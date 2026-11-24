import { useQuery } from "@tanstack/react-query";
import {
  Activity as ActivityIcon,
  AlertOctagon,
  AlertTriangle,
  ArrowDown,
  ArrowUp,
  CalendarClock,
  CheckCircle2,
  ChevronRight,
  ClipboardCheck,
  Cog,
  Factory,
  Info,
  Layers,
  Package,
  PlayCircle,
  Plus,
  RefreshCw,
  Search,
  Truck,
  type LucideIcon,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Link, useNavigate, useSearchParams } from "react-router";
import { ErrorState } from "@/components/common";
import { StatusBadge } from "@/components/status";
import { Badge, Card, Select, Spinner } from "@/components/ui";
import { GUIDED_FLOWS } from "@/config/flows";
import { api, qs } from "@/lib/api";
import { cn, formatDateTime } from "@/lib/utils";
import { useProcesses } from "@/modules/planning/api";
import { useAuth } from "@/stores/auth";

/**
 * Manufacturing dashboard. Every figure comes from GET /dashboard, which counts
 * live transactions on request (definitions are in dashboard.routes.ts);
 * nothing is computed or invented here. Sections show only for modules the
 * user may view. Module navigation stays in the sidebar – no shortcuts here.
 */
type Period = "today" | "7d" | "30d";
type Severity = "critical" | "high" | "medium" | "low";
interface Dash {
  generatedAt: string;
  period: { key: Period; from: string; to: string; days: number };
  kpis: Partial<Record<"activeOrders" | "releasedWorkOrders" | "inProgress" | "completed" | "overdue" | "pendingMrs" | "activeWip" | "pendingQc", number>>;
  orders?: { byStatus: Record<string, number>; releasedWithoutJobs: number };
  jobs?: {
    byStatus: Record<string, number>;
    overdue: number;
    dueToday: number;
    dueWeek: number;
    unscheduled: number;
    progress: { uom: string; planned: number; output: number; remaining: number; workOrders: number }[];
    completedInPeriod: { uom: string; workOrders: number; good: number }[];
    schedule: ScheduleRow[];
  };
  wip?: { running: number; waiting: number; paused: number; rows: { kind: "running" | "waiting" | "paused"; woId: string; woNo: string; fatherCode: string; process: string; previous: string | null; machine: string | null; qty: string; uom: string; lastMovement: string | null }[] };
  floor?: {
    counts: Record<string, number>;
    runningSessions: number;
    output: { date: string; good: number; reject: number }[];
    machines: {
      id: string;
      code: string;
      name: string;
      category: string;
      status: string;
      statusSince: string;
      session: { sessionNo: string; woId: string; woNo: string; process: string; operator: string | null; since: string; good: string; uom: string } | null;
      breakdown: { breakdownNo: string; reason: string; status: string; since: string } | null;
      lastOutput: { at: string; good: number } | null;
    }[];
  };
  mine?: { sessionNo: string; since: string; good: string; machineId: string; machine: string; woId: string; woNo: string; uom: string; process: string }[];
  material?: {
    open: number;
    partiallyIssued: number;
    productionStartedWaiting: number;
    movements: Record<string, number>;
    waiting: { id: string; mrsNo: string; status: string; createdAt: string; woId: string; woNo: string; woStatus: string; lines: number; linesOpen: number }[];
    external: string;
  };
  quality?: { lots: { type: "IQC" | "OQC"; inInspection: number; onHold: number; inRework: number; passed: number; failed: number; rejected: number; concession: number }[] };
  alerts: { key: string; severity: Severity; type: string; record: string; reason: string; at: string | null; role: string; action: string; path: string }[];
  activity: { at: string; kind: string; text: string; record: string; path: string; by: string | null }[];
}
interface ScheduleRow {
  id: string;
  woNo: string;
  status: string;
  priority: string;
  pjoId: string;
  pjoNo: string;
  customerRef: string | null;
  fatherCode: string;
  labelDescription: string;
  uom: string;
  planned: string;
  output: string;
  remaining: string;
  requiredDate: string | null;
  plannedDate: string | null;
  due: "overdue" | "today" | "week" | "later" | "none";
  scheduled: boolean;
  currentProcess: string;
}
interface Hit {
  type: string;
  label: string;
  detail: string;
  path: string;
}

const fmt = (n: number | string) => Number(n).toLocaleString(undefined, { maximumFractionDigits: 2 });
const PERIOD_LABEL: Record<Period, string> = { today: "Today", "7d": "Last 7 days", "30d": "Last 30 days" };
const localDay = (iso: string) => {
  const d = new Date(iso);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};
const ago = (iso: string | null) => {
  if (!iso) return "—";
  const m = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  return h < 48 ? `${h} h ago` : `${Math.round(h / 24)} d ago`;
};
const day = (key: string | null) => (key ? new Date(`${key}T00:00:00`).toLocaleDateString(undefined, { day: "numeric", month: "short" }) : "—");

