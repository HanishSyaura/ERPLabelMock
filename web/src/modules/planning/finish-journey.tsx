import { useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, CheckCircle2, ExternalLink, XCircle } from "lucide-react";
import { useState } from "react";
import { Link, useParams } from "react-router";
import { ErrorState, LoadingState, PageHeader } from "@/components/common";
import { Journey, NextJourney, type JourneyStep } from "@/components/journey";
import { StatusBadge } from "@/components/status";
import { Button, Card, Input, Select } from "@/components/ui";
import { api, ApiError, qs } from "@/lib/api";
import { useAuth } from "@/stores/auth";
import { useLabelTemplates, useReadyLots, type InspectionRow, type OqcCandidate } from "@/modules/qc/api";
import { CompleteDialog } from "./completion-pages";
import { useCompletion } from "./ops-api";

/**
 * Finish a Production Job Order, start to end, on one workbench:
 *   1 Job Orders  confirm each finished Job Order complete
 *   2 OQC         offer finished labels to QC; inspect on the OQC page
 *   3 Labels      carton labels for the quantity QC released
 *   4 Close       the completion check, then complete the order
 * Each step shows the order's real state and turns green when it is done.
 */
type StepId = "jobs" | "oqc" | "labels" | "close";
const msg = (e: unknown) => (e instanceof ApiError ? (e.issues[0]?.message ?? e.message) : String(e));

