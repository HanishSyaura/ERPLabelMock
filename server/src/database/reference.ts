import type { Db } from "../lib/prisma";
import { NUMBER_SEQUENCES } from "../lib/numbering";
import { ADMIN_ROLE_CODE, PERMISSIONS, ROLE_TEMPLATES } from "../modules/access/catalog";

/**
 * Idempotent reference data, safe in every environment:
 * - permission catalog mirrored into `permissions` (removed keys deactivated),
 * - suggested role templates created when missing (grants applied once, at
 *   creation; afterwards administrators own them). Brand-new catalog keys are
 *   granted to existing system roles whose template lists them.
 * - document number sequences inserted when missing.
 */
export async function syncReferenceData(db: Db) {
  const summary = { permissions: 0, rolesCreated: 0, grantsAdded: 0, sequences: 0 };
  await db.$transaction(async (tx) => {
    const existing = new Set((await tx.permission.findMany({ select: { key: true } })).map((p) => p.key));
    const newKeys = new Set<string>();
    for (const [i, p] of PERMISSIONS.entries()) {
      if (!existing.has(p.key)) newKeys.add(p.key);
      await tx.permission.upsert({
        where: { key: p.key },
        create: { key: p.key, module: p.module, area: p.area, description: p.description, sortOrder: i },
        update: { module: p.module, area: p.area, description: p.description, sortOrder: i, isActive: true },
      });
      summary.permissions++;
    }
    const catalogKeys = new Set(PERMISSIONS.map((p) => p.key));
    await tx.permission.updateMany({ where: { key: { notIn: [...catalogKeys] } }, data: { isActive: false } });

    for (const t of ROLE_TEMPLATES) {
      const role = await tx.role.findUnique({ where: { code: t.code } });
      // Administrator's grants are implicit (all keys); no rows needed.
      const grants = t.code === ADMIN_ROLE_CODE ? [] : t.permissions;
      if (!role) {
        await tx.role.create({
          data: {
            code: t.code, name: t.name, description: t.description, isSystem: true,
            permissions: { create: grants.map((permissionKey) => ({ permissionKey })) },
          },
        });
        summary.rolesCreated++;
      } else if (role.isSystem) {
        const fresh = grants.filter((k) => newKeys.has(k));
        if (fresh.length) {
          await tx.rolePermission.createMany({ data: fresh.map((permissionKey) => ({ roleId: role.id, permissionKey })), skipDuplicates: true });
          summary.grantsAdded += fresh.length;
        }
      }
    }

    for (const s of NUMBER_SEQUENCES) {
      const found = await tx.numberSequence.findUnique({ where: { key: s.key } });
      if (!found) {
        await tx.numberSequence.create({ data: { key: s.key, prefix: s.prefix, padding: s.padding, yearly: s.yearly } });
        summary.sequences++;
      }
    }
  });
  return summary;
}
