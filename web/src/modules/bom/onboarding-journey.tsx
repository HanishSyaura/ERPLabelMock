import { useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, CheckCircle2, Loader2, Plus, Trash2 } from "lucide-react";
import { useMemo, useState } from "react";
import { Link, useNavigate } from "react-router";
import { PageHeader, SearchInput } from "@/components/common";
import { Journey, NextJourney, type JourneyStep } from "@/components/journey";
import { Badge, Button, Card, Checkbox, Field, Input, Select, Textarea } from "@/components/ui";
import { api, ApiError, qs } from "@/lib/api";
import { useAuth } from "@/stores/auth";
import { PART_KIND_LABEL, useDieCuts, usePartCategories, usePartGroups } from "@/modules/master-data/api";
import { useMachineCategories, useMachines, useRoutines } from "@/modules/planning/api";
import { useUoms, type BomRow } from "./api";
import { ArtworkDropzone, ArtworkThumb, type UploadResult } from "./artwork";
import { MaterialPicker, type PickedMaterial } from "./material-picker";
import { SPEC_GROUPS, type ProductDetail, type SpecField } from "./product-api";
import { WindingPicker } from "./winding";

/**
 * Product onboarding, start to end – every record gets what it needs:
 *   1 Artwork        new Father Code (artwork + label description) or one without a part
 *   2 Son Codes      component materials and quantities (the BOM)
 *   3 Part           finished-good part: code, description, UOM, NMI No., source,
 *                    category / group, specification, cartons per pallet
 *   4 Customer       Master Card header + AFRF-CS (incl. printing direction)
 *   5 Label          label, print & finishing, delivery (roll) data
 *   6 Material & process  die + Die Cut Spec, Manual QPA per material, routine + process detail
 *   7 Review         create everything; release when complete
 *   Done             links and the next step (Production Job Order)
 * The part's engineering data is filled from the card (label H × W, pcs per
 * roll, rolls per pack) so the two records agree.
 */
type StepId = "artwork" | "sons" | "part" | "customer" | "label" | "process" | "review" | "done";
const ORDER: StepId[] = ["artwork", "sons", "part", "customer", "label", "process", "review", "done"];
const SOURCES = ["Manufactured", "Purchased", "Customer supplied"];

interface SonLine {
  material: PickedMaterial | null;
  quantity: string;
  manualQpa: string;
}
interface Created {
  label: string;
  ref: string;
  to: string;
}
interface ProcRow {
  machineCategoryId: string;
  defaultMachineId: string;
  setupMins: string;
  outputPerPress: string;
  noOfPrint: string;
  speed: string;
  speedUom: string;
}
const group = (title: string) => SPEC_GROUPS.find((g) => g.title === title)!;
const num = (v: string | undefined) => (v && v.trim() ? Number(v) : undefined);

