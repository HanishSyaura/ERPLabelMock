import { useQuery } from "@tanstack/react-query";
import { RefreshCw } from "lucide-react";
import { useCallback, useState } from "react";
import { Link, useSearchParams } from "react-router";
import { DataTable, ErrorState, LoadingState, PageHeader, SearchInput, Tabs, type Column } from "@/components/common";
import { checkoutLabel, StatusBadge } from "@/components/status";
import { Button, Checkbox, Dialog, Field, Input, Select } from "@/components/ui";
import { api, qs } from "@/lib/api";
import { useFormError } from "@/lib/use-form-error";
import { formatDateTime } from "@/lib/utils";
import { useAuth } from "@/stores/auth";
import { useToast } from "@/stores/toast";
import { useMachines, usePlanningMutation, type MachineStatus } from "@/modules/planning/api";

interface BoardMachine {
  id: string;
  code: string;
  name: string;
  category: { code: string; name: string };
  status: MachineStatus;
  statusChangedAt: string;
  openBreakdown: { id: string; breakdownNo: string; reason: string; status: string; reportedAt: string } | null;
  session: { id: string; sessionNo: string; woNo: string; workOrderId: string; process: string; operator: string | null; checkInAt: string; machineGood: string; machineReject: string; processGood: string; target: string; uom: string } | null;
}
interface Breakdown {
  id: string;
  breakdownNo: string;
  machine: { id: string; code: string; name: string };
  woNo: string | null;
  workOrderId: string | null;
  reason: string;
  remarks: string | null;
  status: "OPEN" | "UNDER_MAINTENANCE" | "RESOLVED";
  reportedAt: string;
  reportedBy: string | null;
  lastConfirmedGood: string | null;
  maintenanceNote: string | null;
  resolvedAt: string | null;
  resolvedBy: string | null;
  resolutionNote: string | null;
  downtimeMinutes: number;
}
interface Change {
  id: string;
  workOrderId: string;
  woNo: string;
  process: string;
  from: { code: string } | null;
  to: { code: string } | null;
  prevMachineGood: string;
  prevMachineReject: string;
  outstandingQty: string;
  reason: string;
  status: "PENDING" | "APPROVED" | "REJECTED";
  requestedBy: string | null;
  requestedAt: string;
  decidedBy: string | null;
  decisionNote: string | null;
}

