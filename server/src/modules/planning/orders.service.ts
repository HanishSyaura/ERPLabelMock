import type { Priority, ProductionJobOrder } from "../../generated/prisma/client";
import { errors } from "../../lib/errors";
import { nextNumber } from "../../lib/numbering";
import type { Tx } from "../../lib/prisma";
import { D, q } from "../../lib/qty";
import type { AuthUser, RequestContext } from "../../middleware/context";
import { recordAudit } from "../audit/audit.service";
import { productionSnapshot } from "../bom/bom.service";
import { cardSnapshot } from "../bom/product.service";
import { recomputeMachine, resumedStatus } from "../shopfloor/state";

/**
 * Production Job Order (customer order for one Father Code) -> Job Orders
 * (Work Orders) with their own quantity and process route.
 */
export interface Actor {
  user: AuthUser;
  ctx: RequestContext;
}

const audit = (tx: Tx, a: Actor, entityType: string, id: string, ref: string, action: string, extra: { previous?: unknown; next?: unknown; remarks?: string | null } = {}) =>
  recordAudit(tx, a.ctx, { module: "planning", action, entityType, entityId: id, recordRef: ref, ...extra });

async function lockPjo(tx: Tx, id: string): Promise<ProductionJobOrder> {
  await tx.$queryRaw`SELECT id FROM production_job_orders WHERE id = ${id} FOR UPDATE`;
  const pjo = await tx.productionJobOrder.findUnique({ where: { id } });
  if (!pjo) throw errors.notFound("Production Job Order");
  return pjo;
}
async function lockWo(tx: Tx, id: string) {
  await tx.$queryRaw`SELECT id FROM work_orders WHERE id = ${id} FOR UPDATE`;
  const wo = await tx.workOrder.findUnique({ where: { id }, include: { processes: { orderBy: { seq: "asc" } } } });
  if (!wo) throw errors.notFound("Job Order");
  return wo;
}

/**
 * What a Production Job Order freezes. A Father Code that belongs to a product
 * runs from the product's released Master Card (refused without one); a
 * Father Code without a product uses its current revisions (earlier rule).
 */
async function freezeFor(tx: Tx, bomId: string) {
  const snap = await productionSnapshot(tx, bomId);
  const card = await cardSnapshot(tx, bomId);
  if (!card) {
    return {
      fatherCode: snap.fatherCode,
      data: { artworkRevisionId: snap.artworkRevision.id, componentRevisionId: snap.componentRevision?.id ?? null, productId: null, masterCardRevisionId: null },
      summary: { artworkRevision: snap.artworkRevision.revisionNo, componentRevision: snap.componentRevision?.revisionNo ?? null, masterCard: null as string | null },
    };
  }
  const [art, comp] = await Promise.all([
    tx.bomArtworkRevision.findUniqueOrThrow({ where: { id: card.card.artworkRevisionId } }),
    card.card.componentRevisionId ? tx.bomComponentRevision.findUnique({ where: { id: card.card.componentRevisionId } }) : null,
  ]);
  return {
    fatherCode: snap.fatherCode,
    data: { artworkRevisionId: card.card.artworkRevisionId, componentRevisionId: card.card.componentRevisionId, productId: card.product.id, masterCardRevisionId: card.card.id },
    summary: { artworkRevision: art.revisionNo, componentRevision: comp?.revisionNo ?? null, masterCard: `${card.product.productCode} Rev ${card.card.revisionNo}` },
  };
}

export interface PjoInput {
  bomId: string;
  orderQty: string | number;
  uom: string;
  requiredDate?: Date | null;
  priority?: Priority;
  customerRef?: string | null;
  productRef?: string | null;
  remarks?: string | null;
}

