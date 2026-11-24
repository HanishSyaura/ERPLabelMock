import { useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, CheckCircle2, Loader2, Plus, Trash2 } from "lucide-react";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Link, useNavigate } from "react-router";
import { PageHeader, SearchInput } from "@/components/common";
import { Journey, NextJourney, type JourneyStep } from "@/components/journey";
import { Badge, Button, Card, Checkbox, Field, Input, Select, Textarea } from "@/components/ui";
import { api, ApiError, qs } from "@/lib/api";
import { useAuth } from "@/stores/auth";
import { rev, useUoms, type BomRow } from "@/modules/bom/api";
import { ArtworkThumb } from "@/modules/bom/artwork";
import { useProduct, useProducts } from "@/modules/bom/product-api";
import { PRIORITIES, useRoutines } from "./api";

/**
 * New Production Job Order as one journey, start to end:
 *   1 Product      finished-good part with a released Master Card (or a Father Code without a part)
 *   2 Order        quantity, customer PO, required date, priority
 *   3 Job Orders   split the order for the shopfloor (route from the Master Card)
 *   4 Material     MRS per Job Order, quantity = QPA × Job Order quantity (Master Card QPA)
 *   5 Review       release now or keep as draft, then create
 *   Done           what was created and what happens next on the floor
 * Everything is created through the normal APIs, one call after another; if
 * one fails, what was already created stays and the screen says so.
 */
type StepId = "product" | "order" | "jobs" | "material" | "review" | "done";

interface Pick {
  bomId: string;
  productId: string | null;
  code: string;
  name: string;
  artworkFile: BomRow["artworkFile"];
  cardRev: number | null;
}
interface JobRow {
  quantity: string;
  plannedDate: string;
}
interface Created {
  label: string;
  ref: string;
  to: string;
}

const today = () => new Date().toISOString().slice(0, 10);
const ceil4 = (n: number) => Math.ceil(n * 10000 - 1e-9) / 10000;

