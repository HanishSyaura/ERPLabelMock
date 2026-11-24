import { ArrowDown, ArrowUp, Plus, Trash2 } from "lucide-react";
import { useState, type FormEvent } from "react";
import { ConfirmDialog, DataTable, PageHeader, type Column } from "@/components/common";
import { StatusBadge } from "@/components/status";
import { Badge, Button, Checkbox, Dialog, Field, Input, Select, Textarea } from "@/components/ui";
import { api } from "@/lib/api";
import { useFormError } from "@/lib/use-form-error";
import { useAuth } from "@/stores/auth";
import { useToast } from "@/stores/toast";
import { usePartCategories } from "@/modules/master-data/api";
import { DEFECT_CATEGORY_LABEL, useDefects, useInspectionTemplates, useQcMutation, type DefectCategory, type DefectCode, type InspectionTemplate, type QcType, type Severity, type TemplateItem } from "./api";

function Toggle({ what, code, status, path, onClose }: { what: string; code: string; status: string; path: string; onClose: () => void }) {
  const toast = useToast();
  const activate = status !== "ACTIVE";
  const m = useQcMutation(() => api.put(path, { status: activate ? "ACTIVE" : "INACTIVE" }));
  return (
    <ConfirmDialog
      open
      onClose={onClose}
      title={`${activate ? "Activate" : "Deactivate"} ${what} ${code}?`}
      message={activate ? "It can be chosen again." : "It can't be chosen for new inspections. Past records keep it."}
      confirmLabel={activate ? "Activate" : "Deactivate"}
      tone={activate ? "primary" : "danger"}
      busy={m.isPending}
      onConfirm={() => m.mutate(undefined, { onSuccess: () => (toast.success(`${code} ${activate ? "activated" : "deactivated"}.`), onClose()), onError: (e) => toast.error(e) })}
    />
  );
}

const toggleCol = <T extends { status: string }>(can: boolean, onToggle: (r: T) => void): Column<T>[] =>
  can
    ? [
        {
          key: "actions",
          header: "",
          className: "text-right",
          cell: (r: T) => (
            <Button
              size="sm"
              variant="ghost"
              onClick={(e) => {
                e.stopPropagation();
                onToggle(r);
              }}
            >
              {r.status === "ACTIVE" ? "Deactivate" : "Activate"}
            </Button>
          ),
        },
      ]
    : [];

// ---------------------------------------------------------------------------
// Defect Master
// ---------------------------------------------------------------------------

export function DefectMasterPage() {
  const { can } = useAuth();
  const manage = can("qc.defect.manage");
  const list = useDefects();
  const [editing, setEditing] = useState<DefectCode | "new" | null>(null);
  const [toggling, setToggling] = useState<DefectCode | null>(null);
  const columns: Column<DefectCode>[] = [
    { key: "code", header: "Code", cell: (d) => <span className="font-medium">{d.code}</span> },
    { key: "name", header: "Defect", cell: (d) => d.name },
    { key: "cat", header: "Category", cell: (d) => DEFECT_CATEGORY_LABEL[d.category] },
    { key: "sev", header: "Severity", cell: (d) => <StatusBadge kind="severity" value={d.severity} /> },
    { key: "for", header: "Used in", hideOnMobile: true, cell: (d) => [d.appliesIqc && "IQC", d.appliesOqc && "OQC"].filter(Boolean).join(" · ") },
    { key: "found", header: "Findings", hideOnMobile: true, cell: (d) => <span className="tabular-nums">{d.findingCount}</span> },
    { key: "status", header: "Status", cell: (d) => <StatusBadge kind="record" value={d.status} /> },
    ...toggleCol<DefectCode>(manage, setToggling),
  ];
  return (
    <>
      <PageHeader
        title="Defect Master"
        description="Central defect codes for IQC and OQC. A critical defect always fails the inspection."
        crumbs={[{ label: "Master Data" }, { label: "Defect Master" }]}
        actions={
          manage && (
            <Button variant="primary" icon={<Plus className="size-4" />} onClick={() => setEditing("new")}>
              New defect
            </Button>
          )
        }
      />
      <DataTable
        columns={columns}
        rows={list.data}
        rowKey={(d) => d.id}
        loading={list.isPending}
        error={list.error}
        onRetry={() => void list.refetch()}
        onRowClick={manage ? setEditing : undefined}
        empty={<p className="px-4 py-12 text-center text-sm text-muted">No defect codes yet.</p>}
      />
      {editing && <DefectDialog defect={editing === "new" ? null : editing} onClose={() => setEditing(null)} />}
      {toggling && <Toggle what="defect" code={toggling.code} status={toggling.status} path={`/qc/defects/${toggling.id}/status`} onClose={() => setToggling(null)} />}
    </>
  );
}

