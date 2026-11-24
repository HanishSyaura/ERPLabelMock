import { Router, type Request } from "express";
import { z } from "zod";
import type { Prisma } from "../../generated/prisma/client";
import type { Deps } from "../../deps";
import { errors } from "../../lib/errors";
import { body, idParam, ok, pageMeta, params, query } from "../../lib/http";
import { D, isQtyInput, q } from "../../lib/qty";
import { requireAnyPermission, requirePermission } from "../../middleware/auth";
import { requireUser } from "../../middleware/context";
import { workOrderView } from "../planning/orders.routes";
import * as svc from "./session.service";
import { processQuantities, WORKABLE_WO } from "./state";

const txnId = z.string().trim().min(8, "Missing transaction id").max(64);
const qtyIn = z.union([z.number(), z.string()]).refine((v) => isQtyInput(v), "Enter 0 or a positive quantity (max 4 decimals)");
const text = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .optional()
    .nullable()
    .transform((v) => (v ? v : null));
const range = z.object({ from: z.coerce.date().optional(), to: z.coerce.date().optional() });

export function shopfloorRoutes(deps: Deps) {
  const r = Router();
  const { db } = deps;
  const actor = (req: Request): svc.Actor => ({ user: requireUser(req), ctx: req.ctx });
  const HANDHELD = requirePermission("shopfloor.handheld");
  const RECORD = requirePermission("shopfloor.output.record");
  const MONITOR = requireAnyPermission("shopfloor.output.view", "shopfloor.wip.view");

  const userNames = async (ids: (string | null | undefined)[]) => {
    const unique = [...new Set(ids.filter((x): x is string => !!x))];
    const users = await db.user.findMany({ where: { id: { in: unique } }, select: { id: true, fullName: true } });
    return new Map(users.map((u) => [u.id, u.fullName]));
  };

  r.get("/reference", requireAnyPermission("shopfloor.handheld", "shopfloor.output.view"), (_req, res) => {
    res.json(ok({ breakdownReasons: svc.BREAKDOWN_REASONS }));
  });

  // ----- Handheld: device + machine ------------------------------------------
  /** The calling device (X-Device-Id), registered on first contact, with its pinned machine. */
  r.get("/device", HANDHELD, async (req, res) => {
    const user = requireUser(req);
    const deviceId = req.ctx.deviceId;
    if (!deviceId || deviceId.length < 8) throw errors.badRequest("This handheld has no device id. Reload the handheld app.");
    const device = await db.handheldDevice.upsert({
      where: { id: deviceId },
      create: { id: deviceId, lastUserId: user.id, lastSeenAt: deps.now() },
      update: { lastUserId: user.id, lastSeenAt: deps.now() },
      include: { assignedMachine: { select: { id: true, code: true, name: true } } },
    });
    res.json(ok({ id: device.id, name: device.name, assignedMachine: device.assignedMachine, canReassign: user.permissions.has("shopfloor.device.manage") }));
  });

  /** Scan a machine barcode: profile + whether this operator can start work on it. */
  r.get("/machines/by-code/:code", HANDHELD, async (req, res) => {
    const user = requireUser(req);
    const { code } = params(req, z.object({ code: z.string().trim().min(1).max(30) }));
    const machine = await db.machine.findUnique({
      where: { code: code.toUpperCase() },
      include: { category: { include: { processes: { include: { process: { select: { code: true, name: true } } } } } } },
    });
    if (!machine) throw errors.notFound(`Machine "${code}"`);
    const blockers = await svc.machineBlockers(db, machine, user);
    res.json(
      ok({
        id: machine.id,
        code: machine.code,
        name: machine.name,
        status: machine.status,
        isActive: machine.isActive,
        category: { id: machine.category.id, code: machine.category.code, name: machine.category.name },
        processes: machine.category.processes.map((p) => p.process),
        blockers,
      }),
    );
  });

  /** Machine dashboard: only this machine's own session and output. */
  r.get("/machines/:id/dashboard", requireAnyPermission("shopfloor.handheld", "shopfloor.output.view"), async (req, res) => {
    const user = requireUser(req);
    const { id } = params(req, idParam);
    const machine = await db.machine.findUnique({ where: { id }, include: { category: { select: { id: true, code: true, name: true } } } });
    if (!machine) throw errors.notFound("Machine");
    const now = deps.now();
    const dayStart = new Date(now);
    dayStart.setHours(0, 0, 0, 0);
    const [session, todayOut, paused, openBreakdown, blockers] = await Promise.all([
      db.productionSession.findFirst({ where: { machineId: id, status: "RUNNING" } }),
      db.productionOutput.aggregate({ where: { machineId: id, recordedAt: { gte: dayStart } }, _sum: { goodQty: true, rejectQty: true } }),
      db.workOrderProcess.findMany({
        where: { assignedMachineId: id, status: "PAUSED", workOrder: { status: { in: ["RELEASED", "IN_PROGRESS", "PARTIALLY_COMPLETED", "ON_HOLD"] } } },
        include: { workOrder: { select: { id: true, woNo: true, status: true, quantity: true } }, process: { select: { name: true } } },
      }),
      db.machineBreakdown.findFirst({ where: { machineId: id, status: { not: "RESOLVED" } }, orderBy: { reportedAt: "desc" } }),
      svc.machineBlockers(db, machine, user),
    ]);
    let current = null;
    if (session) {
      const wo = await workOrderView(db, session.workOrderId);
      const step = wo.processes.find((p) => p.id === session.woProcessId)!;
      const names = await userNames([session.operatorId]);
      current = {
        sessionId: session.id,
        sessionNo: session.sessionNo,
        operator: names.get(session.operatorId) ?? null,
        operatorId: session.operatorId,
        isMine: session.operatorId === user.id,
        checkInAt: session.checkInAt,
        machineGood: q(session.goodQty),
        machineReject: q(session.rejectQty),
        availableAtStart: q(session.availableAtStart),
        workOrder: { id: wo.id, woNo: wo.woNo, status: wo.status, quantity: wo.quantity, uom: wo.uom, pjo: wo.pjo },
        process: { id: step.id, name: step.process.name, seq: step.seq, routeLength: wo.processes.length, quantities: step.quantities, allowSplit: step.allowSplit },
      };
    }
    res.json(
      ok({
        machine: { id: machine.id, code: machine.code, name: machine.name, status: machine.status, statusChangedAt: machine.statusChangedAt, isActive: machine.isActive, category: machine.category },
        blockers,
        current,
        today: { good: q(todayOut._sum.goodQty), reject: q(todayOut._sum.rejectQty) },
        pausedWork: paused.map((p) => ({ woProcessId: p.id, workOrderId: p.workOrder.id, woNo: p.workOrder.woNo, woStatus: p.workOrder.status, process: p.process.name, good: q(p.goodQty) })),
        openBreakdown: openBreakdown ? { id: openBreakdown.id, breakdownNo: openBreakdown.breakdownNo, reason: openBreakdown.reason, status: openBreakdown.status, reportedAt: openBreakdown.reportedAt } : null,
      }),
    );
  });

  /** Work Orders that can start on this machine now (for "select from list"). */
  r.get("/machines/:id/eligible-work-orders", HANDHELD, async (req, res) => {
    const user = requireUser(req);
    const { id } = params(req, idParam);
    const machine = await db.machine.findUnique({ where: { id } });
    if (!machine) throw errors.notFound("Machine");
    const supported = (await db.machineCategoryProcess.findMany({ where: { categoryId: machine.categoryId } })).map((c) => c.processId);
    const candidates = await db.workOrder.findMany({
      where: { status: { in: ["RELEASED", "IN_PROGRESS", "PARTIALLY_COMPLETED"] }, processes: { some: { status: { not: "COMPLETED" }, processId: { in: supported } } } },
      orderBy: [{ priority: "desc" }, { plannedDate: "asc" }, { woNo: "asc" }],
      take: 60,
      include: { pjo: { select: { pjoNo: true, bom: { select: { fatherCode: true } }, artworkRevision: { select: { labelDescription: true, revisionNo: true } } } } },
    });
    const out = [];
    for (const wo of candidates) {
      const e = await svc.workOrderEligibility(db, wo, machine, user);
      if (!e.step) continue;
      const qty = processQuantities(wo, await db.workOrderProcess.findMany({ where: { workOrderId: wo.id } }), e.step);
      out.push({
        id: wo.id,
        woNo: wo.woNo,
        status: wo.status,
        priority: wo.priority,
        plannedDate: wo.plannedDate,
        pjoNo: wo.pjo.pjoNo,
        fatherCode: wo.pjo.bom.fatherCode,
        labelDescription: wo.pjo.artworkRevision.labelDescription,
        process: e.processName,
        available: q(qty.available),
        outstanding: q(qty.outstanding),
        uom: wo.uom,
      });
      if (out.length >= 30) break;
    }
    res.json(ok(out));
  });

  /** Scan a Work Order barcode: full info + whether it can start on the given machine. */
  r.get("/work-orders/by-number/:woNo", HANDHELD, async (req, res) => {
    const user = requireUser(req);
    const { woNo } = params(req, z.object({ woNo: z.string().trim().min(1).max(30) }));
    const { machineId } = query(req, z.object({ machineId: z.uuid().optional() }));
    const wo = await db.workOrder.findUnique({ where: { woNo: woNo.toUpperCase() } });
    if (!wo) throw errors.notFound(`Job Order "${woNo}"`);
    const view = await workOrderView(db, wo.id);
    let eligibility = null;
    if (machineId) {
      const machine = await db.machine.findUnique({ where: { id: machineId } });
      if (!machine) throw errors.notFound("Machine");
      const e = await svc.workOrderEligibility(db, wo, machine, user);
      eligibility = { canStart: !!e.step, woProcessId: e.step?.id ?? null, process: e.processName, blockers: e.blockers };
    }
    res.json(ok({ ...view, eligibility }));
  });

  // ----- Handheld: transactions (idempotent) ------------------------------------
  r.post("/check-in", RECORD, async (req, res) => {
    const input = body(req, z.object({ machineId: z.uuid(), workOrderId: z.uuid(), clientTxnId: txnId }));
    const result = await svc.idempotent(db, actor(req), input.clientTxnId, "CHECK_IN", (tx) => svc.checkIn(tx, actor(req), input, deps.now()));
    res.status(result.replayed ? 200 : 201).json(ok(result));
  });

  r.post("/sessions/:id/outputs", RECORD, async (req, res) => {
    const { id } = params(req, idParam);
    const input = body(req, z.object({ goodQty: qtyIn, rejectQty: qtyIn, rejectReason: text(255), clientTxnId: txnId }));
    const result = await svc.idempotent(db, actor(req), input.clientTxnId, "OUTPUT", (tx) => svc.recordOutput(tx, actor(req), id, input, deps.now()));
    res.status(result.replayed ? 200 : 201).json(ok(result));
  });

  r.post("/sessions/:id/check-out", RECORD, async (req, res) => {
    const { id } = params(req, idParam);
    const input = body(
      req,
      z.object({
        totalGood: qtyIn,
        totalReject: qtyIn,
        type: z.enum(["COMPLETED", "PARTIAL", "SHIFT_END", "MACHINE_CHANGE", "MACHINE_BREAKDOWN"]),
        remarks: text(500),
        rejectReason: text(255),
        toMachineId: z.uuid().optional().nullable(),
        changeReason: text(500),
        breakdownReason: z.enum(svc.BREAKDOWN_CODES).optional().nullable(),
        clientTxnId: txnId,
      }),
    );
    const a = actor(req);
    if (input.type === "MACHINE_CHANGE" && !a.user.permissions.has("shopfloor.machine.change")) throw errors.forbidden("You don't have permission to request a machine change.");
    if (input.type === "MACHINE_BREAKDOWN" && !a.user.permissions.has("shopfloor.breakdown.report")) throw errors.forbidden("You don't have permission to report a breakdown.");
    const result = await svc.idempotent(db, a, input.clientTxnId, "CHECK_OUT", (tx) => svc.checkOut(tx, a, id, input, deps.now()));
    res.json(ok(result));
  });

  r.post("/machines/:id/breakdowns", requirePermission("shopfloor.breakdown.report"), async (req, res) => {
    const { id } = params(req, idParam);
    const input = body(req, z.object({ reason: z.enum(svc.BREAKDOWN_CODES, { message: "Choose the breakdown reason" }), remarks: text(500), totalGood: qtyIn.optional(), totalReject: qtyIn.optional(), clientTxnId: txnId }));
    const result = await svc.idempotent(db, actor(req), input.clientTxnId, "BREAKDOWN", (tx) => svc.reportBreakdown(tx, actor(req), id, input, deps.now()));
    res.status(result.replayed ? 200 : 201).json(ok(result));
  });

  // ----- Maintenance & machine status ------------------------------------------
  r.post("/breakdowns/:id/maintenance", requirePermission("shopfloor.breakdown.release"), async (req, res) => {
    const { id } = params(req, idParam);
    const { note } = body(req, z.object({ note: text(500) }));
    res.json(ok(await db.$transaction((tx) => svc.startMaintenance(tx, actor(req), id, note, deps.now()), svc.SHOPFLOOR_TX)));
  });
  r.post("/breakdowns/:id/release", requirePermission("shopfloor.breakdown.release"), async (req, res) => {
    const { id } = params(req, idParam);
    const input = body(req, z.object({ resolutionNote: z.string().trim().min(1, "Describe the repair / inspection").max(500), safetyConfirmed: z.boolean() }));
    res.json(ok(await db.$transaction((tx) => svc.releaseBreakdown(tx, actor(req), id, input, deps.now()), svc.SHOPFLOOR_TX)));
  });
  r.put("/machines/:id/status", requirePermission("shopfloor.breakdown.release"), async (req, res) => {
    const { id } = params(req, idParam);
    const input = body(req, z.object({ status: z.enum(["OFFLINE", "MAINTENANCE", "AVAILABLE"]), note: z.string().trim().min(1, "Give the reason").max(500), safetyConfirmed: z.boolean().optional() }));
    res.json(ok(await db.$transaction((tx) => svc.setManualStatus(tx, actor(req), id, input, deps.now()), svc.SHOPFLOOR_TX)));
  });

  // ----- Machine change ----------------------------------------------------------
  r.get("/work-order-processes/:id/alternative-machines", requireAnyPermission("shopfloor.machine.change", "shopfloor.machine.change.approve"), async (req, res) => {
    const { id } = params(req, idParam);
    res.json(ok(await svc.alternativeMachines(db, id)));
  });
  r.post("/machine-changes", requirePermission("shopfloor.machine.change"), async (req, res) => {
    const input = body(req, z.object({ woProcessId: z.uuid(), toMachineId: z.uuid({ message: "Choose the new machine" }), reason: z.string().trim().min(1, "Give the reason").max(500), clientTxnId: txnId }));
    const result = await svc.idempotent(db, actor(req), input.clientTxnId, "MACHINE_CHANGE", (tx) => svc.requestMachineChange(tx, actor(req), input, deps.now()));
    res.status(result.replayed ? 200 : 201).json(ok(result));
  });
  r.post("/machine-changes/:id/decision", requirePermission("shopfloor.machine.change.approve"), async (req, res) => {
    const { id } = params(req, idParam);
    const input = body(req, z.object({ approve: z.boolean(), note: text(500) }));
    res.json(ok(await db.$transaction((tx) => svc.decideMachineChange(tx, actor(req), id, input, deps.now()), svc.SHOPFLOOR_TX)));
  });

  // ----- Desktop monitoring -------------------------------------------------------
  /** All machines with live status and current session (machine board). */
  r.get("/machine-board", MONITOR, async (_req, res) => {
    const machines = await db.machine.findMany({ where: { isActive: true }, orderBy: { code: "asc" }, include: { category: { select: { code: true, name: true } } } });
    const sessions = await db.productionSession.findMany({
      where: { status: "RUNNING" },
      include: { workOrder: { select: { woNo: true, quantity: true, uom: true } }, woProcess: { include: { process: { select: { name: true } } } } },
    });
    const breakdowns = await db.machineBreakdown.findMany({ where: { status: { not: "RESOLVED" } } });
    const names = await userNames(sessions.map((s) => s.operatorId));
    res.json(
      ok(
        machines.map((m) => {
          const s = sessions.find((x) => x.machineId === m.id);
          const b = breakdowns.find((x) => x.machineId === m.id);
          return {
            id: m.id,
            code: m.code,
            name: m.name,
            category: m.category,
            status: m.status,
            statusChangedAt: m.statusChangedAt,
            openBreakdown: b ? { id: b.id, breakdownNo: b.breakdownNo, reason: b.reason, status: b.status, reportedAt: b.reportedAt } : null,
            session: s
              ? {
                  id: s.id,
                  sessionNo: s.sessionNo,
                  woNo: s.workOrder.woNo,
                  workOrderId: s.workOrderId,
                  process: s.woProcess.process.name,
                  operator: names.get(s.operatorId) ?? null,
                  checkInAt: s.checkInAt,
                  machineGood: q(s.goodQty),
                  machineReject: q(s.rejectQty),
                  processGood: q(s.woProcess.goodQty),
                  target: q(s.workOrder.quantity),
                  uom: s.workOrder.uom,
                }
              : null,
          };
        }),
      ),
    );
  });

  /** Check In / Check Out history. */
  r.get("/sessions", MONITOR, async (req, res) => {
    const f = query(
      req,
      range.extend({
        page: z.coerce.number().int().min(1).default(1),
        pageSize: z.coerce.number().int().min(1).max(200).default(50),
        status: z.enum(["RUNNING", "COMPLETED", "PAUSED", "BREAKDOWN", "TRANSFERRED", "CLOSED"]).optional(),
        machineId: z.uuid().optional(),
        operatorId: z.uuid().optional(),
        workOrderId: z.uuid().optional(),
        q: z.string().trim().max(60).optional(),
      }),
    );
    const where: Prisma.ProductionSessionWhereInput = {
      ...(f.status ? { status: f.status } : {}),
      ...(f.machineId ? { machineId: f.machineId } : {}),
      ...(f.operatorId ? { operatorId: f.operatorId } : {}),
      ...(f.workOrderId ? { workOrderId: f.workOrderId } : {}),
      ...(f.from || f.to ? { checkInAt: { ...(f.from ? { gte: f.from } : {}), ...(f.to ? { lte: f.to } : {}) } } : {}),
      ...(f.q ? { OR: [{ sessionNo: { contains: f.q } }, { workOrder: { woNo: { contains: f.q } } }] } : {}),
    };
    const [total, rows] = await Promise.all([
      db.productionSession.count({ where }),
      db.productionSession.findMany({
        where,
        orderBy: { checkInAt: "desc" },
        skip: (f.page - 1) * f.pageSize,
        take: f.pageSize,
        include: { machine: { select: { code: true, name: true } }, workOrder: { select: { woNo: true, uom: true } }, woProcess: { include: { process: { select: { name: true } } } } },
      }),
    ]);
    const names = await userNames(rows.map((s) => s.operatorId));
    const now = deps.now().getTime();
    res.json(
      ok(
        rows.map((s) => ({
          id: s.id,
          sessionNo: s.sessionNo,
          workOrderId: s.workOrderId,
          woNo: s.workOrder.woNo,
          process: s.woProcess.process.name,
          machine: s.machine,
          operator: names.get(s.operatorId) ?? null,
          checkInAt: s.checkInAt,
          checkOutAt: s.checkOutAt,
          durationMinutes: Math.round(((s.checkOutAt?.getTime() ?? now) - s.checkInAt.getTime()) / 60000),
          status: s.status,
          checkOutType: s.checkOutType,
          goodQty: q(s.goodQty),
          rejectQty: q(s.rejectQty),
          uom: s.workOrder.uom,
          remarks: s.remarks,
        })),
        pageMeta(f.page, f.pageSize, total),
      ),
    );
  });

  /** Output totals grouped by machine / Work Order / process / operator (from output entries). */
  r.get("/output-summary", MONITOR, async (req, res) => {
    const f = query(req, range.extend({ groupBy: z.enum(["machine", "workOrder", "process", "operator"]).default("machine") }));
    const where: Prisma.ProductionOutputWhereInput = f.from || f.to ? { recordedAt: { ...(f.from ? { gte: f.from } : {}), ...(f.to ? { lte: f.to } : {}) } } : {};
    const key = f.groupBy === "machine" ? "machineId" : f.groupBy === "operator" ? "operatorId" : "woProcessId";
    const grouped = await db.productionOutput.groupBy({ by: [key], where, _sum: { goodQty: true, rejectQty: true }, _count: { _all: true } });
    let rows: { key: string; label: string; sub: string | null; good: string; reject: string; entries: number }[] = [];
    if (f.groupBy === "machine") {
      const ms = await db.machine.findMany({ where: { id: { in: grouped.map((g) => g.machineId as string) } } });
      rows = grouped.map((g) => {
        const m = ms.find((x) => x.id === g.machineId);
        return { key: g.machineId as string, label: m?.code ?? "?", sub: m?.name ?? null, good: q(g._sum.goodQty), reject: q(g._sum.rejectQty), entries: g._count._all };
      });
    } else if (f.groupBy === "operator") {
      const names = await userNames(grouped.map((g) => g.operatorId as string));
      rows = grouped.map((g) => ({ key: g.operatorId as string, label: names.get(g.operatorId as string) ?? "?", sub: null, good: q(g._sum.goodQty), reject: q(g._sum.rejectQty), entries: g._count._all }));
    } else {
      const steps = await db.workOrderProcess.findMany({ where: { id: { in: grouped.map((g) => g.woProcessId as string) } }, include: { workOrder: { select: { id: true, woNo: true, uom: true } }, process: { select: { id: true, name: true } } } });
      const merged = new Map<string, { label: string; sub: string | null; good: ReturnType<typeof D>; reject: ReturnType<typeof D>; entries: number }>();
      for (const g of grouped) {
        const s = steps.find((x) => x.id === g.woProcessId);
        if (!s) continue;
        const k = f.groupBy === "workOrder" ? s.workOrder.id : s.process.id;
        const cur = merged.get(k) ?? { label: f.groupBy === "workOrder" ? s.workOrder.woNo : s.process.name, sub: f.groupBy === "workOrder" ? s.workOrder.uom : null, good: D(0), reject: D(0), entries: 0 };
        cur.good = cur.good.plus(D(g._sum.goodQty));
        cur.reject = cur.reject.plus(D(g._sum.rejectQty));
        cur.entries += g._count._all;
        merged.set(k, cur);
      }
      rows = [...merged.entries()].map(([k, v]) => ({ key: k, label: v.label, sub: v.sub, good: q(v.good), reject: q(v.reject), entries: v.entries }));
    }
    rows.sort((a, b) => a.label.localeCompare(b.label));
    res.json(ok(rows));
  });

  /**
   * Running hours and breakdown downtime per machine in a period. Utilisation =
   * running hours / calendar hours of the period (no shift calendar yet).
   */
  r.get("/utilization", MONITOR, async (req, res) => {
    const f = query(req, range);
    const now = deps.now();
    const to = f.to && f.to < now ? f.to : now;
    const from = f.from ?? new Date(to.getTime() - 7 * 86_400_000);
    if (from >= to) throw errors.validation([{ path: "from", message: "The start must be before the end" }]);
    const periodMs = to.getTime() - from.getTime();
    const [machines, sessions, breakdowns] = await Promise.all([
      db.machine.findMany({ where: { isActive: true }, orderBy: { code: "asc" }, select: { id: true, code: true, name: true, status: true } }),
      db.productionSession.findMany({ where: { checkInAt: { lt: to }, OR: [{ checkOutAt: null }, { checkOutAt: { gt: from } }] }, select: { machineId: true, checkInAt: true, checkOutAt: true } }),
      db.machineBreakdown.findMany({ where: { reportedAt: { lt: to }, OR: [{ resolvedAt: null }, { resolvedAt: { gt: from } }] }, select: { machineId: true, reportedAt: true, resolvedAt: true } }),
    ]);
    const overlap = (s: Date, e: Date | null) => Math.max(0, Math.min((e ?? now).getTime(), to.getTime()) - Math.max(s.getTime(), from.getTime()));
    res.json(
      ok({
        from,
        to,
        periodHours: +(periodMs / 3_600_000).toFixed(2),
        basis: "Calendar hours of the period (no shift calendar configured).",
        machines: machines.map((m) => {
          const run = sessions.filter((s) => s.machineId === m.id).reduce((t, s) => t + overlap(s.checkInAt, s.checkOutAt), 0);
          const down = breakdowns.filter((b) => b.machineId === m.id).reduce((t, b) => t + overlap(b.reportedAt, b.resolvedAt), 0);
          return {
            ...m,
            runningHours: +(run / 3_600_000).toFixed(2),
            downtimeHours: +(down / 3_600_000).toFixed(2),
            breakdowns: breakdowns.filter((b) => b.machineId === m.id).length,
            utilizationPct: periodMs ? +((run / periodMs) * 100).toFixed(1) : null,
          };
        }),
      }),
    );
  });

  r.get("/breakdowns", requireAnyPermission("shopfloor.output.view", "shopfloor.breakdown.release"), async (req, res) => {
    const f = query(req, range.extend({ status: z.enum(["OPEN", "UNDER_MAINTENANCE", "RESOLVED"]).optional(), machineId: z.uuid().optional(), open: z.enum(["1"]).optional() }));
    const rows = await db.machineBreakdown.findMany({
      where: {
        ...(f.open ? { status: { not: "RESOLVED" } } : f.status ? { status: f.status } : {}),
        ...(f.machineId ? { machineId: f.machineId } : {}),
        ...(f.from || f.to ? { reportedAt: { ...(f.from ? { gte: f.from } : {}), ...(f.to ? { lte: f.to } : {}) } } : {}),
      },
      orderBy: { reportedAt: "desc" },
      take: 200,
      include: { machine: { select: { id: true, code: true, name: true } } },
    });
    const wos = await db.workOrder.findMany({ where: { id: { in: rows.map((b) => b.workOrderId).filter((x): x is string => !!x) } }, select: { id: true, woNo: true } });
    const names = await userNames(rows.flatMap((b) => [b.reportedById, b.resolvedById, b.maintenanceById]));
    const now = deps.now().getTime();
    res.json(
      ok(
        rows.map((b) => ({
          id: b.id,
          breakdownNo: b.breakdownNo,
          machine: b.machine,
          woNo: wos.find((w) => w.id === b.workOrderId)?.woNo ?? null,
          workOrderId: b.workOrderId,
          reason: b.reason,
          remarks: b.remarks,
          status: b.status,
          reportedAt: b.reportedAt,
          reportedBy: names.get(b.reportedById) ?? null,
          lastConfirmedGood: b.lastConfirmedGood ? q(b.lastConfirmedGood) : null,
          maintenanceNote: b.maintenanceNote,
          maintenanceBy: b.maintenanceById ? (names.get(b.maintenanceById) ?? null) : null,
          resolvedAt: b.resolvedAt,
          resolvedBy: b.resolvedById ? (names.get(b.resolvedById) ?? null) : null,
          resolutionNote: b.resolutionNote,
          safetyConfirmed: b.safetyConfirmed,
          downtimeMinutes: Math.round(((b.resolvedAt?.getTime() ?? now) - b.reportedAt.getTime()) / 60000),
        })),
      ),
    );
  });

  r.get("/machine-changes", requireAnyPermission("shopfloor.output.view", "shopfloor.machine.change.approve"), async (req, res) => {
    const f = query(req, z.object({ status: z.enum(["PENDING", "APPROVED", "REJECTED"]).optional() }));
    const rows = await db.machineChange.findMany({ where: f.status ? { status: f.status } : {}, orderBy: { requestedAt: "desc" }, take: 200, include: { woProcess: { include: { process: { select: { name: true } }, workOrder: { select: { woNo: true } } } } } });
    const machines = await db.machine.findMany({ where: { id: { in: rows.flatMap((c) => [c.fromMachineId, c.toMachineId]).filter((x): x is string => !!x) } }, select: { id: true, code: true, name: true } });
    const names = await userNames(rows.flatMap((c) => [c.requestedById, c.decidedById]));
    res.json(
      ok(
        rows.map((c) => ({
          id: c.id,
          workOrderId: c.workOrderId,
          woNo: c.woProcess.workOrder.woNo,
          process: c.woProcess.process.name,
          from: machines.find((m) => m.id === c.fromMachineId) ?? null,
          to: machines.find((m) => m.id === c.toMachineId) ?? null,
          prevMachineGood: q(c.prevMachineGood),
          prevMachineReject: q(c.prevMachineReject),
          outstandingQty: q(c.outstandingQty),
          reason: c.reason,
          status: c.status,
          requestedBy: names.get(c.requestedById) ?? null,
          requestedAt: c.requestedAt,
          decidedBy: c.decidedById ? (names.get(c.decidedById) ?? null) : null,
          decidedAt: c.decidedAt,
          decisionNote: c.decisionNote,
        })),
      ),
    );
  });

  /** Summary numbers for the Shopfloor monitoring header (all from live records). */
  r.get("/summary", MONITOR, async (_req, res) => {
    const [byStatus, running, pendingChanges, openBreakdowns, workable] = await Promise.all([
      db.machine.groupBy({ by: ["status"], where: { isActive: true }, _count: { _all: true } }),
      db.productionSession.count({ where: { status: "RUNNING" } }),
      db.machineChange.count({ where: { status: "PENDING" } }),
      db.machineBreakdown.count({ where: { status: { not: "RESOLVED" } } }),
      db.workOrder.count({ where: { status: { in: [...WORKABLE_WO] as never } } }),
    ]);
    res.json(ok({ machinesByStatus: Object.fromEntries(byStatus.map((b) => [b.status, b._count._all])), runningSessions: running, pendingMachineChanges: pendingChanges, openBreakdowns, activeWorkOrders: workable }));
  });

  return r;
}
