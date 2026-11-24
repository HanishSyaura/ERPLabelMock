import { Router } from "express";
import { z } from "zod";
import type { Deps } from "../../deps";
import type { Prisma } from "../../generated/prisma/client";
import { addDays, dateColumn, dateColumnKey, dayKey, dayRange } from "../../lib/day";
import { ok, query } from "../../lib/http";
import { D, maxQ, q, ZERO } from "../../lib/qty";
import { requireAuth } from "../../middleware/auth";
import { hasPermission, requireUser } from "../../middleware/context";
import { lineBalances } from "../planning/material.service";
import { processQuantities } from "../shopfloor/state";

/**
 * Manufacturing dashboard (mounted at /dashboard). Every figure is counted
 * from transactions at request time – nothing stored, estimated or invented.
 * Sections appear only for modules the user may view (backend permissions).
 *
 * Definitions (so the numbers reconcile with the module lists):
 * - Open Work Order: PLANNED, RELEASED, IN_PROGRESS, PARTIALLY_COMPLETED, ON_HOLD.
 * - Overdue / due: the Production Job Order's required date (a DATE column,
 *   compared as a plant day – lib/day.ts) for open Work Orders.
 * - Output: good quantity of the Work Order's LAST route step (finished output),
 *   in the Work Order's own unit; totals are grouped by unit, never mixed.
 * - WIP: route steps of open Work Orders – running (a session is checked in),
 *   waiting (later step that may start now – previous step completed or partial
 *   transfer approved – with input passed on, not running),
 *   paused (sessions ended, step not completed). Quantities from processQuantities.
 * - Quality results: lots checked out inside the period (checkedOutAt).
 * Period: today / last 7 / last 30 plant days, server time zone.
 */
const OPEN_WO = ["PLANNED", "RELEASED", "IN_PROGRESS", "PARTIALLY_COMPLETED", "ON_HOLD"] as const;
const PERIODS = { today: 1, "7d": 7, "30d": 30 } as const;
const humanize = (s: string) => s.charAt(0) + s.slice(1).toLowerCase().replace(/_/g, " ");

type Severity = "critical" | "high" | "medium" | "low";
interface Alert {
  key: string;
  severity: Severity;
  type: string;
  record: string;
  reason: string;
  at: Date | null;
  role: string;
  action: string;
  path: string;
}
interface Activity {
  at: Date;
  kind: string;
  text: string;
  record: string;
  path: string;
  userId: string | null;
}