const reasonLabel = (r: string) => r.replace(/_/g, " ").toLowerCase().replace(/^./, (c) => c.toUpperCase());
const minutes = (m: number) => (m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${m % 60} min`);
const today = () => new Date().toISOString().slice(0, 10);
const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);

type Tab = "board" | "output" | "utilization" | "breakdowns" | "changes";

/** Shopfloor › Machine Output Control: consolidated monitoring for supervisors and planners. */
export function MachineOutputControlPage() {
  const [params, setParams] = useSearchParams();
  const tab = (params.get("tab") as Tab) || "board";
  const summary = useQuery({
    queryKey: ["shopfloor", "summary"],
    queryFn: () => api.get<{ machinesByStatus: Record<string, number>; runningSessions: number; pendingMachineChanges: number; openBreakdowns: number; activeWorkOrders: number }>("/shopfloor/summary"),
    refetchInterval: 30_000,
  });
  const s = summary.data;
  return (
    <>
      <PageHeader
        title="Machine Output Control"
        description="Live machine status, machine-wise and Job Order-wise output, utilisation, breakdowns and machine changes. All figures come from Check In / Check Out records."
        crumbs={[{ label: "Shopfloor" }, { label: "Machine Output Control" }]}
      />
      {s && (
        <div className="mb-4 grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
          {(
            [
              ["Running", s.machinesByStatus.RUNNING ?? 0, "primary"],
              ["Available", s.machinesByStatus.AVAILABLE ?? 0, "success"],
              ["Idle (work paused)", s.machinesByStatus.IDLE ?? 0, "info"],
              ["Breakdown / Maintenance", (s.machinesByStatus.BREAKDOWN ?? 0) + (s.machinesByStatus.MAINTENANCE ?? 0), "danger"],
              ["Machine changes waiting", s.pendingMachineChanges, "warning"],
              ["Active Job Orders", s.activeWorkOrders, "neutral"],
            ] as const
          ).map(([label, n]) => (
            <div key={label} className="rounded-lg border border-line bg-surface px-3 py-2">
              <p className="text-xs text-muted">{label}</p>
              <p className="text-xl font-semibold tabular-nums">{n}</p>
            </div>
          ))}
        </div>
      )}
      <Tabs<Tab>
        value={tab}
        onChange={(t) => setParams(t === "board" ? {} : { tab: t })}
        tabs={[
          { id: "board", label: "Machines" },
          { id: "output", label: "Output" },
          { id: "utilization", label: "Utilisation & downtime" },
          { id: "breakdowns", label: `Breakdowns${s?.openBreakdowns ? ` (${s.openBreakdowns} open)` : ""}` },
          { id: "changes", label: `Machine changes${s?.pendingMachineChanges ? ` (${s.pendingMachineChanges})` : ""}` },
        ]}
      />
      {tab === "board" && <MachineBoard />}
      {tab === "output" && <OutputSummary />}
      {tab === "utilization" && <Utilization />}
      {tab === "breakdowns" && <Breakdowns />}
      {tab === "changes" && <MachineChanges />}
    </>
  );
}

function MachineBoard() {
  const { can } = useAuth();
  const board = useQuery({ queryKey: ["shopfloor", "board"], queryFn: () => api.get<BoardMachine[]>("/shopfloor/machine-board"), refetchInterval: 15_000 });
  const [statusFor, setStatusFor] = useState<BoardMachine | null>(null);
  if (board.isPending) return <LoadingState />;
  if (board.error) return <ErrorState error={board.error} onRetry={() => void board.refetch()} />;
  if (!board.data.length) return <p className="py-10 text-center text-sm text-muted">No active machines. Add machines under Planning › Machine.</p>;
  return (
    <>
      <div className="mb-2 flex items-center justify-end gap-2 text-xs text-muted">
        Refreshes every 15 s
        <Button size="sm" variant="ghost" icon={<RefreshCw className="size-4" />} onClick={() => void board.refetch()} aria-label="Refresh now" />
      </div>
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
        {board.data.map((m) => {
          const pct = m.session && Number(m.session.target) ? Math.min(100, Math.round((Number(m.session.processGood) / Number(m.session.target)) * 100)) : 0;
          return (
            <div key={m.id} className="min-w-0 rounded-lg border border-line bg-surface p-3">
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <p className="font-semibold">{m.code}</p>
                  <p className="truncate text-xs text-muted">
                    {m.name} · {m.category.name}
                  </p>
                </div>
                <StatusBadge kind="machine" value={m.status} />
              </div>
              {m.session ? (
                <div className="mt-3 space-y-1 text-sm">
                  <p>
                    <Link to={`/planning/job-order/${m.session.workOrderId}`} className="font-medium text-primary hover:underline">
                      {m.session.woNo}
                    </Link>{" "}
                    · {m.session.process}
                  </p>
                  <p className="text-xs text-muted">
                    {m.session.operator} · since {formatDateTime(m.session.checkInAt)}
                  </p>
                  <p className="text-xs">
                    This machine: <span className="font-semibold tabular-nums">{m.session.machineGood}</span> good / {m.session.machineReject} reject
                  </p>
                  <p className="text-xs text-muted">
                    Process total {m.session.processGood} of {m.session.target} {m.session.uom}
                  </p>
                  <div className="h-1.5 overflow-hidden rounded-full bg-neutral-soft">
                    <div className="h-full bg-primary" style={{ width: `${pct}%` }} />
                  </div>
                </div>
              ) : m.openBreakdown ? (
                <p className="mt-3 text-sm text-danger">
                  {m.openBreakdown.breakdownNo}: {reasonLabel(m.openBreakdown.reason)} · {formatDateTime(m.openBreakdown.reportedAt)}
                </p>
              ) : (
                <p className="mt-3 text-sm text-muted">No running session.</p>
              )}
              {can("shopfloor.breakdown.release") && !m.session && !m.openBreakdown && (
                <div className="mt-3 border-t border-line pt-2 text-right">
                  <Button size="sm" variant="ghost" onClick={() => setStatusFor(m)}>
                    Set status
                  </Button>
                </div>
              )}
            </div>
          );
        })}
      </div>
      {statusFor && <MachineStatusDialog machine={statusFor} onClose={() => setStatusFor(null)} />}
    </>
  );
}

function MachineStatusDialog({ machine, onClose }: { machine: BoardMachine; onClose: () => void }) {
  const toast = useToast();
  const [status, setStatus] = useState<"OFFLINE" | "MAINTENANCE" | "AVAILABLE">(machine.status === "AVAILABLE" || machine.status === "IDLE" ? "MAINTENANCE" : "AVAILABLE");
  const [note, setNote] = useState("");
  const [safety, setSafety] = useState(false);
  const { field, handle } = useFormError();
  const save = usePlanningMutation(() => api.put(`/shopfloor/machines/${machine.id}/status`, { status, note, safetyConfirmed: safety }));
  return (
    <Dialog
      open
      onClose={onClose}
      title={`Machine status – ${machine.code}`}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" loading={save.isPending} onClick={() => save.mutate(undefined, { onSuccess: () => (toast.success("Machine status updated."), onClose()), onError: handle })}>
            Save
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <p className="text-sm">
          Now: <StatusBadge kind="machine" value={machine.status} />
        </p>
        <Field label="New status">
          {(p) => (
            <Select {...p} value={status} onChange={(e) => setStatus(e.target.value as typeof status)}>
              <option value="MAINTENANCE">Maintenance (planned)</option>
              <option value="OFFLINE">Offline</option>
              <option value="AVAILABLE">Available</option>
            </Select>
          )}
        </Field>
        <Field label="Reason" required error={field("note")}>{(p) => <Input {...p} value={note} onChange={(e) => setNote(e.target.value)} />}</Field>
        {status === "AVAILABLE" && machine.status === "MAINTENANCE" && (
          <div>
            <Checkbox label="Physical inspection and safety clearance are done under the factory's procedure" checked={safety} onChange={(e) => setSafety(e.target.checked)} />
            {field("safetyConfirmed") && <p className="mt-1 text-xs text-danger">{field("safetyConfirmed")}</p>}
          </div>
        )}
      </div>
    </Dialog>
  );
}

function useRange() {
  const [params, setParams] = useSearchParams();
  const from = params.get("from") ?? daysAgo(7);
  const to = params.get("to") ?? today();
  const set = useCallback(
    (k: "from" | "to", v: string) =>
      setParams((prev) => {
        const n = new URLSearchParams(prev);
        n.set(k, v);
        return n;
      }),
    [setParams],
  );
  const iso = { from: new Date(`${from}T00:00:00`).toISOString(), to: new Date(`${to}T23:59:59.999`).toISOString() };
  const controls = (
    <div className="flex items-center gap-2">
      <Input type="date" value={from} onChange={(e) => set("from", e.target.value)} className="sm:w-40" aria-label="From" />
      <span className="text-muted">–</span>
      <Input type="date" value={to} onChange={(e) => set("to", e.target.value)} className="sm:w-40" aria-label="To" />
    </div>
  );
  return { iso, controls };
}

function OutputSummary() {
  const { iso, controls } = useRange();
  const [groupBy, setGroupBy] = useState<"machine" | "workOrder" | "process" | "operator">("machine");
  const rows = useQuery({
    queryKey: ["shopfloor", "output", groupBy, iso],
    queryFn: () => api.get<{ key: string; label: string; sub: string | null; good: string; reject: string; entries: number }[]>(`/shopfloor/output-summary${qs({ groupBy, ...iso })}`),
  });
  const label = { machine: "Machine", workOrder: "Job Order", process: "Process", operator: "Operator" }[groupBy];
  type Row = NonNullable<typeof rows.data>[number];
  const columns: Column<Row>[] = [
    {
      key: "label",
      header: label,
      cell: (r) => (
        <div>
          <p className="font-medium">{r.label}</p>
          {r.sub && <p className="text-xs text-muted">{r.sub}</p>}
        </div>
      ),
    },
    { key: "good", header: "Good output", className: "text-right", cell: (r) => <span className="tabular-nums">{r.good}</span> },
    { key: "reject", header: "Reject", className: "text-right", cell: (r) => <span className="tabular-nums">{r.reject}</span> },
    {
      key: "rate",
      header: "Reject %",
      className: "text-right",
      cell: (r) => {
        const total = Number(r.good) + Number(r.reject);
        return <span className="tabular-nums">{total ? `${((Number(r.reject) / total) * 100).toFixed(1)}%` : "—"}</span>;
      },
    },
    { key: "entries", header: "Entries", hideOnMobile: true, className: "text-right", cell: (r) => r.entries },
  ];
  return (
    <DataTable
      columns={columns}
      rows={rows.data}
      rowKey={(r) => r.key}
      loading={rows.isPending}
      error={rows.error}
      onRetry={() => void rows.refetch()}
      toolbar={
        <>
          <Select value={groupBy} onChange={(e) => setGroupBy(e.target.value as typeof groupBy)} className="sm:w-48" aria-label="Group by">
            <option value="machine">Machine-wise</option>
            <option value="workOrder">Job Order-wise</option>
            <option value="process">Process-wise</option>
            <option value="operator">Operator-wise</option>
          </Select>
          {controls}
          <p className="text-xs text-muted sm:ml-auto">Output entries recorded in the period. Job Order rows add up every process.</p>
        </>
      }
      empty={<p className="px-4 py-12 text-center text-sm text-muted">No output recorded in this period.</p>}
    />
  );
}

function Utilization() {
  const { iso, controls } = useRange();
  const data = useQuery({
    queryKey: ["shopfloor", "utilization", iso],
    queryFn: () =>
      api.get<{ periodHours: number; basis: string; machines: { id: string; code: string; name: string; status: MachineStatus; runningHours: number; downtimeHours: number; breakdowns: number; utilizationPct: number | null }[] }>(`/shopfloor/utilization${qs(iso)}`),
  });
  type Row = NonNullable<typeof data.data>["machines"][number];
  const columns: Column<Row>[] = [
    { key: "m", header: "Machine", cell: (m) => <span className="font-medium">{m.code}</span> },
    { key: "s", header: "Status now", cell: (m) => <StatusBadge kind="machine" value={m.status} /> },
    { key: "run", header: "Running hours", className: "text-right", cell: (m) => <span className="tabular-nums">{m.runningHours}</span> },
    { key: "down", header: "Breakdown downtime (h)", className: "text-right", cell: (m) => <span className="tabular-nums">{m.downtimeHours}</span> },
    { key: "bd", header: "Breakdowns", className: "text-right", hideOnMobile: true, cell: (m) => m.breakdowns },
    {
      key: "u",
      header: "Utilisation",
      cell: (m) => (
        <div className="flex min-w-32 items-center gap-2">
          <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-neutral-soft">
            <div className="h-full bg-primary" style={{ width: `${Math.min(100, m.utilizationPct ?? 0)}%` }} />
          </div>
          <span className="w-12 text-right text-xs tabular-nums">{m.utilizationPct === null ? "—" : `${m.utilizationPct}%`}</span>
        </div>
      ),
    },
  ];
  return (
    <DataTable
      columns={columns}
      rows={data.data?.machines}
      rowKey={(m) => m.id}
      loading={data.isPending}
      error={data.error}
      onRetry={() => void data.refetch()}
      toolbar={
        <>
          {controls}
          {data.data && (
            <p className="text-xs text-muted sm:ml-auto">
              Period {data.data.periodHours} h. {data.data.basis}
            </p>
          )}
        </>
      }
    />
  );
}

function Breakdowns() {
  const { can } = useAuth();
  const [status, setStatus] = useState("open");
  const list = useQuery({ queryKey: ["shopfloor", "breakdowns", status], queryFn: () => api.get<Breakdown[]>(`/shopfloor/breakdowns${qs(status === "open" ? { open: "1" } : status ? { status } : {})}`) });
  const [acting, setActing] = useState<{ b: Breakdown; kind: "maintenance" | "release" } | null>(null);
  const columns: Column<Breakdown>[] = [
    {
      key: "no",
      header: "Breakdown",
      cell: (b) => (
        <div>
          <p className="font-medium whitespace-nowrap">{b.breakdownNo}</p>
          <p className="text-xs text-muted">{formatDateTime(b.reportedAt)}</p>
        </div>
      ),
    },
    { key: "m", header: "Machine", cell: (b) => b.machine.code },
    {
      key: "r",
      header: "Reason",
      cell: (b) => (
        <div>
          <p>{reasonLabel(b.reason)}</p>
          {b.remarks && <p className="text-xs text-muted">{b.remarks}</p>}
        </div>
      ),
    },
    { key: "wo", header: "Job Order", hideOnMobile: true, cell: (b) => (b.workOrderId ? <Link className="text-primary hover:underline" to={`/planning/job-order/${b.workOrderId}`}>{b.woNo}</Link> : "—") },
    { key: "down", header: "Downtime", hideOnMobile: true, cell: (b) => minutes(b.downtimeMinutes) },
    {
      key: "st",
      header: "Status",
      cell: (b) => (
        <div>
          <StatusBadge kind="breakdown" value={b.status} />
          {b.resolutionNote && <p className="mt-0.5 text-xs text-muted">{b.resolutionNote} · {b.resolvedBy}</p>}
        </div>
      ),
    },
    ...(can("shopfloor.breakdown.release")
      ? [
          {
            key: "a",
            header: "",
            className: "text-right",
            cell: (b: Breakdown) =>
              b.status === "RESOLVED" ? null : (
                <div className="flex justify-end gap-1">
                  {b.status === "OPEN" && (
                    <Button size="sm" onClick={() => setActing({ b, kind: "maintenance" })}>
                      Start maintenance
                    </Button>
                  )}
                  <Button size="sm" variant="primary" onClick={() => setActing({ b, kind: "release" })}>
                    Release machine
                  </Button>
                </div>
              ),
          },
        ]
      : []),
  ];
  return (
    <>
      <DataTable
        columns={columns}
        rows={list.data}
        rowKey={(b) => b.id}
        loading={list.isPending}
        error={list.error}
        onRetry={() => void list.refetch()}
        toolbar={
          <Select value={status} onChange={(e) => setStatus(e.target.value)} className="sm:w-48" aria-label="Status">
            <option value="open">Open + under maintenance</option>
            <option value="RESOLVED">Resolved</option>
            <option value="">All</option>
          </Select>
        }
        empty={<p className="px-4 py-12 text-center text-sm text-muted">No breakdowns.</p>}
      />
      {acting && <BreakdownActionDialog {...acting} onClose={() => setActing(null)} />}
    </>
  );
}

function BreakdownActionDialog({ b, kind, onClose }: { b: Breakdown; kind: "maintenance" | "release"; onClose: () => void }) {
  const toast = useToast();
  const [note, setNote] = useState("");
  const [safety, setSafety] = useState(false);
  const { field, handle } = useFormError();
  const save = usePlanningMutation(() =>
    kind === "maintenance" ? api.post(`/shopfloor/breakdowns/${b.id}/maintenance`, { note }) : api.post(`/shopfloor/breakdowns/${b.id}/release`, { resolutionNote: note, safetyConfirmed: safety }),
  );
  return (
    <Dialog
      open
      onClose={onClose}
      title={kind === "maintenance" ? `Start maintenance – ${b.machine.code}` : `Release ${b.machine.code}`}
      description={`${b.breakdownNo}: ${reasonLabel(b.reason)}`}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            loading={save.isPending}
            onClick={() => save.mutate(undefined, { onSuccess: () => (toast.success(kind === "maintenance" ? "Machine is under maintenance." : "Machine released for production."), onClose()), onError: handle })}
          >
            {kind === "maintenance" ? "Start maintenance" : "Release machine"}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <Field label={kind === "maintenance" ? "Maintenance note" : "Repair / inspection done"} required={kind === "release"} error={field("resolutionNote") ?? field("note")}>
          {(p) => <Input {...p} value={note} onChange={(e) => setNote(e.target.value)} />}
        </Field>
        {kind === "release" && (
          <div className="rounded-lg border border-warning/40 bg-warning-soft p-3 text-sm">
            <Checkbox label="The physical inspection and safety clearance are done under the factory's procedure." checked={safety} onChange={(e) => setSafety(e.target.checked)} />
            <p className="mt-2 text-xs text-muted">The system records your confirmation. It does not replace the factory's machine safety procedure.</p>
            {field("safetyConfirmed") && <p className="mt-1 text-xs text-danger">{field("safetyConfirmed")}</p>}
          </div>
        )}
      </div>
    </Dialog>
  );
}

function MachineChanges() {
  const { can } = useAuth();
  const toast = useToast();
  const [status, setStatus] = useState("PENDING");
  const list = useQuery({ queryKey: ["shopfloor", "changes", status], queryFn: () => api.get<Change[]>(`/shopfloor/machine-changes${qs({ status })}`) });
  const decide = usePlanningMutation((v: { id: string; approve: boolean }) => api.post(`/shopfloor/machine-changes/${v.id}/decision`, { approve: v.approve }));
  const columns: Column<Change>[] = [
    {
      key: "wo",
      header: "Job Order",
      cell: (c) => (
        <div>
          <Link to={`/planning/job-order/${c.workOrderId}`} className="font-medium text-primary hover:underline">
            {c.woNo}
          </Link>
          <p className="text-xs text-muted">{c.process}</p>
        </div>
      ),
    },
    { key: "mv", header: "Machine", cell: (c) => `${c.from?.code ?? "—"} → ${c.to?.code ?? "—"}` },
    { key: "out", header: "Previous machine output", hideOnMobile: true, cell: (c) => `${c.prevMachineGood} good / ${c.prevMachineReject} reject` },
    { key: "os", header: "Outstanding", className: "text-right", cell: (c) => <span className="tabular-nums">{c.outstandingQty}</span> },
    {
      key: "why",
      header: "Reason",
      cell: (c) => (
        <div>
          <p>{c.reason}</p>
          <p className="text-xs text-muted">
            {c.requestedBy} · {formatDateTime(c.requestedAt)}
          </p>
        </div>
      ),
    },
    { key: "st", header: "Status", cell: (c) => <StatusBadge kind="change" value={c.status} /> },
    ...(can("shopfloor.machine.change.approve")
      ? [
          {
            key: "a",
            header: "",
            className: "text-right",
            cell: (c: Change) =>
              c.status === "PENDING" ? (
                <div className="flex justify-end gap-1">
                  <Button size="sm" onClick={() => decide.mutate({ id: c.id, approve: false }, { onSuccess: () => toast.success("Request rejected."), onError: toast.error })}>
                    Reject
                  </Button>
                  <Button size="sm" variant="primary" onClick={() => decide.mutate({ id: c.id, approve: true }, { onSuccess: () => toast.success(`Approved. ${c.woNo} can start on ${c.to?.code}.`), onError: toast.error })}>
                    Approve
                  </Button>
                </div>
              ) : (
                <span className="text-xs text-muted">{c.decidedBy}</span>
              ),
          },
        ]
      : []),
  ];
  return (
    <DataTable
      columns={columns}
      rows={list.data}
      rowKey={(c) => c.id}
      loading={list.isPending}
      error={list.error}
      onRetry={() => void list.refetch()}
      toolbar={
        <Select value={status} onChange={(e) => setStatus(e.target.value)} className="sm:w-48" aria-label="Status">
          <option value="PENDING">Waiting approval</option>
          <option value="APPROVED">Approved</option>
          <option value="REJECTED">Rejected</option>
          <option value="">All</option>
        </Select>
      }
      empty={<p className="px-4 py-12 text-center text-sm text-muted">No machine changes.</p>}
    />
  );
}

interface SessionRow {
  id: string;
  sessionNo: string;
  workOrderId: string;
  woNo: string;
  process: string;
  machine: { code: string; name: string };
  operator: string | null;
  checkInAt: string;
  checkOutAt: string | null;
  durationMinutes: number;
  status: string;
  checkOutType: string | null;
  goodQty: string;
  rejectQty: string;
  uom: string;
  remarks: string | null;
}

/** Shopfloor › WIP Check In/Check Out: every production session (Check In = start, Check Out = end). */
export function CheckInOutHistoryPage() {
  const [params, setParams] = useSearchParams();
  const page = Number(params.get("page") ?? 1);
  const q = params.get("q") ?? "";
  const status = params.get("status") ?? "";
  const machineId = params.get("machineId") ?? "";
  const machines = useMachines();
  const set = useCallback(
    (patch: Record<string, string>) =>
      setParams((prev) => {
        const n = new URLSearchParams(prev);
        for (const [k, v] of Object.entries(patch)) v ? n.set(k, v) : n.delete(k);
        if (!("page" in patch)) n.delete("page");
        return n;
      }),
    [setParams],
  );
  const list = useQuery({
    queryKey: ["shopfloor", "sessions", page, q, status, machineId],
    queryFn: () => api.list<SessionRow>(`/shopfloor/sessions${qs({ page, q, status, machineId, pageSize: 50 })}`),
    placeholderData: (prev) => prev,
    refetchInterval: 30_000,
  });
  const columns: Column<SessionRow>[] = [
    {
      key: "s",
      header: "Session",
      cell: (s) => (
        <div>
          <p className="font-medium whitespace-nowrap">{s.sessionNo}</p>
          <p className="text-xs text-muted">{s.operator}</p>
        </div>
      ),
    },
    {
      key: "wo",
      header: "Job Order / Process",
      cell: (s) => (
        <div>
          <Link to={`/planning/job-order/${s.workOrderId}`} className="font-medium text-primary hover:underline">
            {s.woNo}
          </Link>
          <p className="text-xs text-muted">{s.process}</p>
        </div>
      ),
    },
    { key: "m", header: "Machine", cell: (s) => s.machine.code },
    {
      key: "t",
      header: "Check In → Check Out",
      hideOnMobile: true,
      cell: (s) => (
        <div className="text-xs whitespace-nowrap">
          <p>{formatDateTime(s.checkInAt)}</p>
          <p className="text-muted">{s.checkOutAt ? `${formatDateTime(s.checkOutAt)} · ${minutes(s.durationMinutes)}` : `running ${minutes(s.durationMinutes)}`}</p>
        </div>
      ),
    },
    { key: "g", header: "Good", className: "text-right", cell: (s) => <span className="tabular-nums">{s.goodQty}</span> },
    { key: "r", header: "Reject", className: "text-right", cell: (s) => <span className="tabular-nums">{s.rejectQty}</span> },
    {
      key: "st",
      header: "Status",
      cell: (s) => (
        <div>
          <StatusBadge kind="session" value={s.status} />
          {s.checkOutType && <p className="mt-0.5 text-xs text-muted">{checkoutLabel(s.checkOutType)}</p>}
        </div>
      ),
    },
  ];
  return (
    <>
      <PageHeader
        title="WIP Check In/Check Out"
        description="Every production session: Check In starts work on a Job Order at a machine, Check Out ends it with the output. Recorded from the handheld."
        crumbs={[{ label: "Shopfloor" }, { label: "WIP Check In/Check Out" }]}
        actions={
          <a href="/hh" target="_blank" rel="noreferrer">
            <Button>Open handheld app</Button>
          </a>
        }
      />
      <DataTable
        columns={columns}
        rows={list.data?.data}
        rowKey={(s) => s.id}
        loading={list.isPending}
        error={list.error}
        onRetry={() => void list.refetch()}
        page={page}
        pageCount={list.data?.meta.pageCount}
        total={list.data?.meta.total}
        onPage={(p) => set({ page: String(p) })}
        toolbar={
          <>
            <SearchInput value={q} onChange={(v) => set({ q: v })} placeholder="Session or Job Order no." />
            <Select value={machineId} onChange={(e) => set({ machineId: e.target.value })} className="sm:w-44" aria-label="Machine">
              <option value="">All machines</option>
              {machines.data?.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.code}
                </option>
              ))}
            </Select>
            <Select value={status} onChange={(e) => set({ status: e.target.value })} className="sm:w-44" aria-label="Status">
              <option value="">All sessions</option>
              {["RUNNING", "COMPLETED", "PAUSED", "CLOSED", "TRANSFERRED", "BREAKDOWN"].map((s) => (
                <option key={s} value={s}>
                  {s.charAt(0) + s.slice(1).toLowerCase()}
                </option>
              ))}
            </Select>
          </>
        }
        empty={<p className="px-4 py-12 text-center text-sm text-muted">No sessions yet. Operators Check In with the handheld app.</p>}
      />
    </>
  );
}

