import { Plus } from "lucide-react";
import { useState, type FormEvent } from "react";
import { useSearchParams } from "react-router";
import { DataTable, PageHeader, SearchInput, type Column } from "@/components/common";
import { StatusBadge } from "@/components/status";
import { Badge, Button, Dialog, Field, Input, Select, Textarea } from "@/components/ui";
import { api } from "@/lib/api";
import { useFormError } from "@/lib/use-form-error";
import { useAuth } from "@/stores/auth";
import { useToast } from "@/stores/toast";
import {
  DIE_CONDITION_LABEL,
  DIE_CUT_LABEL,
  DIE_SHAPE_LABEL,
  DIE_TYPE_LABEL,
  TOOTH_PITCH_MM,
  useDieCuts,
  useMasterMutation,
  type DieCondition,
  type DieCut,
  type DieCutType,
  type DieShape,
  type DieType,
} from "./api";

const conditionTone = (c: DieCondition) => (c === "GOOD" ? "success" : c === "WORN" ? "warning" : "danger");

export function DieCutPage() {
  const { can } = useAuth();
  const manage = can("planning.master.manage");
  const [params, setParams] = useSearchParams();
  const get = (k: string) => params.get(k) ?? "";
  const set = (patch: Record<string, string>) =>
    setParams((prev) => {
      const next = new URLSearchParams(prev);
      for (const [k, v] of Object.entries(patch)) v ? next.set(k, v) : next.delete(k);
      if (!("page" in patch)) next.delete("page");
      return next;
    });
  const page = Number(get("page") || 1);
  const list = useDieCuts({ page, q: get("q"), status: get("status"), dieType: get("dieType"), width: get("width"), height: get("height") });
  const [editing, setEditing] = useState<DieCut | "new" | null>(null);
  const [retiring, setRetiring] = useState<DieCut | null>(null);
  const columns: Column<DieCut>[] = [
    {
      key: "code",
      header: "Die no.",
      cell: (d) => (
        <div className="min-w-0">
          <p className="font-medium whitespace-nowrap">{d.code}</p>
          <p className="line-clamp-1 max-w-xs text-xs text-muted">{d.description}</p>
        </div>
      ),
    },
    {
      key: "size",
      header: "Label size (W × H)",
      cell: (d) => (
        <div className="whitespace-nowrap">
          <p className="tabular-nums">
            {d.labelWidthMm} × {d.labelHeightMm} mm
          </p>
          <p className="text-xs text-muted">
            {DIE_SHAPE_LABEL[d.shape]}
            {d.cornerRadiusMm ? ` · R${d.cornerRadiusMm}` : ""}
          </p>
        </div>
      ),
    },
    {
      key: "layout",
      header: "Across × around",
      cell: (d) => (
        <div className="whitespace-nowrap">
          <p className="tabular-nums">
            {d.across} × {d.around}
          </p>
          <p className="text-xs text-muted">{d.repeatMm ? `Repeat ${d.repeatMm} mm${d.gearTeeth ? ` · ${d.gearTeeth}T` : ""}` : "—"}</p>
        </div>
      ),
    },
    { key: "type", header: "Type", hideOnMobile: true, cell: (d) => <span className="text-sm">{DIE_TYPE_LABEL[d.dieType]}</span> },
    { key: "loc", header: "Location", hideOnMobile: true, cell: (d) => d.location ?? "—" },
    {
      key: "status",
      header: "Condition",
      cell: (d) => (d.status === "ACTIVE" ? <Badge tone={conditionTone(d.condition)}>{DIE_CONDITION_LABEL[d.condition]}</Badge> : <StatusBadge kind="record" value={d.status} />),
    },
    ...(manage
      ? [
          {
            key: "actions",
            header: "",
            className: "text-right",
            cell: (d: DieCut) => (
              <Button
                size="sm"
                variant="ghost"
                onClick={(e) => {
                  e.stopPropagation();
                  setRetiring(d);
                }}
              >
                {d.status === "ACTIVE" ? "Retire" : "Reactivate"}
              </Button>
            ),
          },
        ]
      : []),
  ];
  return (
    <>
      <PageHeader
        title="Die Cut Master"
        description="Cutting dies by die no.: label size and shape, layout across and around, rotary repeat, condition and where the die is kept."
        crumbs={[{ label: "Master Data" }, { label: "Die Cut Master" }]}
        actions={
          manage && (
            <Button variant="primary" icon={<Plus className="size-4" />} onClick={() => setEditing("new")}>
              New die
            </Button>
          )
        }
      />
      <DataTable
        columns={columns}
        rows={list.data?.data}
        rowKey={(d) => d.id}
        loading={list.isPending}
        error={list.error}
        onRetry={() => void list.refetch()}
        page={page}
        pageCount={list.data?.meta.pageCount}
        total={list.data?.meta.total}
        onPage={(p) => set({ page: String(p) })}
        onRowClick={manage ? setEditing : undefined}
        toolbar={
          <>
            <SearchInput value={get("q")} onChange={(v) => set({ q: v })} placeholder="Die no., description, location" />
            <div className="flex items-center gap-1">
              <Input value={get("width")} onChange={(e) => set({ width: e.target.value })} inputMode="decimal" placeholder="Width mm" className="w-auto flex-1 sm:w-28" aria-label="Label width (mm)" />
              <span className="text-sm text-muted">×</span>
              <Input value={get("height")} onChange={(e) => set({ height: e.target.value })} inputMode="decimal" placeholder="Height mm" className="w-auto flex-1 sm:w-28" aria-label="Label height (mm)" />
            </div>
            <Select value={get("dieType")} onChange={(e) => set({ dieType: e.target.value })} className="sm:w-44" aria-label="Die type">
              <option value="">All die types</option>
              {Object.entries(DIE_TYPE_LABEL).map(([k, l]) => (
                <option key={k} value={k}>
                  {l}
                </option>
              ))}
            </Select>
            <Select value={get("status")} onChange={(e) => set({ status: e.target.value })} className="sm:w-36" aria-label="Status">
              <option value="">In use and retired</option>
              <option value="ACTIVE">In use</option>
              <option value="INACTIVE">Retired</option>
            </Select>
          </>
        }
        empty={<p className="px-4 py-12 text-center text-sm text-muted">{get("q") || get("width") || get("height") ? "No dies match. Size search allows ± 0.5 mm." : "No dies yet."}</p>}
      />
      {editing && <DieDialog die={editing === "new" ? null : editing} onClose={() => setEditing(null)} />}
      {retiring && <RetireDialog die={retiring} onClose={() => setRetiring(null)} />}
    </>
  );
}