export async function createPjo(tx: Tx, a: Actor, input: PjoInput, now: Date) {
  const frozen = await freezeFor(tx, input.bomId);
  const pjoNo = await nextNumber(tx, "PJO", now);
  const pjo = await tx.productionJobOrder.create({
    data: {
      pjoNo,
      bomId: input.bomId,
      ...frozen.data,
      orderQty: D(input.orderQty),
      uom: input.uom,
      requiredDate: input.requiredDate ?? null,
      priority: input.priority ?? "NORMAL",
      customerRef: input.customerRef ?? null,
      productRef: input.productRef ?? null,
      remarks: input.remarks ?? null,
      createdById: a.user.id,
      updatedById: a.user.id,
    },
  });
  await audit(tx, a, "production_job_order", pjo.id, pjoNo, "PJO_CREATED", {
    next: { fatherCode: frozen.fatherCode, ...frozen.summary, orderQty: q(input.orderQty), uom: input.uom },
  });
  return pjo;
}

export async function updatePjo(tx: Tx, a: Actor, id: string, input: Partial<PjoInput>) {
  const pjo = await lockPjo(tx, id);
  if (pjo.status !== "DRAFT") throw errors.rule("PJO_NOT_DRAFT", "Only draft Production Job Orders can be edited.");
  const data: Record<string, unknown> = {};
  if (input.bomId && input.bomId !== pjo.bomId) {
    if (await tx.workOrder.count({ where: { pjoId: id, status: { not: "CANCELLED" } } })) {
      throw errors.rule("PJO_HAS_JOB_ORDERS", "Cancel its Job Orders before changing the Father Code.");
    }
    const frozen = await freezeFor(tx, input.bomId);
    Object.assign(data, { bomId: input.bomId, ...frozen.data });
  }
  if (input.orderQty !== undefined) {
    const allocated = await allocatedQty(tx, id);
    if (D(input.orderQty).lessThan(allocated)) throw errors.rule("QTY_BELOW_ALLOCATED", `Job Orders already hold ${q(allocated)}. The order quantity can't be lower.`);
    data.orderQty = D(input.orderQty);
  }
  for (const k of ["uom", "requiredDate", "priority", "customerRef", "productRef", "remarks"] as const) if (input[k] !== undefined) data[k] = input[k];
  const updated = await tx.productionJobOrder.update({ where: { id }, data: { ...data, updatedById: a.user.id } });
  await audit(tx, a, "production_job_order", id, pjo.pjoNo, "PJO_UPDATED", { next: { ...data, orderQty: data.orderQty ? q(data.orderQty as never) : undefined } });
  return updated;
}

/** Release freezes the exact Father Code revisions current at this moment. */
export async function releasePjo(tx: Tx, a: Actor, id: string, now: Date) {
  const pjo = await lockPjo(tx, id);
  if (pjo.status !== "DRAFT") throw errors.rule("PJO_NOT_DRAFT", "Only draft Production Job Orders can be released.");
  const frozen = await freezeFor(tx, pjo.bomId);
  const updated = await tx.productionJobOrder.update({
    where: { id },
    data: { status: "RELEASED", ...frozen.data, releasedAt: now, releasedById: a.user.id, updatedById: a.user.id },
  });
  await audit(tx, a, "production_job_order", id, pjo.pjoNo, "PJO_RELEASED", {
    previous: { status: "DRAFT" },
    next: { status: "RELEASED", fatherCode: frozen.fatherCode, ...frozen.summary },
  });
  return updated;
}

