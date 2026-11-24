import { Router } from "express";
import { z } from "zod";
import type { Prisma } from "../../generated/prisma/client";
import type { Deps } from "../../deps";
import { passwordProblems } from "../../lib/crypto";
import { errors } from "../../lib/errors";
import { body, idParam, listQuery, ok, pageMeta, params, query } from "../../lib/http";
import type { Tx } from "../../lib/prisma";
import { requirePermission } from "../../middleware/auth";
import { requireUser, type AuthUser } from "../../middleware/context";
import { diff, recordAudit } from "../audit/audit.service";
import { countActiveAdmins, missingForGrant, permissionsOfRoles } from "../access/access.service";
import { ADMIN_ROLE_CODE } from "../access/catalog";

const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .optional()
    .nullable()
    .transform((v) => (v ? v : null));

const passwordField = z.string().max(128).superRefine((v, ctx) => {
  const problems = passwordProblems(v);
  if (problems.length) ctx.addIssue({ code: "custom", message: `Password needs ${problems.join(", ")}` });
});

const createSchema = z.object({
  username: z
    .string()
    .trim()
    .min(3, "At least 3 characters")
    .max(50)
    .regex(/^[A-Za-z0-9._-]+$/, "Letters, numbers, dot, dash and underscore only"),
  fullName: z.string().trim().min(1, "Enter the full name").max(120),
  email: optionalText(191).pipe(z.email("Enter a valid e-mail").nullable()),
  employeeNo: optionalText(30),
  password: passwordField,
  roleIds: z.array(z.uuid()).max(20).default([]),
  mustChangePassword: z.boolean().default(true),
});

const updateSchema = z.object({
  fullName: z.string().trim().min(1).max(120).optional(),
  email: optionalText(191).pipe(z.email("Enter a valid e-mail").nullable()).optional(),
  employeeNo: optionalText(30).optional(),
});

const statusSchema = z.object({ status: z.enum(["ACTIVE", "INACTIVE"]) });
const rolesSchema = z.object({ roleIds: z.array(z.uuid()).max(20) });
const resetSchema = z.object({ password: passwordField });

const listSchema = listQuery(["username", "fullName", "lastLoginAt", "createdAt"] as const).extend({
  status: z.enum(["ACTIVE", "INACTIVE"]).optional(),
  roleId: z.uuid().optional(),
});

const userSelect = {
  id: true,
  username: true,
  fullName: true,
  email: true,
  employeeNo: true,
  status: true,
  mustChangePassword: true,
  lockedUntil: true,
  lastLoginAt: true,
  createdAt: true,
  updatedAt: true,
  roles: { select: { role: { select: { id: true, code: true, name: true, isActive: true } } } },
} satisfies Prisma.UserSelect;

type UserRow = Prisma.UserGetPayload<{ select: typeof userSelect }>;
const view = (u: UserRow) => ({ ...u, roles: u.roles.map((r) => r.role) });

