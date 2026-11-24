import { Router, type Request } from "express";
import { z } from "zod";
import type { MaterialTxnType, Prisma } from "../../generated/prisma/client";
import type { Deps } from "../../deps";
import { addDays, DAY_KEY, dayKey } from "../../lib/day";
import { errors } from "../../lib/errors";
import { body, idParam, ok, pageMeta, params, query } from "../../lib/http";
import { isQtyInput, q } from "../../lib/qty";
import { requireAnyPermission, requirePermission } from "../../middleware/auth";
import { hasPermission, requireUser } from "../../middleware/context";
import { idempotent } from "../shopfloor/session.service";
import { completePjo, completionCheck } from "./completion.service";
import * as mat from "./material.service";
import type { Actor } from "./orders.service";
import { dailyView } from "./daily.service";

const qty = z.union([z.number(), z.string()]).refine((v) => isQtyInput(v) && Number(v) > 0, "Enter a quantity greater than 0 (max 4 decimals)");
const text = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .optional()
    .nullable()
    .transform((v) => (v ? v : null));
const day = z.string().regex(DAY_KEY, "Use a date like 2026-11-20");
const txnId = z.string().trim().min(8).max(64);

const MATERIAL_VIEW = ["planning.mrs.view", "planning.mrs.issue", "planning.mrs.additional", "shopfloor.mrs.return", "shopfloor.mrs.reject", "shopfloor.scrap.record"] as const;

/** Daily Job Information and Production Order Complete Utility (mounted at /planning). */
export function planningOpsRoutes(deps: Deps) {
  const r = Router();
  const { db } = deps;
  const actor = (req: Request): Actor => ({ user: requireUser(req), ctx: req.ctx });

  // ----- Daily Job Information ----------------------------------------------
  r.get("/daily", requirePermission("planning.daily.view"), async (req, res) => {
    const f = query(req, z.object({ date: day.optional() }));
    res.json(ok(await dailyView(db, f.date ?? dayKey(deps.now()), deps.now())));
  });

  // ----- Production Order Complete Utility ------------------------------------
  r.get("/completion", requirePermission("planning.pjo.view"), async (req, res) => {
    const f = query(
      req,
      z.object({ page: z.coerce.number().int().min(1).default(1), pageSize: z.coerce.number().int().min(1).max(100).default(25), q: z.string().trim().max(60).optional(), view: z.enum(["open", "closed"]).default("open") }),
    );
    const where: Prisma.ProductionJobOrderWhereInput = {
      status: f.view === "open" ? "RELEASED" : "CLOSED",
      ...(f.q ? { OR: [{ pjoNo: { contains: f.q } }, { customerRef: { contains: f.q } }, { bom: { fatherCode: { contains: f.q } } }] } : {}),
    };
    const [total, rows] = await Promise.all([
      db.productionJobOrder.count({ where }),
      db.productionJobOrder.findMany({
        where,
        orderBy: f.view === "open" ? [{ requiredDate: "asc" }, { pjoNo: "asc" }] : [{ closedAt: "desc" }],
        skip: (f.page - 1) * f.pageSize,
        take: f.pageSize,
        include: { bom: { select: { fatherCode: true } }, artworkRevision: { select: { labelDescription: true } }, workOrders: { select: { status: true } } },
      }),
    ]);
    res.json(
      ok(
        rows.map((p) => {
          const live = p.workOrders.filter((w) => w.status !== "CANCELLED");
          const done = live.filter((w) => w.status === "COMPLETED").length;
          return {
            id: p.id,
            pjoNo: p.pjoNo,
            status: p.status,
            fatherCode: p.bom.fatherCode,
            labelDescription: p.artworkRevision.labelDescription,
            customerRef: p.customerRef,
            orderQty: q(p.orderQty),
            uom: p.uom,
            requiredDate: p.requiredDate,
            jobOrders: live.length,
            completedJobOrders: done,
            ready: live.length > 0 && done === live.length,
            closedAt: p.closedAt,
            closureOverride: p.closureOverride,
          };
        }),
        pageMeta(f.page, f.pageSize, total),
      ),
    );
  });
  r.get("/completion/:id", requirePermission("planning.pjo.view"), async (req, res) => {
    const { id } = params(req, idParam);
    const check = await completionCheck(db, id);
    const pjo = await db.productionJobOrder.findUniqueOrThrow({ where: { id }, select: { closedAt: true, closedById: true, closureNote: true, closureOverride: true } });
    const closedBy = pjo.closedById ? await db.user.findUnique({ where: { id: pjo.closedById }, select: { fullName: true } }) : null;
    res.json(ok({ ...check, closure: pjo.closedAt ? { closedAt: pjo.closedAt, closedBy: closedBy?.fullName ?? null, note: pjo.closureNote, override: pjo.closureOverride } : null }));
  });
  r.post("/completion/:id/complete", requirePermission("planning.completion.complete"), async (req, res) => {
    const { id } = params(req, idParam);
    const input = body(req, z.object({ note: text(500), override: z.boolean().default(false) }));
    const user = requireUser(req);
    const result = await db.$transaction((tx) => completePjo(tx, actor(req), id, { ...input, canOverride: hasPermission(user, "planning.completion.override") }, deps.now()));
    res.json(ok(result));
  });

  return r;
}

