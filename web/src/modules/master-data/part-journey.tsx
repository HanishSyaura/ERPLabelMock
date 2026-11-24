import { useQueryClient } from "@tanstack/react-query";
import { CheckCircle2, Loader2 } from "lucide-react";
import { useMemo, useState } from "react";
import { Link, useNavigate } from "react-router";
import { PageHeader } from "@/components/common";
import { Journey, NextJourney, type JourneyStep } from "@/components/journey";
import { Button, Card, Checkbox, Field, Input, Select, Textarea } from "@/components/ui";
import { api, ApiError } from "@/lib/api";
import { useAuth } from "@/stores/auth";
import { useUoms } from "@/modules/bom/api";
import { PART_KIND_LABEL, PART_TYPE_LABEL, specFieldsFor, specMeta, usePartCategories, usePartGroups, type PartType, type SpecKey } from "./api";

/**
 * New part (raw material, packaging, consumable, semi-finished), start to end:
 *   1 Type      part type, category (decides the technical fields), group
 *   2 General   code, description, UOM, NMI No., source, specification, supplier
 *   3 Technical the fields of the category kind (width, thickness, adhesive…)
 *   4 Shipping  reorder, lead time, over-receive tolerance, Require IQC
 *   5 Review    create
 *   Done        next: Location Qty, use it in Son Codes, receive it at IQC
 * Finished goods go through product onboarding (artwork → Master Card) instead.
 */
type StepId = "type" | "general" | "technical" | "shipping" | "review" | "done";
const ORDER: StepId[] = ["type", "general", "technical", "shipping", "review", "done"];
const SOURCES = ["Purchased", "Manufactured", "Customer supplied", "Local", "Import"];
const NUMERIC: SpecKey[] = ["widthMm", "lengthM", "thicknessMicron", "gsm", "coreIdMm", "shelfLifeDays"];

