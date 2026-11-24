import { describe, expect, it } from "vitest";
import { ADMIN_ROLE_CODE } from "../src/modules/access/catalog";
import { setupDb, TEST_PASSWORD } from "./db-helpers";

const t = setupDb();

describe("users", () => {
  it("creates a user with roles, audits it without the password, and forces a password change", async () => {
    await t.createAdmin();
    const api = await t.login("admin");
    const roleId = await t.roleId("QC_INSPECTOR");
    const res = await api
      .post("/users", { username: "qc.ali", fullName: "Ali QC", employeeNo: "E1001", password: "Initial-pass-1", roleIds: [roleId] })
      .expect(201);
    expect(res.body.data.roles.map((r: { code: string }) => r.code)).toEqual(["QC_INSPECTOR"]);
    expect(res.body.data.mustChangePassword).toBe(true);
    expect(res.body.data).not.toHaveProperty("passwordHash");
    const audit = await t.db.auditLog.findFirstOrThrow({ where: { action: "USER_CREATED" } });
    expect(audit.recordRef).toBe("qc.ali");
    expect(JSON.stringify({ ...audit, id: String(audit.id) })).not.toContain("Initial-pass-1");
  });

  it("validates input with field messages and rejects duplicate usernames", async () => {
    await t.createAdmin();
    const api = await t.login("admin");
    const bad = await api.post("/users", { username: "a b", fullName: "", password: "x" });
    expect(bad.status).toBe(422);
    const paths = bad.body.issues.map((i: { path: string }) => i.path);
    expect(paths).toEqual(expect.arrayContaining(["username", "fullName", "password"]));
    await api.post("/users", { username: "dup", fullName: "Dup", password: "Initial-pass-1" }).expect(201);
    const dup = await api.post("/users", { username: "dup", fullName: "Dup", password: "Initial-pass-1" });
    expect(dup.status).toBe(422);
    expect(dup.body.issues).toEqual([{ path: "username", message: "This username is already taken" }]);
  });

  it("lists with search, filter and paging", async () => {
    await t.createAdmin();
    for (let i = 1; i <= 12; i++) await t.createUser(`op${String(i).padStart(2, "0")}`, ["PRODUCTION_OPERATOR"]);
    const api = await t.login("admin");
    const page2 = await api.get("/users?page=2&pageSize=5&sort=username:asc&roleId=" + (await t.roleId("PRODUCTION_OPERATOR"))).expect(200);
    expect(page2.body.meta).toMatchObject({ page: 2, pageSize: 5, total: 12, pageCount: 3 });
    expect(page2.body.data[0].username).toBe("op06");
    const search = await api.get("/users?q=op1").expect(200);
    expect(search.body.data.map((u: { username: string }) => u.username)).toEqual(["op10", "op11", "op12"]);
  });

  it("blocks self-deactivation and self-demotion, but allows changing another admin", async () => {
    const admin = await t.createAdmin();
    const api = await t.login("admin");
    const self = await api.put(`/users/${admin.id}/status`, { status: "INACTIVE" });
    expect(self.body.code).toBe("SELF_DEACTIVATION");
    const demote = await api.put(`/users/${admin.id}/roles`, { roleIds: [] });
    expect(demote.body.code).toBe("SELF_DEMOTION");

    const second = await t.createUser("admin2", [ADMIN_ROLE_CODE]);
    await api.put(`/users/${second.id}/roles`, { roleIds: [] }).expect(200);
    expect(await t.db.userRole.count({ where: { userId: second.id } })).toBe(0);
  });

  it("refuses to deactivate or demote the last active administrator", async () => {
    const admin = await t.createAdmin();
    await t.createUser("manager", ["MANAGEMENT"]);
    // a non-admin with user-management rights via a custom role
    const roleId = (
      await t.db.role.create({
        data: { code: "USER_ADMIN", name: "User admin", permissions: { create: [{ permissionKey: "system.users.view" }, { permissionKey: "system.users.manage" }] } },
      })
    ).id;
    await t.createUser("useradmin");
    await t.db.userRole.create({ data: { userId: (await t.db.user.findUniqueOrThrow({ where: { username: "useradmin" } })).id, roleId } });
    const api = await t.login("useradmin");
    const res = await api.put(`/users/${admin.id}/status`, { status: "INACTIVE" });
    expect(res.body.code).toBe("LAST_ADMIN");
  });

  it("never lets an actor assign a role with permissions they lack", async () => {
    await t.createAdmin();
    const roleId = (
      await t.db.role.create({
        data: { code: "USER_ADMIN", name: "User admin", permissions: { create: [{ permissionKey: "system.users.view" }, { permissionKey: "system.users.manage" }] } },
      })
    ).id;
    const ua = await t.createUser("useradmin");
    await t.db.userRole.create({ data: { userId: ua.id, roleId } });
    const api = await t.login("useradmin");
    const res = await api.post("/users", {
      username: "sneaky", fullName: "Sneaky", password: "Initial-pass-1", roleIds: [await t.roleId(ADMIN_ROLE_CODE)],
    });
    expect(res.status).toBe(403);
  });

  it("resets a password: forces change, unlocks, ends sessions", async () => {
    await t.createAdmin();
    const op = await t.createUser("op1", ["PRODUCTION_OPERATOR"]);
    const opApi = await t.login("op1");
    const api = await t.login("admin");
    await api.post(`/users/${op.id}/reset-password`, { password: "Temporary-pass-9" }).expect(200);
    await opApi.get("/auth/me").expect(401);
    const fresh = await t.login("op1", "Temporary-pass-9");
    const me = await fresh.get("/auth/me").expect(200);
    expect(me.body.data.user.mustChangePassword).toBe(true);
    await t.anonymous.post("/auth/login", { username: "op1", password: TEST_PASSWORD }).expect(401);
  });

  it("deactivating a user ends their sessions", async () => {
    await t.createAdmin();
    const op = await t.createUser("op1", ["PRODUCTION_OPERATOR"]);
    const opApi = await t.login("op1");
    const api = await t.login("admin");
    await api.put(`/users/${op.id}/status`, { status: "INACTIVE" }).expect(200);
    await opApi.get("/auth/me").expect(401);
  });

  it("does not write an audit row when nothing changed", async () => {
    await t.createAdmin();
    const op = await t.createUser("op1");
    const api = await t.login("admin");
    await api.patch(`/users/${op.id}`, { fullName: op.fullName }).expect(200);
    expect(await t.db.auditLog.count({ where: { action: "USER_UPDATED" } })).toBe(0);
    await api.patch(`/users/${op.id}`, { fullName: "Renamed" }).expect(200);
    const row = await t.db.auditLog.findFirstOrThrow({ where: { action: "USER_UPDATED" } });
    expect(row.previous).toEqual({ fullName: op.fullName });
    expect(row.next).toEqual({ fullName: "Renamed" });
  });
});

