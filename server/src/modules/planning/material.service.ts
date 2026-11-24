import type { MaterialTxnType, MrsLine, Prisma, ReasonCategory } from "../../generated/prisma/client";
import { errors } from "../../lib/errors";
import { nextNumber } from "../../lib/numbering";
import type { DbOrTx, Tx } from "../../lib/prisma";
import { D, maxQ, q, ZERO } from "../../lib/qty";
import { recordAudit } from "../audit/audit.service";
import type { Actor } from "./orders.service";

/**
 * Material Requisition Sheet (MRS) per Job Order and its material movements:
 * issue, additional issue, return, reject and scrap. Movements are
 * append-only transactions; the MRS line keeps running totals updated in the
 * same database transaction.
 *
 * Rules (defaults until the factory confirms otherwise, see DEVELOPMENT_PLAN):
 * - MRS lines come only from the BOM revision frozen on the released PJO.
 * - Normal issue is limited to the requested quantity. Anything more is an
 *   Additional Issue with a reason, allowed once the request is fully issued.
 * - Return, reject and scrap can't exceed what is still out on the line
 *   (issued + additional - returned - rejected - scrapped).
 */

const TXN_SEQUENCE: Record<MaterialTxnType, string> = { ISSUE: "ISS", ADDITIONAL_ISSUE: "MAI", RETURN: "MRR", REJECT: "MRJ", SCRAP: "SCR" };
const TXN_LABEL: Record<MaterialTxnType, string> = { ISSUE: "Issue", ADDITIONAL_ISSUE: "Additional issue", RETURN: "Return", REJECT: "Reject", SCRAP: "Scrap" };
const ACTIVE_WO = ["PLANNED", "RELEASED", "IN_PROGRESS", "PARTIALLY_COMPLETED"];

const audit = (tx: Tx, a: Actor, action: string, entityType: string, id: string, ref: string, extra: { previous?: unknown; next?: unknown; remarks?: string | null } = {}) =>
  recordAudit(tx, a.ctx, { module: "planning", action, entityType, entityId: id, recordRef: ref, ...extra });

export function lineBalances(l: Pick<MrsLine, "requestedQty" | "issuedQty" | "additionalQty" | "returnedQty" | "rejectedQty" | "scrappedQty">) {
  const issued = D(l.issuedQty);
  const additional = D(l.additionalQty);
  const out = issued.plus(additional).minus(D(l.returnedQty)).minus(D(l.rejectedQty)).minus(D(l.scrappedQty));
  return { remainingToIssue: maxQ(D(l.requestedQty).minus(issued), ZERO), onHand: maxQ(out, ZERO) };
}

export function lineView(l: MrsLine & { sonCode?: { sonCode: string } | null }) {
  const b = lineBalances(l);
  return {
    id: l.id,
    lineNo: l.lineNo,
    sonCode: l.sonCode?.sonCode ?? null,
    materialId: l.materialId,
    materialCode: l.materialCode,
    materialDescription: l.materialDescription,
    uom: l.uom,
    requested: q(l.requestedQty),
    issued: q(l.issuedQty),
    additional: q(l.additionalQty),
    returned: q(l.returnedQty),
    rejected: q(l.rejectedQty),
    scrapped: q(l.scrappedQty),
    remainingToIssue: q(b.remainingToIssue),
    onHand: q(b.onHand),
  };
}

/** BOM lines a new MRS can request for a Job Order, with what earlier MRS already requested. */
export async function mrsTemplate(db: DbOrTx, workOrderId: string) {
  const wo = await db.workOrder.findUnique({
    where: { id: workOrderId },
    include: { pjo: { include: { componentRevision: { include: { lines: { orderBy: { lineNo: "asc" }, include: { sonCode: true, material: true } } } } } } },
  });
  if (!wo) throw errors.notFound("Job Order");
  const requested = await db.mrsLine.groupBy({ by: ["sonCodeId"], where: { mrs: { workOrderId, status: { not: "CANCELLED" } } }, _sum: { requestedQty: true } });
  const already = new Map(requested.map((r) => [r.sonCodeId, D(r._sum.requestedQty)]));
  return {
    workOrder: { id: wo.id, woNo: wo.woNo, status: wo.status, quantity: q(wo.quantity), uom: wo.uom },
    pjo: { id: wo.pjo.id, pjoNo: wo.pjo.pjoNo, status: wo.pjo.status, componentRevision: wo.pjo.componentRevision?.revisionNo ?? null },
    lines:
      wo.pjo.componentRevision?.lines.map((l) => ({
        sonCodeId: l.sonCodeId,
        sonCode: l.sonCode.sonCode,
        materialId: l.materialId,
        materialCode: l.materialCode,
        materialDescription: l.materialDescription,
        bomQty: l.quantity ? q(l.quantity) : null,
        uom: l.uom ?? l.material.uom,
        alreadyRequested: q(already.get(l.sonCodeId) ?? ZERO),
      })) ?? [],
  };
}

