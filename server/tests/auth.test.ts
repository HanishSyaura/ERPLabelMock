import { describe, expect, it } from "vitest";
import { setupDb, TEST_PASSWORD } from "./db-helpers";

const t = setupDb();

describe("authentication", () => {
  it("signs in, returns permissions and a CSRF token, and stores only the token hash", async () => {
    const user = await t.createUser("planner1", ["PRODUCTION_PLANNER"]);
    const api = await t.login("planner1");
    const me = await api.get("/auth/me").expect(200);
    expect(me.body.data.user.username).toBe("planner1");
    expect(me.body.data.roles).toEqual(["PRODUCTION_PLANNER"]);
    expect(me.body.data.permissions).toContain("planning.pjo.create");
    expect(me.body.data.permissions).not.toContain("system.users.manage");
    expect(me.body.data.csrfToken).toHaveLength(64);
    const session = await t.db.session.findFirstOrThrow({ where: { userId: user.id } });
    expect(session.id).toMatch(/^[0-9a-f]{64}$/);
  });

  it("gives the same answer for unknown users and wrong passwords, and audits both", async () => {
    await t.createUser("someone");
    const a = await t.anonymous.post("/auth/login", { username: "nobody", password: "x" });
    const b = await t.anonymous.post("/auth/login", { username: "someone", password: "wrong" });
    expect(a.status).toBe(401);
    expect(b.status).toBe(401);
    expect(a.body.title).toBe(b.body.title);
    const rows = await t.db.auditLog.findMany({ where: { action: "LOGIN_FAILED" } });
    expect(rows).toHaveLength(2);
    expect(JSON.stringify(rows, (_k, v) => (typeof v === "bigint" ? v.toString() : v))).not.toContain("wrong");
  });

  it("locks the account after 5 failed attempts and unlocks after 15 minutes", async () => {
    await t.createUser("op1", ["PRODUCTION_OPERATOR"]);
    for (let i = 0; i < 5; i++) await t.anonymous.post("/auth/login", { username: "op1", password: "bad" }).expect(401);
    const locked = await t.anonymous.post("/auth/login", { username: "op1", password: TEST_PASSWORD });
    expect(locked.status).toBe(422);
    expect(locked.body.code).toBe("ACCOUNT_LOCKED");
    t.clock.advance(16 * 60_000);
    await t.anonymous.post("/auth/login", { username: "op1", password: TEST_PASSWORD }).expect(200);
  });

  it("refuses inactive users", async () => {
    const u = await t.createUser("gone");
    await t.db.user.update({ where: { id: u.id }, data: { status: "INACTIVE" } });
    await t.anonymous.post("/auth/login", { username: "gone", password: TEST_PASSWORD }).expect(401);
  });

  it("requires the CSRF token on unsafe requests", async () => {
    await t.createAdmin();
    const login = await t.anonymous.post("/auth/login", { username: "admin", password: TEST_PASSWORD }).expect(200);
    const cookie = login.headers["set-cookie"] as unknown as string[];
    // Signed-in cookie, but no / wrong CSRF header -> refused
    const noCsrf = await t.anonymous.post("/auth/logout").set("Cookie", cookie);
    expect(noCsrf.status).toBe(403);
    const wrong = await t.anonymous.post("/auth/logout").set("Cookie", cookie).set("X-CSRF-Token", "0".repeat(64));
    expect(wrong.status).toBe(403);
    // Safe requests don't need it
    await t.anonymous.get("/auth/me").set("Cookie", cookie).expect(200);
  });

  it("expires idle sessions", async () => {
    await t.createAdmin();
    const api = await t.login("admin");
    await api.get("/auth/me").expect(200);
    t.clock.advance((t.config.SESSION_IDLE_MINUTES + 1) * 60_000);
    await api.get("/auth/me").expect(401);
  });

  it("logs out and the session stops working", async () => {
    await t.createAdmin();
    const api = await t.login("admin");
    await api.post("/auth/logout").expect(200);
    await api.get("/auth/me").expect(401);
  });

  it("forces a password change before anything else, then signs out other sessions", async () => {
    await t.createUser("newbie", ["MANAGEMENT"], { mustChangePassword: true });
    const api = await t.login("newbie");
    const other = await t.login("newbie");
    const blocked = await api.get("/roles");
    expect(blocked.body.code).toBe("PASSWORD_CHANGE_REQUIRED");

    const weak = await api.post("/auth/change-password", { currentPassword: TEST_PASSWORD, newPassword: "short" });
    expect(weak.status).toBe(422);
    await api.post("/auth/change-password", { currentPassword: TEST_PASSWORD, newPassword: "Brand-new-pass-42" }).expect(200);
    await api.get("/auth/me").expect(200);
    await other.get("/auth/me").expect(401);
    await t.anonymous.post("/auth/login", { username: "newbie", password: "Brand-new-pass-42" }).expect(200);
  });

  it("answers 401 for protected routes when signed out", async () => {
    await t.anonymous.get("/users").expect(401);
    await t.anonymous.get("/audit").expect(401);
    await t.anonymous.get("/roles").expect(401);
  });
});
