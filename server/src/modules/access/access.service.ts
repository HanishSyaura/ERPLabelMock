import type { DbOrTx } from "../../lib/prisma";
import { ADMIN_ROLE_CODE, PERMISSIONS } from "./catalog";

const ALL_KEYS = PERMISSIONS.map((p) => p.key);

/** Effective permissions of a user: union over their active roles. */
export async function loadUserAccess(db: DbOrTx, userId: string) {
  const roles = await db.userRole.findMany({
    where: { userId, role: { isActive: true } },
    select: { role: { select: { code: true, permissions: { select: { permissionKey: true } } } } },
  });
  const roleCodes = roles.map((r) => r.role.code);
  const permissions = new Set<string>();
  for (const r of roles) {
    if (r.role.code === ADMIN_ROLE_CODE) ALL_KEYS.forEach((k) => permissions.add(k));
    else r.role.permissions.forEach((p) => permissions.add(p.permissionKey));
  }
  return { roleCodes, permissions };
}

/** Keys in `wanted` the actor does not hold - an actor never grants more than they have. */
export function missingForGrant(actorPermissions: Set<string>, wanted: Iterable<string>): string[] {
  return [...new Set(wanted)].filter((k) => !actorPermissions.has(k));
}

/** Permission keys granted by the given roles (Administrator = everything). */
export async function permissionsOfRoles(db: DbOrTx, roleIds: string[]) {
  if (roleIds.length === 0) return new Set<string>();
  const roles = await db.role.findMany({
    where: { id: { in: roleIds } },
    select: { code: true, permissions: { select: { permissionKey: true } } },
  });
  const keys = new Set<string>();
  for (const r of roles) {
    if (r.code === ADMIN_ROLE_CODE) ALL_KEYS.forEach((k) => keys.add(k));
    else r.permissions.forEach((p) => keys.add(p.permissionKey));
  }
  return keys;
}

/** Active users holding the active Administrator role. */
export async function countActiveAdmins(db: DbOrTx, excludeUserId?: string) {
  return db.user.count({
    where: {
      status: "ACTIVE",
      ...(excludeUserId ? { id: { not: excludeUserId } } : {}),
      roles: { some: { role: { code: ADMIN_ROLE_CODE, isActive: true } } },
    },
  });
}