export function ProductOnboardingPage() {
  const { can } = useAuth();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const uoms = useUoms();
  const routines = useRoutines();
  const dies = useDieCuts({ page: 1, status: "ACTIVE" });
  const cats = useMachineCategories();
  const machines = useMachines();
  const partCats = usePartCategories("ACTIVE");
  const [step, setStep] = useState<StepId>("artwork");
  // 1
  const [artMode, setArtMode] = useState<"new" | "existing">("new");
  const [upload, setUpload] = useState<UploadResult | null>(null);
  const [labelDescription, setLabelDescription] = useState("");
  const [existing, setExisting] = useState<BomRow | null>(null);
  // 2
  const [sons, setSons] = useState<SonLine[]>([{ material: null, quantity: "", manualQpa: "" }]);
  const [existingQpa, setExistingQpa] = useState<Record<string, string>>({});
  // 3
  const [part, setPart] = useState({ code: "", description: "", uom: "PCS", nmiNo: "", source: "Manufactured", categoryId: "", groupId: "", specification: "", cartonsPerPallet: "" });
  const partGroups = usePartGroups(part.categoryId ? { categoryId: part.categoryId } : {});
  // 4–6 (Master Card spec, keyed by spec field)
  const [spec, setSpec] = useState<Record<string, string>>({ shape: "Rounded rectangle", coreMm: "76", printMethod: "UV flexo" });
  const [dieCutId, setDieCutId] = useState("");
  const [routineId, setRoutineId] = useState("");
  const [proc, setProc] = useState<Record<number, ProcRow>>({});
  // 7
  const [release, setRelease] = useState(can("bom.mastercard.release"));
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [running, setRunning] = useState<string | null>(null);
  const [created, setCreated] = useState<Created[]>([]);
  const [failure, setFailure] = useState<string | null>(null);
  const [problems, setProblems] = useState<string[]>([]);
  const [productId, setProductId] = useState<string | null>(null);

  const existingDetail = useQuery({
    queryKey: ["boms", "detail", existing?.id],
    queryFn: () => api.get<{ components: { sonCode: string; materialCode: string; materialDescription: string; quantity: string | null; uom: string | null }[] }>(`/boms/${existing!.id}`),
    enabled: artMode === "existing" && !!existing,
  });
  const existingSons = artMode === "existing" ? (existingDetail.data?.components ?? []) : [];
  const newSons = sons.filter((s) => s.material);
  const routine = routines.data?.find((r) => r.id === routineId);
  const routeSteps = useMemo(() => routine?.steps.map((s) => ({ seq: s.seq, process: s.process.name })) ?? [], [routine]);
  const die = dies.data?.data.find((d) => d.id === dieCutId);

  const check = (s: StepId): Record<string, string> => {
    const e: Record<string, string> = {};
    if (s === "artwork") {
      if (artMode === "new") {
        if (!upload) e.upload = "Upload the artwork";
        if (!labelDescription.trim()) e.labelDescription = "Enter the label description";
      } else if (!existing) e.existing = "Choose the Father Code";
    }
    if (s === "sons" && !existingSons.length && !newSons.length) e.sons = "Add at least one component material";
    if (s === "part") {
      if (!part.code.trim()) e.code = "Enter the part code";
      if (!part.description.trim()) e.description = "Enter the description";
    }
    if (s === "customer" && !spec.winding) e.winding = "Choose the printing direction";
    if (s === "label")
      for (const f of [...group("Label").fields, ...group("Delivery").fields]) if (f.required && !(f.kind === "winding" ? spec[f.key] : Number(spec[f.key]) > 0)) e[`spec.${f.key}`] = `Enter the ${f.label.toLowerCase()}`;
    return e;
  };
  const index = ORDER.indexOf(step);
  const go = (to: StepId) => {
    const target = ORDER.indexOf(to);
    if (target > index)
      for (const s of ORDER.slice(0, target)) {
        const e = check(s);
        if (Object.keys(e).length) {
          setErrors(e);
          setStep(s);
          return;
        }
      }
    setErrors({});
    setStep(to);
  };
  const steps: JourneyStep<StepId>[] = (
    [
      { id: "artwork", label: "Artwork", hint: "Father Code" },
      { id: "sons", label: "Son Codes", hint: "Materials (BOM)" },
      { id: "part", label: "Part", hint: "Part Master" },
      { id: "customer", label: "Customer", hint: "Header & AFRF-CS" },
      { id: "label", label: "Label", hint: "Size, print, roll" },
      { id: "process", label: "Material & process", hint: "Die, QPA, routing" },
      { id: "review", label: "Review", hint: "Create & release" },
      { id: "done", label: "Done", hint: "Ready for orders", state: step === "done" ? (failure ? "error" : "done") : undefined },
    ] as JourneyStep<StepId>[]
  ).map((s) => (step === "done" && s.id !== "done" ? { ...s, state: "done" as const } : s));

  const create = async () => {
    setFailure(null);
    setProblems([]);
    const made: Created[] = [];
    const push = (c: Created) => {
      made.push(c);
      setCreated([...made]);
    };
    try {
      let bomId = existing?.id ?? "";
      if (artMode === "new") {
        setRunning("Creating the Father Code…");
        const b = await api.post<{ id: string; fatherCode: string }>("/boms", { fileId: upload!.file.id, labelDescription });
        bomId = b.id;
        push({ label: "Father Code", ref: b.fatherCode, to: `/bom/${b.id}` });
      }
      let newCodes: string[] = [];
      if (newSons.length) {
        setRunning("Adding the Son Codes…");
        const added = await api.post<{ sonCodes: string[] }>(`/boms/${bomId}/son-codes`, { lines: newSons.map((l) => ({ materialId: l.material!.id, ...(l.quantity ? { quantity: Number(l.quantity) } : {}) })), changeNote: "Product onboarding" });
        newCodes = added.sonCodes;
      }
      const bomDetail = [
        ...existingSons.filter((s) => existingQpa[s.sonCode]).map((s) => ({ sonCode: s.sonCode, manualQpa: Number(existingQpa[s.sonCode]) })),
        ...newSons.map((l, i) => (l.manualQpa && newCodes[i] ? { sonCode: newCodes[i]!, manualQpa: Number(l.manualQpa) } : null)).filter((x): x is { sonCode: string; manualQpa: number } => !!x),
      ];

      setRunning("Creating the finished-good part…");
      const p = await api.post<{ id: string; code: string; product: { id: string } | null }>("/materials", {
        code: part.code,
        description: part.description,
        uom: part.uom,
        ...(part.nmiNo.trim() ? { nmiNo: part.nmiNo.trim() } : {}),
        source: part.source,
        categoryId: part.categoryId || null,
        groupId: part.groupId || null,
        specification:
          part.specification ||
          `${spec.labelWidthMm} × ${spec.labelHeightMm} mm ${spec.shape ?? ""}, ${spec.across} across, core ${spec.coreMm} mm, ${spec.labelsPerRoll} per roll, printing direction ${spec.winding}${spec.colours ? `, ${spec.colours}` : ""}.`,
        partType: "FINISHED_GOOD",
        bomId,
        // Engineering data from the card, so the part and the card agree.
        measureWMm: num(spec.labelWidthMm) ?? null,
        measureHMm: num(spec.labelHeightMm) ?? null,
        pcsPerRoll: num(spec.labelsPerRoll) ?? null,
        packQty: num(spec.rollsPerCarton) ?? null,
        cartonsPerPallet: num(part.cartonsPerPallet) ?? null,
        materialType: "Self-adhesive label",
      });
      push({ label: "Finished-good part", ref: p.code, to: `/master-data/part-master/${p.id}` });
      const pid = p.product!.id;
      setProductId(pid);

      setRunning("Starting the Master Card…");
      const card = await api.post<{ id: string; revisionNo: number }>(`/products/${pid}/cards`);
      const specOut: Record<string, unknown> = {};
      for (const g of SPEC_GROUPS)
        for (const f of g.fields) {
          const v = spec[f.key]?.trim();
          if (v) specOut[f.key] = f.kind === "number" || f.kind === "int" ? Number(v) : v;
        }
      if (dieCutId) specOut.dieCutId = dieCutId;
      if (bomDetail.length) specOut.bomDetail = bomDetail;
      const processDetail = routeSteps
        .map((st) => {
          const r = proc[st.seq];
          if (!r) return null;
          const row = { seq: st.seq, machineCategoryId: r.machineCategoryId || null, defaultMachineId: r.defaultMachineId || null, setupMins: num(r.setupMins) ?? null, outputPerPress: num(r.outputPerPress) ?? null, noOfPrint: num(r.noOfPrint) ?? null, speed: num(r.speed) ?? null, speedUom: r.speedUom || null };
          return row.machineCategoryId || row.defaultMachineId || row.setupMins != null || row.speed != null || row.outputPerPress != null || row.noOfPrint != null ? row : null;
        })
        .filter(Boolean);
      if (processDetail.length) specOut.processDetail = processDetail;
      await api.patch(`/products/${pid}/cards/${card.id}`, { spec: specOut, routineId: routineId || null, changeNote: "First issue (product onboarding)" });
      push({ label: "Master Card", ref: `Rev ${String(card.revisionNo).padStart(2, "0")}`, to: `/bom/master-card/${pid}` });
      if (release) {
        const detail = await api.get<ProductDetail>(`/products/${pid}`);
        const open = detail.draft?.releaseProblems ?? [];
        if (open.length) setProblems(open);
        else {
          setRunning("Releasing the Master Card…");
          await api.post(`/products/${pid}/cards/${card.id}/release`);
        }
      }
      await Promise.all([qc.invalidateQueries({ queryKey: ["boms"] }), qc.invalidateQueries({ queryKey: ["products"] }), qc.invalidateQueries({ queryKey: ["materials"] })]);
      setStep("done");
    } catch (e) {
      setFailure(e instanceof ApiError ? (e.issues[0] ? `${e.issues[0].message} (${e.issues[0].path})` : e.message) : String(e));
      setStep("done");
    } finally {
      setRunning(null);
    }
  };

  const canCreate = can("bom.material.manage") && can("bom.product.manage") && (artMode === "existing" || can("bom.create")) && (!newSons.length || can("bom.son.add"));
  const specField = (f: SpecField) => (
    <Field key={f.key} label={f.unit ? `${f.label} (${f.unit})` : f.label} required={f.required} error={errors[`spec.${f.key}`]} className={f.kind === "long" || f.kind === "winding" ? "sm:col-span-2 lg:col-span-4" : undefined}>
      {(p) =>
        f.kind === "winding" ? (
          <WindingPicker value={spec[f.key] ?? ""} onChange={(v) => setSpec((s) => ({ ...s, [f.key]: v }))} error={errors.winding} />
        ) : f.kind === "long" ? (
          <Textarea {...p} rows={2} value={spec[f.key] ?? ""} onChange={(e) => setSpec((s) => ({ ...s, [f.key]: e.target.value }))} />
        ) : (
          <Input {...p} inputMode={f.kind === "text" ? undefined : f.kind === "int" ? "numeric" : "decimal"} value={spec[f.key] ?? ""} onChange={(e) => setSpec((s) => ({ ...s, [f.key]: e.target.value }))} />
        )
      }
    </Field>
  );
  const fieldset = (title: string, label = title) => (
    <fieldset key={title} className="mb-5">
      <legend className="mb-2 text-xs font-semibold tracking-wide text-muted uppercase">{label}</legend>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">{group(title).fields.map(specField)}</div>
    </fieldset>
  );

  return (
    <>
      <PageHeader title="New product" description="Set up a new label product from artwork to a Master Card ready for production orders. Every record gets the data it needs." crumbs={[{ label: "BOM" }, { label: "Master Card", to: "/bom/master-card" }, { label: "New product" }]} />
      <Card className="mb-4">
        <Journey steps={steps} current={step} onSelect={step === "done" || running ? undefined : go} locked={(s) => s === "done"} />
      </Card>

      {step === "artwork" && (
        <Card title="1. Artwork (Father Code)">
          <div className="mb-4 grid gap-2 sm:grid-cols-2">
            {(
              [
                ["new", "New artwork", "Upload the artwork; a new Father Code is created"],
                ["existing", "Existing Father Code", "A Father Code that no finished-good part uses yet"],
              ] as const
            ).map(([id, label, hint]) => (
              <label key={id} className={`flex cursor-pointer gap-3 rounded-lg border p-3 text-sm ${artMode === id ? "border-primary bg-primary-soft" : "border-line"}`}>
                <input type="radio" name="art" checked={artMode === id} onChange={() => setArtMode(id)} className="mt-0.5" />
                <span>
                  <span className="block font-medium">{label}</span>
                  <span className="text-xs text-muted">{hint}</span>
                </span>
              </label>
            ))}
          </div>
          {artMode === "new" ? (
            <div className="grid gap-4 lg:grid-cols-2">
              <ArtworkDropzone value={upload} onChange={setUpload} error={errors.upload} />
              <Field label="Label description" required error={errors.labelDescription} hint="e.g. Mango Juice 1L – front label">
                {(p) => <Textarea {...p} rows={3} value={labelDescription} onChange={(e) => setLabelDescription(e.target.value)} />}
              </Field>
            </div>
          ) : (
            <FatherCodeChooser value={existing} onChange={setExisting} error={errors.existing} />
          )}
        </Card>
      )}

      {step === "sons" && (
        <Card title="2. Son Codes (component materials)">
          <p className="mb-3 text-sm text-muted">Each material becomes a Son Code. QPA is calculated on the Master Card from the die and the part width (m² / m materials), cores and cartons from the roll data; enter a Manual QPA only to override.</p>
          {existingSons.length > 0 && (
            <ul className="mb-4 divide-y divide-line rounded-md border border-line text-sm">
              {existingSons.map((s) => (
                <li key={s.sonCode} className="grid items-center gap-2 px-3 py-2 sm:grid-cols-[6rem_1fr_7rem_9rem]">
                  <span className="font-medium">{s.sonCode}</span>
                  <span className="min-w-0 truncate">
                    {s.materialCode} <span className="text-muted">{s.materialDescription}</span>
                  </span>
                  <span className="tabular-nums">{s.quantity ? `${s.quantity} ${s.uom ?? ""}` : "—"}</span>
                  <Input inputMode="decimal" value={existingQpa[s.sonCode] ?? ""} onChange={(e) => setExistingQpa((m) => ({ ...m, [s.sonCode]: e.target.value }))} placeholder="Manual QPA" aria-label={`${s.sonCode} manual QPA`} />
                </li>
              ))}
            </ul>
          )}
          <ul className="space-y-2">
            {sons.map((l, i) => (
              <li key={i} className="grid items-end gap-2 sm:grid-cols-[1fr_8rem_8rem_auto]">
                <Field label={`Material ${i + 1}`}>{() => <MaterialPicker value={l.material} onChange={(m) => setSons((x) => x.map((y, k) => (k === i ? { ...y, material: m } : y)))} />}</Field>
                <Field label={`BOM qty${l.material ? ` (${l.material.uom})` : ""}`}>{(p) => <Input {...p} inputMode="decimal" value={l.quantity} onChange={(e) => setSons((x) => x.map((y, k) => (k === i ? { ...y, quantity: e.target.value } : y)))} />}</Field>
                <Field label="Manual QPA">{(p) => <Input {...p} inputMode="decimal" value={l.manualQpa} onChange={(e) => setSons((x) => x.map((y, k) => (k === i ? { ...y, manualQpa: e.target.value } : y)))} />}</Field>
                <Button variant="ghost" icon={<Trash2 className="size-4" />} disabled={sons.length === 1} aria-label="Remove" onClick={() => setSons((x) => x.filter((_, k) => k !== i))} />
              </li>
            ))}
          </ul>
          {errors.sons && <p className="mt-2 text-sm text-danger">{errors.sons}</p>}
          <Button className="mt-3" icon={<Plus className="size-4" />} onClick={() => setSons((x) => [...x, { material: null, quantity: "", manualQpa: "" }])}>
            Add material
          </Button>
          <p className="mt-3 text-xs text-muted">
            Material missing?{" "}
            <Link to="/master-data/part-master/new" target="_blank" className="text-primary hover:underline">
              Add it as a new part
            </Link>{" "}
            and search again.
          </p>
        </Card>
      )}

      {step === "part" && (
        <Card title="3. Finished-good part (Part Master)">
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Part code" required error={errors.code}>{(p) => <Input {...p} value={part.code} onChange={(e) => setPart((x) => ({ ...x, code: e.target.value }))} autoFocus />}</Field>
            <Field label="NMI No." hint="Same number on the Part Master and the Master Card.">{(p) => <Input {...p} value={part.nmiNo} onChange={(e) => setPart((x) => ({ ...x, nmiNo: e.target.value }))} />}</Field>
            <Field label="Part description" required className="sm:col-span-2" error={errors.description}>
              {(p) => <Input {...p} value={part.description} onChange={(e) => setPart((x) => ({ ...x, description: e.target.value }))} placeholder={labelDescription || existing?.labelDescription} />}
            </Field>
            <Field label="Part UOM">
              {(p) => (
                <Select {...p} value={part.uom} onChange={(e) => setPart((x) => ({ ...x, uom: e.target.value }))}>
                  {uoms.data?.map((u) => (
                    <option key={u.code} value={u.code}>
                      {u.code} – {u.label}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
            <Field label="Source">
              {(p) => (
                <>
                  <Input {...p} value={part.source} onChange={(e) => setPart((x) => ({ ...x, source: e.target.value }))} list="ob-src" />
                  <datalist id="ob-src">{SOURCES.map((x) => <option key={x} value={x} />)}</datalist>
                </>
              )}
            </Field>
            <Field label="Part category">
              {(p) => (
                <Select {...p} value={part.categoryId} onChange={(e) => setPart((x) => ({ ...x, categoryId: e.target.value, groupId: "" }))}>
                  <option value="">Not classified</option>
                  {partCats.data?.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name} ({PART_KIND_LABEL[c.kind]})
                    </option>
                  ))}
                </Select>
              )}
            </Field>
            <Field label="Part group">
              {(p) => (
                <Select {...p} value={part.groupId} disabled={!part.categoryId} onChange={(e) => setPart((x) => ({ ...x, groupId: e.target.value }))}>
                  <option value="">{part.categoryId ? "No group" : "Choose a category first"}</option>
                  {partGroups.data?.filter((g) => g.status === "ACTIVE").map((g) => (
                    <option key={g.id} value={g.id}>
                      {g.name}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
            <Field label="Cartons per pallet">{(p) => <Input {...p} inputMode="numeric" value={part.cartonsPerPallet} onChange={(e) => setPart((x) => ({ ...x, cartonsPerPallet: e.target.value }))} />}</Field>
            <Field label="Specification" className="sm:col-span-2" hint="Empty = written from the label data (size, across, core, roll, printing direction).">
              {(p) => <Textarea {...p} rows={2} value={part.specification} onChange={(e) => setPart((x) => ({ ...x, specification: e.target.value }))} />}
            </Field>
          </div>
          <p className="mt-3 text-xs text-muted">Label H × W, pcs per roll and rolls per pack are copied from the Master Card data in the next steps.</p>
        </Card>
      )}

      {step === "customer" && (
        <Card title="4. Customer: Master Card header and AFRF-CS">
          {fieldset("Header", "Header – customer and end user")}
          {fieldset("AFRF-CS")}
        </Card>
      )}

      {step === "label" && (
        <Card title="5. Label, print and roll">
          {fieldset("Label")}
          {fieldset("Print and finishing")}
          {fieldset("Delivery", "Delivery – roll and carton")}
          {fieldset("Tooling and customer", "Tooling and customer requirements")}
        </Card>
      )}

      {step === "process" && (
        <Card title="6. Material spec and process detail">
          <fieldset className="mb-5">
            <legend className="mb-2 text-xs font-semibold tracking-wide text-muted uppercase">Die Cut Spec</legend>
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <Field label="Die Cut Code" className="sm:col-span-2" hint="Feed length and Feed UPS default from the die.">
                {(p) => (
                  <Select {...p} value={dieCutId} onChange={(e) => setDieCutId(e.target.value)}>
                    <option value="">No die yet</option>
                    {dies.data?.data.map((d) => (
                      <option key={d.id} value={d.id}>
                        {d.code} – {d.labelWidthMm} × {d.labelHeightMm} mm, {d.across} × {d.around}
                      </option>
                    ))}
                  </Select>
                )}
              </Field>
              {group("Die Cut Spec").fields.map(specField)}
            </div>
            {die && (
              <p className="mt-2 text-xs text-muted">
                Die defaults: feed length {die.repeatMm ?? "—"} mm, Feed UPS {die.across} × {die.around} = {die.across * die.around}. QPA is calculated when the card is saved; check it on the Material Spec tab.
              </p>
            )}
          </fieldset>
          <fieldset>
            <legend className="mb-2 text-xs font-semibold tracking-wide text-muted uppercase">Process Detail</legend>
            <Field label="Routing (Routine Code)" hint="The process route new Job Orders use.">
              {(p) => (
                <Select {...p} value={routineId} onChange={(e) => setRoutineId(e.target.value)}>
                  <option value="">Not set yet</option>
                  {routines.data?.filter((r) => r.status === "ACTIVE").map((r) => (
                    <option key={r.id} value={r.id}>
                      {r.code} – {r.steps.map((s) => s.process.name).join(" → ")}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
            <ul className="mt-3 space-y-3">
              {routeSteps.map((st) => {
                const r = proc[st.seq] ?? { machineCategoryId: "", defaultMachineId: "", setupMins: "", outputPerPress: "", noOfPrint: "", speed: "", speedUom: "m/min" };
                const setR = (patch: Partial<ProcRow>) => setProc((m) => ({ ...m, [st.seq]: { ...r, ...patch } }));
                return (
                  <li key={st.seq} className="rounded-md border border-line p-3">
                    <p className="mb-2 text-sm font-medium">
                      {st.seq}. {st.process}
                    </p>
                    <div className="grid grid-cols-2 gap-2 sm:grid-cols-4 lg:grid-cols-7">
                      <Field label="Machine category">
                        {(p) => (
                          <Select {...p} value={r.machineCategoryId} onChange={(e) => setR({ machineCategoryId: e.target.value, defaultMachineId: "" })}>
                            <option value="">—</option>
                            {cats.data?.map((c) => (
                              <option key={c.id} value={c.id}>
                                {c.code}
                              </option>
                            ))}
                          </Select>
                        )}
                      </Field>
                      <Field label="Default machine">
                        {(p) => (
                          <Select {...p} value={r.defaultMachineId} onChange={(e) => setR({ defaultMachineId: e.target.value })}>
                            <option value="">—</option>
                            {machines.data?.filter((m) => m.isActive && (!r.machineCategoryId || m.categoryId === r.machineCategoryId)).map((m) => (
                              <option key={m.id} value={m.id}>
                                {m.code}
                              </option>
                            ))}
                          </Select>
                        )}
                      </Field>
                      <Field label="Setup (min)">{(p) => <Input {...p} inputMode="decimal" value={r.setupMins} onChange={(e) => setR({ setupMins: e.target.value })} />}</Field>
                      <Field label="Output / press">{(p) => <Input {...p} inputMode="decimal" value={r.outputPerPress} onChange={(e) => setR({ outputPerPress: e.target.value })} />}</Field>
                      <Field label="No. of print">{(p) => <Input {...p} inputMode="numeric" value={r.noOfPrint} onChange={(e) => setR({ noOfPrint: e.target.value })} />}</Field>
                      <Field label="Speed">{(p) => <Input {...p} inputMode="decimal" value={r.speed} onChange={(e) => setR({ speed: e.target.value })} />}</Field>
                      <Field label="Speed UOM">{(p) => <Input {...p} value={r.speedUom} onChange={(e) => setR({ speedUom: e.target.value })} />}</Field>
                    </div>
                  </li>
                );
              })}
            </ul>
          </fieldset>
        </Card>
      )}

      {step === "review" && (
        <Card title="7. Review and create">
          <dl className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-[11rem_1fr]">
            <dt className="text-muted">Artwork</dt>
            <dd>{artMode === "new" ? `New Father Code · ${labelDescription}` : `${existing?.fatherCode} · ${existing?.labelDescription}`}</dd>
            <dt className="text-muted">Son Codes</dt>
            <dd>{[...existingSons.map((s) => s.materialCode), ...newSons.map((s) => `${s.material!.code}${s.quantity ? ` × ${s.quantity}` : ""}${s.manualQpa ? ` (QPA ${s.manualQpa})` : ""}`)].join(", ")}</dd>
            <dt className="text-muted">Part</dt>
            <dd>
              {part.code.toUpperCase()} · {part.description} · {part.uom}
              {part.nmiNo && ` · NMI ${part.nmiNo}`}
              {part.categoryId && ` · ${partCats.data?.find((c) => c.id === part.categoryId)?.name}`}
            </dd>
            <dt className="text-muted">Customer</dt>
            <dd>{[spec.customerCode, spec.customerPartCode, spec.endUser].filter(Boolean).join(" · ") || "—"}</dd>
            <dt className="text-muted">AFRF-CS</dt>
            <dd>{[spec.afrfMaterial, spec.afrfColor, spec.afrfForm, spec.packingInstruction].filter(Boolean).join(" · ") || "—"}</dd>
            <dt className="text-muted">Label and roll</dt>
            <dd>
              {spec.labelWidthMm} × {spec.labelHeightMm} mm {spec.shape}, {spec.across} across, core {spec.coreMm} mm, {spec.labelsPerRoll} per roll{spec.rollsPerCarton ? `, ${spec.rollsPerCarton} rolls / carton` : ""}, printing direction {spec.winding}
            </dd>
            <dt className="text-muted">Material and process</dt>
            <dd>
              {die ? `Die ${die.code}` : "No die"} · {routine ? `${routine.code} (${routeSteps.length} steps, ${Object.keys(proc).length} with machine data)` : "No routing"}
            </dd>
          </dl>
          <div className="mt-5 border-t border-line pt-4">
            <Checkbox label="Release the Master Card now if it is complete (production orders can then be created)" checked={release} disabled={!can("bom.mastercard.release")} onChange={(e) => setRelease(e.target.checked)} />
            <p className="mt-1 text-xs text-muted">Otherwise it stays a draft to finish in the Master Card editor.</p>
          </div>
          {!canCreate && <p className="mt-3 text-sm text-danger">Your role can't create all of these records (Father Code, Son Codes, part and Master Card).</p>}
          {running && (
            <p className="mt-4 flex items-center gap-2 text-sm">
              <Loader2 className="size-4 animate-spin" /> {running}
            </p>
          )}
        </Card>
      )}

      {step === "done" && (
        <div className="grid gap-4 lg:grid-cols-2">
          <Card title={failure ? "Stopped part-way" : "Product set up"}>
            {failure && (
              <p className="mb-3 flex gap-2 rounded-md bg-danger-soft p-3 text-sm text-danger">
                <AlertTriangle className="mt-0.5 size-4 shrink-0" /> {failure}. Everything listed below was created; continue from there.
              </p>
            )}
            <ul className="space-y-2 text-sm">
              {created.map((c) => (
                <li key={c.label} className="flex items-center gap-2">
                  <CheckCircle2 className="size-4 text-success" />
                  <span className="text-muted">{c.label}</span>
                  <Link to={c.to} className="font-medium text-primary hover:underline">
                    {c.ref}
                  </Link>
                </li>
              ))}
            </ul>
            {problems.length > 0 ? (
              <div className="mt-3 rounded-md bg-warning-soft p-3 text-sm text-warning">
                <p className="font-medium">The Master Card stays a draft until these are done:</p>
                <ul className="mt-1 list-disc pl-5">
                  {problems.map((x) => (
                    <li key={x}>{x}</li>
                  ))}
                </ul>
              </div>
            ) : (
              !failure && release && <Badge tone="success" className="mt-3">Master Card released – ready for production orders</Badge>
            )}
            <div className="mt-4 flex flex-wrap gap-2">
              {productId && (
                <Button variant="primary" onClick={() => navigate(`/bom/master-card/${productId}`)}>
                  Open the Master Card
                </Button>
              )}
              <Button onClick={() => window.location.reload()}>Set up another</Button>
            </div>
          </Card>
          <NextJourney
            items={[
              { label: "Check QPA", detail: "Material Spec tab of the Master Card shows each Son Code's QPA with its formula.", action: productId ? <Link to={`/bom/master-card/${productId}?mc=bom`} className="text-xs text-primary hover:underline">Material Spec</Link> : undefined },
              { label: "Part data", detail: "Shipping, UOM conversion and Location Qty in Part Master." },
              { label: "Create a Production Job Order", detail: "Order quantity, Job Orders and MRS in one journey.", action: <Link to="/planning/production-job-order/new" className="text-xs text-primary hover:underline">New PJO</Link> },
            ]}
          />
        </div>
      )}

      {step !== "done" && (
        <div className="sticky bottom-0 z-10 mt-4 flex flex-wrap items-center gap-2 rounded-lg border border-line bg-surface px-4 py-3 shadow-sm">
          <Button disabled={index === 0 || !!running} onClick={() => go(ORDER[index - 1]!)}>
            Back
          </Button>
          <span className="text-xs text-muted">
            Step {index + 1} of 7 · {steps[index]!.label}
          </span>
          <div className="flex-1" />
          {step === "review" ? (
            <Button variant="primary" loading={!!running} disabled={!canCreate} onClick={() => void create()}>
              Create product
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

/** Active Father Codes that no finished-good part uses yet. */
function FatherCodeChooser({ value, onChange, error }: { value: BomRow | null; onChange: (b: BomRow) => void; error?: string }) {
  const [q, setQ] = useState("");
  const list = useQuery({ queryKey: ["boms", "no-part", q], queryFn: () => api.list<BomRow>(`/boms${qs({ q, status: "ACTIVE", product: "without", pageSize: 20 })}`) });
  return (
    <div>
      <SearchInput value={q} onChange={setQ} placeholder="Father Code or label description" />
      {error && <p className="mt-2 text-sm text-danger">{error}</p>}
      <div className="mt-3 grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
        {list.data?.data.map((b) => (
          <button key={b.id} type="button" onClick={() => onChange(b)} className={`flex items-center gap-3 rounded-lg border p-3 text-left text-sm transition ${value?.id === b.id ? "border-primary bg-primary-soft" : "border-line hover:border-primary/50"}`}>
            <ArtworkThumb file={b.artworkFile} className="size-14" />
            <span className="min-w-0">
              <span className="block font-medium">{b.fatherCode}</span>
              <span className="line-clamp-2 text-xs text-muted">{b.labelDescription}</span>
              <span className="text-xs text-muted">{b.sonCount} Son Codes</span>
            </span>
          </button>
        ))}
      </div>
      {list.data && !list.data.data.length && <p className="mt-3 text-sm text-muted">No free Father Code{q ? " matches" : ""}. Choose “New artwork”.</p>}
    </div>
  );
}