describe("roles and permissions", () => {
  it("enforces permissions per route", async () => {
    await t.createUser("op1", ["PRODUCTION_OPERATOR"]);
    await t.createUser("mgmt", ["MANAGEMENT"]);
    const op = await t.login("op1");
    await op.get("/users").expect(403);
    await op.get("/roles").expect(403);
    await op.get("/audit").expect(403);
    const mgmt = await t.login("mgmt");
    await mgmt.get("/users").expect(403);
    await mgmt.post("/roles", { code: "X", name: "X role" }).expect(403);
  });

  it("creates and edits a custom role, auditing added and removed permissions", async () => {
    await t.createAdmin();
    const api = await t.login("admin");
    const created = await api.post("/roles", { code: "SHIFT_LEAD", name: "Shift lead", permissions: ["shopfloor.wip.view", "bom.view"] }).expect(201);
    const id = created.body.data.id;
    await api.patch(`/roles/${id}`, { permissions: ["shopfloor.wip.view", "shopfloor.output.record"] }).expect(200);
    const role = await api.get(`/roles/${id}`).expect(200);
    expect(role.body.data.permissions).toEqual(["shopfloor.output.record", "shopfloor.wip.view"]);
    const row = await t.db.auditLog.findFirstOrThrow({ where: { action: "ROLE_UPDATED" } });
    expect(row.previous).toEqual({ removedPermissions: ["bom.view"] });
    expect(row.next).toEqual({ addedPermissions: ["shopfloor.output.record"] });
  });

  it("rejects unknown permission keys and protects the Administrator role", async () => {
    await t.createAdmin();
    const api = await t.login("admin");
    const bad = await api.post("/roles", { code: "BAD", name: "Bad role", permissions: ["not.a.key"] });
    expect(bad.status).toBe(422);
    const adminId = await t.roleId(ADMIN_ROLE_CODE);
    const res = await api.patch(`/roles/${adminId}`, { permissions: [] });
    expect(res.body.code).toBe("ADMIN_ROLE_FIXED");
    const off = await api.patch(`/roles/${adminId}`, { isActive: false });
    expect(off.body.code).toBe("ADMIN_ROLE_FIXED");
  });

  it("deactivating a role removes its grants from users immediately", async () => {
    await t.createAdmin();
    await t.createUser("planner", ["PRODUCTION_PLANNER"]);
    const planner = await t.login("planner");
    expect((await planner.get("/auth/me")).body.data.permissions).toContain("planning.pjo.create");
    const api = await t.login("admin");
    await api.patch(`/roles/${await t.roleId("PRODUCTION_PLANNER")}`, { isActive: false }).expect(200);
    expect((await planner.get("/auth/me")).body.data.permissions).toEqual([]);
  });
});

