import { PrintDocumentButton } from "@/modules/documents/print-dialog";
import { Barcode as BarcodeIcon, Pencil, Plus } from "lucide-react";
import { useCallback, useState, type ReactNode } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router";
import { Barcode, BarcodePrintDialog } from "@/components/barcode";
import { DataTable, ErrorState, LoadingState, PageHeader, SearchInput, Tabs, type Column } from "@/components/common";
import { checkoutLabel, StatusBadge } from "@/components/status";
import { Badge, Button, Card, Select } from "@/components/ui";
import { api } from "@/lib/api";
import { formatDate, formatDateTime } from "@/lib/utils";
import { useAuth } from "@/stores/auth";
import { ArtworkPreview, ArtworkThumb } from "@/modules/bom/artwork";
import { NoteConfirmDialog } from "@/modules/bom/bom-dialogs";
import { type PjoStage, useJourney, usePjo, usePjos, useWorkOrder, useWorkOrders, type PjoRow, type WoProcess, type WoRow, type WoView } from "./api";
import { PjoCompletionCard } from "./completion-pages";
import { AuthorizeDialog, ChangeMachineDialog, JobOrderDialog } from "./order-dialogs";

function useListParams() {
  const [params, setParams] = useSearchParams();
  const set = useCallback(
    (patch: Record<string, string>) =>
      setParams((prev) => {
        const next = new URLSearchParams(prev);
        for (const [k, v] of Object.entries(patch)) v ? next.set(k, v) : next.delete(k);
        if (!("page" in patch)) next.delete("page");
        return next;
      }),
    [setParams],
  );
  return { page: Number(params.get("page") ?? 1), q: params.get("q") ?? "", status: params.get("status") ?? "", stage: params.get("stage") ?? "", due: params.get("due") ?? "", completedFrom: params.get("completedFrom") ?? "", set };
}

const Info = ({ label, children }: { label: string; children: ReactNode }) => (
  <div className="contents">
    <dt className="text-muted">{label}</dt>
    <dd className="min-w-0 break-words">{children}</dd>
  </div>
);

// ---------------------------------------------------------------------------
// Production Job Order
// ---------------------------------------------------------------------------

const PJO_STAGES: { id: PjoStage; label: string; empty: string; statuses: [string, string][] }[] = [
  { id: "planned", label: "Planned", empty: "No Production Job Orders waiting for production.", statuses: [["DRAFT", "Draft"], ["RELEASED", "Released"]] },
  { id: "in_progress", label: "In Progress", empty: "No Production Job Orders in production.", statuses: [] },
  { id: "completed", label: "Completed", empty: "No completed Production Job Orders yet.", statuses: [["CLOSED", "Closed"], ["CANCELLED", "Cancelled"]] },
];

