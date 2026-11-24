import { Router } from "express";
import { z } from "zod";
import type { Prisma } from "../../generated/prisma/client";
import type { Deps } from "../../deps";
import { ok, pageMeta, query } from "../../lib/http";
import { requirePermission } from "../../middleware/auth";

const listSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(50),
  q: z.string().trim().max(100).optional(),
  module: z.string().max(30).optional(),
  action: z.string().max(60).optional(),
  userId: z.uuid().optional(),
  entityType: z.string().max(60).optional(),
  entityId: z.string().max(64).optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
  result: z.enum(["SUCCESS", "DENIED", "FAILED"]).optional(),
});

/** Read-only. There is no route that edits or deletes audit rows. */
export function auditRoutes(deps: Deps) {
  const r = Router();

  r.get("/", requirePermission("system.audit.view"), async (req, res) => {
    const q = query(req, listSchema);
    const where: Prisma.AuditLogWhereInput = {
      ...(q.module ? { module: q.module } : {}),
      ...(q.action ? { action: q.action } : {}),
      ...(q.userId ? { userId: q.userId } : {}),
      ...(q.entityType ? { entityType: q.entityType } : {}),
      ...(q.entityId ? { entityId: q.entityId } : {}),
      ...(q.result ? { result: q.result } : {}),
      ...(q.from || q.to ? { occurredAt: { ...(q.from ? { gte: q.from } : {}), ...(q.to ? { lte: q.to } : {}) } } : {}),
      ...(q.q ? { OR: [{ recordRef: { contains: q.q } }, { userName: { contains: q.q } }, { remarks: { contains: q.q } }] } : {}),
    };
    const [total, rows] = await Promise.all([
      deps.db.auditLog.count({ where }),
      deps.db.auditLog.findMany({ where, orderBy: { id: "desc" }, skip: (q.page - 1) * q.pageSize, take: q.pageSize }),
    ]);
    res.json(ok(rows.map((row) => ({ ...row, id: row.id.toString() })), pageMeta(q.page, q.pageSize, total)));
  });

  /** Distinct values for the filter dropdowns. */
  r.get("/facets", requirePermission("system.audit.view"), async (_req, res) => {
    const [modules, actions] = await Promise.all([
      deps.db.auditLog.findMany({ distinct: ["module"], select: { module: true }, orderBy: { module: "asc" } }),
      deps.db.auditLog.findMany({ distinct: ["action"], select: { action: true }, orderBy: { action: "asc" } }),
    ]);
    res.json(ok({ modules: modules.map((m) => m.module), actions: actions.map((a) => a.action) }));
  });

  return r;
}
