import type { Machine, WorkOrder, WorkOrderProcess } from "../../generated/prisma/client";
import type { Tx } from "../../lib/prisma";
import { D, maxQ, q, ZERO, type Qty } from "../../lib/qty";

/**
 * Three separate status families (never interchangeable):
 *   Machine  AVAILABLE | RUNNING | IDLE | BREAKDOWN | MAINTENANCE | OFFLINE
 *   Session  RUNNING | COMPLETED | PAUSED | BREAKDOWN | TRANSFERRED | CLOSED
 *   Work Order PLANNED | RELEASED | IN_PROGRESS | PARTIALLY_COMPLETED | COMPLETED | ON_HOLD | CANCELLED
 * The derived parts are recomputed here, inside the transaction that changed them.
 */

export const BLOCKED_MACHINE = new Set(["BREAKDOWN", "MAINTENANCE", "OFFLINE"]);
export const WORKABLE_WO = new Set(["RELEASED", "IN_PROGRESS", "PARTIALLY_COMPLETED"]);

/** Recompute a machine's status unless it's blocked (breakdown / maintenance / offline). */
export async function recomputeMachine(tx: Tx, machineId: string, now: Date) {
  const m = await tx.machine.findUniqueOrThrow({ where: { id: machineId } });
  if (BLOCKED_MACHINE.has(m.status)) return m;
  return setMachineStatus(tx, m, await derivedMachineStatus(tx, machineId), now);
}

export async function derivedMachineStatus(tx: Tx, machineId: string): Promise<"RUNNING" | "IDLE" | "AVAILABLE"> {
  if (await tx.productionSession.count({ where: { machineId, status: "RUNNING" } })) return "RUNNING";
  const paused = await tx.workOrderProcess.count({
    where: { assignedMachineId: machineId, status: "PAUSED", workOrder: { status: { in: ["RELEASED", "IN_PROGRESS", "PARTIALLY_COMPLETED", "ON_HOLD"] } } },
  });
  return paused ? "IDLE" : "AVAILABLE";
}

export async function setMachineStatus(tx: Tx, m: Machine, status: Machine["status"], now: Date) {
  if (m.status === status) return m;
  return tx.machine.update({ where: { id: m.id }, data: { status, statusChangedAt: now } });
}

/** Process status: COMPLETED is only set by an explicit Check Out "Completed". */
export async function recomputeProcess(tx: Tx, woProcessId: string) {
  const p = await tx.workOrderProcess.findUniqueOrThrow({ where: { id: woProcessId } });
  if (p.status === "COMPLETED") return p;
  const running = await tx.productionSession.count({ where: { woProcessId, status: "RUNNING" } });
  const any = running ? 1 : await tx.productionSession.count({ where: { woProcessId } });
  const status = running ? "RUNNING" : any ? "PAUSED" : "PENDING";
  return status === p.status ? p : tx.workOrderProcess.update({ where: { id: woProcessId }, data: { status } });
}

/**
 * Work Order status from its sessions. Never becomes COMPLETED here: that
 * needs an explicit confirmation (planning.jo.complete).
 */
export async function recomputeWorkOrder(tx: Tx, workOrderId: string) {
  const wo = await tx.workOrder.findUniqueOrThrow({ where: { id: workOrderId } });
  if (!WORKABLE_WO.has(wo.status)) return wo;
  const running = await tx.productionSession.count({ where: { workOrderId, status: "RUNNING" } });
  const sessions = running ? 1 : await tx.productionSession.count({ where: { workOrderId } });
  const status = running ? "IN_PROGRESS" : sessions ? "PARTIALLY_COMPLETED" : "RELEASED";
  return status === wo.status ? wo : tx.workOrder.update({ where: { id: workOrderId }, data: { status } });
}

/** Status a Work Order returns to when taken off hold. */
export async function resumedStatus(tx: Tx, workOrderId: string): Promise<WorkOrder["status"]> {
  return (await tx.productionSession.count({ where: { workOrderId } })) ? "PARTIALLY_COMPLETED" : "RELEASED";
}

export interface ProcessQuantities {
  target: Qty;
  /** Most this process may produce / consume without a new authorisation. */
  authorized: Qty;
  good: Qty;
  reject: Qty;
  /** Target minus good output (never negative). */
  outstanding: Qty;
  /** Input still available to this process (seq 1: authorised good still allowed). */
  available: Qty;
  /** Quantity the next process has taken (good + reject of the next step). */
  acceptedByNext: Qty | null;
  previous: WorkOrderProcess | null;
}

/**
 * Quantity rules for one route step:
 * - Step 1: good output may reach target + authorised extra (rejects come on top).
 * - Later steps: good + reject may not exceed what the previous step passed on
 *   (its good output) + authorised extra.
 */
export function processQuantities(wo: Pick<WorkOrder, "quantity">, route: WorkOrderProcess[], p: WorkOrderProcess): ProcessQuantities {
  const sorted = [...route].sort((a, b) => a.seq - b.seq);
  const idx = sorted.findIndex((x) => x.id === p.id);
  const previous = idx > 0 ? sorted[idx - 1]! : null;
  const next = idx >= 0 && idx < sorted.length - 1 ? sorted[idx + 1]! : null;
  const target = D(wo.quantity);
  const good = D(p.goodQty);
  const reject = D(p.rejectQty);
  const extra = D(p.extraAllowedQty);
  const authorized = previous ? D(previous.goodQty).plus(extra) : target.plus(extra);
  const used = previous ? good.plus(reject) : good;
  return {
    target,
    authorized,
    good,
    reject,
    outstanding: maxQ(target.minus(good), ZERO),
    available: maxQ(authorized.minus(used), ZERO),
    acceptedByNext: next ? D(next.goodQty).plus(D(next.rejectQty)) : null,
    previous,
  };
}

/** Largest good / reject addition allowed now (null = no limit for rejects on step 1). */
export function checkAddition(qty: ProcessQuantities, addGood: Qty, addReject: Qty): string | null {
  if (qty.previous) {
    if (addGood.plus(addReject).greaterThan(qty.available)) {
      return `Good + reject can't exceed the ${q(qty.available)} still received from the previous process. A supervisor can authorise extra quantity.`;
    }
  } else if (addGood.greaterThan(qty.available)) {
    return `Good output can't exceed the authorised quantity: only ${q(qty.available)} more is allowed. A supervisor can authorise extra quantity.`;
  }
  return null;
}

export const qtyView = (x: ProcessQuantities) => ({
  target: q(x.target),
  authorized: q(x.authorized),
  good: q(x.good),
  reject: q(x.reject),
  outstanding: q(x.outstanding),
  available: q(x.available),
  acceptedByNext: x.acceptedByNext ? q(x.acceptedByNext) : null,
});