const FIELDS = ["code", "description", "dieType", "cutType", "shape", "labelWidthMm", "labelHeightMm", "cornerRadiusMm", "across", "around", "gapAcrossMm", "gapAroundMm", "gearTeeth", "repeatMm", "condition", "location", "supplierName", "remarks"] as const;
type DieForm = Record<(typeof FIELDS)[number], string>;

function DieDialog({ die, onClose }: { die: DieCut | null; onClose: () => void }) {
  const toast = useToast();
  const { field, handle } = useFormError();
  const [form, setForm] = useState<DieForm>(() => {
    const f = Object.fromEntries(FIELDS.map((k) => [k, die?.[k] == null ? "" : String(die[k])])) as DieForm;
    if (!die) Object.assign(f, { dieType: "ROTARY_SOLID", cutType: "KISS_CUT", shape: "RECTANGLE", around: "1", condition: "GOOD" });
    return f;
  });
  const set = (k: keyof DieForm) => (e: { target: { value: string } }) => setForm((f) => ({ ...f, [k]: e.target.value }));
  const rotary = form.dieType !== "FLATBED";
  const teethRepeat = form.gearTeeth && Number(form.gearTeeth) > 0 ? (Number(form.gearTeeth) * TOOTH_PITCH_MM).toFixed(3).replace(/\.?0+$/, "") : null;
  const fits = form.repeatMm || teethRepeat ? Number(form.labelHeightMm) * Number(form.around || 1) <= Number(form.repeatMm || teethRepeat) : null;
  const save = useMasterMutation(() => {
    const payload: Record<string, unknown> = Object.fromEntries(FIELDS.filter((k) => k !== "code").map((k) => [k, form[k]]));
    if (form.shape !== "ROUNDED_RECTANGLE") payload.cornerRadiusMm = null;
    if (!rotary) Object.assign(payload, { gearTeeth: null, repeatMm: null });
    else if (!form.repeatMm) payload.repeatMm = die ? undefined : null; // server derives it from the teeth
    return die ? api.patch(`/die-cuts/${die.id}`, payload) : api.post("/die-cuts", { ...payload, code: form.code });
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    save.mutate(undefined, { onSuccess: () => (toast.success(die ? `${die.code} saved.` : `Die ${form.code.toUpperCase()} added.`), onClose()), onError: handle });
  };
  const num = (k: keyof DieForm, label: string, hint?: string) => (
    <Field label={label} error={field(k)} hint={hint} required={k === "labelWidthMm" || k === "labelHeightMm" || k === "across"}>
      {(p) => <Input {...p} value={form[k]} onChange={set(k)} inputMode="decimal" />}
    </Field>
  );
  return (
    <Dialog
      open
      onClose={onClose}
      size="lg"
      title={die ? `Edit die ${die.code}` : "New die"}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" type="submit" form="die-form" loading={save.isPending}>
            {die ? "Save" : "Add die"}
          </Button>
        </>
      }
    >
      <form id="die-form" onSubmit={submit} className="space-y-5" noValidate>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Die no." required error={field("code")} hint={die ? "Die numbers can't be changed." : undefined}>
            {(p) => <Input {...p} value={form.code} disabled={!!die} onChange={set("code")} autoFocus={!die} />}
          </Field>
          <Field label="Die type" required error={field("dieType")}>
            {(p) => (
              <Select {...p} value={form.dieType} onChange={(e) => setForm((f) => ({ ...f, dieType: e.target.value as DieType }))}>
                {Object.entries(DIE_TYPE_LABEL).map(([k, l]) => (
                  <option key={k} value={k}>
                    {l}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <Field label="Description" required className="sm:col-span-2" error={field("description")}>
            {(p) => <Input {...p} value={form.description} onChange={set("description")} placeholder="e.g. 80 × 50 rounded, 3 across" />}
          </Field>
          <Field label="Shape" error={field("shape")}>
            {(p) => (
              <Select {...p} value={form.shape} onChange={(e) => setForm((f) => ({ ...f, shape: e.target.value as DieShape }))}>
                {Object.entries(DIE_SHAPE_LABEL).map(([k, l]) => (
                  <option key={k} value={k}>
                    {l}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <Field label="Cut" error={field("cutType")}>
            {(p) => (
              <Select {...p} value={form.cutType} onChange={(e) => setForm((f) => ({ ...f, cutType: e.target.value as DieCutType }))}>
                {Object.entries(DIE_CUT_LABEL).map(([k, l]) => (
                  <option key={k} value={k}>
                    {l}
                  </option>
                ))}
              </Select>
            )}
          </Field>
        </div>

        <fieldset>
          <legend className="mb-3 text-sm font-semibold">Label and layout</legend>
          <div className="grid gap-4 sm:grid-cols-3">
            {num("labelWidthMm", "Label width (mm)", "Across the web")}
            {num("labelHeightMm", "Label height (mm)", "Around (feed direction)")}
            {form.shape === "ROUNDED_RECTANGLE" ? num("cornerRadiusMm", "Corner radius (mm)") : <div className="hidden sm:block" />}
            {num("across", "Labels across")}
            {num("around", "Labels around")}
            <div className="hidden sm:block" />
            {num("gapAcrossMm", "Gap across (mm)")}
            {num("gapAroundMm", "Gap around (mm)")}
          </div>
        </fieldset>

        {rotary && (
          <fieldset>
            <legend className="mb-3 text-sm font-semibold">Cylinder</legend>
            <div className="grid gap-4 sm:grid-cols-3">
              {num("gearTeeth", "Gear teeth", '1/8" circular pitch')}
              {num("repeatMm", "Repeat (mm)", teethRepeat ? `From the teeth: ${teethRepeat} mm` : "Or enter the gear teeth")}
              {fits !== null && Number(form.labelHeightMm) > 0 && (
                <p className={`self-center text-sm ${fits ? "text-success" : "text-danger"}`}>
                  {fits ? "Labels around fit the repeat." : "Labels around don't fit the repeat."}
                </p>
              )}
            </div>
          </fieldset>
        )}

        <div className="grid gap-4 sm:grid-cols-3">
          <Field label="Condition" error={field("condition")}>
            {(p) => (
              <Select {...p} value={form.condition} onChange={set("condition")}>
                {Object.entries(DIE_CONDITION_LABEL).map(([k, l]) => (
                  <option key={k} value={k}>
                    {l}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <Field label="Location" error={field("location")}>{(p) => <Input {...p} value={form.location} onChange={set("location")} placeholder="e.g. Rack B-3" />}</Field>
          <Field label="Supplier" error={field("supplierName")}>{(p) => <Input {...p} value={form.supplierName} onChange={set("supplierName")} />}</Field>
          <Field label="Remarks" error={field("remarks")} className="sm:col-span-3">{(p) => <Textarea {...p} rows={2} value={form.remarks} onChange={set("remarks")} />}</Field>
        </div>
      </form>
    </Dialog>
  );
}

function RetireDialog({ die, onClose }: { die: DieCut; onClose: () => void }) {
  const toast = useToast();
  const { field, handle } = useFormError();
  const activate = die.status !== "ACTIVE";
  const [reason, setReason] = useState("");
  const save = useMasterMutation(() => api.put(`/die-cuts/${die.id}/status`, { status: activate ? "ACTIVE" : "INACTIVE", reason }));
  const submit = (e: FormEvent) => {
    e.preventDefault();
    save.mutate(undefined, { onSuccess: () => (toast.success(`${die.code} ${activate ? "reactivated" : "retired"}.`), onClose()), onError: handle });
  };
  return (
    <Dialog
      open
      onClose={onClose}
      title={`${activate ? "Reactivate" : "Retire"} die ${die.code}?`}
      description={activate ? "It can be used again." : "Retired dies stay on record but are no longer offered."}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant={activate ? "primary" : "danger"} type="submit" form="retire-form" loading={save.isPending}>
            {activate ? "Reactivate" : "Retire"}
          </Button>
        </>
      }
    >
      <form id="retire-form" onSubmit={submit} noValidate>
        <Field label={activate ? "Note" : "Reason"} required={!activate} error={field("reason")}>
          {(p) => <Textarea {...p} rows={2} value={reason} onChange={(e) => setReason(e.target.value)} placeholder={activate ? undefined : "e.g. Blade damaged, replaced by D-1002"} />}
        </Field>
      </form>
    </Dialog>
  );
}
