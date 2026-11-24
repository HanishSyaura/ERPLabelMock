import { Plus, Printer } from "lucide-react";
import { useState, type FormEvent } from "react";
import { Link, useSearchParams } from "react-router";
import { Barcode } from "@/components/barcode";
import { ConfirmDialog, DataTable, PageHeader, SearchInput, Tabs, type Column } from "@/components/common";
import { StatusBadge } from "@/components/status";
import { Badge, Button, Checkbox, Dialog, Field, Input, Select, Textarea } from "@/components/ui";
import { api } from "@/lib/api";
import { formatDateTime } from "@/lib/utils";
import { useFormError } from "@/lib/use-form-error";
import { useAuth } from "@/stores/auth";
import { useToast } from "@/stores/toast";
import { LABEL_FIELDS, labelFieldName, useLabels, useLabelTemplates, useQcMutation, useReadyLots, type LabelData, type LabelField, type LabelTemplate, type ReadyLot, type ShippingLabelRow } from "./api";

type Tab = "ready" | "labels" | "templates";

/**
 * Shipping Label: label released OQC lots carton by carton, print through the
 * browser (PDF / any printer), reprint with a reason, void, and maintain the
 * label templates. Printer language (ZPL / TSPL) is still an open question.
 */
export function ShippingLabelPage() {
  const { can } = useAuth();
  const [params, setParams] = useSearchParams();
  const lot = params.get("lot");
  const tabs: { id: Tab; label: string }[] = [
    ...(can("qc.label.generate") ? [{ id: "ready" as const, label: "Ready to label" }] : []),
    { id: "labels", label: "Labels" },
    { id: "templates", label: "Label templates" },
  ];
  const raw = params.get("tab") as Tab | null;
  const tab: Tab = raw && tabs.some((t) => t.id === raw) ? raw : tabs[0]!.id;
  return (
    <>
      <PageHeader
        title="Shipping Label"
        description="Carton labels for finished labels that passed OQC. Each label freezes what it prints; reprints need a reason and are audited."
        crumbs={[{ label: "QC" }, { label: "Shipping Label" }]}
      />
      <Tabs tabs={tabs} value={tab} onChange={(id) => setParams(id === tabs[0]!.id ? {} : { tab: id })} />
      {tab === "ready" ? <ReadyTab preselect={lot} /> : tab === "labels" ? <LabelsTab /> : <TemplatesTab />}
    </>
  );
}

// ---------------------------------------------------------------------------
// Ready to label
// ---------------------------------------------------------------------------

function ReadyTab({ preselect }: { preselect: string | null }) {
  const ready = useReadyLots();
  const [generating, setGenerating] = useState<ReadyLot | null>(null);
  const [printing, setPrinting] = useState<string[] | null>(null);
  const pre = preselect ? ready.data?.find((l) => l.id === preselect) : undefined;
  const columns: Column<ReadyLot>[] = [
    {
      key: "lot",
      header: "OQC lot",
      cell: (l) => (
        <div>
          <p className="font-medium">{l.inspNo}</p>
          <p className="text-xs text-muted">
            {l.woNo} · {l.fatherCode}
          </p>
        </div>
      ),
    },
    { key: "status", header: "QC", cell: (l) => <StatusBadge kind="qc" value={l.status} /> },
    { key: "rel", header: "Released", className: "text-right", cell: (l) => <span className="tabular-nums whitespace-nowrap">{l.releasedQty} {l.uom}</span> },
    { key: "done", header: "Labelled", className: "text-right", hideOnMobile: true, cell: (l) => <span className="tabular-nums">{l.labelledQty}</span> },
    { key: "left", header: "To label", className: "text-right", cell: (l) => <span className="font-medium tabular-nums whitespace-nowrap">{l.remainingQty} {l.uom}</span> },
    {
      key: "actions",
      header: "",
      className: "text-right",
      cell: (l) => (
        <Button
          size="sm"
          variant="primary"
          onClick={(e) => {
            e.stopPropagation();
            setGenerating(l);
          }}
        >
          Make labels
        </Button>
      ),
    },
  ];
  const target = generating ?? pre ?? null;
  return (
    <>
      <DataTable
        columns={columns}
        rows={ready.data}
        rowKey={(l) => l.id}
        loading={ready.isPending}
        error={ready.error}
        onRetry={() => void ready.refetch()}
        onRowClick={setGenerating}
        empty={<p className="px-4 py-12 text-center text-sm text-muted">No released OQC lots waiting for labels. Lots appear here once they pass OQC or a supervisor accepts them.</p>}
      />
      {target && !printing && (
        <GenerateDialog
          lot={target}
          onClose={() => {
            setGenerating(null);
            if (preselect) window.history.replaceState(null, "", "/qc/shipping-label");
          }}
          onDone={(ids) => setPrinting(ids)}
        />
      )}
      {printing && (
        <PrintDialog
          ids={printing}
          onClose={() => {
            setPrinting(null);
            setGenerating(null);
          }}
        />
      )}
    </>
  );
}

