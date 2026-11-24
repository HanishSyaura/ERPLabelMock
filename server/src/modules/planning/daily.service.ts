import type { Prisma } from "../../generated/prisma/client";
import { addDays, dayRange } from "../../lib/day";
import type { DbOrTx } from "../../lib/prisma";
import { D, q, ZERO } from "../../lib/qty";

/**
 * Daily Job Information, pulled straight from the Job Orders of released
 * Production Job Orders (no separate pre-plan):
 * - Planned: released PJO, Job Order not started yet (no production session).
 * - In Progress: Job Order with at least one session that is not completed
 *   (running, paused between sessions, or on hold).
 * - Completed: Job Orders confirmed complete on the selected day.
 * "Output today" is what was recorded on the selected day.
 */

export type DailyStage = "PLANNED" | "IN_PROGRESS" | "COMPLETED";

const INCLUDE = {
  processes: { orderBy: { seq: "asc" }, include: { process: { select: { name: true } } } },
  pjo: { select: { id: true, pjoNo: true, customerRef: true, requiredDate: true, bom: { select: { fatherCode: true } }, artworkRevision: { select: { labelDescription: true } } } },
  _count: { select: { sessions: true } },
} satisfies Prisma.WorkOrderInclude;

type JobRow = Prisma.WorkOrderGetPayload<{ include: typeof INCLUDE }>;

/** Material readiness per Job Order: none issued / partly issued / issued. */
async function materialState(db: DbOrTx, workOrderIds: string[]) {
  const lines = workOrderIds.length
    ? await db.mrsLine.findMany({
        where: { mrs: { workOrderId: { in: workOrderIds }, status: { not: "CANCELLED" } } },
        select: { requestedQty: true, issuedQty: true, mrs: { select: { workOrderId: true } } },
      })
    : [];
  const state = new Map<string, "NONE" | "PARTIAL" | "ISSUED">();
  for (const id of workOrderIds) {
    const own = lines.filter((l) => l.mrs.workOrderId === id);
    if (!own.length || own.every((l) => D(l.issuedQty).isZero())) state.set(id, "NONE");
    else if (own.some((l) => D(l.issuedQty).lessThan(D(l.requestedQty)))) state.set(id, "PARTIAL");
    else state.set(id, "ISSUED");
  }
  return state;
}

export async function dailyView(db: DbOrTx, day: string, _now: Date) {
  const { start, end } = dayRange(day);
  const [planned, inProgress, completed] = await Promise.all([
    db.workOrder.findMany({
      where: { status: { in: ["PLANNED", "RELEASED"] }, pjo: { status: "RELEASED" }, sessions: { none: {} } },
      orderBy: [{ plannedDate: "asc" }, { woNo: "asc" }],
      include: INCLUDE,
    }),
    db.workOrder.findMany({
      where: { status: { in: ["RELEASED", "IN_PROGRESS", "PARTIALLY_COMPLETED", "ON_HOLD"] }, sessions: { some: {} } },
      orderBy: [{ plannedDate: "asc" }, { woNo: "asc" }],
      include: INCLUDE,
    }),
    db.workOrder.findMany({
      where: { status: "COMPLETED", completedAt: { gte: start, lt: end } },
      orderBy: { completedAt: "desc" },
      include: INCLUDE,
    }),
  ]);
  const all = [...planned, ...inProgress, ...completed];
  const stepIds = all.flatMap((w) => w.processes.map((p) => p.id));
  const [outputs, running, material] = await Promise.all([
    stepIds.length
      ? db.productionOutput.groupBy({ by: ["woProcessId"], where: { woProcessId: { in: stepIds }, recordedAt: { gte: start, lt: end } }, _sum: { goodQty: true, rejectQty: true } })
      : [],
    stepIds.length
      ? db.productionSession.findMany({ where: { woProcessId: { in: stepIds }, status: "RUNNING" }, select: { woProcessId: true, machine: { select: { code: true, name: true } } } })
      : [],
    materialState(db, all.map((w) => w.id)),
  ]);
  const machineIds = [...new Set(all.flatMap((w) => w.processes.map((p) => p.assignedMachineId).filter((m): m is string => !!m)))];
  const machines = machineIds.length ? await db.machine.findMany({ where: { id: { in: machineIds } }, select: { id: true, code: true, name: true } }) : [];
  const machineOf = new Map(machines.map((m) => [m.id, m]));
  const outputOf = new Map(outputs.map((o) => [o.woProcessId, { good: D(o._sum.goodQty), reject: D(o._sum.rejectQty) }]));
  const runningOf = new Map(running.map((s) => [s.woProcessId, s.machine]));

  const view = (w: JobRow, stage: DailyStage) => {
    const steps = w.processes;
    const done = steps.filter((s) => s.status === "COMPLETED").length;
    // Current step: running first, else the first one not completed, else the last.
    const current = steps.find((s) => runningOf.has(s.id)) ?? steps.find((s) => s.status !== "COMPLETED") ?? steps[steps.length - 1] ?? null;
    const last = steps[steps.length - 1];
    let good = ZERO;
    let reject = ZERO;
    for (const s of steps) {
      const o = outputOf.get(s.id);
      if (o) {
        good = good.plus(o.good);
        reject = reject.plus(o.reject);
      }
    }
    const machine = current ? (runningOf.get(current.id) ?? (current.assignedMachineId ? machineOf.get(current.assignedMachineId) : undefined)) : undefined;
    return {
      stage,
      id: w.id,
      woNo: w.woNo,
      status: w.status,
      holdReason: w.holdReason,
      quantity: q(w.quantity),
      uom: w.uom,
      plannedDate: w.plannedDate,
      priority: w.priority,
      completedAt: w.completedAt,
      pjo: { id: w.pjo.id, pjoNo: w.pjo.pjoNo, customerRef: w.pjo.customerRef, requiredDate: w.pjo.requiredDate },
      fatherCode: w.pjo.bom.fatherCode,
      labelDescription: w.pjo.artworkRevision.labelDescription,
      steps: { done, total: steps.length },
      current: current ? { seq: current.seq, name: current.process.name, status: current.status, goodQty: q(current.goodQty), rejectQty: q(current.rejectQty) } : null,
      machine: machine ? { code: machine.code, name: machine.name } : null,
      running: steps.some((s) => runningOf.has(s.id)),
      finishedQty: last ? q(last.goodQty) : "0",
      outputToday: { good: q(good), reject: q(reject) },
      material: material.get(w.id) ?? "NONE",
    };
  };

  const sections = {
    planned: planned.map((w) => view(w, "PLANNED")),
    inProgress: inProgress.map((w) => view(w, "IN_PROGRESS")),
    completed: completed.map((w) => view(w, "COMPLETED")),
  };
  return {
    date: day,
    previous: addDays(day, -1),
    next: addDays(day, 1),
    summary: {
      planned: sections.planned.length,
      inProgress: sections.inProgress.length,
      running: sections.inProgress.filter((r) => r.running).length,
      onHold: sections.inProgress.filter((r) => r.status === "ON_HOLD").length,
      completed: sections.completed.length,
    },
    ...sections,
  };
}
