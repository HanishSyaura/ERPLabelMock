import { Router, type Request } from "express";
import { z } from "zod";
import type { Prisma } from "../../generated/prisma/client";
import type { Deps } from "../../deps";
import { errors } from "../../lib/errors";
import { body, idParam, ok, pageMeta, params, query } from "../../lib/http";
import type { DbOrTx } from "../../lib/prisma";
import { addDays, DAY_KEY, dateColumn, dayKey, dayRange } from "../../lib/day";
import { D, isQtyInput, q } from "../../lib/qty";
import { requireAnyPermission, requirePermission } from "../../middleware/auth";
import { requireUser } from "../../middleware/context";
import { fileView } from "../bom/files.routes";
import { UOM_CODES } from "../bom/uom";
import { processQuantities, qtyView } from "../shopfloor/state";
import * as svc from "./orders.service";

const qty = z.union([z.number(), z.string()]).refine((v) => isQtyInput(v) && Number(v) > 0, "Enter a quantity greater than 0 (max 4 decimals)");
const text = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .optional()
    .nullable()
    .transform((v) => (v ? v : null));
const date = z.coerce.date().optional().nullable();
const priority = z.enum(["LOW", "NORMAL", "HIGH", "URGENT"]);
const reasonSchema = z.object({ reason: text(500) });

const pjoSchema = z.object({
  bomId: z.uuid({ message: "Choose a Father Code" }),
  orderQty: qty,
  uom: z.enum(UOM_CODES, { message: "Choose a unit" }),
  requiredDate: date,
  priority: priority.optional(),
  customerRef: text(120),
  productRef: text(120),
  remarks: text(500),
});
const woSchema = z.object({
  pjoId: z.uuid({ message: "Choose a Production Job Order" }),
  quantity: qty,
  plannedDate: date,
  priority: priority.optional(),
  remarks: text(500),
  routineId: z.uuid().optional().nullable(),
  processIds: z.array(z.uuid()).max(30).optional(),
});
const listSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
  q: z.string().trim().max(60).optional(),
  status: z.string().max(200).optional(),
  stage: z.enum(["planned", "in_progress", "completed"]).optional(),
  pjoId: z.uuid().optional(),
  /** Open Job Orders by the order's required date (plant day). */
  due: z.enum(["overdue", "today", "week"]).optional(),
  /** Job Orders completed on or after this plant day. */
  completedFrom: z.string().regex(DAY_KEY, "Use YYYY-MM-DD").optional(),
});
const WO_STATUSES = ["PLANNED", "RELEASED", "IN_PROGRESS", "PARTIALLY_COMPLETED", "COMPLETED", "ON_HOLD", "CANCELLED"] as const;
const PJO_STATUSES = ["DRAFT", "RELEASED", "CLOSED", "CANCELLED"] as const;
/** "A,B" status filter, validated against the enum (an unknown value is a 422, not a server error). */
export function statusIn<T extends string>(raw: string | undefined, allowed: readonly T[]): T[] | undefined {
  if (!raw) return undefined;
  const values = raw.split(",").map((s) => s.trim()).filter(Boolean);
  const bad = values.find((v) => !(allowed as readonly string[]).includes(v));
  if (bad) throw errors.validation([{ path: "status", message: `Unknown status ${bad}` }]);
  return values as T[];
}

/**
 * PJO stage for the list sections:
 * - planned: draft, or released with no production session on any Job Order yet;
 * - in_progress: released and production has started on a Job Order;
 * - completed: closed (Production Order Complete Utility) or cancelled.
 */
const STARTED: Prisma.ProductionJobOrderWhereInput = { workOrders: { some: { sessions: { some: {} } } } };
const PJO_STAGE: Record<"planned" | "in_progress" | "completed", Prisma.ProductionJobOrderWhereInput> = {
  planned: { OR: [{ status: "DRAFT" }, { status: "RELEASED", NOT: STARTED }] },
  in_progress: { status: "RELEASED", ...STARTED },
  completed: { status: { in: ["CLOSED", "CANCELLED"] } },
};
const pjoStage = (p: { status: string; workOrders: { _count: { sessions: number } }[] }) =>
  p.status === "CLOSED" || p.status === "CANCELLED" ? "completed" : p.status === "RELEASED" && p.workOrders.some((w) => w._count.sessions > 0) ? "in_progress" : "planned";