function GenerateDialog({ lot, onClose, onDone }: { lot: ReadyLot; onClose: () => void; onDone: (ids: string[]) => void }) {
  const toast = useToast();
  const templates = useLabelTemplates("ACTIVE");
  const { field, handle } = useFormError();
  const [form, setForm] = useState({ templateId: "", totalQty: lot.remainingQty, qtyPerCarton: "" });
  const cartons = Number(form.qtyPerCarton) > 0 && Number(form.totalQty) > 0 ? Math.ceil(Number(form.totalQty) / Number(form.qtyPerCarton)) : null;
  const save = useQcMutation(() => api.post<{ ids: string[]; cartons: number }>("/qc/labels", { inspectionId: lot.id, ...form, templateId: form.templateId || templates.data?.[0]?.id }));
  const submit = (e: FormEvent) => {
    e.preventDefault();
    save.mutate(undefined, { onSuccess: (r) => (toast.success(`${r.cartons} label${r.cartons === 1 ? "" : "s"} made for ${lot.inspNo}.`), onDone(r.ids)), onError: handle });
  };
  const last = cartons && Number(form.totalQty) - Number(form.qtyPerCarton) * (cartons - 1);
  return (
    <Dialog
      open
      onClose={onClose}
      title={`Labels for ${lot.inspNo}`}
      description={`${lot.remainingQty} ${lot.uom} released and not yet labelled (${lot.woNo}).`}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" type="submit" form="gen-labels" loading={save.isPending}>
            Make labels
          </Button>
        </>
      }
    >
      <form id="gen-labels" onSubmit={submit} className="grid gap-4 sm:grid-cols-2" noValidate>
        <Field label="Label template" required error={field("templateId")} className="sm:col-span-2" hint={templates.data && !templates.data.length ? "Add a label template first (Label templates tab)." : undefined}>
          {(p) => (
            <Select {...p} value={form.templateId || templates.data?.[0]?.id || ""} onChange={(e) => setForm((f) => ({ ...f, templateId: e.target.value }))}>
              {templates.data?.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.code} – {t.name} ({t.widthMm} × {t.heightMm} mm)
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field label={`Total to label (${lot.uom})`} required error={field("totalQty")}>{(p) => <Input {...p} inputMode="decimal" value={form.totalQty} onChange={(e) => setForm((f) => ({ ...f, totalQty: e.target.value }))} />}</Field>
        <Field label={`Qty per carton (${lot.uom})`} required error={field("qtyPerCarton")}>{(p) => <Input {...p} inputMode="decimal" value={form.qtyPerCarton} onChange={(e) => setForm((f) => ({ ...f, qtyPerCarton: e.target.value }))} autoFocus />}</Field>
        {cartons && (
          <p className="text-sm text-muted sm:col-span-2">
            {cartons} carton label{cartons === 1 ? "" : "s"}
            {last && last !== Number(form.qtyPerCarton) ? `; the last carton holds ${last} ${lot.uom}` : ""}.
          </p>
        )}
      </form>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Labels: list, print, reprint, void
// ---------------------------------------------------------------------------

function LabelsTab() {
  const { can } = useAuth();
  const [params, setParams] = useSearchParams();
  const page = Number(params.get("page") ?? 1);
  const q = params.get("q") ?? "";
  const list = useLabels({ page, q });
  const [selected, setSelected] = useState<string[]>([]);
  const [printing, setPrinting] = useState<string[] | null>(null);
  const [voiding, setVoiding] = useState<ShippingLabelRow | null>(null);
  const set = (patch: Record<string, string>) =>
    setParams((prev) => {
      const next = new URLSearchParams(prev);
      for (const [k, v] of Object.entries(patch)) v ? next.set(k, v) : next.delete(k);
      if (!("page" in patch)) next.delete("page");
      return next;
    });
  const toggle = (id: string) => setSelected((s) => (s.includes(id) ? s.filter((x) => x !== id) : [...s, id]));
  const columns: Column<ShippingLabelRow>[] = [
    {
      key: "sel",
      header: "",
      mobile: "aside",
      cell: (l) =>
        l.status === "ACTIVE" ? (
          <input type="checkbox" className="size-5" checked={selected.includes(l.id)} onChange={() => toggle(l.id)} onClick={(e) => e.stopPropagation()} aria-label={`Select ${l.labelNo}`} />
        ) : null,
    },
    { key: "no", header: "Label", mobile: "title", cell: (l) => <span className="font-medium whitespace-nowrap">{l.labelNo}</span> },
    {
      key: "lot",
      header: "Lot / carton",
      cell: (l) => (
        <span className="text-sm whitespace-nowrap">
          <Link to={`/qc/oqc-check-in-out/${l.inspection?.id}`} className="text-primary hover:underline" onClick={(e) => e.stopPropagation()}>
            {l.inspection?.inspNo}
          </Link>{" "}
          · {l.cartonNo} / {l.cartonCount}
        </span>
      ),
    },
    { key: "qty", header: "Qty", className: "text-right", cell: (l) => <span className="tabular-nums whitespace-nowrap">{l.qty} {l.uom}</span> },
    {
      key: "printed",
      header: "Printed",
      hideOnMobile: true,
      cell: (l) => (l.printCount ? <span className="text-xs">×{l.printCount} · {formatDateTime(l.lastPrintedAt)}</span> : <span className="text-xs text-muted">Not yet</span>),
    },
    { key: "status", header: "Status", cell: (l) => (l.status === "VOID" ? <Badge tone="neutral" >Void</Badge> : <Badge tone={l.printCount ? "success" : "warning"}>{l.printCount ? "Printed" : "To print"}</Badge>) },
    ...(can("qc.label.generate")
      ? [
          {
            key: "actions",
            header: "",
            className: "text-right",
            cell: (l: ShippingLabelRow) =>
              l.status === "ACTIVE" ? (
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={(e) => {
                    e.stopPropagation();
                    setVoiding(l);
                  }}
                >
                  Void
                </Button>
              ) : null,
          },
        ]
      : []),
  ];
  return (
    <>
      <DataTable
        columns={columns}
        rows={list.data?.data}
        rowKey={(l) => l.id}
        loading={list.isPending}
        error={list.error}
        onRetry={() => void list.refetch()}
        page={page}
        pageCount={list.data?.meta.pageCount}
        total={list.data?.meta.total}
        onPage={(p) => set({ page: String(p) })}
        onRowClick={(l) => l.status === "ACTIVE" && toggle(l.id)}
        toolbar={
          <>
            <SearchInput value={q} onChange={(v) => set({ q: v })} placeholder="Label no., OQC no., Job Order" />
            <div className="flex-1" />
            <Button variant="primary" icon={<Printer className="size-4" />} disabled={!selected.length} onClick={() => setPrinting(selected)}>
              Print {selected.length ? `(${selected.length})` : ""}
            </Button>
          </>
        }
        empty={<p className="px-4 py-12 text-center text-sm text-muted">{q ? "No labels match." : "No labels yet."}</p>}
      />
      {printing && (
        <PrintDialog
          ids={printing}
          onClose={() => {
            setPrinting(null);
            setSelected([]);
          }}
        />
      )}
      {voiding && <VoidDialog label={voiding} onClose={() => setVoiding(null)} />}
    </>
  );
}

/** One label at its template size, values as frozen when generated. */
function ShipLabel({ d }: { d: LabelData }) {
  return (
    <div className="ship-label flex flex-col justify-between overflow-hidden rounded border border-black bg-white p-2 text-black" style={{ width: `${d.widthMm}mm`, height: `${d.heightMm}mm` }}>
      <dl className="grid grid-cols-[auto_1fr] gap-x-2 text-[9pt] leading-tight">
        {d.fields.map((k: LabelField) => (
          <div key={k} className="contents">
            <dt className="font-semibold">{labelFieldName(k)}</dt>
            <dd className="truncate">{d[k] ?? "—"}</dd>
          </div>
        ))}
      </dl>
      <div className="flex justify-center">
        <Barcode value={d.barcodeValue} kind={d.barcode === "QR" ? "qrcode" : "code128"} scale={2} height={10} />
      </div>
    </div>
  );
}

function PrintDialog({ ids, onClose }: { ids: string[]; onClose: () => void }) {
  const { can } = useAuth();
  const toast = useToast();
  const labels = useLabels({ page: 1, ids: ids.join(","), pageSize: 500 });
  const [reason, setReason] = useState("");
  const { field, handle } = useFormError();
  const rows = (labels.data?.data ?? []).filter((l) => ids.includes(l.id));
  const reprint = rows.some((l) => l.printCount > 0);
  const mark = useQcMutation(() => api.post<{ printed: number; reprinted: number }>("/qc/labels/print", { ids, reason: reason || null }));
  const print = () =>
    mark.mutate(undefined, {
      onSuccess: () => {
        window.print();
        toast.success(`${ids.length} label${ids.length === 1 ? "" : "s"} sent to print.`);
      },
      onError: handle,
    });
  return (
    <Dialog
      open
      onClose={onClose}
      size="lg"
      title={`Print ${ids.length} label${ids.length === 1 ? "" : "s"}`}
      description="Prints through the browser: choose the label printer, or save as PDF."
      footer={
        <>
          <Button onClick={onClose}>Close</Button>
          <Button variant="primary" icon={<Printer className="size-4" />} onClick={print} loading={mark.isPending} disabled={reprint && (!can("qc.label.reprint") || !reason.trim())}>
            {reprint ? "Reprint" : "Print"}
          </Button>
        </>
      }
    >
      {reprint && (
        <div className="mb-4 space-y-2">
          <p className="rounded-md bg-warning-soft px-3 py-2 text-sm text-warning">Some of these labels were printed before. A reprint is recorded with its reason.</p>
          {can("qc.label.reprint") ? (
            <Field label="Reason for reprint" required error={field("reason")}>{(p) => <Textarea {...p} rows={2} value={reason} onChange={(e) => setReason(e.target.value)} />}</Field>
          ) : (
            <p className="text-sm text-danger">Reprinting needs the reprint permission (QC Supervisor).</p>
          )}
        </div>
      )}
      {rows.length < ids.length && <p className="mb-2 text-sm text-muted">Loading labels…</p>}
      <div className="print-labels flex flex-wrap gap-3">
        {rows.map((l) => l.data && <ShipLabel key={l.id} d={l.data} />)}
      </div>
    </Dialog>
  );
}

function VoidDialog({ label, onClose }: { label: ShippingLabelRow; onClose: () => void }) {
  const toast = useToast();
  const { field, handle } = useFormError();
  const [reason, setReason] = useState("");
  const save = useQcMutation(() => api.post(`/qc/labels/${label.id}/void`, { reason }));
  const submit = (e: FormEvent) => {
    e.preventDefault();
    save.mutate(undefined, { onSuccess: () => (toast.success(`${label.labelNo} voided; its quantity can be labelled again.`), onClose()), onError: handle });
  };
  return (
    <Dialog
      open
      onClose={onClose}
      title={`Void ${label.labelNo}?`}
      description="A void label can't be printed. Its quantity goes back to 'Ready to label'."
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="danger" type="submit" form="void-label" loading={save.isPending}>
            Void label
          </Button>
        </>
      }
    >
      <form id="void-label" onSubmit={submit} noValidate>
        <Field label="Reason" required error={field("reason")}>{(p) => <Textarea {...p} rows={2} value={reason} onChange={(e) => setReason(e.target.value)} />}</Field>
      </form>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Label templates
// ---------------------------------------------------------------------------

function TemplatesTab() {
  const { can } = useAuth();
  const manage = can("qc.label.template.manage");
  const list = useLabelTemplates();
  const [editing, setEditing] = useState<LabelTemplate | "new" | null>(null);
  const [toggling, setToggling] = useState<LabelTemplate | null>(null);
  const toast = useToast();
  const toggle = useQcMutation((t: LabelTemplate) => api.put(`/qc/label-templates/${t.id}/status`, { status: t.status === "ACTIVE" ? "INACTIVE" : "ACTIVE" }));
  const columns: Column<LabelTemplate>[] = [
    { key: "code", header: "Code", cell: (t) => <span className="font-medium">{t.code}</span> },
    { key: "name", header: "Template", cell: (t) => t.name },
    { key: "size", header: "Size", cell: (t) => <span className="whitespace-nowrap tabular-nums">{t.widthMm} × {t.heightMm} mm</span> },
    { key: "fields", header: "Fields", hideOnMobile: true, cell: (t) => <span className="line-clamp-2 max-w-sm text-xs">{t.fields.map(labelFieldName).join(", ")}</span> },
    { key: "bc", header: "Barcode", hideOnMobile: true, cell: (t) => `${t.barcode === "QR" ? "QR" : "Code 128"} · ${labelFieldName(t.barcodeField)}` },
    { key: "status", header: "Status", cell: (t) => <StatusBadge kind="record" value={t.status} /> },
    ...(manage
      ? [
          {
            key: "actions",
            header: "",
            className: "text-right",
            cell: (t: LabelTemplate) => (
              <Button
                size="sm"
                variant="ghost"
                onClick={(e) => {
                  e.stopPropagation();
                  setToggling(t);
                }}
              >
                {t.status === "ACTIVE" ? "Deactivate" : "Activate"}
              </Button>
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
        rowKey={(t) => t.id}
        loading={list.isPending}
        error={list.error}
        onRetry={() => void list.refetch()}
        onRowClick={manage ? setEditing : undefined}
        toolbar={
          manage && (
            <>
              <div className="flex-1" />
              <Button variant="primary" icon={<Plus className="size-4" />} onClick={() => setEditing("new")}>
                New label template
              </Button>
            </>
          )
        }
        empty={<p className="px-4 py-12 text-center text-sm text-muted">No label templates yet.</p>}
      />
      {editing && <LabelTemplateDialog template={editing === "new" ? null : editing} onClose={() => setEditing(null)} />}
      {toggling && (
        <ConfirmDialog
          open
          onClose={() => setToggling(null)}
          title={`${toggling.status === "ACTIVE" ? "Deactivate" : "Activate"} ${toggling.code}?`}
          message={toggling.status === "ACTIVE" ? "It can't be used for new labels. Labels already made keep their layout." : "It can be used for new labels again."}
          confirmLabel={toggling.status === "ACTIVE" ? "Deactivate" : "Activate"}
          tone={toggling.status === "ACTIVE" ? "danger" : "primary"}
          busy={toggle.isPending}
          onConfirm={() => toggle.mutate(toggling, { onSuccess: () => (toast.success(`${toggling.code} updated.`), setToggling(null)), onError: (e) => toast.error(e) })}
        />
      )}
    </>
  );
}

const SAMPLE: Record<LabelField, string> = {
  labelNo: "LBL-2026-0000001",
  customerName: "Fresh Valley Sdn Bhd",
  productCode: "FG-10482",
  productName: "Mango Juice 1L front label",
  customerPartNo: "FV-MJ1L-F",
  customerRef: "PO-4471",
  fatherCode: "BOM-000012",
  labelDescription: "Mango juice 1L front",
  pjoNo: "PJO-2026-00031",
  woNo: "JO-2026-00045",
  lotNo: "OQC-2026-00012",
  qty: "2000 PCS",
  cartonNo: "1 / 6",
  packedDate: "2026-11-23",
  inspector: "QC Inspector",
};

function LabelTemplateDialog({ template, onClose }: { template: LabelTemplate | null; onClose: () => void }) {
  const toast = useToast();
  const { field, handle } = useFormError();
  const [form, setForm] = useState({
    code: template?.code ?? "",
    name: template?.name ?? "",
    widthMm: String(template?.widthMm ?? 100),
    heightMm: String(template?.heightMm ?? 75),
    fields: template?.fields ?? (["customerName", "productCode", "customerRef", "woNo", "lotNo", "qty", "cartonNo", "packedDate"] as LabelField[]),
    barcode: template?.barcode ?? ("CODE128" as "CODE128" | "QR"),
    barcodeField: template?.barcodeField ?? ("labelNo" as LabelField),
  });
  const save = useQcMutation(() => {
    const { code, ...rest } = form;
    return template ? api.patch(`/qc/label-templates/${template.id}`, rest) : api.post("/qc/label-templates", { code, ...rest });
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    save.mutate(undefined, { onSuccess: () => (toast.success(template ? `${template.code} saved.` : `Template ${form.code.toUpperCase()} added.`), onClose()), onError: handle });
  };
  const flip = (k: LabelField) => setForm((f) => ({ ...f, fields: f.fields.includes(k) ? f.fields.filter((x) => x !== k) : LABEL_FIELDS.map(([x]) => x).filter((x) => x === k || f.fields.includes(x)) }));
  const preview: LabelData = { ...SAMPLE, fields: form.fields, barcode: form.barcode, barcodeValue: SAMPLE[form.barcodeField], widthMm: Number(form.widthMm) || 100, heightMm: Number(form.heightMm) || 75 };
  return (
    <Dialog
      open
      onClose={onClose}
      size="lg"
      title={template ? `Edit ${template.code}` : "New label template"}
      description={template ? "Labels already made keep the layout they were made with." : undefined}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" type="submit" form="lbl-tpl" loading={save.isPending}>
            Save
          </Button>
        </>
      }
    >
      <form id="lbl-tpl" onSubmit={submit} className="space-y-5" noValidate>
        <div className="grid gap-4 sm:grid-cols-4">
          <Field label="Code" required error={field("code")} hint={template ? "Can't be changed." : undefined}>
            {(p) => <Input {...p} value={form.code} disabled={!!template} onChange={(e) => setForm((f) => ({ ...f, code: e.target.value }))} autoFocus={!template} />}
          </Field>
          <Field label="Name" required error={field("name")} className="sm:col-span-3">{(p) => <Input {...p} value={form.name} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} />}</Field>
          <Field label="Width (mm)" required error={field("widthMm")}>{(p) => <Input {...p} inputMode="numeric" value={form.widthMm} onChange={(e) => setForm((f) => ({ ...f, widthMm: e.target.value }))} />}</Field>
          <Field label="Height (mm)" required error={field("heightMm")}>{(p) => <Input {...p} inputMode="numeric" value={form.heightMm} onChange={(e) => setForm((f) => ({ ...f, heightMm: e.target.value }))} />}</Field>
          <Field label="Barcode" error={field("barcode")}>
            {(p) => (
              <Select {...p} value={form.barcode} onChange={(e) => setForm((f) => ({ ...f, barcode: e.target.value as "CODE128" | "QR" }))}>
                <option value="CODE128">Code 128</option>
                <option value="QR">QR code</option>
              </Select>
            )}
          </Field>
          <Field label="Barcode holds" error={field("barcodeField")}>
            {(p) => (
              <Select {...p} value={form.barcodeField} onChange={(e) => setForm((f) => ({ ...f, barcodeField: e.target.value as LabelField }))}>
                {LABEL_FIELDS.map(([k, l]) => (
                  <option key={k} value={k}>
                    {l}
                  </option>
                ))}
              </Select>
            )}
          </Field>
        </div>
        <fieldset>
          <legend className="mb-2 text-sm font-semibold">Printed fields</legend>
          {field("fields") && <p className="mb-2 text-sm text-danger">{field("fields")}</p>}
          <div className="grid gap-2 sm:grid-cols-3">
            {LABEL_FIELDS.map(([k, l]) => (
              <Checkbox key={k} label={l} checked={form.fields.includes(k)} onChange={() => flip(k)} />
            ))}
          </div>
        </fieldset>
        <div>
          <p className="mb-2 text-sm font-semibold">Preview (sample data)</p>
          <div className="relative overflow-x-auto rounded-lg bg-surface-2 p-3">
            <ShipLabel d={preview} />
          </div>
        </div>
      </form>
    </Dialog>
  );
}
