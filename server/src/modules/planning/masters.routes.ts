import { Router } from "express";
import { z } from "zod";
import type { Deps } from "../../deps";
import { errors } from "../../lib/errors";
import { body, idParam, ok, params, query } from "../../lib/http";
import { requireAnyPermission, requirePermission } from "../../middleware/auth";
import { requireUser } from "../../middleware/context";
import { diff, recordAudit } from "../audit/audit.service";

/**
 * Planning masters: Process, Machine Category, Machine (+ handheld devices).
 * Codes are immutable; records are deactivated, never deleted.
 */
const code = z
  .string()
  .trim()
  .min(1, "Enter the code")
  .max(30)
  .regex(/^[A-Za-z0-9._\-/]+$/, "Letters, numbers and . _ - / only")
  .transform((v) => v.toUpperCase());
const name = z.string().trim().min(1, "Enter the name").max(80);
const text = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .optional()
    .nullable()
    .transform((v) => (v ? v : null));
const statusSchema = z.object({ status: z.enum(["ACTIVE", "INACTIVE"]) });
const listSchema = z.object({ q: z.string().trim().max(60).optional(), status: z.enum(["ACTIVE", "INACTIVE"]).optional() });

export function planningMasterRoutes(deps: Deps) {
  const r = Router();
  const { db } = deps;
  const VIEW = requireAnyPermission("planning.master.view", "shopfloor.output.view", "shopfloor.handheld", "planning.jo.view");
  const MANAGE = requirePermission("planning.master.manage");

  // ----- Process ---------------------------------------------------------
  const processSchema = z.object({ code, name, description: text(255), sequence: z.number().int().min(0).max(999).default(0) });
  r.get("/processes", VIEW, async (req, res) => {
    const q = query(req, listSchema);
    const rows = await db.process.findMany({
      where: { ...(q.status ? { status: q.status } : {}), ...(q.q ? { OR: [{ code: { contains: q.q } }, { name: { contains: q.q } }] } : {}) },
      orderBy: [{ sequence: "asc" }, { code: "asc" }],
      include: { _count: { select: { categories: true } } },
    });
    res.json(ok(rows.map(({ _count, ...p }) => ({ ...p, categoryCount: _count.categories }))));
  });
  r.post("/processes", MANAGE, async (req, res) => {
    const user = requireUser(req);
    const input = body(req, processSchema);
    const row = await db.$transaction(async (tx) => {
      if (await tx.process.findUnique({ where: { code: input.code } })) throw errors.validation([{ path: "code", message: "This process code already exists" }]);
      const p = await tx.process.create({ data: { ...input, createdById: user.id, updatedById: user.id } });
      await recordAudit(tx, req.ctx, { module: "planning", action: "PROCESS_CREATED", entityType: "process", entityId: p.id, recordRef: p.code, next: input });
      return p;
    });
    res.status(201).json(ok(row));
  });
  r.patch("/processes/:id", MANAGE, async (req, res) => {
    const user = requireUser(req);
    const { id } = params(req, idParam);
    const input = body(req, processSchema.omit({ code: true }).partial());
    const row = await db.$transaction(async (tx) => {
      const before = await tx.process.findUnique({ where: { id } });
      if (!before) throw errors.notFound("Process");
      const change = diff(before, input);
      if (!change.changed) return before;
      const p = await tx.process.update({ where: { id }, data: { ...input, updatedById: user.id } });
      await recordAudit(tx, req.ctx, { module: "planning", action: "PROCESS_UPDATED", entityType: "process", entityId: id, recordRef: p.code, previous: change.previous, next: change.next });
      return p;
    });
    res.json(ok(row));
  });
  r.put("/processes/:id/status", MANAGE, async (req, res) => {
    const { id } = params(req, idParam);
    const { status } = body(req, statusSchema);
    res.json(ok(await setStatus("process", id, status, req)));
  });

  // ----- Machine Category ------------------------------------------------
  const categorySchema = z.object({ code, name, description: text(255), processIds: z.array(z.uuid()).max(50).default([]) });
  r.get("/machine-categories", VIEW, async (req, res) => {
    const q = query(req, listSchema);
    const rows = await db.machineCategory.findMany({
      where: { ...(q.status ? { status: q.status } : {}), ...(q.q ? { OR: [{ code: { contains: q.q } }, { name: { contains: q.q } }] } : {}) },
      orderBy: { code: "asc" },
      include: {
        processes: { include: { process: { select: { id: true, code: true, name: true, status: true } } } },
        _count: { select: { machines: true, qualifications: true } },
      },
    });
    res.json(
      ok(
        rows.map(({ _count, processes, ...c }) => ({
          ...c,
          processes: processes.map((p) => p.process),
          machineCount: _count.machines,
          qualifiedOperatorCount: _count.qualifications,
        })),
      ),
    );
  });
  r.post("/machine-categories", MANAGE, async (req, res) => {
    const user = requireUser(req);
    const { processIds, ...input } = body(req, categorySchema);
    const row = await db.$transaction(async (tx) => {
      if (await tx.machineCategory.findUnique({ where: { code: input.code } })) throw errors.validation([{ path: "code", message: "This category code already exists" }]);
      await checkProcesses(tx, processIds);
      const c = await tx.machineCategory.create({
        data: { ...input, createdById: user.id, updatedById: user.id, processes: { create: processIds.map((processId) => ({ processId })) } },
      });
      await recordAudit(tx, req.ctx, { module: "planning", action: "MACHINE_CATEGORY_CREATED", entityType: "machine_category", entityId: c.id, recordRef: c.code, next: { ...input, processIds } });
      return c;
    });
    res.status(201).json(ok(row));
  });
  r.patch("/machine-categories/:id", MANAGE, async (req, res) => {
    const user = requireUser(req);
    const { id } = params(req, idParam);
    const { processIds, ...input } = body(req, categorySchema.omit({ code: true }).partial());
    const row = await db.$transaction(async (tx) => {
      const before = await tx.machineCategory.findUnique({ where: { id }, include: { processes: true } });
      if (!before) throw errors.notFound("Machine category");
      const change = diff(before, input);
      const prevIds = before.processes.map((p) => p.processId).sort();
      const procChanged = processIds !== undefined && prevIds.join() !== [...processIds].sort().join();
      if (!change.changed && !procChanged) return before;
      if (procChanged) {
        await checkProcesses(tx, processIds!);
        await tx.machineCategoryProcess.deleteMany({ where: { categoryId: id } });
        await tx.machineCategoryProcess.createMany({ data: processIds!.map((processId) => ({ categoryId: id, processId })) });
      }
      const c = await tx.machineCategory.update({ where: { id }, data: { ...input, updatedById: user.id } });
      await recordAudit(tx, req.ctx, {
        module: "planning", action: "MACHINE_CATEGORY_UPDATED", entityType: "machine_category", entityId: id, recordRef: c.code,
        previous: { ...change.previous, ...(procChanged ? { processIds: prevIds } : {}) },
        next: { ...change.next, ...(procChanged ? { processIds } : {}) },
      });
      return c;
    });
    res.json(ok(row));
  });
  r.put("/machine-categories/:id/status", MANAGE, async (req, res) => {
    const { id } = params(req, idParam);
    const { status } = body(req, statusSchema);
    res.json(ok(await setStatus("machine_category", id, status, req)));
  });

  /** Operators authorised for machines of this category. */
  r.get("/machine-categories/:id/operators", VIEW, async (req, res) => {
    const { id } = params(req, idParam);
    const quals = await db.operatorQualification.findMany({ where: { categoryId: id } });
    const users = await db.user.findMany({
      where: { id: { in: quals.map((q) => q.userId) } },
      select: { id: true, username: true, fullName: true, employeeNo: true, status: true },
      orderBy: { fullName: "asc" },
    });
    res.json(ok(users));
  });
  r.put("/machine-categories/:id/operators", MANAGE, async (req, res) => {
    const user = requireUser(req);
    const { id } = params(req, idParam);
    const { userIds } = body(req, z.object({ userIds: z.array(z.uuid()).max(500) }));
    await db.$transaction(async (tx) => {
      const cat = await tx.machineCategory.findUnique({ where: { id } });
      if (!cat) throw errors.notFound("Machine category");
      const found = await tx.user.count({ where: { id: { in: userIds } } });
      if (found !== new Set(userIds).size) throw errors.validation([{ path: "userIds", message: "One or more users do not exist" }]);
      const before = (await tx.operatorQualification.findMany({ where: { categoryId: id } })).map((q) => q.userId);
      const added = userIds.filter((u) => !before.includes(u));
      const removed = before.filter((u) => !userIds.includes(u));
      if (!added.length && !removed.length) return;
      await tx.operatorQualification.deleteMany({ where: { categoryId: id, userId: { in: removed } } });
      await tx.operatorQualification.createMany({ data: added.map((userId) => ({ userId, categoryId: id, createdById: user.id })) });
      await recordAudit(tx, req.ctx, {
        module: "planning", action: "OPERATOR_QUALIFICATIONS_CHANGED", entityType: "machine_category", entityId: id, recordRef: cat.code,
        previous: { removedUserIds: removed }, next: { addedUserIds: added },
      });
    });
    res.json(ok({ saved: true }));
  });

  // ----- Machine ---------------------------------------------------------
  const machineSchema = z.object({ code, name, categoryId: z.uuid({ message: "Choose a machine category" }), description: text(255), location: text(80), remarks: text(500) });
  r.get("/machines", VIEW, async (req, res) => {
    const q = query(req, listSchema.extend({ categoryId: z.uuid().optional() }));
    const rows = await db.machine.findMany({
      where: {
        ...(q.status ? { isActive: q.status === "ACTIVE" } : {}),
        ...(q.categoryId ? { categoryId: q.categoryId } : {}),
        ...(q.q ? { OR: [{ code: { contains: q.q } }, { name: { contains: q.q } }, { location: { contains: q.q } }] } : {}),
      },
      orderBy: { code: "asc" },
      include: { category: { select: { id: true, code: true, name: true } }, devices: { select: { id: true, name: true } } },
    });
    res.json(ok(rows));
  });
  r.post("/machines", MANAGE, async (req, res) => {
    const user = requireUser(req);
    const input = body(req, machineSchema);
    const row = await db.$transaction(async (tx) => {
      if (await tx.machine.findUnique({ where: { code: input.code } })) throw errors.validation([{ path: "code", message: "This machine code already exists" }]);
      await activeCategory(tx, input.categoryId);
      const m = await tx.machine.create({ data: { ...input, statusChangedAt: deps.now(), createdById: user.id, updatedById: user.id } });
      await recordAudit(tx, req.ctx, { module: "planning", action: "MACHINE_CREATED", entityType: "machine", entityId: m.id, recordRef: m.code, next: input });
      return m;
    });
    res.status(201).json(ok(row));
  });
  r.patch("/machines/:id", MANAGE, async (req, res) => {
    const user = requireUser(req);
    const { id } = params(req, idParam);
    const input = body(req, machineSchema.omit({ code: true }).partial());
    const row = await db.$transaction(async (tx) => {
      const before = await tx.machine.findUnique({ where: { id } });
      if (!before) throw errors.notFound("Machine");
      const change = diff(before, input);
      if (!change.changed) return before;
      if (input.categoryId && input.categoryId !== before.categoryId) {
        await activeCategory(tx, input.categoryId);
        const running = await tx.productionSession.count({ where: { machineId: id, status: "RUNNING" } });
        if (running) throw errors.rule("MACHINE_BUSY", "Check out the running session before changing the machine category.");
      }
      const m = await tx.machine.update({ where: { id }, data: { ...input, updatedById: user.id } });
      await recordAudit(tx, req.ctx, { module: "planning", action: "MACHINE_UPDATED", entityType: "machine", entityId: id, recordRef: m.code, previous: change.previous, next: change.next });
      return m;
    });
    res.json(ok(row));
  });
  r.put("/machines/:id/active", MANAGE, async (req, res) => {
    const user = requireUser(req);
    const { id } = params(req, idParam);
    const { isActive } = body(req, z.object({ isActive: z.boolean() }));
    const row = await db.$transaction(async (tx) => {
      const before = await tx.machine.findUnique({ where: { id } });
      if (!before) throw errors.notFound("Machine");
      if (before.isActive === isActive) return before;
      if (!isActive && (await tx.productionSession.count({ where: { machineId: id, status: "RUNNING" } }))) {
        throw errors.rule("MACHINE_BUSY", "Check out the running session before deactivating the machine.");
      }
      const m = await tx.machine.update({ where: { id }, data: { isActive, updatedById: user.id } });
      await recordAudit(tx, req.ctx, {
        module: "planning", action: isActive ? "MACHINE_ACTIVATED" : "MACHINE_DEACTIVATED", entityType: "machine", entityId: id, recordRef: m.code,
        previous: { isActive: before.isActive }, next: { isActive },
      });
      return m;
    });
    res.json(ok(row));
  });

  // ----- Handheld devices ------------------------------------------------
  r.get("/handheld-devices", requireAnyPermission("shopfloor.device.manage", "planning.master.view"), async (_req, res) => {
    const rows = await db.handheldDevice.findMany({ orderBy: { lastSeenAt: "desc" }, include: { assignedMachine: { select: { id: true, code: true, name: true } } } });
    const users = await db.user.findMany({ where: { id: { in: rows.map((d) => d.lastUserId).filter((x): x is string => !!x) } }, select: { id: true, fullName: true } });
    const nameOf = new Map(users.map((u) => [u.id, u.fullName]));
    res.json(ok(rows.map((d) => ({ ...d, lastUserName: d.lastUserId ? (nameOf.get(d.lastUserId) ?? null) : null }))));
  });
  r.patch("/handheld-devices/:deviceId", requirePermission("shopfloor.device.manage"), async (req, res) => {
    const user = requireUser(req);
    const { deviceId } = params(req, z.object({ deviceId: z.string().min(8).max(80) }));
    const input = body(req, z.object({ name: text(80).optional(), assignedMachineId: z.uuid().nullable().optional() }));
    const row = await db.$transaction(async (tx) => {
      const before = await tx.handheldDevice.findUnique({ where: { id: deviceId } });
      if (!before) throw errors.notFound("Handheld device");
      if (input.assignedMachineId) {
        const m = await tx.machine.findUnique({ where: { id: input.assignedMachineId } });
        if (!m || !m.isActive) throw errors.validation([{ path: "assignedMachineId", message: "Choose an active machine" }]);
      }
      const change = diff(before, input);
      if (!change.changed) return before;
      const d = await tx.handheldDevice.update({ where: { id: deviceId }, data: { ...input, updatedById: user.id } });
      await recordAudit(tx, req.ctx, { module: "shopfloor", action: "DEVICE_ASSIGNMENT_CHANGED", entityType: "handheld_device", entityId: deviceId, recordRef: d.name ?? deviceId, previous: change.previous, next: change.next });
      return d;
    });
    res.json(ok(row));
  });

  // ----- helpers -----------------------------------------------------------
  async function checkProcesses(tx: Parameters<Parameters<typeof db.$transaction>[0]>[0], ids: string[]) {
    const found = await tx.process.count({ where: { id: { in: ids }, status: "ACTIVE" } });
    if (found !== new Set(ids).size) throw errors.validation([{ path: "processIds", message: "Choose active processes only" }]);
  }
  async function activeCategory(tx: Parameters<Parameters<typeof db.$transaction>[0]>[0], id: string) {
    const c = await tx.machineCategory.findUnique({ where: { id } });
    if (!c || c.status !== "ACTIVE") throw errors.validation([{ path: "categoryId", message: "Choose an active machine category" }]);
  }
  async function setStatus(kind: "process" | "machine_category", id: string, status: "ACTIVE" | "INACTIVE", req: Parameters<Parameters<typeof r.get>[1]>[0]) {
    const user = requireUser(req);
    return db.$transaction(async (tx) => {
      const model = kind === "process" ? tx.process : tx.machineCategory;
      const before = await (model as typeof tx.process).findUnique({ where: { id } });
      if (!before) throw errors.notFound(kind === "process" ? "Process" : "Machine category");
      if (before.status === status) return before;
      const row = await (model as typeof tx.process).update({ where: { id }, data: { status, updatedById: user.id } });
      await recordAudit(tx, req.ctx, {
        module: "planning", action: `${kind.toUpperCase()}_${status === "ACTIVE" ? "ACTIVATED" : "DEACTIVATED"}`, entityType: kind, entityId: id, recordRef: before.code,
        previous: { status: before.status }, next: { status },
      });
      return row;
    });
  }

  return r;
}