export async function cancelPjo(tx: Tx, a: Actor, id: string, reason: string | null) {
  const pjo = await lockPjo(tx, id);
  if (pjo.status === "CANCELLED" || pjo.status === "CLOSED") throw errors.rule("PJO_CLOSED", "This Production Job Order is already closed.");
  const started = await tx.workOrder.count({ where: { pjoId: id, sessions: { some: {} } } });
  if (started) throw errors.rule("PJO_STARTED", "Production has started on its Job Orders. Put them on hold instead.");
  // Each Job Order is cancelled (and audited) on its own, with its unused requisitions.
  const wos = await tx.workOrder.findMany({ where: { pjoId: id, status: { notIn: ["CANCELLED", "COMPLETED"] } }, select: { id: true, woNo: true, status: true } });
  const material = { cancelled: [] as string[], keptOpen: [] as string[] };
  for (const w of wos) {
    await tx.workOrder.update({ where: { id: w.id }, data: { status: "CANCELLED", updatedById: a.user.id } });
    await audit(tx, a, "work_order", w.id, w.woNo, "JOB_ORDER_CANCELLED", { previous: { status: w.status }, next: { status: "CANCELLED" }, remarks: `${pjo.pjoNo} cancelled${reason ? `: ${reason}` : ""}` });
    const m = await closeMrsOfCancelled(tx, a, w, reason);
    material.cancelled.push(...m.cancelled);
    material.keptOpen.push(...m.keptOpen);
  }
  const updated = await tx.productionJobOrder.update({ where: { id }, data: { status: "CANCELLED", updatedById: a.user.id } });
  await audit(tx, a, "production_job_order", id, pjo.pjoNo, "PJO_CANCELLED", { previous: { status: pjo.status }, next: { status: "CANCELLED", jobOrders: wos.map((w) => w.woNo), mrsCancelled: material.cancelled }, remarks: reason });
  return { pjo: updated, material };
}

/**
 * Requisitions of a cancelled Job Order: one that never moved material is
 * cancelled with it (nothing can be issued to a cancelled job any more); one
 * with material out stays open so the unused material can still be returned,
 * rejected or scrapped against it.
 */
async function closeMrsOfCancelled(tx: Tx, a: Actor, wo: { id: string; woNo: string }, reason: string | null) {
  const list = await tx.materialRequisition.findMany({ where: { workOrderId: wo.id, status: { in: ["OPEN", "PARTIALLY_ISSUED", "ISSUED"] } }, select: { id: true, mrsNo: true, status: true, _count: { select: { transactions: true } } } });
  const out = { cancelled: [] as string[], keptOpen: [] as string[] };
  for (const m of list) {
    if (m._count.transactions) {
      out.keptOpen.push(m.mrsNo);
      continue;
    }
    await tx.materialRequisition.update({ where: { id: m.id }, data: { status: "CANCELLED", updatedById: a.user.id } });
    await audit(tx, a, "material_requisition", m.id, m.mrsNo, "MRS_CANCELLED", { previous: { status: m.status }, next: { status: "CANCELLED" }, remarks: `${wo.woNo} cancelled${reason ? `: ${reason}` : ""}` });
    out.cancelled.push(m.mrsNo);
  }
  return out;
}

async function allocatedQty(tx: Tx, pjoId: string) {
  const agg = await tx.workOrder.aggregate({ where: { pjoId, status: { not: "CANCELLED" } }, _sum: { quantity: true } });
  return D(agg._sum.quantity);
}

/** Route for a new Job Order: explicit processes, a routine, or the routine on the PJO's frozen Master Card. */
async function resolveRoute(tx: Tx, pjo: Pick<ProductionJobOrder, "masterCardRevisionId">, input: { processIds?: string[]; routineId?: string | null }) {
  let processIds = input.processIds;
  if (!processIds?.length && input.routineId) {
    const rt = await tx.routine.findUnique({ where: { id: input.routineId }, include: { steps: { orderBy: { seq: "asc" } } } });
    if (!rt || rt.status !== "ACTIVE") throw errors.validation([{ path: "routineId", message: "Choose an active routine" }]);
    processIds = rt.steps.map((s) => s.processId);
  }
  if (!processIds?.length) {
    const card = pjo.masterCardRevisionId
      ? await tx.masterCardRevision.findUnique({ where: { id: pjo.masterCardRevisionId }, select: { routine: { include: { steps: { orderBy: { seq: "asc" } } } } } })
      : null;
    if (card?.routine && card.routine.status === "ACTIVE") processIds = card.routine.steps.map((s) => s.processId);
  }
  if (!processIds?.length) {
    throw errors.validation([{ path: "processIds", message: "Choose a routine or the processes. This order's Master Card has no routine." }]);
  }
  const found = await tx.process.findMany({ where: { id: { in: processIds } } });
  const byId = new Map(found.map((p) => [p.id, p]));
  for (const pid of processIds) {
    const p = byId.get(pid);
    if (!p || p.status !== "ACTIVE") throw errors.validation([{ path: "processIds", message: "Choose active processes only" }]);
  }
  return processIds;
}

