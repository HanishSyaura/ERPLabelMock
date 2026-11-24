import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, ChevronRight, ClipboardCheck, Minus, Plus, X } from "lucide-react";
import { useEffect, useState } from "react";
import { useNavigate } from "react-router";
import { Button, Spinner } from "@/components/ui";
import { api, ApiError, qs } from "@/lib/api";
import { cn } from "@/lib/utils";
import { useAuth } from "@/stores/auth";
import { DISPOSITION_LABEL, DISPOSITIONS, useDefects, useInspections, useOqcCandidates, type Disposition, type InspectionDetail, type QcType } from "@/modules/qc/api";
import { Alert, BackLink, Centered, ErrorPanel, QtyInput, ResultPanel, TextInput } from "./handheld-app";
import { ModuleBand } from "./handheld-home";
import { ScanBox } from "./scan-box";

/**
 * Quality on the handheld – same big-button format as Production and Material.
 *   IQC receive:  part → lot → Check In → checks & defects → Check Out → decide → store → done
 *   OQC:          offer a Job Order (scan / pick) or open a waiting lot → checks → Check Out → decide
 */
const msg = (e: unknown) => (e instanceof ApiError ? (e.issues[0]?.message ?? e.message) : e instanceof Error ? e.message : String(e));
interface PartOption {
  id: string;
  code: string;
  description: string;
  uom: string;
  category: string | null;
}

function StepBar({ steps, current }: { steps: string[]; current: number }) {
  return (
    <div className="mb-4">
      <div className="flex gap-1" aria-hidden>
        {steps.map((s, i) => (
          <span key={s} className={cn("h-2 flex-1 rounded-full", i < current ? "bg-success" : i === current ? "bg-success/60" : "bg-neutral-soft")} />
        ))}
      </div>
      <p className="mt-1 text-sm text-muted">
        Step {Math.min(current + 1, steps.length)} of {steps.length} · <span className="font-semibold text-fg">{steps[Math.min(current, steps.length - 1)]}</span>
      </p>
    </div>
  );
}

const BigButton = (p: React.ComponentProps<typeof Button>) => <Button size="xl" className="w-full" {...p} />;

// ---------------------------------------------------------------------------
// IQC receive
// ---------------------------------------------------------------------------
type IqcStep = "part" | "lot" | "inspect" | "decide" | "store" | "done";
const IQC_STEPS = ["Part", "Lot", "Inspect", "Decide", "Store"];

