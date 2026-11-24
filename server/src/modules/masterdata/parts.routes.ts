import { Router } from "express";
import { z } from "zod";
import type { Deps } from "../../deps";
import { errors } from "../../lib/errors";
import { body, idParam, ok, params, query } from "../../lib/http";
import { requirePermission } from "../../middleware/auth";
import { requireUser } from "../../middleware/context";
import { diff, recordAudit } from "../audit/audit.service";
import { code, statusSchema, text } from "./fields";

/**
 * Part Category Master and Part Group Master (mounted at /parts).
 * Category = what the part is (its kind decides the spec fields a part shows);
 * group = a finer grouping inside one category. Codes are immutable; both are
 * deactivated, never deleted. Inactive ones can't be chosen for a part.
 */
export const PART_KINDS = ["LABEL_STOCK", "FILM", "PAPER", "LAMINATE", "ADHESIVE", "INK", "VARNISH", "FOIL", "RIBBON", "CORE", "PLATE", "PACKAGING", "OTHER"] as const;

const categorySchema = z.object({
  code: code(20, "category code"),
  name: z.string().trim().min(1, "Enter the name").max(60),
  kind: z.enum(PART_KINDS, { message: "Choose the kind" }),
  description: text(255),
});
const groupSchema = z.object({
  code: code(20, "group code"),
  name: z.string().trim().min(1, "Enter the name").max(60),
  categoryId: z.uuid({ message: "Choose a category" }),
  description: text(255),
});

