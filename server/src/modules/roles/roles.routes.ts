import { Router } from "express";
import { z } from "zod";
import type { Deps } from "../../deps";
import { errors } from "../../lib/errors";
import { body, idParam, ok, params } from "../../lib/http";
import { requirePermission } from "../../middleware/auth";
import { requireUser } from "../../middleware/context";
import { recordAudit } from "../audit/audit.service";
import { missingForGrant } from "../access/access.service";
import { ADMIN_ROLE_CODE, PERMISSION_KEYS, PERMISSIONS } from "../access/catalog";

const permissionList = z
  .array(z.string())
  .max(PERMISSIONS.length)
  .superRefine((keys, ctx) => {
    const unknown = keys.filter((k) => !PERMISSION_KEYS.has(k));
    if (unknown.length) ctx.addIssue({ code: "custom", message: `Unknown permission: ${unknown.join(", ")}` });
  })
  .transform((keys) => [...new Set(keys)].sort());

const createSchema = z.object({
  code: z
    .string()
    .trim()
    .min(2)
    .max(40)
    .regex(/^[A-Z0-9_]+$/, "Upper-case letters, numbers and underscore only"),
  name: z.string().trim().min(2).max(80),
  description: z.string().trim().max(255).optional().nullable(),
  permissions: permissionList.default([]),
});

const updateSchema = z.object({
  name: z.string().trim().min(2).max(80).optional(),
  description: z.string().trim().max(255).optional().nullable(),
  isActive: z.boolean().optional(),
  permissions: permissionList.optional(),
});

export function roleRoutes(deps: Deps) {
  const r = Router();
  const { db } = deps;

  const load = async (id: string) => {
    const role = await db.role.findUnique({
      where: { id },
      include: { permissions: { select: { permissionKey: true } }, _count: { select: { users: true } } },
    });
    if (!role) throw errors.notFound("Role");
    const { permissions, _count, ...rest } = role;
    return {
      ...rest,
      userCount: _count.users,
      permissions: role.code === ADMIN_ROLE_CODE ? PERMISSIONS.map((p) => p.key) : permissions.map((p) => p.permissionKey).sort(),
    };
  };

  /** Permission catalog, grouped for the role editor. */
  r.get("/catalog", requirePermission("system.roles.view"), (_req, res) => {
    res.json(ok(PERMISSIONS));
  });

  r.get("/", requirePermission("system.roles.view"), async (_req, res) => {
    const roles = await db.role.findMany({
      orderBy: [{ isSystem: "desc" }, { name: "asc" }],
      include: { _count: { select: { users: true, permissions: true } } },
    });
    res.json(
      ok(
        roles.map(({ _count, ...role }) => ({
          ...role,
          userCount: _count.users,
          permissionCount: role.code === ADMIN_ROLE_CODE ? PERMISSIONS.length : _count.permissions,
        })),
      ),
    );
  });

  r.get("/:id", requirePermission("system.roles.view"), async (req, res) => {
    const { id } = params(req, idParam);
    res.json(ok(await load(id)));
  });

  r.post("/", requirePermission("system.roles.manage"), async (req, res) => {
    const actor = requireUser(req);
    const input = body(req, createSchema);
    const missing = missingForGrant(actor.permissions, input.permissions);
    if (missing.length) throw errors.forbidden(`You can't grant permissions you don't hold: ${missing.join(", ")}`);
    const role = await db.$transaction(async (tx) => {
      const created = await tx.role.create({
        data: {
          code: input.code,
          name: input.name,
          description: input.description ?? null,
          createdById: actor.id,
          updatedById: actor.id,
          permissions: { create: input.permissions.map((permissionKey) => ({ permissionKey })) },
        },
      });
      await recordAudit(tx, req.ctx, {
        module: "system", action: "ROLE_CREATED", entityType: "role", entityId: created.id, recordRef: created.code,
        next: { name: created.name, permissions: input.permissions },
      });
      return created;
    });
    res.status(201).json(ok(await load(role.id)));
  });

  r.patch("/:id", requirePermission("system.roles.manage"), async (req, res) => {
    const actor = requireUser(req);
    const { id } = params(req, idParam);
    const input = body(req, updateSchema);
    await db.$transaction(async (tx) => {
      const before = await tx.role.findUnique({ where: { id }, include: { permissions: true } });
      if (!before) throw errors.notFound("Role");
      const isAdminRole = before.code === ADMIN_ROLE_CODE;
      if (isAdminRole && input.permissions) {
        throw errors.rule("ADMIN_ROLE_FIXED", "The Administrator role always holds every permission.");
      }
      if (isAdminRole && input.isActive === false) {
        throw errors.rule("ADMIN_ROLE_FIXED", "The Administrator role can't be deactivated.");
      }
      const previousKeys = before.permissions.map((p) => p.permissionKey).sort();
      let added: string[] = [];
      let removed: string[] = [];
      if (input.permissions) {
        added = input.permissions.filter((k) => !previousKeys.includes(k));
        removed = previousKeys.filter((k) => !input.permissions!.includes(k));
        const missing = missingForGrant(actor.permissions, added);
        if (missing.length) throw errors.forbidden(`You can't grant permissions you don't hold: ${missing.join(", ")}`);
        if (removed.length) await tx.rolePermission.deleteMany({ where: { roleId: id, permissionKey: { in: removed } } });
        if (added.length) await tx.rolePermission.createMany({ data: added.map((permissionKey) => ({ roleId: id, permissionKey })) });
      }
      const data = {
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.description !== undefined ? { description: input.description } : {}),
        ...(input.isActive !== undefined ? { isActive: input.isActive } : {}),
      };
      const fieldChanges = Object.entries(data).filter(([k, v]) => (before as Record<string, unknown>)[k] !== v);
      if (!fieldChanges.length && !added.length && !removed.length) return;
      await tx.role.update({ where: { id }, data: { ...data, updatedById: actor.id } });
      await recordAudit(tx, req.ctx, {
        module: "system", action: "ROLE_UPDATED", entityType: "role", entityId: id, recordRef: before.code,
        previous: { ...Object.fromEntries(fieldChanges.map(([k]) => [k, (before as Record<string, unknown>)[k]])), ...(removed.length ? { removedPermissions: removed } : {}) },
        next: { ...Object.fromEntries(fieldChanges), ...(added.length ? { addedPermissions: added } : {}) },
      });
    });
    res.json(ok(await load(id)));
  });

  return r;
}