export function HandheldIqc() {
  const { can } = useAuth();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [step, setStep] = useState<IqcStep>("part");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [part, setPart] = useState<PartOption | null>(null);
  const [lot, setLot] = useState({ lotRef: "", supplierName: "", deliveryRef: "", qty: "", sampleSize: "" });
  const [inspId, setInspId] = useState<string | null>(null);
  const [stored, setStored] = useState<string | null>(null);
  const toModule = () => navigate("/hh/module/quality");
  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      await qc.invalidateQueries({ queryKey: ["qc"] });
    } catch (e) {
      setError(msg(e));
    } finally {
      setBusy(false);
    }
  };
  const index = { part: 0, lot: 1, inspect: 2, decide: 3, store: 4, done: 5 }[step];

  return (
    <>
      <ModuleBand module="quality" title="Receive a lot (IQC)" onBack={toModule} />
      {step !== "done" && <StepBar steps={IQC_STEPS} current={index} />}

      {step === "part" && (
        <PartFinder
          onPick={(p) => {
            setPart(p);
            setStep("lot");
          }}
          onBack={toModule}
        />
      )}

      {step === "lot" && part && (
        <div className="space-y-4">
          <BackLink onClick={() => setStep("part")} label="Change part" />
          <PartCard part={part} />
          <TextInput label="Lot / roll no. *" value={lot.lotRef} onChange={(v) => setLot((l) => ({ ...l, lotRef: v }))} />
          <QtyInput label="Delivered quantity *" value={lot.qty} onChange={(v) => setLot((l) => ({ ...l, qty: v }))} unit={part.uom} />
          <QtyInput label="Sample size" value={lot.sampleSize} onChange={(v) => setLot((l) => ({ ...l, sampleSize: v }))} unit={part.uom} />
          <TextInput label="Supplier" value={lot.supplierName} onChange={(v) => setLot((l) => ({ ...l, supplierName: v }))} />
          <TextInput label="DO / delivery ref." value={lot.deliveryRef} onChange={(v) => setLot((l) => ({ ...l, deliveryRef: v }))} />
          {error && <Alert tone="danger">{error}</Alert>}
          <BigButton
            variant="primary"
            loading={busy}
            disabled={!lot.lotRef.trim() || !(Number(lot.qty) > 0)}
            onClick={() =>
              void run(async () => {
                const r = await api.post<{ id: string; inspNo: string }>("/qc/iqc", { materialId: part.id, lotRef: lot.lotRef, supplierName: lot.supplierName, deliveryRef: lot.deliveryRef, qty: lot.qty, uom: part.uom, sampleSize: lot.sampleSize || null });
                setInspId(r.id);
                setStep("inspect");
              })
            }
          >
            Check In
          </BigButton>
        </div>
      )}

      {step === "inspect" && inspId && <InspectScreen type="IQC" inspId={inspId} onDone={() => setStep("decide")} />}

      {step === "decide" && inspId && (
        <DecideScreen
          type="IQC"
          inspId={inspId}
          onNext={(accepted) => setStep(accepted > 0 && can("bom.material.manage") ? "store" : "done")}
          nextLabel={(accepted) => (accepted > 0 && can("bom.material.manage") ? "Next: Store" : "Finish")}
        />
      )}

      {step === "store" && inspId && part && (
        <StoreScreen
          inspId={inspId}
          part={part}
          lotRef={lot.lotRef}
          onSkip={() => setStep("done")}
          onStored={(s) => {
            setStored(s);
            setStep("done");
          }}
        />
      )}

      {step === "done" && inspId && (
        <IqcDone
          inspId={inspId}
          stored={stored}
          onAnother={() => {
            setPart(null);
            setLot({ lotRef: "", supplierName: "", deliveryRef: "", qty: "", sampleSize: "" });
            setInspId(null);
            setStored(null);
            setStep("part");
          }}
          onModule={toModule}
        />
      )}
    </>
  );
}