/** Work Order (Job Order) full view: PJO, frozen artwork, route with quantities. */
export async function workOrderView(db: DbOrTx, id: string) {
  const wo = await db.workOrder.findUnique({
    where: { id },
    include: {
      processes: { orderBy: { seq: "asc" }, include: { process: { select: { id: true, code: true, name: true } } } },
      pjo: {
        include: {
          bom: { select: { id: true, fatherCode: true } },
          artworkRevision: { include: { file: true } },
          componentRevision: { select: { revisionNo: true } },
        },
      },
    },
  });
  if (!wo) throw errors.notFound("Job Order");
  const machineIds = wo.processes.map((p) => p.assignedMachineId).filter((x): x is string => !!x);
  const machines = await db.machine.findMany({ where: { id: { in: machineIds } }, select: { id: true, code: true, name: true, status: true } });
  const machineOf = new Map(machines.map((m) => [m.id, m]));
  const pending = await db.machineChange.findMany({ where: { workOrderId: id, status: "PENDING" }, select: { woProcessId: true, toMachineId: true, id: true } });
  const currentSeq = wo.processes.find((p) => p.status !== "COMPLETED")?.seq ?? null;
  return {
    id: wo.id,
    woNo: wo.woNo,
    status: wo.status,
    quantity: q(wo.quantity),
    uom: wo.uom,
    plannedDate: wo.plannedDate,
    priority: wo.priority,
    remarks: wo.remarks,
    holdReason: wo.holdReason,
    releasedAt: wo.releasedAt,
    completedAt: wo.completedAt,
    completionNote: wo.completionNote,
    pjo: {
      id: wo.pjo.id,
      pjoNo: wo.pjo.pjoNo,
      status: wo.pjo.status,
      customerRef: wo.pjo.customerRef,
      fatherCode: wo.pjo.bom.fatherCode,
      bomId: wo.pjo.bom.id,
      labelDescription: wo.pjo.artworkRevision.labelDescription,
      artworkRevision: wo.pjo.artworkRevision.revisionNo,
      componentRevision: wo.pjo.componentRevision?.revisionNo ?? null,
      artworkFile: fileView(wo.pjo.artworkRevision.file),
    },
    currentSeq,
    processes: wo.processes.map((p) => ({
      id: p.id,
      seq: p.seq,
      process: p.process,
      status: p.status,
      assignedMachine: p.assignedMachineId ? (machineOf.get(p.assignedMachineId) ?? null) : null,
      allowPartialTransfer: p.allowPartialTransfer,
      allowSplit: p.allowSplit,
      extraAllowedQty: q(p.extraAllowedQty),
      startedAt: p.startedAt,
      completedAt: p.completedAt,
      completionNote: p.completionNote,
      pendingMachineChange: pending.find((c) => c.woProcessId === p.id) ?? null,
      quantities: qtyView(processQuantities(wo, wo.processes, p)),
    })),
  };
}

/** Master Card revision a PJO is frozen on (null for Father Codes without a product). */
const masterCardView = (p: { product: { productCode: string; currentCardRevNo: number } | null; masterCardRevision: { revisionNo: number } | null }) =>
  p.product && p.masterCardRevision
    ? { productCode: p.product.productCode, revisionNo: p.masterCardRevision.revisionNo, newerAvailable: p.product.currentCardRevNo > p.masterCardRevision.revisionNo }
    : null;

