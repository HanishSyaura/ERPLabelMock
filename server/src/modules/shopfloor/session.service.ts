import type { Machine, WorkOrder, WorkOrderProcess } from "../../generated/prisma/client";
import { errors } from "../../lib/errors";
import { nextNumber } from "../../lib/numbering";
import type { Db, DbOrTx, Tx } from "../../lib/prisma";
import { D, q, ZERO, type Qty } from "../../lib/qty";
import type { AuthUser, RequestContext } from "../../middleware/context";
import { recordAudit } from "../audit/audit.service";
import { BLOCKED_MACHINE, checkAddition, processQuantities, recomputeMachine, recomputeProcess, recomputeWorkOrder, setMachineStatus, WORKABLE_WO } from "./state";

/**
 * Shopfloor session engine. Check In = START WORK, Check Out = END WORK.
 * One code path for handheld and desktop. Every write:
 *   lock machine row, then Work Order process row (fixed order, no deadlocks)
 *   -> validate -> write -> recompute statuses -> audit, in one transaction.
 */
export interface Actor {
  user: AuthUser;
  ctx: RequestContext;
}

export const BREAKDOWN_REASONS = [
  { code: "MECHANICAL", label: "Mechanical failure" },
  { code: "ELECTRICAL", label: "Electrical failure" },
  { code: "SENSOR_CONTROL", label: "Sensor / control failure" },
  { code: "MATERIAL_JAM", label: "Material jam" },
  { code: "SETUP_ISSUE", label: "Machine setup issue" },
  { code: "OTHER", label: "Other" },
] as const;
export const BREAKDOWN_CODES = BREAKDOWN_REASONS.map((r) => r.code) as [string, ...string[]];

const SESSION_STATUS_FOR = {
  COMPLETED: "COMPLETED",
  PARTIAL: "PAUSED",
  SHIFT_END: "CLOSED",
  MACHINE_CHANGE: "TRANSFERRED",
  MACHINE_BREAKDOWN: "BREAKDOWN",
} as const;
export type CheckOutType = keyof typeof SESSION_STATUS_FOR;

const audit = (tx: Tx, a: Actor, action: string, entityType: string, entityId: string, ref: string, extra: { previous?: unknown; next?: unknown; remarks?: string | null } = {}) =>
  recordAudit(tx, a.ctx, { module: "shopfloor", action, entityType, entityId, recordRef: ref, ...extra });

// ---------------------------------------------------------------------------
// Idempotency
// ---------------------------------------------------------------------------

/**
 * READ COMMITTED: after taking a row lock, re-checks must see rows other
 * transactions committed meanwhile (MySQL's default REPEATABLE READ would keep
 * reading the transaction's first snapshot and miss a concurrent Check In).
 */
export const SHOPFLOOR_TX = { isolationLevel: "ReadCommitted" as const, timeout: 15_000 };

const isUnique = (e: unknown) => {
  const err = e as { code?: string; message?: string };
  return err?.code === "P2002" || /Duplicate entry/i.test(err?.message ?? "");
};

/**
 * Run a handheld transaction once per client transaction id. A retry after a
 * network drop gets the stored response; nothing is applied twice.
 */
export async function idempotent<T extends object>(db: Db, a: Actor, clientTxnId: string, kind: string, fn: (tx: Tx) => Promise<T>): Promise<T & { replayed: boolean }> {
  const replay = async () => {
    const row = await db.shopfloorTransaction.findUnique({ where: { clientTxnId } });
    if (!row) return null;
    if (row.userId !== a.user.id || row.kind !== kind) throw errors.conflict("This transaction id was already used for a different request.");
    return { ...(row.response as T), replayed: true };
  };
  const earlier = await replay();
  if (earlier) return earlier;
  try {
    return await db.$transaction(async (tx) => {
      // Claim the id first: a concurrent duplicate blocks here, then fails on the unique key.
      await tx.shopfloorTransaction.create({ data: { clientTxnId, kind, userId: a.user.id, response: {} } });
      const result = await fn(tx);
      await tx.shopfloorTransaction.update({ where: { clientTxnId }, data: { response: result as never } });
      return { ...result, replayed: false };
    }, SHOPFLOOR_TX);
  } catch (e) {
    if (isUnique(e)) {
      const again = await replay();
      if (again) return again;
    }
    throw e;
  }
}

// ---------------------------------------------------------------------------
// Locks & loading
// ---------------------------------------------------------------------------

