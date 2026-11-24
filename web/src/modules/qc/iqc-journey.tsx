import { useQuery, useQueryClient } from "@tanstack/react-query";
import { CheckCircle2, Plus, Trash2, XCircle } from "lucide-react";
import { useState } from "react";
import { Link, useNavigate } from "react-router";
import { PageHeader } from "@/components/common";
import { Journey, NextJourney, type JourneyStep } from "@/components/journey";
import { StatusBadge } from "@/components/status";
import { Button, Card, Field, Input, Select, Textarea } from "@/components/ui";
import { api, ApiError, qs } from "@/lib/api";
import { useAuth } from "@/stores/auth";
import { DISPOSITION_LABEL, DISPOSITIONS, useDefects, useInspectionTemplates, type CheckResult, type Disposition, type InspectionDetail } from "./api";

/**
 * IQC receiving, start to end:
 *   1 Lot      part, lot / roll no., DO, supplier, quantity → Check In (lot on QC hold)
 *   2 Inspect  template checks, defects, reject quantity → Check Out
 *   3 Decide   passed = released; failed = supervisor disposition
 *   4 Store    put the accepted quantity into a location (manual Location Qty)
 *   Done       next: issue it on an MRS
 * Each step saves as it goes (Check In, Check Out, disposition, location).
 */
type StepId = "lot" | "inspect" | "decide" | "store" | "done";
const ORDER: StepId[] = ["lot", "inspect", "decide", "store", "done"];
interface PartOption {
  id: string;
  code: string;
  description: string;
  uom: string;
  category: string | null;
}

const msg = (e: unknown) => (e instanceof ApiError ? (e.issues[0]?.message ?? e.message) : e instanceof Error ? e.message : String(e));