export interface MrsInput {
  workOrderId: string;
  remarks?: string | null;
  lines: { sonCodeId: string; requestedQty: string | number }[];
}

export async function createMrs(tx: Tx, a: Actor, input: MrsInput, now: Date) {
  await tx.$queryRaw`SELECT id FROM work_orders WHERE id = ${input.workOrderId} FOR UPDATE`;
  const wo = await tx.workOrder.findUnique({
    where: { id: input.workOrderId },
    include: { pjo: { include: { componentRevision: { include: { lines: { include: { material: true } } } } } } },
  });
  if (!wo) throw errors.notFound("Job Order");
  if (!ACTIVE_WO.includes(wo.status)) throw errors.rule("WO_NOT_ACTIVE", `${wo.woNo} is ${wo.status.toLowerCase().replace(/_/g, " ")}; material can't be requested for it.`);
  if (wo.pjo.status !== "RELEASED") throw errors.rule("PJO_NOT_RELEASED", `Release ${wo.pjo.pjoNo} first: the MRS uses the BOM revision frozen at release.`);
  const bomLines = wo.pjo.componentRevision?.lines ?? [];
  if (!bomLines.length) throw errors.rule("NO_COMPONENTS", `${wo.pjo.pjoNo} has no component list (Son Codes) to request material from.`);
  if (!input.lines.length) throw errors.validation([{ path: "lines", message: "Request at least one material" }]);
  const bySon = new Map(bomLines.map((l) => [l.sonCodeId, l]));
  const seen = new Set<string>();
  input.lines.forEach((l, i) => {
    if (!bySon.has(l.sonCodeId)) throw errors.validation([{ path: `lines.${i}.sonCodeId`, message: "Choose a Son Code from the frozen BOM revision" }]);
    if (seen.has(l.sonCodeId)) throw errors.validation([{ path: `lines.${i}.sonCodeId`, message: "Each Son Code once per MRS" }]);
    seen.add(l.sonCodeId);
  });
  const mrsNo = await nextNumber(tx, "MRS", now);
  const mrs = await tx.materialRequisition.create({
    data: {
      mrsNo,
      workOrderId: wo.id,
      remarks: input.remarks ?? null,
      createdById: a.user.id,
      updatedById: a.user.id,
      lines: {
        create: input.lines.map((l, i) => {
          const b = bySon.get(l.sonCodeId)!;
          return {
            lineNo: i + 1,
            sonCodeId: b.sonCodeId,
            materialId: b.materialId,
            materialCode: b.materialCode,
            materialDescription: b.materialDescription,
            uom: b.uom ?? b.material.uom,
            requestedQty: D(l.requestedQty),
          };
        }),
      },
    },
  });
  await audit(tx, a, "MRS_CREATED", "material_requisition", mrs.id, mrsNo, {
    next: { woNo: wo.woNo, lines: input.lines.map((l) => ({ sonCode: bySon.get(l.sonCodeId)!.materialCode, requested: q(l.requestedQty) })) },
  });
  return mrs;
}

async function lockMrs(tx: Tx, id: string) {
  await tx.$queryRaw`SELECT id FROM material_requisitions WHERE id = ${id} FOR UPDATE`;
  const mrs = await tx.materialRequisition.findUnique({ where: { id }, include: { workOrder: { include: { pjo: true } } } });
  if (!mrs) throw errors.notFound("MRS");
  return mrs;
}

export async function cancelMrs(tx: Tx, a: Actor, id: string, reason: string | null) {
  const mrs = await lockMrs(tx, id);
  if (mrs.status === "CANCELLED" || mrs.status === "CLOSED") throw errors.rule("MRS_CLOSED", `${mrs.mrsNo} is already ${mrs.status.toLowerCase()}.`);
  if (await tx.materialTransaction.count({ where: { mrsId: id } })) throw errors.rule("MRS_HAS_MOVEMENTS", "Material has already moved on this MRS. Return what is unused instead of cancelling.");
  if (!reason) throw errors.validation([{ path: "reason", message: "Give the reason for cancelling" }]);
  await tx.materialRequisition.update({ where: { id }, data: { status: "CANCELLED", updatedById: a.user.id } });
  await audit(tx, a, "MRS_CANCELLED", "material_requisition", id, mrs.mrsNo, { previous: { status: mrs.status }, next: { status: "CANCELLED" }, remarks: reason });
}