async function lockMachine(tx: Tx, id: string): Promise<Machine> {
  await tx.$queryRaw`SELECT id FROM machines WHERE id = ${id} FOR UPDATE`;
  const m = await tx.machine.findUnique({ where: { id } });
  if (!m) throw errors.notFound("Machine");
  return m;
}
async function lockProcess(tx: Tx, id: string) {
  await tx.$queryRaw`SELECT id FROM work_order_processes WHERE id = ${id} FOR UPDATE`;
  return tx.workOrderProcess.findUniqueOrThrow({ where: { id } });
}
async function route(tx: DbOrTx, workOrderId: string) {
  return tx.workOrderProcess.findMany({ where: { workOrderId }, orderBy: { seq: "asc" } });
}

// ---------------------------------------------------------------------------
// Eligibility (shared by scan screens and Check In)
// ---------------------------------------------------------------------------

export interface Blocker {
  code: string;
  message: string;
}

export async function machineBlockers(db: DbOrTx, machine: Machine & { categoryId: string }, user: AuthUser): Promise<Blocker[]> {
  const out: Blocker[] = [];
  if (!machine.isActive) out.push({ code: "MACHINE_INACTIVE", message: `Machine ${machine.code} is deactivated.` });
  if (BLOCKED_MACHINE.has(machine.status)) out.push({ code: "MACHINE_BLOCKED", message: `Machine ${machine.code} is under ${machine.status.toLowerCase()}. It can't start production.` });
  if (!user.permissions.has("shopfloor.machine.any")) {
    const qualified = await db.operatorQualification.count({ where: { userId: user.id, categoryId: machine.categoryId } });
    if (!qualified) out.push({ code: "NOT_QUALIFIED", message: `You are not authorised to operate ${machine.code}. Ask a supervisor to add you to its machine category.` });
  }
  return out;
}

/**
 * Which route step of this Work Order can run on this machine, or why not.
 * Returns the step (lowest eligible seq) plus blockers when none qualifies.
 */
export async function workOrderEligibility(db: DbOrTx, wo: WorkOrder, machine: Machine, user: AuthUser) {
  const blockers: Blocker[] = [...(await machineBlockers(db, machine, user))];
  if (wo.status === "PLANNED") blockers.push({ code: "WO_NOT_RELEASED", message: `${wo.woNo} is not released for production yet.` });
  else if (wo.status === "ON_HOLD") blockers.push({ code: "WO_ON_HOLD", message: `${wo.woNo} is on hold${wo.holdReason ? `: ${wo.holdReason}` : ""}.` });
  else if (!WORKABLE_WO.has(wo.status)) blockers.push({ code: "WO_CLOSED", message: `${wo.woNo} is ${wo.status.toLowerCase()}.` });

  const steps = await route(db, wo.id);
  const supported = new Set((await db.machineCategoryProcess.findMany({ where: { categoryId: machine.categoryId } })).map((c) => c.processId));
  const processNames = new Map((await db.process.findMany({ where: { id: { in: steps.map((s) => s.processId) } }, select: { id: true, name: true } })).map((p) => [p.id, p.name]));
  const open = steps.filter((s) => s.status !== "COMPLETED");
  if (!open.length && !blockers.length) blockers.push({ code: "WO_ALL_DONE", message: `Every process of ${wo.woNo} is completed.` });

  const stepReasons: Blocker[] = [];
  let chosen: WorkOrderProcess | null = null;
  for (const s of open) {
    const name = processNames.get(s.processId) ?? "process";
    if (!supported.has(s.processId)) continue;
    const qty = processQuantities(wo, steps, s);
    const prev = qty.previous;
    if (prev && prev.status !== "COMPLETED" && !s.allowPartialTransfer) {
      stepReasons.push({ code: "PREVIOUS_NOT_DONE", message: `${processNames.get(prev.processId)} must be completed before ${name} (or a supervisor approves partial transfer).` });
      continue;
    }
    if (qty.outstanding.lessThanOrEqualTo(ZERO) && !prev) {
      stepReasons.push({ code: "NOTHING_OUTSTANDING", message: `${name} has no outstanding quantity.` });
      continue;
    }
    if (qty.available.lessThanOrEqualTo(ZERO)) {
      stepReasons.push({ code: "NOTHING_AVAILABLE", message: prev ? `No quantity is waiting from ${processNames.get(prev.processId)} for ${name}.` : `${name} has reached its authorised quantity.` });
      continue;
    }
    const pending = await db.machineChange.findFirst({ where: { woProcessId: s.id, status: "PENDING" } });
    if (pending) {
      stepReasons.push({ code: "CHANGE_PENDING", message: `A machine change for ${name} is waiting for supervisor approval.` });
      continue;
    }
    const running = await db.productionSession.findMany({ where: { woProcessId: s.id, status: "RUNNING" }, include: { machine: { select: { code: true } } } });
    if (running.some((r) => r.machineId === machine.id)) {
      stepReasons.push({ code: "ALREADY_RUNNING", message: `${wo.woNo} ${name} is already running on this machine.` });
      continue;
    }
    if (running.length && !s.allowSplit) {
      stepReasons.push({ code: "ALREADY_RUNNING", message: `${wo.woNo} ${name} is already running on ${running[0]!.machine.code}. Split production is not authorised.` });
      continue;
    }
    if (s.assignedMachineId && s.assignedMachineId !== machine.id && !s.allowSplit) {
      const assigned = await db.machine.findUnique({ where: { id: s.assignedMachineId }, select: { code: true } });
      stepReasons.push({ code: "ASSIGNED_ELSEWHERE", message: `${name} is assigned to machine ${assigned?.code}. Use Change Machine to move it here.` });
      continue;
    }
    chosen = s;
    break;
  }
  if (!chosen && !stepReasons.length && open.length) {
    const current = open[0]!;
    stepReasons.push({ code: "PROCESS_NOT_SUPPORTED", message: `${wo.woNo} needs ${processNames.get(current.processId)}. Machine ${machine.code} can't do that process.` });
  }
  if (!chosen) blockers.push(...stepReasons);
  // Machine / Work Order blockers always win: no step may start while any exist.
  const step = blockers.length ? null : chosen;
  return { step, blockers, processName: step ? (processNames.get(step.processId) ?? null) : null };
}

