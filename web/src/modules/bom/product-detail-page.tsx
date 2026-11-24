import { AlertTriangle, CheckCircle2, FilePlus2, Plus, RefreshCw, Trash2 } from "lucide-react";
import { useEffect, useState, type FormEvent } from "react";
import { Link, Navigate, useParams, useSearchParams } from "react-router";
import {
  ConfirmDialog,
  ErrorState,
  LoadingState,
  Tabs,
} from "@/components/common";
import { StatusBadge } from "@/components/status";
import {
  Badge,
  Button,
  Card,
  Field,
  Input,
  Select,
  Textarea,
} from "@/components/ui";
import { api, ApiError } from "@/lib/api";
import { formatDate, formatDateTime, humanize } from "@/lib/utils";
import { useFormError } from "@/lib/use-form-error";
import { useAuth } from "@/stores/auth";
import { useToast } from "@/stores/toast";
import { useDieCuts } from "@/modules/master-data/api";
import { useMachineCategories, useMachines, useRoutines } from "@/modules/planning/api";
import { rev } from "./api";
import { ArtworkPreview, ArtworkThumb } from "./artwork";
import { WindingIcon, WindingPicker } from "./winding";
import {
  SPEC_GROUPS,
  specValue,
  useProduct,
  useProductHistory,
  useProductMutation,
  type CardSpec,
  type CardView,
  type ProductDetail,
  type QpaLine,
} from "./product-api";

type Tab = "card" | "spec" | "bom" | "orders" | "history";

/** Old product URL: the Master Card now lives on its Father Code page. */
export function ProductDetailPage() {
  const { id = "" } = useParams();
  const product = useProduct(id);
  if (product.isPending) return <LoadingState />;
  if (product.error) return <ErrorState error={product.error} onRetry={() => void product.refetch()} />;
  return <Navigate to={`/bom/master-card/${product.data.id}`} replace />;
}

/**
 * Master Card of a Father Code's finished-good part, shown as a tab of the
 * Father Code page (BOM › Father Code › Master Card). Inner sections use the
 * `mc` search param so the page's own tab stays put.
 */
export function MasterCardPanel({ productId }: { productId: string }) {
  const [params, setParams] = useSearchParams();
  const tab = (params.get("mc") as Tab) || "card";
  const product = useProduct(productId);
  if (product.isPending) return <LoadingState />;
  if (product.error) return <ErrorState error={product.error} onRetry={() => void product.refetch()} />;
  const p = product.data;
  const shown = p.released ?? p.draft;
  const setTab = (t: Tab) =>
    setParams((prev) => {
      const next = new URLSearchParams(prev);
      if (t === "card") next.delete("mc");
      else next.set("mc", t);
      return next;
    });
  return (
    <>
      <div className="mb-4 flex flex-col gap-4 rounded-lg border border-line bg-surface p-4 sm:flex-row sm:items-center">
        <dl className="grid min-w-0 flex-1 grid-cols-2 gap-x-6 gap-y-2 text-sm lg:grid-cols-4">
          <div className="min-w-0">
            <dt className="text-xs text-muted">Finished-good part</dt>
            <dd>
              <Link to={`/master-data/part-master/${p.part.id}`} className="font-medium text-primary hover:underline">
                {p.productCode}
              </Link>
              <p className="truncate text-xs text-muted">{p.name}</p>
            </dd>
          </div>
          <div className="min-w-0">
            <dt className="text-xs text-muted">NMI No.</dt>
            <dd>{p.part.nmiNo ?? "—"}</dd>
          </div>
          <div className="min-w-0">
            <dt className="text-xs text-muted">In production</dt>
            <dd>{p.released ? <Badge tone="success">Master Card {rev(p.released.revisionNo)}</Badge> : <Badge tone="warning">No released Master Card</Badge>}</dd>
          </div>
          <div className="min-w-0">
            <dt className="text-xs text-muted">Status / unit</dt>
            <dd>
              <StatusBadge kind="record" value={p.status} /> <span className="ml-1">{p.uom}</span>
            </dd>
          </div>
        </dl>
      </div>
      <NextAction p={p} onTab={setTab} />
      <Tabs<Tab>
        value={tab}
        onChange={setTab}
        tabs={[
          { id: "card", label: "Master Card" },
          { id: "spec", label: "Specification" },
          { id: "bom", label: "Material Spec" },
          { id: "orders", label: `Orders (${p.orders.length})` },
          { id: "history", label: "History" },
        ]}
      />
      {tab === "card" && <MasterCardTab p={p} />}
      {tab === "spec" && (shown ? <SpecView spec={shown.spec} title={`Specification · Master Card ${rev(shown.revisionNo)} (${humanize(shown.status)})`} /> : <EmptyCard text="Draft a Master Card to record the specification." />)}
      {tab === "bom" && (shown ? <MaterialSpecView card={shown} /> : <EmptyCard text="Draft a Master Card to see its Material Spec." />)}
      {tab === "orders" && <OrdersView p={p} />}
      {tab === "history" && <HistoryView id={p.id} />}
    </>
  );
}

function EmptyCard({ text }: { text: string }) {
  return (
    <Card>
      <p className="py-6 text-center text-sm text-muted">{text}</p>
    </Card>
  );
}