describe("audit trail", () => {
  it("is append-only at the database level", async () => {
    await t.createAdmin();
    await t.login("admin");
    const row = await t.db.auditLog.findFirstOrThrow();
    await expect(t.db.auditLog.update({ where: { id: row.id }, data: { action: "TAMPERED" } })).rejects.toThrow(/append-only/);
    await expect(t.db.auditLog.delete({ where: { id: row.id } })).rejects.toThrow(/append-only/);
  });

  it("lists with filters for users holding system.audit.view", async () => {
    await t.createAdmin();
    const api = await t.login("admin");
    await t.anonymous.post("/auth/login", { username: "admin", password: "nope" });
    const res = await api.get("/audit?module=auth&result=DENIED").expect(200);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0].action).toBe("LOGIN_FAILED");
    const facets = await api.get("/audit/facets").expect(200);
    expect(facets.body.data.modules).toContain("auth");
  });
});

describe("reference data", () => {
  it("is idempotent and keeps admin edits to system roles", async () => {
    await t.createAdmin();
    const api = await t.login("admin");
    const plannerId = await t.roleId("PRODUCTION_PLANNER");
    await api.patch(`/roles/${plannerId}`, { permissions: ["bom.view"] }).expect(200);
    const { syncReferenceData } = await import("../src/database/reference");
    const again = await syncReferenceData(t.db);
    expect(again).toMatchObject({ rolesCreated: 0, grantsAdded: 0, sequences: 0 });
    const role = await api.get(`/roles/${plannerId}`).expect(200);
    expect(role.body.data.permissions).toEqual(["bom.view"]);
  });

  it("numbers documents per sequence, restarting yearly sequences each year", async () => {
    const { nextNumber } = await import("../src/lib/numbering");
    const n = await t.db.$transaction(async (tx) => [
      await nextNumber(tx, "BOM", new Date("2026-05-01")),
      await nextNumber(tx, "BOM", new Date("2026-05-01")),
      await nextNumber(tx, "PJO", new Date("2026-12-31")),
      await nextNumber(tx, "PJO", new Date("2027-01-01")),
    ]);
    expect(n).toEqual(["BOM-000001", "BOM-000002", "PJO-2026-00001", "PJO-2027-00001"]);
  });
});
