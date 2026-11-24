import { AlertTriangle, CheckCircle2, XCircle } from "lucide-react";
import { useState, type FormEvent } from "react";
import { Link, useParams } from "react-router";
import { ErrorState, LoadingState, PageHeader } from "@/components/common";
import { StatusBadge } from "@/components/status";
import { Badge, Button, Card, Checkbox, Dialog, Field, Textarea } from "@/components/ui";
import { api } from "@/lib/api";
import { formatDateTime } from "@/lib/utils";
import { useFormError } from "@/lib/use-form-error";
import { useAuth } from "@/stores/auth";
import { useToast } from "@/stores/toast";
import { usePlanningMutation } from "./api";
import { useCompletion, type CompletionCheck } from "./ops-api";

/*
 * Orders are completed from the Production Job Order (detail page, Completion
 * card). The full check page stays at /planning/production-order-complete-utility/:id.
 */

/** Blockers / warnings / closure summary for one order. */
export function CompletionChecks({ c }: { c: CompletionCheck }) {
  const closed = c.pjo.status === "CLOSED";
  return (
    <>
    {closed && c.closure ? (
      <div className="space-y-1 text-sm">
        <p className="flex items-center gap-2 font-medium text-success">
          <CheckCircle2 className="size-4" /> Completed {formatDateTime(c.closure.closedAt)} by {c.closure.closedBy ?? "—"}
        </p>
        {c.closure.override && <Badge tone="warning">Completed with authorised override</Badge>}
        {c.closure.note && <p className="text-muted">{c.closure.note}</p>}
      </div>
    ) : c.blockers.length === 0 && c.warnings.length === 0 ? (
      <p className="flex items-center gap-2 text-sm text-success">
        <CheckCircle2 className="size-4" /> Everything is in order. The order can be completed.
      </p>
    ) : (
      <ul className="space-y-1.5 text-sm">
        {c.blockers.map((b) => (
          <li key={b} className="flex gap-2 text-danger">
            <XCircle className="mt-0.5 size-4 shrink-0" />
            {b}
          </li>
        ))}
        {c.warnings.map((w) => (
          <li key={w} className="flex gap-2 text-warning">
            <AlertTriangle className="mt-0.5 size-4 shrink-0" />
            {w}
          </li>
        ))}
      </ul>
    )}
    </>
  );
}

/** Completion card on the Production Job Order detail page. */
export function PjoCompletionCard({ pjoId }: { pjoId: string }) {
  const { can } = useAuth();
  const check = useCompletion(pjoId);
  const [completing, setCompleting] = useState(false);
  const c = check.data;
  const closed = c?.pjo.status === "CLOSED";
  return (
    <Card
      title="Completion"
      className="mb-4"
      actions={
        c && !closed && can("planning.completion.complete") ? (
          <Button size="sm" variant="primary" disabled={c.blockers.length > 0} onClick={() => setCompleting(true)}>
            Complete order
          </Button>
        ) : undefined
      }
    >
      {check.isPending ? (
        <LoadingState />
      ) : check.error ? (
        <ErrorState error={check.error} onRetry={() => void check.refetch()} />
      ) : (
        <>
          <CompletionChecks c={check.data} />
          <Link to={`/planning/production-order-complete-utility/${pjoId}`} className="mt-3 inline-block text-xs text-primary hover:underline">
            Material and output summary
          </Link>
        </>
      )}
      {completing && c && <CompleteDialog check={c} onClose={() => setCompleting(false)} />}
    </Card>
  );
}