export function DashboardPage() {
  const { can } = useAuth();
  const [params, setParams] = useSearchParams();
  const period = (["today", "7d", "30d"].includes(params.get("period") ?? "") ? params.get("period") : "today") as Period;
  const processId = params.get("process") ?? "";
  const setFilter = (k: string, v: string) =>
    setParams((p) => {
      const n = new URLSearchParams(p);
      v ? n.set(k, v) : n.delete(k);
      return n;
    }, { replace: true });
  const dash = useQuery({ queryKey: ["dashboard", period, processId], queryFn: () => api.get<Dash>(`/dashboard${qs({ period, processId: processId || undefined })}`), refetchInterval: 60_000, placeholderData: (p) => p });
  const processes = useProcesses("ACTIVE");
  const showProcess = can("planning.master.view") && (processes.data?.length ?? 0) > 0;
  const d = dash.data;

  return (
    <div className="space-y-4">
      {/* Title + filters */}
      <section className="flex flex-col gap-3 xl:flex-row xl:items-center">
        <div className="min-w-0 flex-1">
          <h1 className="text-xl font-semibold">Manufacturing overview</h1>
          <p className="flex flex-wrap items-center gap-x-2 text-xs text-muted">
            {d ? <>Counted from transactions · last updated {formatDateTime(d.generatedAt)} · refreshes every minute</> : "Loading live figures…"}
            <button onClick={() => void dash.refetch()} className="inline-flex items-center gap-1 text-primary hover:underline" disabled={dash.isFetching}>
              <RefreshCw className={cn("size-3", dash.isFetching && "animate-spin")} /> Refresh
            </button>
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <div className="inline-flex rounded-lg border border-line bg-surface p-0.5" role="group" aria-label="Period">
            {(["today", "7d", "30d"] as Period[]).map((p) => (
              <button key={p} onClick={() => setFilter("period", p === "today" ? "" : p)} aria-pressed={period === p} className={cn("rounded-md px-3 py-1.5 text-sm", period === p ? "bg-primary text-on-primary" : "text-muted hover:text-text")}>
                {PERIOD_LABEL[p]}
              </button>
            ))}
          </div>
          {showProcess && (
            <Select value={processId} onChange={(e) => setFilter("process", e.target.value)} className="w-44" aria-label="Process">
              <option value="">All processes</option>
              {processes.data?.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </Select>
          )}
          <QuickFind />
          <StartMenu />
        </div>
      </section>

      {dash.error && !d ? (
        <ErrorState error={dash.error} onRetry={() => void dash.refetch()} />
      ) : !d ? (
        <div className="grid place-items-center py-16">
          <Spinner className="size-7" />
        </div>
      ) : (
        <>
          <Kpis d={d} period={period} />
          {d.mine && d.mine.length > 0 && <MyWork rows={d.mine} />}
          <div className="grid gap-4 xl:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)]">
            <Alerts alerts={d.alerts} />
            {d.jobs && <ProductionProgress jobs={d.jobs} orders={d.orders} period={period} />}
          </div>
          {d.jobs && <Schedule rows={d.jobs.schedule} jobs={d.jobs} />}
          {d.floor && (
            <div className="grid gap-4 xl:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)]">
              <Machines floor={d.floor} filtered={!!processId} />
              <OutputChart days={d.floor.output} period={period} />
            </div>
          )}
          <div className="grid gap-4 lg:grid-cols-2 xl:grid-cols-3">
            {d.wip && <Wip wip={d.wip} filtered={!!processId} className="xl:col-span-1" />}
            {d.material && <Material m={d.material} period={period} />}
            {d.quality && <Quality q={d.quality} period={period} />}
          </div>
          {d.activity.length > 0 && <RecentActivity rows={d.activity} />}
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// KPIs
// ---------------------------------------------------------------------------

const TONE = { danger: "text-danger", warning: "text-warning", success: "text-success", primary: "text-primary" } as const;
function Kpis({ d, period }: { d: Dash; period: Period }) {
  const k = d.kpis;
  const qcPath = d.quality?.lots.some((l) => l.type === "IQC") ? "/qc/iqc-check-in-out?view=open" : "/qc/oqc-check-in-out?view=open";
  const cards: { show: boolean; icon: LucideIcon; label: string; value: number; hint: string; to: string; tone?: keyof typeof TONE }[] = [
    { show: k.activeOrders !== undefined, icon: Package, label: "Active production orders", value: k.activeOrders ?? 0, hint: `${d.orders?.byStatus.DRAFT ?? 0} draft`, to: "/planning/production-job-order?status=RELEASED" },
    { show: k.releasedWorkOrders !== undefined, icon: PlayCircle, label: "Job Orders ready", value: k.releasedWorkOrders ?? 0, hint: "Released, not started", to: "/planning/job-order?status=RELEASED" },
    { show: k.inProgress !== undefined, icon: Cog, label: "Job Orders in progress", value: k.inProgress ?? 0, hint: `${d.jobs?.byStatus.ON_HOLD ?? 0} on hold`, to: "/planning/job-order?status=IN_PROGRESS,PARTIALLY_COMPLETED", tone: "primary" },
    { show: k.completed !== undefined, icon: CheckCircle2, label: `Completed · ${PERIOD_LABEL[period].toLowerCase()}`, value: k.completed ?? 0, hint: "Job Orders confirmed complete", to: `/planning/job-order?status=COMPLETED&completedFrom=${localDay(d.period.from)}`, tone: "success" },
    { show: k.overdue !== undefined, icon: CalendarClock, label: "Overdue Job Orders", value: k.overdue ?? 0, hint: `${d.jobs?.dueToday ?? 0} due today · ${d.jobs?.dueWeek ?? 0} this week`, to: "/planning/job-order?due=overdue", tone: k.overdue ? "danger" : "success" },
    { show: k.pendingMrs !== undefined, icon: Truck, label: "MRS waiting for material", value: k.pendingMrs ?? 0, hint: `${d.material?.partiallyIssued ?? 0} partly issued`, to: "/planning/material-requisition-sheet?status=OPEN,PARTIALLY_ISSUED&activeJob=1", tone: k.pendingMrs ? "warning" : undefined },
    { show: k.activeWip !== undefined, icon: Layers, label: "Active WIP steps", value: k.activeWip ?? 0, hint: d.wip ? `${d.wip.running} running · ${d.wip.waiting} waiting` : "", to: "/shopfloor/wip-check-in-out?status=RUNNING" },
    { show: k.pendingQc !== undefined, icon: ClipboardCheck, label: "QC lots pending", value: k.pendingQc ?? 0, hint: `${d.quality?.lots.reduce((a, l) => a + l.onHold, 0) ?? 0} on hold`, to: qcPath, tone: d.quality?.lots.some((l) => l.onHold) ? "warning" : undefined },
  ];
  const shown = cards.filter((c) => c.show);
  if (!shown.length) return null;
  return (
    <section className="grid grid-cols-2 gap-3 md:grid-cols-4" aria-label="Key figures">
      {shown.map((c) => (
        <Link key={c.label} to={c.to} className="group min-w-0 rounded-lg border border-line bg-surface px-3 py-2.5 transition hover:border-primary hover:shadow-sm" title={`Open: ${c.label}`}>
          <p className="flex items-center gap-1.5 text-[11px] leading-tight font-medium text-muted">
            <c.icon className={cn("size-3.5 shrink-0", c.tone ? TONE[c.tone] : "text-primary")} />
            <span className="truncate">{c.label}</span>
          </p>
          <p className={cn("mt-0.5 text-2xl font-semibold tabular-nums", c.tone === "danger" && c.value > 0 && TONE.danger)}>{fmt(c.value)}</p>
          <p className="truncate text-[11px] text-muted">{c.hint}</p>
        </Link>
      ))}
    </section>
  );
}

function MyWork({ rows }: { rows: NonNullable<Dash["mine"]> }) {
  return (
    <Card title="My work – checked in">
      <ul className="grid gap-2 md:grid-cols-2 xl:grid-cols-3">
        {rows.map((s) => (
          <li key={s.sessionNo}>
            <Link to={`/hh/m/${s.machineId}`} className="flex items-center gap-3 rounded-md border border-primary/40 bg-primary-soft px-3 py-2 hover:border-primary">
              <Factory className="size-5 shrink-0 text-primary" />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-semibold">
                  {s.woNo} · {s.process} on {s.machine}
                </span>
                <span className="block text-xs text-muted">
                  Since {formatDateTime(s.since)} · good {fmt(s.good)} {s.uom}
                </span>
              </span>
              <ChevronRight className="size-4 text-muted" />
            </Link>
          </li>
        ))}
      </ul>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Alerts & pending actions
// ---------------------------------------------------------------------------

const SEV: Record<Severity, { label: string; icon: LucideIcon; cls: string; chip: string }> = {
  critical: { label: "Critical", icon: AlertOctagon, cls: "text-danger", chip: "bg-danger text-white" },
  high: { label: "High", icon: AlertTriangle, cls: "text-danger", chip: "bg-danger-soft text-danger" },
  medium: { label: "Medium", icon: AlertTriangle, cls: "text-warning", chip: "bg-warning-soft text-warning" },
  low: { label: "Low", icon: Info, cls: "text-info", chip: "bg-info-soft text-info" },
};
function Alerts({ alerts }: { alerts: Dash["alerts"] }) {
  const [all, setAll] = useState(false);
  const counts = (["critical", "high", "medium", "low"] as Severity[]).map((s) => [s, alerts.filter((a) => a.severity === s).length] as const).filter(([, n]) => n);
  const list = all ? alerts : alerts.slice(0, 8);
  return (
    <Card
      title={
        <span className="flex flex-wrap items-center gap-2">
          Alerts & pending actions
          {counts.map(([s, n]) => (
            <span key={s} className={cn("rounded-full px-2 py-0.5 text-xs font-semibold", SEV[s].chip)}>
              {n} {SEV[s].label.toLowerCase()}
            </span>
          ))}
        </span>
      }
    >
      {!alerts.length ? (
        <p className="flex items-center gap-2 py-4 text-sm text-muted">
          <CheckCircle2 className="size-5 text-success" /> Nothing needs action: no breakdowns, overdue jobs, failed lots, open sessions or material gaps.
        </p>
      ) : (
        <>
          <ul className="-my-1 divide-y divide-line">
            {list.map((a) => {
              const S = SEV[a.severity];
              return (
                <li key={a.key}>
                  <Link to={a.path} className="group grid grid-cols-[auto_minmax(0,1fr)_auto] items-start gap-3 py-2.5">
                    <S.icon className={cn("mt-0.5 size-4", S.cls)} aria-label={S.label} />
                    <span className="min-w-0">
                      <span className="flex flex-wrap items-baseline gap-x-2 text-sm">
                        <span className="font-semibold group-hover:text-primary">{a.record}</span>
                        <span className="text-xs text-muted">{a.type}</span>
                      </span>
                      <span className="block text-xs text-muted">{a.reason}</span>
                      <span className="mt-0.5 block text-xs">
                        <span className="font-medium text-primary">{a.action}</span> <span className="text-muted">· {a.role}</span>
                      </span>
                    </span>
                    <span className="text-right text-[11px] whitespace-nowrap text-muted">{a.at ? ago(a.at) : ""}</span>
                  </Link>
                </li>
              );
            })}
          </ul>
          {alerts.length > 8 && (
            <button onClick={() => setAll((v) => !v)} className="mt-2 text-sm text-primary hover:underline">
              {all ? "Show fewer" : `Show all ${alerts.length}`}
            </button>
          )}
        </>
      )}
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Production progress
// ---------------------------------------------------------------------------

const WO_ORDER = ["PLANNED", "RELEASED", "IN_PROGRESS", "PARTIALLY_COMPLETED", "ON_HOLD"] as const;
const WO_BAR: Record<string, string> = { PLANNED: "bg-neutral-soft", RELEASED: "bg-info", IN_PROGRESS: "bg-primary", PARTIALLY_COMPLETED: "bg-warning", ON_HOLD: "bg-danger" };
function ProductionProgress({ jobs, orders, period }: { jobs: NonNullable<Dash["jobs"]>; orders?: Dash["orders"]; period: Period }) {
  const open = WO_ORDER.map((s) => [s, jobs.byStatus[s] ?? 0] as const);
  const total = open.reduce((a, [, n]) => a + n, 0);
  return (
    <Card title="Production progress">
      <div className="space-y-4">
        {!jobs.progress.length ? (
          <p className="text-sm text-muted">No released Job Orders in production.</p>
        ) : (
          jobs.progress.map((p) => {
            const pct = p.planned ? Math.min(100, (p.output / p.planned) * 100) : 0;
            return (
              <div key={p.uom}>
                <div className="mb-1 flex flex-wrap items-baseline justify-between gap-x-3 text-sm">
                  <span className="font-medium">
                    {p.workOrders} open Job Order{p.workOrders === 1 ? "" : "s"} <span className="text-xs text-muted">({p.uom})</span>
                  </span>
                  <span className="text-xs text-muted">
                    <span className="font-semibold text-text tabular-nums">{fmt(p.output)}</span> of {fmt(p.planned)} finished · {fmt(p.remaining)} to go
                  </span>
                </div>
                <div className="h-2.5 overflow-hidden rounded-full bg-neutral-soft" role="progressbar" aria-valuenow={Math.round(pct)} aria-valuemin={0} aria-valuemax={100} aria-label={`Finished output ${p.uom}`}>
                  <div className="h-full rounded-full bg-primary" style={{ width: `${pct}%` }} />
                </div>
                <p className="mt-0.5 text-right text-[11px] text-muted">{pct.toFixed(0)}% · finished output = good quantity of the last route step</p>
              </div>
            );
          })
        )}
        <div>
          <p className="mb-1.5 text-xs font-semibold tracking-wide text-muted uppercase">Open Job Orders by status</p>
          {total === 0 ? (
            <p className="text-sm text-muted">None open.</p>
          ) : (
            <>
              <div className="flex h-3 gap-0.5 overflow-hidden rounded" role="img" aria-label={open.map(([s, n]) => `${s} ${n}`).join(", ")}>
                {open.filter(([, n]) => n).map(([s, n]) => (
                  <div key={s} className={WO_BAR[s]} style={{ width: `${(n / total) * 100}%` }} title={`${s}: ${n}`} />
                ))}
              </div>
              <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1.5 text-xs">
                {open.map(([s, n]) => (
                  <Link key={s} to={`/planning/job-order?status=${s}`} className="flex items-center gap-1.5 hover:text-primary">
                    <span className={cn("size-2.5 rounded-sm", WO_BAR[s])} />
                    <StatusBadge kind="wo" value={s} /> <span className="font-semibold tabular-nums">{n}</span>
                  </Link>
                ))}
              </div>
            </>
          )}
        </div>
        <div className="grid grid-cols-2 gap-2 text-sm">
          <div className="rounded-md bg-surface-2 px-3 py-2">
            <p className="text-xs text-muted">Completed · {PERIOD_LABEL[period].toLowerCase()}</p>
            {jobs.completedInPeriod.length ? (
              jobs.completedInPeriod.map((c) => (
                <p key={c.uom} className="tabular-nums">
                  <span className="font-semibold">{c.workOrders}</span> JO · {fmt(c.good)} {c.uom}
                </p>
              ))
            ) : (
              <p className="font-semibold">0</p>
            )}
          </div>
          <div className="rounded-md bg-surface-2 px-3 py-2">
            <p className="text-xs text-muted">Planning gaps</p>
            <p>
              <span className="font-semibold">{jobs.unscheduled}</span> without a planned date
            </p>
            {orders && orders.releasedWithoutJobs > 0 && (
              <p>
                <span className="font-semibold">{orders.releasedWithoutJobs}</span> order{orders.releasedWithoutJobs === 1 ? "" : "s"} without Job Orders
              </p>
            )}
          </div>
        </div>
      </div>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Schedule
// ---------------------------------------------------------------------------

type SortKey = "due" | "woNo" | "remaining" | "status";
const DUE_LABEL: Record<ScheduleRow["due"], { text: string; cls: string }> = {
  overdue: { text: "Overdue", cls: "bg-danger-soft text-danger" },
  today: { text: "Due today", cls: "bg-warning-soft text-warning" },
  week: { text: "This week", cls: "bg-info-soft text-info" },
  later: { text: "Later", cls: "bg-neutral-soft text-muted" },
  none: { text: "No date", cls: "bg-neutral-soft text-muted" },
};
function Schedule({ rows, jobs }: { rows: ScheduleRow[]; jobs: NonNullable<Dash["jobs"]> }) {
  const [sort, setSort] = useState<{ key: SortKey; dir: 1 | -1 }>({ key: "due", dir: 1 });
  const sorted = useMemo(() => {
    if (sort.key === "due") return sort.dir === 1 ? rows : [...rows].reverse();
    const v = (r: ScheduleRow) => (sort.key === "remaining" ? Number(r.remaining) : sort.key === "woNo" ? r.woNo : r.status);
    return [...rows].sort((a, b) => (v(a) > v(b) ? 1 : v(a) < v(b) ? -1 : 0) * sort.dir);
  }, [rows, sort]);
  const Th = ({ k, children, className }: { k: SortKey; children: ReactNode; className?: string }) => (
    <th className={cn("py-2 font-medium", className)} aria-sort={sort.key === k ? (sort.dir === 1 ? "ascending" : "descending") : "none"}>
      <button className="inline-flex items-center gap-1 hover:text-text" onClick={() => setSort((s) => ({ key: k, dir: s.key === k ? ((-s.dir) as 1 | -1) : 1 }))}>
        {children}
        {sort.key === k && (sort.dir === 1 ? <ArrowUp className="size-3" /> : <ArrowDown className="size-3" />)}
      </button>
    </th>
  );
  return (
    <Card
      title={
        <span className="flex flex-wrap items-center gap-2">
          Production schedule
          <span className="text-xs font-normal text-muted">
            Open Job Orders by required date · {jobs.overdue} overdue · {jobs.dueToday} today · {jobs.dueWeek} this week
          </span>
        </span>
      }
      actions={
        <Link to="/planning/job-order" className="text-sm text-primary hover:underline">
          All Job Orders
        </Link>
      }
    >
      {!rows.length ? (
        <p className="py-3 text-sm text-muted">No open Job Orders.</p>
      ) : (
        <div className="relative -mx-5 overflow-x-auto">
          <table className="w-full min-w-[56rem] text-sm">
            <thead>
              <tr className="border-b border-line text-left text-xs text-muted">
                <Th k="woNo" className="pl-5">
                  Job Order
                </Th>
                <th className="py-2 font-medium">Customer ref.</th>
                <th className="py-2 font-medium">Product</th>
                <th className="py-2 text-right font-medium">Planned</th>
                <th className="py-2 text-right font-medium">Finished</th>
                <Th k="remaining" className="text-right">
                  Remaining
                </Th>
                <Th k="due" className="pl-4">
                  Required
                </Th>
                <Th k="status">Status</Th>
                <th className="py-2 pr-5 font-medium">Priority</th>
              </tr>
            </thead>
            <tbody>
              {sorted.map((r) => (
                <tr key={r.id} className="border-b border-line last:border-0 hover:bg-surface-2">
                  <td className="py-2 pl-5">
                    <Link to={`/planning/job-order/${r.id}`} className="font-medium text-primary hover:underline">
                      {r.woNo}
                    </Link>
                    <Link to={`/planning/production-job-order/${r.pjoId}`} className="block text-xs text-muted hover:text-primary">
                      {r.pjoNo}
                    </Link>
                  </td>
                  <td className="py-2 text-xs">{r.customerRef ?? <span className="text-muted">—</span>}</td>
                  <td className="max-w-60 py-2">
                    <span className="block truncate">{r.fatherCode}</span>
                    <span className="block truncate text-xs text-muted">{r.currentProcess}</span>
                  </td>
                  <td className="py-2 text-right tabular-nums">{fmt(r.planned)}</td>
                  <td className="py-2 text-right tabular-nums">{fmt(r.output)}</td>
                  <td className="py-2 text-right font-medium tabular-nums">
                    {fmt(r.remaining)} <span className="text-xs font-normal text-muted">{r.uom}</span>
                  </td>
                  <td className="py-2 pl-4 whitespace-nowrap">
                    {day(r.requiredDate)}
                    <span className={cn("ml-1.5 rounded px-1.5 py-0.5 text-[11px] font-medium", DUE_LABEL[r.due].cls)}>{DUE_LABEL[r.due].text}</span>
                    {!r.scheduled && <span className="block text-[11px] text-muted">No planned date</span>}
                  </td>
                  <td className="py-2">
                    <StatusBadge kind="wo" value={r.status} />
                  </td>
                  <td className="py-2 pr-5">
                    <StatusBadge kind="priority" value={r.priority} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Shopfloor
// ---------------------------------------------------------------------------

const MACHINE_ORDER = ["RUNNING", "IDLE", "AVAILABLE", "BREAKDOWN", "MAINTENANCE", "OFFLINE"];
const MACHINE_EDGE: Record<string, string> = { RUNNING: "border-l-primary", IDLE: "border-l-info", AVAILABLE: "border-l-success", BREAKDOWN: "border-l-danger", MAINTENANCE: "border-l-warning", OFFLINE: "border-l-line" };
function Machines({ floor, filtered }: { floor: NonNullable<Dash["floor"]>; filtered: boolean }) {
  return (
    <Card
      title={
        <span className="flex flex-wrap items-center gap-2">
          Shopfloor & machines {filtered && <Badge tone="info">Process filter</Badge>}
        </span>
      }
      actions={
        <Link to="/shopfloor/machine-output-control" className="text-sm text-primary hover:underline">
          Machine Output Control
        </Link>
      }
    >
      <div className="mb-3 flex flex-wrap gap-2">
        {MACHINE_ORDER.filter((s) => floor.counts[s]).map((s) => (
          <span key={s} className="inline-flex items-center gap-1.5 rounded-md bg-surface-2 px-2 py-1 text-sm">
            <StatusBadge kind="machine" value={s} /> <span className="font-semibold tabular-nums">{floor.counts[s]}</span>
          </span>
        ))}
        {!floor.machines.length && <span className="text-sm text-muted">No active machines{filtered ? " for this process" : ""}.</span>}
      </div>
      <ul className="grid max-h-[26rem] gap-2 overflow-y-auto sm:grid-cols-2">
        {floor.machines.map((m) => (
          <li key={m.id} className={cn("rounded-md border border-l-4 border-line bg-surface px-3 py-2", MACHINE_EDGE[m.status])}>
            <div className="flex items-center justify-between gap-2">
              <span className="min-w-0">
                <span className="font-semibold">{m.code}</span> <span className="text-xs text-muted">{m.category}</span>
              </span>
              <StatusBadge kind="machine" value={m.status} />
            </div>
            {m.session ? (
              <p className="mt-1 text-xs">
                <Link to={`/planning/job-order/${m.session.woId}`} className="font-medium text-primary hover:underline">
                  {m.session.woNo}
                </Link>{" "}
                · {m.session.process}
                <span className="block text-muted">
                  {m.session.operator ?? "Operator"} · since {formatDateTime(m.session.since)} · good {fmt(m.session.good)} {m.session.uom}
                </span>
              </p>
            ) : m.breakdown ? (
              <p className="mt-1 text-xs text-danger">
                {m.breakdown.breakdownNo} · {m.breakdown.reason} · {ago(m.breakdown.since)}
              </p>
            ) : (
              <p className="mt-1 text-xs text-muted">No session · status since {ago(m.statusSince)}</p>
            )}
            {m.lastOutput && <p className="text-[11px] text-muted">Last output {ago(m.lastOutput.at)} ({fmt(m.lastOutput.good)} good)</p>}
          </li>
        ))}
      </ul>
    </Card>
  );
}

/** Good output per plant day – one series (no legend); hover shows good, reject and reject %. */
function OutputChart({ days, period }: { days: { date: string; good: number; reject: number }[]; period: Period }) {
  const [hover, setHover] = useState<number | null>(null);
  const max = Math.max(1, ...days.map((x) => x.good));
  const good = days.reduce((a, b) => a + b.good, 0);
  const reject = days.reduce((a, b) => a + b.reject, 0);
  const H = 150;
  const many = days.length > 10;
  const label = (iso: string) => new Date(`${iso}T00:00:00`).toLocaleDateString(undefined, many ? { day: "numeric" } : { weekday: "short" });
  return (
    <Card title={`Good output per day · last ${days.length} days`}>
      <p className="mb-3 text-sm text-muted">
        <span className="text-2xl font-semibold text-text tabular-nums">{fmt(days[days.length - 1]?.good ?? 0)}</span> today · {fmt(good)} in {days.length} days · reject {good + reject ? ((reject / (good + reject)) * 100).toFixed(1) : "0.0"}%
        {period !== "today" && <span className="block text-[11px]">All route steps, units as recorded.</span>}
      </p>
      {good + reject === 0 ? (
        <p className="py-8 text-center text-sm text-muted">No output recorded in this range.</p>
      ) : (
        <div className="relative">
          <div className="flex items-end gap-0.5 border-b border-line" style={{ height: H }} onMouseLeave={() => setHover(null)}>
            {days.map((x, i) => (
              <div key={x.date} tabIndex={0} onMouseEnter={() => setHover(i)} onFocus={() => setHover(i)} onBlur={() => setHover(null)} className="flex h-full min-w-0 flex-1 items-end justify-center px-[1px]" aria-label={`${x.date}: ${fmt(x.good)} good, ${fmt(x.reject)} reject`}>
                <div className={cn("w-full max-w-9 rounded-t bg-primary transition-opacity", hover !== null && hover !== i && "opacity-45")} style={{ height: `${x.good ? Math.max(2, (x.good / max) * (H - 8)) : 0}px` }} />
              </div>
            ))}
          </div>
          <div className="mt-1 flex gap-0.5 text-center text-[10px] text-muted">
            {days.map((x, i) => (
              <span key={x.date} className={cn("min-w-0 flex-1 truncate", i === days.length - 1 && "font-semibold text-text")}>
                {i === days.length - 1 ? "Today" : many && i % 3 ? "" : label(x.date)}
              </span>
            ))}
          </div>
          {hover !== null && days[hover] && (
            <div className="pointer-events-none absolute top-0 w-36 rounded-md border border-line bg-surface px-2.5 py-1.5 text-xs shadow-md" style={{ left: `clamp(0px, calc(${((hover + 0.5) / days.length) * 100}% - 4.5rem), calc(100% - 9rem))` }}>
              <p className="font-semibold">{day(days[hover].date)}</p>
              <p>Good {fmt(days[hover].good)}</p>
              <p className="text-muted">
                Reject {fmt(days[hover].reject)}
                {days[hover].good + days[hover].reject ? ` (${((days[hover].reject / (days[hover].good + days[hover].reject)) * 100).toFixed(1)}%)` : ""}
              </p>
            </div>
          )}
          <table className="sr-only">
            <caption>Good and reject output per day</caption>
            <thead>
              <tr>
                <th>Day</th>
                <th>Good</th>
                <th>Reject</th>
              </tr>
            </thead>
            <tbody>
              {days.map((x) => (
                <tr key={x.date}>
                  <td>{x.date}</td>
                  <td>{x.good}</td>
                  <td>{x.reject}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}

// ---------------------------------------------------------------------------
// WIP, material, quality
// ---------------------------------------------------------------------------

const WIP_KIND = { running: { text: "Running", cls: "bg-primary-soft text-primary" }, waiting: { text: "Waiting", cls: "bg-warning-soft text-warning" }, paused: { text: "Paused", cls: "bg-neutral-soft text-muted" } } as const;
function Wip({ wip, filtered, className }: { wip: NonNullable<Dash["wip"]>; filtered: boolean; className?: string }) {
  return (
    <Card
      className={className}
      title={
        <span className="flex flex-wrap items-center gap-2">
          WIP {filtered && <Badge tone="info">Process filter</Badge>}
        </span>
      }
      actions={
        <Link to="/shopfloor/wip-check-in-out" className="text-sm text-primary hover:underline">
          Check In/Out
        </Link>
      }
    >
      <div className="mb-3 grid grid-cols-3 gap-2 text-center">
        {(["running", "waiting", "paused"] as const).map((k) => (
          <div key={k} className="rounded-md bg-surface-2 py-1.5">
            <p className="text-lg font-semibold tabular-nums">{wip[k]}</p>
            <p className="text-[11px] text-muted">{k === "running" ? "Checked in" : k === "waiting" ? "Awaiting next step" : "Paused (not done)"}</p>
          </div>
        ))}
      </div>
      {!wip.rows.length ? (
        <p className="text-sm text-muted">No work in process.</p>
      ) : (
        <ul className="-my-1 divide-y divide-line text-sm">
          {wip.rows.map((r, i) => (
            <li key={`${r.woId}-${r.process}-${i}`}>
              <Link to={`/planning/job-order/${r.woId}`} className="group flex items-center gap-2 py-2">
                <span className={cn("w-16 shrink-0 rounded px-1.5 py-0.5 text-center text-[11px] font-medium", WIP_KIND[r.kind].cls)}>{WIP_KIND[r.kind].text}</span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-medium group-hover:text-primary">
                    {r.woNo} · {r.process}
                  </span>
                  <span className="block truncate text-xs text-muted">
                    {r.fatherCode}
                    {r.previous ? ` · from ${r.previous}` : ""}
                    {r.machine ? ` · ${r.machine}` : ""} · {r.lastMovement ? ago(r.lastMovement) : "no movement yet"}
                  </span>
                </span>
                <span className="shrink-0 text-right text-xs tabular-nums">
                  {fmt(r.qty)} <span className="text-muted">{r.uom}</span>
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

function Material({ m, period }: { m: NonNullable<Dash["material"]>; period: Period }) {
  const mv = (k: string) => m.movements[k] ?? 0;
  return (
    <Card
      title="Material & requisitions"
      actions={
        <Link to="/planning/material-movement" className="text-sm text-primary hover:underline">
          Movements
        </Link>
      }
    >
      <div className="mb-3 grid grid-cols-3 gap-2 text-center">
        <Link to="/planning/material-requisition-sheet?status=OPEN&activeJob=1" className="rounded-md bg-surface-2 py-1.5 hover:bg-primary-soft">
          <p className="text-lg font-semibold tabular-nums">{m.open}</p>
          <p className="text-[11px] text-muted">Not issued</p>
        </Link>
        <Link to="/planning/material-requisition-sheet?status=PARTIALLY_ISSUED&activeJob=1" className="rounded-md bg-surface-2 py-1.5 hover:bg-primary-soft">
          <p className="text-lg font-semibold tabular-nums">{m.partiallyIssued}</p>
          <p className="text-[11px] text-muted">Partly issued</p>
        </Link>
        <div className={cn("rounded-md py-1.5", m.productionStartedWaiting ? "bg-danger-soft text-danger" : "bg-surface-2")}>
          <p className="text-lg font-semibold tabular-nums">{m.productionStartedWaiting}</p>
          <p className="text-[11px]">Running short</p>
        </div>
      </div>
      <p className="mb-1 text-xs font-semibold tracking-wide text-muted uppercase">Movements · {PERIOD_LABEL[period].toLowerCase()}</p>
      <div className="mb-3 grid grid-cols-4 gap-1.5 text-center text-xs">
        {(
          [
            ["ADDITIONAL_ISSUE", "Additional"],
            ["RETURN", "Returned"],
            ["REJECT", "Rejected"],
            ["SCRAP", "Scrapped"],
          ] as const
        ).map(([k, l]) => (
          <Link key={k} to={`/planning/material-movement?type=${k}`} className="rounded bg-surface-2 py-1 hover:bg-primary-soft">
            <span className="block font-semibold tabular-nums">{mv(k)}</span>
            <span className="text-muted">{l}</span>
          </Link>
        ))}
      </div>
      {m.waiting.length > 0 && (
        <ul className="-my-1 divide-y divide-line text-sm">
          {m.waiting.slice(0, 5).map((r) => (
            <li key={r.id}>
              <Link to={`/planning/material-requisition-sheet/${r.id}`} className="group flex items-center gap-2 py-1.5">
                <span className="min-w-0 flex-1 truncate">
                  <span className="font-medium group-hover:text-primary">{r.mrsNo}</span> <span className="text-xs text-muted">· {r.woNo}</span>
                </span>
                <span className="text-xs text-muted">
                  {r.linesOpen}/{r.lines} lines open
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
      <p className="mt-3 flex gap-1.5 text-[11px] text-muted">
        <Info className="mt-0.5 size-3 shrink-0" /> {m.external}
      </p>
    </Card>
  );
}

function Quality({ q, period }: { q: NonNullable<Dash["quality"]>; period: Period }) {
  return (
    <Card title={`Quality · ${PERIOD_LABEL[period].toLowerCase()}`}>
      <div className="space-y-4">
        {q.lots.map((l) => {
          const done = l.passed + l.failed;
          const rate = done ? (l.passed / done) * 100 : null;
          const path = `/qc/${l.type.toLowerCase()}-check-in-out`;
          return (
            <div key={l.type}>
              <div className="mb-1.5 flex items-baseline justify-between text-sm">
                <Link to={path} className="font-semibold hover:text-primary">
                  {l.type}
                </Link>
                <span className="text-xs text-muted">{rate === null ? "No lots checked out" : `${rate.toFixed(0)}% passed first time (${l.passed} / ${done})`}</span>
              </div>
              {rate !== null && (
                <div className="mb-2 flex h-2 gap-0.5 overflow-hidden rounded-full" role="img" aria-label={`${l.type}: ${l.passed} passed, ${l.failed} failed`}>
                  {l.passed > 0 && <div className="bg-success" style={{ width: `${rate}%` }} />}
                  {l.failed > 0 && <div className="flex-1 bg-danger" />}
                </div>
              )}
              <div className="grid grid-cols-4 gap-1.5 text-center text-xs">
                <Link to={`${path}?view=open`} className="rounded bg-surface-2 py-1 hover:bg-primary-soft">
                  <span className="block font-semibold tabular-nums">{l.inInspection}</span>
                  <span className="text-muted">Inspecting</span>
                </Link>
                <Link to={`${path}?view=open`} className={cn("rounded py-1", l.onHold ? "bg-warning-soft text-warning" : "bg-surface-2")}>
                  <span className="block font-semibold tabular-nums">{l.onHold}</span>
                  <span>On hold</span>
                </Link>
                <div className="rounded bg-surface-2 py-1">
                  <span className="block font-semibold tabular-nums">{l.failed}</span>
                  <span className="text-muted">Failed</span>
                </div>
                <div className="rounded bg-surface-2 py-1">
                  <span className="block font-semibold tabular-nums">{l.rejected}</span>
                  <span className="text-muted">Rejected</span>
                </div>
              </div>
              {(l.inRework > 0 || l.concession > 0) && (
                <p className="mt-1 text-[11px] text-muted">
                  {l.inRework > 0 && `${l.inRework} in rework`}
                  {l.inRework > 0 && l.concession > 0 && " · "}
                  {l.concession > 0 && `${l.concession} accepted on concession`}
                </p>
              )}
            </div>
          );
        })}
      </div>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Recent activity
// ---------------------------------------------------------------------------

const KIND: Record<string, { icon: LucideIcon; cls: string }> = {
  order: { icon: Package, cls: "text-info" },
  start: { icon: PlayCircle, cls: "text-primary" },
  end: { icon: ActivityIcon, cls: "text-primary" },
  done: { icon: CheckCircle2, cls: "text-success" },
  material: { icon: Truck, cls: "text-warning" },
  qc: { icon: ClipboardCheck, cls: "text-success" },
  fail: { icon: AlertTriangle, cls: "text-danger" },
};
function RecentActivity({ rows }: { rows: Dash["activity"] }) {
  return (
    <Card title="Recent manufacturing activity">
      <ol className="grid gap-x-6 md:grid-cols-2">
        {rows.map((a, i) => {
          const K = KIND[a.kind] ?? KIND.order!;
          return (
            <li key={i} className="border-b border-line last:border-0 md:[&:nth-last-child(2)]:border-0">
              <Link to={a.path} className="group flex items-start gap-2.5 py-2">
                <K.icon className={cn("mt-0.5 size-4 shrink-0", K.cls)} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm">
                    <span className="font-medium group-hover:text-primary">{a.record}</span> · {a.text}
                  </span>
                  <span className="block text-xs text-muted">
                    {a.by ?? "System"} · {formatDateTime(a.at)}
                  </span>
                </span>
              </Link>
            </li>
          );
        })}
      </ol>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Quick find and Start (actions, not module navigation)
// ---------------------------------------------------------------------------

function QuickFind() {
  const navigate = useNavigate();
  const [q, setQ] = useState("");
  const [debounced, setDebounced] = useState("");
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(q.trim()), 220);
    return () => clearTimeout(t);
  }, [q]);
  const hits = useQuery({ queryKey: ["dashboard", "find", debounced], queryFn: () => api.get<Hit[]>(`/dashboard/find${qs({ q: debounced })}`), enabled: debounced.length >= 2 });
  useEffect(() => setActive(0), [hits.data]);
  useEffect(() => {
    const close = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, []);
  const list = hits.data ?? [];
  const go = (h: Hit) => (setOpen(false), navigate(h.path));
  return (
    <div ref={ref} className="relative w-full sm:w-72">
      <label className="flex h-9 items-center gap-2 rounded-lg border border-line bg-surface px-2.5 focus-within:border-focus focus-within:ring-2 focus-within:ring-focus/30">
        <Search className="size-4 shrink-0 text-muted" />
        <input
          value={q}
          onChange={(e) => (setQ(e.target.value), setOpen(true))}
          onFocus={() => setOpen(true)}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown") (e.preventDefault(), setActive((a) => Math.min(a + 1, list.length - 1)));
            if (e.key === "ArrowUp") (e.preventDefault(), setActive((a) => Math.max(a - 1, 0)));
            if (e.key === "Enter" && list[active]) go(list[active]);
            if (e.key === "Escape") setOpen(false);
          }}
          placeholder="Find JO, PJO, MRS, part, lot…"
          className="h-full min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-muted"
          aria-label="Quick find"
          role="combobox"
          aria-expanded={open && debounced.length >= 2}
          aria-controls="quick-find-list"
        />
        {hits.isFetching && <Spinner className="size-4" />}
      </label>
      {open && debounced.length >= 2 && (
        <ul id="quick-find-list" role="listbox" className="absolute top-10 right-0 z-30 max-h-96 w-[min(26rem,calc(100vw-2rem))] overflow-auto rounded-lg border border-line bg-surface p-1 shadow-xl">
          {!hits.isFetching && !list.length && <li className="px-3 py-2 text-sm text-muted">Nothing matches “{debounced}”.</li>}
          {list.map((h, i) => (
            <li key={`${h.type}-${h.path}`} role="option" aria-selected={i === active}>
              <button onMouseEnter={() => setActive(i)} onClick={() => go(h)} className={cn("flex w-full items-center gap-3 rounded-md px-3 py-2 text-left", i === active && "bg-primary-soft")}>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium">{h.label}</span>
                  <span className="block truncate text-xs text-muted">{h.detail}</span>
                </span>
                <span className="shrink-0 rounded bg-surface-2 px-1.5 py-0.5 text-[11px] text-muted">{h.type}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** Create actions (guided journeys) in one menu – not a module directory. */
function StartMenu() {
  const { can } = useAuth();
  const flows = GUIDED_FLOWS.filter((f) => can(f.permission) && f.id !== "finish" && f.id !== "handheld");
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const close = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, []);
  if (!flows.length) return null;
  return (
    <div ref={ref} className="relative">
      <button onClick={() => setOpen((v) => !v)} aria-expanded={open} className="inline-flex h-9 items-center gap-1.5 rounded-lg bg-primary px-3 text-sm font-medium text-on-primary hover:bg-primary-hover">
        <Plus className="size-4" /> Start
      </button>
      {open && (
        <ul className="absolute top-10 right-0 z-30 w-72 rounded-lg border border-line bg-surface p-1 shadow-xl">
          {flows.map((f) => (
            <li key={f.id}>
              <Link to={f.path} onClick={() => setOpen(false)} className="flex items-start gap-2.5 rounded-md px-3 py-2 hover:bg-primary-soft">
                <f.icon className="mt-0.5 size-4 shrink-0 text-primary" />
                <span className="min-w-0">
                  <span className="block text-sm font-medium">{f.label}</span>
                  <span className="block text-xs text-muted">{f.steps.join(" → ")}</span>
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
