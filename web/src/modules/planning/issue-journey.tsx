import { useQueries, useQueryClient } from "@tanstack/react-query";
import { CheckCircle2, XCircle } from "lucide-react";
import { useMemo, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router";
import { PageHeader, SearchInput } from "@/components/common";
import { Journey, NextJourney, type JourneyStep } from "@/components/journey";
import { StatusBadge } from "@/components/status";
import { Button, Card, Input } from "@/components/ui";
import { api, ApiError } from "@/lib/api";
import { newTxnId } from "@/lib/use-form-error";
import { useAuth } from "@/stores/auth";
import type { PartDetail } from "@/modules/master-data/api";
import { useMrs, useMrsList } from "./ops-api";

/**
 * Issue material, start to end:
 *   1 MRS     pick an open Material Requisition Sheet
 *   2 Issue   quantity and lot / roll no. per line (defaults: what is still to issue);
 *             lots come from the part's Location Qty; Require-IQC parts need a lot that passed IQC
 *   Done      what was issued, and next: run the Job Order
 * Each line is issued as its own movement (the server checks every limit).
 */
type StepId = "mrs" | "issue" | "done";

export function IssueMaterialJourney() {
  const { can } = useAuth();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [params] = useSearchParams();
  const [step, setStep] = useState<StepId>(params.get("mrs") ? "issue" : "mrs");
  const [q, setQ] = useState("");
  const [mrsId, setMrsId] = useState<string | null>(params.get("mrs"));
  const open = useMrsList({ page: 1, q, status: "OPEN" });
  const partly = useMrsList({ page: 1, q, status: "PARTIALLY_ISSUED" });
  const mrs = useMrs(mrsId);
  const lines = useMemo(() => (mrs.data?.lines ?? []).filter((l) => Number(l.remainingToIssue) > 0), [mrs.data]);
  const [form, setForm] = useState<Record<string, { qty: string; lot: string }>>({});
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<{ line: string; ok: boolean; text: string }[]>([]);

  // Lots on hand per part (Location Qty) as suggestions.
  const materialIds = [...new Set(lines.map((l) => l.materialId))];
  const partQueries = useQueries({ queries: materialIds.map((id) => ({ queryKey: ["materials", "detail", id], queryFn: () => api.get<PartDetail>(`/materials/${id}`) })) });
  const partOf = new Map(partQueries.filter((x) => x.data).map((x) => [x.data!.id, x.data!]));

  const val = (id: string, remaining: string) => form[id] ?? { qty: remaining, lot: "" };
  const issue = async () => {
    setBusy(true);
    const out: typeof outcome = [];
    for (const l of lines) {
      const v = val(l.id, l.remainingToIssue);
      if (!(Number(v.qty) > 0)) continue;
      try {
        await api.post(`/material/lines/${l.id}/issue`, { qty: v.qty, lotRef: v.lot || null, clientTxnId: newTxnId() });
        out.push({ line: l.materialCode, ok: true, text: `${v.qty} ${l.uom}${v.lot ? ` · lot ${v.lot}` : ""}` });
      } catch (e) {
        out.push({ line: l.materialCode, ok: false, text: e instanceof ApiError ? (e.issues[0]?.message ?? e.message) : String(e) });
      }
    }
    setOutcome(out);
    await qc.invalidateQueries({ queryKey: ["planning"] });
    setBusy(false);
    setStep("done");
  };

  const steps: JourneyStep<StepId>[] = [
    { id: "mrs", label: "MRS", hint: "Which requisition", state: mrsId ? "done" : undefined },
    { id: "issue", label: "Issue", hint: "Qty and lot per line" },
    { id: "done", label: "Done", hint: "Next: run the job", state: step === "done" ? (outcome.some((o) => !o.ok) ? "error" : "done") : undefined },
  ];
  const rows = [...(open.data?.data ?? []), ...(partly.data?.data ?? [])];

  return (
    <>
      <PageHeader title="Issue material" description="Hand material to production against a Material Requisition Sheet, line by line, by lot." crumbs={[{ label: "Planning" }, { label: "Material Requisition Sheet", to: "/planning/material-requisition-sheet" }, { label: "Issue" }]} />
      <Card className="mb-4">
        <Journey steps={steps} current={step} onSelect={step === "done" ? undefined : (s) => (s === "mrs" || mrsId) && setStep(s)} />
      </Card>

      {step === "mrs" && (
        <Card title="1. Which MRS?">
          <SearchInput value={q} onChange={setQ} placeholder="MRS no., Job Order, PJO, Father Code" />
          <ul className="mt-3 divide-y divide-line">
            {rows.map((r) => (
              <li key={r.id}>
                <button type="button" onClick={() => (setMrsId(r.id), setForm({}), setStep("issue"))} className={`flex w-full flex-wrap items-center gap-3 px-2 py-2.5 text-left text-sm hover:bg-surface-2 ${mrsId === r.id ? "bg-primary-soft" : ""}`}>
                  <span className="font-medium">{r.mrsNo}</span>
                  <span>{r.workOrder.woNo}</span>
                  <span className="text-muted">
                    {r.pjoNo} · {r.fatherCode}
                  </span>
                  <span className="flex-1" />
                  <span className="text-xs text-muted">
                    {r.linesFullyIssued} / {r.lineCount} lines issued
                  </span>
                  <StatusBadge kind="mrs" value={r.status} />
                </button>
              </li>
            ))}
          </ul>
          {!rows.length && <p className="py-6 text-center text-sm text-muted">No MRS waiting for issue.</p>}
        </Card>
      )}

      {step === "issue" && mrs.data && (
        <Card title={`2. Issue ${mrs.data.mrsNo} · ${mrs.data.workOrder.woNo}`}>
          {!lines.length ? (
            <p className="text-sm text-muted">Every line is fully issued. More material goes through MRS Additional Issued (Material Movement).</p>
          ) : (
            <>
              <p className="mb-3 text-sm text-muted">Quantities default to what is still to issue. Parts that require IQC need a lot no. that passed IQC.</p>
              <ul className="space-y-3">
                {lines.map((l) => {
                  const v = val(l.id, l.remainingToIssue);
                  const p = partOf.get(l.materialId);
                  const lots = (p?.locations ?? []).filter((x) => x.lotNo);
                  const listId = `lots-${l.id}`;
                  return (
                    <li key={l.id} className="rounded-lg border border-line p-3">
                      <div className="mb-2 flex flex-wrap items-baseline gap-x-3 text-sm">
                        <span className="font-medium">{l.materialCode}</span>
                        <span className="min-w-0 flex-1 truncate text-muted">{l.materialDescription}</span>
                        <span className="text-xs">
                          requested {l.requested} · issued {l.issued} · <span className="font-medium">to issue {l.remainingToIssue} {l.uom}</span>
                        </span>
                        {p?.requireIqc && <span className="rounded bg-warning-soft px-1.5 text-xs text-warning">Require IQC</span>}
                      </div>
                      <div className="grid gap-2 sm:grid-cols-2">
                        <Input inputMode="decimal" value={v.qty} onChange={(e) => setForm((f) => ({ ...f, [l.id]: { ...v, qty: e.target.value } }))} aria-label={`${l.materialCode} quantity`} placeholder={`Quantity (${l.uom})`} />
                        <Input value={v.lot} onChange={(e) => setForm((f) => ({ ...f, [l.id]: { ...v, lot: e.target.value } }))} list={listId} aria-label={`${l.materialCode} lot`} placeholder="Lot / roll no." />
                        <datalist id={listId}>
                          {lots.map((x) => (
                            <option key={x.id} value={x.lotNo!}>{`${x.warehouseCode}/${x.locationCode} · ${x.qty}`}</option>
                          ))}
                        </datalist>
                      </div>
                      {lots.length > 0 && <p className="mt-1 text-xs text-muted">In stock: {lots.map((x) => `${x.lotNo} (${x.qty} at ${x.warehouseCode}/${x.locationCode})`).join(" · ")}</p>}
                    </li>
                  );
                })}
              </ul>
            </>
          )}
        </Card>
      )}

      {step === "done" && (
        <div className="grid gap-4 lg:grid-cols-2">
          <Card title="Issued">
            <ul className="space-y-1.5 text-sm">
              {outcome.map((o, k) => (
                <li key={k} className="flex items-start gap-2">
                  {o.ok ? <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-success" /> : <XCircle className="mt-0.5 size-4 shrink-0 text-danger" />}
                  <span>
                    <span className="font-medium">{o.line}</span> <span className={o.ok ? "" : "text-danger"}>{o.text}</span>
                  </span>
                </li>
              ))}
            </ul>
            <div className="mt-4 flex flex-wrap gap-2">
              {outcome.some((o) => !o.ok) && (
                <Button variant="primary" onClick={() => (setOutcome([]), setStep("issue"))}>
                  Fix and issue the rest
                </Button>
              )}
              {mrsId && <Button onClick={() => navigate(`/planning/material-requisition-sheet/${mrsId}`)}>Open the MRS</Button>}
              <Button onClick={() => (setMrsId(null), setOutcome([]), setForm({}), setStep("mrs"))}>Issue another MRS</Button>
            </div>
          </Card>
          <NextJourney
            items={[
              { label: "Run the Job Order", detail: "Operators Check In on the handheld by scanning the Job Order barcode.", action: <Link to="/planning/daily-job-information" className="text-xs text-primary hover:underline">Daily Job Info</Link> },
              { label: "Returns, rejects and scrap", detail: "Unused, damaged or scrapped material goes back through Material Movement.", action: <Link to="/planning/material-movement" className="text-xs text-primary hover:underline">Material Movement</Link> },
            ]}
          />
        </div>
      )}

      {step === "issue" && (
        <div className="sticky bottom-0 z-10 mt-4 flex flex-wrap items-center gap-2 rounded-lg border border-line bg-surface px-4 py-3 shadow-sm">
          <Button onClick={() => setStep("mrs")}>Back</Button>
          <div className="flex-1" />
          <Button variant="primary" loading={busy} disabled={!lines.length || !can("planning.mrs.issue")} onClick={() => void issue()}>
            Issue {lines.length} line{lines.length === 1 ? "" : "s"}
          </Button>
        </div>
      )}
    </>
  );
}
