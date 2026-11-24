import { PrintDocumentButton } from "@/modules/documents/print-dialog";
import { useQuery } from "@tanstack/react-query";
import { CheckCircle2, ClipboardCheck, Plus, RotateCcw, Trash2, XCircle } from "lucide-react";
import { useState, type FormEvent } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router";
import { DataTable, ErrorState, LoadingState, PageHeader, SearchInput, Tabs, type Column } from "@/components/common";
import { StatusBadge } from "@/components/status";
import { Badge, Button, Card, Dialog, Field, Input, Select, Textarea } from "@/components/ui";
import { api, qs } from "@/lib/api";
import { formatDateTime } from "@/lib/utils";
import { useFormError } from "@/lib/use-form-error";
import { useAuth } from "@/stores/auth";
import { useToast } from "@/stores/toast";
import {
  DISPOSITION_LABEL,
  DISPOSITIONS,
  useDefects,
  useInspection,
  useInspections,
  useInspectionTemplates,
  useOqcCandidates,
  useQcMutation,
  type CheckResult,
  type Disposition,
  type InspectionDetail,
  type InspectionRow,
  type QcType,
} from "./api";

const PATH: Record<QcType, string> = { IQC: "/qc/iqc-check-in-out", OQC: "/qc/oqc-check-in-out" };
const TITLE: Record<QcType, string> = { IQC: "IQC Check In/Check Out", OQC: "OQC Check In/Check Out" };

// ---------------------------------------------------------------------------
// List
// ---------------------------------------------------------------------------

function InspectionList({ type }: { type: QcType }) {
  const { can } = useAuth();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const set = (patch: Record<string, string>) =>
    setParams((prev) => {
      const next = new URLSearchParams(prev);
      for (const [k, v] of Object.entries(patch)) v ? next.set(k, v) : next.delete(k);
      if (!("page" in patch)) next.delete("page");
      return next;
    });
  const page = Number(params.get("page") ?? 1);
  const q = params.get("q") ?? "";
  const view = (params.get("view") as "open" | "closed" | "all" | null) ?? "open";
  const list = useInspections(type, { page, q, view });
  const counts = (list.data?.meta as { counts?: { inInspection: number; pendingDisposition: number } } | undefined)?.counts;
  const [checkingIn, setCheckingIn] = useState(false);
  const lot: Column<InspectionRow> =
    type === "IQC"
      ? {
          key: "lot",
          header: "Part / lot",
          cell: (i) => (
            <div className="min-w-0">
              <p className="font-medium">{i.part?.code}</p>
              <p className="line-clamp-1 max-w-xs text-xs text-muted">
                Lot {i.lotRef}
                {i.supplierName ? ` · ${i.supplierName}` : ""}
              </p>
            </div>
          ),
        }
      : {
          key: "lot",
          header: "Job Order",
          cell: (i) => (
            <div className="min-w-0">
              <p className="font-medium">{i.workOrder?.woNo}</p>
              <p className="line-clamp-1 max-w-xs text-xs text-muted">
                {i.workOrder?.fatherCode} · {i.workOrder?.pjoNo}
                {i.reinspectionOf ? ` · reinspection of ${i.reinspectionOf.inspNo}` : ""}
              </p>
            </div>
          ),
        };
  const columns: Column<InspectionRow>[] = [
    { key: "no", header: "No.", cell: (i) => <span className="font-medium whitespace-nowrap">{i.inspNo}</span> },
    lot,
    {
      key: "qty",
      header: "Qty",
      className: "text-right",
      cell: (i) => (
        <span className="whitespace-nowrap tabular-nums">
          {i.qty} {i.uom}
        </span>
      ),
    },
    { key: "in", header: "Checked in", hideOnMobile: true, cell: (i) => <span className="text-xs whitespace-nowrap">{formatDateTime(i.checkedInAt)}<br />{i.checkedInBy}</span> },
    { key: "status", header: "Status", cell: (i) => <StatusBadge kind="qc" value={i.status} /> },
  ];
  return (
    <>
      <PageHeader
        title={TITLE[type]}
        description={
          type === "IQC"
            ? "Check In puts a received part lot on QC hold; Check Out records the checks and releases it, or holds it for a supervisor's disposition."
            : "Check In offers a Job Order's finished labels to QC; Check Out records the checks. Released lots can get shipping labels; reworked lots are reinspected."
        }
        crumbs={[{ label: "QC" }, { label: TITLE[type] }]}
        actions={
          can(`qc.${type.toLowerCase()}.inspect`) && (
            <Button variant="primary" icon={<Plus className="size-4" />} onClick={() => (type === "IQC" ? navigate("/qc/iqc-check-in-out/receive") : setCheckingIn(true))}>
              Check In
            </Button>
          )
        }
      />
      <Tabs
        value={view}
        onChange={(id) => set({ view: id === "open" ? "" : id })}
        tabs={[
          { id: "open", label: <>Open {counts && <span className="ml-1 rounded-full bg-surface-2 px-1.5 text-xs tabular-nums">{counts.inInspection + counts.pendingDisposition}</span>}</> },
          { id: "closed", label: "Closed" },
          { id: "all", label: "All" },
        ]}
      />
      {counts && counts.pendingDisposition > 0 && view === "open" && (
        <p className="mb-3 rounded-md bg-warning-soft px-3 py-2 text-sm text-warning">
          {counts.pendingDisposition} lot{counts.pendingDisposition === 1 ? "" : "s"} failed and wait{counts.pendingDisposition === 1 ? "s" : ""} for a QC supervisor's disposition.
        </p>
      )}
      <DataTable
        columns={columns}
        rows={list.data?.data}
        rowKey={(i) => i.id}
        loading={list.isPending}
        error={list.error}
        onRetry={() => void list.refetch()}
        page={page}
        pageCount={list.data?.meta.pageCount}
        total={list.data?.meta.total}
        onPage={(p) => set({ page: String(p) })}
        onRowClick={(i) => navigate(`${PATH[type]}/${i.id}`)}
        toolbar={<SearchInput value={q} onChange={(v) => set({ q: v })} placeholder={type === "IQC" ? "No., part, lot, DO, supplier" : "No., Job Order, PJO"} />}
        empty={<p className="px-4 py-12 text-center text-sm text-muted">{q ? "No inspections match." : view === "open" ? "Nothing in inspection right now." : "No inspections yet."}</p>}
      />
      {checkingIn && (type === "IQC" ? <IqcCheckInDialog onClose={() => setCheckingIn(false)} /> : <OqcCheckInDialog onClose={() => setCheckingIn(false)} />)}
    </>
  );
}

