import { randomBytes } from "node:crypto";
import { Router, type Response } from "express";
import { z } from "zod";
import type { Deps } from "../../deps";
import { passwordProblems, randomToken, sha256 } from "../../lib/crypto";
import { errors } from "../../lib/errors";
import { body, ok } from "../../lib/http";
import { SESSION_COOKIE } from "../../middleware/auth";
import { requireUser } from "../../middleware/context";
import { recordAudit } from "../audit/audit.service";
import { loadUserAccess } from "../access/access.service";

const MAX_FAILED_LOGINS = 5;
const LOCK_MINUTES = 15;
const IP_WINDOW_MS = 5 * 60_000;


const loginSchema = z.object({
  username: z.string().trim().min(1, "Enter your username").max(50),
  password: z.string().min(1, "Enter your password").max(200),
});

const changePasswordSchema = z.object({
  currentPassword: z.string().min(1, "Enter your current password").max(200),
  newPassword: z.string().max(200),
});

/** In-memory per-IP limiter for the login route (single instance deployment). */
function createIpLimiter(now: () => Date, maxAttempts: number) {
  const hits = new Map<string, number[]>();
  return (ip: string) => {
    const t = now().getTime();
    const list = (hits.get(ip) ?? []).filter((x) => t - x < IP_WINDOW_MS);
    list.push(t);
    hits.set(ip, list);
    if (hits.size > 10_000) hits.clear();
    return list.length <= maxAttempts;
  };
}

export function authRoutes(deps: Deps) {
  const r = Router();
  const { db, config, hasher } = deps;
  const allowIp = createIpLimiter(deps.now, config.LOGIN_IP_MAX_ATTEMPTS);

  const setCookie = (res: Response, token: string, expires: Date) =>
    res.cookie(SESSION_COOKIE, token, {
      httpOnly: true,
      secure: config.COOKIE_SECURE,
      sameSite: "lax",
      path: "/",
      expires,
    });

  const me = async (userId: string, csrfToken: string) => {
    const user = await db.user.findUniqueOrThrow({
      where: { id: userId },
      select: { id: true, username: true, fullName: true, email: true, employeeNo: true, mustChangePassword: true },
    });
    const access = await loadUserAccess(db, userId);
    return { user, roles: access.roleCodes, permissions: [...access.permissions].sort(), csrfToken };
  };

  r.post("/login", async (req, res) => {
    if (!allowIp(req.ip ?? "unknown")) throw errors.tooMany();
    const input = body(req, loginSchema);
    const now = deps.now();
    const user = await db.user.findUnique({ where: { username: input.username } });
    // Same message for every failure so usernames can't be probed.
    const refused = errors.unauthenticated("The username or password is incorrect.");

    if (!user) {
      await hasher.hash(input.password); // keep timing similar
      await recordAudit(db, req.ctx, {
        module: "auth", action: "LOGIN_FAILED", entityType: "user", recordRef: input.username, result: "DENIED",
        remarks: "Unknown username",
      });
      throw refused;
    }
    if (user.lockedUntil && user.lockedUntil > now) {
      throw errors.rule("ACCOUNT_LOCKED", `Too many failed attempts. Try again after ${LOCK_MINUTES} minutes or ask an administrator to reset your password.`);
    }
    const valid = await hasher.verify(user.passwordHash, input.password);
    if (!valid || user.status !== "ACTIVE") {
      const failed = valid ? user.failedLogins : user.failedLogins + 1;
      const lock = failed >= MAX_FAILED_LOGINS;
      await db.user.update({
        where: { id: user.id },
        data: { failedLogins: lock ? 0 : failed, lockedUntil: lock ? new Date(now.getTime() + LOCK_MINUTES * 60_000) : undefined },
      });
      await recordAudit(db, req.ctx, {
        module: "auth", action: lock ? "ACCOUNT_LOCKED" : "LOGIN_FAILED", entityType: "user", entityId: user.id,
        recordRef: user.username, result: "DENIED", remarks: user.status !== "ACTIVE" ? "Inactive account" : null,
      });
      throw refused;
    }

    const token = randomToken();
    const csrfToken = randomBytes(32).toString("hex");
    const expiresAt = new Date(now.getTime() + config.SESSION_TTL_HOURS * 3_600_000);
    await db.$transaction(async (tx) => {
      await tx.session.create({
        data: {
          id: sha256(token), userId: user.id, csrfToken, createdAt: now, lastSeenAt: now, expiresAt,
          ip: req.ip ?? null, userAgent: req.header("user-agent")?.slice(0, 255) ?? null, deviceId: req.ctx.deviceId,
        },
      });
      await tx.user.update({ where: { id: user.id }, data: { failedLogins: 0, lockedUntil: null, lastLoginAt: now } });
      await recordAudit(tx, { ...req.ctx, user: { id: user.id, fullName: user.fullName } as never }, {
        module: "auth", action: "LOGIN", entityType: "user", entityId: user.id, recordRef: user.username,
      });
    });
    setCookie(res, token, expiresAt);
    res.json(ok(await me(user.id, csrfToken)));
  });

  r.post("/logout", async (req, res) => {
    if (req.ctx.sessionId) {
      await db.session.update({ where: { id: req.ctx.sessionId }, data: { revokedAt: deps.now() } });
      await recordAudit(db, req.ctx, { module: "auth", action: "LOGOUT", entityType: "user", entityId: req.ctx.user?.id, recordRef: req.ctx.user?.username });
    }
    res.clearCookie(SESSION_COOKIE, { path: "/" });
    res.json(ok({ signedOut: true }));
  });

  /** Current session. 401 when signed out (the UI shows the sign-in page). */
  r.get("/me", async (req, res) => {
    const user = requireUser(req);
    const session = await db.session.findUniqueOrThrow({ where: { id: req.ctx.sessionId! }, select: { csrfToken: true } });
    res.json(ok(await me(user.id, session.csrfToken)));
  });

  r.post("/change-password", async (req, res) => {
    const user = requireUser(req);
    const input = body(req, changePasswordSchema);
    const record = await db.user.findUniqueOrThrow({ where: { id: user.id } });
    if (!(await hasher.verify(record.passwordHash, input.currentPassword))) {
      throw errors.validation([{ path: "currentPassword", message: "Current password is incorrect" }]);
    }
    const problems = passwordProblems(input.newPassword);
    if (problems.length) throw errors.validation([{ path: "newPassword", message: `Password needs ${problems.join(", ")}` }]);
    if (input.newPassword === input.currentPassword) {
      throw errors.validation([{ path: "newPassword", message: "Choose a password different from the current one" }]);
    }
    const passwordHash = await hasher.hash(input.newPassword);
    await db.$transaction(async (tx) => {
      await tx.user.update({ where: { id: user.id }, data: { passwordHash, mustChangePassword: false, updatedById: user.id } });
      // Sign out every other session of this user.
      await tx.session.updateMany({
        where: { userId: user.id, revokedAt: null, id: { not: req.ctx.sessionId! } },
        data: { revokedAt: deps.now() },
      });
      await recordAudit(tx, req.ctx, { module: "auth", action: "PASSWORD_CHANGED", entityType: "user", entityId: user.id, recordRef: user.username });
    });
    res.json(ok({ changed: true }));
  });

  return r;
}