export function IqcReceivingJourney() {
  const { can } = useAuth();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [step, setStep] = useState<StepId>("lot");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // 1
  const [search, setSearch] = useState("");
  const parts = useQuery({ queryKey: ["qc", "part-lookup", search], queryFn: () => api.get<PartOption[]>(`/materials/lookup${qs({ q: search })}`) });
  const templates = useInspectionTemplates({ type: "IQC", status: "ACTIVE" });
  const [lot, setLot] = useState({ materialId: "", lotRef: "", supplierName: "", deliveryRef: "", qty: "", sampleSize: "", templateId: "" });
  const part = parts.data?.find((p) => p.id === lot.materialId);
  // 2
  const [inspId, setInspId] = useState<string | null>(null);
  const insp = useQuery({ queryKey: ["qc", "inspection", inspId], queryFn: () => api.get<InspectionDetail>(`/qc/inspections/${inspId}`), enabled: !!inspId });
  const defects = useDefects({ status: "ACTIVE", type: "IQC" });
  const [results, setResults] = useState<Record<number, { pass: boolean | null; value: string; note: string }>>({});
  const [found, setFound] = useState<{ defectCodeId: string; qty: string }[]>([]);
  const [rejectQty, setRejectQty] = useState("");
  // 3
  const [disposition, setDisposition] = useState<Disposition | "">("");
  const [note, setNote] = useState("");
  // 4
  const [loc, setLoc] = useState({ warehouseCode: "", locationCode: "", shelfLocation: "" });
  const [stored, setStored] = useState<string | null>(null);

  const i = insp.data;
  const accepted = i ? (i.status === "PASSED" ? Number(i.goodQty ?? i.qty) : i.status === "ACCEPTED" ? Number(i.qty) : 0) : 0;
  const index = ORDER.indexOf(step);
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

  const checkIn = () =>
    run(async () => {
      if (!lot.materialId) throw new Error("Choose the part");
      const r = await api.post<{ id: string; inspNo: string }>("/qc/iqc", { ...lot, templateId: lot.templateId || null, sampleSize: lot.sampleSize || null });
      setInspId(r.id);
      setStep("inspect");
    });
  const checkOut = () =>
    run(async () => {
      const checks = i?.checks ?? [];
      await api.post(`/qc/inspections/${inspId}/check-out`, {
        results: checks.map((_, n) => ({ index: n, pass: results[n]?.pass ?? null, value: results[n]?.value ? Number(results[n]!.value) : null, note: results[n]?.note || null })),
        rejectQty: rejectQty || null,
        defects: found.filter((d) => d.defectCodeId),
      });
      await insp.refetch();
      setStep("decide");
    });
  const dispose = () =>
    run(async () => {
      if (!disposition) throw new Error("Choose a disposition");
      await api.post(`/qc/inspections/${inspId}/disposition`, { disposition, note });
      await insp.refetch();
    });
  const store = () =>
    run(async () => {
      await api.post(`/materials/${lot.materialId}/locations`, { ...loc, lotNo: lot.lotRef, qty: accepted });
      setStored(`${accepted.toLocaleString()} ${i?.uom} in ${loc.warehouseCode.toUpperCase()} / ${loc.locationCode.toUpperCase()}`);
      setStep("done");
    });

  const steps: JourneyStep<StepId>[] = [
    { id: "lot", label: "Lot", hint: "Check In", state: inspId ? "done" : undefined },
    { id: "inspect", label: "Inspect", hint: "Checks & defects", state: i && i.status !== "IN_INSPECTION" ? "done" : undefined },
    { id: "decide", label: "Decide", hint: "Release / disposition", state: i?.status === "PENDING_DISPOSITION" ? "error" : i && ["PASSED", "ACCEPTED", "REJECTED", "RETURNED"].includes(i.status) ? "done" : undefined },
    { id: "store", label: "Store", hint: "Location Qty", state: stored ? "done" : i && !accepted && i.status !== "IN_INSPECTION" && i.status !== "PENDING_DISPOSITION" ? "skipped" : undefined },
    { id: "done", label: "Done", hint: "Ready to issue", state: step === "done" ? "done" : undefined },
  ];

  return (
    <>
      <PageHeader title="Receive a lot (IQC)" description="From a delivered lot to inspected, released material in its location." crumbs={[{ label: "QC" }, { label: "IQC Check In/Check Out", to: "/qc/iqc-check-in-out" }, { label: "Receive" }]} />
      <Card className="mb-4">
        <Journey steps={steps} current={step} />
      </Card>
      {error && <p className="mb-4 rounded-md bg-danger-soft p-3 text-sm text-danger">{error}</p>}

      {step === "lot" && (
        <Card title="1. The lot received">
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Find part" className="sm:col-span-2">{(p) => <Input {...p} value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Part code or description" autoFocus />}</Field>
            <Field label="Part" required className="sm:col-span-2">
              {(p) => (
                <Select {...p} value={lot.materialId} onChange={(e) => setLot((l) => ({ ...l, materialId: e.target.value }))}>
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
            <Field label="Lot / roll no." required>{(p) => <Input {...p} value={lot.lotRef} onChange={(e) => setLot((l) => ({ ...l, lotRef: e.target.value }))} />}</Field>
            <Field label={`Quantity${part ? ` (${part.uom})` : ""}`} required>{(p) => <Input {...p} inputMode="decimal" value={lot.qty} onChange={(e) => setLot((l) => ({ ...l, qty: e.target.value }))} />}</Field>
            <Field label="Delivery order / GRN">{(p) => <Input {...p} value={lot.deliveryRef} onChange={(e) => setLot((l) => ({ ...l, deliveryRef: e.target.value }))} />}</Field>
            <Field label="Supplier" hint="Empty = the part's supplier.">{(p) => <Input {...p} value={lot.supplierName} onChange={(e) => setLot((l) => ({ ...l, supplierName: e.target.value }))} />}</Field>
            <Field label="Sample size" hint="Empty = 100 % inspection.">{(p) => <Input {...p} inputMode="decimal" value={lot.sampleSize} onChange={(e) => setLot((l) => ({ ...l, sampleSize: e.target.value }))} />}</Field>
            <Field label="Template" hint="Empty = the part category's default.">
              {(p) => (
                <Select {...p} value={lot.templateId} onChange={(e) => setLot((l) => ({ ...l, templateId: e.target.value }))}>
                  <option value="">Default</option>
                  {templates.data?.map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.code} – {t.name}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
          </div>
        </Card>
      )}

      {step === "inspect" && i && (
        <Card title={`2. Inspect ${i.inspNo}`}>
          <p className="mb-3 text-sm text-muted">
            {i.part?.code} · lot {i.lotRef} · {i.qty} {i.uom} {i.sampleSize ? `(sample ${i.sampleSize})` : "(100 %)"}
          </p>
          {i.checks.length === 0 && <p className="mb-3 text-sm text-muted">No template checks: record defects and the reject quantity.</p>}
          <ul className="space-y-3">
            {i.checks.map((c: CheckResult, n) => {
              const r = results[n] ?? { pass: null, value: "", note: "" };
              const set = (patch: Partial<typeof r>) => setResults((x) => ({ ...x, [n]: { ...r, ...patch } }));
              const ok = c.kind === "MEASURE" ? (r.value === "" ? null : (c.min == null || Number(r.value) >= c.min) && (c.max == null || Number(r.value) <= c.max)) : r.pass;
              return (
                <li key={n} className="rounded-lg border border-line p-3">
                  <div className="flex items-start gap-2">
                    <p className="flex-1 text-sm font-medium">
                      {c.label}
                      {c.required && <span className="text-danger"> *</span>}
                      <span className="block text-xs font-normal text-muted">{c.kind === "MEASURE" ? `${c.min ?? "…"} – ${c.max ?? "…"} ${c.unit ?? ""}` : (c.target ?? "")}</span>
                    </p>
                    {ok === true && <CheckCircle2 className="size-5 text-success" />}
                    {ok === false && <XCircle className="size-5 text-danger" />}
                  </div>
                  <div className="mt-2 flex flex-wrap gap-2">
                    {c.kind === "MEASURE" ? (
                      <Input inputMode="decimal" value={r.value} onChange={(e) => set({ value: e.target.value })} placeholder="Value" className="w-full sm:w-40" aria-label={`${c.label} value`} />
                    ) : (
                      <>
                        <Button size="sm" variant={r.pass === true ? "primary" : "secondary"} onClick={() => set({ pass: true })}>
                          Pass
                        </Button>
                        <Button size="sm" variant={r.pass === false ? "danger" : "secondary"} onClick={() => set({ pass: false })}>
                          Fail
                        </Button>
                      </>
                    )}
                    <Input value={r.note} onChange={(e) => set({ note: e.target.value })} placeholder="Note" className="min-w-0 flex-1" aria-label={`${c.label} note`} />
                  </div>
                </li>
              );
            })}
          </ul>
          <p className="mt-4 mb-2 text-sm font-semibold">Defects found</p>
          {found.map((d, n) => (
            <div key={n} className="mb-2 grid gap-2 sm:grid-cols-[1fr_6rem_auto]">
              <Select value={d.defectCodeId} onChange={(e) => setFound((l) => l.map((x, k) => (k === n ? { ...x, defectCodeId: e.target.value } : x)))} aria-label="Defect">
                <option value="">Choose defect…</option>
                {defects.data?.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.code} – {c.name} ({c.severity.toLowerCase()})
                  </option>
                ))}
              </Select>
              <Input inputMode="decimal" value={d.qty} onChange={(e) => setFound((l) => l.map((x, k) => (k === n ? { ...x, qty: e.target.value } : x)))} aria-label="Quantity" />
              <Button variant="ghost" icon={<Trash2 className="size-4" />} aria-label="Remove defect" onClick={() => setFound((l) => l.filter((_, k) => k !== n))} />
            </div>
          ))}
          <Button size="sm" icon={<Plus className="size-4" />} onClick={() => setFound((l) => [...l, { defectCodeId: "", qty: "1" }])}>
            Add defect
          </Button>
          <div className="mt-4 max-w-xs">
            <Field label={`Reject quantity (${i.uom})`} hint="Any reject fails the lot.">{(p) => <Input {...p} inputMode="decimal" value={rejectQty} onChange={(e) => setRejectQty(e.target.value)} placeholder="0" />}</Field>
          </div>
        </Card>
      )}

      {step === "decide" && i && (
        <Card title="3. Decision">
          <p className="mb-3 flex items-center gap-2 text-sm">
            {i.inspNo} <StatusBadge kind="qc" value={i.status} />
          </p>
          {i.status === "PASSED" && <p className="text-sm text-success">Passed: {Number(i.goodQty ?? i.qty).toLocaleString()} {i.uom} released for use.</p>}
          {i.status === "ACCEPTED" && <p className="text-sm">Accepted as is by {i.dispositionBy}: {i.dispositionNote}</p>}
          {(i.status === "REJECTED" || i.status === "RETURNED") && <p className="text-sm text-danger">{DISPOSITION_LABEL[i.disposition!]}: {i.dispositionNote}. Nothing goes into stock.</p>}
          {i.status === "PENDING_DISPOSITION" &&
            (can("qc.iqc.disposition") ? (
              <div className="space-y-3">
                <p className="text-sm text-warning">The lot failed. Decide what happens to it.</p>
                <div className="grid gap-2 sm:grid-cols-3">
                  {DISPOSITIONS.IQC.map((d) => (
                    <label key={d} className={`flex cursor-pointer items-center gap-2 rounded-lg border p-3 text-sm ${disposition === d ? "border-primary bg-primary-soft" : "border-line"}`}>
                      <input type="radio" checked={disposition === d} onChange={() => setDisposition(d)} />
                      {DISPOSITION_LABEL[d]}
                    </label>
                  ))}
                </div>
                <Field label="Reason" required>{(p) => <Textarea {...p} rows={2} value={note} onChange={(e) => setNote(e.target.value)} />}</Field>
                <Button variant="primary" loading={busy} onClick={() => void dispose()}>
                  Confirm disposition
                </Button>
              </div>
            ) : (
              <p className="text-sm text-warning">The lot failed and waits for a QC supervisor's disposition. It stays on hold.</p>
            ))}
        </Card>
      )}

      {step === "store" && i && (
        <Card title="4. Put into stock">
          {accepted > 0 ? (
            <>
              <p className="mb-3 text-sm text-muted">
                {accepted.toLocaleString()} {i.uom} of lot {i.lotRef} is released. Record where it is kept (Location Qty, keyed in by hand until the WMS integration).
              </p>
              <div className="grid gap-4 sm:grid-cols-3">
                <Field label="Warehouse code" required>{(p) => <Input {...p} value={loc.warehouseCode} onChange={(e) => setLoc((l) => ({ ...l, warehouseCode: e.target.value }))} />}</Field>
                <Field label="Location code" required>{(p) => <Input {...p} value={loc.locationCode} onChange={(e) => setLoc((l) => ({ ...l, locationCode: e.target.value }))} />}</Field>
                <Field label="Shelf">{(p) => <Input {...p} value={loc.shelfLocation} onChange={(e) => setLoc((l) => ({ ...l, shelfLocation: e.target.value }))} />}</Field>
              </div>
            </>
          ) : (
            <p className="text-sm text-muted">Nothing was released, so nothing goes into stock.</p>
          )}
        </Card>
      )}

      {step === "done" && (
        <div className="grid gap-4 lg:grid-cols-2">
          <Card title="Lot received">
            <ul className="space-y-1 text-sm">
              {i && (
                <li>
                  Inspection{" "}
                  <Link to={`/qc/iqc-check-in-out/${i.id}`} className="font-medium text-primary hover:underline">
                    {i.inspNo}
                  </Link>{" "}
                  <StatusBadge kind="qc" value={i.status} />
                </li>
              )}
              {stored && <li>Stored: {stored}</li>}
            </ul>
            <div className="mt-4 flex flex-wrap gap-2">
              <Button variant="primary" onClick={() => window.location.reload()}>
                Receive another lot
              </Button>
              <Button onClick={() => navigate("/qc/iqc-check-in-out")}>Back to IQC</Button>
            </div>
          </Card>
          <NextJourney
            items={[
              { label: "Issue it to production", detail: "The store issues it on the Job Order's MRS by this lot no. (required when the part needs IQC).", action: <Link to="/planning/material-requisition-sheet/issue" className="text-xs text-primary hover:underline">Issue material</Link> },
              { label: "Check the stock", detail: "Location Qty on the part in Part Master.", action: lot.materialId ? <Link to={`/master-data/part-master/${lot.materialId}?tab=location`} className="text-xs text-primary hover:underline">Part</Link> : undefined },
            ]}
          />
        </div>
      )}

      {step !== "done" && (
        <div className="sticky bottom-0 z-10 mt-4 flex flex-wrap items-center gap-2 rounded-lg border border-line bg-surface px-4 py-3 shadow-sm">
          <span className="text-xs text-muted">
            Step {index + 1} of 4 · {steps[index]!.label}
          </span>
          <div className="flex-1" />
          {step === "lot" && (
            <Button variant="primary" loading={busy} disabled={!can("qc.iqc.inspect")} onClick={() => void checkIn()}>
              Check In and inspect
            </Button>
          )}
          {step === "inspect" && (
            <Button variant="primary" loading={busy} onClick={() => void checkOut()}>
              Check Out
            </Button>
          )}
          {step === "decide" && i && i.status !== "PENDING_DISPOSITION" && (
            <Button variant="primary" onClick={() => setStep(accepted > 0 && can("bom.material.manage") ? "store" : "done")}>
              {accepted > 0 && can("bom.material.manage") ? "Next: Store" : "Finish"}
            </Button>
          )}
          {step === "decide" && i?.status === "PENDING_DISPOSITION" && !can("qc.iqc.disposition") && <Button onClick={() => setStep("done")}>Finish (on hold)</Button>}
          {step === "store" && (
            <>
              <Button onClick={() => setStep("done")}>Skip</Button>
              {accepted > 0 && (
                <Button variant="primary" loading={busy} onClick={() => void store()}>
                  Save location
                </Button>
              )}
            </>
          )}
        </div>
      )}
    </>
  );
}