export const IqcPage = () => <InspectionList type="IQC" />;
export const OqcPage = () => <InspectionList type="OQC" />;

// ---------------------------------------------------------------------------
// Check In
// ---------------------------------------------------------------------------

interface PartOption {
  id: string;
  code: string;
  description: string;
  uom: string;
  category: string | null;
}

function IqcCheckInDialog({ onClose }: { onClose: () => void }) {
  const toast = useToast();
  const navigate = useNavigate();
  const { field, handle } = useFormError();
  const [search, setSearch] = useState("");
  const parts = useQuery({ queryKey: ["qc", "part-lookup", search], queryFn: () => api.get<PartOption[]>(`/materials/lookup${qs({ q: search })}`) });
  const templates = useInspectionTemplates({ type: "IQC", status: "ACTIVE" });
  const [form, setForm] = useState({ materialId: "", lotRef: "", supplierName: "", deliveryRef: "", qty: "", sampleSize: "", templateId: "", remarks: "" });
  const part = parts.data?.find((p) => p.id === form.materialId);
  const set = (k: keyof typeof form) => (e: { target: { value: string } }) => setForm((f) => ({ ...f, [k]: e.target.value }));
  const save = useQcMutation(() => api.post<{ id: string; inspNo: string }>("/qc/iqc", { ...form, templateId: form.templateId || null, sampleSize: form.sampleSize || null }));
  const submit = (e: FormEvent) => {
    e.preventDefault();
    save.mutate(undefined, { onSuccess: (r) => (toast.success(`${r.inspNo} checked in.`), onClose(), navigate(`${PATH.IQC}/${r.id}`)), onError: handle });
  };
  return (
    <Dialog
      open
      onClose={onClose}
      title="IQC Check In"
      description="The lot goes on QC hold until it is checked out."
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" type="submit" form="iqc-in" loading={save.isPending}>
            Check In
          </Button>
        </>
      }
    >
      <form id="iqc-in" onSubmit={submit} className="grid gap-4 sm:grid-cols-2" noValidate>
        <Field label="Find part" className="sm:col-span-2">{(p) => <Input {...p} value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Part code or description" />}</Field>
        <Field label="Part" required error={field("materialId")} className="sm:col-span-2">
          {(p) => (
            <Select {...p} value={form.materialId} onChange={set("materialId")}>
              <option value="">Choose…</option>
              {parts.data?.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.code} – {m.description}
                  {m.category ? ` (${m.category})` : ""}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field label="Lot / roll no." required error={field("lotRef")}>{(p) => <Input {...p} value={form.lotRef} onChange={set("lotRef")} />}</Field>
        <Field label={`Quantity${part ? ` (${part.uom})` : ""}`} required error={field("qty")}>{(p) => <Input {...p} inputMode="decimal" value={form.qty} onChange={set("qty")} />}</Field>
        <Field label="Supplier" error={field("supplierName")} hint="Defaults to the part's supplier.">{(p) => <Input {...p} value={form.supplierName} onChange={set("supplierName")} />}</Field>
        <Field label="Delivery order / GRN" error={field("deliveryRef")}>{(p) => <Input {...p} value={form.deliveryRef} onChange={set("deliveryRef")} />}</Field>
        <Field label="Sample size" error={field("sampleSize")} hint="Empty = 100 % inspection.">{(p) => <Input {...p} inputMode="decimal" value={form.sampleSize} onChange={set("sampleSize")} />}</Field>
        <Field label="Template" error={field("templateId")} hint="Empty = the part category's default.">
          {(p) => (
            <Select {...p} value={form.templateId} onChange={set("templateId")}>
              <option value="">Default</option>
              {templates.data?.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.code} – {t.name}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field label="Remarks" error={field("remarks")} className="sm:col-span-2">{(p) => <Textarea {...p} rows={2} value={form.remarks} onChange={set("remarks")} />}</Field>
      </form>
    </Dialog>
  );
}

function OqcCheckInDialog({ onClose }: { onClose: () => void }) {
  const toast = useToast();
  const navigate = useNavigate();
  const { field, handle } = useFormError();
  const [search, setSearch] = useState("");
  const candidates = useOqcCandidates(search);
  const templates = useInspectionTemplates({ type: "OQC", status: "ACTIVE" });
  const [form, setForm] = useState({ workOrderId: "", qty: "", sampleSize: "", templateId: "", remarks: "" });
  const wo = candidates.data?.find((c) => c.id === form.workOrderId);
  const set = (k: keyof typeof form) => (e: { target: { value: string } }) => setForm((f) => ({ ...f, [k]: e.target.value }));
  const save = useQcMutation(() => api.post<{ id: string; inspNo: string }>("/qc/oqc", { ...form, templateId: form.templateId || null, sampleSize: form.sampleSize || null }));
  const submit = (e: FormEvent) => {
    e.preventDefault();
    save.mutate(undefined, { onSuccess: (r) => (toast.success(`${r.inspNo} checked in.`), onClose(), navigate(`${PATH.OQC}/${r.id}`)), onError: handle });
  };
  return (
    <Dialog
      open
      onClose={onClose}
      title="OQC Check In"
      description="Offer finished labels of a Job Order to QC (up to the good output of its last process)."
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" type="submit" form="oqc-in" loading={save.isPending}>
            Check In
          </Button>
        </>
      }
    >
      <form id="oqc-in" onSubmit={submit} className="grid gap-4 sm:grid-cols-2" noValidate>
        <Field label="Find Job Order" className="sm:col-span-2">{(p) => <Input {...p} value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Job Order or PJO no." />}</Field>
        <Field label="Job Order" required error={field("workOrderId")} className="sm:col-span-2" hint={candidates.data && !candidates.data.length ? "No Job Order has finished output waiting for OQC." : undefined}>
          {(p) => (
            <Select {...p} value={form.workOrderId} onChange={(e) => setForm((f) => ({ ...f, workOrderId: e.target.value, qty: candidates.data?.find((c) => c.id === e.target.value)?.availableQty ?? "" }))}>
              <option value="">Choose…</option>
              {candidates.data?.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.woNo} · {c.fatherCode} · {c.availableQty} {c.uom} waiting
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field label={`Quantity${wo ? ` (max ${wo.availableQty} ${wo.uom})` : ""}`} required error={field("qty")}>{(p) => <Input {...p} inputMode="decimal" value={form.qty} onChange={set("qty")} />}</Field>
        <Field label="Sample size" error={field("sampleSize")} hint="Empty = 100 % inspection.">{(p) => <Input {...p} inputMode="decimal" value={form.sampleSize} onChange={set("sampleSize")} />}</Field>
        <Field label="Template" error={field("templateId")} className="sm:col-span-2" hint="Empty = the first active OQC template.">
          {(p) => (
            <Select {...p} value={form.templateId} onChange={set("templateId")}>
              <option value="">Default</option>
              {templates.data?.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.code} – {t.name}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field label="Remarks" error={field("remarks")} className="sm:col-span-2">{(p) => <Textarea {...p} rows={2} value={form.remarks} onChange={set("remarks")} />}</Field>
      </form>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Detail: Check Out, disposition, reinspection
// ---------------------------------------------------------------------------

const Info = ({ label, children }: { label: string; children: React.ReactNode }) => (
  <div className="contents">
    <dt className="text-muted">{label}</dt>
    <dd className="min-w-0 break-words">{children}</dd>
  </div>
);

function checkLimit(c: CheckResult) {
  if (c.kind !== "MEASURE") return c.target ?? "";
  const range = c.min != null && c.max != null ? `${c.min}–${c.max}` : c.min != null ? `≥ ${c.min}` : `≤ ${c.max}`;
  return `${range}${c.unit ? ` ${c.unit}` : ""}${c.target ? ` (target ${c.target})` : ""}`;
}

function InspectionDetailPage({ type }: { type: QcType }) {
  const { id = "" } = useParams();
  const { can } = useAuth();
  const navigate = useNavigate();
  const toast = useToast();
  const insp = useInspection(id);
  const [dialog, setDialog] = useState<"dispose" | "reinspect" | null>(null);
  const reinspect = useQcMutation(() => api.post<{ id: string; inspNo: string }>(`/qc/inspections/${id}/reinspect`, {}));
  if (insp.isPending) return <LoadingState />;
  if (insp.error) return <ErrorState error={insp.error} onRetry={() => void insp.refetch()} />;
  const i = insp.data;
  const lower = type.toLowerCase();
  return (
    <>
      <PageHeader
        title={i.inspNo}
        description={type === "IQC" ? `${i.part?.code} · lot ${i.lotRef}` : `${i.workOrder?.woNo} · ${i.workOrder?.fatherCode}`}
        crumbs={[{ label: "QC" }, { label: TITLE[type], to: PATH[type] }, { label: i.inspNo }]}
        actions={
          <>
            <PrintDocumentButton type={type === "IQC" ? "IQC_REPORT" : "OQC_REPORT"} id={i.id} label="Print report" />
            {i.status === "PENDING_DISPOSITION" && can(`qc.${lower}.disposition`) && (
              <Button variant="primary" onClick={() => setDialog("dispose")}>
                Disposition
              </Button>
            )}
            {i.status === "REWORK" && !i.reinspection && can("qc.oqc.inspect") && (
              <Button
                variant="primary"
                icon={<RotateCcw className="size-4" />}
                loading={reinspect.isPending}
                onClick={() => reinspect.mutate(undefined, { onSuccess: (r) => (toast.success(`${r.inspNo} checked in for reinspection.`), navigate(`${PATH.OQC}/${r.id}`)), onError: (e) => toast.error(e) })}
              >
                Reinspect after rework
              </Button>
            )}
            {type === "OQC" && (i.status === "PASSED" || i.status === "ACCEPTED") && can("qc.label.generate") && Number(i.releasedQty) > Number(i.labelledQty) && (
              <Link to={`/qc/shipping-label?lot=${i.id}`}>
                <Button variant="primary">Shipping labels</Button>
              </Link>
            )}
          </>
        }
      />
      <div className="mb-4 grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        <Card title="Lot">
          <dl className="grid gap-x-4 gap-y-2 text-sm sm:grid-cols-[9rem_1fr]">
            <Info label="Status">
              <StatusBadge kind="qc" value={i.status} />
              {i.result && <Badge tone={i.result === "PASS" ? "success" : "danger"} className="ml-1.5">{i.result === "PASS" ? "Pass" : "Fail"}</Badge>}
            </Info>
            {type === "IQC" ? (
              <>
                <Info label="Part">
                  {i.part?.code} – {i.part?.description}
                </Info>
                <Info label="Lot / roll">{i.lotRef}</Info>
                <Info label="Supplier">{i.supplierName ?? "—"}</Info>
                <Info label="Delivery / GRN">{i.deliveryRef ?? "—"}</Info>
              </>
            ) : (
              <>
                <Info label="Job Order">
                  <Link to={`/planning/job-order/${i.workOrder?.id}`} className="text-primary hover:underline">
                    {i.workOrder?.woNo}
                  </Link>{" "}
                  · {i.workOrder?.pjoNo}
                </Info>
                <Info label="Label">
                  {i.workOrder?.fatherCode} · {i.workOrder?.labelDescription}
                </Info>
                {i.reinspectionOf && (
                  <Info label="Reinspection of">
                    <Link to={`${PATH.OQC}/${i.reinspectionOf.id}`} className="text-primary hover:underline">
                      {i.reinspectionOf.inspNo}
                    </Link>
                  </Info>
                )}
                {i.reinspection && (
                  <Info label="Reinspected in">
                    <Link to={`${PATH.OQC}/${i.reinspection.id}`} className="text-primary hover:underline">
                      {i.reinspection.inspNo}
                    </Link>
                  </Info>
                )}
              </>
            )}
            <Info label="Quantity">
              {i.qty} {i.uom}
              {i.sampleSize ? ` · sample ${i.sampleSize}` : " · 100 %"}
            </Info>
            {i.goodQty !== null && (
              <Info label="Good / reject">
                {i.goodQty} / {i.rejectQty} {i.uom}
              </Info>
            )}
            <Info label="Checked in">
              {formatDateTime(i.checkedInAt)} · {i.checkedInBy}
            </Info>
            {i.checkedOutAt && (
              <Info label="Checked out">
                {formatDateTime(i.checkedOutAt)} · {i.checkedOutBy}
              </Info>
            )}
            {i.disposition && (
              <Info label="Disposition">
                {DISPOSITION_LABEL[i.disposition]} · {i.dispositionBy}
                <p className="text-xs text-muted">{i.dispositionNote}</p>
              </Info>
            )}
            {i.remarks && <Info label="Remarks">{i.remarks}</Info>}
            {type === "OQC" && (i.status === "PASSED" || i.status === "ACCEPTED") && (
              <Info label="Labelled">
                {i.labelledQty} of {i.releasedQty} {i.uom}
              </Info>
            )}
          </dl>
        </Card>
        {i.status === "IN_INSPECTION" && can(`qc.${lower}.inspect`) ? <CheckOutCard i={i} /> : <ResultsCard i={i} />}
      </div>
      {i.labels.length > 0 && (
        <Card title={`Shipping labels (${i.labels.filter((l) => l.status === "ACTIVE").length})`}>
          <ul className="divide-y divide-line text-sm">
            {i.labels.map((l) => (
              <li key={l.id} className="flex flex-wrap items-center gap-3 py-2">
                <span className="font-medium">{l.labelNo}</span>
                <span className="text-muted">
                  Carton {l.cartonNo} / {l.cartonCount}
                </span>
                <span className="tabular-nums">
                  {l.qty} {l.uom}
                </span>
                <span className="flex-1" />
                {l.status === "VOID" ? <Badge tone="neutral">Void</Badge> : <Badge tone={l.printCount ? "success" : "warning"}>{l.printCount ? `Printed ×${l.printCount}` : "Not printed"}</Badge>}
              </li>
            ))}
          </ul>
        </Card>
      )}
      {dialog === "dispose" && <DispositionDialog i={i} onClose={() => setDialog(null)} />}
    </>
  );
}

export const IqcDetailPage = () => <InspectionDetailPage type="IQC" />;
export const OqcDetailPage = () => <InspectionDetailPage type="OQC" />;

function ResultsCard({ i }: { i: InspectionDetail }) {
  return (
    <Card title="Checks and defects">
      {i.status === "IN_INSPECTION" ? (
        <p className="py-4 text-sm text-muted">In inspection. An inspector records the results at Check Out.</p>
      ) : (
        <>
          {i.checks.length === 0 ? (
            <p className="text-sm text-muted">No template checks.</p>
          ) : (
            <ul className="space-y-1.5 text-sm">
              {i.checks.map((c, n) => (
                <li key={n} className="flex items-start gap-2">
                  {c.pass === true ? <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-success" /> : c.pass === false ? <XCircle className="mt-0.5 size-4 shrink-0 text-danger" /> : <span className="mt-0.5 size-4 shrink-0 text-center text-muted">–</span>}
                  <span className="min-w-0 flex-1">
                    {c.label}
                    {c.kind === "MEASURE" && c.value !== null && <span className="tabular-nums"> · {c.value}{c.unit ? ` ${c.unit}` : ""}</span>}
                    <span className="block text-xs text-muted">{checkLimit(c)}{c.note ? ` · ${c.note}` : ""}</span>
                  </span>
                </li>
              ))}
            </ul>
          )}
          {i.defects.length > 0 && (
            <ul className="mt-4 space-y-1 border-t border-line pt-3 text-sm">
              {i.defects.map((d) => (
                <li key={d.id} className="flex flex-wrap items-center gap-2">
                  <span className="font-medium">{d.code}</span> {d.name}
                  <StatusBadge kind="severity" value={d.severity} />
                  <span className="flex-1" />
                  <span className="tabular-nums">× {d.qty}</span>
                  {d.remark && <span className="w-full text-xs text-muted">{d.remark}</span>}
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </Card>
  );
}

function CheckOutCard({ i }: { i: InspectionDetail }) {
  const toast = useToast();
  const { field, handle } = useFormError();
  const defects = useDefects({ status: "ACTIVE", type: i.type });
  const [results, setResults] = useState(i.checks.map(() => ({ pass: null as boolean | null, value: "", note: "" })));
  const [found, setFound] = useState<{ defectCodeId: string; qty: string; remark: string }[]>([]);
  const [rejectQty, setRejectQty] = useState("");
  const [remarks, setRemarks] = useState("");
  const setResult = (n: number, patch: Partial<(typeof results)[number]>) => setResults((r) => r.map((x, j) => (j === n ? { ...x, ...patch } : x)));
  const save = useQcMutation(() =>
    api.post<{ status: string; result: "PASS" | "FAIL" }>(`/qc/inspections/${i.id}/check-out`, {
      results: results.map((r, index) => ({ index, pass: r.pass, value: r.value.trim() === "" ? null : Number(r.value), note: r.note || null })),
      rejectQty: rejectQty || null,
      defects: found,
      remarks: remarks || null,
    }),
  );
  const submit = (e: FormEvent) => {
    e.preventDefault();
    save.mutate(undefined, {
      onSuccess: (r) => (r.result === "PASS" ? toast.success(`${i.inspNo} passed and is released.`) : toast.error(`${i.inspNo} failed; it waits for a supervisor's disposition.`)),
      onError: handle,
    });
  };
  const measureState = (c: CheckResult, v: string) => {
    if (v.trim() === "" || Number.isNaN(Number(v))) return null;
    const n = Number(v);
    return (c.min == null || n >= c.min) && (c.max == null || n <= c.max);
  };
  return (
    <Card title="Check Out">
      <form onSubmit={submit} className="space-y-4" noValidate>
        {i.checks.length === 0 && <p className="text-sm text-muted">No template checks: record defects and the reject quantity.</p>}
        <ul className="space-y-3">
          {i.checks.map((c, n) => {
            const r = results[n]!;
            const ok = c.kind === "MEASURE" ? measureState(c, r.value) : r.pass;
            return (
              <li key={n} className="rounded-lg border border-line p-3">
                <div className="flex items-start gap-2">
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium">
                      {c.label}
                      {c.required && <span className="text-danger"> *</span>}
                    </p>
                    <p className="text-xs text-muted">{checkLimit(c)}</p>
                  </div>
                  {ok === true && <CheckCircle2 className="size-5 text-success" aria-label="Pass" />}
                  {ok === false && <XCircle className="size-5 text-danger" aria-label="Fail" />}
                </div>
                <div className="mt-2 flex flex-wrap items-center gap-2">
                  {c.kind === "MEASURE" ? (
                    <Input inputMode="decimal" value={r.value} onChange={(e) => setResult(n, { value: e.target.value })} placeholder={`Value${c.unit ? ` (${c.unit})` : ""}`} className="w-full sm:w-40" aria-label={`${c.label} value`} />
                  ) : (
                    <div className="flex w-full gap-2 sm:w-auto">
                      <Button size="sm" className="flex-1 sm:flex-none" variant={r.pass === true ? "primary" : "secondary"} onClick={() => setResult(n, { pass: true })}>
                        Pass
                      </Button>
                      <Button size="sm" className="flex-1 sm:flex-none" variant={r.pass === false ? "danger" : "secondary"} onClick={() => setResult(n, { pass: false })}>
                        Fail
                      </Button>
                    </div>
                  )}
                  <Input value={r.note} onChange={(e) => setResult(n, { note: e.target.value })} placeholder="Note (optional)" className="min-w-0 flex-1" aria-label={`${c.label} note`} />
                </div>
                {field(`results.${n}`) && <p className="mt-1 text-xs text-danger">{field(`results.${n}`)}</p>}
              </li>
            );
          })}
        </ul>
        <fieldset>
          <legend className="mb-2 text-sm font-semibold">Defects found</legend>
          <ul className="space-y-2">
            {found.map((d, n) => (
              <li key={n} className="grid gap-2 sm:grid-cols-[1fr_6rem_auto]">
                <Select value={d.defectCodeId} onChange={(e) => setFound((l) => l.map((x, j) => (j === n ? { ...x, defectCodeId: e.target.value } : x)))} aria-label="Defect">
                  <option value="">Choose defect…</option>
                  {defects.data?.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.code} – {c.name} ({c.severity.toLowerCase()})
                    </option>
                  ))}
                </Select>
                <Input inputMode="decimal" value={d.qty} onChange={(e) => setFound((l) => l.map((x, j) => (j === n ? { ...x, qty: e.target.value } : x)))} placeholder="Qty" aria-label="Defect quantity" />
                <Button size="sm" variant="ghost" icon={<Trash2 className="size-4" />} onClick={() => setFound((l) => l.filter((_, j) => j !== n))} aria-label="Remove defect" />
                {(field(`defects.${n}.defectCodeId`) || field(`defects.${n}.qty`)) && <p className="text-xs text-danger sm:col-span-3">{field(`defects.${n}.defectCodeId`) ?? field(`defects.${n}.qty`)}</p>}
              </li>
            ))}
          </ul>
          <Button size="sm" className="mt-2" icon={<Plus className="size-4" />} onClick={() => setFound((l) => [...l, { defectCodeId: "", qty: "1", remark: "" }])}>
            Add defect
          </Button>
        </fieldset>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label={`Reject quantity (${i.uom})`} error={field("rejectQty")} hint="Any reject fails the lot.">{(p) => <Input {...p} inputMode="decimal" value={rejectQty} onChange={(e) => setRejectQty(e.target.value)} placeholder="0" />}</Field>
          <Field label="Remarks" error={field("remarks")}>{(p) => <Input {...p} value={remarks} onChange={(e) => setRemarks(e.target.value)} />}</Field>
        </div>
        <Button type="submit" variant="primary" icon={<ClipboardCheck className="size-4" />} loading={save.isPending} className="w-full sm:w-auto">
          Check Out
        </Button>
      </form>
    </Card>
  );
}

function DispositionDialog({ i, onClose }: { i: InspectionDetail; onClose: () => void }) {
  const toast = useToast();
  const { field, handle } = useFormError();
  const [disposition, setDisposition] = useState<Disposition | "">("");
  const [note, setNote] = useState("");
  const save = useQcMutation(() => api.post(`/qc/inspections/${i.id}/disposition`, { disposition, note }));
  const submit = (e: FormEvent) => {
    e.preventDefault();
    save.mutate(undefined, { onSuccess: () => (toast.success(`${i.inspNo}: ${DISPOSITION_LABEL[disposition as Disposition].toLowerCase()}.`), onClose()), onError: handle });
  };
  return (
    <Dialog
      open
      onClose={onClose}
      title={`Disposition for ${i.inspNo}`}
      description="The lot failed inspection. Decide what happens to it; the reason is kept in the audit trail."
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" type="submit" form="dispo" loading={save.isPending} disabled={!disposition}>
            Confirm
          </Button>
        </>
      }
    >
      <form id="dispo" onSubmit={submit} className="space-y-4" noValidate>
        <div className="grid gap-2">
          {DISPOSITIONS[i.type].map((d) => (
            <label key={d} className={`flex cursor-pointer items-center gap-3 rounded-lg border p-3 text-sm ${disposition === d ? "border-primary bg-primary-soft" : "border-line"}`}>
              <input type="radio" name="disposition" checked={disposition === d} onChange={() => setDisposition(d)} />
              {DISPOSITION_LABEL[d]}
            </label>
          ))}
        </div>
        {field("disposition") && <p className="text-sm text-danger">{field("disposition")}</p>}
        <Field label="Reason" required error={field("note")}>{(p) => <Textarea {...p} rows={3} value={note} onChange={(e) => setNote(e.target.value)} />}</Field>
      </form>
    </Dialog>
  );
}