export function NewPjoJourneyPage() {
  const { can } = useAuth();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const uoms = useUoms();
  const routines = useRoutines();
  const [step, setStep] = useState<StepId>("product");
  const [pick, setPick] = useState<Pick | null>(null);
  const [order, setOrder] = useState({ orderQty: "", uom: "PCS", customerRef: "", requiredDate: "", priority: "NORMAL", remarks: "" });
  const [jobs, setJobs] = useState<JobRow[]>([{ quantity: "", plannedDate: today() }]);
  const [routineId, setRoutineId] = useState("");
  const [releaseOrder, setReleaseOrder] = useState(can("planning.pjo.release"));
  const [releaseJobs, setReleaseJobs] = useState(can("planning.jo.release"));
  const [raiseMrs, setRaiseMrs] = useState(can("planning.mrs.issue"));
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [running, setRunning] = useState<string | null>(null);
  const [created, setCreated] = useState<Created[]>([]);
  const [failure, setFailure] = useState<string | null>(null);
  const [pjo, setPjo] = useState<{ id: string; pjoNo: string } | null>(null);

  const product = useProduct(pick?.productId ?? "");
  const card = pick?.productId ? product.data?.released ?? null : null;
  const qpa = useMemo(() => new Map((card?.qpa ?? []).map((l) => [l.sonCode, l])), [card]);
  const orderQty = Number(order.orderQty) || 0;
  const jobTotal = jobs.reduce((s, j) => s + (Number(j.quantity) || 0), 0);
  const mrsPossible = !!card && releaseOrder;

  // Job Orders default to the whole order.
  useEffect(() => {
    if (jobs.length === 1 && !jobs[0]!.quantity && order.orderQty) setJobs([{ ...jobs[0]!, quantity: order.orderQty }]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [order.orderQty]);
  useEffect(() => {
    if (product.data) setOrder((o) => ({ ...o, uom: product.data!.uom }));
  }, [product.data]);

  // ----- validation per step ------------------------------------------------
  const check = (s: StepId): Record<string, string> => {
    const e: Record<string, string> = {};
    if (s === "product" && !pick) e.product = "Choose what to produce";
    if (s === "order") {
      if (!(orderQty > 0)) e.orderQty = "Enter the order quantity";
      if (!order.uom) e.uom = "Choose a unit";
    }
    if (s === "jobs") {
      jobs.forEach((j, i) => {
        if (!(Number(j.quantity) > 0)) e[`job.${i}`] = "Enter a quantity";
      });
      if (jobTotal > orderQty) e.jobs = `Job Orders total ${jobTotal.toLocaleString()} but the order is ${orderQty.toLocaleString()}`;
      if (pick && !pick.productId && !routineId) e.routine = "Choose the routine (this Father Code has no Master Card)";
      if (pick?.productId && card && !card.routine && !routineId) e.routine = "The Master Card has no routine; choose one";
    }
    return e;
  };
  const ORDER: StepId[] = ["product", "order", "jobs", "material", "review", "done"];
  const index = ORDER.indexOf(step);
  const go = (to: StepId) => {
    const target = ORDER.indexOf(to);
    if (target > index) {
      for (const s of ORDER.slice(0, target)) {
        const e = check(s);
        if (Object.keys(e).length) {
          setErrors(e);
          setStep(s);
          return;
        }
      }
    }
    setErrors({});
    setStep(to);
  };
  const stepState = (s: StepId): JourneyStep["state"] => {
    if (step === "done") return s === "material" && !(raiseMrs && mrsPossible) ? "skipped" : "done";
    if (s === "material" && !card) return "skipped";
    return undefined;
  };
  const steps: JourneyStep<StepId>[] = [
    { id: "product", label: "Product", hint: "What to make", state: stepState("product") },
    { id: "order", label: "Order", hint: "Qty, PO, date", state: stepState("order") },
    { id: "jobs", label: "Job Orders", hint: "Split for the floor", state: stepState("jobs") },
    { id: "material", label: "Material", hint: "MRS from QPA", state: stepState("material") },
    { id: "review", label: "Review", hint: "Release & create", state: stepState("review") },
    { id: "done", label: "Done", hint: "Next on the floor", state: step === "done" && !failure ? "done" : failure ? "error" : undefined },
  ];

  // ----- create -----------------------------------------------------------------
  const create = async () => {
    setFailure(null);
    setCreated([]);
    const made: Created[] = [];
    const push = (c: Created) => {
      made.push(c);
      setCreated([...made]);
    };
    try {
      setRunning("Creating the Production Job Order…");
      const p = await api.post<{ id: string; pjoNo: string }>("/planning/production-job-orders", {
        bomId: pick!.bomId,
        orderQty: order.orderQty,
        uom: order.uom,
        requiredDate: order.requiredDate || null,
        priority: order.priority,
        customerRef: order.customerRef,
        remarks: order.remarks,
      });
      setPjo(p);
      push({ label: "Production Job Order", ref: p.pjoNo, to: `/planning/production-job-order/${p.id}` });
      if (releaseOrder) {
        setRunning(`Releasing ${p.pjoNo} (freezes the Master Card)…`);
        await api.post(`/planning/production-job-orders/${p.id}/release`);
      }
      for (const [i, j] of jobs.entries()) {
        setRunning(`Creating Job Order ${i + 1} of ${jobs.length}…`);
        const wo = await api.post<{ id: string; woNo: string }>("/planning/work-orders", {
          pjoId: p.id,
          quantity: j.quantity,
          plannedDate: j.plannedDate || null,
          ...(routineId ? { routineId } : {}),
        });
        push({ label: `Job Order ${i + 1}`, ref: wo.woNo, to: `/planning/job-order/${wo.id}` });
        if (releaseOrder && releaseJobs) await api.post(`/planning/work-orders/${wo.id}/release`);
        if (releaseOrder && raiseMrs && card) {
          setRunning(`Raising the MRS for ${wo.woNo}…`);
          const tpl = await api.get<{ lines: { sonCodeId: string; sonCode: string }[] }>(`/material/work-orders/${wo.id}/mrs-template`);
          const lines = tpl.lines
            .map((l) => ({ sonCodeId: l.sonCodeId, requestedQty: ceil4((qpa.get(l.sonCode)?.qpa ?? 0) * Number(j.quantity)) }))
            .filter((l) => l.requestedQty > 0);
          if (lines.length) {
            const m = await api.post<{ id: string; mrsNo: string }>("/material/requisitions", { workOrderId: wo.id, lines });
            push({ label: `MRS for ${wo.woNo}`, ref: m.mrsNo, to: `/planning/material-requisition-sheet/${m.id}` });
          }
        }
      }
      await qc.invalidateQueries({ queryKey: ["planning"] });
      setStep("done");
    } catch (e) {
      setFailure(e instanceof ApiError ? (e.issues[0]?.message ?? e.message) : String(e));
      setStep("done");
    } finally {
      setRunning(null);
    }
  };

  return (
    <>
      <PageHeader
        title="New Production Job Order"
        description="One journey from what to make to Job Orders and material, ready for the shopfloor."
        crumbs={[{ label: "Planning" }, { label: "Production Job Order", to: "/planning/production-job-order" }, { label: "New" }]}
      />
      <Card className="mb-4">
        <Journey steps={steps} current={step} onSelect={step === "done" || running ? undefined : go} locked={(s) => s === "done"} />
      </Card>

      {step === "product" && <ProductStep pick={pick} onPick={setPick} error={errors.product} />}

      {step === "order" && pick && (
        <Card title={`Order for ${pick.code}`}>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Order quantity" required error={errors.orderQty}>{(p) => <Input {...p} inputMode="decimal" value={order.orderQty} onChange={(e) => setOrder((o) => ({ ...o, orderQty: e.target.value }))} autoFocus />}</Field>
            <Field label="Unit" required error={errors.uom}>
              {(p) => (
                <Select {...p} value={order.uom} onChange={(e) => setOrder((o) => ({ ...o, uom: e.target.value }))}>
                  {uoms.data?.map((u) => (
                    <option key={u.code} value={u.code}>
                      {u.code} – {u.label}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
            <Field label="Customer PO / reference">{(p) => <Input {...p} value={order.customerRef} onChange={(e) => setOrder((o) => ({ ...o, customerRef: e.target.value }))} />}</Field>
            <Field label="Required date">{(p) => <Input {...p} type="date" value={order.requiredDate} onChange={(e) => setOrder((o) => ({ ...o, requiredDate: e.target.value }))} />}</Field>
            <Field label="Priority">
              {(p) => (
                <Select {...p} value={order.priority} onChange={(e) => setOrder((o) => ({ ...o, priority: e.target.value }))}>
                  {PRIORITIES.map((x) => (
                    <option key={x} value={x}>
                      {x.charAt(0) + x.slice(1).toLowerCase()}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
            <Field label="Remarks" className="sm:col-span-2">{(p) => <Textarea {...p} rows={2} value={order.remarks} onChange={(e) => setOrder((o) => ({ ...o, remarks: e.target.value }))} />}</Field>
          </div>
        </Card>
      )}

      {step === "jobs" && pick && (
        <Card title="Split into Job Orders">
          <p className="mb-3 text-sm text-muted">
            Each Job Order is a shopfloor batch with its own barcode. Total {jobTotal.toLocaleString()} of {orderQty.toLocaleString()} {order.uom}
            {jobTotal < orderQty ? ` · ${(orderQty - jobTotal).toLocaleString()} left for later Job Orders` : ""}.
          </p>
          <ul className="space-y-2">
            {jobs.map((j, i) => (
              <li key={i} className="grid items-end gap-2 sm:grid-cols-[2rem_1fr_1fr_auto]">
                <span className="pb-2.5 text-sm font-semibold">{i + 1}.</span>
                <Field label={`Quantity (${order.uom})`} error={errors[`job.${i}`]}>{(p) => <Input {...p} inputMode="decimal" value={j.quantity} onChange={(e) => setJobs((l) => l.map((x, k) => (k === i ? { ...x, quantity: e.target.value } : x)))} />}</Field>
                <Field label="Planned date">{(p) => <Input {...p} type="date" value={j.plannedDate} onChange={(e) => setJobs((l) => l.map((x, k) => (k === i ? { ...x, plannedDate: e.target.value } : x)))} />}</Field>
                <Button variant="ghost" icon={<Trash2 className="size-4" />} disabled={jobs.length === 1} aria-label="Remove Job Order" onClick={() => setJobs((l) => l.filter((_, k) => k !== i))} />
              </li>
            ))}
          </ul>
          {errors.jobs && <p className="mt-2 text-sm text-danger">{errors.jobs}</p>}
          <div className="mt-3 flex flex-wrap gap-2">
            <Button icon={<Plus className="size-4" />} onClick={() => setJobs((l) => [...l, { quantity: orderQty > jobTotal ? String(orderQty - jobTotal) : "", plannedDate: today() }])}>
              Add Job Order
            </Button>
            {orderQty > 0 && jobs.length > 1 && (
              <Button
                onClick={() => {
                  const each = Math.floor(orderQty / jobs.length);
                  setJobs((l) => l.map((x, k) => ({ ...x, quantity: String(k === l.length - 1 ? orderQty - each * (l.length - 1) : each) })));
                }}
              >
                Split evenly
              </Button>
            )}
          </div>
          <div className="mt-5 border-t border-line pt-4">
            <p className="mb-2 text-sm font-semibold">Process route</p>
            {card?.routine && !routineId ? (
              <p className="text-sm">
                From Master Card {rev(card.revisionNo)}: <span className="font-medium">{card.routine.code}</span> – {card.routine.steps.join(" → ")}
              </p>
            ) : null}
            {(!card?.routine || routineId) && (
              <Field label="Routine" error={errors.routine} hint={pick.productId ? "Overrides the Master Card routine for these Job Orders." : "This Father Code has no Master Card, so choose the route."}>
                {(p) => (
                  <Select {...p} value={routineId} onChange={(e) => setRoutineId(e.target.value)}>
                    <option value="">{card?.routine ? "Use the Master Card routine" : "Choose…"}</option>
                    {routines.data
                      ?.filter((r) => r.status === "ACTIVE")
                      .map((r) => (
                        <option key={r.id} value={r.id}>
                          {r.code} – {r.steps.map((s) => s.process.name).join(" → ")}
                        </option>
                      ))}
                  </Select>
                )}
              </Field>
            )}
            {card?.routine && !routineId && (
              <button type="button" className="mt-1 text-xs text-primary hover:underline" onClick={() => setRoutineId(routines.data?.find((r) => r.id === card.routine?.id)?.id ?? "")}>
                Use a different routine
              </button>
            )}
          </div>
        </Card>
      )}

      {step === "material" && (
        <Card title="Material (MRS)">
          {!card ? (
            <p className="text-sm text-muted">No Master Card, so no QPA to calculate material from. Raise the MRS from the Job Order later.</p>
          ) : (
            <>
              <Checkbox label="Raise an MRS for each Job Order (needs the order released in the next step)" checked={raiseMrs} disabled={!can("planning.mrs.issue")} onChange={(e) => setRaiseMrs(e.target.checked)} />
              <p className="mt-2 text-xs text-muted">Requested quantity = QPA from Master Card {rev(card.revisionNo)} × Job Order quantity, rounded up. The store issues against it.</p>
              <div className="relative mt-3 overflow-x-auto">
                <table className="w-full text-left text-sm">
                  <thead className="text-xs text-muted uppercase">
                    <tr>
                      <th className="px-2 py-2">Material</th>
                      <th className="px-2 py-2 text-right">QPA</th>
                      {jobs.map((j, i) => (
                        <th key={i} className="px-2 py-2 text-right whitespace-nowrap">
                          JO {i + 1} ({Number(j.quantity || 0).toLocaleString()})
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-line">
                    {card.qpa.map((l) => (
                      <tr key={l.sonCode}>
                        <td className="px-2 py-2">
                          <p className="font-medium">{l.materialCode}</p>
                          <p className="text-xs text-muted">
                            {l.sonCode} · {l.materialDescription}
                          </p>
                        </td>
                        <td className="px-2 py-2 text-right whitespace-nowrap tabular-nums">
                          {l.qpa ?? "—"} {l.uom}
                        </td>
                        {jobs.map((j, i) => (
                          <td key={i} className="px-2 py-2 text-right whitespace-nowrap tabular-nums">
                            {l.qpa ? `${ceil4(l.qpa * (Number(j.quantity) || 0)).toLocaleString()} ${l.uom}` : "—"}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </Card>
      )}

      {step === "review" && pick && (
        <Card title="Review and create">
          <dl className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-[10rem_1fr]">
            <dt className="text-muted">Product</dt>
            <dd>
              {pick.code} · {pick.name}
              {pick.cardRev ? ` · Master Card ${rev(pick.cardRev)}` : " · no Master Card (Father Code revisions)"}
            </dd>
            <dt className="text-muted">Order</dt>
            <dd>
              {orderQty.toLocaleString()} {order.uom}
              {order.customerRef && ` · PO ${order.customerRef}`}
              {order.requiredDate && ` · required ${order.requiredDate}`} · {order.priority.toLowerCase()} priority
            </dd>
            <dt className="text-muted">Job Orders</dt>
            <dd>{jobs.map((j, i) => `${i + 1}: ${Number(j.quantity).toLocaleString()} on ${j.plannedDate || "—"}`).join(" · ")}</dd>
            <dt className="text-muted">Route</dt>
            <dd>{routineId ? routines.data?.find((r) => r.id === routineId)?.code : (card?.routine?.code ?? "—")}</dd>
          </dl>
          <div className="mt-5 space-y-2 border-t border-line pt-4">
            <Checkbox label="Release the order now (freezes the Master Card, artwork and BOM revisions)" checked={releaseOrder} disabled={!can("planning.pjo.release")} onChange={(e) => setReleaseOrder(e.target.checked)} />
            <Checkbox label="Release the Job Orders to the shopfloor" checked={releaseOrder && releaseJobs} disabled={!releaseOrder || !can("planning.jo.release")} onChange={(e) => setReleaseJobs(e.target.checked)} />
            <Checkbox label="Raise the MRS for each Job Order" checked={mrsPossible && raiseMrs} disabled={!mrsPossible || !can("planning.mrs.issue")} onChange={(e) => setRaiseMrs(e.target.checked)} />
            {!releaseOrder && <p className="text-xs text-muted">Kept as a draft: release it from the Production Job Order page when ready.</p>}
          </div>
          {running && (
            <p className="mt-4 flex items-center gap-2 text-sm">
              <Loader2 className="size-4 animate-spin" /> {running}
            </p>
          )}
        </Card>
      )}

      {step === "done" && (
        <div className="grid gap-4 lg:grid-cols-2">
          <Card title={failure ? "Stopped part-way" : "Created"}>
            {failure && (
              <p className="mb-3 flex gap-2 rounded-md bg-danger-soft p-3 text-sm text-danger">
                <AlertTriangle className="mt-0.5 size-4 shrink-0" /> {failure} Everything listed below was created; continue from the Production Job Order.
              </p>
            )}
            <ul className="space-y-2 text-sm">
              {created.map((c) => (
                <li key={c.ref} className="flex items-center gap-2">
                  <CheckCircle2 className="size-4 text-success" />
                  <span className="text-muted">{c.label}</span>
                  <Link to={c.to} className="font-medium text-primary hover:underline">
                    {c.ref}
                  </Link>
                </li>
              ))}
            </ul>
            <div className="mt-4 flex flex-wrap gap-2">
              {pjo && <Button variant="primary" onClick={() => navigate(`/planning/production-job-order/${pjo.id}`)}>Open {pjo.pjoNo}</Button>}
              <Button onClick={() => window.location.reload()}>Create another</Button>
            </div>
          </Card>
          <NextJourney
            items={[
              { label: "Issue material", detail: "The store issues the MRS lines (by lot when the part needs IQC).", action: <Link to="/planning/material-requisition-sheet" className="text-xs text-primary hover:underline">MRS</Link> },
              { label: "Run the Job Orders", detail: "Operators scan the Job Order barcode on the handheld: Check In, record output, Check Out per process.", action: <Link to="/planning/daily-job-information" className="text-xs text-primary hover:underline">Daily Job Info</Link> },
              { label: "Complete the Job Orders", detail: "When the last process is done, confirm the Job Order complete." },
              { label: "OQC", detail: "Offer the finished labels to QC; a passed lot is released.", action: <Link to="/qc/oqc-check-in-out" className="text-xs text-primary hover:underline">OQC</Link> },
              { label: "Shipping labels", detail: "Print carton labels for the released quantity.", action: <Link to="/qc/shipping-label" className="text-xs text-primary hover:underline">Labels</Link> },
              { label: "Complete the order", detail: "Close the Production Job Order from its page (Completion card)." },
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
            Step {index + 1} of 5 · {steps[index]!.label}
          </span>
          <div className="flex-1" />
          {step === "review" ? (
            <Button variant="primary" loading={!!running} disabled={!can("planning.pjo.create") || !can("planning.jo.create")} onClick={() => void create()}>
              Create {releaseOrder ? "and release" : "as draft"}
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

/** Step 1: finished-good parts with a released Master Card, or a Father Code without a part. */
function ProductStep({ pick, onPick, error }: { pick: Pick | null; onPick: (p: Pick) => void; error?: string }) {
  const [mode, setMode] = useState<"card" | "father">("card");
  const [q, setQ] = useState("");
  const cards = useProducts({ page: 1, q, card: "released", status: "ACTIVE" });
  const fathers = useQuery({ queryKey: ["boms", "no-part", q], queryFn: () => api.list<BomRow>(`/boms${qs({ q, status: "ACTIVE", product: "without", pageSize: 20 })}`), enabled: mode === "father" });
  const tile = (p: Pick, sub: string, badge: ReactNode) => (
    <button
      key={p.bomId}
      type="button"
      onClick={() => onPick(p)}
      className={`flex items-center gap-3 rounded-lg border p-3 text-left text-sm transition ${pick?.bomId === p.bomId ? "border-primary bg-primary-soft" : "border-line hover:border-primary/50"}`}
    >
      <ArtworkThumb file={p.artworkFile} className="size-14" />
      <span className="min-w-0 flex-1">
        <span className="block font-medium">{p.code}</span>
        <span className="line-clamp-1 text-xs text-muted">{p.name}</span>
        <span className="text-xs text-muted">{sub}</span>
      </span>
      {badge}
    </button>
  );
  return (
    <Card title="What do you want to produce?">
      <div className="mb-3 flex flex-wrap gap-2">
        <Button variant={mode === "card" ? "primary" : "secondary"} size="sm" onClick={() => setMode("card")}>
          Finished-good parts (Master Card)
        </Button>
        <Button variant={mode === "father" ? "primary" : "secondary"} size="sm" onClick={() => setMode("father")}>
          Father Code without a part
        </Button>
      </div>
      <SearchInput value={q} onChange={setQ} placeholder={mode === "card" ? "Part code, name, NMI, customer" : "Father Code or label description"} />
      {error && <p className="mt-2 text-sm text-danger">{error}</p>}
      <div className="mt-3 grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
        {mode === "card"
          ? cards.data?.data.map((p) =>
              tile(
                { bomId: p.bomId, productId: p.id, code: p.productCode, name: p.name, artworkFile: p.artworkFile, cardRev: p.currentCardRevNo },
                `${p.fatherCode}${p.customerName ? ` · ${p.customerName}` : ""}`,
                <Badge tone="success">Card {rev(p.currentCardRevNo)}</Badge>,
              ),
            )
          : fathers.data?.data.map((b) => tile({ bomId: b.id, productId: null, code: b.fatherCode, name: b.labelDescription, artworkFile: b.artworkFile, cardRev: null }, `${b.sonCount} Son Codes`, <Badge tone="neutral">No part</Badge>))}
      </div>
      {mode === "card" && cards.data && !cards.data.data.length && (
        <p className="mt-3 text-sm text-muted">
          No finished-good part with a released Master Card{q ? " matches" : ""}. Release one under{" "}
          <Link to="/bom/master-card" className="text-primary hover:underline">
            BOM › Master Card
          </Link>
          .
        </p>
      )}
    </Card>
  );
}