// ---------------------------------------------------------------------------
// Check In
// ---------------------------------------------------------------------------

export async function checkIn(tx: Tx, a: Actor, input: { machineId: string; workOrderId: string }, now: Date) {
  const machine = await lockMachine(tx, input.machineId);
  const wo = await tx.workOrder.findUnique({ where: { id: input.workOrderId } });
  if (!wo) throw errors.notFound("Job Order");
  if (await tx.productionSession.count({ where: { machineId: machine.id, status: "RUNNING" } })) {
    const running = await tx.productionSession.findFirstOrThrow({ where: { machineId: machine.id, status: "RUNNING" }, include: { workOrder: { select: { woNo: true } } } });
    throw errors.rule("MACHINE_BUSY", `Machine ${machine.code} is already running ${running.workOrder.woNo}. Check Out first.`);
  }
  const first = await workOrderEligibility(tx, wo, machine, a.user);
  if (!first.step) throw errors.rule(first.blockers[0]!.code, first.blockers[0]!.message, { blockers: first.blockers });
  // Lock the chosen step and re-check under the lock.
  await lockProcess(tx, first.step.id);
  const { step, blockers } = await workOrderEligibility(tx, wo, machine, a.user);
  if (!step || step.id !== first.step.id) throw errors.rule(blockers[0]?.code ?? "CONFLICT", blockers[0]?.message ?? "The Job Order changed. Scan it again.");

  const qty = processQuantities(wo, await route(tx, wo.id), step);
  const sessionNo = await nextNumber(tx, "SES", now);
  const session = await tx.productionSession.create({
    data: {
      sessionNo,
      workOrderId: wo.id,
      woProcessId: step.id,
      machineId: machine.id,
      operatorId: a.user.id,
      checkInAt: now,
      availableAtStart: qty.available,
      checkInDeviceId: a.ctx.deviceId,
    },
  });
  await tx.workOrderProcess.update({
    where: { id: step.id },
    data: { assignedMachineId: step.allowSplit ? (step.assignedMachineId ?? machine.id) : machine.id, startedAt: step.startedAt ?? now },
  });
  await recomputeProcess(tx, step.id);
  await recomputeWorkOrder(tx, wo.id);
  await setMachineStatus(tx, machine, "RUNNING", now);
  await audit(tx, a, "CHECK_IN", "production_session", session.id, `${sessionNo} · ${wo.woNo}`, {
    next: { workOrder: wo.woNo, process: first.processName, machine: machine.code, operator: a.user.username, availableAtStart: q(qty.available), deviceId: a.ctx.deviceId },
  });
  return { sessionId: session.id, sessionNo, checkInAt: now.toISOString(), process: first.processName, available: q(qty.available) };
}

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

