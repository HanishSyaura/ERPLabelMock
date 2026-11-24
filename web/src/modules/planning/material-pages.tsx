import { PrintDocumentButton } from "@/modules/documents/print-dialog";
import { useQuery } from "@tanstack/react-query";
import { Plus } from "lucide-react";
import { useCallback, useState, type FormEvent } from "react";
import { Link, Navigate, useNavigate, useParams, useSearchParams } from "react-router";
import { DataTable, ErrorState, LoadingState, PageHeader, SearchInput, Tabs, type Column } from "@/components/common";
import { StatusBadge } from "@/components/status";
import { Badge, Button, Card, Dialog, Field, Input, Select, Textarea } from "@/components/ui";
import { api, qs } from "@/lib/api";
import { formatDateTime } from "@/lib/utils";
import { newTxnId, useFormError } from "@/lib/use-form-error";
import { useAuth } from "@/stores/auth";
import { useToast } from "@/stores/toast";
import { NoteConfirmDialog } from "@/modules/bom/bom-dialogs";
import { useMachines, usePlanningMutation, type WoRow } from "./api";
import {
  MOVEMENT_LABEL,
  MOVEMENT_PATH,
  MOVEMENT_PERMISSION,
  useMovements,
  useMrs,
  useMrsList,
  useReasons,
  type MovementRow,
  type MovementType,
  type MrsLineView,
  type MrsRow,
  type MrsTemplate,
  type ReasonCategory,
} from "./ops-api";

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
  return { page: Number(params.get("page") ?? 1), q: params.get("q") ?? "", status: params.get("status") ?? "", tab: params.get("tab") ?? "", activeJob: params.get("activeJob") ?? "", set };
}

const MOVEMENT_HELP: Record<MovementType, string> = {
  ISSUE: "Material handed to production against the request.",
  ADDITIONAL_ISSUE: "Material beyond the request, with a reason. Allowed once the request is fully issued.",
  RETURN: "Unused material going back to the store.",
  REJECT: "Issued material that is damaged or defective.",
  SCRAP: "Material destroyed during production, by reason, machine and process.",
};
const REASON_OF: Partial<Record<MovementType, ReasonCategory>> = { ADDITIONAL_ISSUE: "ADDITIONAL_ISSUE", REJECT: "REJECT", SCRAP: "SCRAP" };

/** Which movements a line allows right now (the server checks again). */
function allowed(type: MovementType, l: MrsLineView, open: boolean) {
  if (!open) return false;
  if (type === "ISSUE") return Number(l.remainingToIssue) > 0;
  if (type === "ADDITIONAL_ISSUE") return Number(l.remainingToIssue) === 0;
  return Number(l.onHand) > 0;
}

// ---------------------------------------------------------------------------
// Movement dialog: pick MRS -> line -> quantity (+ lot, reason, machine/process)
// ---------------------------------------------------------------------------

