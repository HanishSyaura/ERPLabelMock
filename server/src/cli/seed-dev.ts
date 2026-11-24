import { loadConfig } from "../config/env";
import { syncReferenceData } from "../database/reference";
import { createPasswordHasher, passwordProblems } from "../lib/crypto";
import { createPrisma } from "../lib/prisma";
import { ROLE_TEMPLATES } from "../modules/access/catalog";

/**
 * DEVELOPMENT ONLY: reference data + one test account per role template
 * (username = dev.<role>, e.g. dev.planner). No business records.
 * Refused unless the database name ends in _dev, _test or _local.
 */
const config = loadConfig();
const dbName = new URL(config.DATABASE_URL).pathname.slice(1);
if (config.NODE_ENV === "production" || !/_(dev|test|local)$/.test(dbName)) {
  console.error(`Refusing to create test accounts in database "${dbName}" (only *_dev, *_test, *_local).`);
  process.exit(1);
}
const password = config.DEV_ACCOUNT_PASSWORD;
if (!password || passwordProblems(password).length) {
  console.error("Set DEV_ACCOUNT_PASSWORD in server/.env (10+ characters, letters and numbers).");
  process.exit(1);
}

const DEV_ACCOUNTS: Record<string, { username: string; fullName: string }> = {
  ADMINISTRATOR: { username: "dev.admin", fullName: "Dev Administrator" },
  PRODUCTION_PLANNER: { username: "dev.planner", fullName: "Dev Production Planner" },
  PRODUCTION_SUPERVISOR: { username: "dev.supervisor", fullName: "Dev Production Supervisor" },
  PRODUCTION_OPERATOR: { username: "dev.operator", fullName: "Dev Production Operator" },
  MATERIAL_CONTROLLER: { username: "dev.material", fullName: "Dev Material Controller" },
  QC_INSPECTOR: { username: "dev.qc", fullName: "Dev QC Inspector" },
  QC_SUPERVISOR: { username: "dev.qcsupervisor", fullName: "Dev QC Supervisor" },
  MANAGEMENT: { username: "dev.management", fullName: "Dev Management" },
};

const db = createPrisma(config.DATABASE_URL, 2);
try {
  await syncReferenceData(db);
  const passwordHash = await createPasswordHasher(config.PASSWORD_PEPPER).hash(password);
  for (const t of ROLE_TEMPLATES) {
    const acct = DEV_ACCOUNTS[t.code];
    if (!acct) continue;
    const role = await db.role.findUniqueOrThrow({ where: { code: t.code } });
    const user = await db.user.upsert({
      where: { username: acct.username },
      create: { username: acct.username, fullName: acct.fullName, passwordHash, roles: { create: [{ roleId: role.id }] } },
      update: { passwordHash, status: "ACTIVE", failedLogins: 0, lockedUntil: null },
    });
    await db.userRole.upsert({
      where: { userId_roleId: { userId: user.id, roleId: role.id } },
      create: { userId: user.id, roleId: role.id },
      update: {},
    });
    console.log(`  ${acct.username.padEnd(18)} ${t.name}`);
  }
  console.log("Dev accounts ready (password = DEV_ACCOUNT_PASSWORD).");
} finally {
  await db.$disconnect();
}