async function loadRunningSession(tx: Tx, a: Actor, sessionId: string) {
  const s0 = await tx.productionSession.findUnique({ where: { id: sessionId } });
  if (!s0) throw errors.notFound("Production session");
  const machine = await lockMachine(tx, s0.machineId);
  const step = await lockProcess(tx, s0.woProcessId);
  const session = await tx.productionSession.findUniqueOrThrow({ where: { id: sessionId } });
  if (session.status !== "RUNNING") throw errors.rule("SESSION_NOT_RUNNING", `Session ${session.sessionNo} has already been checked out.`);
  if (session.operatorId !== a.user.id && !a.user.permissions.has("shopfloor.session.supervise")) {
    throw errors.forbidden("This session belongs to another operator. A supervisor can record on it.");
  }
  const wo = await tx.workOrder.findUniqueOrThrow({ where: { id: session.workOrderId } });
  return { session, machine, step, wo };
}

async function addOutput(
  tx: Tx,
  a: Actor,
  ctx: { session: { id: string; woProcessId: string; machineId: string; operatorId: string }; step: WorkOrderProcess },
  kind: string,
  good: Qty,
  reject: Qty,
  rejectReason: string | null,
  now: Date,
) {
  if (good.isZero() && reject.isZero()) return;
  await tx.productionOutput.create({
    data: {
      sessionId: ctx.session.id,
      woProcessId: ctx.session.woProcessId,
      machineId: ctx.session.machineId,
      operatorId: a.user.id,
      kind,
      goodQty: good,
      rejectQty: reject,
      rejectReason,
      recordedAt: now,
      deviceId: a.ctx.deviceId,
    },
  });
  await tx.productionSession.update({ where: { id: ctx.session.id }, data: { goodQty: { increment: good }, rejectQty: { increment: reject } } });
  await tx.workOrderProcess.update({ where: { id: ctx.step.id }, data: { goodQty: { increment: good }, rejectQty: { increment: reject } } });
}

export async function recordOutput(tx: Tx, a: Actor, sessionId: string, input: { goodQty: string | number; rejectQty: string | number; rejectReason?: string | null }, now: Date) {
  const { session, step, wo } = await loadRunningSession(tx, a, sessionId);
  const good = D(input.goodQty);
  const reject = D(input.rejectQty);
  if (good.isZero() && reject.isZero()) throw errors.validation([{ path: "goodQty", message: "Enter good or reject quantity" }]);
  const qty = processQuantities(wo, await route(tx, wo.id), step);
  const problem = checkAddition(qty, good, reject);
  if (problem) throw errors.rule("QTY_EXCEEDS_AUTHORIZED", problem);
  await addOutput(tx, a, { session, step }, "INTERIM", good, reject, input.rejectReason ?? null, now);
  const after = await tx.productionSession.findUniqueOrThrow({ where: { id: sessionId } });
  await audit(tx, a, "OUTPUT_RECORDED", "production_session", sessionId, `${session.sessionNo} · ${wo.woNo}`, {
    next: { good: q(good), reject: q(reject), sessionGood: q(after.goodQty), sessionReject: q(after.rejectQty), rejectReason: input.rejectReason ?? null },
  });
  return { sessionGood: q(after.goodQty), sessionReject: q(after.rejectQty) };
}

// ---------------------------------------------------------------------------
// Check Out
// ---------------------------------------------------------------------------

export interface CheckOutInput {
  totalGood: string | number;
  totalReject: string | number;
  type: CheckOutType;
  remarks?: string | null;
  rejectReason?: string | null;
  toMachineId?: string | null;
  changeReason?: string | null;
  breakdownReason?: string | null;
}