export interface MovementInput {
  qty: string | number;
  lotRef?: string | null;
  reasonCodeId?: string | null;
  machineId?: string | null;
  woProcessId?: string | null;
  remarks?: string | null;
}

const REASON_FOR: Partial<Record<MaterialTxnType, ReasonCategory>> = { ADDITIONAL_ISSUE: "ADDITIONAL_ISSUE", REJECT: "REJECT", SCRAP: "SCRAP" };

/** One material movement on an MRS line. Call inside `idempotent()`. */
export async function recordMovement(tx: Tx, a: Actor, type: MaterialTxnType, lineId: string, input: MovementInput, now: Date) {
  const pre = await tx.mrsLine.findUnique({ where: { id: lineId }, select: { mrsId: true } });
  if (!pre) throw errors.notFound("MRS line");
  const mrs = await lockMrs(tx, pre.mrsId);
  const line = await tx.mrsLine.findUniqueOrThrow({ where: { id: lineId } });
  const qty = D(input.qty);
  const wo = mrs.workOrder;
  if (mrs.status === "CLOSED" || mrs.status === "CANCELLED") throw errors.rule("MRS_CLOSED", `${mrs.mrsNo} is ${mrs.status.toLowerCase()}. No more material can move on it.`);
  const { remainingToIssue, onHand } = lineBalances(line);

  if (type === "ISSUE" || type === "ADDITIONAL_ISSUE") {
    if (wo.status === "ON_HOLD") throw errors.rule("WO_ON_HOLD", `${wo.woNo} is on hold: ${wo.holdReason ?? "no reason given"}. Release the hold before issuing.`);
    if (!ACTIVE_WO.includes(wo.status)) throw errors.rule("WO_NOT_ACTIVE", `${wo.woNo} is ${wo.status.toLowerCase().replace(/_/g, " ")}; material can't be issued to it.`);
  }
  if (type === "ISSUE") {
    if (remainingToIssue.isZero()) throw errors.rule("FULLY_ISSUED", `${line.materialCode} is fully issued on ${mrs.mrsNo}. Use MRS Additional Issued for more.`);
    if (qty.greaterThan(remainingToIssue)) {
      throw errors.validation([{ path: "qty", message: `Only ${q(remainingToIssue)} ${line.uom} remains to issue. Use MRS Additional Issued for more.` }]);
    }
  }
  // Part Master "Require IQC": only lots that passed IQC (or were accepted) may be issued.
  if (type === "ISSUE" || type === "ADDITIONAL_ISSUE") {
    const part = await tx.material.findUnique({ where: { id: line.materialId }, select: { requireIqc: true, code: true } });
    if (part?.requireIqc) {
      const lot = input.lotRef?.trim();
      if (!lot) throw errors.validation([{ path: "lotRef", message: `${part.code} requires IQC: enter the lot / roll no. that passed IQC` }]);
      const ok = await tx.qcInspection.findFirst({ where: { type: "IQC", materialId: line.materialId, lotRef: lot, status: { in: ["PASSED", "ACCEPTED"] } } });
      if (!ok) throw errors.rule("LOT_NOT_RELEASED", `Lot ${lot} of ${part.code} hasn't passed IQC. Check it in and out at IQC first.`);
    }
  }
  if (type === "ADDITIONAL_ISSUE" && !remainingToIssue.isZero()) {
    throw errors.rule("ISSUE_FIRST", `Issue the remaining ${q(remainingToIssue)} ${line.uom} of the request first; additional issue is for material beyond the MRS.`);
  }
  if (type === "RETURN" || type === "REJECT" || type === "SCRAP") {
    if (onHand.isZero()) throw errors.rule("NOTHING_OUT", `No ${line.materialCode} is out on ${mrs.mrsNo} to ${TXN_LABEL[type].toLowerCase()}.`);
    if (qty.greaterThan(onHand)) throw errors.validation([{ path: "qty", message: `Only ${q(onHand)} ${line.uom} is out on this line (issued minus returned, rejected and scrapped).` }]);
  }

  let reason: { id: string; code: string } | null = null;
  const category = REASON_FOR[type];
  if (category) {
    if (!input.reasonCodeId) throw errors.validation([{ path: "reasonCodeId", message: "Choose a reason" }]);
    const r = await tx.reasonCode.findUnique({ where: { id: input.reasonCodeId } });
    if (!r || r.category !== category || r.status !== "ACTIVE") throw errors.validation([{ path: "reasonCodeId", message: "Choose an active reason for this movement" }]);
    reason = { id: r.id, code: r.code };
  }
  let processName: string | null = null;
  if (type === "SCRAP") {
    if (input.woProcessId) {
      const step = await tx.workOrderProcess.findUnique({ where: { id: input.woProcessId }, include: { process: true } });
      if (!step || step.workOrderId !== wo.id) throw errors.validation([{ path: "woProcessId", message: `Choose a process of ${wo.woNo}` }]);
      processName = step.process.name;
    }
    if (input.machineId && !(await tx.machine.findUnique({ where: { id: input.machineId } }))) throw errors.validation([{ path: "machineId", message: "Choose a machine" }]);
  }

  const txnNo = await nextNumber(tx, TXN_SEQUENCE[type], now);
  const txn = await tx.materialTransaction.create({
    data: {
      txnNo,
      type,
      mrsId: mrs.id,
      mrsLineId: line.id,
      workOrderId: wo.id,
      materialId: line.materialId,
      qty,
      uom: line.uom,
      lotRef: input.lotRef ?? null,
      reasonCodeId: reason?.id ?? null,
      machineId: type === "SCRAP" ? (input.machineId ?? null) : null,
      woProcessId: type === "SCRAP" ? (input.woProcessId ?? null) : null,
      remarks: input.remarks ?? null,
      createdById: a.user.id,
      createdAt: now,
    },
  });
  const field: Record<MaterialTxnType, keyof Prisma.MrsLineUpdateInput> = { ISSUE: "issuedQty", ADDITIONAL_ISSUE: "additionalQty", RETURN: "returnedQty", REJECT: "rejectedQty", SCRAP: "scrappedQty" };
  const updated = await tx.mrsLine.update({ where: { id: line.id }, data: { [field[type]]: { increment: qty } } });
  if (type === "ISSUE" || type === "ADDITIONAL_ISSUE") await recomputeMrsStatus(tx, mrs.id, a.user.id);
  await audit(tx, a, `MATERIAL_${type}`, "material_requisition", mrs.id, `${mrs.mrsNo} / ${txnNo}`, {
    next: { woNo: wo.woNo, material: line.materialCode, qty: q(qty), uom: line.uom, lotRef: input.lotRef ?? null, reason: reason?.code ?? null, process: processName },
    remarks: input.remarks ?? null,
  });
  return { txnNo: txn.txnNo, type, mrsNo: mrs.mrsNo, line: lineView(updated) };
}