export function PjoListPage() {
  const { can } = useAuth();
  const navigate = useNavigate();
  const { page, q, status, stage: rawStage, set } = useListParams();
  const stage = (PJO_STAGES.some((s) => s.id === rawStage) ? rawStage : "planned") as PjoStage;
  const list = usePjos({ page, q, status, stage });
  const counts = list.data?.meta.stages;
  const columns: Column<PjoRow>[] = [
    { key: "art", header: "Artwork", cell: (p) => <ArtworkThumb file={p.artworkFile} className="size-12" /> },
    {
      key: "no",
      header: "Production Job Order",
      cell: (p) => (
        <div>
          <p className="font-medium whitespace-nowrap">{p.pjoNo}</p>
          <p className="text-xs text-muted">{p.customerRef ?? "—"}</p>
        </div>
      ),
    },
    {
      key: "fc",
      header: "Father Code / Label",
      cell: (p) => (
        <div className="min-w-0">
          <p className="font-medium">{p.fatherCode}</p>
          <p className="line-clamp-1 max-w-xs text-xs text-muted">{p.labelDescription}</p>
        </div>
      ),
    },
    { key: "rev", header: "Revision", hideOnMobile: true, cell: (p) => <span className="text-xs whitespace-nowrap">Art {String(p.artworkRevision).padStart(2, "0")} · BOM {p.componentRevision ? String(p.componentRevision).padStart(2, "0") : "—"}</span> },
    { key: "qty", header: "Order Qty", className: "text-right", cell: (p) => <span className="whitespace-nowrap tabular-nums">{p.orderQty} {p.uom}</span> },
    { key: "alloc", header: "In Job Orders", hideOnMobile: true, className: "text-right", cell: (p) => <span className="tabular-nums">{p.allocatedQty} ({p.jobOrderCount})</span> },
    { key: "req", header: "Required", hideOnMobile: true, cell: (p) => formatDate(p.requiredDate) },
    { key: "prio", header: "Priority", hideOnMobile: true, cell: (p) => <StatusBadge kind="priority" value={p.priority} /> },
    { key: "status", header: "Status", cell: (p) => <StatusBadge kind="pjo" value={p.status} /> },
  ];
  return (
    <>
      <PageHeader title="Production Job Order" description="Customer production order for one Father Code. It is split into Job Orders (Work Orders) for the shopfloor." crumbs={[{ label: "Planning" }, { label: "Production Job Order" }]} />
      <Tabs
        tabs={PJO_STAGES.map((s) => ({
          id: s.id,
          label: (
            <>
              {s.label} <span className="ml-1 rounded-full bg-surface-2 px-1.5 text-xs tabular-nums">{counts?.[s.id] ?? "…"}</span>
            </>
          ),
        }))}
        value={stage}
        onChange={(id) => set({ stage: id, status: "" })}
      />
      <DataTable
        columns={columns}
        rows={list.data?.data}
        rowKey={(p) => p.id}
        loading={list.isPending}
        error={list.error}
        onRetry={() => void list.refetch()}
        page={page}
        pageCount={list.data?.meta.pageCount}
        total={list.data?.meta.total}
        onPage={(p) => set({ page: String(p) })}
        onRowClick={(p) => navigate(`/planning/production-job-order/${p.id}`)}
        toolbar={
          <>
            <SearchInput value={q} onChange={(v) => set({ q: v })} placeholder="PJO no., customer ref, Father Code" />
            {PJO_STAGES.find((s) => s.id === stage)!.statuses.length > 0 && (
              <Select value={status} onChange={(e) => set({ status: e.target.value })} className="sm:w-40" aria-label="Status">
                <option value="">All statuses</option>
                {PJO_STAGES.find((s) => s.id === stage)!.statuses.map(([v, l]) => (
                  <option key={v} value={v}>
                    {l}
                  </option>
                ))}
              </Select>
            )}
            <div className="flex-1" />
            {can("planning.pjo.create") && (
              <Button variant="primary" icon={<Plus className="size-4" />} onClick={() => navigate("/planning/production-job-order/new")}>
                New Production Job Order
              </Button>
            )}
          </>
        }
        empty={<p className="px-4 py-12 text-center text-sm text-muted">{q || status ? "No Production Job Orders match your filters." : PJO_STAGES.find((s) => s.id === stage)!.empty}</p>}
      />
    </>
  );
}