export function partTaxonomyRoutes(deps: Deps) {
  const r = Router();
  const { db } = deps;
  const VIEW = requirePermission("bom.view");
  const MANAGE = requirePermission("bom.material.manage");

  // ----- Part Category ------------------------------------------------------
  r.get("/categories", VIEW, async (req, res) => {
    const f = query(req, z.object({ status: z.enum(["ACTIVE", "INACTIVE"]).optional() }));
    const rows = await db.partCategory.findMany({
      where: f.status ? { status: f.status } : {},
      orderBy: { name: "asc" },
      include: { _count: { select: { groups: true, parts: true } } },
    });
    res.json(ok(rows.map(({ _count, ...c }) => ({ ...c, groupCount: _count.groups, partCount: _count.parts }))));
  });

  r.post("/categories", MANAGE, async (req, res) => {
    const user = requireUser(req);
    const input = body(req, categorySchema);
    const row = await db.$transaction(async (tx) => {
      if (await tx.partCategory.findUnique({ where: { code: input.code } })) throw errors.validation([{ path: "code", message: "This category code already exists" }]);
      if (await tx.partCategory.findUnique({ where: { name: input.name } })) throw errors.validation([{ path: "name", message: "A category with this name already exists" }]);
      const c = await tx.partCategory.create({ data: { ...input, createdById: user.id, updatedById: user.id } });
      await recordAudit(tx, req.ctx, { module: "masterdata", action: "PART_CATEGORY_CREATED", entityType: "part_category", entityId: c.id, recordRef: c.code, next: input });
      return c;
    });
    res.status(201).json(ok(row));
  });

  r.patch("/categories/:id", MANAGE, async (req, res) => {
    const user = requireUser(req);
    const { id } = params(req, idParam);
    const input = body(req, categorySchema.omit({ code: true }).partial());
    const row = await db.$transaction(async (tx) => {
      const before = await tx.partCategory.findUnique({ where: { id } });
      if (!before) throw errors.notFound("Part category");
      if (input.name && input.name !== before.name && (await tx.partCategory.findUnique({ where: { name: input.name } }))) {
        throw errors.validation([{ path: "name", message: "A category with this name already exists" }]);
      }
      const change = diff(before, input);
      if (!change.changed) return before;
      const c = await tx.partCategory.update({ where: { id }, data: { ...input, updatedById: user.id } });
      await recordAudit(tx, req.ctx, {
        module: "masterdata", action: "PART_CATEGORY_UPDATED", entityType: "part_category", entityId: id, recordRef: c.code, previous: change.previous, next: change.next,
        remarks: change.next.kind ? "Kind changed: parts in this category now show the fields of the new kind; values already saved are kept." : null,
      });
      return c;
    });
    res.json(ok(row));
  });

  r.put("/categories/:id/status", MANAGE, async (req, res) => {
    const user = requireUser(req);
    const { id } = params(req, idParam);
    const { status } = body(req, statusSchema);
    const row = await db.$transaction(async (tx) => {
      const before = await tx.partCategory.findUnique({ where: { id } });
      if (!before) throw errors.notFound("Part category");
      if (before.status === status) return before;
      const c = await tx.partCategory.update({ where: { id }, data: { status, updatedById: user.id } });
      await recordAudit(tx, req.ctx, {
        module: "masterdata", action: status === "ACTIVE" ? "PART_CATEGORY_ACTIVATED" : "PART_CATEGORY_DEACTIVATED", entityType: "part_category", entityId: id, recordRef: c.code,
        previous: { status: before.status }, next: { status },
      });
      return c;
    });
    res.json(ok(row));
  });

  // ----- Part Group ---------------------------------------------------------
  r.get("/groups", VIEW, async (req, res) => {
    const f = query(req, z.object({ categoryId: z.uuid().optional(), status: z.enum(["ACTIVE", "INACTIVE"]).optional() }));
    const rows = await db.partGroup.findMany({
      where: { ...(f.categoryId ? { categoryId: f.categoryId } : {}), ...(f.status ? { status: f.status } : {}) },
      orderBy: [{ category: { name: "asc" } }, { name: "asc" }],
      include: { category: { select: { id: true, code: true, name: true, kind: true, status: true } }, _count: { select: { parts: true } } },
    });
    res.json(ok(rows.map(({ _count, ...g }) => ({ ...g, partCount: _count.parts }))));
  });

  r.post("/groups", MANAGE, async (req, res) => {
    const user = requireUser(req);
    const input = body(req, groupSchema);
    const row = await db.$transaction(async (tx) => {
      if (await tx.partGroup.findUnique({ where: { code: input.code } })) throw errors.validation([{ path: "code", message: "This group code already exists" }]);
      const cat = await tx.partCategory.findUnique({ where: { id: input.categoryId } });
      if (!cat || cat.status !== "ACTIVE") throw errors.validation([{ path: "categoryId", message: "Choose an active category" }]);
      if (await tx.partGroup.findUnique({ where: { categoryId_name: { categoryId: input.categoryId, name: input.name } } })) {
        throw errors.validation([{ path: "name", message: `${cat.name} already has a group with this name` }]);
      }
      const g = await tx.partGroup.create({ data: { ...input, createdById: user.id, updatedById: user.id } });
      await recordAudit(tx, req.ctx, { module: "masterdata", action: "PART_GROUP_CREATED", entityType: "part_group", entityId: g.id, recordRef: g.code, next: { ...input, category: cat.code } });
      return g;
    });
    res.status(201).json(ok(row));
  });

  r.patch("/groups/:id", MANAGE, async (req, res) => {
    const user = requireUser(req);
    const { id } = params(req, idParam);
    const input = body(req, groupSchema.omit({ code: true }).partial());
    const row = await db.$transaction(async (tx) => {
      const before = await tx.partGroup.findUnique({ where: { id }, include: { _count: { select: { parts: true } } } });
      if (!before) throw errors.notFound("Part group");
      const { _count, ...current } = before;
      const categoryId = input.categoryId ?? current.categoryId;
      if (input.categoryId && input.categoryId !== current.categoryId) {
        if (_count.parts > 0) throw errors.validation([{ path: "categoryId", message: `${_count.parts} part(s) use this group. Move them first, or create a new group in the other category.` }]);
        const cat = await tx.partCategory.findUnique({ where: { id: input.categoryId } });
        if (!cat || cat.status !== "ACTIVE") throw errors.validation([{ path: "categoryId", message: "Choose an active category" }]);
      }
      const name = input.name ?? current.name;
      if (name !== current.name || categoryId !== current.categoryId) {
        const clash = await tx.partGroup.findUnique({ where: { categoryId_name: { categoryId, name } } });
        if (clash && clash.id !== id) throw errors.validation([{ path: "name", message: "That category already has a group with this name" }]);
      }
      const change = diff(current, input);
      if (!change.changed) return current;
      const g = await tx.partGroup.update({ where: { id }, data: { ...input, updatedById: user.id } });
      await recordAudit(tx, req.ctx, { module: "masterdata", action: "PART_GROUP_UPDATED", entityType: "part_group", entityId: id, recordRef: g.code, previous: change.previous, next: change.next });
      return g;
    });
    res.json(ok(row));
  });

  r.put("/groups/:id/status", MANAGE, async (req, res) => {
    const user = requireUser(req);
    const { id } = params(req, idParam);
    const { status } = body(req, statusSchema);
    const row = await db.$transaction(async (tx) => {
      const before = await tx.partGroup.findUnique({ where: { id } });
      if (!before) throw errors.notFound("Part group");
      if (before.status === status) return before;
      const g = await tx.partGroup.update({ where: { id }, data: { status, updatedById: user.id } });
      await recordAudit(tx, req.ctx, {
        module: "masterdata", action: status === "ACTIVE" ? "PART_GROUP_ACTIVATED" : "PART_GROUP_DEACTIVATED", entityType: "part_group", entityId: id, recordRef: g.code,
        previous: { status: before.status }, next: { status },
      });
      return g;
    });
    res.json(ok(row));
  });

  return r;
}