export async function checkOut(tx: Tx, a: Actor, sessionId: string, input: CheckOutInput, now: Date) {
  const { session, machine, step, wo } = await loadRunningSession(tx, a, sessionId);
  const totalGood = D(input.totalGood);
  const totalReject = D(input.totalReject);
  const addGood = totalGood.minus(D(session.goodQty));
  const addReject = totalReject.minus(D(session.rejectQty));
  if (addGood.isNegative() || addReject.isNegative()) {
    throw errors.rule("OUTPUT_BELOW_RECORDED", `This session already recorded ${q(session.goodQty)} good and ${q(session.rejectQty)} reject. Totals can't be lower; a supervisor corrects recorded output.`);
  }
  const steps = await route(tx, wo.id);
  const qty = processQuantities(wo, steps, step);
  const problem = checkAddition(qty, addGood, addReject);
  if (problem) throw errors.rule("QTY_EXCEEDS_AUTHORIZED", problem);

  if (input.type === "COMPLETED") {
    const others = await tx.productionSession.count({ where: { woProcessId: step.id, status: "RUNNING", id: { not: session.id } } });
    if (others) throw errors.rule("OTHERS_RUNNING", "Other machines are still running this process. Check Out as Partial, or complete it after they finish.");
    const processGoodAfter = D(step.goodQty).plus(addGood);
    if (processGoodAfter.lessThan(qty.target) && !input.remarks?.trim()) {
      throw errors.validation([{ path: "remarks", message: `Good output ${q(processGoodAfter)} is below the target ${q(qty.target)}. Give a reason to complete the process.` }]);
    }
  }
  if (input.type === "MACHINE_CHANGE" && (!input.toMachineId || !input.changeReason?.trim())) {
    throw errors.validation([...(!input.toMachineId ? [{ path: "toMachineId", message: "Choose the machine to continue on" }] : []), ...(!input.changeReason?.trim() ? [{ path: "changeReason", message: "Give the reason for the machine change" }] : [])]);
  }
  if (input.type === "MACHINE_BREAKDOWN" && !input.breakdownReason) throw errors.validation([{ path: "breakdownReason", message: "Choose the breakdown reason" }]);

  await addOutput(tx, a, { session, step }, input.type === "MACHINE_BREAKDOWN" ? "BREAKDOWN" : "CHECKOUT", addGood, addReject, input.rejectReason ?? null, now);
  const closed = await tx.productionSession.update({
    where: { id: session.id },
    data: { status: SESSION_STATUS_FOR[input.type], checkOutType: input.type, checkOutAt: now, remarks: input.remarks?.trim() || null, checkOutDeviceId: a.ctx.deviceId, checkOutById: a.user.id },
  });

  if (input.type === "COMPLETED") {
    await tx.workOrderProcess.update({ where: { id: step.id }, data: { status: "COMPLETED", completedAt: now, completedById: a.user.id, completionNote: input.remarks?.trim() || null } });
  } else {
    await recomputeProcess(tx, step.id);
  }

  let breakdownNo: string | null = null;
  let change: { id: string; status: string } | null = null;
  if (input.type === "MACHINE_BREAKDOWN") {
    breakdownNo = await createBreakdown(tx, a, machine, { sessionId: session.id, workOrderId: wo.id, woProcessId: step.id, reason: input.breakdownReason!, remarks: input.remarks ?? null, lastConfirmedGood: totalGood }, now);
  } else {
    await recomputeMachine(tx, machine.id, now);
  }
  if (input.type === "MACHINE_CHANGE") {
    change = await createMachineChange(tx, a, { woProcessId: step.id, toMachineId: input.toMachineId!, reason: input.changeReason!, fromSessionId: session.id }, now);
  }
  await recomputeWorkOrder(tx, wo.id);

  const after = processQuantities(wo, await route(tx, wo.id), await tx.workOrderProcess.findUniqueOrThrow({ where: { id: step.id } }));
  await audit(tx, a, "CHECK_OUT", "production_session", session.id, `${session.sessionNo} · ${wo.woNo}`, {
    previous: { status: "RUNNING" },
    next: {
      status: closed.status,
      type: input.type,
      machine: machine.code,
      sessionGood: q(totalGood),
      sessionReject: q(totalReject),
      processGood: q(after.good),
      outstanding: q(after.outstanding),
      ...(breakdownNo ? { breakdownNo } : {}),
      ...(change ? { machineChange: change.status } : {}),
    },
    remarks: input.remarks ?? null,
  });
  return {
    sessionNo: session.sessionNo,
    status: closed.status,
    sessionGood: q(totalGood),
    sessionReject: q(totalReject),
    processGood: q(after.good),
    outstanding: q(after.outstanding),
    breakdownNo,
    machineChange: change,
  };
}

// ---------------------------------------------------------------------------
// Breakdown & maintenance
// ---------------------------------------------------------------------------

async function createBreakdown(
  tx: Tx,
  a: Actor,
  machine: Machine,
  input: { sessionId: string | null; workOrderId: string | null; woProcessId: string | null; reason: string; remarks: string | null; lastConfirmedGood: Qty | null },
  now: Date,
) {
  const breakdownNo = await nextNumber(tx, "BRK", now);
  await tx.machineBreakdown.create({
    data: {
      breakdownNo,
      machineId: machine.id,
      sessionId: input.sessionId,
      workOrderId: input.workOrderId,
      woProcessId: input.woProcessId,
      reason: input.reason,
      remarks: input.remarks,
      reportedAt: now,
      reportedById: a.user.id,
      lastConfirmedGood: input.lastConfirmedGood,
    },
  });
  await setMachineStatus(tx, machine, "BREAKDOWN", now);
  await audit(tx, a, "BREAKDOWN_REPORTED", "machine", machine.id, `${breakdownNo} · ${machine.code}`, {
    previous: { status: machine.status },
    next: { status: "BREAKDOWN", reason: input.reason, lastConfirmedGood: input.lastConfirmedGood ? q(input.lastConfirmedGood) : null },
    remarks: input.remarks,
  });
  return breakdownNo;
}