export function PjoDetailPage() {
  const { id = "" } = useParams();
  const { can } = useAuth();
  const pjo = usePjo(id);
  const [dialog, setDialog] = useState<"wo" | "release" | "cancel" | null>(null);
  if (pjo.isPending) return <LoadingState />;
  if (pjo.error) return <ErrorState error={pjo.error} onRetry={() => void pjo.refetch()} />;
  const p = pjo.data;
  const open = p.status === "DRAFT" || p.status === "RELEASED";
  return (
    <>
      <PageHeader
        title={p.pjoNo}
        description={`${p.bom.fatherCode} · ${p.bom.labelDescription}`}
        crumbs={[{ label: "Planning" }, { label: "Production Job Order", to: "/planning/production-job-order" }, { label: p.pjoNo }]}
        actions={
          <>
            <PrintDocumentButton type="PJO" id={p.id} />
            {(p.status === "RELEASED" || p.status === "CLOSED") && (
              <Link to={`/planning/production-job-order/${p.id}/finish`}>
                <Button variant={p.status === "RELEASED" ? "primary" : "secondary"}>{p.status === "RELEASED" ? "Finish order" : "Finish summary"}</Button>
              </Link>
            )}
            {open && can("planning.pjo.release") && <Button onClick={() => setDialog("cancel")}>Cancel order</Button>}
            {p.status === "DRAFT" && can("planning.pjo.release") && (
              <Button variant="primary" onClick={() => setDialog("release")}>
                Release
              </Button>
            )}
          </>
        }
      />
      <div className="mb-4 grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        <Card title="Order">
          <dl className="grid gap-x-4 gap-y-2 text-sm sm:grid-cols-[10rem_1fr]">
            <Info label="Status"><StatusBadge kind="pjo" value={p.status} /></Info>
            <Info label="Customer reference">{p.customerRef ?? "—"}</Info>
            <Info label="Product reference">{p.productRef ?? "—"}</Info>
            <Info label="Order quantity">{p.orderQty} {p.uom}</Info>
            <Info label="In Job Orders">{p.allocatedQty} {p.uom}</Info>
            <Info label="Required date">{formatDate(p.requiredDate)}</Info>
            <Info label="Priority"><StatusBadge kind="priority" value={p.priority} /></Info>
            <Info label="Released">{formatDateTime(p.releasedAt)}</Info>
            <Info label="Remarks">{p.remarks ?? "—"}</Info>
          </dl>
        </Card>
        <Card title={`BOM reference – ${p.bom.fatherCode}`}>
          <div className="grid gap-4 sm:grid-cols-[10rem_1fr]">
            <ArtworkPreview file={p.bom.artworkFile} height="h-32" />
            <div className="min-w-0 space-y-2 text-sm">
              <p>{p.bom.labelDescription}</p>
              <div className="flex flex-wrap gap-1.5">
                <Badge tone="primary">Artwork Rev {String(p.bom.artworkRevision).padStart(2, "0")}</Badge>
                <Badge tone="info">{p.bom.componentRevision ? `BOM Rev ${String(p.bom.componentRevision).padStart(2, "0")}` : "No component list"}</Badge>
                {p.masterCard && <Badge tone="success">Master Card Rev {String(p.masterCard.revisionNo).padStart(2, "0")}</Badge>}
                {p.masterCard?.newerAvailable && <Badge tone="warning">Newer Master Card released</Badge>}
              </div>
              {p.product && (
                <p className="text-xs">
                  Product{" "}
                  <Link to={`/bom/products/${p.product.id}`} className="text-primary hover:underline">
                    {p.product.productCode} · {p.product.name}
                  </Link>
                  {!p.masterCard && p.status === "DRAFT" && " · releasing uses its current Master Card"}
                </p>
              )}
              <p className="text-xs text-muted">
                {p.status === "DRAFT"
                  ? p.bom.newerRevisionAvailable
                    ? p.product
                      ? "A newer Master Card is released; releasing this order will use it."
                      : "The Father Code has newer revisions; releasing will use them."
                    : "These revisions are frozen when the order is released."
                  : "Frozen at release. Later BOM changes don't affect this order."}
              </p>
              <Link to={`/bom/${p.bom.id}`} className="text-xs text-primary hover:underline">
                Open Father Code
              </Link>
            </div>
          </div>
          {p.bom.components.length > 0 && (
            <ul className="mt-3 space-y-0.5 border-t border-line pt-3 text-xs">
              {p.bom.components.map((c) => (
                <li key={c.sonCode}>
                  <span className="font-medium">{c.sonCode}</span> {c.materialCode} – {c.materialDescription} {c.quantity ? `· ${c.quantity} ${c.uom ?? ""}` : ""}
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
      {(p.status === "RELEASED" || p.status === "CLOSED") && <PjoCompletionCard pjoId={p.id} />}
      <Card
        title={`Job Orders (${p.workOrders.filter((w) => w.status !== "CANCELLED").length})`}
        actions={
          open &&
          can("planning.jo.create") && (
            <Button size="sm" variant="primary" icon={<Plus className="size-4" />} onClick={() => setDialog("wo")}>
              New Job Order
            </Button>
          )
        }
      >
        {p.workOrders.length === 0 ? (
          <p className="py-6 text-center text-sm text-muted">No Job Orders yet. Split the order into Job Orders for the shopfloor.</p>
        ) : (
          <ul className="divide-y divide-line">
            {p.workOrders.map((w) => (
              <li key={w.id} className="flex flex-wrap items-center gap-3 py-2 text-sm">
                <Link to={`/planning/job-order/${w.id}`} className="font-medium text-primary hover:underline">
                  {w.woNo}
                </Link>
                <span className="tabular-nums">
                  {w.quantity} {p.uom}
                </span>
                <span className="text-muted">{formatDate(w.plannedDate)}</span>
                <span className="flex-1" />
                <StatusBadge kind="wo" value={w.status} />
              </li>
            ))}
          </ul>
        )}
      </Card>
      {dialog === "wo" && <JobOrderDialog pjo={p} onClose={() => setDialog(null)} />}
      {dialog === "release" && (
        <NoteConfirmDialog
          title={`Release ${p.pjoNo}?`}
          message={`The current revisions of ${p.bom.fatherCode} are frozen on this order. Its Job Orders can then be released to the shopfloor.`}
          confirmLabel="Release"
          noteLabel="Note"
          run={() => api.post(`/planning/production-job-orders/${p.id}/release`)}
          success={`${p.pjoNo} released.`}
          onClose={() => (setDialog(null), void pjo.refetch())}
        />
      )}
      {dialog === "cancel" && (
        <NoteConfirmDialog
          title={`Cancel ${p.pjoNo}?`}
          message="Only possible before production starts. Its Job Orders are cancelled too, with any MRS that never moved material. An MRS with material out stays open so the unused material can be returned."
          confirmLabel="Cancel order"
          tone="danger"
          run={(reason) => api.post(`/planning/production-job-orders/${p.id}/cancel`, { reason })}
          success={`${p.pjoNo} cancelled.`}
          onClose={() => (setDialog(null), void pjo.refetch())}
        />
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
// Job Order (Work Order)
// ---------------------------------------------------------------------------

export function JobOrderListPage() {
  const navigate = useNavigate();
  const { page, q, status, due, completedFrom, set } = useListParams();
  const list = useWorkOrders({ page, q, status, due: due || undefined, completedFrom: completedFrom || undefined });
  const columns: Column<WoRow>[] = [
    { key: "art", header: "Artwork", cell: (w) => <ArtworkThumb file={w.artworkFile} className="size-12" /> },
    {
      key: "no",
      header: "Job Order",
      cell: (w) => (
        <div>
          <p className="font-medium whitespace-nowrap">{w.woNo}</p>
          <p className="text-xs text-muted">{w.pjoNo}</p>
        </div>
      ),
    },
    {
      key: "fc",
      header: "Father Code / Label",
      cell: (w) => (
        <div className="min-w-0">
          <p className="font-medium">{w.fatherCode}</p>
          <p className="line-clamp-1 max-w-xs text-xs text-muted">{w.labelDescription}</p>
        </div>
      ),
    },
    { key: "qty", header: "Quantity", className: "text-right", cell: (w) => <span className="whitespace-nowrap tabular-nums">{w.quantity} {w.uom}</span> },
    {
      key: "proc",
      header: "Current Process",
      hideOnMobile: true,
      cell: (w) =>
        w.currentProcess ? (
          <span className="text-xs">
            {w.currentProcess.seq}/{w.processCount} {w.currentProcess.name} · <StatusBadge kind="process" value={w.currentProcess.status} />
          </span>
        ) : (
          <span className="text-xs text-muted">All {w.processCount} done</span>
        ),
    },
    { key: "plan", header: "Planned", hideOnMobile: true, cell: (w) => formatDate(w.plannedDate) },
    { key: "req", header: "Required", hideOnMobile: true, cell: (w) => (w.requiredDate ? <span className="whitespace-nowrap">{formatDate(`${w.requiredDate.slice(0, 10)}T00:00:00`)}</span> : <span className="text-muted">—</span>) },
    { key: "status", header: "Status", cell: (w) => <StatusBadge kind="wo" value={w.status} /> },
  ];
  return (
    <>
      <PageHeader title="Job Order" description="Job Orders (Work Orders) are the shopfloor's production reference: one barcode, one quantity, one process route." crumbs={[{ label: "Planning" }, { label: "Job Order" }]} />
      <DataTable
        columns={columns}
        rows={list.data?.data}
        rowKey={(w) => w.id}
        loading={list.isPending}
        error={list.error}
        onRetry={() => void list.refetch()}
        page={page}
        pageCount={list.data?.meta.pageCount}
        total={list.data?.meta.total}
        onPage={(p) => set({ page: String(p) })}
        onRowClick={(w) => navigate(`/planning/job-order/${w.id}`)}
        toolbar={
          <>
            <SearchInput value={q} onChange={(v) => set({ q: v })} placeholder="Job Order, PJO, Father Code, label" />
            <Select value={status} onChange={(e) => set({ status: e.target.value })} className="sm:w-48" aria-label="Status">
              <option value="">All statuses</option>
              <option value="RELEASED,IN_PROGRESS,PARTIALLY_COMPLETED,ON_HOLD">Open (released to production)</option>
              <option value="IN_PROGRESS,PARTIALLY_COMPLETED">In progress (running or partly done)</option>
              {["PLANNED", "RELEASED", "IN_PROGRESS", "PARTIALLY_COMPLETED", "ON_HOLD", "COMPLETED", "CANCELLED"].map((s) => (
                <option key={s} value={s}>
                  {s.replace(/_/g, " ").toLowerCase().replace(/^./, (c) => c.toUpperCase())}
                </option>
              ))}
            </Select>
            {due && (
              <button onClick={() => set({ due: "" })} className="inline-flex items-center gap-1 rounded-full bg-danger-soft px-2.5 py-1 text-xs font-medium text-danger" aria-label="Clear the due filter">
                {due === "overdue" ? "Overdue" : due === "today" ? "Due today" : "Due this week"} ×
              </button>
            )}
            {completedFrom && (
              <button onClick={() => set({ completedFrom: "" })} className="inline-flex items-center gap-1 rounded-full bg-success-soft px-2.5 py-1 text-xs font-medium text-success" aria-label="Clear the completed filter">
                Completed since {formatDate(`${completedFrom}T00:00:00`)} ×
              </button>
            )}
            <p className="text-xs text-muted sm:ml-auto">Create Job Orders from a Production Job Order.</p>
          </>
        }
        empty={<p className="px-4 py-12 text-center text-sm text-muted">No Job Orders found.</p>}
      />
    </>
  );
}

type WoDialog = { kind: "edit" } | { kind: "release" } | { kind: "hold" } | { kind: "unhold" } | { kind: "cancel" } | { kind: "complete" } | { kind: "barcode" } | { kind: "authorize"; step: WoProcess } | { kind: "change"; step: WoProcess };

export function JobOrderDetailPage() {
  const { id = "" } = useParams();
  const wo = useWorkOrder(id);
  if (wo.isPending) return <LoadingState />;
  if (wo.error) return <ErrorState error={wo.error} onRetry={() => void wo.refetch()} />;
  return <JobOrderDetail wo={wo.data} refetch={() => void wo.refetch()} />;
}

function JobOrderDetail({ wo, refetch }: { wo: WoView; refetch: () => void }) {
  const { can } = useAuth();
  const [params, setParams] = useSearchParams();
  const tab = params.get("tab") === "journey" ? "journey" : "route";
  const [dialog, setDialog] = useState<WoDialog | null>(null);
  const close = () => (setDialog(null), refetch());
  const workable = ["RELEASED", "IN_PROGRESS", "PARTIALLY_COMPLETED"].includes(wo.status);
  const allDone = wo.processes.every((p) => p.status === "COMPLETED");
  const last = wo.processes[wo.processes.length - 1];
  return (
    <>
      <PageHeader
        title={wo.woNo}
        description={`${wo.pjo.fatherCode} · ${wo.pjo.labelDescription}`}
        crumbs={[{ label: "Planning" }, { label: "Job Order", to: "/planning/job-order" }, { label: wo.woNo }]}
        actions={
          <>
            <PrintDocumentButton type="JOB_ORDER" id={wo.id} label="Print traveller" />
            <Button icon={<BarcodeIcon className="size-4" />} onClick={() => setDialog({ kind: "barcode" })}>
              Barcode
            </Button>
            {wo.status === "PLANNED" && can("planning.jo.create") && (
              <Button icon={<Pencil className="size-4" />} onClick={() => setDialog({ kind: "edit" })}>
                Edit
              </Button>
            )}
            {wo.status !== "COMPLETED" && wo.status !== "CANCELLED" && can("planning.jo.release") && (
              <>
                {workable && <Button onClick={() => setDialog({ kind: "hold" })}>Put on hold</Button>}
                {wo.status === "ON_HOLD" && <Button onClick={() => setDialog({ kind: "unhold" })}>Release hold</Button>}
                {(wo.status === "PLANNED" || wo.status === "RELEASED") && <Button onClick={() => setDialog({ kind: "cancel" })}>Cancel</Button>}
              </>
            )}
            {wo.status === "PLANNED" && can("planning.jo.release") && (
              <Button variant="primary" onClick={() => setDialog({ kind: "release" })}>
                Release to shopfloor
              </Button>
            )}
            {workable && allDone && can("planning.jo.complete") && (
              <Button variant="primary" onClick={() => setDialog({ kind: "complete" })}>
                Confirm completion
              </Button>
            )}
          </>
        }
      />
      {wo.status === "ON_HOLD" && <div className="mb-4 rounded-lg border border-danger/40 bg-danger-soft px-4 py-3 text-sm text-danger">On hold: {wo.holdReason}</div>}
      <div className="mb-4 grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)]">
        <Card title="Job Order">
          <dl className="grid gap-x-4 gap-y-2 text-sm sm:grid-cols-[10rem_1fr]">
            <Info label="Status"><StatusBadge kind="wo" value={wo.status} /></Info>
            <Info label="Production Job Order">
              <Link to={`/planning/production-job-order/${wo.pjo.id}`} className="text-primary hover:underline">
                {wo.pjo.pjoNo}
              </Link>{" "}
              {wo.pjo.customerRef ? `· ${wo.pjo.customerRef}` : ""}
            </Info>
            <Info label="Target quantity">{wo.quantity} {wo.uom}</Info>
            <Info label="Final good output">{last ? `${last.quantities.good} ${wo.uom}` : "—"}</Info>
            <Info label="Planned date">{formatDate(wo.plannedDate)}</Info>
            <Info label="Priority"><StatusBadge kind="priority" value={wo.priority} /></Info>
            <Info label="Completed">{wo.completedAt ? `${formatDateTime(wo.completedAt)}${wo.completionNote ? ` · ${wo.completionNote}` : ""}` : "—"}</Info>
            <Info label="Remarks">{wo.remarks ?? "—"}</Info>
          </dl>
        </Card>
        <Card title={`Artwork – ${wo.pjo.fatherCode}`}>
          <div className="grid gap-4 sm:grid-cols-[12rem_1fr]">
            <ArtworkPreview file={wo.pjo.artworkFile} height="h-36" />
            <div className="space-y-2 text-sm">
              <p>{wo.pjo.labelDescription}</p>
              <div className="flex flex-wrap gap-1.5">
                <Badge tone="primary">Artwork Rev {String(wo.pjo.artworkRevision).padStart(2, "0")}</Badge>
                {wo.pjo.componentRevision && <Badge tone="info">BOM Rev {String(wo.pjo.componentRevision).padStart(2, "0")}</Badge>}
              </div>
            </div>
          </div>
        </Card>
      </div>

      <Tabs
        value={tab}
        onChange={(t) => setParams(t === "route" ? {} : { tab: t }, { replace: true })}
        tabs={[
          { id: "route", label: "Process route & quantities" },
          { id: "journey", label: "Production journey" },
        ]}
      />
      {tab === "route" ? (
        <div className="space-y-2">
          {wo.processes.map((p) => (
            <RouteStep
              key={p.id}
              step={p}
              uom={wo.uom}
              current={p.seq === wo.currentSeq}
              onAuthorize={workable && can("shopfloor.process.authorize") ? () => setDialog({ kind: "authorize", step: p }) : undefined}
              onChange={
                (workable || wo.status === "ON_HOLD") && !!p.assignedMachine && p.status !== "COMPLETED" && p.status !== "RUNNING" && !p.pendingMachineChange && (can("shopfloor.machine.change") || can("shopfloor.machine.change.approve"))
                  ? () => setDialog({ kind: "change", step: p })
                  : undefined
              }
            />
          ))}
        </div>
      ) : (
        <JourneyView wo={wo} />
      )}

      {dialog?.kind === "edit" && <JobOrderDialog wo={wo} onClose={close} />}
      {dialog?.kind === "authorize" && <AuthorizeDialog step={dialog.step} onClose={close} />}
      {dialog?.kind === "change" && <ChangeMachineDialog step={dialog.step} canApprove={can("shopfloor.machine.change.approve")} onClose={close} />}
      {dialog?.kind === "barcode" && (
        <BarcodePrintDialog title={`Job Order barcode – ${wo.woNo}`} onClose={() => setDialog(null)}>
          <div className="space-y-3 text-sm">
            <div className="flex items-start justify-between gap-4">
              <div>
                <p className="text-xl font-bold">{wo.woNo}</p>
                <p>
                  {wo.pjo.pjoNo} · {wo.pjo.fatherCode} · Artwork Rev {String(wo.pjo.artworkRevision).padStart(2, "0")}
                </p>
                <p>{wo.pjo.labelDescription}</p>
                <p>
                  Quantity: {wo.quantity} {wo.uom}
                  {wo.plannedDate ? ` · Planned ${formatDate(wo.plannedDate)}` : ""}
                </p>
              </div>
              <Barcode value={wo.woNo} kind="qrcode" scale={3} />
            </div>
            <Barcode value={wo.woNo} />
            <ol className="list-decimal pl-5">
              {wo.processes.map((p) => (
                <li key={p.id}>{p.process.name}</li>
              ))}
            </ol>
          </div>
        </BarcodePrintDialog>
      )}
      {dialog?.kind === "release" && (
        <NoteConfirmDialog title={`Release ${wo.woNo}?`} message="Operators can then Check In on it with the handheld." confirmLabel="Release" noteLabel="Note" run={() => api.post(`/planning/work-orders/${wo.id}/release`)} success={`${wo.woNo} released to the shopfloor.`} onClose={close} />
      )}
      {dialog?.kind === "hold" && (
        <NoteConfirmDialog title={`Put ${wo.woNo} on hold?`} message="No new Check In is accepted while it is on hold. All machines must be checked out first." confirmLabel="Put on hold" tone="danger" run={(reason) => api.post(`/planning/work-orders/${wo.id}/hold`, { reason })} success={`${wo.woNo} is on hold.`} onClose={close} />
      )}
      {dialog?.kind === "unhold" && <NoteConfirmDialog title={`Release the hold on ${wo.woNo}?`} message="Operators can Check In again." confirmLabel="Release hold" run={(reason) => api.post(`/planning/work-orders/${wo.id}/unhold`, { reason })} success="Hold released." onClose={close} />}
      {dialog?.kind === "cancel" && <NoteConfirmDialog title={`Cancel ${wo.woNo}?`} message="Only possible before production starts. Its MRS that never moved material are cancelled too; an MRS with material out stays open so the unused material can be returned." confirmLabel="Cancel Job Order" tone="danger" run={(reason) => api.post(`/planning/work-orders/${wo.id}/cancel`, { reason })} success={`${wo.woNo} cancelled.`} onClose={close} />}
      {dialog?.kind === "complete" && (
        <NoteConfirmDialog
          title={`Confirm completion of ${wo.woNo}?`}
          message={`Every process is completed. Final good output ${last?.quantities.good} of ${wo.quantity} ${wo.uom}. A note is required if it is below target.`}
          confirmLabel="Confirm completion"
          noteLabel="Completion note"
          run={(note) => api.post(`/planning/work-orders/${wo.id}/complete`, { note })}
          success={`${wo.woNo} completed.`}
          onClose={close}
        />
      )}
    </>
  );
}

function RouteStep({ step, uom, current, onAuthorize, onChange }: { step: WoProcess; uom: string; current: boolean; onAuthorize?: () => void; onChange?: () => void }) {
  const qty = step.quantities;
  const pct = Number(qty.target) ? Math.min(100, Math.round((Number(qty.good) / Number(qty.target)) * 100)) : 0;
  return (
    <div className={`rounded-lg border bg-surface p-3 ${current ? "border-primary/50" : "border-line"}`}>
      <div className="flex flex-wrap items-center gap-2">
        <span className="grid size-7 place-items-center rounded-full bg-neutral-soft text-xs font-semibold">{step.seq}</span>
        <span className="font-medium">{step.process.name}</span>
        <StatusBadge kind="process" value={step.status} />
        {current && <Badge tone="primary">Current</Badge>}
        {step.allowPartialTransfer && <Badge tone="info">Partial transfer</Badge>}
        {step.allowSplit && <Badge tone="info">Split allowed</Badge>}
        {Number(step.extraAllowedQty) > 0 && <Badge tone="warning">+{step.extraAllowedQty} authorised</Badge>}
        {step.pendingMachineChange && <Badge tone="warning">Machine change waiting approval</Badge>}
        <span className="flex-1" />
        <span className="text-xs text-muted">Machine: {step.assignedMachine ? `${step.assignedMachine.code}` : "—"}</span>
        {onChange && (
          <Button size="sm" onClick={onChange}>
            Change machine
          </Button>
        )}
        {onAuthorize && (
          <Button size="sm" onClick={onAuthorize}>
            Authorise
          </Button>
        )}
      </div>
      <div className="mt-3 grid grid-cols-2 gap-2 text-sm sm:grid-cols-3 lg:grid-cols-6">
        {(
          [
            ["Target", qty.target],
            ["Authorised", qty.authorized],
            ["Good output", qty.good],
            ["Reject", qty.reject],
            ["Outstanding", qty.outstanding],
            ["Taken by next process", qty.acceptedByNext ?? "—"],
          ] as const
        ).map(([label, v]) => (
          <div key={label} className="rounded-md bg-surface-2 px-2 py-1.5">
            <p className="text-[11px] text-muted uppercase">{label}</p>
            <p className="font-semibold tabular-nums">
              {v} {v !== "—" ? <span className="text-xs font-normal text-muted">{uom}</span> : null}
            </p>
          </div>
        ))}
      </div>
      <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-neutral-soft" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100} aria-label={`${step.process.name} progress`}>
        <div className="h-full bg-primary" style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

function JourneyView({ wo }: { wo: WoView }) {
  const j = useJourney(wo.id);
  if (j.isPending) return <LoadingState />;
  if (j.error) return <ErrorState error={j.error} onRetry={() => void j.refetch()} />;
  if (!j.data.sessions.length && !j.data.machineChanges.length) return <p className="py-8 text-center text-sm text-muted">No production yet.</p>;
  return (
    <div className="space-y-4">
      {wo.processes.map((p) => {
        const sessions = j.data.sessions.filter((s) => s.woProcessId === p.id);
        const changes = j.data.machineChanges.filter((c) => c.woProcessId === p.id);
        const breakdowns = j.data.breakdowns.filter((b) => b.woProcessId === p.id);
        if (!sessions.length && !changes.length) return null;
        return (
          <Card key={p.id} title={`${p.seq}. ${p.process.name}`}>
            <div className="relative -mx-4 overflow-x-auto">
              <table className="w-full text-left text-sm">
                <thead className="bg-surface-2 text-xs text-muted uppercase">
                  <tr>
                    <th className="px-4 py-2">Session</th>
                    <th className="px-3 py-2">Machine</th>
                    <th className="px-3 py-2">Operator</th>
                    <th className="px-3 py-2">Check In</th>
                    <th className="px-3 py-2">Check Out</th>
                    <th className="px-3 py-2 text-right">Good</th>
                    <th className="px-3 py-2 text-right">Reject</th>
                    <th className="px-3 py-2">Result</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-line">
                  {sessions.map((s) => (
                    <tr key={s.id}>
                      <td className="px-4 py-2 font-medium whitespace-nowrap">{s.sessionNo}</td>
                      <td className="px-3 py-2 whitespace-nowrap">{s.machine.code}</td>
                      <td className="px-3 py-2">{s.operator}</td>
                      <td className="px-3 py-2 whitespace-nowrap">{formatDateTime(s.checkInAt)}</td>
                      <td className="px-3 py-2 whitespace-nowrap">{formatDateTime(s.checkOutAt)}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{s.goodQty}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{s.rejectQty}</td>
                      <td className="px-3 py-2">
                        <StatusBadge kind="session" value={s.status} /> <span className="text-xs text-muted">{s.checkOutType ? checkoutLabel(s.checkOutType) : ""}</span>
                        {s.remarks && <span className="block text-xs text-muted">“{s.remarks}”</span>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {(changes.length > 0 || breakdowns.length > 0) && (
              <ul className="mt-3 space-y-1 border-t border-line pt-3 text-sm">
                {breakdowns.map((b) => (
                  <li key={b.id}>
                    <Badge tone="danger">Breakdown</Badge> {b.breakdownNo} on {b.machine.code} · {b.reason.replace(/_/g, " ").toLowerCase()} · {formatDateTime(b.reportedAt)} by {b.reportedBy} · <StatusBadge kind="breakdown" value={b.status} />
                  </li>
                ))}
                {changes.map((c) => (
                  <li key={c.id}>
                    <Badge tone="warning">Machine change</Badge> {c.from?.code ?? "—"} → {c.to?.code} · previous machine output {c.prevMachineGood} good / {c.prevMachineReject} reject · outstanding {c.outstandingQty} · “{c.reason}” · {c.requestedBy}
                    {c.decidedBy ? `, decided by ${c.decidedBy}` : ""} · <StatusBadge kind="change" value={c.status} />
                  </li>
                ))}
              </ul>
            )}
          </Card>
        );
      })}
    </div>
  );
}