export function FinishOrderJourney() {
  const { id = "" } = useParams();
  const { can } = useAuth();
  const qc = useQueryClient();
  const check = useCompletion(id);
  const pjoNo = check.data?.pjo.pjoNo ?? "";
  const lots = useQuery({ queryKey: ["qc", "inspections", "OQC", "pjo", pjoNo], queryFn: () => api.list<InspectionRow>(`/qc/oqc${qs({ view: "all", q: pjoNo, pageSize: 100 })}`), enabled: !!pjoNo });
  const candidates = useQuery({ queryKey: ["qc", "oqc-candidates", pjoNo], queryFn: () => api.get<OqcCandidate[]>(`/qc/oqc-candidates${qs({ q: pjoNo })}`), enabled: !!pjoNo && can("qc.oqc.inspect") });
  const ready = useReadyLots(can("qc.label.generate"));
  const templates = useLabelTemplates("ACTIVE");
  const [step, setStep] = useState<StepId>("jobs");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [oqcQty, setOqcQty] = useState<Record<string, string>>({});
  const [label, setLabel] = useState<Record<string, { templateId: string; perCarton: string }>>({});
  const [closing, setClosing] = useState(false);

  if (check.isPending) return <LoadingState />;
  if (check.error) return <ErrorState error={check.error} onRetry={() => void check.refetch()} />;
  const c = check.data;
  const refresh = () => Promise.all([qc.invalidateQueries({ queryKey: ["planning"] }), qc.invalidateQueries({ queryKey: ["qc"] })]);
  const act = async (key: string, fn: () => Promise<unknown>) => {
    setBusy(key);
    setError(null);
    try {
      await fn();
      await refresh();
    } catch (e) {
      setError(msg(e));
    } finally {
      setBusy(null);
    }
  };

  const openJobs = c.jobOrders.filter((w) => w.status !== "COMPLETED" && w.status !== "CANCELLED");
  const myLots = lots.data?.data ?? [];
  const myCandidates = (candidates.data ?? []).filter((x) => x.pjoNo === c.pjo.pjoNo);
  const pendingLots = myLots.filter((l) => l.status === "IN_INSPECTION" || l.status === "PENDING_DISPOSITION" || (l.status === "REWORK" && !l.reinspection));
  const myReady = (ready.data ?? []).filter((r) => r.pjoNo === c.pjo.pjoNo);
  const closed = c.pjo.status === "CLOSED";
  const done: Record<StepId, boolean> = {
    jobs: openJobs.length === 0 && c.jobOrders.length > 0,
    oqc: myLots.length > 0 && pendingLots.length === 0 && myCandidates.length === 0,
    labels: myLots.some((l) => l.status === "PASSED" || l.status === "ACCEPTED") && myReady.length === 0,
    close: closed,
  };
  const steps: JourneyStep<StepId>[] = [
    { id: "jobs", label: "Job Orders", hint: `${c.jobOrders.length - openJobs.length} / ${c.jobOrders.length} complete`, state: done.jobs ? "done" : undefined },
    { id: "oqc", label: "OQC", hint: `${myLots.length} lot${myLots.length === 1 ? "" : "s"}`, state: done.oqc ? "done" : pendingLots.some((l) => l.status === "PENDING_DISPOSITION") ? "error" : undefined },
    { id: "labels", label: "Labels", hint: myReady.length ? `${myReady.length} lot(s) to label` : "Carton labels", state: done.labels ? "done" : undefined },
    { id: "close", label: "Close", hint: closed ? "Completed" : "Completion check", state: closed ? "done" : c.blockers.length ? undefined : undefined },
  ];

  return (
    <>
      <PageHeader
        title={`Finish ${c.pjo.pjoNo}`}
        description={`${c.pjo.fatherCode} · ${c.pjo.labelDescription} · ${c.pjo.orderQty} ${c.pjo.uom} · good output ${c.goodOutput}`}
        crumbs={[{ label: "Planning" }, { label: "Production Job Order", to: "/planning/production-job-order" }, { label: c.pjo.pjoNo, to: `/planning/production-job-order/${c.pjo.id}` }, { label: "Finish" }]}
      />
      <Card className="mb-4">
        <Journey steps={steps} current={step} onSelect={setStep} />
      </Card>
      {error && <p className="mb-4 rounded-md bg-danger-soft p-3 text-sm text-danger">{error}</p>}

      {step === "jobs" && (
        <Card title="1. Complete the Job Orders">
          <p className="mb-3 text-sm text-muted">Confirm a Job Order complete when its last process is finished. A shortfall needs a note.</p>
          <ul className="divide-y divide-line">
            {c.jobOrders.map((w) => {
              const open = w.status !== "COMPLETED" && w.status !== "CANCELLED";
              const short = Number(w.finalGood) < Number(w.quantity);
              return (
                <li key={w.id} className="flex flex-wrap items-center gap-3 py-2.5 text-sm">
                  <Link to={`/planning/job-order/${w.id}`} className="font-medium text-primary hover:underline">
                    {w.woNo}
                  </Link>
                  <span className="tabular-nums">
                    final good {w.finalGood} / {w.quantity}
                  </span>
                  <StatusBadge kind="wo" value={w.status} />
                  <span className="flex-1" />
                  {open && can("planning.jo.complete") && (
                    <>
                      {short && <Input value={notes[w.id] ?? ""} onChange={(e) => setNotes((n) => ({ ...n, [w.id]: e.target.value }))} placeholder="Note (shortfall)" className="w-full sm:w-56" aria-label={`${w.woNo} note`} />}
                      <Button size="sm" variant="primary" loading={busy === w.id} onClick={() => void act(w.id, () => api.post(`/planning/work-orders/${w.id}/complete`, { note: notes[w.id] || null }))}>
                        Complete
                      </Button>
                    </>
                  )}
                </li>
              );
            })}
          </ul>
        </Card>
      )}

      {step === "oqc" && (
        <Card title="2. Outgoing quality (OQC)">
          {myCandidates.length > 0 && (
            <div className="mb-4 rounded-md border border-line p-3">
              <p className="mb-2 text-sm font-semibold">Finished and not yet offered</p>
              <ul className="space-y-2">
                {myCandidates.map((x) => (
                  <li key={x.id} className="flex flex-wrap items-center gap-2 text-sm">
                    <span className="font-medium">{x.woNo}</span>
                    <span className="text-muted">
                      {x.availableQty} {x.uom} waiting
                    </span>
                    <span className="flex-1" />
                    <Input inputMode="decimal" value={oqcQty[x.id] ?? x.availableQty} onChange={(e) => setOqcQty((m) => ({ ...m, [x.id]: e.target.value }))} className="w-32" aria-label={`${x.woNo} quantity`} />
                    <Button size="sm" variant="primary" loading={busy === `oqc-${x.id}`} onClick={() => void act(`oqc-${x.id}`, () => api.post("/qc/oqc", { workOrderId: x.id, qty: oqcQty[x.id] ?? x.availableQty }))}>
                      Check In to OQC
                    </Button>
                  </li>
                ))}
              </ul>
            </div>
          )}
          <p className="mb-2 text-sm font-semibold">OQC lots of this order</p>
          {!myLots.length ? (
            <p className="text-sm text-muted">No lots offered to QC yet.</p>
          ) : (
            <ul className="divide-y divide-line">
              {myLots.map((l) => (
                <li key={l.id} className="flex flex-wrap items-center gap-3 py-2 text-sm">
                  <span className="font-medium">{l.inspNo}</span>
                  <span>{l.workOrder?.woNo}</span>
                  <span className="tabular-nums text-muted">
                    {l.qty} {l.uom}
                  </span>
                  <StatusBadge kind="qc" value={l.status} />
                  <span className="flex-1" />
                  <Link to={`/qc/oqc-check-in-out/${l.id}`} target="_blank" className="inline-flex items-center gap-1 text-primary hover:underline">
                    {l.status === "IN_INSPECTION" ? "Inspect" : l.status === "PENDING_DISPOSITION" ? "Disposition" : l.status === "REWORK" ? "Reinspect" : "Open"} <ExternalLink className="size-3" />
                  </Link>
                </li>
              ))}
            </ul>
          )}
          <p className="mt-3 text-xs text-muted">Inspection opens in a new tab; come back and the list updates.</p>
          <Button size="sm" className="mt-2" onClick={() => void refresh()}>
            Refresh
          </Button>
        </Card>
      )}

      {step === "labels" && (
        <Card title="3. Shipping labels">
          {!myReady.length ? (
            <p className="text-sm text-muted">{myLots.some((l) => l.status === "PASSED" || l.status === "ACCEPTED") ? "Every released quantity has labels." : "Nothing released by QC yet."}</p>
          ) : (
            <ul className="space-y-3">
              {myReady.map((r) => {
                const v = label[r.id] ?? { templateId: templates.data?.[0]?.id ?? "", perCarton: "" };
                return (
                  <li key={r.id} className="rounded-md border border-line p-3 text-sm">
                    <p className="mb-2">
                      <span className="font-medium">{r.inspNo}</span> · {r.woNo} · <span className="font-medium">{r.remainingQty} {r.uom}</span> to label
                    </p>
                    <div className="flex flex-wrap items-center gap-2">
                      <Select value={v.templateId} onChange={(e) => setLabel((m) => ({ ...m, [r.id]: { ...v, templateId: e.target.value } }))} className="sm:w-64" aria-label="Label template">
                        {templates.data?.map((t) => (
                          <option key={t.id} value={t.id}>
                            {t.code} – {t.name}
                          </option>
                        ))}
                      </Select>
                      <Input inputMode="decimal" value={v.perCarton} onChange={(e) => setLabel((m) => ({ ...m, [r.id]: { ...v, perCarton: e.target.value } }))} placeholder={`Qty per carton (${r.uom})`} className="w-48" aria-label="Quantity per carton" />
                      <Button
                        size="sm"
                        variant="primary"
                        loading={busy === `lbl-${r.id}`}
                        disabled={!v.templateId || !(Number(v.perCarton) > 0)}
                        onClick={() => void act(`lbl-${r.id}`, () => api.post("/qc/labels", { inspectionId: r.id, templateId: v.templateId, totalQty: r.remainingQty, qtyPerCarton: v.perCarton }))}
                      >
                        Make labels
                      </Button>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
          <Link to="/qc/shipping-label?tab=labels" target="_blank" className="mt-3 inline-flex items-center gap-1 text-sm text-primary hover:underline">
            Print labels in Shipping Label <ExternalLink className="size-3" />
          </Link>
        </Card>
      )}

      {step === "close" && (
        <Card title="4. Complete the order">
          {closed && c.closure ? (
            <p className="flex items-center gap-2 text-sm text-success">
              <CheckCircle2 className="size-4" /> Completed by {c.closure.closedBy}
              {c.closure.override ? " with authorised exceptions" : ""}.
            </p>
          ) : (
            <>
              <ul className="mb-3 space-y-1.5 text-sm">
                {c.blockers.map((b) => (
                  <li key={b} className="flex gap-2 text-danger">
                    <XCircle className="mt-0.5 size-4 shrink-0" /> {b}
                  </li>
                ))}
                {c.warnings.map((w) => (
                  <li key={w} className="flex gap-2 text-warning">
                    <AlertTriangle className="mt-0.5 size-4 shrink-0" /> {w}
                  </li>
                ))}
                {!c.blockers.length && !c.warnings.length && (
                  <li className="flex gap-2 text-success">
                    <CheckCircle2 className="mt-0.5 size-4 shrink-0" /> Everything is in order.
                  </li>
                )}
              </ul>
              {can("planning.completion.complete") && (
                <Button variant="primary" disabled={c.blockers.length > 0} onClick={() => setClosing(true)}>
                  Complete order
                </Button>
              )}
            </>
          )}
          {closed && (
            <div className="mt-4">
              <NextJourney items={[{ label: "Ship", detail: "Cartons are labelled; hand over to dispatch." }, { label: "Report", detail: "Output, material and QC history stay on the order and its Job Orders." }]} />
            </div>
          )}
        </Card>
      )}
      {closing && <CompleteDialog check={c} onClose={() => setClosing(false)} />}
    </>
  );
}