export function userRoutes(deps: Deps) {
  const r = Router();
  const { db, hasher } = deps;

  /** Role assignment rules shared by create and set-roles. */
  async function checkRoleGrant(tx: Tx, actor: AuthUser, roleIds: string[]) {
    const roles = await tx.role.findMany({ where: { id: { in: roleIds } }, select: { id: true, isActive: true, name: true } });
    if (roles.length !== new Set(roleIds).size) throw errors.validation([{ path: "roleIds", message: "One or more roles do not exist" }]);
    const inactive = roles.filter((x) => !x.isActive);
    if (inactive.length) {
      throw errors.validation([{ path: "roleIds", message: `Inactive role: ${inactive.map((x) => x.name).join(", ")}` }]);
    }
    const missing = missingForGrant(actor.permissions, await permissionsOfRoles(tx, roleIds));
    if (missing.length) {
      throw errors.forbidden(`You can't assign a role with permissions you don't hold (${missing.slice(0, 5).join(", ")}${missing.length > 5 ? ", ..." : ""}).`);
    }
  }

  /** Unique fields reported on the field itself (the DB constraint stays as the backstop). */
  async function checkUnique(tx: Tx, values: { username?: string; email?: string | null; employeeNo?: string | null }, exceptId?: string) {
    const checks = [
      ["username", values.username, "This username is already taken"],
      ["email", values.email, "Another user already has this e-mail"],
      ["employeeNo", values.employeeNo, "Another user already has this employee no."],
    ] as const;
    const issues = [];
    for (const [field, value, message] of checks) {
      if (!value) continue;
      const found = await tx.user.findFirst({ where: { [field]: value, ...(exceptId ? { id: { not: exceptId } } : {}) }, select: { id: true } });
      if (found) issues.push({ path: field, message });
    }
    if (issues.length) throw errors.validation(issues);
  }

  r.get("/", requirePermission("system.users.view"), async (req, res) => {
    const q = query(req, listSchema);
    const where: Prisma.UserWhereInput = {
      ...(q.status ? { status: q.status } : {}),
      ...(q.roleId ? { roles: { some: { roleId: q.roleId } } } : {}),
      ...(q.q
        ? { OR: [{ username: { contains: q.q } }, { fullName: { contains: q.q } }, { email: { contains: q.q } }, { employeeNo: { contains: q.q } }] }
        : {}),
    };
    const [total, rows] = await Promise.all([
      db.user.count({ where }),
      db.user.findMany({
        where,
        select: userSelect,
        orderBy: q.sort ? { [q.sort.field]: q.sort.dir } : { username: "asc" },
        skip: (q.page - 1) * q.pageSize,
        take: q.pageSize,
      }),
    ]);
    res.json(ok(rows.map(view), pageMeta(q.page, q.pageSize, total)));
  });

  r.get("/:id", requirePermission("system.users.view"), async (req, res) => {
    const { id } = params(req, idParam);
    const user = await db.user.findUnique({ where: { id }, select: userSelect });
    if (!user) throw errors.notFound("User");
    res.json(ok(view(user)));
  });

  r.post("/", requirePermission("system.users.manage"), async (req, res) => {
    const actor = requireUser(req);
    const input = body(req, createSchema);
    const passwordHash = await hasher.hash(input.password);
    const created = await db.$transaction(async (tx) => {
      await checkUnique(tx, input);
      await checkRoleGrant(tx, actor, input.roleIds);
      const user = await tx.user.create({
        data: {
          username: input.username,
          fullName: input.fullName,
          email: input.email,
          employeeNo: input.employeeNo,
          passwordHash,
          mustChangePassword: input.mustChangePassword,
          createdById: actor.id,
          updatedById: actor.id,
          roles: { create: input.roleIds.map((roleId) => ({ roleId })) },
        },
        select: userSelect,
      });
      await recordAudit(tx, req.ctx, {
        module: "system", action: "USER_CREATED", entityType: "user", entityId: user.id, recordRef: user.username,
        next: { username: user.username, fullName: user.fullName, email: user.email, employeeNo: user.employeeNo, roles: user.roles.map((x) => x.role.code) },
      });
      return user;
    });
    res.status(201).json(ok(view(created)));
  });

  r.patch("/:id", requirePermission("system.users.manage"), async (req, res) => {
    const actor = requireUser(req);
    const { id } = params(req, idParam);
    const input = body(req, updateSchema);
    const updated = await db.$transaction(async (tx) => {
      const before = await tx.user.findUnique({ where: { id } });
      if (!before) throw errors.notFound("User");
      const change = diff(before, input);
      if (!change.changed) return tx.user.findUniqueOrThrow({ where: { id }, select: userSelect });
      await checkUnique(tx, { email: input.email, employeeNo: input.employeeNo }, id);
      const user = await tx.user.update({ where: { id }, data: { ...input, updatedById: actor.id }, select: userSelect });
      await recordAudit(tx, req.ctx, {
        module: "system", action: "USER_UPDATED", entityType: "user", entityId: id, recordRef: user.username,
        previous: change.previous, next: change.next,
      });
      return user;
    });
    res.json(ok(view(updated)));
  });

  r.put("/:id/status", requirePermission("system.users.manage"), async (req, res) => {
    const actor = requireUser(req);
    const { id } = params(req, idParam);
    const { status } = body(req, statusSchema);
    const updated = await db.$transaction(async (tx) => {
      const before = await tx.user.findUnique({ where: { id }, select: userSelect });
      if (!before) throw errors.notFound("User");
      if (before.status === status) return before;
      if (status === "INACTIVE") {
        if (id === actor.id) throw errors.rule("SELF_DEACTIVATION", "You can't deactivate your own account.");
        const isAdmin = before.roles.some((x) => x.role.code === ADMIN_ROLE_CODE);
        if (isAdmin && (await countActiveAdmins(tx, id)) === 0) {
          throw errors.rule("LAST_ADMIN", "This is the last active administrator. Make another user an administrator first.");
        }
      }
      const user = await tx.user.update({
        where: { id },
        data: { status, updatedById: actor.id, ...(status === "ACTIVE" ? { failedLogins: 0, lockedUntil: null } : {}) },
        select: userSelect,
      });
      if (status === "INACTIVE") await tx.session.updateMany({ where: { userId: id, revokedAt: null }, data: { revokedAt: deps.now() } });
      await recordAudit(tx, req.ctx, {
        module: "system", action: status === "ACTIVE" ? "USER_ACTIVATED" : "USER_DEACTIVATED", entityType: "user",
        entityId: id, recordRef: user.username, previous: { status: before.status }, next: { status },
      });
      return user;
    });
    res.json(ok(view(updated)));
  });

  r.put("/:id/roles", requirePermission("system.users.manage"), async (req, res) => {
    const actor = requireUser(req);
    const { id } = params(req, idParam);
    const { roleIds } = body(req, rolesSchema);
    const updated = await db.$transaction(async (tx) => {
      const before = await tx.user.findUnique({ where: { id }, select: userSelect });
      if (!before) throw errors.notFound("User");
      const current = new Set(before.roles.map((x) => x.role.id));
      const added = roleIds.filter((x) => !current.has(x));
      const removed = [...current].filter((x) => !roleIds.includes(x));
      if (!added.length && !removed.length) return before;
      // Only newly added roles are checked against the actor's own grants.
      await checkRoleGrant(tx, actor, added);
      const adminRole = await tx.role.findUnique({ where: { code: ADMIN_ROLE_CODE }, select: { id: true } });
      if (adminRole && removed.includes(adminRole.id)) {
        if (id === actor.id) throw errors.rule("SELF_DEMOTION", "You can't remove your own Administrator role.");
        if (before.status === "ACTIVE" && (await countActiveAdmins(tx, id)) === 0) {
          throw errors.rule("LAST_ADMIN", "This is the last active administrator. Make another user an administrator first.");
        }
      }
      await tx.userRole.deleteMany({ where: { userId: id, roleId: { in: removed } } });
      if (added.length) await tx.userRole.createMany({ data: added.map((roleId) => ({ userId: id, roleId })) });
      await tx.user.update({ where: { id }, data: { updatedById: actor.id } });
      const user = await tx.user.findUniqueOrThrow({ where: { id }, select: userSelect });
      await recordAudit(tx, req.ctx, {
        module: "system", action: "USER_ROLES_CHANGED", entityType: "user", entityId: id, recordRef: user.username,
        previous: { roles: before.roles.map((x) => x.role.code) }, next: { roles: user.roles.map((x) => x.role.code) },
      });
      return user;
    });
    res.json(ok(view(updated)));
  });

  r.post("/:id/reset-password", requirePermission("system.users.manage"), async (req, res) => {
    const { id } = params(req, idParam);
    const { password } = body(req, resetSchema);
    const actor = requireUser(req);
    const passwordHash = await hasher.hash(password);
    await db.$transaction(async (tx) => {
      const user = await tx.user.findUnique({ where: { id } });
      if (!user) throw errors.notFound("User");
      await tx.user.update({
        where: { id },
        data: { passwordHash, mustChangePassword: true, failedLogins: 0, lockedUntil: null, updatedById: actor.id },
      });
      await tx.session.updateMany({ where: { userId: id, revokedAt: null }, data: { revokedAt: deps.now() } });
      await recordAudit(tx, req.ctx, {
        module: "system", action: "USER_PASSWORD_RESET", entityType: "user", entityId: id, recordRef: user.username,
        remarks: "Password reset by administrator; user must change it at next sign-in.",
      });
    });
    res.json(ok({ reset: true }));
  });

  return r;
}
