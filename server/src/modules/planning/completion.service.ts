import { errors } from "../../lib/errors";
import type { DbOrTx, Tx } from "../../lib/prisma";
import { D, q, ZERO } from "../../lib/qty";
import { recordAudit } from "../audit/audit.service";
import { lineBalances } from "./material.service";
import type { Actor } from "./orders.service";

/**
 * Production Order Complete Utility: closes a Production Job Order once its
 * Job Orders are finished. Blockers stop completion outright; warnings
 * (short output, material not fully issued) need an authorised override with
 * a reason. Completion closes the order's open MRS so no more material moves.
 */

export interface CompletionCheck {
  pjo: { id: string; pjoNo: string; status: string; orderQty: string; uom: string; customerRef: string | null; fatherCode: string; labelDescription: string };
  blockers: string[];
  warnings: string[];
  goodOutput: string;
  jobOrders: { id: string; woNo: string; status: string; quantity: string; finalGood: string }[];
  materials: {
    mrsId: string;
    mrsNo: string;
    status: string;
    woNo: string;
    lines: { materialCode: string; materialDescription: string; uom: string; requested: string; issued: string; additional: string; returned: string; rejected: string; scrapped: string; remainingToIssue: string; onHand: string }[];
  }[];
}

export async function completionCheck(db: DbOrTx, pjoId: string): Promise<CompletionCheck> {
  const pjo = await db.productionJobOrder.findUnique({
    where: { id: pjoId },
    include: {
      bom: { select: { fatherCode: true } },
      artworkRevision: { select: { labelDescription: true } },
      workOrders: { orderBy: { woNo: "asc" }, include: { processes: { orderBy: { seq: "asc" } } } },
    },
  });
  if (!pjo) throw errors.notFound("Production Job Order");
  const woIds = pjo.workOrders.map((w) => w.id);
  const [running, mrs, oqcOpen] = await Promise.all([
    db.productionSession.count({ where: { workOrderId: { in: woIds }, status: "RUNNING" } }),
    db.materialRequisition.findMany({ where: { workOrderId: { in: woIds }, status: { not: "CANCELLED" } }, orderBy: { mrsNo: "asc" }, include: { lines: { orderBy: { lineNo: "asc" } }, workOrder: { select: { woNo: true } } } }),
    db.qcInspection.findMany({ where: { type: "OQC", workOrderId: { in: woIds }, status: { in: ["IN_INSPECTION", "PENDING_DISPOSITION", "REWORK"] } }, orderBy: { inspNo: "asc" }, select: { inspNo: true, status: true } }),
  ]);

  const blockers: string[] = [];
  const warnings: string[] = [];
  if (pjo.status === "CLOSED") blockers.push(`${pjo.pjoNo} is already completed.`);
  else if (pjo.status === "CANCELLED") blockers.push(`${pjo.pjoNo} is cancelled.`);
  else if (pjo.status !== "RELEASED") blockers.push("Only released orders can be completed.");
  if (running) blockers.push(`${running} machine session(s) are still running on its Job Orders. Operators must Check Out first.`);
  const open = pjo.workOrders.filter((w) => !["COMPLETED", "CANCELLED"].includes(w.status));
  for (const w of open) blockers.push(`${w.woNo} is ${w.status.toLowerCase().replace(/_/g, " ")}. Complete or cancel it first.`);
  const completed = pjo.workOrders.filter((w) => w.status === "COMPLETED");
  if (pjo.workOrders.length && !completed.length && !open.length) blockers.push("No Job Order was completed. Cancel the order instead.");
  if (!pjo.workOrders.length) blockers.push("The order has no Job Orders.");
  // Finished output still under QC is unresolved: the order can't close around it.
  for (const i of oqcOpen.filter((x) => x.status !== "REWORK"))
    blockers.push(`OQC ${i.inspNo} is ${i.status === "IN_INSPECTION" ? "still being inspected" : "on QC hold waiting for a disposition"}. Finish it first.`);
  for (const i of oqcOpen.filter((x) => x.status === "REWORK")) warnings.push(`OQC ${i.inspNo} was sent to rework and is not reinspected yet. Completing leaves it unresolved.`);

  const finalGood = (w: (typeof pjo.workOrders)[number]) => D(w.processes[w.processes.length - 1]?.goodQty ?? 0);
  const good = completed.reduce((s, w) => s.plus(finalGood(w)), ZERO);
  if (completed.length && good.lessThan(D(pjo.orderQty))) {
    warnings.push(`Completed output ${q(good)} ${pjo.uom} is short of the order quantity ${q(pjo.orderQty)} ${pjo.uom} by ${q(D(pjo.orderQty).minus(good))}.`);
  }
  for (const m of mrs) {
    const notIssued = m.lines.filter((l) => !lineBalances(l).remainingToIssue.isZero());
    if (m.lines.every((l) => D(l.issuedQty).isZero())) warnings.push(`${m.mrsNo} (${m.workOrder.woNo}) was never issued. Completing closes it.`);
    else if (notIssued.length) warnings.push(`${m.mrsNo} (${m.workOrder.woNo}): ${notIssued.length} material line(s) not fully issued. Completing closes it.`);
  }

  return {
    pjo: {
      id: pjo.id,
      pjoNo: pjo.pjoNo,
      status: pjo.status,
      orderQty: q(pjo.orderQty),
      uom: pjo.uom,
      customerRef: pjo.customerRef,
      fatherCode: pjo.bom.fatherCode,
      labelDescription: pjo.artworkRevision.labelDescription,
    },
    blockers,
    warnings,
    goodOutput: q(good),
    jobOrders: pjo.workOrders.map((w) => ({ id: w.id, woNo: w.woNo, status: w.status, quantity: q(w.quantity), finalGood: q(finalGood(w)) })),
    materials: mrs.map((m) => ({
      mrsId: m.id,
      mrsNo: m.mrsNo,
      status: m.status,
      woNo: m.workOrder.woNo,
      lines: m.lines.map((l) => {
        const b = lineBalances(l);
        return {
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
      }),
    })),
  };
}

export async function completePjo(tx: Tx, a: Actor, pjoId: string, input: { note: string | null; override: boolean; canOverride: boolean }, now: Date) {
  await tx.$queryRaw`SELECT id FROM production_job_orders WHERE id = ${pjoId} FOR UPDATE`;
  const check = await completionCheck(tx, pjoId);
  if (check.blockers.length) throw errors.rule("COMPLETION_BLOCKED", check.blockers[0]!, { blockers: check.blockers });
  if (check.warnings.length) {
    if (!input.override) throw errors.rule("COMPLETION_WARNINGS", "Some checks need an authorised override.", { warnings: check.warnings });
    if (!input.canOverride) throw errors.forbidden("Completing with exceptions needs the override permission.");
    if (!input.note) throw errors.validation([{ path: "note", message: "Give the reason for completing with exceptions" }]);
  }
  await tx.productionJobOrder.update({
    where: { id: pjoId },
    data: { status: "CLOSED", closedAt: now, closedById: a.user.id, closureNote: input.note, closureOverride: check.warnings.length > 0, updatedById: a.user.id },
  });
  const toClose = check.materials.filter((m) => m.status !== "CLOSED");
  for (const m of toClose) {
    await tx.materialRequisition.update({ where: { id: m.mrsId }, data: { status: "CLOSED", closedAt: now, updatedById: a.user.id } });
    await recordAudit(tx, a.ctx, { module: "planning", action: "MRS_CLOSED", entityType: "material_requisition", entityId: m.mrsId, recordRef: m.mrsNo, previous: { status: m.status }, next: { status: "CLOSED" }, remarks: `Closed by completing ${check.pjo.pjoNo}` });
  }
  await recordAudit(tx, a.ctx, {
    module: "planning",
    action: check.warnings.length ? "PJO_COMPLETED_WITH_OVERRIDE" : "PJO_COMPLETED",
    entityType: "production_job_order",
    entityId: pjoId,
    recordRef: check.pjo.pjoNo,
    previous: { status: check.pjo.status },
    next: { status: "CLOSED", goodOutput: check.goodOutput, orderQty: check.pjo.orderQty, warnings: check.warnings, mrsClosed: toClose.map((m) => m.mrsNo) },
    remarks: input.note,
  });
  return { status: "CLOSED", mrsClosed: toClose.length };
}
