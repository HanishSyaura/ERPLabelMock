import type { DbOrTx } from "../../lib/prisma";
import type { RequestContext } from "../../middleware/context";

export type AuditModule = "system" | "auth" | "bom" | "masterdata" | "planning" | "shopfloor" | "qc";

export interface AuditEntry {
  module: AuditModule;
  action: string;
  entityType: string;
  entityId?: string | null;
  recordRef?: string | null;
  previous?: unknown;
  next?: unknown;
  remarks?: string | null;
  result?: "SUCCESS" | "DENIED" | "FAILED";
}

/** Values that must never reach the audit trail, whatever the caller passes. */
const SECRET_KEYS = /^(password|passwordHash|newPassword|currentPassword|token|csrfToken)$/i;

function scrub(value: unknown): unknown {
  if (value === undefined || value === null) return value ?? undefined;
  if (Array.isArray(value)) return value.map(scrub);
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (!SECRET_KEYS.test(k)) out[k] = scrub(v);
    }
    return out;
  }
  return value;
}

/**
 * Append an audit row. Pass the transaction client when inside a transaction
 * so the audit row commits (or rolls back) with the change it describes.
 */
export async function recordAudit(db: DbOrTx, ctx: RequestContext | null, entry: AuditEntry) {
  await db.auditLog.create({
    data: {
      userId: ctx?.user?.id ?? null,
      userName: ctx?.user?.fullName ?? null,
      module: entry.module,
      action: entry.action,
      entityType: entry.entityType,
      entityId: entry.entityId ?? null,
      recordRef: entry.recordRef ?? null,
      previous: (scrub(entry.previous) ?? undefined) as never,
      next: (scrub(entry.next) ?? undefined) as never,
      remarks: entry.remarks ?? null,
      result: entry.result ?? "SUCCESS",
      deviceId: ctx?.deviceId ?? null,
      ip: ctx?.ip ?? null,
      requestId: ctx?.requestId ?? null,
    },
  });
}

/** Shallow diff of two plain records: only changed keys, for previous/next. */
export function diff<T extends Record<string, unknown>>(before: T, after: Partial<T>) {
  const previous: Record<string, unknown> = {};
  const next: Record<string, unknown> = {};
  for (const key of Object.keys(after)) {
    const a = before[key];
    const b = after[key];
    if (b === undefined) continue;
    const same = a instanceof Date && b instanceof Date ? a.getTime() === b.getTime() : JSON.stringify(a) === JSON.stringify(b);
    if (!same) {
      previous[key] = a;
      next[key] = b;
    }
  }
  return { previous, next, changed: Object.keys(next).length > 0 };
}
