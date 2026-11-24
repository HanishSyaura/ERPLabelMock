import { randomUUID, timingSafeEqual } from "node:crypto";
import type { NextFunction, Request, RequestHandler, Response } from "express";
import type { Deps } from "../deps";
import { sha256 } from "../lib/crypto";
import { errors } from "../lib/errors";
import { loadUserAccess } from "../modules/access/access.service";
import type { RequestContext } from "./context";

export const SESSION_COOKIE = "mes_session";
const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);
/** lastSeenAt is refreshed at most this often (avoids a write per request). */
const TOUCH_INTERVAL_MS = 60_000;

const sameToken = (a: string, b: string) => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

/**
 * Loads the session (if any) into req.ctx. Never rejects by itself:
 * routes decide with requireAuth / requirePermission.
 */
export function sessionMiddleware(deps: Deps): RequestHandler {
  return async (req: Request, _res: Response, next: NextFunction) => {
    const deviceHeader = req.header("x-device-id");
    const ctx: RequestContext = {
      requestId: (req.header("x-request-id") ?? randomUUID()).slice(0, 64),
      ip: req.ip ?? null,
      deviceId: deviceHeader ? deviceHeader.slice(0, 80) : null,
      user: null,
      sessionId: null,
    };
    req.ctx = ctx;

    const token: unknown = req.cookies?.[SESSION_COOKIE];
    if (typeof token !== "string" || token.length < 20) return next();

    const id = sha256(token);
    const session = await deps.db.session.findUnique({
      where: { id },
      include: { user: { select: { id: true, username: true, fullName: true, status: true, mustChangePassword: true } } },
    });
    const now = deps.now();
    const idleLimit = deps.config.SESSION_IDLE_MINUTES * 60_000;
    const valid =
      session &&
      !session.revokedAt &&
      session.expiresAt > now &&
      now.getTime() - session.lastSeenAt.getTime() <= idleLimit &&
      session.user.status === "ACTIVE";
    if (!valid) return next();

    // CSRF: unsafe requests must echo the session's token.
    if (!SAFE_METHODS.has(req.method)) {
      const sent = req.header("x-csrf-token") ?? "";
      if (!sameToken(sent, session.csrfToken)) {
        return next(errors.forbidden("Your session security token is missing or out of date. Reload the page and try again."));
      }
    }

    if (now.getTime() - session.lastSeenAt.getTime() > TOUCH_INTERVAL_MS) {
      await deps.db.session.update({ where: { id }, data: { lastSeenAt: now } });
    }

    const access = await loadUserAccess(deps.db, session.user.id);
    ctx.sessionId = id;
    ctx.deviceId = ctx.deviceId ?? session.deviceId;
    ctx.user = {
      id: session.user.id,
      username: session.user.username,
      fullName: session.user.fullName,
      mustChangePassword: session.user.mustChangePassword,
      permissions: access.permissions,
      roleCodes: access.roleCodes,
    };
    next();
  };
}

/** Signed in, and not blocked by a forced password change. */
export const requireAuth: RequestHandler = (req, _res, next) => {
  const user = req.ctx.user;
  if (!user) return next(errors.unauthenticated());
  if (user.mustChangePassword) {
    return next(errors.rule("PASSWORD_CHANGE_REQUIRED", "You must change your password before continuing."));
  }
  next();
};

/** Requires every listed permission key. */
export const requirePermission =
  (...keys: string[]): RequestHandler =>
  (req, _res, next) => {
    const user = req.ctx.user;
    if (!user) return next(errors.unauthenticated());
    if (user.mustChangePassword) {
      return next(errors.rule("PASSWORD_CHANGE_REQUIRED", "You must change your password before continuing."));
    }
    if (!keys.every((k) => user.permissions.has(k))) return next(errors.forbidden());
    next();
  };

/** Requires at least one of the listed permission keys. */
export const requireAnyPermission =
  (...keys: string[]): RequestHandler =>
  (req, _res, next) => {
    const user = req.ctx.user;
    if (!user) return next(errors.unauthenticated());
    if (user.mustChangePassword) {
      return next(errors.rule("PASSWORD_CHANGE_REQUIRED", "You must change your password before continuing."));
    }
    if (!keys.some((k) => user.permissions.has(k))) return next(errors.forbidden());
    next();
  };