export interface WoInput {
  pjoId: string;
  quantity: string | number;
  plannedDate?: Date | null;
  priority?: Priority;
  remarks?: string | null;
  routineId?: string | null;
  processIds?: string[];
}

export async function createWorkOrder(tx: Tx, a: Actor, input: WoInput, now: Date) {
  const pjo = await lockPjo(tx, input.pjoId);
  if (pjo.status !== "DRAFT" && pjo.status !== "RELEASED") throw errors.rule("PJO_CLOSED", "This Production Job Order is closed or cancelled.");
  const allocated = await allocatedQty(tx, pjo.id);
  const remaining = D(pjo.orderQty).minus(allocated);
  if (D(input.quantity).greaterThan(remaining)) {
    throw errors.validation([{ path: "quantity", message: `Only ${q(remaining)} ${pjo.uom} of ${pjo.pjoNo} is not yet in a Job Order` }]);
  }
  const processIds = await resolveRoute(tx, pjo, input);
  const woNo = await nextNumber(tx, "JO", now);
  const wo = await tx.workOrder.create({
    data: {
      woNo,
      pjoId: pjo.id,
      quantity: D(input.quantity),
      uom: pjo.uom,
      plannedDate: input.plannedDate ?? null,
      priority: input.priority ?? pjo.priority,
      remarks: input.remarks ?? null,
      createdById: a.user.id,
      updatedById: a.user.id,
      processes: { create: processIds.map((processId, i) => ({ processId, seq: i + 1 })) },
    },
  });
  await audit(tx, a, "work_order", wo.id, woNo, "JOB_ORDER_CREATED", { next: { pjoNo: pjo.pjoNo, quantity: q(input.quantity), uom: pjo.uom, route: processIds.length } });
  return wo;
}

export async function updateWorkOrder(tx: Tx, a: Actor, id: string, input: Partial<Omit<WoInput, "pjoId">>) {
  const wo = await lockWo(tx, id);
  if (wo.status !== "PLANNED") throw errors.rule("WO_NOT_PLANNED", "Only planned (not yet released) Job Orders can be edited.");
  const pjo = await lockPjo(tx, wo.pjoId);
  const data: Record<string, unknown> = {};
  if (input.quantity !== undefined) {
    const remaining = D(pjo.orderQty).minus(await allocatedQty(tx, pjo.id)).plus(D(wo.quantity));
    if (D(input.quantity).greaterThan(remaining)) throw errors.validation([{ path: "quantity", message: `At most ${q(remaining)} ${pjo.uom} is available on ${pjo.pjoNo}` }]);
    data.quantity = D(input.quantity);
  }
  for (const k of ["plannedDate", "priority", "remarks"] as const) if (input[k] !== undefined) data[k] = input[k];
  let routeChanged = false;
  if (input.processIds?.length || input.routineId) {
    const processIds = await resolveRoute(tx, pjo, input);
    if (processIds.join() !== wo.processes.map((p) => p.processId).join()) {
      routeChanged = true;
      await tx.workOrderProcess.deleteMany({ where: { workOrderId: id } });
      await tx.workOrderProcess.createMany({ data: processIds.map((processId, i) => ({ workOrderId: id, processId, seq: i + 1 })) });
    }
  }
  const updated = await tx.workOrder.update({ where: { id }, data: { ...data, updatedById: a.user.id } });
  await audit(tx, a, "work_order", id, wo.woNo, "JOB_ORDER_UPDATED", { next: { ...data, quantity: data.quantity ? q(data.quantity as never) : undefined, ...(routeChanged ? { routeChanged } : {}) } });
  return updated;
}