/**
 * Report Breakdown from the machine dashboard. A running session is checked
 * out as MACHINE_BREAKDOWN with the operator's latest confirmed totals.
 */
export async function reportBreakdown(
  tx: Tx,
  a: Actor,
  machineId: string,
  input: { reason: string; remarks?: string | null; totalGood?: string | number; totalReject?: string | number },
  now: Date,
) {
  const machine = await lockMachine(tx, machineId);
  if (machine.status === "BREAKDOWN") throw errors.rule("ALREADY_BREAKDOWN", `Machine ${machine.code} is already reported as broken down.`);
  const running = await tx.productionSession.findFirst({ where: { machineId, status: "RUNNING" } });
  if (running) {
    const result = await checkOut(
      tx,
      a,
      running.id,
      {
        type: "MACHINE_BREAKDOWN",
        totalGood: input.totalGood ?? q(running.goodQty),
        totalReject: input.totalReject ?? q(running.rejectQty),
        breakdownReason: input.reason,
        remarks: input.remarks ?? null,
      },
      now,
    );
    return { breakdownNo: result.breakdownNo!, sessionNo: result.sessionNo, outstanding: result.outstanding };
  }
  const breakdownNo = await createBreakdown(tx, a, machine, { sessionId: null, workOrderId: null, woProcessId: null, reason: input.reason, remarks: input.remarks ?? null, lastConfirmedGood: null }, now);
  return { breakdownNo, sessionNo: null, outstanding: null };
}

export async function startMaintenance(tx: Tx, a: Actor, breakdownId: string, note: string | null, now: Date) {
  const b0 = await tx.machineBreakdown.findUnique({ where: { id: breakdownId } });
  if (!b0) throw errors.notFound("Breakdown");
  const machine = await lockMachine(tx, b0.machineId);
  const b = await tx.machineBreakdown.findUniqueOrThrow({ where: { id: breakdownId } });
  if (b.status !== "OPEN") throw errors.rule("BREAKDOWN_NOT_OPEN", "Maintenance has already started or the breakdown is resolved.");
  await tx.machineBreakdown.update({ where: { id: b.id }, data: { status: "UNDER_MAINTENANCE", maintenanceNote: note, maintenanceStartedAt: now, maintenanceById: a.user.id } });
  await setMachineStatus(tx, machine, "MAINTENANCE", now);
  await audit(tx, a, "MAINTENANCE_STARTED", "machine", machine.id, `${b.breakdownNo} · ${machine.code}`, { previous: { status: machine.status }, next: { status: "MAINTENANCE" }, remarks: note });
  return { status: "UNDER_MAINTENANCE" };
}

/**
 * Release a machine after breakdown. The releasing person must confirm the
 * physical inspection and safety clearance done under the factory's own
 * procedure; the system only records that confirmation.
 */
export async function releaseBreakdown(tx: Tx, a: Actor, breakdownId: string, input: { resolutionNote: string; safetyConfirmed: boolean }, now: Date) {
  if (!input.safetyConfirmed) throw errors.validation([{ path: "safetyConfirmed", message: "Confirm that the physical inspection and safety clearance are done" }]);
  const b0 = await tx.machineBreakdown.findUnique({ where: { id: breakdownId } });
  if (!b0) throw errors.notFound("Breakdown");
  const machine = await lockMachine(tx, b0.machineId);
  const b = await tx.machineBreakdown.findUniqueOrThrow({ where: { id: breakdownId } });
  if (b.status === "RESOLVED") throw errors.rule("BREAKDOWN_RESOLVED", "This breakdown is already resolved.");
  await tx.machineBreakdown.update({ where: { id: b.id }, data: { status: "RESOLVED", resolvedAt: now, resolvedById: a.user.id, resolutionNote: input.resolutionNote, safetyConfirmed: true } });
  const stillOpen = await tx.machineBreakdown.count({ where: { machineId: machine.id, status: { not: "RESOLVED" } } });
  let status = machine.status;
  if (!stillOpen) {
    const base = await tx.machine.update({ where: { id: machine.id }, data: { status: "AVAILABLE", statusChangedAt: now } });
    status = (await recomputeMachine(tx, base.id, now)).status;
  }
  await audit(tx, a, "MACHINE_RELEASED", "machine", machine.id, `${b.breakdownNo} · ${machine.code}`, {
    previous: { status: machine.status },
    next: { status, safetyConfirmed: true },
    remarks: input.resolutionNote,
  });
  return { machineStatus: status };
}