export function orderRoutes(deps: Deps) {
  const r = Router();
  const { db } = deps;
  const actor = (req: Request): svc.Actor => ({ user: requireUser(req), ctx: req.ctx });

  // ----- Production Job Order -------------------------------------------
  r.get("/production-job-orders", requirePermission("planning.pjo.view"), async (req, res) => {
    const f = query(req, listSchema);
    const pjoStatus = statusIn(f.status, PJO_STATUSES);
    const search: Prisma.ProductionJobOrderWhereInput = {
      ...(pjoStatus ? { status: { in: pjoStatus } } : {}),
      ...(f.q ? { OR: [{ pjoNo: { contains: f.q } }, { customerRef: { contains: f.q } }, { bom: { fatherCode: { contains: f.q } } }, { bom: { labelDescription: { contains: f.q } } }] } : {}),
    };
    const where: Prisma.ProductionJobOrderWhereInput = f.stage ? { AND: [search, PJO_STAGE[f.stage]] } : search;
    const [total, rows, planned, inProgress, completed] = await Promise.all([
      db.productionJobOrder.count({ where }),
      db.productionJobOrder.findMany({
        where,
        orderBy: { createdAt: "desc" },
        skip: (f.page - 1) * f.pageSize,
        take: f.pageSize,
        include: {
          bom: { select: { fatherCode: true } },
          artworkRevision: { select: { revisionNo: true, labelDescription: true, file: true } },
          componentRevision: { select: { revisionNo: true } },
          workOrders: { select: { quantity: true, status: true, _count: { select: { sessions: true } } } },
          product: { select: { productCode: true, currentCardRevNo: true } },
          masterCardRevision: { select: { revisionNo: true } },
        },
      }),
      db.productionJobOrder.count({ where: { AND: [search, PJO_STAGE.planned] } }),
      db.productionJobOrder.count({ where: { AND: [search, PJO_STAGE.in_progress] } }),
      db.productionJobOrder.count({ where: { AND: [search, PJO_STAGE.completed] } }),
    ]);
    res.json(
      ok(
        rows.map((p) => ({
          id: p.id,
          pjoNo: p.pjoNo,
          status: p.status,
          stage: pjoStage(p),
          fatherCode: p.bom.fatherCode,
          labelDescription: p.artworkRevision.labelDescription,
          artworkRevision: p.artworkRevision.revisionNo,
          componentRevision: p.componentRevision?.revisionNo ?? null,
          artworkFile: fileView(p.artworkRevision.file),
          customerRef: p.customerRef,
          orderQty: q(p.orderQty),
          uom: p.uom,
          allocatedQty: q(p.workOrders.filter((w) => w.status !== "CANCELLED").reduce((s, w) => s.plus(D(w.quantity)), D(0))),
          jobOrderCount: p.workOrders.filter((w) => w.status !== "CANCELLED").length,
          requiredDate: p.requiredDate,
          priority: p.priority,
          createdAt: p.createdAt,
          masterCard: masterCardView(p),
        })),
        { ...pageMeta(f.page, f.pageSize, total), stages: { planned, in_progress: inProgress, completed } },
      ),
    );
  });

  r.get("/production-job-orders/:id", requirePermission("planning.pjo.view"), async (req, res) => {
    const { id } = params(req, idParam);
    const p = await db.productionJobOrder.findUnique({
      where: { id },
      include: {
        bom: { select: { id: true, fatherCode: true, status: true, currentArtworkRevNo: true, currentComponentRevNo: true } },
        artworkRevision: { include: { file: true } },
        componentRevision: { include: { lines: { orderBy: { lineNo: "asc" }, include: { sonCode: { select: { sonCode: true } } } } } },
        workOrders: { orderBy: { woNo: "asc" } },
        product: { select: { id: true, productCode: true, name: true, currentCardRevNo: true } },
        masterCardRevision: { select: { revisionNo: true } },
      },
    });
    if (!p) throw errors.notFound("Production Job Order");
    // For a product's Father Code, "newer" means a newer released Master Card.
    const linkedProduct = p.product ?? (await db.product.findUnique({ where: { bomId: p.bom.id }, select: { id: true, productCode: true, name: true, currentCardRevNo: true } }));
    res.json(
      ok({
        id: p.id,
        pjoNo: p.pjoNo,
        status: p.status,
        customerRef: p.customerRef,
        productRef: p.productRef,
        orderQty: q(p.orderQty),
        uom: p.uom,
        requiredDate: p.requiredDate,
        priority: p.priority,
        remarks: p.remarks,
        releasedAt: p.releasedAt,
        createdAt: p.createdAt,
        bom: {
          ...p.bom,
          labelDescription: p.artworkRevision.labelDescription,
          artworkRevision: p.artworkRevision.revisionNo,
          componentRevision: p.componentRevision?.revisionNo ?? null,
          newerRevisionAvailable:
            p.status === "DRAFT" &&
            (linkedProduct
              ? linkedProduct.currentCardRevNo !== (p.masterCardRevision?.revisionNo ?? 0)
              : p.bom.currentArtworkRevNo !== p.artworkRevision.revisionNo || p.bom.currentComponentRevNo !== (p.componentRevision?.revisionNo ?? 0)),
          artworkFile: fileView(p.artworkRevision.file),
          components:
            p.componentRevision?.lines.map((l) => ({ sonCode: l.sonCode.sonCode, materialCode: l.materialCode, materialDescription: l.materialDescription, quantity: l.quantity ? q(l.quantity) : null, uom: l.uom })) ?? [],
        },
        workOrders: p.workOrders.map((w) => ({ id: w.id, woNo: w.woNo, status: w.status, quantity: q(w.quantity), plannedDate: w.plannedDate, priority: w.priority })),
        allocatedQty: q(p.workOrders.filter((w) => w.status !== "CANCELLED").reduce((s, w) => s.plus(D(w.quantity)), D(0))),
        masterCard: masterCardView(p),
        product: linkedProduct ? { id: linkedProduct.id, productCode: linkedProduct.productCode, name: linkedProduct.name, currentCardRevNo: linkedProduct.currentCardRevNo } : null,
      }),
    );
  });

  r.post("/production-job-orders", requirePermission("planning.pjo.create"), async (req, res) => {
    const input = body(req, pjoSchema);
    const pjo = await db.$transaction((tx) => svc.createPjo(tx, actor(req), input, deps.now()));
    res.status(201).json(ok({ id: pjo.id, pjoNo: pjo.pjoNo }));
  });
  r.patch("/production-job-orders/:id", requirePermission("planning.pjo.create"), async (req, res) => {
    const { id } = params(req, idParam);
    const input = body(req, pjoSchema.partial());
    await db.$transaction((tx) => svc.updatePjo(tx, actor(req), id, input));
    res.json(ok({ saved: true }));
  });
  r.post("/production-job-orders/:id/release", requirePermission("planning.pjo.release"), async (req, res) => {
    const { id } = params(req, idParam);
    const pjo = await db.$transaction((tx) => svc.releasePjo(tx, actor(req), id, deps.now()));
    res.json(ok({ status: pjo.status }));
  });
  r.post("/production-job-orders/:id/cancel", requirePermission("planning.pjo.release"), async (req, res) => {
    const { id } = params(req, idParam);
    const { reason } = body(req, reasonSchema);
    const r = await db.$transaction((tx) => svc.cancelPjo(tx, actor(req), id, reason));
    res.json(ok({ status: "CANCELLED", material: r.material }));
  });

  // ----- Job Order (Work Order) -----------------------------------------
  r.get("/work-orders", requireAnyPermission("planning.jo.view", "shopfloor.wip.view"), async (req, res) => {
    const f = query(req, listSchema);
    const woStatus = statusIn(f.status, WO_STATUSES);
    const todayKey = dayKey(deps.now());
    const dueWhere: Record<"overdue" | "today" | "week", Prisma.DateTimeNullableFilter> = {
      overdue: { lt: dateColumn(todayKey) },
      today: { equals: dateColumn(todayKey) },
      week: { gte: dateColumn(todayKey), lt: dateColumn(addDays(todayKey, 7)) },
    };
    const where: Prisma.WorkOrderWhereInput = {
      ...(woStatus ? { status: { in: woStatus } } : {}),
      ...(f.due ? { status: { in: (woStatus ?? ["PLANNED", "RELEASED", "IN_PROGRESS", "PARTIALLY_COMPLETED", "ON_HOLD"]).filter((s) => s !== "COMPLETED" && s !== "CANCELLED") }, pjo: { requiredDate: dueWhere[f.due] } } : {}),
      ...(f.completedFrom ? { completedAt: { gte: dayRange(f.completedFrom).start } } : {}),
      ...(f.pjoId ? { pjoId: f.pjoId } : {}),
      ...(f.q ? { OR: [{ woNo: { contains: f.q } }, { pjo: { pjoNo: { contains: f.q } } }, { pjo: { bom: { fatherCode: { contains: f.q } } } }, { pjo: { artworkRevision: { labelDescription: { contains: f.q } } } }] } : {}),
    };
    const [total, rows] = await Promise.all([
      db.workOrder.count({ where }),
      db.workOrder.findMany({
        where,
        orderBy: [{ createdAt: "desc" }],
        skip: (f.page - 1) * f.pageSize,
        take: f.pageSize,
        include: {
          pjo: { select: { pjoNo: true, customerRef: true, requiredDate: true, bom: { select: { fatherCode: true } }, artworkRevision: { select: { labelDescription: true, file: true } } } },
          processes: { orderBy: { seq: "asc" }, include: { process: { select: { name: true } } } },
        },
      }),
    ]);
    res.json(
      ok(
        rows.map((w) => {
          const current = w.processes.find((p) => p.status !== "COMPLETED") ?? null;
          const last = w.processes[w.processes.length - 1];
          return {
            id: w.id,
            woNo: w.woNo,
            status: w.status,
            pjoNo: w.pjo.pjoNo,
            fatherCode: w.pjo.bom.fatherCode,
            labelDescription: w.pjo.artworkRevision.labelDescription,
            artworkFile: fileView(w.pjo.artworkRevision.file),
            quantity: q(w.quantity),
            uom: w.uom,
            plannedDate: w.plannedDate,
            requiredDate: w.pjo.requiredDate,
            customerRef: w.pjo.customerRef,
            priority: w.priority,
            currentProcess: current ? { name: current.process.name, status: current.status, seq: current.seq } : null,
            processCount: w.processes.length,
            completedProcesses: w.processes.filter((p) => p.status === "COMPLETED").length,
            finalGood: last ? q(last.goodQty) : "0",
          };
        }),
        pageMeta(f.page, f.pageSize, total),
      ),
    );
  });

  r.get("/work-orders/:id", requireAnyPermission("planning.jo.view", "shopfloor.wip.view", "shopfloor.handheld"), async (req, res) => {
    const { id } = params(req, idParam);
    res.json(ok(await workOrderView(db, id)));
  });

  /** Complete production journey across machines: sessions, machine changes, breakdowns. */
  r.get("/work-orders/:id/journey", requireAnyPermission("planning.jo.view", "shopfloor.wip.view"), async (req, res) => {
    const { id } = params(req, idParam);
    const [sessions, changes, breakdowns] = await Promise.all([
      db.productionSession.findMany({ where: { workOrderId: id }, orderBy: [{ checkInAt: "asc" }, { sessionNo: "asc" }], include: { machine: { select: { code: true, name: true } } } }),
      db.machineChange.findMany({ where: { workOrderId: id }, orderBy: { requestedAt: "asc" } }),
      db.machineBreakdown.findMany({ where: { workOrderId: id }, orderBy: { reportedAt: "asc" }, include: { machine: { select: { code: true, name: true } } } }),
    ]);
    const userIds = [...sessions.map((s) => s.operatorId), ...changes.flatMap((c) => [c.requestedById, c.decidedById]), ...breakdowns.map((b) => b.reportedById)].filter((x): x is string => !!x);
    const machineIds = changes.flatMap((c) => [c.fromMachineId, c.toMachineId]).filter((x): x is string => !!x);
    const [users, machines] = await Promise.all([
      db.user.findMany({ where: { id: { in: userIds } }, select: { id: true, fullName: true } }),
      db.machine.findMany({ where: { id: { in: machineIds } }, select: { id: true, code: true, name: true } }),
    ]);
    const nameOf = new Map(users.map((u) => [u.id, u.fullName]));
    const machineOf = new Map(machines.map((m) => [m.id, m]));
    res.json(
      ok({
        sessions: sessions.map((s) => ({
          id: s.id,
          sessionNo: s.sessionNo,
          woProcessId: s.woProcessId,
          machine: s.machine,
          operator: nameOf.get(s.operatorId) ?? null,
          checkInAt: s.checkInAt,
          checkOutAt: s.checkOutAt,
          status: s.status,
          checkOutType: s.checkOutType,
          goodQty: q(s.goodQty),
          rejectQty: q(s.rejectQty),
          remarks: s.remarks,
        })),
        machineChanges: changes.map((c) => ({
          id: c.id,
          woProcessId: c.woProcessId,
          from: c.fromMachineId ? (machineOf.get(c.fromMachineId) ?? null) : null,
          to: machineOf.get(c.toMachineId) ?? null,
          prevMachineGood: q(c.prevMachineGood),
          prevMachineReject: q(c.prevMachineReject),
          outstandingQty: q(c.outstandingQty),
          reason: c.reason,
          status: c.status,
          requestedBy: nameOf.get(c.requestedById) ?? null,
          requestedAt: c.requestedAt,
          decidedBy: c.decidedById ? (nameOf.get(c.decidedById) ?? null) : null,
          decidedAt: c.decidedAt,
        })),
        breakdowns: breakdowns.map((b) => ({
          id: b.id,
          breakdownNo: b.breakdownNo,
          woProcessId: b.woProcessId,
          machine: b.machine,
          reason: b.reason,
          remarks: b.remarks,
          status: b.status,
          reportedAt: b.reportedAt,
          reportedBy: nameOf.get(b.reportedById) ?? null,
          resolvedAt: b.resolvedAt,
        })),
      }),
    );
  });

  r.post("/work-orders", requirePermission("planning.jo.create"), async (req, res) => {
    const input = body(req, woSchema);
    const wo = await db.$transaction((tx) => svc.createWorkOrder(tx, actor(req), input, deps.now()));
    res.status(201).json(ok({ id: wo.id, woNo: wo.woNo }));
  });
  r.patch("/work-orders/:id", requirePermission("planning.jo.create"), async (req, res) => {
    const { id } = params(req, idParam);
    const input = body(req, woSchema.omit({ pjoId: true }).partial());
    await db.$transaction((tx) => svc.updateWorkOrder(tx, actor(req), id, input));
    res.json(ok({ saved: true }));
  });
  r.post("/work-orders/:id/release", requirePermission("planning.jo.release"), async (req, res) => {
    const { id } = params(req, idParam);
    await db.$transaction((tx) => svc.releaseWorkOrder(tx, actor(req), id, deps.now()));
    res.json(ok({ status: "RELEASED" }));
  });
  r.post("/work-orders/:id/hold", requirePermission("planning.jo.release"), async (req, res) => {
    const { id } = params(req, idParam);
    const { reason } = body(req, reasonSchema);
    const wo = await db.$transaction((tx) => svc.holdWorkOrder(tx, actor(req), id, true, reason, deps.now()));
    res.json(ok({ status: wo.status }));
  });
  r.post("/work-orders/:id/unhold", requirePermission("planning.jo.release"), async (req, res) => {
    const { id } = params(req, idParam);
    const { reason } = body(req, reasonSchema);
    const wo = await db.$transaction((tx) => svc.holdWorkOrder(tx, actor(req), id, false, reason, deps.now()));
    res.json(ok({ status: wo.status }));
  });
  r.post("/work-orders/:id/cancel", requirePermission("planning.jo.release"), async (req, res) => {
    const { id } = params(req, idParam);
    const { reason } = body(req, reasonSchema);
    const r = await db.$transaction((tx) => svc.cancelWorkOrder(tx, actor(req), id, reason));
    res.json(ok({ status: "CANCELLED", material: r.material }));
  });
  r.post("/work-orders/:id/complete", requirePermission("planning.jo.complete"), async (req, res) => {
    const { id } = params(req, idParam);
    const { note } = body(req, z.object({ note: text(500) }));
    await db.$transaction((tx) => svc.completeWorkOrder(tx, actor(req), id, note, deps.now()));
    res.json(ok({ status: "COMPLETED" }));
  });
  r.put("/work-order-processes/:id/authorization", requirePermission("shopfloor.process.authorize"), async (req, res) => {
    const { id } = params(req, idParam);
    const input = body(
      req,
      z.object({
        allowPartialTransfer: z.boolean().optional(),
        allowSplit: z.boolean().optional(),
        extraAllowedQty: z.union([z.number(), z.string()]).refine((v) => isQtyInput(v), "Enter 0 or more").optional(),
        note: z.string().trim().min(1, "Give the reason").max(500),
      }),
    );
    await db.$transaction((tx) => svc.authorizeProcess(tx, actor(req), id, input));
    res.json(ok({ saved: true }));
  });

  return r;
}