function DefectDialog({ defect, onClose }: { defect: DefectCode | null; onClose: () => void }) {
  const toast = useToast();
  const { field, handle } = useFormError();
  const [form, setForm] = useState({
    code: defect?.code ?? "",
    name: defect?.name ?? "",
    category: defect?.category ?? ("" as DefectCategory | ""),
    severity: defect?.severity ?? ("MAJOR" as Severity),
    appliesIqc: defect?.appliesIqc ?? true,
    appliesOqc: defect?.appliesOqc ?? true,
    description: defect?.description ?? "",
  });
  const save = useQcMutation(() => {
    const { code, ...rest } = form;
    return defect ? api.patch(`/qc/defects/${defect.id}`, rest) : api.post("/qc/defects", { code, ...rest });
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    save.mutate(undefined, { onSuccess: () => (toast.success(defect ? `${defect.code} saved.` : `Defect ${form.code.toUpperCase()} added.`), onClose()), onError: handle });
  };
  return (
    <Dialog
      open
      onClose={onClose}
      title={defect ? `Edit ${defect.code}` : "New defect"}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" type="submit" form="defect-form" loading={save.isPending}>
            Save
          </Button>
        </>
      }
    >
      <form id="defect-form" onSubmit={submit} className="grid gap-4 sm:grid-cols-2" noValidate>
        <Field label="Code" required error={field("code")} hint={defect ? "Codes can't be changed." : "e.g. REG-01"}>
          {(p) => <Input {...p} value={form.code} disabled={!!defect} onChange={(e) => setForm((f) => ({ ...f, code: e.target.value }))} autoFocus={!defect} />}
        </Field>
        <Field label="Defect" required error={field("name")}>{(p) => <Input {...p} value={form.name} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} placeholder="e.g. Colour out of tolerance" />}</Field>
        <Field label="Category" required error={field("category")}>
          {(p) => (
            <Select {...p} value={form.category} onChange={(e) => setForm((f) => ({ ...f, category: e.target.value as DefectCategory }))}>
              <option value="">Choose…</option>
              {Object.entries(DEFECT_CATEGORY_LABEL).map(([k, l]) => (
                <option key={k} value={k}>
                  {l}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field label="Severity" error={field("severity")} hint="Critical always fails the inspection.">
          {(p) => (
            <Select {...p} value={form.severity} onChange={(e) => setForm((f) => ({ ...f, severity: e.target.value as Severity }))}>
              <option value="MINOR">Minor</option>
              <option value="MAJOR">Major</option>
              <option value="CRITICAL">Critical</option>
            </Select>
          )}
        </Field>
        <div className="flex flex-wrap gap-6 sm:col-span-2">
          <Checkbox label="Used in IQC" checked={form.appliesIqc} onChange={(e) => setForm((f) => ({ ...f, appliesIqc: e.target.checked }))} />
          <Checkbox label="Used in OQC" checked={form.appliesOqc} onChange={(e) => setForm((f) => ({ ...f, appliesOqc: e.target.checked }))} />
        </div>
        {field("appliesIqc") && <p className="text-sm text-danger sm:col-span-2">{field("appliesIqc")}</p>}
        <Field label="Description" error={field("description")} className="sm:col-span-2">
          {(p) => <Textarea {...p} rows={2} value={form.description} onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))} />}
        </Field>
      </form>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Inspection Template
// ---------------------------------------------------------------------------

export function InspectionTemplatePage() {
  const { can } = useAuth();
  const manage = can("qc.template.manage");
  const list = useInspectionTemplates();
  const [editing, setEditing] = useState<InspectionTemplate | "new" | null>(null);
  const [toggling, setToggling] = useState<InspectionTemplate | null>(null);
  const columns: Column<InspectionTemplate>[] = [
    { key: "code", header: "Code", cell: (t) => <span className="font-medium">{t.code}</span> },
    { key: "name", header: "Template", cell: (t) => t.name },
    { key: "type", header: "Type", cell: (t) => <Badge tone={t.type === "IQC" ? "info" : "primary"}>{t.type}</Badge> },
    { key: "for", header: "Default for", hideOnMobile: true, cell: (t) => (t.type === "IQC" ? (t.partCategory?.name ?? "—") : "All OQC") },
    { key: "items", header: "Checks", cell: (t) => <span className="tabular-nums">{t.items.length}</span> },
    { key: "used", header: "Inspections", hideOnMobile: true, cell: (t) => <span className="tabular-nums">{t.inspectionCount}</span> },
    { key: "status", header: "Status", cell: (t) => <StatusBadge kind="record" value={t.status} /> },
    ...toggleCol<InspectionTemplate>(manage, setToggling),
  ];
  return (
    <>
      <PageHeader
        title="Inspection Template"
        description="The checks an IQC or OQC inspection records: pass / fail checks and measurements with limits. An IQC template linked to a part category is used for that category's lots."
        crumbs={[{ label: "Master Data" }, { label: "Inspection Template" }]}
        actions={
          manage && (
            <Button variant="primary" icon={<Plus className="size-4" />} onClick={() => setEditing("new")}>
              New template
            </Button>
          )
        }
      />
      <DataTable
        columns={columns}
        rows={list.data}
        rowKey={(t) => t.id}
        loading={list.isPending}
        error={list.error}
        onRetry={() => void list.refetch()}
        onRowClick={manage ? setEditing : undefined}
        empty={<p className="px-4 py-12 text-center text-sm text-muted">No inspection templates yet. Inspections without a template record defects and quantities only.</p>}
      />
      {editing && <TemplateDialog template={editing === "new" ? null : editing} onClose={() => setEditing(null)} />}
      {toggling && <Toggle what="template" code={toggling.code} status={toggling.status} path={`/qc/inspection-templates/${toggling.id}/status`} onClose={() => setToggling(null)} />}
    </>
  );
}

const blankItem = (): TemplateItem => ({ label: "", kind: "PASS_FAIL", target: null, min: null, max: null, unit: null, required: true });

function TemplateDialog({ template, onClose }: { template: InspectionTemplate | null; onClose: () => void }) {
  const toast = useToast();
  const categories = usePartCategories("ACTIVE");
  const { field, handle } = useFormError();
  const [form, setForm] = useState({ code: template?.code ?? "", name: template?.name ?? "", type: template?.type ?? ("IQC" as QcType), partCategoryId: template?.partCategoryId ?? "" });
  const [items, setItems] = useState<TemplateItem[]>(template?.items.length ? template.items : [blankItem()]);
  const setItem = (i: number, patch: Partial<TemplateItem>) => setItems((list) => list.map((it, j) => (j === i ? { ...it, ...patch } : it)));
  const move = (i: number, d: -1 | 1) => setItems((list) => {
    const next = [...list];
    const [x] = next.splice(i, 1);
    next.splice(i + d, 0, x!);
    return next;
  });
  const save = useQcMutation(() => {
    const payload = { name: form.name, partCategoryId: form.type === "IQC" && form.partCategoryId ? form.partCategoryId : null, items };
    return template ? api.patch(`/qc/inspection-templates/${template.id}`, payload) : api.post("/qc/inspection-templates", { ...payload, code: form.code, type: form.type });
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    save.mutate(undefined, { onSuccess: () => (toast.success(template ? `${template.code} saved.` : `Template ${form.code.toUpperCase()} added.`), onClose()), onError: handle });
  };
  const num = (v: string) => (v.trim() === "" ? null : Number(v));
  return (
    <Dialog
      open
      onClose={onClose}
      size="lg"
      title={template ? `Edit ${template.code}` : "New inspection template"}
      description={template ? "Inspections already checked in keep the checks they started with." : undefined}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" type="submit" form="tpl-form" loading={save.isPending}>
            Save
          </Button>
        </>
      }
    >
      <form id="tpl-form" onSubmit={submit} className="space-y-5" noValidate>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Code" required error={field("code")} hint={template ? "Codes can't be changed." : undefined}>
            {(p) => <Input {...p} value={form.code} disabled={!!template} onChange={(e) => setForm((f) => ({ ...f, code: e.target.value }))} autoFocus={!template} />}
          </Field>
          <Field label="Name" required error={field("name")}>{(p) => <Input {...p} value={form.name} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} />}</Field>
          <Field label="Type" required error={field("type")} hint={template ? "The type can't be changed." : undefined}>
            {(p) => (
              <Select {...p} value={form.type} disabled={!!template} onChange={(e) => setForm((f) => ({ ...f, type: e.target.value as QcType }))}>
                <option value="IQC">IQC – incoming material</option>
                <option value="OQC">OQC – finished labels</option>
              </Select>
            )}
          </Field>
          {form.type === "IQC" && (
            <Field label="Default for part category" error={field("partCategoryId")}>
              {(p) => (
                <Select {...p} value={form.partCategoryId} onChange={(e) => setForm((f) => ({ ...f, partCategoryId: e.target.value }))}>
                  <option value="">None (choose at Check In)</option>
                  {categories.data?.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
          )}
        </div>
        <fieldset>
          <legend className="mb-2 text-sm font-semibold">Checks</legend>
          {field("items") && <p className="mb-2 text-sm text-danger">{field("items")}</p>}
          <ul className="space-y-3">
            {items.map((it, i) => (
              <li key={i} className="rounded-lg border border-line p-3">
                <div className="grid gap-3 sm:grid-cols-[1fr_10rem]">
                  <Field label={`Check ${i + 1}`} required error={field(`items.${i}.label`)}>
                    {(p) => <Input {...p} value={it.label} onChange={(e) => setItem(i, { label: e.target.value })} placeholder="e.g. Colour vs approved proof" />}
                  </Field>
                  <Field label="Kind">
                    {(p) => (
                      <Select {...p} value={it.kind} onChange={(e) => setItem(i, { kind: e.target.value as TemplateItem["kind"] })}>
                        <option value="PASS_FAIL">Pass / fail</option>
                        <option value="MEASURE">Measurement</option>
                      </Select>
                    )}
                  </Field>
                </div>
                <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-4">
                  <Field label="Target / standard">{(p) => <Input {...p} value={it.target ?? ""} onChange={(e) => setItem(i, { target: e.target.value || null })} />}</Field>
                  {it.kind === "MEASURE" && (
                    <>
                      <Field label="Min" error={field(`items.${i}.min`)}>{(p) => <Input {...p} inputMode="decimal" value={it.min ?? ""} onChange={(e) => setItem(i, { min: num(e.target.value) })} />}</Field>
                      <Field label="Max" error={field(`items.${i}.max`)}>{(p) => <Input {...p} inputMode="decimal" value={it.max ?? ""} onChange={(e) => setItem(i, { max: num(e.target.value) })} />}</Field>
                      <Field label="Unit">{(p) => <Input {...p} value={it.unit ?? ""} onChange={(e) => setItem(i, { unit: e.target.value || null })} placeholder="mm, µm, ΔE" />}</Field>
                    </>
                  )}
                </div>
                <div className="mt-2 flex flex-wrap items-center gap-2">
                  <Checkbox label="Required" checked={it.required} onChange={(e) => setItem(i, { required: e.target.checked })} />
                  <span className="flex-1" />
                  <Button size="sm" variant="ghost" icon={<ArrowUp className="size-4" />} disabled={i === 0} onClick={() => move(i, -1)} aria-label="Move up" />
                  <Button size="sm" variant="ghost" icon={<ArrowDown className="size-4" />} disabled={i === items.length - 1} onClick={() => move(i, 1)} aria-label="Move down" />
                  <Button size="sm" variant="ghost" icon={<Trash2 className="size-4" />} disabled={items.length === 1} onClick={() => setItems((l) => l.filter((_, j) => j !== i))} aria-label="Remove check" />
                </div>
              </li>
            ))}
          </ul>
          <Button size="sm" className="mt-3" icon={<Plus className="size-4" />} onClick={() => setItems((l) => [...l, blankItem()])}>
            Add check
          </Button>
        </fieldset>
      </form>
    </Dialog>
  );
}