function PartFinder({ onPick, onBack }: { onPick: (p: PartOption) => void; onBack: () => void }) {
  const [term, setTerm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const list = useQuery({ queryKey: ["hh", "part-lookup", term], queryFn: () => api.get<PartOption[]>(`/materials/lookup${qs({ q: term })}`), enabled: term.length > 0 });
  const scan = async (code: string) => {
    setBusy(true);
    setError(null);
    try {
      const rows = await api.get<PartOption[]>(`/materials/lookup${qs({ q: code })}`);
      const exact = rows.find((r) => r.code.toUpperCase() === code.toUpperCase());
      if (exact) onPick(exact);
      else if (!rows.length) setError(`No active part matches “${code}”.`);
      else setTerm(code);
    } catch (e) {
      setError(msg(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="space-y-4">
      <BackLink onClick={onBack} />
      <div className="rounded-xl border-2 border-line bg-surface p-3">
        <p className="mb-2 text-base font-semibold">Scan the part barcode on the delivery</p>
        <ScanBox label="Part code" placeholder="e.g. PP-WHT-80" onScan={(c) => void scan(c)} busy={busy} />
      </div>
      {error && <Alert tone="danger">{error}</Alert>}
      {term && (
        <div className="space-y-2">
          <p className="text-sm font-semibold tracking-wide text-muted uppercase">Matches for “{term}”</p>
          {list.isPending && <Spinner />}
          {list.data?.map((p) => (
            <button key={p.id} onClick={() => onPick(p)} className="flex min-h-16 w-full items-center gap-3 rounded-xl border-2 border-line bg-surface p-3 text-left active:bg-surface-2">
              <span className="min-w-0 flex-1">
                <span className="block text-lg font-semibold">{p.code}</span>
                <span className="block truncate text-sm text-muted">
                  {p.description} · {p.uom}
                </span>
              </span>
              <ChevronRight className="size-6 text-muted" />
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

const PartCard = ({ part }: { part: PartOption }) => (
  <div className="rounded-xl bg-success-soft p-3">
    <p className="text-2xl font-bold">{part.code}</p>
    <p className="text-base">{part.description}</p>
    <p className="text-sm text-muted">
      {part.category ?? "Not classified"} · {part.uom}
    </p>
  </div>
);

function StoreScreen({ inspId, part, lotRef, onSkip, onStored }: { inspId: string; part: PartOption; lotRef: string; onSkip: () => void; onStored: (s: string) => void }) {
  const insp = useInspectionDetail(inspId);
  const [loc, setLoc] = useState({ warehouseCode: "", locationCode: "", shelfLocation: "" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const i = insp.data;
  if (!i) return <Centered><Spinner className="size-8" /></Centered>;
  const accepted = acceptedQty(i);
  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      await api.post(`/materials/${part.id}/locations`, { ...loc, lotNo: lotRef, qty: accepted });
      onStored(`${accepted.toLocaleString()} ${i.uom} in ${loc.warehouseCode.toUpperCase()} / ${loc.locationCode.toUpperCase()}${loc.shelfLocation ? ` / ${loc.shelfLocation}` : ""}`);
    } catch (e) {
      setError(msg(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="space-y-4">
      <div className="rounded-xl bg-surface-2 p-3">
        <p className="text-xs text-muted uppercase">Accepted to store</p>
        <p className="text-3xl font-bold tabular-nums">
          {accepted.toLocaleString()} <span className="text-base font-normal text-muted">{i.uom}</span>
        </p>
        <p className="text-sm text-muted">Lot {lotRef}</p>
      </div>
      <TextInput label="Warehouse code *" value={loc.warehouseCode} onChange={(v) => setLoc((l) => ({ ...l, warehouseCode: v }))} />
      <TextInput label="Location code *" value={loc.locationCode} onChange={(v) => setLoc((l) => ({ ...l, locationCode: v }))} />
      <TextInput label="Shelf" value={loc.shelfLocation} onChange={(v) => setLoc((l) => ({ ...l, shelfLocation: v }))} />
      {error && <Alert tone="danger">{error}</Alert>}
      <BigButton variant="primary" loading={busy} disabled={!loc.warehouseCode.trim() || !loc.locationCode.trim()} onClick={() => void save()}>
        Save location
      </BigButton>
      <Button size="lg" variant="ghost" className="w-full" onClick={onSkip}>
        Skip – store later
      </Button>
    </div>
  );
}

function IqcDone({ inspId, stored, onAnother, onModule }: { inspId: string; stored: string | null; onAnother: () => void; onModule: () => void }) {
  const insp = useInspectionDetail(inspId);
  const i = insp.data;
  if (!i) return <Centered><Spinner className="size-8" /></Centered>;
  const ok = ["PASSED", "ACCEPTED"].includes(i.status);
  const lines = [`${i.inspNo} · ${i.part?.code ?? ""}`, statusLine(i)];
  if (stored) lines.push(`Stored: ${stored}`);
  return (
    <div className="space-y-3">
      <ResultPanel ok={ok || i.status === "PENDING_DISPOSITION"} title={ok ? "Lot released" : i.status === "PENDING_DISPOSITION" ? "Lot on hold" : "Lot not released"} lines={lines} onDone={onAnother} />
      <Button size="lg" className="w-full" onClick={onModule}>
        Back to Quality
      </Button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// OQC
// ---------------------------------------------------------------------------
export function HandheldOqc() {
  const { can } = useAuth();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [mode, setMode] = useState<"home" | "offer" | "inspect" | "decide" | "done">("home");
  const [inspId, setInspId] = useState<string | null>(null);
  const toModule = () => navigate("/hh/module/quality");
  const open = useInspections("OQC", { page: 1, view: "open" });
  const reset = () => {
    setInspId(null);
    setMode("home");
    void qc.invalidateQueries({ queryKey: ["qc"] });
  };
  const steps = ["Lot", "Inspect", "Decide"];

  return (
    <>
      <ModuleBand module="quality" title="OQC – finished labels" onBack={mode === "home" ? toModule : reset} />
      {mode !== "home" && mode !== "done" && <StepBar steps={steps} current={mode === "offer" ? 0 : mode === "inspect" ? 1 : 2} />}

      {mode === "home" && (
        <div className="space-y-4">
          {can("qc.oqc.inspect") && (
            <button onClick={() => setMode("offer")} className="flex min-h-20 w-full items-center gap-4 rounded-xl border-2 border-success bg-success-soft p-3 text-left active:scale-[0.99]">
              <span className="grid size-12 place-items-center rounded-lg bg-success text-white">
                <Plus className="size-7" />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block text-lg font-bold">Offer a Job Order to OQC</span>
                <span className="block text-sm text-muted">Scan the Job Order of finished labels</span>
              </span>
              <ChevronRight className="size-6 text-muted" />
            </button>
          )}
          <section className="space-y-2">
            <h2 className="text-sm font-semibold tracking-wide text-muted uppercase">Waiting lots</h2>
            {open.isPending && <Spinner />}
            {open.error && <ErrorPanel message={(open.error as Error).message} onRetry={() => void open.refetch()} />}
            {open.data && !open.data.data.length && <p className="rounded-xl bg-surface-2 p-4 text-base text-muted">No OQC lots are waiting.</p>}
            {open.data?.data.map((l) => (
              <button
                key={l.id}
                onClick={() => {
                  setInspId(l.id);
                  setMode(l.status === "IN_INSPECTION" ? "inspect" : "decide");
                }}
                className="flex min-h-20 w-full items-center gap-3 rounded-xl border-2 border-line bg-surface p-3 text-left active:bg-surface-2"
              >
                <ClipboardCheck className="size-7 shrink-0 text-success" />
                <span className="min-w-0 flex-1">
                  <span className="block text-lg font-semibold">
                    {l.inspNo} · {l.workOrder?.woNo}
                  </span>
                  <span className="block truncate text-sm text-muted">
                    {l.workOrder?.fatherCode} · {Number(l.qty).toLocaleString()} {l.uom}
                  </span>
                  <span className={cn("mt-1 inline-block rounded-full px-2 py-0.5 text-xs font-semibold", l.status === "IN_INSPECTION" ? "bg-info-soft text-info" : "bg-warning-soft text-warning")}>{l.status === "IN_INSPECTION" ? "To inspect" : "Needs a disposition"}</span>
                </span>
                <ChevronRight className="size-6 text-muted" />
              </button>
            ))}
          </section>
        </div>
      )}

      {mode === "offer" && (
        <OfferJobOrder
          onBack={() => setMode("home")}
          onCheckedIn={(id) => {
            setInspId(id);
            setMode("inspect");
          }}
        />
      )}
      {mode === "inspect" && inspId && <InspectScreen type="OQC" inspId={inspId} onDone={() => setMode("decide")} />}
      {mode === "decide" && inspId && <DecideScreen type="OQC" inspId={inspId} onNext={() => setMode("done")} nextLabel={() => "Finish"} />}
      {mode === "done" && inspId && <OqcDone inspId={inspId} onDone={reset} />}
    </>
  );
}

function OfferJobOrder({ onBack, onCheckedIn }: { onBack: () => void; onCheckedIn: (id: string) => void }) {
  const [term, setTerm] = useState("");
  const candidates = useOqcCandidates(term);
  const [pick, setPick] = useState<string | null>(null);
  const [qty, setQty] = useState("");
  const [sample, setSample] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const c = candidates.data?.find((x) => x.id === pick);
  const scan = (code: string) => {
    setTerm(code);
    setError(null);
  };
  // A scan matching exactly one Job Order picks it.
  const exact = term && candidates.data?.length === 1 ? candidates.data[0]! : null;
  useEffect(() => {
    if (exact) {
      setPick(exact.id);
      setQty(exact.availableQty);
    }
  }, [exact]);
  const checkIn = async () => {
    if (!c) return;
    setBusy(true);
    setError(null);
    try {
      const r = await api.post<{ id: string }>("/qc/oqc", { workOrderId: c.id, qty, sampleSize: sample || null });
      onCheckedIn(r.id);
    } catch (e) {
      setError(msg(e));
    } finally {
      setBusy(false);
    }
  };
  if (c)
    return (
      <div className="space-y-4">
        <BackLink onClick={() => setPick(null)} label="Change Job Order" />
        <div className="rounded-xl bg-success-soft p-3">
          <p className="text-2xl font-bold">{c.woNo}</p>
          <p className="text-base">
            {c.pjoNo} · {c.fatherCode}
          </p>
          <p className="text-sm text-muted">
            Finished {Number(c.finishedQty).toLocaleString()} · offered {Number(c.offeredQty).toLocaleString()} · available {Number(c.availableQty).toLocaleString()} {c.uom}
          </p>
        </div>
        <QtyInput label="Quantity to inspect *" value={qty} onChange={setQty} unit={c.uom} autoFocus />
        <QtyInput label="Sample size" value={sample} onChange={setSample} unit={c.uom} />
        {error && <Alert tone="danger">{error}</Alert>}
        <BigButton variant="primary" loading={busy} disabled={!(Number(qty) > 0) || Number(qty) > Number(c.availableQty)} onClick={() => void checkIn()}>
          Check In to OQC
        </BigButton>
        {Number(qty) > Number(c.availableQty) && <Alert tone="warning">Only {Number(c.availableQty).toLocaleString()} {c.uom} are available.</Alert>}
      </div>
    );
  return (
    <div className="space-y-4">
      <BackLink onClick={onBack} />
      <div className="rounded-xl border-2 border-line bg-surface p-3">
        <p className="mb-2 text-base font-semibold">Scan the Job Order</p>
        <ScanBox label="Job Order / PJO no." placeholder="e.g. WO-…" onScan={scan} />
      </div>
      {error && <Alert tone="danger">{error}</Alert>}
      <section className="space-y-2">
        <p className="text-sm font-semibold tracking-wide text-muted uppercase">{term ? `Matches for “${term}”` : "Finished, not yet offered"}</p>
        {candidates.isPending && <Spinner />}
        {candidates.data && !candidates.data.length && <p className="rounded-xl bg-surface-2 p-4 text-base text-muted">No Job Order with finished labels to offer{term ? " matches" : ""}.</p>}
        {candidates.data?.map((x) => (
          <button
            key={x.id}
            onClick={() => {
              setPick(x.id);
              setQty(x.availableQty);
            }}
            className="flex min-h-16 w-full items-center gap-3 rounded-xl border-2 border-line bg-surface p-3 text-left active:bg-surface-2"
          >
            <span className="min-w-0 flex-1">
              <span className="block text-lg font-semibold">{x.woNo}</span>
              <span className="block truncate text-sm text-muted">
                {x.pjoNo} · {x.fatherCode} · {Number(x.availableQty).toLocaleString()} {x.uom} available
              </span>
            </span>
            <ChevronRight className="size-6 text-muted" />
          </button>
        ))}
      </section>
    </div>
  );
}

function OqcDone({ inspId, onDone }: { inspId: string; onDone: () => void }) {
  const insp = useInspectionDetail(inspId);
  const i = insp.data;
  if (!i) return <Centered><Spinner className="size-8" /></Centered>;
  const ok = ["PASSED", "ACCEPTED"].includes(i.status);
  return <ResultPanel ok={ok || i.status === "PENDING_DISPOSITION" || i.status === "REWORK"} title={ok ? "Lot released" : i.status === "PENDING_DISPOSITION" ? "Lot on hold" : i.status === "REWORK" ? "Sent to rework" : "Lot rejected"} lines={[`${i.inspNo} · ${i.workOrder?.woNo ?? ""}`, statusLine(i), ...(ok ? ["Ready for shipping labels."] : [])]} onDone={onDone} />;
}

// ---------------------------------------------------------------------------
// Shared: inspect (Check Out) and decide
// ---------------------------------------------------------------------------
const useInspectionDetail = (id: string) => useQuery({ queryKey: ["qc", "inspection", id], queryFn: () => api.get<InspectionDetail>(`/qc/inspections/${id}`) });
const acceptedQty = (i: InspectionDetail) => (i.status === "PASSED" ? Number(i.goodQty ?? i.qty) : i.status === "ACCEPTED" ? Number(i.qty) : 0);
const statusLine = (i: InspectionDetail) =>
  ({
    PASSED: `Passed · good ${Number(i.goodQty ?? i.qty).toLocaleString()} ${i.uom}${Number(i.rejectQty ?? 0) ? ` · reject ${Number(i.rejectQty).toLocaleString()}` : ""}`,
    ACCEPTED: `Accepted (${i.disposition ? DISPOSITION_LABEL[i.disposition] : ""})`,
    PENDING_DISPOSITION: "Failed – waiting for a disposition by QC",
    REJECTED: "Rejected",
    RETURNED: "Return to supplier",
    REWORK: "Rework, then reinspect",
    IN_INSPECTION: "In inspection",
  })[i.status];

function InspectScreen({ type, inspId, onDone }: { type: QcType; inspId: string; onDone: () => void }) {
  const qc = useQueryClient();
  const insp = useInspectionDetail(inspId);
  const defects = useDefects({ status: "ACTIVE", type });
  const [results, setResults] = useState<Record<number, { pass: boolean | null; value: string }>>({});
  const [found, setFound] = useState<Record<string, number>>({});
  const [rejectQty, setRejectQty] = useState("");
  const [remarks, setRemarks] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const i = insp.data;
  const checkedOut = !!i && i.status !== "IN_INSPECTION";
  useEffect(() => {
    if (checkedOut) onDone();
  }, [checkedOut, onDone]);
  if (insp.error) return <ErrorPanel message={(insp.error as Error).message} onRetry={() => void insp.refetch()} />;
  if (!i || checkedOut) return <Centered><Spinner className="size-8" /></Centered>;
  const missing = i.checks.filter((c, n) => c.required && (c.kind === "MEASURE" ? !results[n]?.value : results[n]?.pass == null)).length;
  const measurePass = (n: number, v: string) => {
    const c = i.checks[n]!;
    const x = Number(v);
    if (!v || Number.isNaN(x)) return null;
    return (c.min == null || x >= c.min) && (c.max == null || x <= c.max);
  };
  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      await api.post(`/qc/inspections/${inspId}/check-out`, {
        results: i.checks.map((c, n) => {
          const r = results[n];
          return c.kind === "MEASURE" ? { index: n, value: r?.value ? Number(r.value) : null, pass: r?.value ? measurePass(n, r.value) : null } : { index: n, pass: r?.pass ?? null };
        }),
        rejectQty: rejectQty || null,
        defects: Object.entries(found)
          .filter(([, q]) => q > 0)
          .map(([defectCodeId, q]) => ({ defectCodeId, qty: String(q) })),
        remarks,
      });
      await qc.invalidateQueries({ queryKey: ["qc"] });
      onDone();
    } catch (e) {
      setError(msg(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="space-y-4">
      <div className="rounded-xl bg-surface-2 p-3">
        <p className="text-xl font-bold">{i.inspNo}</p>
        <p className="text-base">{type === "IQC" ? `${i.part?.code} · lot ${i.lotRef}` : `${i.workOrder?.woNo} · ${i.workOrder?.fatherCode}`}</p>
        <p className="text-sm text-muted">
          {Number(i.qty).toLocaleString()} {i.uom}
          {i.sampleSize ? ` · sample ${Number(i.sampleSize).toLocaleString()}` : ""}
          {i.template ? ` · ${i.template.code}` : ""}
        </p>
      </div>

      <section className="space-y-2">
        <h2 className="text-sm font-semibold tracking-wide text-muted uppercase">Checks {i.checks.length ? `(${i.checks.length - missing}/${i.checks.length})` : ""}</h2>
        {!i.checks.length && <p className="rounded-xl bg-surface-2 p-3 text-base text-muted">No template checks – record defects and the reject quantity.</p>}
        {i.checks.map((c, n) => {
          const r = results[n];
          const setR = (patch: Partial<{ pass: boolean | null; value: string }>) => setResults((m) => ({ ...m, [n]: { pass: null, value: "", ...m[n], ...patch } }));
          const mp = c.kind === "MEASURE" && r?.value ? measurePass(n, r.value) : null;
          return (
            <div key={n} className="rounded-xl border-2 border-line bg-surface p-3">
              <p className="text-base font-semibold">
                {c.label}
                {c.required && <span className="text-danger"> *</span>}
              </p>
              {(c.target || c.min != null || c.max != null) && (
                <p className="text-sm text-muted">
                  {c.target && `Target ${c.target}`} {c.min != null && `min ${c.min}`} {c.max != null && `max ${c.max}`} {c.unit}
                </p>
              )}
              {c.kind === "MEASURE" ? (
                <div className="mt-2 flex items-center gap-2">
                  <input value={r?.value ?? ""} onChange={(e) => setR({ value: e.target.value.replace(/[^\d.-]/g, "") })} inputMode="decimal" aria-label={c.label} className="h-14 min-w-0 flex-1 rounded-xl border border-line bg-surface px-4 text-2xl font-semibold tabular-nums focus:border-focus focus:ring-2 focus:ring-focus/30 focus:outline-none" />
                  <span className="w-12 text-base text-muted">{c.unit}</span>
                  {mp != null && <span className={cn("rounded-lg px-2 py-1 text-sm font-bold", mp ? "bg-success-soft text-success" : "bg-danger-soft text-danger")}>{mp ? "OK" : "OUT"}</span>}
                </div>
              ) : (
                <div className="mt-2 grid grid-cols-2 gap-2">
                  <button type="button" aria-pressed={r?.pass === true} onClick={() => setR({ pass: true })} className={cn("flex min-h-14 items-center justify-center gap-2 rounded-xl border-2 text-lg font-bold", r?.pass === true ? "border-success bg-success text-white" : "border-line bg-surface text-success")}>
                    <Check className="size-6" /> Pass
                  </button>
                  <button type="button" aria-pressed={r?.pass === false} onClick={() => setR({ pass: false })} className={cn("flex min-h-14 items-center justify-center gap-2 rounded-xl border-2 text-lg font-bold", r?.pass === false ? "border-danger bg-danger text-white" : "border-line bg-surface text-danger")}>
                    <X className="size-6" /> Fail
                  </button>
                </div>
              )}
            </div>
          );
        })}
      </section>

      <section className="space-y-2">
        <h2 className="text-sm font-semibold tracking-wide text-muted uppercase">Defects found</h2>
        <div className="grid gap-2">
          {defects.data?.map((d) => {
            const q = found[d.id] ?? 0;
            const set = (v: number) => setFound((m) => ({ ...m, [d.id]: Math.max(0, v) }));
            return (
              <div key={d.id} className={cn("flex items-center gap-2 rounded-xl border-2 p-2", q ? "border-danger bg-danger-soft" : "border-line bg-surface")}>
                <span className="min-w-0 flex-1">
                  <span className="block text-base font-semibold">{d.name}</span>
                  <span className="text-xs text-muted">
                    {d.code} · {d.severity.toLowerCase()}
                  </span>
                </span>
                <button type="button" onClick={() => set(q - 1)} disabled={!q} className="grid size-12 place-items-center rounded-lg border border-line bg-surface disabled:opacity-40" aria-label={`Less ${d.name}`}>
                  <Minus className="size-5" />
                </button>
                <span className="w-10 text-center text-xl font-bold tabular-nums">{q}</span>
                <button type="button" onClick={() => set(q + 1)} className="grid size-12 place-items-center rounded-lg border border-line bg-surface" aria-label={`More ${d.name}`}>
                  <Plus className="size-5" />
                </button>
              </div>
            );
          })}
        </div>
      </section>

      <QtyInput label="Reject quantity" value={rejectQty} onChange={setRejectQty} unit={i.uom} />
      <TextInput label="Remarks" value={remarks} onChange={setRemarks} />
      {missing > 0 && <Alert tone="info">{missing} required check{missing === 1 ? "" : "s"} still to record.</Alert>}
      {error && <Alert tone="danger">{error}</Alert>}
      <BigButton variant="primary" loading={busy} disabled={missing > 0} onClick={() => void submit()}>
        Check Out
      </BigButton>
    </div>
  );
}

function DecideScreen({ type, inspId, onNext, nextLabel }: { type: QcType; inspId: string; onNext: (accepted: number) => void; nextLabel: (accepted: number) => string }) {
  const { can } = useAuth();
  const qc = useQueryClient();
  const insp = useInspectionDetail(inspId);
  const [disposition, setDisposition] = useState<Disposition | "">("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const i = insp.data;
  if (!i) return <Centered><Spinner className="size-8" /></Centered>;
  const pending = i.status === "PENDING_DISPOSITION";
  const mayDispose = can(type === "IQC" ? "qc.iqc.disposition" : "qc.oqc.disposition");
  const pass = i.result === "PASS";
  const dispose = async () => {
    setBusy(true);
    setError(null);
    try {
      await api.post(`/qc/inspections/${inspId}/disposition`, { disposition, note });
      await qc.invalidateQueries({ queryKey: ["qc"] });
      await insp.refetch();
    } catch (e) {
      setError(msg(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="space-y-4">
      <div className={cn("rounded-2xl p-5 text-center", pass ? "bg-success text-white" : "bg-danger text-white")}>
        <p className="text-4xl font-black tracking-wide">{pass ? "PASS" : "FAIL"}</p>
        <p className="mt-1 text-lg">{i.inspNo}</p>
        <p className="text-base opacity-90">{statusLine(i)}</p>
      </div>
      {i.defects.length > 0 && (
        <ul className="rounded-xl bg-surface-2 p-3 text-base">
          {i.defects.map((d) => (
            <li key={d.id}>
              {d.name} × {Number(d.qty).toLocaleString()}
            </li>
          ))}
        </ul>
      )}
      {pending &&
        (mayDispose ? (
          <section className="space-y-2">
            <h2 className="text-sm font-semibold tracking-wide text-muted uppercase">Disposition</h2>
            <div className="grid gap-2">
              {DISPOSITIONS[type].map((d) => (
                <button key={d} type="button" aria-pressed={disposition === d} onClick={() => setDisposition(d)} className={cn("min-h-14 rounded-xl border-2 px-3 text-left text-lg font-semibold", disposition === d ? "border-warning bg-warning-soft text-warning" : "border-line bg-surface")}>
                  {DISPOSITION_LABEL[d]}
                </button>
              ))}
            </div>
            <TextInput label="Reason *" value={note} onChange={setNote} />
            {error && <Alert tone="danger">{error}</Alert>}
            <BigButton variant="primary" loading={busy} disabled={!disposition || !note.trim()} onClick={() => void dispose()}>
              Save disposition
            </BigButton>
          </section>
        ) : (
          <Alert tone="warning">The lot is on hold. A QC supervisor decides the disposition.</Alert>
        ))}
      {(!pending || !mayDispose) && (
        <BigButton variant={pending ? undefined : "primary"} onClick={() => onNext(acceptedQty(i))}>
          {pending ? "Finish (on hold)" : nextLabel(acceptedQty(i))}
        </BigButton>
      )}
    </div>
  );
}