export function CompleteDialog({ check, onClose }: { check: CompletionCheck; onClose: () => void }) {
  const { can } = useAuth();
  const toast = useToast();
  const [note, setNote] = useState("");
  const [override, setOverride] = useState(false);
  const { field, handle } = useFormError();
  const needsOverride = check.warnings.length > 0;
  const save = usePlanningMutation(() => api.post<{ mrsClosed: number }>(`/planning/completion/${check.pjo.id}/complete`, { note: note || null, override }));
  const submit = (e: FormEvent) => {
    e.preventDefault();
    save.mutate(undefined, { onSuccess: (r) => (toast.success(`${check.pjo.pjoNo} completed${r.mrsClosed ? `; ${r.mrsClosed} MRS closed` : ""}.`), onClose()), onError: handle });
  };
  return (
    <Dialog
      open
      onClose={onClose}
      title={`Complete ${check.pjo.pjoNo}?`}
      description="The order is closed and its open Material Requisition Sheets are closed with it. This can't be undone from the screen."
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" type="submit" form="complete-form" loading={save.isPending} disabled={needsOverride && !override}>
            Complete order
          </Button>
        </>
      }
    >
      <form id="complete-form" onSubmit={submit} className="space-y-4" noValidate>
        {needsOverride && (
          <>
            <ul className="space-y-1 rounded-md bg-warning-soft p-3 text-sm text-warning">
              {check.warnings.map((w) => (
                <li key={w} className="flex gap-2">
                  <AlertTriangle className="mt-0.5 size-4 shrink-0" />
                  {w}
                </li>
              ))}
            </ul>
            {can("planning.completion.override") ? (
              <Checkbox label="Complete with these exceptions (authorised override)" checked={override} onChange={(e) => setOverride(e.target.checked)} />
            ) : (
              <p className="text-sm text-danger">These exceptions need someone with the override permission (for example the Production Supervisor).</p>
            )}
          </>
        )}
        <Field label={needsOverride ? "Reason" : "Note"} required={needsOverride} error={field("note")}>{(p) => <Textarea {...p} rows={3} value={note} onChange={(e) => setNote(e.target.value)} />}</Field>
      </form>
    </Dialog>
  );
}