/** MRS, additional issue, return, reject, scrap and reason codes (mounted at /material). */
export function materialMovementRoutes(deps: Deps) {
  const r = Router();
  const { db } = deps;
  const actor = (req: Request): Actor => ({ user: requireUser(req), ctx: req.ctx });

  r.get("/requisitions", requireAnyPermission(...MATERIAL_VIEW), async (req, res) => {
    const f = query(
      req,
      z.object({
        page: z.coerce.number().int().min(1).default(1),
        pageSize: z.coerce.number().int().min(1).max(100).default(25),
        q: z.string().trim().max(60).optional(),
        /** One status or several ("OPEN,PARTIALLY_ISSUED"). */
        status: z
          .string()
          .max(80)
          .optional()
          .transform((v) => (v ? v.split(",").map((s) => s.trim()).filter(Boolean) : undefined))
          .pipe(z.array(z.enum(["OPEN", "PARTIALLY_ISSUED", "ISSUED", "CLOSED", "CANCELLED"], { message: "Unknown status" })).optional()),
        workOrderId: z.uuid().optional(),
        /** Only requisitions of Job Orders that can still use material (not completed / cancelled). */
        activeJob: z.enum(["1"]).optional(),
        /** Only requisitions with material still out (for return / reject / scrap). */
        withOnHand: z.enum(["1"]).optional(),
      }),
    );
    const where: Prisma.MaterialRequisitionWhereInput = {
      ...(f.status ? { status: { in: f.status } } : {}),
      ...(f.workOrderId ? { workOrderId: f.workOrderId } : {}),
      ...(f.activeJob ? { workOrder: { status: { in: ["PLANNED", "RELEASED", "IN_PROGRESS", "PARTIALLY_COMPLETED", "ON_HOLD"] } } } : {}),
      ...(f.withOnHand ? { status: { notIn: ["CLOSED", "CANCELLED"] }, lines: { some: { OR: [{ issuedQty: { gt: 0 } }, { additionalQty: { gt: 0 } }] } } } : {}),
      ...(f.q ? { OR: [{ mrsNo: { contains: f.q } }, { workOrder: { woNo: { contains: f.q } } }, { workOrder: { pjo: { pjoNo: { contains: f.q } } } }, { lines: { some: { materialCode: { contains: f.q } } } }] } : {}),
    };
    const [total, rows] = await Promise.all([
      db.materialRequisition.count({ where }),
      db.materialRequisition.findMany({
        where,
        orderBy: { createdAt: "desc" },
        skip: (f.page - 1) * f.pageSize,
        take: f.pageSize,
        include: { lines: true, workOrder: { select: { id: true, woNo: true, status: true, pjo: { select: { pjoNo: true, bom: { select: { fatherCode: true } } } } } } },
      }),
    ]);
    res.json(
      ok(
        rows.map((m) => ({
          id: m.id,
          mrsNo: m.mrsNo,
          status: m.status,
          workOrder: { id: m.workOrder.id, woNo: m.workOrder.woNo, status: m.workOrder.status },
          pjoNo: m.workOrder.pjo.pjoNo,
          fatherCode: m.workOrder.pjo.bom.fatherCode,
          lineCount: m.lines.length,
          linesFullyIssued: m.lines.filter((l) => mat.lineBalances(l).remainingToIssue.isZero()).length,
          linesWithOnHand: m.lines.filter((l) => !mat.lineBalances(l).onHand.isZero()).length,
          createdAt: m.createdAt,
        })),
        pageMeta(f.page, f.pageSize, total),
      ),
    );
  });

  r.get("/requisitions/:id", requireAnyPermission(...MATERIAL_VIEW), async (req, res) => {
    const { id } = params(req, idParam);
    const m = await db.materialRequisition.findUnique({
      where: { id },
      include: {
        lines: { orderBy: { lineNo: "asc" }, include: { sonCode: { select: { sonCode: true } } } },
        workOrder: { include: { pjo: { select: { id: true, pjoNo: true, status: true, bom: { select: { fatherCode: true } }, artworkRevision: { select: { labelDescription: true } }, componentRevision: { select: { revisionNo: true } } } }, processes: { orderBy: { seq: "asc" }, include: { process: { select: { name: true } } } } } },
        transactions: { orderBy: { id: "desc" }, include: { reasonCode: { select: { code: true, description: true } } } },
      },
    });
    if (!m) throw errors.notFound("MRS");
    const userIds = [...new Set([m.createdById, ...m.transactions.map((t) => t.createdById)])];
    const machineIds = m.transactions.map((t) => t.machineId).filter((x): x is string => !!x);
    const [users, machines] = await Promise.all([
      db.user.findMany({ where: { id: { in: userIds } }, select: { id: true, fullName: true } }),
      db.machine.findMany({ where: { id: { in: machineIds } }, select: { id: true, code: true } }),
    ]);
    const nameOf = new Map(users.map((u) => [u.id, u.fullName]));
    const machineOf = new Map(machines.map((x) => [x.id, x.code]));
    const lineOf = new Map(m.lines.map((l) => [l.id, l]));
    const stepOf = new Map(m.workOrder.processes.map((p) => [p.id, p.process.name]));
    res.json(
      ok({
        id: m.id,
        mrsNo: m.mrsNo,
        status: m.status,
        remarks: m.remarks,
        createdAt: m.createdAt,
        createdBy: nameOf.get(m.createdById) ?? null,
        closedAt: m.closedAt,
        workOrder: {
          id: m.workOrder.id,
          woNo: m.workOrder.woNo,
          status: m.workOrder.status,
          holdReason: m.workOrder.holdReason,
          quantity: q(m.workOrder.quantity),
          uom: m.workOrder.uom,
          processes: m.workOrder.processes.map((p) => ({ id: p.id, seq: p.seq, name: p.process.name })),
        },
        pjo: { id: m.workOrder.pjo.id, pjoNo: m.workOrder.pjo.pjoNo, status: m.workOrder.pjo.status, fatherCode: m.workOrder.pjo.bom.fatherCode, labelDescription: m.workOrder.pjo.artworkRevision.labelDescription, componentRevision: m.workOrder.pjo.componentRevision?.revisionNo ?? null },
        lines: m.lines.map(mat.lineView),
        transactions: m.transactions.map((t) => ({
          id: String(t.id),
          txnNo: t.txnNo,
          type: t.type,
          materialCode: lineOf.get(t.mrsLineId)?.materialCode ?? null,
          qty: q(t.qty),
          uom: t.uom,
          lotRef: t.lotRef,
          reason: t.reasonCode ? `${t.reasonCode.code} – ${t.reasonCode.description}` : null,
          machine: t.machineId ? (machineOf.get(t.machineId) ?? null) : null,
          process: t.woProcessId ? (stepOf.get(t.woProcessId) ?? null) : null,
          remarks: t.remarks,
          by: nameOf.get(t.createdById) ?? null,
          at: t.createdAt,
        })),
      }),
    );
  });

  r.get("/work-orders/:id/mrs-template", requirePermission("planning.mrs.issue"), async (req, res) => {
    const { id } = params(req, idParam);
    res.json(ok(await mat.mrsTemplate(db, id)));
  });
  r.post("/requisitions", requirePermission("planning.mrs.issue"), async (req, res) => {
    const input = body(
      req,
      z.object({
        workOrderId: z.uuid({ message: "Choose a Job Order" }),
        remarks: text(500),
        lines: z.array(z.object({ sonCodeId: z.uuid(), requestedQty: qty })).max(100),
      }),
    );
    const mrs = await db.$transaction((tx) => mat.createMrs(tx, actor(req), input, deps.now()));
    res.status(201).json(ok({ id: mrs.id, mrsNo: mrs.mrsNo }));
  });
  r.post("/requisitions/:id/cancel", requirePermission("planning.mrs.issue"), async (req, res) => {
    const { id } = params(req, idParam);
    const { reason } = body(req, z.object({ reason: text(500) }));
    await db.$transaction((tx) => mat.cancelMrs(tx, actor(req), id, reason));
    res.json(ok({ status: "CANCELLED" }));
  });

  const movement = (type: MaterialTxnType, permission: string) =>
    r.post(`/lines/:id/${type.toLowerCase().replace("_", "-")}`, requirePermission(permission), async (req, res) => {
      const { id } = params(req, idParam);
      const input = body(
        req,
        z.object({
          clientTxnId: txnId,
          qty,
          lotRef: text(80),
          reasonCodeId: z.uuid().optional().nullable(),
          machineId: z.uuid().optional().nullable(),
          woProcessId: z.uuid().optional().nullable(),
          remarks: text(500),
        }),
      );
      const a = actor(req);
      const result = await idempotent(db, a, input.clientTxnId, `MATERIAL_${type}`, (tx) => mat.recordMovement(tx, a, type, id, input, deps.now()));
      res.status(result.replayed ? 200 : 201).json(ok(result));
    });
  movement("ISSUE", "planning.mrs.issue");
  movement("ADDITIONAL_ISSUE", "planning.mrs.additional");
  movement("RETURN", "shopfloor.mrs.return");
  movement("REJECT", "shopfloor.mrs.reject");
  movement("SCRAP", "shopfloor.scrap.record");

  /** Material Movement register (tabs: MRS Additional Issued, MRS Return, MRS Reject, Scrap Bad Material, All). */
  r.get("/transactions", requireAnyPermission(...MATERIAL_VIEW), async (req, res) => {
    const f = query(
      req,
      z.object({
        page: z.coerce.number().int().min(1).default(1),
        pageSize: z.coerce.number().int().min(1).max(100).default(25),
        /** Omitted = every movement type ("All" tab of the Material Movement register). */
        type: z.enum(["ISSUE", "ADDITIONAL_ISSUE", "RETURN", "REJECT", "SCRAP"]).optional(),
        q: z.string().trim().max(60).optional(),
        from: day.optional(),
        to: day.optional(),
      }),
    );
    const where: Prisma.MaterialTransactionWhereInput = {
      ...(f.type ? { type: f.type } : {}),
      ...(f.from || f.to ? { createdAt: { ...(f.from ? { gte: new Date(`${f.from}T00:00:00`) } : {}), ...(f.to ? { lt: new Date(`${addDays(f.to, 1)}T00:00:00`) } : {}) } } : {}),
      ...(f.q ? { OR: [{ txnNo: { contains: f.q } }, { lotRef: { contains: f.q } }, { mrs: { mrsNo: { contains: f.q } } }, { line: { materialCode: { contains: f.q } } }] } : {}),
    };
    const [total, rows] = await Promise.all([
      db.materialTransaction.count({ where }),
      db.materialTransaction.findMany({
        where,
        orderBy: { id: "desc" },
        skip: (f.page - 1) * f.pageSize,
        take: f.pageSize,
        include: { mrs: { select: { id: true, mrsNo: true, workOrder: { select: { woNo: true } } } }, line: { select: { materialCode: true, materialDescription: true } }, reasonCode: { select: { code: true, description: true } } },
      }),
    ]);
    const userIds = [...new Set(rows.map((t) => t.createdById))];
    const machineIds = rows.map((t) => t.machineId).filter((x): x is string => !!x);
    const stepIds = rows.map((t) => t.woProcessId).filter((x): x is string => !!x);
    const [users, machines, steps] = await Promise.all([
      db.user.findMany({ where: { id: { in: userIds } }, select: { id: true, fullName: true } }),
      db.machine.findMany({ where: { id: { in: machineIds } }, select: { id: true, code: true } }),
      db.workOrderProcess.findMany({ where: { id: { in: stepIds } }, select: { id: true, process: { select: { name: true } } } }),
    ]);
    const nameOf = new Map(users.map((u) => [u.id, u.fullName]));
    const machineOf = new Map(machines.map((x) => [x.id, x.code]));
    const stepOf = new Map(steps.map((s) => [s.id, s.process.name]));
    res.json(
      ok(
        rows.map((t) => ({
          id: String(t.id),
          txnNo: t.txnNo,
          type: t.type,
          mrsId: t.mrs.id,
          mrsNo: t.mrs.mrsNo,
          woNo: t.mrs.workOrder.woNo,
          materialCode: t.line.materialCode,
          materialDescription: t.line.materialDescription,
          qty: q(t.qty),
          uom: t.uom,
          lotRef: t.lotRef,
          reason: t.reasonCode ? `${t.reasonCode.code} – ${t.reasonCode.description}` : null,
          machine: t.machineId ? (machineOf.get(t.machineId) ?? null) : null,
          process: t.woProcessId ? (stepOf.get(t.woProcessId) ?? null) : null,
          remarks: t.remarks,
          by: nameOf.get(t.createdById) ?? null,
          at: t.createdAt,
        })),
        pageMeta(f.page, f.pageSize, total),
      ),
    );
  });

  // ----- Reason codes ----------------------------------------------------------
  const category = z.enum(["ADDITIONAL_ISSUE", "REJECT", "SCRAP"]);
  r.get("/reasons", requireAnyPermission(...MATERIAL_VIEW, "planning.reason.manage"), async (req, res) => {
    const f = query(req, z.object({ category: category.optional(), status: z.enum(["ACTIVE", "INACTIVE"]).optional() }));
    const rows = await db.reasonCode.findMany({ where: { ...(f.category ? { category: f.category } : {}), ...(f.status ? { status: f.status } : {}) }, orderBy: [{ category: "asc" }, { code: "asc" }] });
    res.json(ok(rows.map((x) => ({ id: x.id, category: x.category, code: x.code, description: x.description, status: x.status }))));
  });
  r.post("/reasons", requirePermission("planning.reason.manage"), async (req, res) => {
    const input = body(req, z.object({ category, code: z.string().trim().min(1, "Enter a code").max(30).regex(/^[A-Za-z0-9_-]+$/, "Letters, digits, - and _ only"), description: z.string().trim().min(1, "Enter a description").max(255) }));
    const created = await db.$transaction((tx) => mat.createReason(tx, actor(req), input));
    res.status(201).json(ok({ id: created.id }));
  });
  r.patch("/reasons/:id", requirePermission("planning.reason.manage"), async (req, res) => {
    const { id } = params(req, idParam);
    const input = body(req, z.object({ description: z.string().trim().min(1).max(255).optional(), status: z.enum(["ACTIVE", "INACTIVE"]).optional() }));
    await db.$transaction((tx) => mat.updateReason(tx, actor(req), id, input));
    res.json(ok({ saved: true }));
  });

  return r;
}
