import { randomBytes } from "node:crypto";
import { parseArgs } from "node:util";
import { loadConfig } from "../config/env";
import { syncReferenceData } from "../database/reference";
import { createPasswordHasher } from "../lib/crypto";
import { createPrisma } from "../lib/prisma";
import { recordAudit } from "../modules/audit/audit.service";
import { ADMIN_ROLE_CODE } from "../modules/access/catalog";

/**
 * Creates the FIRST administrator only (refuses when any user exists).
 *   npm --workspace server run bootstrap:admin -- --username admin --name "System Administrator"
 * Prints a one-time password; the admin must change it at first sign-in.
 */
const { values } = parseArgs({
  options: { username: { type: "string" }, name: { type: "string" }, email: { type: "string" } },
});
if (!values.username || !values.name) {
  console.error('Usage: bootstrap:admin -- --username <name> --name "<full name>" [--email <e-mail>]');
  process.exit(1);
}

const config = loadConfig();
const db = createPrisma(config.DATABASE_URL, 2);
try {
  await syncReferenceData(db);
  if ((await db.user.count()) > 0) {
    console.error("Users already exist - bootstrap is only for the first administrator. Use the Users page instead.");
    process.exit(1);
  }
  const role = await db.role.findUniqueOrThrow({ where: { code: ADMIN_ROLE_CODE } });
  const password = `${randomBytes(9).toString("base64url")}9a`;
  const passwordHash = await createPasswordHasher(config.PASSWORD_PEPPER).hash(password);
  const user = await db.$transaction(async (tx) => {
    const created = await tx.user.create({
      data: {
        username: values.username!, fullName: values.name!, email: values.email ?? null, passwordHash,
        mustChangePassword: true, roles: { create: [{ roleId: role.id }] },
      },
    });
    await recordAudit(tx, null, {
      module: "system", action: "ADMIN_BOOTSTRAPPED", entityType: "user", entityId: created.id, recordRef: created.username,
      remarks: "First administrator created from the command line.",
    });
    return created;
  });
  console.log(`Administrator "${user.username}" created.`);
  console.log(`One-time password: ${password}`);
  console.log("You will be asked to change it at first sign-in. This password is not shown again.");
} finally {
  await db.$disconnect();
}