async function recomputeMrsStatus(tx: Tx, mrsId: string, userId: string) {
  const lines = await tx.mrsLine.findMany({ where: { mrsId } });
  const all = lines.every((l) => D(l.issuedQty).greaterThanOrEqualTo(D(l.requestedQty)));
  const any = lines.some((l) => D(l.issuedQty).greaterThan(0));
  await tx.materialRequisition.update({ where: { id: mrsId }, data: { status: all ? "ISSUED" : any ? "PARTIALLY_ISSUED" : "OPEN", updatedById: userId } });
}

// ---------------------------------------------------------------------------
// Reason codes
// ---------------------------------------------------------------------------

export async function createReason(tx: Tx, a: Actor, input: { category: ReasonCategory; code: string; description: string }) {
  const code = input.code.trim().toUpperCase();
  if (await tx.reasonCode.findUnique({ where: { category_code: { category: input.category, code } } })) {
    throw errors.validation([{ path: "code", message: `${code} already exists for this movement type` }]);
  }
  const r = await tx.reasonCode.create({ data: { category: input.category, code, description: input.description, createdById: a.user.id, updatedById: a.user.id } });
  await audit(tx, a, "REASON_CREATED", "reason_code", r.id, `${input.category} / ${code}`, { next: { description: input.description } });
  return r;
}

export async function updateReason(tx: Tx, a: Actor, id: string, input: { description?: string; status?: "ACTIVE" | "INACTIVE" }) {
  const r = await tx.reasonCode.findUnique({ where: { id } });
  if (!r) throw errors.notFound("Reason");
  const updated = await tx.reasonCode.update({ where: { id }, data: { ...input, updatedById: a.user.id } });
  await audit(tx, a, "REASON_UPDATED", "reason_code", id, `${r.category} / ${r.code}`, { previous: { description: r.description, status: r.status }, next: input });
  return updated;
}
