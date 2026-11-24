import { ChevronLeft, ChevronRight } from "lucide-react";
import { useMemo } from "react";
import { useNavigate, useSearchParams } from "react-router";
import { DataTable, PageHeader, SearchInput, Tabs, type Column } from "@/components/common";
import { StatusBadge } from "@/components/status";
import { Badge, Button, Input } from "@/components/ui";
import { formatDate, formatDateTime } from "@/lib/utils";
import { dayLabel, localDay, shiftDay, useDaily, type DailyJob } from "./ops-api";

type Section = "planned" | "inProgress" | "completed";
const SECTIONS: { id: Section; label: string; empty: string }[] = [
  { id: "planned", label: "Planned", empty: "No released Job Orders waiting to start." },
  { id: "inProgress", label: "In Progress", empty: "No Job Orders in production right now." },
  { id: "completed", label: "Completed", empty: "No Job Orders were completed on this day." },
];

/** Progress of a Job Order through its route: "2 / 3 steps" plus a thin bar. */
function StepProgress({ r }: { r: DailyJob }) {
  const pct = r.steps.total ? Math.round((r.steps.done / r.steps.total) * 100) : 0;
  return (
    <div className="min-w-28">
      <p className="text-xs whitespace-nowrap text-muted">
        {r.steps.done} / {r.steps.total} steps
      </p>
      <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-surface-2" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
        <div className="h-full rounded-full bg-primary" style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

const jobCell = (r: DailyJob) => (
  <div className="min-w-0">
    <p className="font-medium whitespace-nowrap">{r.woNo}</p>
    <p className="text-xs whitespace-nowrap text-muted">
      {r.pjo.pjoNo}
      {r.pjo.customerRef ? ` · ${r.pjo.customerRef}` : ""}
    </p>
  </div>
);
const labelCell = (r: DailyJob) => (
  <div className="min-w-0">
    <p className="font-medium">{r.fatherCode}</p>
    <p className="line-clamp-1 max-w-xs text-xs text-muted">{r.labelDescription}</p>
  </div>
);
const qtyCell = (r: DailyJob) => (
  <span className="whitespace-nowrap tabular-nums">
    {r.quantity} {r.uom}
  </span>
);
const stepCell = (r: DailyJob) =>
  r.current ? (
    <div className="min-w-0">
      <p className="whitespace-nowrap">
        {r.current.seq}. {r.current.name}
      </p>
      <p className="text-xs whitespace-nowrap text-muted">{r.machine ? `${r.machine.code} – ${r.machine.name}` : "No machine yet"}</p>
    </div>
  ) : (
    "—"
  );

function columnsFor(section: Section, today: string): Column<DailyJob>[] {
  if (section === "planned")
    return [
      { key: "job", header: "Job Order", cell: jobCell },
      { key: "label", header: "Father Code / Label", cell: labelCell },
      { key: "qty", header: "Quantity", className: "text-right", cell: qtyCell },
      {
        key: "date",
        header: "Planned date",
        cell: (r) => {
          const d = r.plannedDate?.slice(0, 10);
          return (
            <span className="whitespace-nowrap">
              {d ? formatDate(r.plannedDate) : "—"}
              {d && d < today && <Badge tone="danger" className="ml-1.5">Late</Badge>}
              {d === today && <Badge tone="primary" className="ml-1.5">Today</Badge>}
            </span>
          );
        },
      },
      { key: "first", header: "First step", hideOnMobile: true, cell: (r) => (r.current ? `${r.current.seq}. ${r.current.name}` : "—") },
      { key: "mat", header: "Material", cell: (r) => <StatusBadge kind="material" value={r.material} /> },
      { key: "prio", header: "Priority", hideOnMobile: true, cell: (r) => <StatusBadge kind="priority" value={r.priority} /> },
      { key: "status", header: "Status", cell: (r) => <StatusBadge kind="wo" value={r.status} /> },
    ];
  if (section === "inProgress")
    return [
      { key: "job", header: "Job Order", cell: jobCell },
      { key: "label", header: "Father Code / Label", hideOnMobile: true, cell: labelCell },
      { key: "step", header: "Current step / machine", cell: stepCell },
      { key: "progress", header: "Progress", cell: (r) => <StepProgress r={r} /> },
      {
        key: "out",
        header: "Output on day",
        className: "text-right",
        cell: (r) => (
          <span className="whitespace-nowrap tabular-nums">
            {r.outputToday.good}
            {r.outputToday.reject !== "0" && <span className="text-danger"> / {r.outputToday.reject} rej</span>}
          </span>
        ),
      },
      { key: "qty", header: "Order qty", className: "text-right", hideOnMobile: true, cell: qtyCell },
      { key: "mat", header: "Material", hideOnMobile: true, cell: (r) => <StatusBadge kind="material" value={r.material} /> },
      {
        key: "status",
        header: "Status",
        cell: (r) =>
          r.running ? (
            <Badge tone="primary">Running</Badge>
          ) : r.status === "ON_HOLD" ? (
            <span title={r.holdReason ?? undefined}>
              <StatusBadge kind="wo" value={r.status} />
            </span>
          ) : (
            <Badge tone="warning">Paused</Badge>
          ),
      },
    ];
  return [
    { key: "job", header: "Job Order", cell: jobCell },
    { key: "label", header: "Father Code / Label", cell: labelCell },
    {
      key: "fin",
      header: "Finished / ordered",
      className: "text-right",
      cell: (r) => (
        <span className="whitespace-nowrap tabular-nums">
          {r.finishedQty} / {r.quantity} {r.uom}
        </span>
      ),
    },
    { key: "at", header: "Completed at", cell: (r) => <span className="whitespace-nowrap">{formatDateTime(r.completedAt)}</span> },
    { key: "status", header: "Status", cell: (r) => <StatusBadge kind="wo" value={r.status} /> },
  ];
}

export function DailyJobInformationPage() {
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const date = params.get("date") ?? localDay();
  const section = (params.get("section") as Section | null) ?? "inProgress";
  const search = params.get("q") ?? "";
  const set = (patch: Record<string, string>) =>
    setParams((prev) => {
      const next = new URLSearchParams(prev);
      for (const [k, v] of Object.entries(patch)) v ? next.set(k, v) : next.delete(k);
      return next;
    });
  const daily = useDaily(date);
  const today = localDay();
  const rows = useMemo(() => {
    const list = daily.data?.[section] ?? [];
    const s = search.trim().toLowerCase();
    return s ? list.filter((r) => [r.woNo, r.pjo.pjoNo, r.pjo.customerRef, r.fatherCode, r.labelDescription].some((v) => v?.toLowerCase().includes(s))) : list;
  }, [daily.data, section, search]);
  const sum = daily.data?.summary;
  const count = (id: Section) => (id === "planned" ? sum?.planned : id === "inProgress" ? sum?.inProgress : sum?.completed);

  return (
    <>
      <PageHeader
        title="Daily Job Information"
        description="Job Orders pulled straight from released Production Job Orders: waiting to start, in production, and completed on the day."
        crumbs={[{ label: "Planning" }, { label: "Daily Job Information" }]}
        actions={
          <div className="flex w-full items-center gap-1 sm:w-auto">
            <Button size="sm" icon={<ChevronLeft className="size-4" />} onClick={() => set({ date: shiftDay(date, -1) })} aria-label="Previous day" />
            <Input type="date" value={date} onChange={(e) => e.target.value && set({ date: e.target.value })} className="w-auto flex-1 sm:w-40 sm:flex-none" aria-label="Day" />
            <Button size="sm" icon={<ChevronRight className="size-4" />} onClick={() => set({ date: shiftDay(date, 1) })} aria-label="Next day" />
            {date !== today && (
              <Button size="sm" onClick={() => set({ date: "" })}>
                Today
              </Button>
            )}
          </div>
        }
      />
      {sum && (
        <div className="mb-4 grid grid-cols-2 gap-2 sm:grid-cols-4">
          {(
            [
              ["Planned", sum.planned, "Released, not started"],
              ["In progress", sum.inProgress, `${sum.running} running${sum.onHold ? ` · ${sum.onHold} on hold` : ""}`],
              ["Completed", sum.completed, dayLabel(date)],
              ["Output recorded", daily.data ? [...daily.data.inProgress, ...daily.data.completed].filter((r) => r.outputToday.good !== "0").length : 0, "Job Orders with output on the day"],
            ] as const
          ).map(([label, n, hint]) => (
            <div key={label} className="min-w-0 rounded-lg border border-line bg-surface p-3">
              <p className="text-xs text-muted">{label}</p>
              <p className="text-xl font-semibold tabular-nums">{n}</p>
              <p className="truncate text-xs text-muted">{hint}</p>
            </div>
          ))}
        </div>
      )}
      <Tabs
        tabs={SECTIONS.map((s) => ({
          id: s.id,
          label: (
            <>
              {s.label} <span className="ml-1 rounded-full bg-surface-2 px-1.5 text-xs tabular-nums">{count(s.id) ?? "…"}</span>
            </>
          ),
        }))}
        value={section}
        onChange={(id) => set({ section: id })}
      />
      <DataTable
        columns={columnsFor(section, today)}
        rows={rows}
        rowKey={(r) => r.id}
        loading={daily.isPending}
        error={daily.error}
        onRetry={() => void daily.refetch()}
        onRowClick={(r) => navigate(`/planning/job-order/${r.id}`)}
        toolbar={<SearchInput value={search} onChange={(v) => set({ q: v })} placeholder="Job Order, PJO, customer ref, Father Code" />}
        empty={<p className="px-4 py-12 text-center text-sm text-muted">{search ? "No Job Orders match your search." : SECTIONS.find((s) => s.id === section)!.empty}</p>}
      />
    </>
  );
}