export function NewPartJourney() {
  const { can } = useAuth();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const uoms = useUoms();
  const categories = usePartCategories("ACTIVE");
  const [step, setStep] = useState<StepId>("type");
  const [f, setF] = useState<Record<string, string>>({ partType: "RAW_MATERIAL", categoryId: "", groupId: "", code: "", description: "", uom: "", nmiNo: "", source: "Purchased", specification: "", supplierName: "", supplierPartNo: "", reorderLevel: "", reorderQty: "", maxQty: "", leadTimeDays: "", overReceivePct: "" });
  const [requireIqc, setRequireIqc] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [created, setCreated] = useState<{ id: string; code: string } | null>(null);
  const groups = usePartGroups(f.categoryId ? { categoryId: f.categoryId } : {});
  const kind = categories.data?.find((c) => c.id === f.categoryId)?.kind ?? null;
  const techKeys = useMemo(() => specFieldsFor(kind), [kind]);
  const set = (k: string) => (e: { target: { value: string } }) => setF((x) => ({ ...x, [k]: e.target.value }));

  const check = (s: StepId) => {
    const e: Record<string, string> = {};
    if (s === "general") {
      if (!(f.code ?? "").trim()) e.code = "Enter the part code";
      if (!(f.description ?? "").trim()) e.description = "Enter the description";
      if (!f.uom) e.uom = "Choose the unit";
    }
    return e;
  };
  const index = ORDER.indexOf(step);
  const go = (to: StepId) => {
    if (ORDER.indexOf(to) > index)
      for (const s of ORDER.slice(0, ORDER.indexOf(to))) {
        const e = check(s);
        if (Object.keys(e).length) return setErrors(e), setStep(s);
      }
    setErrors({});
    setStep(to);
  };
  const create = async () => {
    setBusy(true);
    try {
      const payload: Record<string, unknown> = { ...f, categoryId: f.categoryId || null, groupId: f.groupId || null, requireIqc };
      for (const k of Object.keys(payload)) if (payload[k] === "") delete payload[k];
      for (const k of techKeys) if (k === "stockForm" && !f[k]) delete payload[k];
      const r = await api.post<{ id: string; code: string }>("/materials", payload);
      await qc.invalidateQueries({ queryKey: ["materials"] });
      setCreated(r);
      setStep("done");
    } catch (e) {
      if (e instanceof ApiError && e.issues.length) {
        const map = Object.fromEntries(e.issues.map((i) => [i.path, i.message]));
        setErrors(map);
        const first = e.issues[0]!.path;
        setStep(techKeys.includes(first as SpecKey) ? "technical" : ["reorderLevel", "reorderQty", "maxQty", "leadTimeDays", "overReceivePct"].includes(first) ? "shipping" : ["categoryId", "groupId", "partType"].includes(first) ? "type" : "general");
      } else setErrors({ form: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(false);
    }
  };

  const steps: JourneyStep<StepId>[] = [
    { id: "type", label: "Type", hint: "Category & group" },
    { id: "general", label: "General", hint: "Code, unit, NMI" },
    { id: "technical", label: "Technical", hint: kind ? PART_KIND_LABEL[kind] : "Specification" },
    { id: "shipping", label: "Shipping", hint: "Reorder & IQC" },
    { id: "review", label: "Review", hint: "Create" },
    { id: "done", label: "Done", hint: "Next steps", state: step === "done" ? "done" : undefined },
  ].map((s) => (step === "done" && s.id !== "done" ? { ...s, state: "done" as const } : s)) as JourneyStep<StepId>[];

  return (
    <>
      <PageHeader title="New part" description="Add a material, packaging or consumable to Part Master, step by step." crumbs={[{ label: "Master Data" }, { label: "Part Master", to: "/master-data/part-master" }, { label: "New part" }]} />
      <Card className="mb-4">
        <Journey steps={steps} current={step} onSelect={step === "done" || busy ? undefined : go} locked={(s) => s === "done"} />
      </Card>
      {errors.form && <p className="mb-4 rounded-md bg-danger-soft p-3 text-sm text-danger">{errors.form}</p>}

      {step === "type" && (
        <Card title="1. What kind of part?">
          <div className="mb-4 grid gap-2 sm:grid-cols-4">
            {(["RAW_MATERIAL", "PACKAGING", "CONSUMABLE", "SEMI_FINISHED"] as PartType[]).map((t) => (
              <label key={t} className={`flex cursor-pointer items-center gap-2 rounded-lg border p-3 text-sm ${f.partType === t ? "border-primary bg-primary-soft" : "border-line"}`}>
                <input type="radio" checked={f.partType === t} onChange={() => setF((x) => ({ ...x, partType: t }))} />
                {PART_TYPE_LABEL[t]}
              </label>
            ))}
          </div>
          <p className="mb-3 text-xs text-muted">
            A finished label (finished good) is set up from its artwork in{" "}
            <Link to="/bom/new-product" className="text-primary hover:underline">
              New product
            </Link>
            .
          </p>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Part category" error={errors.categoryId} hint="Decides which technical fields the part has.">
              {(p) => (
                <Select {...p} value={f.categoryId} onChange={(e) => setF((x) => ({ ...x, categoryId: e.target.value, groupId: "" }))}>
                  <option value="">Not classified</option>
                  {categories.data?.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name} ({PART_KIND_LABEL[c.kind]})
                    </option>
                  ))}
                </Select>
              )}
            </Field>
            <Field label="Part group" error={errors.groupId}>
              {(p) => (
                <Select {...p} value={f.groupId} disabled={!f.categoryId} onChange={set("groupId")}>
                  <option value="">{f.categoryId ? "No group" : "Choose a category first"}</option>
                  {groups.data?.filter((g) => g.status === "ACTIVE").map((g) => (
                    <option key={g.id} value={g.id}>
                      {g.name}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
          </div>
        </Card>
      )}

      {step === "general" && (
        <Card title="2. General">
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Part code" required error={errors.code}>{(p) => <Input {...p} value={f.code} onChange={set("code")} autoFocus />}</Field>
            <Field label="Part UOM" required error={errors.uom}>
              {(p) => (
                <Select {...p} value={f.uom} onChange={set("uom")}>
                  <option value="">Choose…</option>
                  {uoms.data?.map((u) => (
                    <option key={u.code} value={u.code}>
                      {u.code} – {u.label}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
            <Field label="Part description" required className="sm:col-span-2" error={errors.description}>{(p) => <Input {...p} value={f.description} onChange={set("description")} />}</Field>
            <Field label="NMI No." error={errors.nmiNo}>{(p) => <Input {...p} value={f.nmiNo} onChange={set("nmiNo")} />}</Field>
            <Field label="Source">
              {(p) => (
                <>
                  <Input {...p} value={f.source} onChange={set("source")} list="part-src" />
                  <datalist id="part-src">{SOURCES.map((x) => <option key={x} value={x} />)}</datalist>
                </>
              )}
            </Field>
            <Field label="Supplier">{(p) => <Input {...p} value={f.supplierName} onChange={set("supplierName")} />}</Field>
            <Field label="Supplier part no.">{(p) => <Input {...p} value={f.supplierPartNo} onChange={set("supplierPartNo")} />}</Field>
            <Field label="Specification" className="sm:col-span-2">{(p) => <Textarea {...p} rows={2} value={f.specification} onChange={set("specification")} />}</Field>
          </div>
        </Card>
      )}

      {step === "technical" && (
        <Card title={`3. Technical data${kind ? ` – ${PART_KIND_LABEL[kind]}` : ""}`}>
          {!kind && <p className="mb-3 text-sm text-muted">No category chosen, so every technical field is shown. Fill in what applies.</p>}
          <div className="grid gap-4 sm:grid-cols-2">
            {techKeys.map((k) => {
              const meta = specMeta(k, kind);
              const label = meta.unit ? `${meta.label} (${meta.unit})` : meta.label;
              if (k === "stockForm")
                return (
                  <Field key={k} label={label} error={errors[k]}>
                    {(p) => (
                      <Select {...p} value={f[k] ?? ""} onChange={set(k)}>
                        <option value="">—</option>
                        <option value="ROLL">Roll</option>
                        <option value="SHEET">Sheet</option>
                        <option value="FANFOLD">Fanfold</option>
                        <option value="UNIT">Unit / piece</option>
                      </Select>
                    )}
                  </Field>
                );
              const listId = meta.suggestions ? `pj-${k}` : undefined;
              return (
                <Field key={k} label={label} error={errors[k]}>
                  {(p) => (
                    <>
                      <Input {...p} value={f[k] ?? ""} onChange={set(k)} inputMode={NUMERIC.includes(k) ? "decimal" : undefined} list={listId} />
                      {listId && <datalist id={listId}>{meta.suggestions!.map((s) => <option key={s} value={s} />)}</datalist>}
                    </>
                  )}
                </Field>
              );
            })}
          </div>
        </Card>
      )}

      {step === "shipping" && (
        <Card title="4. Shipping and IQC">
          <p className="mb-3 text-sm text-muted">Keyed in by hand until the WMS / purchasing integration.</p>
          <div className="grid gap-4 sm:grid-cols-3">
            {(
              [
                ["reorderLevel", "Reorder level"],
                ["reorderQty", "Reorder qty"],
                ["maxQty", "Max qty"],
                ["leadTimeDays", "Lead time (days)"],
                ["overReceivePct", "Over receive tolerance (%)"],
              ] as const
            ).map(([k, label]) => (
              <Field key={k} label={label} error={errors[k]}>{(p) => <Input {...p} inputMode="decimal" value={f[k]} onChange={set(k)} />}</Field>
            ))}
          </div>
          <div className="mt-4">
            <Checkbox label="Require IQC – only lots that passed IQC can be issued to production" checked={requireIqc} onChange={(e) => setRequireIqc(e.target.checked)} />
          </div>
        </Card>
      )}

      {step === "review" && (
        <Card title="5. Review">
          <dl className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-[10rem_1fr]">
            <dt className="text-muted">Part</dt>
            <dd>
              {(f.code ?? "").toUpperCase()} · {f.description} · {f.uom} · {PART_TYPE_LABEL[f.partType as PartType]}
            </dd>
            <dt className="text-muted">Category / group</dt>
            <dd>
              {categories.data?.find((c) => c.id === f.categoryId)?.name ?? "Not classified"}
              {f.groupId && ` / ${groups.data?.find((g) => g.id === f.groupId)?.name}`}
            </dd>
            <dt className="text-muted">Technical</dt>
            <dd>{techKeys.filter((k) => f[k]).map((k) => `${specMeta(k, kind).label}: ${f[k]}`).join(" · ") || "—"}</dd>
            <dt className="text-muted">Shipping</dt>
            <dd>
              {[f.reorderLevel && `reorder at ${f.reorderLevel}`, f.leadTimeDays && `${f.leadTimeDays} days lead time`, requireIqc && "Require IQC"].filter(Boolean).join(" · ") || "—"}
            </dd>
          </dl>
          {busy && (
            <p className="mt-3 flex items-center gap-2 text-sm">
              <Loader2 className="size-4 animate-spin" /> Creating…
            </p>
          )}
        </Card>
      )}

      {step === "done" && created && (
        <div className="grid gap-4 lg:grid-cols-2">
          <Card title="Part created">
            <p className="flex items-center gap-2 text-sm">
              <CheckCircle2 className="size-4 text-success" />
              <Link to={`/master-data/part-master/${created.id}`} className="font-medium text-primary hover:underline">
                {created.code}
              </Link>
            </p>
            <div className="mt-4 flex flex-wrap gap-2">
              <Button variant="primary" onClick={() => navigate(`/master-data/part-master/${created.id}`)}>
                Open the part
              </Button>
              <Button onClick={() => window.location.reload()}>Add another</Button>
            </div>
          </Card>
          <NextJourney
            items={[
              { label: "UOM conversion and Location Qty", detail: "On the part's tabs in Part Master.", action: <Link to={`/master-data/part-master/${created.id}?tab=location`} className="text-xs text-primary hover:underline">Part</Link> },
              { label: "Receive a lot (IQC)", detail: requireIqc ? "This part requires IQC before it can be issued." : "Inspect deliveries when needed.", action: <Link to="/qc/iqc-check-in-out/receive" className="text-xs text-primary hover:underline">IQC</Link> },
              { label: "Use it in a BOM", detail: "Pick it as a Son Code on a Father Code, or in New product.", action: <Link to="/bom" className="text-xs text-primary hover:underline">Bill of Material</Link> },
            ]}
          />
        </div>
      )}

      {step !== "done" && (
        <div className="sticky bottom-0 z-10 mt-4 flex flex-wrap items-center gap-2 rounded-lg border border-line bg-surface px-4 py-3 shadow-sm">
          <Button disabled={index === 0 || busy} onClick={() => go(ORDER[index - 1]!)}>
            Back
          </Button>
          <span className="text-xs text-muted">
            Step {index + 1} of 5 · {steps[index]!.label}
          </span>
          <div className="flex-1" />
          {step === "review" ? (
            <Button variant="primary" loading={busy} disabled={!can("bom.material.manage")} onClick={() => void create()}>
              Create part
            </Button>
          ) : (
            <Button variant="primary" onClick={() => go(ORDER[index + 1]!)}>
              Next: {steps[index + 1]!.label}
            </Button>
          )}
        </div>
      )}
    </>
  );
}