export async function releaseWorkOrder(tx: Tx, a: Actor, id: string, now: Date) {
  const wo = await lockWo(tx, id);
  if (wo.status !== "PLANNED") throw errors.rule("WO_NOT_PLANNED", "Only planned Job Orders can be released.");
  const pjo = await tx.productionJobOrder.findUniqueOrThrow({ where: { id: wo.pjoId } });
  if (pjo.status !== "RELEASED") throw errors.rule("PJO_NOT_RELEASED", `Release ${pjo.pjoNo} first (it freezes the artwork and BOM revisions).`);
  if (!wo.processes.length) throw errors.rule("NO_ROUTE", "The Job Order has no process route.");
  const updated = await tx.workOrder.update({ where: { id }, data: { status: "RELEASED", releasedAt: now, releasedById: a.user.id, updatedById: a.user.id } });
  await audit(tx, a, "work_order", id, wo.woNo, "JOB_ORDER_RELEASED", { previous: { status: "PLANNED" }, next: { status: "RELEASED" } });
  return updated;
}

export async function holdWorkOrder(tx: Tx, a: Actor, id: string, hold: boolean, reason: string | null, now: Date) {
  const wo = await lockWo(tx, id);
  if (hold) {
    if (!["RELEASED", "IN_PROGRESS", "PARTIALLY_COMPLETED"].includes(wo.status)) throw errors.rule("WO_NOT_ACTIVE", "Only released or in-progress Job Orders can be put on hold.");
    if (await tx.productionSession.count({ where: { workOrderId: id, status: "RUNNING" } })) {
      throw errors.rule("WO_RUNNING", "A machine is still running this Job Order. The operator must Check Out first.");
    }
    if (!reason) throw errors.validation([{ path: "reason", message: "Give the reason for the hold" }]);
    const updated = await tx.workOrder.update({ where: { id }, data: { status: "ON_HOLD", holdReason: reason, updatedById: a.user.id } });
    await audit(tx, a, "work_order", id, wo.woNo, "JOB_ORDER_ON_HOLD", { previous: { status: wo.status }, next: { status: "ON_HOLD" }, remarks: reason });
    return updated;
  }
  if (wo.status !== "ON_HOLD") throw errors.rule("WO_NOT_ON_HOLD", "This Job Order is not on hold.");
  const status = await resumedStatus(tx, id);
  const updated = await tx.workOrder.update({ where: { id }, data: { status, holdReason: null, updatedById: a.user.id } });
  await audit(tx, a, "work_order", id, wo.woNo, "JOB_ORDER_RELEASED_FROM_HOLD", { previous: { status: "ON_HOLD" }, next: { status }, remarks: reason });
  for (const p of wo.processes) if (p.assignedMachineId) await recomputeMachine(tx, p.assignedMachineId, now);
  return updated;
}

export async function cancelWorkOrder(tx: Tx, a: Actor, id: string, reason: string | null) {
  const wo = await lockWo(tx, id);
  if (wo.status === "CANCELLED" || wo.status === "COMPLETED") throw errors.rule("WO_CLOSED", "This Job Order is already closed.");
  if (await tx.productionSession.count({ where: { workOrderId: id } })) throw errors.rule("WO_STARTED", "Production has started on this Job Order. Put it on hold instead.");
  const updated = await tx.workOrder.update({ where: { id }, data: { status: "CANCELLED", updatedById: a.user.id } });
  const material = await closeMrsOfCancelled(tx, a, wo, reason);
  await audit(tx, a, "work_order", id, wo.woNo, "JOB_ORDER_CANCELLED", { previous: { status: wo.status }, next: { status: "CANCELLED", mrsCancelled: material.cancelled, mrsKeptOpen: material.keptOpen }, remarks: reason });
  return { wo: updated, material };
}