/** Manual status: take a machine offline / into planned maintenance, or back. */
export async function setManualStatus(tx: Tx, a: Actor, machineId: string, input: { status: "OFFLINE" | "MAINTENANCE" | "AVAILABLE"; note: string; safetyConfirmed?: boolean }, now: Date) {
  const machine = await lockMachine(tx, machineId);
  if (input.status === machine.status) return { machineStatus: machine.status };
  if (input.status !== "AVAILABLE") {
    if (await tx.productionSession.count({ where: { machineId, status: "RUNNING" } })) throw errors.rule("MACHINE_BUSY", "Check Out the running session first.");
    await setMachineStatus(tx, machine, input.status, now);
  } else {
    if (machine.status === "BREAKDOWN" || (await tx.machineBreakdown.count({ where: { machineId, status: { not: "RESOLVED" } } }))) {
      throw errors.rule("OPEN_BREAKDOWN", "This machine has an open breakdown. Release it from the breakdown record.");
    }
    if (machine.status === "MAINTENANCE" && !input.safetyConfirmed) {
      throw errors.validation([{ path: "safetyConfirmed", message: "Confirm that the physical inspection and safety clearance are done" }]);
    }
    await tx.machine.update({ where: { id: machineId }, data: { status: "AVAILABLE", statusChangedAt: now } });
    await recomputeMachine(tx, machineId, now);
  }
  const after = await tx.machine.findUniqueOrThrow({ where: { id: machineId } });
  await audit(tx, a, "MACHINE_STATUS_CHANGED", "machine", machineId, machine.code, { previous: { status: machine.status }, next: { status: after.status }, remarks: input.note });
  return { machineStatus: after.status };
}

// ---------------------------------------------------------------------------
// Machine change
// ---------------------------------------------------------------------------

/** Machines that could take over a route step, with why not when they can't. */
export async function alternativeMachines(db: DbOrTx, woProcessId: string) {
  const step = await db.workOrderProcess.findUnique({ where: { id: woProcessId } });
  if (!step) throw errors.notFound("Job Order process");
  const machines = await db.machine.findMany({
    where: { isActive: true, category: { status: "ACTIVE", processes: { some: { processId: step.processId } } } },
    include: { category: { select: { code: true, name: true } } },
    orderBy: { code: "asc" },
  });
  const running = await db.productionSession.findMany({ where: { machineId: { in: machines.map((m) => m.id) }, status: "RUNNING" }, include: { workOrder: { select: { woNo: true } } } });
  return machines
    .filter((m) => m.id !== step.assignedMachineId)
    .map((m) => {
      const busy = running.find((r) => r.machineId === m.id);
      const blocked = BLOCKED_MACHINE.has(m.status);
      return {
        id: m.id,
        code: m.code,
        name: m.name,
        category: m.category,
        status: m.status,
        available: !blocked,
        note: blocked ? `Under ${m.status.toLowerCase()}` : busy ? `Running ${busy.workOrder.woNo} now (can take over after it checks out)` : null,
      };
    });
}

async function createMachineChange(tx: Tx, a: Actor, input: { woProcessId: string; toMachineId: string; reason: string; fromSessionId: string | null }, now: Date) {
  const step = await tx.workOrderProcess.findUniqueOrThrow({ where: { id: input.woProcessId }, include: { workOrder: true, process: true } });
  const to = await tx.machine.findUnique({ where: { id: input.toMachineId } });
  if (!to || !to.isActive) throw errors.validation([{ path: "toMachineId", message: "Choose an active machine" }]);
  if (to.id === step.assignedMachineId) throw errors.validation([{ path: "toMachineId", message: "The process is already assigned to this machine" }]);
  if (BLOCKED_MACHINE.has(to.status)) throw errors.rule("MACHINE_BLOCKED", `Machine ${to.code} is under ${to.status.toLowerCase()}.`);
  const supports = await tx.machineCategoryProcess.count({ where: { categoryId: to.categoryId, processId: step.processId } });
  if (!supports) throw errors.rule("PROCESS_NOT_SUPPORTED", `Machine ${to.code} can't do ${step.process.name}.`);
  if (await tx.machineChange.count({ where: { woProcessId: step.id, status: "PENDING" } })) throw errors.rule("CHANGE_PENDING", "A machine change for this process is already waiting for approval.");

  const from = step.assignedMachineId;
  const prev = from
    ? await tx.productionOutput.aggregate({ where: { woProcessId: step.id, machineId: from }, _sum: { goodQty: true, rejectQty: true } })
    : { _sum: { goodQty: null, rejectQty: null } };
  const qty = processQuantities(step.workOrder, await route(tx, step.workOrderId), step);
  const approve = a.user.permissions.has("shopfloor.machine.change.approve");
  const change = await tx.machineChange.create({
    data: {
      workOrderId: step.workOrderId,
      woProcessId: step.id,
      fromMachineId: from,
      toMachineId: to.id,
      fromSessionId: input.fromSessionId,
      prevMachineGood: D(prev._sum.goodQty),
      prevMachineReject: D(prev._sum.rejectQty),
      outstandingQty: qty.outstanding,
      reason: input.reason,
      status: approve ? "APPROVED" : "PENDING",
      requestedById: a.user.id,
      requestedAt: now,
      ...(approve ? { decidedById: a.user.id, decidedAt: now, decisionNote: "Applied by an authorised requester" } : {}),
    },
  });
  if (approve) await applyMachineChange(tx, step.id, from, to.id, now);
  const fromCode = from ? (await tx.machine.findUnique({ where: { id: from }, select: { code: true } }))?.code : null;
  await audit(tx, a, approve ? "MACHINE_CHANGE_APPLIED" : "MACHINE_CHANGE_REQUESTED", "work_order", step.workOrderId, `${step.workOrder.woNo} / ${step.process.name}`, {
    previous: { machine: fromCode ?? null, machineGood: q(prev._sum.goodQty), machineReject: q(prev._sum.rejectQty) },
    next: { machine: to.code, outstanding: q(qty.outstanding), status: change.status },
    remarks: input.reason,
  });
  return { id: change.id, status: change.status };
}