/** One line telling the user what to do next with this product. */
function NextAction({
  p,
  onTab,
}: {
  p: ProductDetail;
  onTab: (t: Tab) => void;
}) {
  let text: string | null = null;
  if (p.status !== "ACTIVE")
    text = "This product is inactive: no new orders can use it.";
  else if (p.draft && p.draft.releaseProblems.length)
    text = `Master Card ${rev(p.draft.revisionNo)} is a draft. Complete it to release: ${p.draft.releaseProblems.join("; ")}.`;
  else if (p.draft)
    text = `Master Card ${rev(p.draft.revisionNo)} is ready to release. Orders keep using ${p.released ? rev(p.released.revisionNo) : "nothing"} until then.`;
  else if (!p.released)
    text =
      "No Master Card yet. Draft one, fill in the specification and release it before production orders can be created.";
  else if (p.fatherCode.newerThanReleased)
    text = `The Father Code has newer artwork or BOM revisions than Master Card ${rev(p.released.revisionNo)}. Draft a new revision to bring them into production.`;
  if (!text) return null;
  return (
    <div className="mb-4 flex flex-wrap items-center justify-between gap-2 rounded-lg bg-primary-soft px-4 py-3 text-sm">
      <span>
        <span className="font-semibold">Next · </span>
        {text}
      </span>
      <Button size="sm" onClick={() => onTab("card")}>
        Open Master Card
      </Button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Master Card tab
// ---------------------------------------------------------------------------

function MasterCardTab({ p }: { p: ProductDetail }) {
  const { can } = useAuth();
  const toast = useToast();
  const manage = can("bom.product.manage");
  const start = useProductMutation(() => api.post(`/products/${p.id}/cards`));
  return (
    <div className="space-y-4">
      {p.draft ? (
        <DraftEditor p={p} draft={p.draft} />
      ) : (
        manage &&
        p.status === "ACTIVE" && (
          <Card>
            <div className="flex flex-col items-start gap-3 sm:flex-row sm:items-center sm:justify-between">
              <p className="text-sm text-muted">
                {p.released
                  ? `Changing the specification, artwork, BOM or routing? Start a new draft. Production keeps using ${rev(p.released.revisionNo)} until the draft is released.`
                  : "Start the first Master Card. It takes the Father Code's current artwork and BOM revisions."}
              </p>
              <Button
                variant="primary"
                icon={<FilePlus2 className="size-4" />}
                loading={start.isPending}
                onClick={() =>
                  start.mutate(undefined, {
                    onSuccess: () => toast.success("Draft started."),
                    onError: toast.error,
                  })
                }
              >
                {p.released ? "New revision" : "Start Master Card"}
              </Button>
            </div>
          </Card>
        )
      )}
      {p.released && (
        <CardSummary
          p={p}
          card={p.released}
          title={`In production · Master Card ${rev(p.released.revisionNo)}`}
        />
      )}
      <Card title="All revisions">
        {p.cards.length === 0 ? (
          <p className="py-4 text-center text-sm text-muted">
            No Master Card revisions yet.
          </p>
        ) : (
          <>
            <ul className="divide-y divide-line text-sm sm:hidden">
              {p.cards.map((c) => (
                <li key={c.id} className="py-2">
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-medium">{rev(c.revisionNo)}</span>
                    <StatusBadge kind="card" value={c.status} />
                  </div>
                  <p className="text-xs text-muted">
                    Artwork {rev(c.artworkRevision)} · BOM{" "}
                    {c.componentRevision ? rev(c.componentRevision) : "—"}
                    {c.releasedAt
                      ? ` · released ${formatDate(c.releasedAt)}`
                      : ""}
                  </p>
                  {c.changeNote && <p className="text-xs">{c.changeNote}</p>}
                </li>
              ))}
            </ul>
            <div className="relative hidden overflow-x-auto sm:block">
              <table className="w-full text-left text-sm">
                <thead className="text-xs text-muted uppercase">
                  <tr>
                    <th className="px-2 py-2">Revision</th>
                    <th className="px-2 py-2">Artwork</th>
                    <th className="px-2 py-2">BOM</th>
                    <th className="px-2 py-2">Status</th>
                    <th className="hidden px-2 py-2 sm:table-cell">Change</th>
                    <th className="px-2 py-2">Released</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-line">
                  {p.cards.map((c) => (
                    <tr key={c.id}>
                      <td className="px-2 py-2 font-medium">
                        {rev(c.revisionNo)}
                      </td>
                      <td className="px-2 py-2">{rev(c.artworkRevision)}</td>
                      <td className="px-2 py-2">
                        {c.componentRevision ? rev(c.componentRevision) : "—"}
                      </td>
                      <td className="px-2 py-2">
                        <StatusBadge kind="card" value={c.status} />
                      </td>
                      <td className="hidden px-2 py-2 text-muted sm:table-cell">
                        {c.changeNote ?? "—"}
                      </td>
                      <td className="px-2 py-2 whitespace-nowrap">
                        {c.releasedAt
                          ? `${formatDate(c.releasedAt)}${c.releasedBy ? ` · ${c.releasedBy}` : ""}`
                          : "—"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
        <p className="mt-2 text-xs text-muted">
          A released revision never changes. Orders keep the revision they were
          created on.
        </p>
      </Card>
    </div>
  );
}

function CardSummary({ p, card, title }: { p: ProductDetail; card: CardView; title: string }) {
  const rows: [string, string, boolean][] = [
    [
      "Artwork",
      `${rev(card.artwork.revisionNo)} · ${card.artwork.labelDescription}`,
      card.artwork.current,
    ],
    [
      "BOM",
      card.component
        ? `${rev(card.component.revisionNo)} · ${card.component.lines.length} Son Codes`
        : "No component list",
      card.component?.current ?? false,
    ],
    [
      "Routing",
      card.routine
        ? `${card.routine.code} · ${card.routine.steps.join(" → ")}`
        : "Not set",
      true,
    ],
    [
      "Tooling",
      [
        card.die ? `Die ${card.die.code}` : card.spec.dieRef && `Die ${card.spec.dieRef}`,
        card.spec.plateRef && `Plates ${card.spec.plateRef}`,
      ]
        .filter(Boolean)
        .join(" · ") || "Not recorded",
      true,
    ],
  ];
  return (
    <Card title={title}>
      <CardHeader p={p} card={card} />
      <div className="grid gap-4 md:grid-cols-[10rem_minmax(0,1fr)]">
        <ArtworkPreview file={card.artwork.file} height="h-40" />
        <div className="min-w-0 space-y-3">
          <dl className="grid gap-x-4 gap-y-2 text-sm sm:grid-cols-[7rem_minmax(0,1fr)]">
            {rows.map(([k, v, current]) => (
              <div key={k} className="contents">
                <dt className="text-muted">{k}</dt>
                <dd className="min-w-0 break-words">
                  {v}
                  {(k === "Artwork" || k === "BOM") &&
                    !current &&
                    card.status !== "SUPERSEDED" && (
                      <Badge tone="warning" className="ml-2">
                        newer exists
                      </Badge>
                    )}
                </dd>
              </div>
            ))}
          </dl>
          <p className="text-xs text-muted">
            {card.releasedAt
              ? `Released ${formatDateTime(card.releasedAt)}${card.releasedBy ? ` by ${card.releasedBy}` : ""}`
              : `Drafted ${formatDateTime(card.createdAt)}${card.createdBy ? ` by ${card.createdBy}` : ""}`}
            {card.changeNote ? ` · ${card.changeNote}` : ""}
          </p>
        </div>
      </div>
    </Card>
  );
}

const toInput = (spec: CardSpec) =>
  Object.fromEntries(
    Object.entries(spec).map(([k, v]) => [
      k,
      v === undefined || v === null ? "" : String(v),
    ]),
  ) as Record<string, string>;

type SectionId = "header" | "afrf" | "spec" | "material" | "process" | "release";
/** The Master Card draft form, split into steps. `groups` are SPEC_GROUPS titles. */
const SECTIONS: { id: SectionId; label: string; groups: string[] }[] = [
  { id: "header", label: "Header", groups: ["Header", "Tooling and customer"] },
  { id: "afrf", label: "AFRF-CS", groups: ["AFRF-CS"] },
  { id: "spec", label: "Label & delivery", groups: ["Label", "Print and finishing", "Delivery"] },
  { id: "material", label: "Material Spec", groups: ["Die Cut Spec"] },
  { id: "process", label: "Process Detail", groups: [] },
  { id: "release", label: "Review & release", groups: [] },
];
/** Which section a server field path belongs to (for error dots and jumping). */
function sectionOfPath(path: string): SectionId | null {
  if (path === "routineId" || path.startsWith("spec.processDetail") || path.startsWith("spec.printingMachines")) return "process";
  if (path === "changeNote") return "release";
  if (path.startsWith("spec.bomDetail") || path === "spec.dieCutId") return "material";
  const key = path.replace(/^spec\./, "").split(".")[0];
  const group = SPEC_GROUPS.find((g) => g.fields.some((x) => x.key === key))?.title;
  return group ? (SECTIONS.find((x) => x.groups.includes(group))?.id ?? null) : null;
}

function DraftEditor({ p, draft }: { p: ProductDetail; draft: CardView }) {
  const { can } = useAuth();
  const toast = useToast();
  const routines = useRoutines();
  const [values, setValues] = useState<Record<string, string>>(() =>
    toInput(draft.spec),
  );
  const [routineId, setRoutineId] = useState(draft.routine?.id ?? "");
  const steps = routines.data?.find((r) => r.id === routineId)?.steps.map((x) => ({ seq: x.seq, process: x.process.name })) ?? (routineId === draft.routine?.id ? (draft.routine?.stepDetail ?? []) : []);
  const structs = useCardStructures(draft, draft.routine?.stepDetail ?? []);
  const stepKey = steps.map((x) => x.seq).join(",");
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => structs.resetProc(steps), [stepKey]);
  const [changeNote, setChangeNote] = useState(draft.changeNote ?? "");
  const [compare, setCompare] = useState(false);
  const [confirm, setConfirm] = useState<"release" | "discard" | null>(null);
  const { field, handle, setError, error } = useFormError();
  const manage = can("bom.product.manage");
  const [section, setSection] = useState<SectionId>("header");
  const index = SECTIONS.findIndex((x) => x.id === section);
  const current = SECTIONS[index]!;
  /** Sections holding a field the last save complained about. */
  const errorSections = new Set((error?.issues ?? []).map((i) => sectionOfPath(i.path)).filter((x): x is SectionId => !!x));
  const onSaveError = (e: unknown) => {
    handle(e);
    const first = e instanceof ApiError ? e.issues.map((i) => sectionOfPath(i.path)).find(Boolean) : undefined;
    if (first) setSection(first);
  };
  const renderGroup = (g: (typeof SPEC_GROUPS)[number]) => (
          <fieldset key={g.title} className="space-y-3">
            <legend className="mb-2 text-xs font-semibold tracking-wide text-muted uppercase">
              {g.title}
            </legend>
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              {g.fields.map((f) => (
                <Field
                  key={f.key}
                  label={f.unit ? `${f.label} (${f.unit})` : f.label}
                  required={f.required}
                  error={field(`spec.${f.key}`)}
                  className={
                    f.kind === "long" || f.kind === "winding"
                      ? "sm:col-span-2 lg:col-span-4"
                      : undefined
                  }
                >
                  {(props) =>
                    f.kind === "winding" ? (
                      <WindingPicker
                        value={values[f.key] ?? ""}
                        onChange={(v) => setValues((s) => ({ ...s, [f.key]: v }))}
                        disabled={!manage}
                      />
                    ) : f.kind === "long" ? (
                      <Textarea
                        {...props}
                        rows={2}
                        value={values[f.key] ?? ""}
                        onChange={(e) =>
                          setValues((v) => ({ ...v, [f.key]: e.target.value }))
                        }
                        disabled={!manage}
                      />
                    ) : (
                      <Input
                        {...props}
                        inputMode={
                          f.kind === "text"
                            ? undefined
                            : f.kind === "int"
                              ? "numeric"
                              : "decimal"
                        }
                        value={values[f.key] ?? ""}
                        onChange={(e) =>
                          setValues((v) => ({ ...v, [f.key]: e.target.value }))
                        }
                        disabled={!manage}
                      />
                    )
                  }
                </Field>
              ))}
            </div>
          </fieldset>
  );

  const buildSpec = () => {
    const spec: Record<string, string | number> = {};
    for (const g of SPEC_GROUPS)
      for (const f of g.fields) {
        const v = (values[f.key] ?? "").trim();
        if (!v) continue;
        spec[f.key] = f.kind === "number" || f.kind === "int" ? Number(v) : v;
      }
    return { ...spec, ...structs.build() };
  };
  const save = useProductMutation(
    (extra: { refreshRevisions?: boolean } = {}) =>
      api.patch(`/products/${p.id}/cards/${draft.id}`, {
        spec: buildSpec(),
        routineId: routineId || null,
        changeNote: changeNote || null,
        ...extra,
      }),
  );
  const release = useProductMutation(() =>
    api.post<{ revisionNo: number; superseded: number | null }>(
      `/products/${p.id}/cards/${draft.id}/release`,
    ),
  );
  const discard = useProductMutation(() =>
    api.delete(`/products/${p.id}/cards/${draft.id}`),
  );
  const submit = (e: FormEvent) => {
    e.preventDefault();
    save.mutate(
      {},
      {
        onSuccess: () => (setError(null), toast.success("Draft saved.")),
        onError: onSaveError,
      },
    );
  };

  return (
    <Card
      title={
        <span className="flex flex-wrap items-center gap-2">
          Master Card {rev(draft.revisionNo)}{" "}
          <StatusBadge kind="card" value="DRAFT" />
        </span>
      }
    >
      <div className="mb-4 grid gap-2 text-sm sm:grid-cols-2">
        <div className="flex items-center gap-2 rounded-md border border-line p-2">
          <ArtworkThumb file={draft.artwork.file} className="size-10" />
          <span className="min-w-0">
            Artwork {rev(draft.artwork.revisionNo)}{" "}
            {!draft.artwork.current && (
              <Badge tone="warning">newer exists</Badge>
            )}
            <span className="block truncate text-xs text-muted">
              {draft.artwork.labelDescription}
            </span>
          </span>
        </div>
        <div className="rounded-md border border-line p-2">
          BOM {draft.component ? rev(draft.component.revisionNo) : "—"}{" "}
          {draft.component && !draft.component.current && (
            <Badge tone="warning">newer exists</Badge>
          )}
          <span className="block text-xs text-muted">
            {draft.component
              ? `${draft.component.lines.length} Son Codes`
              : "The Father Code has no component list yet"}
          </span>
        </div>
      </div>
      <CardHeader p={p} card={draft} />
      <form onSubmit={submit} noValidate>
        {/* Step bar */}
        <nav aria-label="Master Card sections" className="relative mb-5 overflow-x-auto">
          <ol className="flex min-w-max gap-1.5">
            {SECTIONS.map((sec, i) => {
              const on = section === sec.id;
              const bad = errorSections.has(sec.id);
              return (
                <li key={sec.id}>
                  <button
                    type="button"
                    onClick={() => setSection(sec.id)}
                    aria-current={on ? "step" : undefined}
                    className={`flex items-center gap-2 rounded-full border px-3 py-1.5 text-sm transition ${on ? "border-primary bg-primary text-white" : "border-line bg-surface hover:border-primary/60"}`}
                  >
                    <span className={`grid size-5 place-items-center rounded-full text-xs font-bold ${on ? "bg-white text-primary" : "bg-surface-2"}`}>{i + 1}</span>
                    <span className="whitespace-nowrap">{sec.label}</span>
                    {bad && <span className="size-2 rounded-full bg-danger" aria-label="has errors" />}
                  </button>
                </li>
              );
            })}
          </ol>
        </nav>

        <div className="space-y-5">
          {current.groups.map((title) => {
            const g = SPEC_GROUPS.find((x) => x.title === title);
            return g ? renderGroup(g) : null;
          })}

          {section === "material" && <MaterialSpecEditor draft={draft} s={structs} field={field} disabled={!manage} />}

          {section === "process" && (
            <>
              <Field label="Routing (Routine Code)" hint="From Routine Master. New Job Orders for this part use it as their process route; its steps appear below." error={field("routineId")}>
                {(props) => (
                  <Select {...props} value={routineId} onChange={(e) => setRoutineId(e.target.value)} disabled={!manage}>
                    <option value="">Not set</option>
                    {routines.data
                      ?.filter((r) => r.status === "ACTIVE" || r.id === routineId)
                      .map((r) => (
                        <option key={r.id} value={r.id}>
                          {r.code} – {r.steps.map((s) => s.process.name).join(" → ")}
                        </option>
                      ))}
                  </Select>
                )}
              </Field>
              <ProcessEditor steps={steps} s={structs} field={field} disabled={!manage} />
            </>
          )}

          {section === "release" && (
            <>
              <Field label="What changed" hint="Shown in the revision list and the audit trail." error={field("changeNote")}>
                {(props) => <Input {...props} value={changeNote} onChange={(e) => setChangeNote(e.target.value)} disabled={!manage} />}
              </Field>
              {draft.releaseProblems.length > 0 ? (
                <ul className="space-y-1 rounded-md bg-warning-soft p-3 text-sm text-warning">
                  {draft.releaseProblems.map((x) => (
                    <li key={x} className="flex gap-2">
                      <AlertTriangle className="mt-0.5 size-4 shrink-0" /> {x}
                    </li>
                  ))}
                  <li className="text-xs">Save the draft after filling these in; the list updates.</li>
                </ul>
              ) : (
                <p className="flex items-center gap-2 text-sm text-success">
                  <CheckCircle2 className="size-4" /> Ready to release (based on the last save).
                </p>
              )}
              {manage && (
                <div className="flex flex-wrap gap-2">
                  <Button
                    icon={<RefreshCw className="size-4" />}
                    onClick={() =>
                      save.mutate(
                        { refreshRevisions: true },
                        { onSuccess: () => toast.success("Draft now uses the Father Code's current artwork and BOM revisions."), onError: onSaveError },
                      )
                    }
                  >
                    Use latest artwork + BOM
                  </Button>
                  {p.released && <Button onClick={() => setCompare((c) => !c)}>{compare ? "Hide comparison" : `Compare with ${rev(p.released.revisionNo)}`}</Button>}
                  {can("bom.mastercard.release") && (
                    <Button variant="primary" disabled={draft.releaseProblems.length > 0} onClick={() => setConfirm("release")}>
                      Release {rev(draft.revisionNo)}
                    </Button>
                  )}
                  <div className="flex-1" />
                  <Button variant="danger" onClick={() => setConfirm("discard")}>
                    Discard draft
                  </Button>
                </div>
              )}
              {compare && p.released && <CompareView from={p.released} to={{ ...draft, spec: buildSpec() as CardSpec }} />}
            </>
          )}
        </div>

        {/* Sticky action bar: move between sections, save any time. */}
        <div className="sticky bottom-0 z-10 -mx-4 -mb-4 mt-6 flex flex-wrap items-center gap-2 rounded-b-lg border-t border-line bg-surface px-4 py-3">
          <Button disabled={index === 0} onClick={() => setSection(SECTIONS[index - 1]!.id)}>
            Back
          </Button>
          <span className="text-xs text-muted">
            Step {index + 1} of {SECTIONS.length} · {current.label}
          </span>
          <div className="flex-1" />
          {manage && (
            <Button type="submit" variant={index === SECTIONS.length - 1 ? "primary" : "secondary"} loading={save.isPending}>
              Save draft
            </Button>
          )}
          {index < SECTIONS.length - 1 && (
            <Button variant="primary" onClick={() => setSection(SECTIONS[index + 1]!.id)}>
              Next: {SECTIONS[index + 1]!.label}
            </Button>
          )}
        </div>
      </form>
      <ConfirmDialog
        open={confirm === "release"}
        title={`Release Master Card ${rev(draft.revisionNo)}?`}
        message={`New Production Job Orders for ${p.productCode} will use it${p.released ? ` instead of ${rev(p.released.revisionNo)}` : ""}. Orders already created keep their revision. A released revision can't be edited.`}
        confirmLabel="Release"
        busy={release.isPending}
        onConfirm={() =>
          release.mutate(undefined, {
            onSuccess: (r) => (
              toast.success(`Master Card ${rev(r.revisionNo)} released.`),
              setConfirm(null)
            ),
            onError: (e) => (toast.error(e), setConfirm(null)),
          })
        }
        onClose={() => setConfirm(null)}
      />
      <ConfirmDialog
        open={confirm === "discard"}
        title={`Discard draft ${rev(draft.revisionNo)}?`}
        message="The draft is deleted. Released revisions are not affected."
        confirmLabel="Discard"
        tone="danger"
        busy={discard.isPending}
        onConfirm={() =>
          discard.mutate(undefined, {
            onSuccess: () => (
              toast.success("Draft discarded."),
              setConfirm(null)
            ),
            onError: toast.error,
          })
        }
        onClose={() => setConfirm(null)}
      />
    </Card>
  );
}

function CompareView({ from, to }: { from: CardView; to: CardView }) {
  const lines: { label: string; before: string; after: string }[] = [];
  if (from.artwork.revisionNo !== to.artwork.revisionNo)
    lines.push({
      label: "Artwork",
      before: rev(from.artwork.revisionNo),
      after: rev(to.artwork.revisionNo),
    });
  if ((from.component?.revisionNo ?? 0) !== (to.component?.revisionNo ?? 0))
    lines.push({
      label: "BOM",
      before: from.component ? rev(from.component.revisionNo) : "—",
      after: to.component ? rev(to.component.revisionNo) : "—",
    });
  if ((from.routine?.id ?? "") !== (to.routine?.id ?? ""))
    lines.push({
      label: "Routing",
      before: from.routine?.code ?? "—",
      after: to.routine?.code ?? "—",
    });
  for (const g of SPEC_GROUPS)
    for (const f of g.fields) {
      const a = specValue(f, from.spec[f.key]);
      const b = specValue(f, to.spec[f.key]);
      if (a !== b) lines.push({ label: f.label, before: a, after: b });
    }
  return (
    <div className="rounded-md bg-info-soft p-3 text-sm">
      <p className="mb-2 font-medium text-info">
        Changes from {rev(from.revisionNo)} to this draft{" "}
        {lines.length === 0 && "· none"}
      </p>
      <ul className="space-y-1">
        {lines.map((l) => (
          <li key={l.label} className="flex flex-wrap gap-x-2">
            <span className="text-muted">{l.label}:</span>
            <span className="line-through decoration-danger">{l.before}</span>
            <span>→</span>
            <span className="font-medium">{l.after}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Other tabs
// ---------------------------------------------------------------------------

function SpecView({ spec, title }: { spec: CardSpec; title: string }) {
  return (
    <Card title={title}>
      <div className="grid gap-6 md:grid-cols-2">
        {SPEC_GROUPS.map((g) => (
          <div key={g.title} className="min-w-0">
            <h3 className="mb-2 text-xs font-semibold tracking-wide text-muted uppercase">
              {g.title}
            </h3>
            <dl className="divide-y divide-line text-sm">
              {g.fields.map((f) => (
                <div
                  key={f.key}
                  className="grid grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)_auto] items-start gap-2 py-1.5"
                >
                  <dt className="text-muted">{f.label}</dt>
                  <dd className="min-w-0 break-words">
                    {f.kind === "winding" && spec.winding ? (
                      <span className="flex items-center gap-2">
                        <WindingIcon position={Number(spec.winding)} className="h-28 w-auto shrink-0 rounded border border-line bg-white p-1" />
                        {specValue(f, spec[f.key])}
                      </span>
                    ) : (
                      specValue(f, spec[f.key])
                    )}
                  </dd>
                  <dd>
                    <Badge className="!text-[11px]">{f.owner}</Badge>
                  </dd>
                </div>
              ))}
            </dl>
          </div>
        ))}
      </div>
      <p className="mt-3 text-xs text-muted">
        Each attribute shows the record that owns it. Quantity, due date and
        roll count belong to the order, not the Master Card.
      </p>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Master Card header, Material Spec (BOM detail + Die Cut Spec + QPA), Process Detail
// ---------------------------------------------------------------------------

/** TBS header: NMI No., Part Code, Artwork No., H × W, customer, prepared / approved. */
function CardHeader({ p, card }: { p: ProductDetail; card: CardView }) {
  const s = card.spec;
  const rows: [string, string][] = [
    ["NMI No.", p.part.nmiNo ?? "—"],
    ["Part Code", p.productCode],
    ["Artwork No.", `${p.fatherCode.fatherCode} · Artwork ${rev(card.artwork.revisionNo)}`],
    ["Measurement H × W", s.labelHeightMm && s.labelWidthMm ? `${s.labelHeightMm} × ${s.labelWidthMm} mm` : "—"],
    ["Customer code", s.customerCode ?? "—"],
    ["Customer part code", s.customerPartCode ?? "—"],
    ["End user", s.endUser ?? "—"],
    ["Prepared by", card.createdBy ? `${card.createdBy} · ${formatDate(card.createdAt)}` : "—"],
    ["Approved by", card.releasedBy ? `${card.releasedBy} · ${formatDate(card.releasedAt)}` : card.status === "DRAFT" ? "On release" : "—"],
  ];
  return (
    <dl className="mb-4 grid gap-x-6 gap-y-1.5 rounded-md border border-line p-3 text-sm sm:grid-cols-[9rem_1fr_9rem_1fr]">
      {rows.map(([k, v]) => (
        <div key={k} className="contents">
          <dt className="text-muted">{k}</dt>
          <dd className="min-w-0 break-words">{v}</dd>
        </div>
      ))}
    </dl>
  );
}

const SOURCE_TONE = { MANUAL: "info", CALCULATED: "success", BOM: "neutral", MISSING: "danger" } as const;
const SOURCE_LABEL = { MANUAL: "Manual QPA", CALCULATED: "Calculated", BOM: "BOM quantity", MISSING: "Missing" } as const;
const fmtQpa = (n: number | null) => (n == null ? "—" : n.toLocaleString("en-US", { maximumFractionDigits: 6 }));

/** Die Cut Spec with the UPS / feed working, and the QPA rule list. */
function DieSpecBlock({ card }: { card: CardView }) {
  const d = card.dieSpec;
  return (
    <div className="rounded-md border border-line p-3 text-sm">
      <p className="mb-2 font-semibold">Die Cut Spec</p>
      <dl className="grid gap-x-6 gap-y-1.5 sm:grid-cols-[9rem_1fr_9rem_1fr]">
        <dt className="text-muted">Die Cut Code</dt>
        <dd>{card.die ? `${card.die.code} · ${card.die.description}` : "—"}</dd>
        <dt className="text-muted">Feed length</dt>
        <dd>
          {d.feedLengthMm != null ? `${d.feedLengthMm} mm` : "—"}
          {d.feedLengthFrom === "die repeat" && <span className="text-xs text-muted"> (from the die repeat)</span>}
        </dd>
        <dt className="text-muted">Feed UPS</dt>
        <dd>
          {d.feedUps ?? "—"}
          {d.feedUpsFormula && <span className="block text-xs text-muted">{d.feedUpsFormula}</span>}
        </dd>
        <dt className="text-muted">Actual UPS</dt>
        <dd>{d.actualUps ?? "—"}</dd>
        <dt className="text-muted">Sample count</dt>
        <dd>{card.spec.sampleCount ?? "—"}</dd>
        <dt className="text-muted">QPA (web per label)</dt>
        <dd>{d.qpa != null ? `${fmtQpa(d.qpa)} mm` : "—"}</dd>
      </dl>
      <p className="mt-2 rounded bg-surface-2 px-2 py-1 font-mono text-xs">{d.formula}</p>
    </div>
  );
}

function QpaRules() {
  return (
    <details className="rounded-md bg-surface-2 p-3 text-xs">
      <summary className="cursor-pointer font-semibold">How QPA is calculated (check with the customer)</summary>
      <ul className="mt-2 list-disc space-y-1 pl-5">
        <li>QPA = quantity of the part used by 1 finished label (1 PCS), in the part's unit.</li>
        <li>Feed length = web travel per die repeat (default: the die's repeat). Feed UPS = die across × around; Actual UPS defaults to Feed UPS.</li>
        <li>
          Web parts in m²: <span className="font-mono">width (mm) × feed length (mm) ÷ actual UPS ÷ 1,000,000</span>. Width = the line width here, else the part's width in Part Master.
        </li>
        <li>
          Web parts in m: <span className="font-mono">feed length (mm) ÷ actual UPS ÷ 1,000</span>.
        </li>
        <li>
          Cores: <span className="font-mono">1 ÷ labels per roll</span>. Packaging: <span className="font-mono">1 ÷ (labels per roll × rolls per carton)</span>.
        </li>
        <li>Other units (ink in kg, foil rolls…): the BOM quantity. A Manual QPA always replaces the calculated value.</li>
        <li>No waste or make-ready allowance is added yet.</li>
      </ul>
    </details>
  );
}

function QpaTable({ lines }: { lines: QpaLine[] }) {
  if (!lines.length) return <p className="py-4 text-center text-sm text-muted">The Father Code has no Son Codes yet.</p>;
  return (
    <ul className="divide-y divide-line">
      {lines.map((l) => (
        <li key={l.sonCode} className="py-2.5 text-sm">
          <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
            <span className="font-medium">{l.sonCode}</span>
            <span>{l.materialCode}</span>
            <span className="min-w-0 flex-1 truncate text-xs text-muted">{l.materialDescription}</span>
            <span className="font-medium tabular-nums">
              QPA {fmtQpa(l.qpa)} {l.uom}
            </span>
            <Badge tone={SOURCE_TONE[l.source]}>{SOURCE_LABEL[l.source]}</Badge>
          </div>
          <p className="mt-0.5 text-xs text-muted">
            W {l.widthMm ?? "—"} · L {l.lengthMm ?? "—"} · H/Ø {l.heightMm ?? "—"} mm · BOM qty {l.bomQty ?? "—"}
            {l.manualQpa != null && l.calculated != null ? ` · calculated ${fmtQpa(l.calculated)} (replaced by Manual QPA)` : ""}
          </p>
          <p className="mt-1 rounded bg-surface-2 px-2 py-1 font-mono text-xs">{l.formula}</p>
        </li>
      ))}
    </ul>
  );
}

/** Read-only Material Spec + Process Detail of a card. */
function MaterialSpecView({ card }: { card: CardView }) {
  const cats = useMachineCategories();
  const machines = useMachines();
  const catName = (id?: string | null) => cats.data?.find((c) => c.id === id)?.code ?? "—";
  const machName = (id?: string | null) => machines.data?.find((m) => m.id === id)?.code ?? "—";
  const steps = card.routine?.stepDetail ?? [];
  const detail = new Map((card.spec.processDetail ?? []).map((r) => [r.seq, r]));
  return (
    <div className="space-y-4">
      <Card title={`Material Spec · Master Card ${rev(card.revisionNo)}${card.component ? ` · BOM ${rev(card.component.revisionNo)}` : ""}`}>
        <div className="space-y-4">
          <DieSpecBlock card={card} />
          <div>
            <p className="mb-1 text-sm font-semibold">BOM Detail</p>
            <QpaTable lines={card.qpa} />
          </div>
          <QpaRules />
        </div>
      </Card>
      <Card title={`Process Detail${card.routine ? ` · ${card.routine.code} – ${card.routine.name}` : ""}`}>
        {!card.routine ? (
          <p className="py-4 text-center text-sm text-muted">No routine on this card.</p>
        ) : (
          <div className="relative overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="text-xs text-muted uppercase">
                <tr>
                  <th className="px-2 py-2">Seq</th>
                  <th className="px-2 py-2">Process</th>
                  <th className="px-2 py-2">Machine category</th>
                  <th className="px-2 py-2">Default machine</th>
                  <th className="px-2 py-2 text-right">Setup (min)</th>
                  <th className="px-2 py-2 text-right">Output / press</th>
                  <th className="px-2 py-2 text-right">No. of print</th>
                  <th className="px-2 py-2 text-right">Speed</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {steps.map((st) => {
                  const r = detail.get(st.seq);
                  return (
                    <tr key={st.seq}>
                      <td className="px-2 py-2">{st.seq}</td>
                      <td className="px-2 py-2">{st.process}</td>
                      <td className="px-2 py-2">{catName(r?.machineCategoryId)}</td>
                      <td className="px-2 py-2">{machName(r?.defaultMachineId)}</td>
                      <td className="px-2 py-2 text-right tabular-nums">{r?.setupMins ?? "—"}</td>
                      <td className="px-2 py-2 text-right tabular-nums">{r?.outputPerPress ?? "—"}</td>
                      <td className="px-2 py-2 text-right tabular-nums">{r?.noOfPrint ?? "—"}</td>
                      <td className="px-2 py-2 text-right whitespace-nowrap tabular-nums">{r?.speed != null ? `${r.speed} ${r.speedUom ?? ""}` : "—"}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        {(card.spec.printingMachines ?? []).length > 0 && (
          <div className="mt-4">
            <p className="mb-1 text-sm font-semibold">Printing machine</p>
            <ul className="divide-y divide-line text-sm">
              {card.spec.printingMachines!.map((m, i) => (
                <li key={i} className="flex flex-wrap gap-x-4 py-1.5">
                  <span className="font-medium">{machName(m.machineId)}</span>
                  <span className="text-muted">{catName(m.machineCategoryId)}</span>
                  <span>{m.noOfPrint ?? "—"} print</span>
                  <span>setup {m.setupMins ?? "—"} min</span>
                  <span>{m.outputPerPress ?? "—"} / press</span>
                  <span>speed {m.speed ?? "—"}</span>
                </li>
              ))}
            </ul>
          </div>
        )}
      </Card>
    </div>
  );
}

const numOrNull = (v: string) => (v.trim() === "" ? null : Number(v));
const str = (v: number | null | undefined) => (v == null ? "" : String(v));

type BomRow = { sonCode: string; widthMm: string; lengthMm: string; heightMm: string; manualQpa: string };
type ProcRow = { seq: number; machineCategoryId: string; defaultMachineId: string; setupMins: string; outputPerPress: string; noOfPrint: string; speed: string; speedUom: string };
type PrintRow = { machineCategoryId: string; machineId: string; noOfPrint: string; setupMins: string; outputPerPress: string; speed: string };

/** Draft editors for the structured parts of the card; parent keeps the state. */
function useCardStructures(draft: CardView, routineSteps: { seq: number; process: string }[]) {
  const bomInit = (): BomRow[] => {
    const saved = new Map((draft.spec.bomDetail ?? []).map((b) => [b.sonCode, b]));
    return draft.qpa.map((l) => {
      const b = saved.get(l.sonCode);
      return { sonCode: l.sonCode, widthMm: str(b?.widthMm), lengthMm: str(b?.lengthMm), heightMm: str(b?.heightMm), manualQpa: str(b?.manualQpa) };
    });
  };
  const procFrom = (steps: { seq: number }[], prev: ProcRow[] = []): ProcRow[] => {
    const saved = new Map((draft.spec.processDetail ?? []).map((r) => [r.seq, r]));
    const kept = new Map(prev.map((r) => [r.seq, r]));
    return steps.map(({ seq }) => {
      const k = kept.get(seq);
      if (k) return k;
      const r = saved.get(seq);
      return { seq, machineCategoryId: r?.machineCategoryId ?? "", defaultMachineId: r?.defaultMachineId ?? "", setupMins: str(r?.setupMins), outputPerPress: str(r?.outputPerPress), noOfPrint: str(r?.noOfPrint), speed: str(r?.speed), speedUom: r?.speedUom ?? "" };
    });
  };
  const [bom, setBom] = useState<BomRow[]>(bomInit);
  const [proc, setProc] = useState<ProcRow[]>(() => procFrom(routineSteps));
  const [prints, setPrints] = useState<PrintRow[]>(() =>
    (draft.spec.printingMachines ?? []).map((m) => ({ machineCategoryId: m.machineCategoryId ?? "", machineId: m.machineId ?? "", noOfPrint: str(m.noOfPrint), setupMins: str(m.setupMins), outputPerPress: str(m.outputPerPress), speed: str(m.speed) })),
  );
  const [dieCutId, setDieCutId] = useState(draft.spec.dieCutId ?? "");
  const build = () => ({
    ...(dieCutId ? { dieCutId } : {}),
    bomDetail: bom
      .map((b) => ({ sonCode: b.sonCode, widthMm: numOrNull(b.widthMm), lengthMm: numOrNull(b.lengthMm), heightMm: numOrNull(b.heightMm), manualQpa: numOrNull(b.manualQpa) }))
      .filter((b) => b.widthMm != null || b.lengthMm != null || b.heightMm != null || b.manualQpa != null),
    processDetail: proc
      .map((r) => ({
        seq: r.seq,
        machineCategoryId: r.machineCategoryId || null,
        defaultMachineId: r.defaultMachineId || null,
        setupMins: numOrNull(r.setupMins),
        outputPerPress: numOrNull(r.outputPerPress),
        noOfPrint: numOrNull(r.noOfPrint),
        speed: numOrNull(r.speed),
        speedUom: r.speedUom || null,
      }))
      .filter((r) => r.machineCategoryId || r.defaultMachineId || r.setupMins != null || r.outputPerPress != null || r.noOfPrint != null || r.speed != null),
    printingMachines: prints.map((m) => ({ machineCategoryId: m.machineCategoryId || null, machineId: m.machineId || null, noOfPrint: numOrNull(m.noOfPrint), setupMins: numOrNull(m.setupMins), outputPerPress: numOrNull(m.outputPerPress), speed: numOrNull(m.speed) })),
  });
  return { bom, setBom, proc, setProc, resetProc: (steps: { seq: number }[]) => setProc((p) => procFrom(steps, p)), prints, setPrints, dieCutId, setDieCutId, build };
}

function MaterialSpecEditor({ draft, s, field, disabled }: { draft: CardView; s: ReturnType<typeof useCardStructures>; field: (p: string) => string | undefined; disabled: boolean }) {
  const dies = useDieCuts({ page: 1, status: "ACTIVE" });
  const qpaOf = new Map(draft.qpa.map((l) => [l.sonCode, l]));
  const set = (i: number, k: keyof BomRow, v: string) => s.setBom((rows) => rows.map((r, j) => (j === i ? { ...r, [k]: v } : r)));
  return (
    <fieldset className="space-y-3">
      <legend className="mb-2 text-xs font-semibold tracking-wide text-muted uppercase">Material Spec – Engineering</legend>
      <Field label="Die Cut Code" error={field("spec.dieCutId")} hint="From Die Cut Master. Feed length and Feed UPS default from the die (Die Cut Spec fields above override).">
        {(props) => (
          <Select {...props} value={s.dieCutId} disabled={disabled} onChange={(e) => s.setDieCutId(e.target.value)}>
            <option value="">No die</option>
            {dies.data?.data.map((d) => (
              <option key={d.id} value={d.id}>
                {d.code} – {d.description} ({d.labelWidthMm} × {d.labelHeightMm} mm, {d.across} × {d.around})
              </option>
            ))}
          </Select>
        )}
      </Field>
      <DieSpecBlock card={draft} />
      <p className="text-sm font-semibold">BOM Detail</p>
      {!s.bom.length && <p className="text-sm text-muted">The Father Code has no Son Codes yet.</p>}
      <ul className="space-y-3">
        {s.bom.map((r, i) => {
          const l = qpaOf.get(r.sonCode)!;
          return (
            <li key={r.sonCode} className="rounded-md border border-line p-3">
              <div className="mb-2 flex flex-wrap items-baseline gap-x-3 text-sm">
                <span className="font-medium">{r.sonCode}</span>
                <span>{l.materialCode}</span>
                <span className="min-w-0 flex-1 truncate text-xs text-muted">{l.materialDescription}</span>
                <span className="font-medium tabular-nums">
                  QPA {fmtQpa(l.qpa)} {l.uom}
                </span>
                <Badge tone={SOURCE_TONE[l.source]}>{SOURCE_LABEL[l.source]}</Badge>
              </div>
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                {(
                  [
                    ["widthMm", "Width (mm)"],
                    ["lengthMm", "Length (mm)"],
                    ["heightMm", "Height / Ø (mm)"],
                    ["manualQpa", `Manual QPA (${l.uom})`],
                  ] as const
                ).map(([k, label]) => (
                  <Field key={k} label={label} error={field(`spec.bomDetail.${i}.${k}`)}>
                    {(props) => <Input {...props} inputMode="decimal" value={r[k]} disabled={disabled} onChange={(e) => set(i, k, e.target.value)} placeholder={k === "widthMm" && l.widthMm != null && !r.widthMm ? String(l.widthMm) : undefined} />}
                  </Field>
                ))}
              </div>
              <p className="mt-2 rounded bg-surface-2 px-2 py-1 font-mono text-xs">{l.formula}</p>
            </li>
          );
        })}
      </ul>
      <p className="text-xs text-muted">QPA and formulas recalculate when the draft is saved.</p>
      <QpaRules />
    </fieldset>
  );
}

function ProcessEditor({ steps, s, field, disabled }: { steps: { seq: number; process: string }[]; s: ReturnType<typeof useCardStructures>; field: (p: string) => string | undefined; disabled: boolean }) {
  const cats = useMachineCategories();
  const machines = useMachines();
  const setP = (i: number, k: keyof ProcRow, v: string) => s.setProc((rows) => rows.map((r, j) => (j === i ? { ...r, [k]: v, ...(k === "machineCategoryId" ? { defaultMachineId: "" } : {}) } : r)));
  const setM = (i: number, k: keyof PrintRow, v: string) => s.setPrints((rows) => rows.map((r, j) => (j === i ? { ...r, [k]: v, ...(k === "machineCategoryId" ? { machineId: "" } : {}) } : r)));
  const machineOptions = (catId: string) => machines.data?.filter((m) => m.isActive && (!catId || m.categoryId === catId)) ?? [];
  return (
    <fieldset className="space-y-3">
      <legend className="mb-2 text-xs font-semibold tracking-wide text-muted uppercase">Process Detail – Engineering</legend>
      {!steps.length && <p className="text-sm text-muted">Choose a routine (Routing) to fill in the process detail.</p>}
      <ul className="space-y-3">
        {s.proc.map((r, i) => (
          <li key={r.seq} className="rounded-md border border-line p-3">
            <p className="mb-2 text-sm font-medium">
              {r.seq}. {steps.find((x) => x.seq === r.seq)?.process}
            </p>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
              <Field label="Machine category" error={field(`spec.processDetail.${i}.machineCategoryId`)}>
                {(props) => (
                  <Select {...props} value={r.machineCategoryId} disabled={disabled} onChange={(e) => setP(i, "machineCategoryId", e.target.value)}>
                    <option value="">—</option>
                    {cats.data?.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.code}
                      </option>
                    ))}
                  </Select>
                )}
              </Field>
              <Field label="Default machine" error={field(`spec.processDetail.${i}.defaultMachineId`)}>
                {(props) => (
                  <Select {...props} value={r.defaultMachineId} disabled={disabled} onChange={(e) => setP(i, "defaultMachineId", e.target.value)}>
                    <option value="">—</option>
                    {machineOptions(r.machineCategoryId).map((m) => (
                      <option key={m.id} value={m.id}>
                        {m.code}
                      </option>
                    ))}
                  </Select>
                )}
              </Field>
              {(
                [
                  ["setupMins", "Setup time (min)"],
                  ["outputPerPress", "Output per press"],
                  ["noOfPrint", "No. of print"],
                  ["speed", "Speed"],
                  ["speedUom", "Speed UOM"],
                ] as const
              ).map(([k, label]) => (
                <Field key={k} label={label} error={field(`spec.processDetail.${i}.${k}`)}>
                  {(props) => <Input {...props} inputMode={k === "speedUom" ? undefined : "decimal"} value={r[k]} disabled={disabled} onChange={(e) => setP(i, k, e.target.value)} placeholder={k === "speedUom" ? "m/min" : undefined} />}
                </Field>
              ))}
            </div>
          </li>
        ))}
      </ul>
      <p className="text-sm font-semibold">Printing machine</p>
      <ul className="space-y-2">
        {s.prints.map((m, i) => (
          <li key={i} className="grid grid-cols-2 items-end gap-2 sm:grid-cols-[repeat(6,minmax(0,1fr))_auto]">
            <Field label="Machine category">
              {(props) => (
                <Select {...props} value={m.machineCategoryId} disabled={disabled} onChange={(e) => setM(i, "machineCategoryId", e.target.value)}>
                  <option value="">—</option>
                  {cats.data?.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.code}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
            <Field label="Machine code" error={field(`spec.printingMachines.${i}.machineId`)}>
              {(props) => (
                <Select {...props} value={m.machineId} disabled={disabled} onChange={(e) => setM(i, "machineId", e.target.value)}>
                  <option value="">—</option>
                  {machineOptions(m.machineCategoryId).map((x) => (
                    <option key={x.id} value={x.id}>
                      {x.code}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
            {(
              [
                ["noOfPrint", "No. of print"],
                ["setupMins", "Setup (min)"],
                ["outputPerPress", "Output / press"],
                ["speed", "Speed"],
              ] as const
            ).map(([k, label]) => (
              <Field key={k} label={label}>
                {(props) => <Input {...props} inputMode="decimal" value={m[k]} disabled={disabled} onChange={(e) => setM(i, k, e.target.value)} />}
              </Field>
            ))}
            {!disabled && <Button size="sm" variant="ghost" icon={<Trash2 className="size-4" />} aria-label="Remove printing machine" onClick={() => s.setPrints((rows) => rows.filter((_, j) => j !== i))} />}
          </li>
        ))}
      </ul>
      {!disabled && (
        <Button size="sm" icon={<Plus className="size-4" />} onClick={() => s.setPrints((rows) => [...rows, { machineCategoryId: "", machineId: "", noOfPrint: "", setupMins: "", outputPerPress: "", speed: "" }])}>
          Add printing machine
        </Button>
      )}
    </fieldset>
  );
}

function OrdersView({ p }: { p: ProductDetail }) {
  return (
    <Card title="Production Job Orders">
      {p.orders.length === 0 ? (
        <p className="py-4 text-center text-sm text-muted">
          No Production Job Orders yet
          {p.released ? "." : ". Release a Master Card first."}
        </p>
      ) : (
        <ul className="divide-y divide-line text-sm">
          {p.orders.map((o) => (
            <li key={o.id} className="flex flex-wrap items-center gap-3 py-2">
              <Link
                to={`/planning/production-job-order/${o.id}`}
                className="font-medium text-primary hover:underline"
              >
                {o.pjoNo}
              </Link>
              <span className="tabular-nums text-muted">
                {o.orderQty} {o.uom}
              </span>
              {o.cardRevisionNo && (
                <Badge
                  tone={
                    o.cardRevisionNo === p.currentCardRevNo ? "info" : "warning"
                  }
                >
                  Master Card {rev(o.cardRevisionNo)}
                </Badge>
              )}
              <span className="text-muted">{formatDate(o.requiredDate)}</span>
              <span className="flex-1" />
              <StatusBadge kind="pjo" value={o.status} />
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

function HistoryView({ id }: { id: string }) {
  const history = useProductHistory(id, true);
  if (history.isPending) return <LoadingState />;
  if (history.error)
    return (
      <ErrorState
        error={history.error}
        onRetry={() => void history.refetch()}
      />
    );
  return (
    <Card title="History">
      {history.data.length === 0 ? (
        <p className="py-4 text-center text-sm text-muted">
          No changes recorded.
        </p>
      ) : (
        <ul className="divide-y divide-line text-sm">
          {history.data.map((h) => (
            <li key={h.id} className="py-2">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-medium">{humanize(h.action)}</span>
                <span className="text-muted">
                  {formatDateTime(h.occurredAt)} · {h.userName ?? "System"}
                </span>
              </div>
              {h.remarks && <p className="text-muted">{h.remarks}</p>}
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

