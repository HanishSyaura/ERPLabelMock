import { Badge, type Tone } from "./ui";

/**
 * Status labels and colours, one map per status family. Machine, session and
 * Work Order statuses are different things and are never mixed.
 */
const MAPS = {
  machine: {
    AVAILABLE: ["Available", "success"],
    RUNNING: ["Running", "primary"],
    IDLE: ["Idle", "info"],
    BREAKDOWN: ["Breakdown", "danger"],
    MAINTENANCE: ["Maintenance", "warning"],
    OFFLINE: ["Offline", "neutral"],
  },
  session: {
    RUNNING: ["Running", "primary"],
    COMPLETED: ["Completed", "success"],
    PAUSED: ["Paused", "info"],
    BREAKDOWN: ["Breakdown", "danger"],
    TRANSFERRED: ["Transferred", "warning"],
    CLOSED: ["Closed (shift end)", "neutral"],
  },
  wo: {
    PLANNED: ["Planned", "neutral"],
    RELEASED: ["Released", "info"],
    IN_PROGRESS: ["In Progress", "primary"],
    PARTIALLY_COMPLETED: ["Partially Completed", "warning"],
    COMPLETED: ["Completed", "success"],
    ON_HOLD: ["On Hold", "danger"],
    CANCELLED: ["Cancelled", "neutral"],
  },
  pjo: {
    DRAFT: ["Draft", "neutral"],
    RELEASED: ["Released", "info"],
    CLOSED: ["Closed", "success"],
    CANCELLED: ["Cancelled", "neutral"],
  },
  process: {
    PENDING: ["Pending", "neutral"],
    RUNNING: ["Running", "primary"],
    PAUSED: ["Paused", "info"],
    COMPLETED: ["Completed", "success"],
  },
  record: {
    ACTIVE: ["Active", "success"],
    INACTIVE: ["Inactive", "neutral"],
  },
  breakdown: {
    OPEN: ["Open", "danger"],
    UNDER_MAINTENANCE: ["Under maintenance", "warning"],
    RESOLVED: ["Resolved", "success"],
  },
  change: {
    PENDING: ["Waiting approval", "warning"],
    APPROVED: ["Approved", "success"],
    REJECTED: ["Rejected", "neutral"],
  },
  mrs: {
    OPEN: ["Open", "neutral"],
    PARTIALLY_ISSUED: ["Partly issued", "warning"],
    ISSUED: ["Issued", "success"],
    CLOSED: ["Closed", "info"],
    CANCELLED: ["Cancelled", "neutral"],
  },
  material: {
    NONE: ["No material issued", "danger"],
    PARTIAL: ["Material partly issued", "warning"],
    ISSUED: ["Material issued", "success"],
  },
  qc: {
    IN_INSPECTION: ["In inspection", "primary"],
    PASSED: ["Passed", "success"],
    PENDING_DISPOSITION: ["Waiting for disposition", "warning"],
    ACCEPTED: ["Accepted (use as is)", "info"],
    REJECTED: ["Rejected", "danger"],
    REWORK: ["Sent to rework", "warning"],
    RETURNED: ["Returned to supplier", "neutral"],
  },
  severity: {
    MINOR: ["Minor", "info"],
    MAJOR: ["Major", "warning"],
    CRITICAL: ["Critical", "danger"],
  },
  card: {
    DRAFT: ["Draft", "primary"],
    RELEASED: ["Released", "success"],
    SUPERSEDED: ["Superseded", "neutral"],
  },
  priority: {
    LOW: ["Low", "neutral"],
    NORMAL: ["Normal", "info"],
    HIGH: ["High", "warning"],
    URGENT: ["Urgent", "danger"],
  },
} as const satisfies Record<string, Record<string, readonly [string, Tone]>>;

export type StatusKind = keyof typeof MAPS;

export function statusLabel(kind: StatusKind, value: string) {
  return (MAPS[kind] as Record<string, readonly [string, Tone]>)[value]?.[0] ?? value;
}

export function StatusBadge({ kind, value, className }: { kind: StatusKind; value: string; className?: string }) {
  const entry = (MAPS[kind] as Record<string, readonly [string, Tone]>)[value];
  return (
    <Badge tone={entry?.[1] ?? "neutral"} className={className}>
      {entry?.[0] ?? value}
    </Badge>
  );
}

export const CHECKOUT_TYPES = [
  { value: "COMPLETED", label: "Completed", hint: "This operation is finished." },
  { value: "PARTIAL", label: "Partial / Pause", hint: "Stop for now; work stays on this machine." },
  { value: "SHIFT_END", label: "Shift End", hint: "End of shift; the next shift continues." },
  { value: "MACHINE_CHANGE", label: "Machine Change", hint: "Continue the remaining work on another machine." },
  { value: "MACHINE_BREAKDOWN", label: "Machine Breakdown", hint: "The machine can't continue." },
] as const;

export const checkoutLabel = (v: string | null) => CHECKOUT_TYPES.find((c) => c.value === v)?.label ?? v ?? "—";