async function applyMachineChange(tx: Tx, woProcessId: string, fromMachineId: string | null, toMachineId: string, now: Date) {
  await tx.workOrderProcess.update({ where: { id: woProcessId }, data: { assignedMachineId: toMachineId } });
  if (fromMachineId) await recomputeMachine(tx, fromMachineId, now);
  await recomputeMachine(tx, toMachineId, now);
}

/** Change Machine for a paused / broken-down process (no running session). */
export async function requestMachineChange(tx: Tx, a: Actor, input: { woProcessId: string; toMachineId: string; reason: string }, now: Date) {
  const step = await lockProcess(tx, input.woProcessId);
  if (step.status === "COMPLETED") throw errors.rule("PROCESS_COMPLETED", "This process is already completed.");
  if (await tx.productionSession.count({ where: { woProcessId: step.id, status: "RUNNING" } })) {
    throw errors.rule("SESSION_RUNNING", "This process is running. Check Out with type Machine Change instead.");
  }
  const wo = await tx.workOrder.findUniqueOrThrow({ where: { id: step.workOrderId } });
  if (!WORKABLE_WO.has(wo.status) && wo.status !== "ON_HOLD") throw errors.rule("WO_CLOSED", `${wo.woNo} is ${wo.status.toLowerCase()}.`);
  return createMachineChange(tx, a, { ...input, fromSessionId: null }, now);
}

export async function decideMachineChange(tx: Tx, a: Actor, changeId: string, input: { approve: boolean; note: string | null }, now: Date) {
  const c0 = await tx.machineChange.findUnique({ where: { id: changeId } });
  if (!c0) throw errors.notFound("Machine change");
  const step = await lockProcess(tx, c0.woProcessId);
  const c = await tx.machineChange.findUniqueOrThrow({ where: { id: changeId } });
  if (c.status !== "PENDING") throw errors.rule("CHANGE_DECIDED", "This machine change has already been decided.");
  if (input.approve) {
    const to = await tx.machine.findUniqueOrThrow({ where: { id: c.toMachineId } });
    if (!to.isActive || BLOCKED_MACHINE.has(to.status)) throw errors.rule("MACHINE_BLOCKED", `Machine ${to.code} is not available now (${to.status.toLowerCase()}). Reject this request and choose another machine.`);
    await applyMachineChange(tx, step.id, step.assignedMachineId, to.id, now);
  }
  await tx.machineChange.update({ where: { id: c.id }, data: { status: input.approve ? "APPROVED" : "REJECTED", decidedById: a.user.id, decidedAt: now, decisionNote: input.note } });
  const wo = await tx.workOrder.findUniqueOrThrow({ where: { id: c.workOrderId } });
  await audit(tx, a, input.approve ? "MACHINE_CHANGE_APPROVED" : "MACHINE_CHANGE_REJECTED", "work_order", c.workOrderId, wo.woNo, { previous: { status: "PENDING" }, next: { status: input.approve ? "APPROVED" : "REJECTED" }, remarks: input.note });
  return { status: input.approve ? "APPROVED" : "REJECTED" };
}