function MovementDialog({ type, mrsId: initialMrs, lineId: initialLine, onClose }: { type: MovementType; mrsId?: string; lineId?: string; onClose: () => void }) {
  const toast = useToast();
  const [mrsId, setMrsId] = useState<string | null>(initialMrs ?? null);
  const [lineId, setLineId] = useState<string | null>(initialLine ?? null);
  const [q, setQ] = useState("");
  const pick = useMrsList({ page: 1, q, ...(type === "ISSUE" || type === "ADDITIONAL_ISSUE" ? {} : { withOnHand: "1" }) });
  const mrs = useMrs(mrsId);
  const reasonCategory = REASON_OF[type];
  const reasons = useQuery({ queryKey: ["planning", "reasons", reasonCategory, "ACTIVE"], queryFn: () => api.get<{ id: string; code: string; description: string }[]>(`/material/reasons${qs({ category: reasonCategory, status: "ACTIVE" })}`), enabled: !!reasonCategory });
  const machines = useMachines();
  const [form, setForm] = useState({ qty: "", lotRef: "", reasonCodeId: "", machineId: "", woProcessId: "", remarks: "" });
  const [clientTxnId] = useState(newTxnId);
  const { field, handle } = useFormError();
  const line = mrs.data?.lines.find((l) => l.id === lineId) ?? null;
  const open = mrs.data ? !["CLOSED", "CANCELLED"].includes(mrs.data.status) : false;
  const save = usePlanningMutation(() =>
    api.post<{ txnNo: string; replayed: boolean }>(`/material/lines/${lineId}/${MOVEMENT_PATH[type]}`, {
      clientTxnId,
      qty: form.qty,
      lotRef: form.lotRef || null,
      reasonCodeId: form.reasonCodeId || null,
      machineId: form.machineId || null,
      woProcessId: form.woProcessId || null,
      remarks: form.remarks || null,
    }),
  );
  const set = (k: keyof typeof form) => (e: { target: { value: string } }) => setForm((f) => ({ ...f, [k]: e.target.value }));
  const submit = (e: FormEvent) => {
    e.preventDefault();
    save.mutate(undefined, { onSuccess: (r) => (toast.success(`${MOVEMENT_LABEL[type]} ${r.txnNo} recorded${r.replayed ? " (already saved earlier)" : ""}.`), onClose()), onError: handle });
  };
  const limit = line ? (type === "ISSUE" ? line.remainingToIssue : type === "ADDITIONAL_ISSUE" ? null : line.onHand) : null;

  return (
    <Dialog
      open
      onClose={onClose}
      size="lg"
      title={`Record ${MOVEMENT_LABEL[type].toLowerCase()}`}
      description={MOVEMENT_HELP[type]}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" type="submit" form="move-form" loading={save.isPending} disabled={!line}>
            Record
          </Button>
        </>
      }
    >
      <form id="move-form" onSubmit={submit} className="space-y-4" noValidate>
        {!mrsId ? (
          <div className="space-y-2">
            <p className="text-sm font-medium">Material Requisition Sheet</p>
            <Input placeholder="Search MRS no., Job Order, PJO or material code" value={q} onChange={(e) => setQ(e.target.value)} data-autofocus />
            <div className="max-h-64 space-y-1 overflow-y-auto rounded-md border border-line p-1">
              {pick.data?.data
                .filter((m) => !["CLOSED", "CANCELLED"].includes(m.status))
                .map((m) => (
                  <button key={m.id} type="button" onClick={() => setMrsId(m.id)} className="flex w-full flex-wrap items-center gap-2 rounded-md p-2 text-left text-sm hover:bg-surface-2">
                    <span className="font-medium">{m.mrsNo}</span>
                    <span className="text-muted">
                      {m.workOrder.woNo} · {m.pjoNo} · {m.fatherCode}
                    </span>
                    <span className="flex-1" />
                    <StatusBadge kind="mrs" value={m.status} />
                  </button>
                ))}
              {pick.data?.data.length === 0 && <p className="p-2 text-sm text-muted">{type === "ISSUE" || type === "ADDITIONAL_ISSUE" ? "No open MRS matches." : "No open MRS has material out."}</p>}
            </div>
          </div>
        ) : mrs.isPending ? (
          <LoadingState />
        ) : mrs.data ? (
          <>
            <div className="flex flex-wrap items-center gap-2 text-sm">
              <span className="font-medium">{mrs.data.mrsNo}</span>
              <span className="text-muted">
                {mrs.data.workOrder.woNo} · {mrs.data.pjo.fatherCode}
              </span>
              <StatusBadge kind="mrs" value={mrs.data.status} />
              {!initialMrs && (
                <button type="button" className="text-xs text-primary hover:underline" onClick={() => (setMrsId(null), setLineId(null))}>
                  Change
                </button>
              )}
            </div>
            {mrs.data.workOrder.status === "ON_HOLD" && (type === "ISSUE" || type === "ADDITIONAL_ISSUE") && (
              <p className="rounded-md bg-danger-soft p-2 text-sm text-danger">Job Order on hold: {mrs.data.workOrder.holdReason}. Issue is refused until the hold is released.</p>
            )}
            <div className="space-y-2 sm:hidden" role="radiogroup" aria-label="Material line">
              {mrs.data.lines.map((l) => {
                const can = allowed(type, l, open);
                const sel = lineId === l.id;
                return (
                  <button
                    key={l.id}
                    type="button"
                    role="radio"
                    aria-checked={sel}
                    disabled={!can}
                    onClick={() => setLineId(l.id)}
                    className={`w-full rounded-lg border p-3 text-left disabled:opacity-50 ${sel ? "border-primary bg-primary-soft" : "border-line"}`}
                  >
                    <p className="font-medium">{l.materialCode}</p>
                    <p className="text-xs text-muted">{l.materialDescription}</p>
                    <p className="mt-1 text-xs tabular-nums">
                      Requested {l.requested} · to issue {l.remainingToIssue} · out {l.onHand} {l.uom}
                    </p>
                  </button>
                );
              })}
            </div>
            <div className="relative hidden overflow-x-auto rounded-md border border-line sm:block">
              <table className="w-full text-left text-sm">
                <thead className="bg-surface-2 text-xs text-muted">
                  <tr>
                    <th className="px-2 py-1.5" />
                    <th className="px-2 py-1.5">Material</th>
                    <th className="px-2 py-1.5 text-right">Requested</th>
                    <th className="px-2 py-1.5 text-right">To issue</th>
                    <th className="px-2 py-1.5 text-right">Out on line</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-line">
                  {mrs.data.lines.map((l) => {
                    const can = allowed(type, l, open);
                    return (
                      <tr key={l.id} className={can ? "cursor-pointer hover:bg-surface-2" : "opacity-50"} onClick={() => can && setLineId(l.id)}>
                        <td className="px-2 py-1.5">
                          <input type="radio" name="line" checked={lineId === l.id} disabled={!can} onChange={() => setLineId(l.id)} aria-label={l.materialCode} className="accent-primary" />
                        </td>
                        <td className="px-2 py-1.5">
                          <p className="font-medium">{l.materialCode}</p>
                          <p className="text-xs text-muted">{l.materialDescription}</p>
                        </td>
                        <td className="px-2 py-1.5 text-right tabular-nums">
                          {l.requested} {l.uom}
                        </td>
                        <td className="px-2 py-1.5 text-right tabular-nums">{l.remainingToIssue}</td>
                        <td className="px-2 py-1.5 text-right tabular-nums">{l.onHand}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            {line && (
              <div className="grid gap-4 sm:grid-cols-2">
                <Field label={`Quantity (${line.uom})`} required error={field("qty")} hint={limit !== null ? `Up to ${limit} ${line.uom}` : undefined}>
                  {(p) => <Input {...p} inputMode="decimal" value={form.qty} onChange={set("qty")} data-autofocus />}
                </Field>
                <Field label="Lot / roll reference" hint="Scan or type the lot or roll number" error={field("lotRef")}>
                  {(p) => <Input {...p} value={form.lotRef} onChange={set("lotRef")} />}
                </Field>
                {reasonCategory && (
                  <Field label="Reason" required error={field("reasonCodeId")} className="sm:col-span-2">
                    {(p) =>
                      reasons.data?.length === 0 ? (
                        <p className="text-sm text-danger">No active reasons yet. Add one on the Reasons tab of this page.</p>
                      ) : (
                        <Select {...p} value={form.reasonCodeId} onChange={set("reasonCodeId")}>
                          <option value="">Choose a reason</option>
                          {reasons.data?.map((r) => (
                            <option key={r.id} value={r.id}>
                              {r.code} – {r.description}
                            </option>
                          ))}
                        </Select>
                      )
                    }
                  </Field>
                )}
                {type === "SCRAP" && (
                  <>
                    <Field label="Machine" error={field("machineId")}>
                      {(p) => (
                        <Select {...p} value={form.machineId} onChange={set("machineId")}>
                          <option value="">Not machine-related</option>
                          {machines.data?.map((m) => (
                            <option key={m.id} value={m.id}>
                              {m.code} – {m.name}
                            </option>
                          ))}
                        </Select>
                      )}
                    </Field>
                    <Field label="Process" error={field("woProcessId")}>
                      {(p) => (
                        <Select {...p} value={form.woProcessId} onChange={set("woProcessId")}>
                          <option value="">Not process-related</option>
                          {mrs.data?.workOrder.processes.map((s) => (
                            <option key={s.id} value={s.id}>
                              {s.seq}. {s.name}
                            </option>
                          ))}
                        </Select>
                      )}
                    </Field>
                  </>
                )}
                <Field label="Remarks" className="sm:col-span-2" error={field("remarks")}>
                  {(p) => <Textarea {...p} rows={2} value={form.remarks} onChange={set("remarks")} />}
                </Field>
              </div>
            )}
          </>
        ) : (
          <ErrorState error={mrs.error} />
        )}
      </form>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Material Requisition Sheet
// ---------------------------------------------------------------------------

function NewMrsDialog({ onClose }: { onClose: () => void }) {
  const toast = useToast();
  const navigate = useNavigate();
  const [q, setQ] = useState("");
  const [wo, setWo] = useState<WoRow | null>(null);
  const jobs = useQuery({ queryKey: ["planning", "wos", "mrs-pick", q], queryFn: () => api.list<WoRow>(`/planning/work-orders${qs({ q, pageSize: 8 })}`) });
  const template = useQuery({ queryKey: ["planning", "mrs-template", wo?.id], queryFn: () => api.get<MrsTemplate>(`/material/work-orders/${wo!.id}/mrs-template`), enabled: !!wo });
  const [qty, setQty] = useState<Record<string, string>>({});
  const [remarks, setRemarks] = useState("");
  const { field, handle } = useFormError();
  const lines = Object.entries(qty)
    .filter(([, v]) => v.trim() !== "")
    .map(([sonCodeId, requestedQty]) => ({ sonCodeId, requestedQty }));
  const save = usePlanningMutation(() => api.post<{ id: string; mrsNo: string }>("/material/requisitions", { workOrderId: wo?.id, lines, remarks: remarks || null }));
  const submit = (e: FormEvent) => {
    e.preventDefault();
    save.mutate(undefined, { onSuccess: (r) => (toast.success(`${r.mrsNo} created. Issue the material from it.`), navigate(`/planning/material-requisition-sheet/${r.id}`)), onError: handle });
  };
  const pickable = (s: string) => ["PLANNED", "RELEASED", "IN_PROGRESS", "PARTIALLY_COMPLETED"].includes(s);
  return (
    <Dialog
      open
      onClose={onClose}
      size="lg"
      title="New Material Requisition Sheet"
      description="Choose the Job Order. Materials come from the BOM revision frozen on its Production Job Order."
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" type="submit" form="mrs-form" loading={save.isPending} disabled={!wo || !lines.length}>
            Create MRS
          </Button>
        </>
      }
    >
      <form id="mrs-form" onSubmit={submit} className="space-y-4" noValidate>
        {!wo ? (
          <div className="space-y-2">
            <Input placeholder="Search Job Order, PJO, Father Code" value={q} onChange={(e) => setQ(e.target.value)} data-autofocus />
            <div className="max-h-64 space-y-1 overflow-y-auto rounded-md border border-line p-1">
              {jobs.data?.data.map((j) => (
                <button key={j.id} type="button" disabled={!pickable(j.status)} onClick={() => setWo(j)} className="flex w-full flex-wrap items-center gap-2 rounded-md p-2 text-left text-sm hover:bg-surface-2 disabled:opacity-50">
                  <span className="font-medium">{j.woNo}</span>
                  <span className="min-w-0 truncate text-muted">
                    {j.pjoNo} · {j.fatherCode} · {j.quantity} {j.uom}
                  </span>
                  <span className="flex-1" />
                  <StatusBadge kind="wo" value={j.status} />
                </button>
              ))}
              {jobs.data?.data.length === 0 && <p className="p-2 text-sm text-muted">No Job Order matches.</p>}
            </div>
          </div>
        ) : (
          <>
            <div className="flex flex-wrap items-center gap-2 text-sm">
              <span className="font-medium">{wo.woNo}</span>
              <span className="text-muted">
                {wo.pjoNo} · {wo.quantity} {wo.uom}
              </span>
              <button type="button" className="text-xs text-primary hover:underline" onClick={() => (setWo(null), setQty({}))}>
                Change
              </button>
            </div>
            {template.isPending ? (
              <LoadingState />
            ) : template.error ? (
              <ErrorState error={template.error} />
            ) : template.data.pjo.status !== "RELEASED" ? (
              <p className="rounded-md bg-warning-soft p-2 text-sm text-warning">Release {template.data.pjo.pjoNo} first: the MRS uses the BOM revision frozen at release.</p>
            ) : !template.data.lines.length ? (
              <p className="rounded-md bg-warning-soft p-2 text-sm text-warning">{template.data.pjo.pjoNo} has no component list (Son Codes).</p>
            ) : (
              <div className="relative overflow-x-auto rounded-md border border-line">
                <p className="border-b border-line px-2 py-1.5 text-xs text-muted">BOM Rev {String(template.data.pjo.componentRevision).padStart(2, "0")} · leave a quantity empty to skip that material</p>
                <ul className="divide-y divide-line sm:hidden">
                  {template.data.lines.map((l, i) => (
                    <li key={l.sonCodeId} className="space-y-2 px-2 py-3">
                      <div>
                        <p className="font-medium">
                          {l.sonCode} · {l.materialCode}
                        </p>
                        <p className="text-xs text-muted">
                          {l.materialDescription} · BOM qty {l.bomQty ?? "—"} · already requested {l.alreadyRequested}
                        </p>
                      </div>
                      <div className="flex items-center gap-2">
                        <Input inputMode="decimal" placeholder="Request" value={qty[l.sonCodeId] ?? ""} onChange={(e) => setQty((s) => ({ ...s, [l.sonCodeId]: e.target.value }))} aria-label={`Request ${l.materialCode}`} aria-invalid={!!field(`lines.${i}.requestedQty`)} />
                        <span className="text-sm text-muted">{l.uom}</span>
                      </div>
                    </li>
                  ))}
                </ul>
                <table className="hidden w-full text-left text-sm sm:table">
                  <thead className="bg-surface-2 text-xs text-muted">
                    <tr>
                      <th className="px-2 py-1.5">Son Code / material</th>
                      <th className="px-2 py-1.5 text-right">BOM qty</th>
                      <th className="px-2 py-1.5 text-right">Already requested</th>
                      <th className="px-2 py-1.5">Request</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-line">
                    {template.data.lines.map((l, i) => (
                      <tr key={l.sonCodeId}>
                        <td className="px-2 py-1.5">
                          <p className="font-medium">
                            {l.sonCode} · {l.materialCode}
                          </p>
                          <p className="text-xs text-muted">{l.materialDescription}</p>
                        </td>
                        <td className="px-2 py-1.5 text-right tabular-nums">{l.bomQty ?? "—"}</td>
                        <td className="px-2 py-1.5 text-right tabular-nums">{l.alreadyRequested}</td>
                        <td className="px-2 py-1.5">
                          <div className="flex items-center gap-1">
                            <Input inputMode="decimal" className="w-28" value={qty[l.sonCodeId] ?? ""} onChange={(e) => setQty((s) => ({ ...s, [l.sonCodeId]: e.target.value }))} aria-label={`Request ${l.materialCode}`} aria-invalid={!!field(`lines.${i}.requestedQty`)} />
                            <span className="text-xs text-muted">{l.uom}</span>
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                <p className="px-2 py-1.5 text-xs text-muted">The BOM quantity basis (per label, per 1,000 or per order) is not confirmed yet, so the request is entered by the planner.</p>
              </div>
            )}
            {field("lines") && <p className="text-xs text-danger">{field("lines")}</p>}
            <Field label="Remarks" error={field("remarks")}>{(p) => <Textarea {...p} rows={2} value={remarks} onChange={(e) => setRemarks(e.target.value)} />}</Field>
          </>
        )}
      </form>
    </Dialog>
  );
}

export function MrsListPage() {
  const { can } = useAuth();
  const navigate = useNavigate();
  const { page, q, status, activeJob, set } = useListParams();
  const list = useMrsList({ page, q, status, activeJob: activeJob || undefined });
  const [creating, setCreating] = useState(false);
  const columns: Column<MrsRow>[] = [
    { key: "no", header: "MRS", cell: (m) => <span className="font-medium whitespace-nowrap">{m.mrsNo}</span> },
    {
      key: "wo",
      header: "Job Order",
      cell: (m) => (
        <div>
          <p className="whitespace-nowrap">{m.workOrder.woNo}</p>
          <p className="text-xs text-muted">
            {m.pjoNo} · {m.fatherCode}
          </p>
        </div>
      ),
    },
    { key: "lines", header: "Lines issued", className: "text-right", cell: (m) => <span className="tabular-nums">{m.linesFullyIssued} / {m.lineCount}</span> },
    { key: "out", header: "Lines with material out", hideOnMobile: true, className: "text-right", cell: (m) => <span className="tabular-nums">{m.linesWithOnHand}</span> },
    { key: "created", header: "Created", hideOnMobile: true, cell: (m) => formatDateTime(m.createdAt) },
    { key: "status", header: "Status", cell: (m) => <StatusBadge kind="mrs" value={m.status} /> },
  ];
  return (
    <>
      <PageHeader
        title="Material Requisition Sheet"
        description="Material requested for a Job Order from its frozen BOM, and issued against that request."
        crumbs={[{ label: "Planning" }, { label: "Material Requisition Sheet" }]}
        actions={can("planning.mrs.issue") && <Link to="/planning/material-requisition-sheet/issue"><Button>Issue material</Button></Link>}
      />
      <DataTable
        columns={columns}
        rows={list.data?.data}
        rowKey={(m) => m.id}
        loading={list.isPending}
        error={list.error}
        onRetry={() => void list.refetch()}
        page={page}
        pageCount={list.data?.meta.pageCount}
        total={list.data?.meta.total}
        onPage={(p) => set({ page: String(p) })}
        onRowClick={(m) => navigate(`/planning/material-requisition-sheet/${m.id}`)}
        toolbar={
          <>
            <SearchInput value={q} onChange={(v) => set({ q: v })} placeholder="MRS, Job Order, PJO, material code" />
            <Select value={status} onChange={(e) => set({ status: e.target.value })} className="sm:w-44" aria-label="Status">
              <option value="">All statuses</option>
              <option value="OPEN,PARTIALLY_ISSUED">Waiting for material</option>
              <option value="OPEN">Open</option>
              <option value="PARTIALLY_ISSUED">Partly issued</option>
              <option value="ISSUED">Issued</option>
              <option value="CLOSED">Closed</option>
              <option value="CANCELLED">Cancelled</option>
            </Select>
            {activeJob && (
              <button onClick={() => set({ activeJob: "" })} className="inline-flex items-center gap-1 rounded-full bg-primary-soft px-2.5 py-1 text-xs font-medium text-primary" aria-label="Clear the live Job Orders filter">
                Live Job Orders only ×
              </button>
            )}
            <div className="flex-1" />
            {can("planning.mrs.issue") && (
              <Button variant="primary" icon={<Plus className="size-4" />} onClick={() => setCreating(true)}>
                New MRS
              </Button>
            )}
          </>
        }
        empty={<p className="px-4 py-12 text-center text-sm text-muted">No Material Requisition Sheets yet.</p>}
      />
      {creating && <NewMrsDialog onClose={() => setCreating(false)} />}
    </>
  );
}

export function MrsDetailPage() {
  const { id = "" } = useParams();
  const { can } = useAuth();
  const mrs = useMrs(id);
  const [move, setMove] = useState<{ type: MovementType; lineId: string } | null>(null);
  const [cancelling, setCancelling] = useState(false);
  if (mrs.isPending) return <LoadingState />;
  if (mrs.error) return <ErrorState error={mrs.error} onRetry={() => void mrs.refetch()} />;
  const m = mrs.data;
  const open = !["CLOSED", "CANCELLED"].includes(m.status);
  const types: MovementType[] = ["ISSUE", "ADDITIONAL_ISSUE", "RETURN", "REJECT", "SCRAP"];
  return (
    <>
      <PageHeader
        title={m.mrsNo}
        description={`${m.workOrder.woNo} · ${m.pjo.fatherCode} · ${m.pjo.labelDescription}`}
        crumbs={[{ label: "Planning" }, { label: "Material Requisition Sheet", to: "/planning/material-requisition-sheet" }, { label: m.mrsNo }]}
        actions={
          <>
            <PrintDocumentButton type="MRS" id={m.id} />
            {open && can("planning.mrs.issue") ? (
            <>
              {m.lines.some((l) => Number(l.remainingToIssue) > 0) && (
                <Link to={`/planning/material-requisition-sheet/issue?mrs=${m.id}`}>
                  <Button variant="primary">Issue lines</Button>
                </Link>
              )}
              {m.transactions.length === 0 && <Button onClick={() => setCancelling(true)}>Cancel MRS</Button>}
            </>
          ) : null}
          </>
        }
      />
      <div className="mb-4 flex flex-wrap items-center gap-2 text-sm">
        <StatusBadge kind="mrs" value={m.status} />
        <Link to={`/planning/job-order/${m.workOrder.id}`} className="text-primary hover:underline">
          {m.workOrder.woNo}
        </Link>
        <StatusBadge kind="wo" value={m.workOrder.status} />
        <span className="text-muted">
          {m.workOrder.quantity} {m.workOrder.uom} · {m.pjo.pjoNo} · BOM Rev {String(m.pjo.componentRevision ?? 0).padStart(2, "0")}
        </span>
        <span className="text-muted">· created by {m.createdBy ?? "—"} {formatDateTime(m.createdAt)}</span>
      </div>
      {m.status === "CLOSED" && <p className="mb-4 rounded-md bg-info-soft p-3 text-sm text-info">Closed {formatDateTime(m.closedAt)} when the production order was completed. No more material can move on it.</p>}
      <Card title="Lines" className="mb-4">
        <ul className="-my-2 divide-y divide-line sm:hidden">
          {m.lines.map((l) => {
            const acts = types.filter((t) => can(MOVEMENT_PERMISSION[t]) && allowed(t, l, open));
            return (
              <li key={l.id} className="py-3">
                <p className="font-medium">{l.materialCode}</p>
                <p className="text-xs text-muted">
                  {l.sonCode} · {l.materialDescription}
                </p>
                <div className="mt-2 grid grid-cols-3 gap-2 text-center text-xs">
                  {[
                    ["Requested", l.requested],
                    ["Issued + add.", `${l.issued} + ${l.additional}`],
                    ["Out on line", l.onHand],
                    ["Returned", l.returned],
                    ["Rejected", l.rejected],
                    ["Scrapped", l.scrapped],
                  ].map(([k, v]) => (
                    <div key={k} className="rounded-md bg-surface-2 p-1.5">
                      <p className="text-muted">{k}</p>
                      <p className="text-sm font-medium tabular-nums">{v}</p>
                    </div>
                  ))}
                </div>
                <p className="mt-1 text-xs text-muted">
                  Unit {l.uom}
                  {Number(l.remainingToIssue) > 0 && <span className="text-warning"> · {l.remainingToIssue} still to issue</span>}
                </p>
                {acts.length > 0 && (
                  <div className="mt-2 grid grid-cols-2 gap-2">
                    {acts.map((t) => (
                      <Button key={t} size="sm" variant={t === "ISSUE" ? "primary" : undefined} onClick={() => setMove({ type: t, lineId: l.id })}>
                        {MOVEMENT_LABEL[t]}
                      </Button>
                    ))}
                  </div>
                )}
              </li>
            );
          })}
        </ul>
        <div className="relative hidden overflow-x-auto sm:block">
          <table className="w-full text-left text-sm">
            <thead className="text-xs text-muted uppercase">
              <tr>
                <th className="px-2 py-2">Material</th>
                <th className="px-2 py-2 text-right">Requested</th>
                <th className="px-2 py-2 text-right">Issued</th>
                <th className="px-2 py-2 text-right">Additional</th>
                <th className="px-2 py-2 text-right">Returned</th>
                <th className="px-2 py-2 text-right">Rejected</th>
                <th className="px-2 py-2 text-right">Scrapped</th>
                <th className="px-2 py-2 text-right">Out on line</th>
                <th className="px-2 py-2" />
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {m.lines.map((l) => (
                <tr key={l.id} className="align-top">
                  <td className="px-2 py-2">
                    <p className="font-medium">{l.materialCode}</p>
                    <p className="text-xs text-muted">
                      {l.sonCode} · {l.materialDescription}
                    </p>
                  </td>
                  <td className="px-2 py-2 text-right tabular-nums">
                    {l.requested} <span className="text-xs text-muted">{l.uom}</span>
                  </td>
                  <td className="px-2 py-2 text-right tabular-nums">
                    {l.issued}
                    {Number(l.remainingToIssue) > 0 && <p className="text-xs text-warning">{l.remainingToIssue} to issue</p>}
                  </td>
                  <td className="px-2 py-2 text-right tabular-nums">{l.additional}</td>
                  <td className="px-2 py-2 text-right tabular-nums">{l.returned}</td>
                  <td className="px-2 py-2 text-right tabular-nums">{l.rejected}</td>
                  <td className="px-2 py-2 text-right tabular-nums">{l.scrapped}</td>
                  <td className="px-2 py-2 text-right font-medium tabular-nums">{l.onHand}</td>
                  <td className="px-2 py-2">
                    <div className="flex flex-wrap justify-end gap-1">
                      {types
                        .filter((t) => can(MOVEMENT_PERMISSION[t]) && allowed(t, l, open))
                        .map((t) => (
                          <Button key={t} size="sm" variant={t === "ISSUE" ? "primary" : undefined} onClick={() => setMove({ type: t, lineId: l.id })}>
                            {MOVEMENT_LABEL[t]}
                          </Button>
                        ))}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
      <Card title={`Movements (${m.transactions.length})`}>
        {m.transactions.length === 0 ? (
          <p className="py-6 text-center text-sm text-muted">Nothing issued yet.</p>
        ) : (
          <MovementTable rows={m.transactions} showType />
        )}
      </Card>
      {move && <MovementDialog type={move.type} mrsId={m.id} lineId={move.lineId} onClose={() => setMove(null)} />}
      {cancelling && (
        <NoteConfirmDialog
          title={`Cancel ${m.mrsNo}?`}
          message="Only possible while no material has moved on it."
          confirmLabel="Cancel MRS"
          tone="danger"
          noteLabel="Reason"
          run={(reason) => api.post(`/material/requisitions/${m.id}/cancel`, { reason })}
          success={`${m.mrsNo} cancelled.`}
          onClose={() => (setCancelling(false), void mrs.refetch())}
        />
      )}
    </>
  );
}

function MovementTable({ rows, showType }: { rows: MovementRow[]; showType?: boolean }) {
  return (
    <>
    <ul className="-my-2 divide-y divide-line sm:hidden">
      {rows.map((t) => (
        <li key={t.id} className="py-2.5 text-sm">
          <div className="flex items-center justify-between gap-2">
            <span className="font-medium">{t.txnNo}</span>
            {showType && <Badge tone={t.type === "ISSUE" ? "primary" : t.type === "RETURN" ? "info" : t.type === "ADDITIONAL_ISSUE" ? "warning" : "danger"}>{MOVEMENT_LABEL[t.type]}</Badge>}
          </div>
          <p>
            {t.materialCode} · <b className="tabular-nums">{t.qty} {t.uom}</b>
            {t.lotRef && <span className="text-muted"> · lot {t.lotRef}</span>}
          </p>
          {(t.reason || t.machine || t.process) && <p className="text-xs text-muted">{[t.reason, t.machine, t.process].filter(Boolean).join(" · ")}</p>}
          <p className="text-xs text-muted">
            {t.by ?? "—"} · {formatDateTime(t.at)}
          </p>
        </li>
      ))}
    </ul>
    <div className="relative hidden overflow-x-auto sm:block">
      <table className="w-full text-left text-sm">
        <thead className="text-xs text-muted uppercase">
          <tr>
            <th className="px-2 py-2">No.</th>
            {showType && <th className="px-2 py-2">Type</th>}
            <th className="px-2 py-2">Material</th>
            <th className="px-2 py-2 text-right">Qty</th>
            <th className="px-2 py-2">Lot / roll</th>
            <th className="px-2 py-2">Reason</th>
            <th className="px-2 py-2">By</th>
            <th className="px-2 py-2">When</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-line">
          {rows.map((t) => (
            <tr key={t.id}>
              <td className="px-2 py-2 font-medium whitespace-nowrap">{t.txnNo}</td>
              {showType && (
                <td className="px-2 py-2">
                  <Badge tone={t.type === "ISSUE" ? "primary" : t.type === "RETURN" ? "info" : t.type === "ADDITIONAL_ISSUE" ? "warning" : "danger"}>{MOVEMENT_LABEL[t.type]}</Badge>
                </td>
              )}
              <td className="px-2 py-2">{t.materialCode}</td>
              <td className="px-2 py-2 text-right tabular-nums whitespace-nowrap">
                {t.qty} {t.uom}
              </td>
              <td className="px-2 py-2">{t.lotRef ?? "—"}</td>
              <td className="px-2 py-2">
                {t.reason ?? "—"}
                {(t.machine || t.process) && <p className="text-xs text-muted">{[t.machine, t.process].filter(Boolean).join(" · ")}</p>}
                {t.remarks && <p className="text-xs text-muted">{t.remarks}</p>}
              </td>
              <td className="px-2 py-2">{t.by ?? "—"}</td>
              <td className="px-2 py-2 whitespace-nowrap">{formatDateTime(t.at)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
    </>
  );
}

// ---------------------------------------------------------------------------
// Registers: MRS Additional Issued, MRS Return, MRS Reject, Scrap Bad Material
// ---------------------------------------------------------------------------

export function ReasonsTab({ category }: { category: ReasonCategory }) {
  const { can } = useAuth();
  const toast = useToast();
  const reasons = useReasons(category);
  const [form, setForm] = useState({ code: "", description: "" });
  const { field, handle, setError } = useFormError();
  const add = usePlanningMutation(() => api.post("/material/reasons", { category, ...form }));
  const toggle = usePlanningMutation((v: { id: string; status: "ACTIVE" | "INACTIVE" }) => api.patch(`/material/reasons/${v.id}`, { status: v.status }));
  const manage = can("planning.reason.manage");
  return (
    <Card title="Reasons">
      {manage && (
        <form
          className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-end"
          noValidate
          onSubmit={(e) => {
            e.preventDefault();
            add.mutate(undefined, { onSuccess: () => (toast.success("Reason added."), setForm({ code: "", description: "" }), setError(null)), onError: handle });
          }}
        >
          <Field label="Code" required error={field("code")}>{(p) => <Input {...p} value={form.code} onChange={(e) => setForm((f) => ({ ...f, code: e.target.value }))} className="sm:w-40" />}</Field>
          <Field label="Description" required error={field("description")} className="flex-1">
            {(p) => <Input {...p} value={form.description} onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))} />}
          </Field>
          <Button type="submit" variant="primary" loading={add.isPending}>
            Add reason
          </Button>
        </form>
      )}
      {reasons.isPending ? (
        <LoadingState />
      ) : !reasons.data?.length ? (
        <p className="py-6 text-center text-sm text-muted">No reasons yet. Movements of this type need one, so add the factory's reasons first.</p>
      ) : (
        <ul className="divide-y divide-line text-sm">
          {reasons.data.map((r) => (
            <li key={r.id} className="flex flex-wrap items-center gap-3 py-2">
              <span className="font-medium">{r.code}</span>
              <span className="flex-1">{r.description}</span>
              <StatusBadge kind="record" value={r.status} />
              {manage && (
                <Button size="sm" onClick={() => toggle.mutate({ id: r.id, status: r.status === "ACTIVE" ? "INACTIVE" : "ACTIVE" }, { onError: toast.error })}>
                  {r.status === "ACTIVE" ? "Deactivate" : "Activate"}
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

/** The four TBS register menus, shown as tabs of one Material Movement register. */
const REGISTER_TABS: { type: Exclude<MovementType, "ISSUE">; label: string; permission: string }[] = [
  { type: "ADDITIONAL_ISSUE", label: "MRS Additional Issued", permission: "planning.mrs.view" },
  { type: "RETURN", label: "MRS Return", permission: "shopfloor.mrs.return" },
  { type: "REJECT", label: "MRS Reject", permission: "shopfloor.mrs.reject" },
  { type: "SCRAP", label: "Scrap Bad Material", permission: "shopfloor.scrap.record" },
];

/**
 * Planning › Material Movement: one register for MRS Additional Issued, MRS
 * Return, MRS Reject and Scrap Bad Material (tabs, ?type=), plus All
 * movements. Each person sees the tabs their permissions allow.
 */
export function MaterialMovementPage() {
  const { can } = useAuth();
  const [params] = useSearchParams();
  const { page, q, tab, set } = useListParams();
  const from = params.get("from") ?? "";
  const to = params.get("to") ?? "";
  const allowed = REGISTER_TABS.filter((t) => can(t.permission));
  const raw = params.get("type");
  const all = raw === "ALL" || params.get("view") === "all";
  const type = (allowed.find((t) => t.type === raw) ?? allowed[0] ?? REGISTER_TABS[1]!).type;
  const list = useMovements({ page, type: all ? undefined : type, q, from: from || undefined, to: to || undefined });
  const [recording, setRecording] = useState(false);
  const category = REASON_OF[type];
  const tabs = [...allowed.map((t) => ({ id: t.type as string, label: t.label })), { id: "ALL", label: "All movements" }];
  const columns: Column<MovementRow>[] = [
    { key: "no", header: "No.", cell: (t) => <span className="font-medium whitespace-nowrap">{t.txnNo}</span> },
    ...(all ? [{ key: "type", header: "Type", cell: (t: MovementRow) => <Badge tone={t.type === "ISSUE" || t.type === "ADDITIONAL_ISSUE" ? "info" : t.type === "RETURN" ? "success" : "warning"}>{MOVEMENT_LABEL[t.type]}</Badge> }] : []),
    {
      key: "mrs",
      header: "MRS / Job Order",
      cell: (t) => (
        <div>
          <Link to={`/planning/material-requisition-sheet/${t.mrsId}`} className="text-primary hover:underline" onClick={(e) => e.stopPropagation()}>
            {t.mrsNo}
          </Link>
          <p className="text-xs text-muted">{t.woNo}</p>
        </div>
      ),
    },
    {
      key: "mat",
      header: "Material",
      cell: (t) => (
        <div className="min-w-0">
          <p>{t.materialCode}</p>
          <p className="line-clamp-1 max-w-xs text-xs text-muted">{t.materialDescription}</p>
        </div>
      ),
    },
    { key: "qty", header: "Qty", className: "text-right", cell: (t) => <span className="tabular-nums whitespace-nowrap">{t.qty} {t.uom}</span> },
    { key: "lot", header: "Lot / roll", hideOnMobile: true, cell: (t) => t.lotRef ?? "—" },
    ...(type !== "RETURN"
      ? [
          {
            key: "reason",
            header: type === "SCRAP" ? "Reason / where" : "Reason",
            hideOnMobile: true,
            cell: (t: MovementRow) => (
              <div>
                <p>{t.reason ?? "—"}</p>
                {(t.machine || t.process) && <p className="text-xs text-muted">{[t.machine, t.process].filter(Boolean).join(" · ")}</p>}
              </div>
            ),
          },
        ]
      : []),
    { key: "by", header: "By", hideOnMobile: true, cell: (t) => t.by ?? "—" },
    { key: "at", header: "When", cell: (t) => <span className="whitespace-nowrap">{formatDateTime(t.at)}</span> },
  ];
  return (
    <>
      <PageHeader
        title="Material Movement"
        description="Material moved after the MRS issue: additional issue (beyond the request, with a reason), return to the store, reject (damaged / defective) and scrap during production."
        crumbs={[{ label: "Planning" }, { label: "Material Movement" }]}
      />
      <Tabs tabs={tabs} value={all ? "ALL" : type} onChange={(id) => set({ type: id, view: "" })} />
      {tab === "reasons" && category ? (
        <Navigate to={`/master-data/reason-code?category=${category}`} replace />
      ) : (
        <DataTable
          columns={columns}
          rows={list.data?.data}
          rowKey={(t) => t.id}
          loading={list.isPending}
          error={list.error}
          onRetry={() => void list.refetch()}
          page={page}
          pageCount={list.data?.meta.pageCount}
          total={list.data?.meta.total}
          onPage={(p) => set({ page: String(p) })}
          toolbar={
            <>
              <SearchInput value={q} onChange={(v) => set({ q: v })} placeholder="No., MRS, material, lot" />
              <div className="flex items-center gap-1">
                <Input type="date" value={from} onChange={(e) => set({ from: e.target.value })} className="w-auto flex-1 sm:w-38" aria-label="From date" />
                <span className="text-sm text-muted">to</span>
                <Input type="date" value={to} onChange={(e) => set({ to: e.target.value })} className="w-auto flex-1 sm:w-38" aria-label="To date" />
              </div>
              <div className="flex-1" />
              {!all && category && (
                <Link to={`/master-data/reason-code?category=${category}`} className="text-sm text-primary hover:underline">
                  Reasons
                </Link>
              )}
              {!all && can(MOVEMENT_PERMISSION[type]) && (
                <Button variant="primary" icon={<Plus className="size-4" />} onClick={() => setRecording(true)}>
                  Record {MOVEMENT_LABEL[type].toLowerCase()}
                </Button>
              )}
            </>
          }
          empty={<p className="px-4 py-12 text-center text-sm text-muted">{q || from || to ? "No movements match your filters." : all ? "No material movements yet." : `No ${MOVEMENT_LABEL[type].toLowerCase()} recorded yet.`}</p>}
        />
      )}
      {recording && <MovementDialog type={type} onClose={() => setRecording(false)} />}
    </>
  );
}