/** Explicit completion: every process completed and nothing running. Never automatic. */
export async function completeWorkOrder(tx: Tx, a: Actor, id: string, note: string | null, now: Date) {
  const wo = await lockWo(tx, id);
  if (!["RELEASED", "IN_PROGRESS", "PARTIALLY_COMPLETED"].includes(wo.status)) throw errors.rule("WO_NOT_ACTIVE", "This Job Order can't be completed in its current status.");
  if (await tx.productionSession.count({ where: { workOrderId: id, status: "RUNNING" } })) throw errors.rule("WO_RUNNING", "A machine is still running this Job Order.");
  const open = wo.processes.filter((p) => p.status !== "COMPLETED");
  if (open.length) {
    const names = await tx.process.findMany({ where: { id: { in: open.map((p) => p.processId) } }, select: { name: true } });
    throw errors.rule("PROCESSES_OPEN", `Not every process is completed yet: ${names.map((n) => n.name).join(", ")}.`);
  }
  const last = wo.processes[wo.processes.length - 1]!;
  const short = D(last.goodQty).lessThan(D(wo.quantity));
  if (short && !note) throw errors.validation([{ path: "note", message: `Final good output ${q(last.goodQty)} is below the target ${q(wo.quantity)}. Give a reason.` }]);
  const updated = await tx.workOrder.update({ where: { id }, data: { status: "COMPLETED", completedAt: now, completedById: a.user.id, completionNote: note, updatedById: a.user.id } });
  await audit(tx, a, "work_order", id, wo.woNo, "JOB_ORDER_COMPLETED", { previous: { status: wo.status }, next: { status: "COMPLETED", finalGood: q(last.goodQty), target: q(wo.quantity) }, remarks: note });
  return updated;
}

/** Supervisor authorisations on one route step. */
export async function authorizeProcess(
  tx: Tx,
  a: Actor,
  woProcessId: string,
  input: { allowPartialTransfer?: boolean; allowSplit?: boolean; extraAllowedQty?: string | number; note: string },
) {
  const p = await tx.workOrderProcess.findUnique({ where: { id: woProcessId }, include: { workOrder: true, process: true } });
  if (!p) throw errors.notFound("Job Order process");
  if (p.status === "COMPLETED") throw errors.rule("PROCESS_COMPLETED", "This process is already completed.");
  const data: Record<string, unknown> = {};
  const previous: Record<string, unknown> = {};
  if (input.allowPartialTransfer !== undefined && input.allowPartialTransfer !== p.allowPartialTransfer) {
    if (p.seq === 1 && input.allowPartialTransfer) throw errors.rule("FIRST_PROCESS", "The first process has no previous process to transfer from.");
    data.allowPartialTransfer = input.allowPartialTransfer;
    previous.allowPartialTransfer = p.allowPartialTransfer;
  }
  if (input.allowSplit !== undefined && input.allowSplit !== p.allowSplit) {
    data.allowSplit = input.allowSplit;
    previous.allowSplit = p.allowSplit;
  }
  if (input.extraAllowedQty !== undefined && !D(input.extraAllowedQty).equals(D(p.extraAllowedQty))) {
    data.extraAllowedQty = D(input.extraAllowedQty);
    previous.extraAllowedQty = q(p.extraAllowedQty);
  }
  if (!Object.keys(data).length) return p;
  const updated = await tx.workOrderProcess.update({ where: { id: woProcessId }, data });
  await recordAudit(tx, a.ctx, {
    module: "shopfloor", action: "PROCESS_AUTHORISATION_CHANGED", entityType: "work_order", entityId: p.workOrderId, recordRef: `${p.workOrder.woNo} / ${p.process.name}`,
    previous, next: { ...data, extraAllowedQty: data.extraAllowedQty ? q(data.extraAllowedQty as never) : undefined }, remarks: input.note,
  });
  return updated;
}
