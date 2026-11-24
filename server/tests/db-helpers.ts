import "dotenv/config";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import request from "supertest";
import { createFileStore } from "../src/lib/file-store";
import { afterAll, beforeEach } from "vitest";
import { API_BASE_PATH, createApp } from "../src/app";
import { loadConfig } from "../src/config/env";
import { syncReferenceData } from "../src/database/reference";
import { createPasswordHasher } from "../src/lib/crypto";
import { createLogger } from "../src/lib/logger";
import { createPrisma } from "../src/lib/prisma";
import { ADMIN_ROLE_CODE } from "../src/modules/access/catalog";

export const TEST_PASSWORD = "Test-password-123";

/** Tables wiped before each test (TRUNCATE bypasses the audit DELETE trigger). */
const TABLES = [
  "shipping_labels",
  "label_templates",
  "document_templates",
  "document_settings",
  "qc_defects",
  "qc_inspections",
  "inspection_templates",
  "defect_codes",
  "shopfloor_transactions",
  "material_transactions",
  "mrs_lines",
  "material_requisitions",
  "reason_codes",
  "schedule_entries",
  "production_outputs",
  "machine_changes",
  "machine_breakdowns",
  "production_sessions",
  "work_order_processes",
  "work_orders",
  "production_job_orders",
  "master_card_revisions",
  "products",
  "production_routines",
  "routine_steps",
  "routines",
  "handheld_devices",
  "operator_qualifications",
  "machines",
  "machine_category_processes",
  "machine_categories",
  "processes",
  "bom_component_lines",
  "bom_component_revisions",
  "bom_son_codes",
  "bom_artwork_revisions",
  "boms",
  "materials",
  "part_groups",
  "part_categories",
  "die_cuts",
  "stored_files",
  "sessions",
  "user_roles",
  "role_permissions",
  "audit_log",
  "users",
  "roles",
  "permissions",
  "number_sequences",
];

/** Controllable clock. */
export function createClock(start = new Date("2026-11-10T08:00:00Z")) {
  let t = start.getTime();
  return {
    now: () => new Date(t),
    advance: (ms: number) => {
      t += ms;
    },
  };
}

export function setupDb() {
  const config = loadConfig({ ...process.env, NODE_ENV: "test", DATABASE_URL: process.env.TEST_DATABASE_URL, LOG_LEVEL: "silent" });
  const db = createPrisma(config.DATABASE_URL, 4);
  const clock = createClock();
  const hasher = createPasswordHasher(config.PASSWORD_PEPPER);
  const uploadDir = mkdtempSync(path.join(tmpdir(), "label-mes-test-"));
  const files = createFileStore(uploadDir);
  const app = createApp({ config: { ...config, ARTWORK_MAX_MB: 2, LOGIN_IP_MAX_ATTEMPTS: 100_000 }, db, hasher, files, logger: createLogger("silent", false), now: clock.now });

  beforeEach(async () => {
    // One connection: FOREIGN_KEY_CHECKS is a session variable.
    // TRUNCATE is slow on MySQL (it recreates the table): only wipe tables holding rows.
    const counts = await db.$queryRawUnsafe<{ t: string; n: bigint | number }[]>(
      TABLES.map((t) => `SELECT '${t}' AS t, EXISTS(SELECT 1 FROM \`${t}\`) AS n`).join(" UNION ALL "),
    );
    const dirty = counts.filter((c) => Number(c.n) > 0).map((c) => c.t);
    await db.$transaction(
      async (tx) => {
        await tx.$executeRawUnsafe("SET FOREIGN_KEY_CHECKS = 0");
        for (const t of dirty) await tx.$executeRawUnsafe(`TRUNCATE TABLE \`${t}\``);
        await tx.$executeRawUnsafe("SET FOREIGN_KEY_CHECKS = 1");
      },
      { timeout: 60_000 },
    );
    await syncReferenceData(db);
  });
  afterAll(async () => {
    await db.$disconnect();
    rmSync(uploadDir, { recursive: true, force: true });
  });

  const roleId = async (code: string) => (await db.role.findUniqueOrThrow({ where: { code } })).id;

  async function createUser(username: string, roleCodes: string[] = [], extra: { mustChangePassword?: boolean } = {}) {
    const passwordHash = await hasher.hash(TEST_PASSWORD);
    const ids = await Promise.all(roleCodes.map(roleId));
    return db.user.create({
      data: {
        username,
        fullName: `User ${username}`,
        passwordHash,
        mustChangePassword: extra.mustChangePassword ?? false,
        roles: { create: ids.map((id) => ({ roleId: id })) },
      },
    });
  }
  const createAdmin = (username = "admin") => createUser(username, [ADMIN_ROLE_CODE]);

  /** Signs in and returns a client that sends the cookie + CSRF token. */
  async function login(username: string, password = TEST_PASSWORD) {
    const res = await request(app).post(`${API_BASE_PATH}/auth/login`).send({ username, password });
    if (res.status !== 200) throw new Error(`login ${username} failed: ${res.status} ${JSON.stringify(res.body)}`);
    const cookie = res.headers["set-cookie"] as unknown as string[];
    const csrf = res.body.data.csrfToken as string;
    return client(cookie, csrf);
  }

  function client(cookie?: string[], csrf?: string) {
    const withAuth = (r: request.Test) => {
      if (cookie) r.set("Cookie", cookie);
      if (csrf) r.set("X-CSRF-Token", csrf);
      return r;
    };
    const url = (p: string) => `${API_BASE_PATH}${p}`;
    return {
      /** Raw artwork upload, as the browser sends it. */
      upload: (fileName: string, bytes: Buffer) =>
        withAuth(request(app).post(url("/bom-files")))
          .set("Content-Type", "application/octet-stream")
          .set("X-File-Name", encodeURIComponent(fileName))
          .send(bytes),
      get: (p: string) => withAuth(request(app).get(url(p))),
      post: (p: string, b?: object) => withAuth(request(app).post(url(p))).send(b ?? {}),
      patch: (p: string, b?: object) => withAuth(request(app).patch(url(p))).send(b ?? {}),
      put: (p: string, b?: object) => withAuth(request(app).put(url(p))).send(b ?? {}),
      delete: (p: string) => withAuth(request(app).delete(url(p))),
    };
  }

  return { app, db, clock, config, hasher, files, createUser, createAdmin, login, anonymous: client(), roleId };
}