export function dashboardRoutes(deps: Deps) {
  const r = Router();
  const { db } = deps;

  r.get("/", requireAuth, async (req, res) => {
    const user = requireUser(req);
    const can = (k: string) => hasPermission(user, k);
    const f = query(req, z.object({ period: z.enum(["today", "7d", "30d"]).default("today"), processId: z.uuid().optional() }));
    const now = deps.now();
    const todayKey = dayKey(now);
    const todayCol = dateColumn(todayKey);
    const days = PERIODS[f.period];
    const from = dayRange(addDays(todayKey, -(days - 1))).start;
    const out: Record<string, unknown> = { generatedAt: now, period: { key: f.period, from, to: now, days } };
    const alerts: Alert[] = [];
    const activity: Activity[] = [];
    const kpis: Record<string, number> = {};

    const seeOrders = can("planning.pjo.view");
    const seeJobs = can("planning.jo.view") || can("shopfloor.wip.view");
    const seeFloor = can("shopfloor.output.view");
    const seeMrs = can("planning.mrs.view");
    const qcTypes = (["IQC", "OQC"] as const).filter((t) => can(`qc.${t.toLowerCase()}.view`));

    // ----- Production Job Orders ------------------------------------------------
    if (seeOrders) {
      const [groups, noJobs] = await Promise.all([
        db.productionJobOrder.groupBy({ by: ["status"], _count: { _all: true } }),
        db.productionJobOrder.findMany({
          where: { status: "RELEASED", workOrders: { none: { status: { not: "CANCELLED" } } } },
          orderBy: { requiredDate: { sort: "asc", nulls: "last" } },
          take: 10,
          select: { id: true, pjoNo: true, requiredDate: true, releasedAt: true },
        }),
      ]);
      const byStatus = Object.fromEntries(groups.map((g) => [g.status, g._count._all]));
      kpis.activeOrders = byStatus.RELEASED ?? 0;
      out.orders = { byStatus, releasedWithoutJobs: noJobs.length };
      for (const p of noJobs)
        alerts.push({
          key: `pjo-nojobs-${p.id}`,
          severity: p.requiredDate && p.requiredDate < todayCol ? "high" : "medium",
          type: "Order without Job Orders",
          record: p.pjoNo,
          reason: `Released${p.requiredDate ? `, required ${dateColumnKey(p.requiredDate)}` : ""}, but no Job Order has been created.`,
          at: p.releasedAt,
          role: "Production Planner",
          action: "Create Job Orders",
          path: `/planning/production-job-order/${p.id}`,
        });
    }

    // ----- Work Orders: status, progress, schedule, WIP --------------------------
    if (seeJobs) {
      const periodRange = { gte: from, lte: now };
      const open = await db.workOrder.findMany({
        where: { status: { in: [...OPEN_WO] } },
        include: {
          pjo: { select: { id: true, pjoNo: true, customerRef: true, requiredDate: true, bom: { select: { fatherCode: true } }, artworkRevision: { select: { labelDescription: true } } } },
          processes: { orderBy: { seq: "asc" }, include: { process: { select: { id: true, name: true } } } },
          _count: { select: { scheduleEntries: true } },
        },
      });
      const [groups, completed] = await Promise.all([
        db.workOrder.groupBy({ by: ["status"], _count: { _all: true } }),
        db.workOrder.findMany({ where: { status: "COMPLETED", completedAt: periodRange }, select: { quantity: true, uom: true, processes: { orderBy: { seq: "desc" }, take: 1, select: { goodQty: true } } } }),
      ]);
      const byStatus = Object.fromEntries(groups.map((g) => [g.status, g._count._all]));
      const weekCol = dateColumn(addDays(todayKey, 7));
      const soonCol = dateColumn(addDays(todayKey, 2));
      const rows = open.map((w) => {
        const last = w.processes[w.processes.length - 1];
        const output = last ? D(last.goodQty) : ZERO;
        const req = w.pjo.requiredDate;
        const due = !req ? "none" : req < todayCol ? "overdue" : req.getTime() === todayCol.getTime() ? "today" : req < weekCol ? "week" : "later";
        const current = w.processes.find((p) => p.status !== "COMPLETED") ?? null;
        return {
          id: w.id, woNo: w.woNo, status: w.status, priority: w.priority, pjoId: w.pjo.id, pjoNo: w.pjo.pjoNo, customerRef: w.pjo.customerRef,
          fatherCode: w.pjo.bom.fatherCode, labelDescription: w.pjo.artworkRevision.labelDescription, uom: w.uom,
          planned: q(w.quantity), output: q(output), remaining: q(maxQ(D(w.quantity).minus(output), ZERO)),
          requiredDate: req ? dateColumnKey(req) : null, plannedDate: w.plannedDate ? dateColumnKey(w.plannedDate) : null, due,
          scheduled: !!w.plannedDate || w._count.scheduleEntries > 0,
          currentProcess: current ? `${current.seq}/${w.processes.length} ${current.process.name}` : "All steps done",
          allStepsDone: w.processes.length > 0 && w.processes.every((p) => p.status === "COMPLETED"),
          _req: req,
        };
      });
      const progress = new Map<string, { uom: string; planned: number; output: number; remaining: number; workOrders: number }>();
      for (const x of rows) {
        if (x.status === "PLANNED") continue; // not released to production yet
        const g = progress.get(x.uom) ?? { uom: x.uom, planned: 0, output: 0, remaining: 0, workOrders: 0 };
        g.planned += Number(x.planned);
        g.output += Number(x.output);
        g.remaining += Number(x.remaining);
        g.workOrders += 1;
        progress.set(x.uom, g);
      }
      const doneByUom = new Map<string, { uom: string; workOrders: number; good: number }>();
      for (const w of completed) {
        const g = doneByUom.get(w.uom) ?? { uom: w.uom, workOrders: 0, good: 0 };
        g.workOrders += 1;
        g.good += Number(w.processes[0]?.goodQty ?? 0);
        doneByUom.set(w.uom, g);
      }
      const rank = { overdue: 0, today: 1, week: 2, later: 3, none: 4 } as const;
      const schedule = [...rows]
        .sort((a, b) => rank[a.due as keyof typeof rank] - rank[b.due as keyof typeof rank] || (a._req?.getTime() ?? Infinity) - (b._req?.getTime() ?? Infinity) || a.woNo.localeCompare(b.woNo))
        .slice(0, 15)
        .map(({ _req, ...x }) => x);
      kpis.releasedWorkOrders = byStatus.RELEASED ?? 0;
      kpis.inProgress = (byStatus.IN_PROGRESS ?? 0) + (byStatus.PARTIALLY_COMPLETED ?? 0);
      kpis.completed = completed.length;
      kpis.overdue = rows.filter((x) => x.due === "overdue").length;
      out.jobs = {
        byStatus,
        overdue: kpis.overdue,
        dueToday: rows.filter((x) => x.due === "today").length,
        dueWeek: rows.filter((x) => x.due === "week").length,
        unscheduled: rows.filter((x) => !x.scheduled && x.status !== "ON_HOLD").length,
        progress: [...progress.values()],
        completedInPeriod: [...doneByUom.values()],
        schedule,
      };
      for (const x of rows) {
        const path = `/planning/job-order/${x.id}`;
        if (x.due === "overdue")
          alerts.push({ key: `wo-overdue-${x.id}`, severity: "high", type: "Overdue Job Order", record: x.woNo, reason: `Required ${x.requiredDate} (${x.pjoNo}); ${x.remaining} ${x.uom} still to produce.`, at: null, role: "Production Planner", action: "Expedite or agree a new date", path });
        else if (x.status === "RELEASED" && x._req && x._req <= soonCol)
          alerts.push({ key: `wo-notstarted-${x.id}`, severity: "medium", type: "Not started, due soon", record: x.woNo, reason: `Required ${x.requiredDate}; no Check In yet.`, at: null, role: "Production Supervisor", action: "Check In on a machine", path });
        if (x.allStepsDone && x.status !== "ON_HOLD")
          alerts.push({ key: `wo-confirm-${x.id}`, severity: "low", type: "Awaiting completion", record: x.woNo, reason: "Every route step is completed; the Job Order is not confirmed complete.", at: null, role: "Production Planner", action: "Confirm completion", path });
      }

      // WIP from the route steps of released / running Work Orders.
      const stepIds = open.flatMap((w) => w.processes.map((p) => p.id));
      const [lastMoves, running] = await Promise.all([
        stepIds.length ? db.productionOutput.groupBy({ by: ["woProcessId"], where: { woProcessId: { in: stepIds } }, _max: { recordedAt: true } }) : Promise.resolve([]),
        db.productionSession.findMany({ where: { status: "RUNNING" }, select: { woProcessId: true, machine: { select: { code: true } }, checkInAt: true } }),
      ]);
      const lastMove = new Map(lastMoves.map((m) => [m.woProcessId, m._max.recordedAt]));
      const runningBy = new Map(running.map((s) => [s.woProcessId, s]));
      const machineIds = [...new Set(open.flatMap((w) => w.processes.map((p) => p.assignedMachineId).filter((x): x is string => !!x)))];
      const machines = new Map((machineIds.length ? await db.machine.findMany({ where: { id: { in: machineIds } }, select: { id: true, code: true } }) : []).map((m) => [m.id, m.code]));
      const wip: { kind: "running" | "waiting" | "paused"; woId: string; woNo: string; fatherCode: string; process: string; previous: string | null; machine: string | null; qty: string; uom: string; lastMovement: Date | null }[] = [];
      for (const w of open) {
        if (w.status === "PLANNED") continue;
        for (const p of w.processes) {
          if (p.status === "COMPLETED" || (f.processId && p.processId !== f.processId)) continue;
          const qty = processQuantities(w, w.processes, p);
          const prev = qty.previous;
          const base = { woId: w.id, woNo: w.woNo, fatherCode: w.pjo.bom.fatherCode, process: `${p.seq}. ${p.process.name}`, previous: prev ? w.processes.find((x) => x.id === prev.id)?.process.name ?? null : null, uom: w.uom };
          const rs = runningBy.get(p.id);
          if (rs) wip.push({ ...base, kind: "running", machine: rs.machine.code, qty: q(qty.available), lastMovement: lastMove.get(p.id) ?? rs.checkInAt });
          else if (p.status === "PAUSED") wip.push({ ...base, kind: "paused", machine: p.assignedMachineId ? (machines.get(p.assignedMachineId) ?? null) : null, qty: q(qty.outstanding), lastMovement: lastMove.get(p.id) ?? null });
          // Waiting = the step could start now: previous step completed, or partial transfer approved (same rule as Check In).
          else if (prev && qty.available.greaterThan(0) && (prev.status === "COMPLETED" || p.allowPartialTransfer)) wip.push({ ...base, kind: "waiting", machine: p.assignedMachineId ? (machines.get(p.assignedMachineId) ?? null) : null, qty: q(qty.available), lastMovement: lastMove.get(prev.id) ?? prev.completedAt ?? null });
        }
      }
      const order = { running: 0, waiting: 1, paused: 2 };
      wip.sort((a, b) => order[a.kind] - order[b.kind] || (a.lastMovement?.getTime() ?? 0) - (b.lastMovement?.getTime() ?? 0));
      kpis.activeWip = wip.length;
      out.wip = {
        running: wip.filter((x) => x.kind === "running").length,
        waiting: wip.filter((x) => x.kind === "waiting").length,
        paused: wip.filter((x) => x.kind === "paused").length,
        rows: wip.slice(0, 12),
      };
    }

    // ----- Shopfloor: machines, output, sessions --------------------------------
    if (seeFloor) {
      const categoryFilter: Prisma.MachineWhereInput = f.processId ? { category: { processes: { some: { processId: f.processId } } } } : {};
      const [machines, breakdowns, sessions, outputs, changes] = await Promise.all([
        db.machine.findMany({ where: { isActive: true, ...categoryFilter }, orderBy: { code: "asc" }, select: { id: true, code: true, name: true, status: true, statusChangedAt: true, category: { select: { code: true } } } }),
        db.machineBreakdown.findMany({ where: { status: { in: ["OPEN", "UNDER_MAINTENANCE"] } }, orderBy: { reportedAt: "asc" }, select: { id: true, breakdownNo: true, machineId: true, reason: true, status: true, reportedAt: true, machine: { select: { code: true } } } }),
        db.productionSession.findMany({
          where: { status: "RUNNING" },
          select: { id: true, sessionNo: true, machineId: true, operatorId: true, checkInAt: true, goodQty: true, workOrder: { select: { id: true, woNo: true, uom: true } }, woProcess: { select: { seq: true, process: { select: { name: true } } } } },
        }),
        db.productionOutput.findMany({
          where: { recordedAt: { gte: dayRange(addDays(todayKey, -(Math.max(days, 7) - 1))).start }, ...(f.processId ? { session: { woProcess: { processId: f.processId } } } : {}) },
          select: { machineId: true, recordedAt: true, goodQty: true, rejectQty: true },
        }),
        db.machineChange.findMany({ where: { status: "PENDING" }, select: { id: true, requestedAt: true, reason: true, workOrderId: true, toMachineId: true } }),
      ]);
      const names = await userNames(db, sessions.map((s) => s.operatorId));
      const lastOut = new Map<string, { at: Date; good: number }>();
      for (const o of outputs) {
        const cur = lastOut.get(o.machineId);
        if (!cur || o.recordedAt > cur.at) lastOut.set(o.machineId, { at: o.recordedAt, good: Number(o.goodQty) });
      }
      const chartDays = Math.max(days, 7);
      const chart = Array.from({ length: chartDays }, (_, i) => ({ date: addDays(todayKey, i - chartDays + 1), good: 0, reject: 0 }));
      for (const o of outputs) {
        const day = chart.find((c) => c.date === dayKey(o.recordedAt));
        if (!day) continue;
        day.good += Number(o.goodQty);
        day.reject += Number(o.rejectQty);
      }
      const counts: Record<string, number> = {};
      const machineRows = machines.map((m) => {
        counts[m.status] = (counts[m.status] ?? 0) + 1;
        const s = sessions.find((x) => x.machineId === m.id);
        const b = breakdowns.find((x) => x.machineId === m.id);
        const lo = lastOut.get(m.id);
        return {
          id: m.id, code: m.code, name: m.name, category: m.category.code, status: m.status, statusSince: m.statusChangedAt,
          session: s ? { sessionNo: s.sessionNo, woId: s.workOrder.id, woNo: s.workOrder.woNo, process: `${s.woProcess.seq}. ${s.woProcess.process.name}`, operator: names.get(s.operatorId) ?? null, since: s.checkInAt, good: q(s.goodQty), uom: s.workOrder.uom } : null,
          breakdown: b ? { breakdownNo: b.breakdownNo, reason: humanize(b.reason), status: b.status, since: b.reportedAt } : null,
          lastOutput: lo ? { at: lo.at, good: lo.good } : null,
        };
      });
      const rank: Record<string, number> = { BREAKDOWN: 0, MAINTENANCE: 1, RUNNING: 2, IDLE: 3, AVAILABLE: 4, OFFLINE: 5 };
      machineRows.sort((a, b) => (rank[a.status] ?? 9) - (rank[b.status] ?? 9) || a.code.localeCompare(b.code));
      out.floor = { counts, machines: machineRows, output: chart, runningSessions: sessions.length };
      for (const b of breakdowns)
        alerts.push({ key: `bd-${b.id}`, severity: "critical", type: "Machine breakdown", record: b.machine.code, reason: `${b.breakdownNo} · ${humanize(b.reason)} · ${b.status === "OPEN" ? "waiting for maintenance" : "under maintenance"}.`, at: b.reportedAt, role: "Maintenance", action: "Repair, then release the machine", path: "/shopfloor/machine-output-control?tab=breakdowns" });
      for (const c of changes)
        alerts.push({ key: `mc-${c.id}`, severity: "medium", type: "Machine change waiting", record: "Machine change", reason: c.reason, at: c.requestedAt, role: "Production Supervisor", action: "Approve or reject the change", path: "/shopfloor/machine-output-control?tab=changes" });
      const startOfToday = dayRange(todayKey).start;
      for (const s of sessions.filter((x) => x.checkInAt < startOfToday))
        alerts.push({ key: `ses-${s.id}`, severity: "medium", type: "Session open since a previous day", record: s.workOrder.woNo, reason: `${s.sessionNo} checked in ${dayKey(s.checkInAt)} by ${names.get(s.operatorId) ?? "an operator"}; not checked out.`, at: s.checkInAt, role: "Production Supervisor", action: "Check Out the session", path: "/shopfloor/wip-check-in-out?status=RUNNING" });
    }

    // ----- Operator: my running sessions ----------------------------------------
    if (can("shopfloor.output.record")) {
      const mine = await db.productionSession.findMany({
        where: { operatorId: user.id, status: "RUNNING" },
        select: { sessionNo: true, checkInAt: true, goodQty: true, machine: { select: { id: true, code: true } }, workOrder: { select: { id: true, woNo: true, uom: true } }, woProcess: { select: { process: { select: { name: true } } } } },
      });
      out.mine = mine.map((s) => ({ sessionNo: s.sessionNo, since: s.checkInAt, good: q(s.goodQty), machineId: s.machine.id, machine: s.machine.code, woId: s.workOrder.id, woNo: s.workOrder.woNo, uom: s.workOrder.uom, process: s.woProcess.process.name }));
    }

    // ----- Material -----------------------------------------------------------------
    if (seeMrs) {
      // Waiting = not fully issued for a Job Order that can still use it (same as the MRS list "activeJob=1").
      const live: Prisma.MaterialRequisitionWhereInput = { status: { in: ["OPEN", "PARTIALLY_ISSUED"] }, workOrder: { status: { in: [...OPEN_WO] } } };
      const [groups, waiting, txns, stranded] = await Promise.all([
        db.materialRequisition.groupBy({ by: ["status"], where: live, _count: { _all: true } }),
        db.materialRequisition.findMany({
          where: live,
          orderBy: { createdAt: "asc" },
          take: 30,
          select: { id: true, mrsNo: true, status: true, createdAt: true, workOrder: { select: { id: true, woNo: true, status: true } }, lines: { select: { requestedQty: true, issuedQty: true } } },
        }),
        db.materialTransaction.groupBy({ by: ["type"], where: { createdAt: { gte: from, lte: now } }, _count: { _all: true } }),
        // Cancelled Job Orders whose requisition still has material out (kept open for returns).
        db.materialRequisition.findMany({
          where: { status: { in: ["OPEN", "PARTIALLY_ISSUED", "ISSUED"] }, workOrder: { status: "CANCELLED" } },
          select: { id: true, mrsNo: true, updatedAt: true, workOrder: { select: { woNo: true } }, lines: { select: { requestedQty: true, issuedQty: true, additionalQty: true, returnedQty: true, rejectedQty: true, scrappedQty: true } } },
        }),
      ]);
      const byStatus = Object.fromEntries(groups.map((g) => [g.status, g._count._all]));
      kpis.pendingMrs = (byStatus.OPEN ?? 0) + (byStatus.PARTIALLY_ISSUED ?? 0);
      const rows = waiting.map((m) => ({
        id: m.id, mrsNo: m.mrsNo, status: m.status, createdAt: m.createdAt, woId: m.workOrder.id, woNo: m.workOrder.woNo, woStatus: m.workOrder.status,
        lines: m.lines.length, linesOpen: m.lines.filter((l) => D(l.issuedQty).lessThan(D(l.requestedQty))).length,
      }));
      out.material = {
        open: byStatus.OPEN ?? 0,
        partiallyIssued: byStatus.PARTIALLY_ISSUED ?? 0,
        productionStartedWaiting: rows.filter((x) => x.woStatus === "IN_PROGRESS" || x.woStatus === "PARTIALLY_COMPLETED").length,
        movements: Object.fromEntries(txns.map((t) => [t.type, t._count._all])),
        waiting: rows.slice(0, 8),
        external: "Stock availability comes from WMS (not connected): Location Qty in Part Master is recorded manually.",
      };
      for (const m of stranded) {
        const out = m.lines.reduce((acc, l) => acc.plus(lineBalances(l).onHand), ZERO);
        if (out.greaterThan(0))
          alerts.push({ key: `mrs-cancelled-${m.id}`, severity: "medium", type: "Material out on a cancelled job", record: m.mrsNo, reason: `${m.workOrder.woNo} was cancelled; ${q(out)} of material issued on this MRS is not returned, rejected or scrapped.`, at: m.updatedAt, role: "Material Controller", action: "Return the unused material", path: `/planning/material-requisition-sheet/${m.id}` });
      }
      for (const m of rows.filter((x) => x.woStatus === "IN_PROGRESS" || x.woStatus === "PARTIALLY_COMPLETED"))
        alerts.push({ key: `mrs-${m.id}`, severity: "high", type: "Running without full material", record: m.mrsNo, reason: `${m.woNo} is in production; ${m.linesOpen} of ${m.lines} MRS line${m.lines === 1 ? "" : "s"} not fully issued.`, at: m.createdAt, role: "Material Controller", action: "Issue the remaining lines", path: `/planning/material-requisition-sheet/${m.id}` });
    }

    // ----- Quality -----------------------------------------------------------------
    if (qcTypes.length) {
      const types = [...qcTypes];
      const [openGroups, results, dispositions, pending] = await Promise.all([
        db.qcInspection.groupBy({ by: ["type", "status"], where: { type: { in: types }, status: { in: ["IN_INSPECTION", "PENDING_DISPOSITION", "REWORK"] } }, _count: { _all: true } }),
        db.qcInspection.groupBy({ by: ["type", "result"], where: { type: { in: types }, checkedOutAt: { gte: from, lte: now }, result: { not: null } }, _count: { _all: true } }),
        db.qcInspection.groupBy({ by: ["type", "status"], where: { type: { in: types }, dispositionAt: { gte: from, lte: now }, status: { in: ["REJECTED", "RETURNED", "ACCEPTED", "REWORK"] } }, _count: { _all: true } }),
        db.qcInspection.findMany({
          where: { type: { in: types }, status: "PENDING_DISPOSITION" },
          orderBy: { checkedOutAt: "asc" },
          select: { id: true, inspNo: true, type: true, lotRef: true, checkedOutAt: true, material: { select: { code: true } }, workOrder: { select: { woNo: true } } },
        }),
      ]);
      const n = (rows: { type: string; status?: string | null; result?: string | null; _count: { _all: number } }[], type: string, key: "status" | "result", v: string) => rows.find((g) => g.type === type && g[key] === v)?._count._all ?? 0;
      const lots = types.map((t) => ({
        type: t,
        inInspection: n(openGroups, t, "status", "IN_INSPECTION"),
        onHold: n(openGroups, t, "status", "PENDING_DISPOSITION"),
        inRework: n(openGroups, t, "status", "REWORK"),
        passed: n(results, t, "result", "PASS"),
        failed: n(results, t, "result", "FAIL"),
        rejected: n(dispositions, t, "status", "REJECTED") + n(dispositions, t, "status", "RETURNED"),
        concession: n(dispositions, t, "status", "ACCEPTED"),
      }));
      kpis.pendingQc = lots.reduce((a, l) => a + l.inInspection + l.onHold, 0);
      out.quality = { lots };
      for (const p of pending)
        alerts.push({ key: `qc-${p.id}`, severity: "high", type: `${p.type} failed – on hold`, record: p.inspNo, reason: p.type === "IQC" ? `${p.material?.code ?? ""} lot ${p.lotRef ?? ""} failed inspection.` : `${p.workOrder?.woNo ?? ""} failed outgoing inspection.`, at: p.checkedOutAt, role: "QC Supervisor", action: "Decide the disposition", path: `/qc/${p.type.toLowerCase()}-check-in-out/${p.id}` });
    }

    // ----- Recent manufacturing activity (genuine transactions only) ----------------
    const take = 8;
    const jobs: Promise<void>[] = [];
    if (seeOrders)
      jobs.push(
        db.productionJobOrder.findMany({ where: { releasedAt: { not: null } }, orderBy: { releasedAt: "desc" }, take, select: { id: true, pjoNo: true, releasedAt: true, releasedById: true } })
          .then((rows) => void activity.push(...rows.map((p) => ({ at: p.releasedAt!, kind: "order", text: "Production Job Order released", record: p.pjoNo, path: `/planning/production-job-order/${p.id}`, userId: p.releasedById })))),
      );
    if (seeJobs) {
      jobs.push(
        db.workOrder.findMany({ where: { releasedAt: { not: null } }, orderBy: { releasedAt: "desc" }, take, select: { id: true, woNo: true, releasedAt: true, releasedById: true } })
          .then((rows) => void activity.push(...rows.map((w) => ({ at: w.releasedAt!, kind: "order", text: "Job Order released", record: w.woNo, path: `/planning/job-order/${w.id}`, userId: w.releasedById })))),
        db.workOrder.findMany({ where: { completedAt: { not: null } }, orderBy: { completedAt: "desc" }, take, select: { id: true, woNo: true, completedAt: true, completedById: true } })
          .then((rows) => void activity.push(...rows.map((w) => ({ at: w.completedAt!, kind: "done", text: "Job Order completed", record: w.woNo, path: `/planning/job-order/${w.id}`, userId: w.completedById })))),
        db.productionSession.findMany({ orderBy: { checkInAt: "desc" }, take, select: { checkInAt: true, operatorId: true, workOrder: { select: { id: true, woNo: true } }, machine: { select: { code: true } }, woProcess: { select: { process: { select: { name: true } } } } } })
          .then((rows) => void activity.push(...rows.map((s) => ({ at: s.checkInAt, kind: "start", text: `Check In · ${s.woProcess.process.name} on ${s.machine.code}`, record: s.workOrder.woNo, path: `/planning/job-order/${s.workOrder.id}`, userId: s.operatorId })))),
        db.productionSession.findMany({ where: { checkOutAt: { not: null } }, orderBy: { checkOutAt: "desc" }, take, select: { checkOutAt: true, checkOutType: true, checkOutById: true, operatorId: true, goodQty: true, rejectQty: true, workOrder: { select: { id: true, woNo: true, uom: true } }, machine: { select: { code: true } } } })
          .then((rows) => void activity.push(...rows.map((s) => ({ at: s.checkOutAt!, kind: "end", text: `Check Out (${humanize(s.checkOutType ?? "PARTIAL")}) on ${s.machine.code} · good ${q(s.goodQty)}, reject ${q(s.rejectQty)} ${s.workOrder.uom}`, record: s.workOrder.woNo, path: `/planning/job-order/${s.workOrder.id}`, userId: s.checkOutById ?? s.operatorId })))),
      );
    }
    if (seeMrs)
      jobs.push(
        db.materialTransaction.findMany({ orderBy: { createdAt: "desc" }, take, select: { mrsId: true, type: true, qty: true, uom: true, createdAt: true, createdById: true, material: { select: { code: true } }, mrs: { select: { mrsNo: true } } } })
          .then((rows) => void activity.push(...rows.map((m) => ({ at: m.createdAt, kind: "material", text: `${humanize(m.type)} · ${m.material.code} ${q(m.qty)} ${m.uom}`, record: m.mrs.mrsNo, path: `/planning/material-requisition-sheet/${m.mrsId}`, userId: m.createdById })))),
      );
    if (qcTypes.length)
      jobs.push(
        db.qcInspection.findMany({ where: { type: { in: [...qcTypes] }, checkedOutAt: { not: null } }, orderBy: { checkedOutAt: "desc" }, take, select: { id: true, inspNo: true, type: true, result: true, checkedOutAt: true, checkedOutById: true } })
          .then((rows) => void activity.push(...rows.map((i) => ({ at: i.checkedOutAt!, kind: i.result === "FAIL" ? "fail" : "qc", text: `${i.type} inspection ${i.result === "FAIL" ? "failed" : "passed"}`, record: i.inspNo, path: `/qc/${i.type.toLowerCase()}-check-in-out/${i.id}`, userId: i.checkedOutById })))),
      );
    if (seeFloor)
      jobs.push(
        db.machineBreakdown.findMany({ orderBy: { reportedAt: "desc" }, take, select: { reportedAt: true, reportedById: true, breakdownNo: true, reason: true, machine: { select: { code: true } } } })
          .then((rows) => void activity.push(...rows.map((b) => ({ at: b.reportedAt, kind: "fail", text: `Breakdown reported · ${b.machine.code} (${humanize(b.reason)})`, record: b.breakdownNo, path: "/shopfloor/machine-output-control?tab=breakdowns", userId: b.reportedById })))),
      );
    await Promise.all(jobs);
    activity.sort((a, b) => b.at.getTime() - a.at.getTime());
    const recent = activity.slice(0, 15);
    const who = await userNames(db, recent.map((a) => a.userId));
    out.activity = recent.map(({ userId, ...a }) => ({ ...a, by: userId ? (who.get(userId) ?? null) : null }));

    const sev = { critical: 0, high: 1, medium: 2, low: 3 };
    alerts.sort((a, b) => sev[a.severity] - sev[b.severity] || (a.at?.getTime() ?? 0) - (b.at?.getTime() ?? 0));
    out.alerts = alerts;
    out.kpis = kpis;
    res.json(ok(out));
  });

  /** Quick find across the records the user may see: PJO, Job Order, Father Code, product, part, MRS, inspection. */
  r.get("/find", requireAuth, async (req, res) => {
    const user = requireUser(req);
    const can = (k: string) => hasPermission(user, k);
    const { q: term } = query(req, z.object({ q: z.string().trim().min(2).max(60) }));
    const take = 5;
    const hits: { type: string; label: string; detail: string; path: string }[] = [];
    const jobs: Promise<void>[] = [];
    if (can("planning.pjo.view"))
      jobs.push(
        db.productionJobOrder
          .findMany({ where: { OR: [{ pjoNo: { contains: term } }, { customerRef: { contains: term } }] }, take, orderBy: { pjoNo: "desc" }, include: { bom: { select: { fatherCode: true } } } })
          .then((rows) => void hits.push(...rows.map((p) => ({ type: "Production Job Order", label: p.pjoNo, detail: `${p.bom.fatherCode}${p.customerRef ? ` · ${p.customerRef}` : ""} · ${p.status.toLowerCase()}`, path: `/planning/production-job-order/${p.id}` })))),
      );
    if (can("planning.jo.view"))
      jobs.push(
        db.workOrder
          .findMany({ where: { woNo: { contains: term } }, take, orderBy: { woNo: "desc" }, include: { pjo: { select: { pjoNo: true } } } })
          .then((rows) => void hits.push(...rows.map((w) => ({ type: "Job Order", label: w.woNo, detail: `${w.pjo.pjoNo} · ${humanize(w.status).toLowerCase()}`, path: `/planning/job-order/${w.id}` })))),
      );
    if (can("bom.view")) {
      jobs.push(
        db.bom
          .findMany({ where: { OR: [{ fatherCode: { contains: term } }, { labelDescription: { contains: term } }] }, take, orderBy: { fatherCode: "asc" } })
          .then((rows) => void hits.push(...rows.map((b) => ({ type: "Father Code", label: b.fatherCode, detail: b.labelDescription, path: `/bom/${b.id}` })))),
        db.product
          .findMany({ where: { OR: [{ productCode: { contains: term } }, { name: { contains: term } }] }, take, orderBy: { productCode: "asc" } })
          .then((rows) => void hits.push(...rows.map((p) => ({ type: "Master Card", label: p.productCode, detail: p.name, path: `/bom/master-card/${p.id}` })))),
        db.material
          .findMany({ where: { partType: { not: "FINISHED_GOOD" }, OR: [{ code: { contains: term } }, { description: { contains: term } }] }, take, orderBy: { code: "asc" } })
          .then((rows) => void hits.push(...rows.map((m) => ({ type: "Part", label: m.code, detail: m.description, path: `/master-data/part-master/${m.id}` })))),
      );
    }
    if (can("planning.mrs.view"))
      jobs.push(
        db.materialRequisition
          .findMany({ where: { mrsNo: { contains: term } }, take, orderBy: { mrsNo: "desc" }, include: { workOrder: { select: { woNo: true } } } })
          .then((rows) => void hits.push(...rows.map((m) => ({ type: "MRS", label: m.mrsNo, detail: `${m.workOrder.woNo} · ${humanize(m.status).toLowerCase()}`, path: `/planning/material-requisition-sheet/${m.id}` })))),
      );
    const types = (["IQC", "OQC"] as const).filter((t) => can(`qc.${t.toLowerCase()}.view`));
    if (types.length)
      jobs.push(
        db.qcInspection
          .findMany({ where: { type: { in: [...types] }, OR: [{ inspNo: { contains: term } }, { lotRef: { contains: term } }] }, take, orderBy: { inspNo: "desc" } })
          .then((rows) => void hits.push(...rows.map((i) => ({ type: `${i.type} inspection`, label: i.inspNo, detail: `${i.lotRef ? `lot ${i.lotRef} · ` : ""}${humanize(i.status).toLowerCase()}`, path: `/qc/${i.type.toLowerCase()}-check-in-out/${i.id}` })))),
      );
    await Promise.all(jobs);
    const up = term.toUpperCase();
    hits.sort((a, b) => Number(!a.label.toUpperCase().startsWith(up)) - Number(!b.label.toUpperCase().startsWith(up)));
    res.json(ok(hits.slice(0, 20)));
  });

  return r;
}

async function userNames(db: Deps["db"], ids: (string | null | undefined)[]) {
  const unique = [...new Set(ids.filter((x): x is string => !!x))];
  const rows = unique.length ? await db.user.findMany({ where: { id: { in: unique } }, select: { id: true, fullName: true } }) : [];
  return new Map(rows.map((u) => [u.id, u.fullName]));
}