export function CompletionDetailPage() {
  const { id = "" } = useParams();
  const { can } = useAuth();
  const check = useCompletion(id);
  const [completing, setCompleting] = useState(false);
  if (check.isPending) return <LoadingState />;
  if (check.error) return <ErrorState error={check.error} onRetry={() => void check.refetch()} />;
  const c = check.data;
  const closed = c.pjo.status === "CLOSED";
  return (
    <>
      <PageHeader
        title={c.pjo.pjoNo}
        description={`${c.pjo.fatherCode} · ${c.pjo.labelDescription}`}
        crumbs={[{ label: "Planning" }, { label: "Production Job Order", to: "/planning/production-job-order" }, { label: c.pjo.pjoNo, to: `/planning/production-job-order/${c.pjo.id}` }, { label: "Completion" }]}
        actions={
          !closed && can("planning.completion.complete") ? (
            <Button variant="primary" disabled={c.blockers.length > 0} onClick={() => setCompleting(true)}>
              Complete order
            </Button>
          ) : undefined
        }
      />
      <div className="mb-4 grid gap-4 lg:grid-cols-3">
        <Card title="Order">
          <dl className="grid grid-cols-[8rem_1fr] gap-y-1.5 text-sm">
            <dt className="text-muted">Status</dt>
            <dd>
              <StatusBadge kind="pjo" value={c.pjo.status} />
            </dd>
            <dt className="text-muted">Customer ref</dt>
            <dd>{c.pjo.customerRef ?? "—"}</dd>
            <dt className="text-muted">Order qty</dt>
            <dd className="tabular-nums">
              {c.pjo.orderQty} {c.pjo.uom}
            </dd>
            <dt className="text-muted">Good output</dt>
            <dd className="tabular-nums">
              {c.goodOutput} {c.pjo.uom}
            </dd>
          </dl>
          <Link to={`/planning/production-job-order/${c.pjo.id}`} className="mt-3 inline-block text-xs text-primary hover:underline">
            Open Production Job Order
          </Link>
        </Card>
        <Card title="Checks" className="lg:col-span-2">
          <CompletionChecks c={c} />
        </Card>
      </div>
      <Card title={`Job Orders (${c.jobOrders.length})`} className="mb-4">
        <ul className="divide-y divide-line text-sm">
          {c.jobOrders.map((w) => (
            <li key={w.id} className="flex flex-wrap items-center gap-3 py-2">
              <Link to={`/planning/job-order/${w.id}`} className="font-medium text-primary hover:underline">
                {w.woNo}
              </Link>
              <span className="tabular-nums text-muted">
                target {w.quantity} · final good {w.finalGood} {c.pjo.uom}
              </span>
              <span className="flex-1" />
              <StatusBadge kind="wo" value={w.status} />
            </li>
          ))}
        </ul>
      </Card>
      <Card title="Material summary">
        {c.materials.length === 0 ? (
          <p className="py-4 text-center text-sm text-muted">No Material Requisition Sheet was raised for this order.</p>
        ) : (
          <div className="relative overflow-x-auto">
            <ul className="divide-y divide-line sm:hidden">
              {c.materials.flatMap((m) =>
                m.lines.map((l) => (
                  <li key={`${m.mrsId}-${l.materialCode}`} className="py-2.5 text-sm">
                    <div className="flex items-center justify-between gap-2">
                      <Link to={`/planning/material-requisition-sheet/${m.mrsId}`} className="text-primary">
                        {m.mrsNo}
                      </Link>
                      <StatusBadge kind="mrs" value={m.status} />
                    </div>
                    <p className="font-medium">{l.materialCode}</p>
                    <p className="text-xs text-muted tabular-nums">
                      Requested {l.requested} · issued {l.issued} + {l.additional} · returned {l.returned} · rejected {l.rejected} · scrapped {l.scrapped} {l.uom}
                    </p>
                    <p className="tabular-nums">
                      Net to production <b>{l.onHand}</b>
                      {Number(l.remainingToIssue) > 0 && <span className="text-xs text-warning"> · {l.remainingToIssue} never issued</span>}
                    </p>
                  </li>
                )),
              )}
            </ul>
            <table className="hidden w-full text-left text-sm sm:table">
              <thead className="text-xs text-muted uppercase">
                <tr>
                  <th className="px-2 py-2">MRS</th>
                  <th className="px-2 py-2">Material</th>
                  <th className="px-2 py-2 text-right">Requested</th>
                  <th className="px-2 py-2 text-right">Issued + add.</th>
                  <th className="px-2 py-2 text-right">Returned</th>
                  <th className="px-2 py-2 text-right">Rejected</th>
                  <th className="px-2 py-2 text-right">Scrapped</th>
                  <th className="px-2 py-2 text-right">Net to production</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {c.materials.flatMap((m) =>
                  m.lines.map((l, i) => (
                    <tr key={`${m.mrsId}-${l.materialCode}`}>
                      <td className="px-2 py-2">
                        {i === 0 && (
                          <>
                            <Link to={`/planning/material-requisition-sheet/${m.mrsId}`} className="text-primary hover:underline">
                              {m.mrsNo}
                            </Link>
                            <div className="mt-0.5">
                              <StatusBadge kind="mrs" value={m.status} />
                            </div>
                          </>
                        )}
                      </td>
                      <td className="px-2 py-2">
                        <p>{l.materialCode}</p>
                        <p className="text-xs text-muted">{l.materialDescription}</p>
                      </td>
                      <td className="px-2 py-2 text-right tabular-nums">
                        {l.requested} <span className="text-xs text-muted">{l.uom}</span>
                      </td>
                      <td className="px-2 py-2 text-right tabular-nums">
                        {l.issued} + {l.additional}
                        {Number(l.remainingToIssue) > 0 && <p className="text-xs text-warning">{l.remainingToIssue} never issued</p>}
                      </td>
                      <td className="px-2 py-2 text-right tabular-nums">{l.returned}</td>
                      <td className="px-2 py-2 text-right tabular-nums">{l.rejected}</td>
                      <td className="px-2 py-2 text-right tabular-nums">{l.scrapped}</td>
                      <td className="px-2 py-2 text-right font-medium tabular-nums">{l.onHand}</td>
                    </tr>
                  )),
                )}
              </tbody>
            </table>
            <p className="mt-2 text-xs text-muted">Net to production = issued + additional − returned − rejected − scrapped. Actual consumption per roll is not recorded yet.</p>
          </div>
        )}
      </Card>
      {completing && <CompleteDialog check={c} onClose={() => setCompleting(false)} />}
    </>
  );
}
