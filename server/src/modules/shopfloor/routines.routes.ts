import { Router } from "express";
import { z } from "zod";
import type { Deps } from "../../deps";
import { errors } from "../../lib/errors";
import { body, idParam, ok, params } from "../../lib/http";
import type { Tx } from "../../lib/prisma";
import { requireAnyPermission, requirePermission } from "../../middleware/auth";
import { requireUser } from "../../middleware/context";
import { diff, recordAudit } from "../audit/audit.service";

/**
 * Routine Master (ordered process steps) and Production Routine Master
 * (which routine a Father Code follows by default). A Work Order copies its
 * route from here at creation, so later routine edits never change existing
 * Work Orders.
 */
const code = z
  .string()
  .trim()
  .min(1, "Enter the code")
  .max(30)
  .regex(/^[A-Za-z0-9._\-/]+$/, "Letters, numbers and . _ - / only")
  .transform((v) => v.toUpperCase());
const text = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .optional()
    .nullable()
    .transform((v) => (v ? v : null));

async function checkSteps(tx: Tx, processIds: string[]) {
  if (!processIds.length) throw errors.validation([{ path: "processIds", message: "Add at least one process" }]);
  const found = await tx.process.findMany({ where: { id: { in: processIds } } });
  const byId = new Map(found.map((p) => [p.id, p]));
  for (const id of processIds) {
    const p = byId.get(id);
    if (!p) throw errors.validation([{ path: "processIds", message: "Process not found" }]);
    if (p.status !== "ACTIVE") throw errors.validation([{ path: "processIds", message: `Process ${p.code} is inactive` }]);
  }
}

export function routineRoutes(deps: Deps) {
  const r = Router();
  const { db } = deps;
  const VIEW = requireAnyPermission("shopfloor.routine.view", "planning.jo.create");
  const MANAGE = requirePermission("shopfloor.routine.manage");

  const routineSchema = z.object({ code, name: z.string().trim().min(1, "Enter the name").max(80), description: text(255), processIds: z.array(z.uuid()).max(30) });

  r.get("/routines", VIEW, async (_req, res) => {
    const rows = await db.routine.findMany({
      orderBy: { code: "asc" },
      include: { steps: { orderBy: { seq: "asc" }, include: { process: { select: { id: true, code: true, name: true, status: true } } } }, _count: { select: { masterCards: true } } },
    });
    res.json(ok(rows.map(({ _count, steps, ...rt }) => ({ ...rt, steps: steps.map((s) => ({ seq: s.seq, process: s.process })), masterCardCount: _count.masterCards }))));
  });

  r.post("/routines", MANAGE, async (req, res) => {
    const user = requireUser(req);
    const { processIds, ...input } = body(req, routineSchema);
    const row = await db.$transaction(async (tx) => {
      if (await tx.routine.findUnique({ where: { code: input.code } })) throw errors.validation([{ path: "code", message: "This routine code already exists" }]);
      await checkSteps(tx, processIds);
      const rt = await tx.routine.create({
        data: { ...input, createdById: user.id, updatedById: user.id, steps: { create: processIds.map((processId, i) => ({ processId, seq: i + 1 })) } },
      });
      await recordAudit(tx, req.ctx, { module: "shopfloor", action: "ROUTINE_CREATED", entityType: "routine", entityId: rt.id, recordRef: rt.code, next: { ...input, processIds } });
      return rt;
    });
    res.status(201).json(ok(row));
  });

  r.patch("/routines/:id", MANAGE, async (req, res) => {
    const user = requireUser(req);
    const { id } = params(req, idParam);
    const { processIds, ...input } = body(req, routineSchema.omit({ code: true }).partial().extend({ status: z.enum(["ACTIVE", "INACTIVE"]).optional() }));
    const row = await db.$transaction(async (tx) => {
      const before = await tx.routine.findUnique({ where: { id }, include: { steps: { orderBy: { seq: "asc" } } } });
      if (!before) throw errors.notFound("Routine");
      const change = diff(before, input);
      const prev = before.steps.map((s) => s.processId);
      const stepsChanged = processIds !== undefined && prev.join() !== processIds.join();
      if (!change.changed && !stepsChanged) return before;
      if (stepsChanged) {
        await checkSteps(tx, processIds!);
        await tx.routineStep.deleteMany({ where: { routineId: id } });
        await tx.routineStep.createMany({ data: processIds!.map((processId, i) => ({ routineId: id, processId, seq: i + 1 })) });
      }
      const rt = await tx.routine.update({ where: { id }, data: { ...input, updatedById: user.id } });
      await recordAudit(tx, req.ctx, {
        module: "shopfloor", action: "ROUTINE_UPDATED", entityType: "routine", entityId: id, recordRef: rt.code,
        previous: { ...change.previous, ...(stepsChanged ? { processIds: prev } : {}) },
        next: { ...change.next, ...(stepsChanged ? { processIds } : {}) },
        remarks: stepsChanged ? "Existing Work Orders keep the route they were created with." : null,
      });
      return rt;
    });
    res.json(ok(row));
  });

  // Production Routine Master retired (2026-11-23): the routine is set on the
  // Master Card only; the production_routines table is kept for history.

  return r;
}
