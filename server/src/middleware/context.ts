import type { Request } from "express";
import { errors } from "../lib/errors";

export interface AuthUser {
  id: string;
  username: string;
  fullName: string;
  mustChangePassword: boolean;
  permissions: Set<string>;
  roleCodes: string[];
}

/** Per-request context, attached by the auth middleware. */
export interface RequestContext {
  requestId: string;
  ip: string | null;
  deviceId: string | null;
  user: AuthUser | null;
  sessionId: string | null;
}

declare module "express-serve-static-core" {
  interface Request {
    ctx: RequestContext;
  }
}

/** The signed-in caller, or 401. */
export function requireUser(req: Request): AuthUser {
  const user = req.ctx.user;
  if (!user) throw errors.unauthenticated();
  return user;
}

export const hasPermission = (user: AuthUser | null, key: string) => !!user && user.permissions.has(key);
