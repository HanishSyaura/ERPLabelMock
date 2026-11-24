import { useQuery } from "@tanstack/react-query";
import { ChevronDown, ChevronRight, Pencil, Plus, RotateCcw, Trash2 } from "lucide-react";
import { useState, type ReactNode } from "react";
import { Link, useParams, useSearchParams } from "react-router";
import { EmptyState, ErrorState, LoadingState, PageHeader, Tabs } from "@/components/common";
import { Badge, Button, Card } from "@/components/ui";
import { PHASE_NAMES } from "@/config/navigation";
import { api } from "@/lib/api";
import { formatDateTime, humanize } from "@/lib/utils";
import { useAuth } from "@/stores/auth";
import { fileUrl, rev, useArtworkRevisions, useBom, useBomHistory, useComponentRevisions, type BomDetail, type ComponentLine, type ComponentRevision, type LineChange } from "./api";
import { ArtworkPreview, ArtworkThumb } from "./artwork";
import { AddSonCodesDialog, EditArtworkDialog, EditSonCodeDialog, NoteConfirmDialog } from "./bom-dialogs";

type Tab = "master-card" | "artwork" | "components" | "usage" | "history";

export function BomDetailPage() {
  const { id = "" } = useParams();
  const bom = useBom(id);
  if (bom.isPending) return <LoadingState />;
  if (bom.error) return <ErrorState error={bom.error} onRetry={() => void bom.refetch()} />;
  return <Detail bom={bom.data} />;
}

type Dialog =
  | { kind: "artwork" }
  | { kind: "status" }
  | { kind: "add" }
  | { kind: "edit"; line: ComponentLine }
  | { kind: "remove"; line: ComponentLine }
  | { kind: "restoreArtwork"; revisionNo: number }
  | { kind: "restoreComponents"; revisionNo: number };

function Detail({ bom }: { bom: BomDetail }) {
  const { can } = useAuth();
  const [params, setParams] = useSearchParams();
  const tab = (params.get("tab") as Tab) || "artwork";
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const close = () => setDialog(null);
  const active = bom.status === "ACTIVE";
  const compRev = bom.componentRevision?.revisionNo ?? 0;

  return (
    <>
      <PageHeader
        title={bom.fatherCode}
        description={bom.labelDescription}
        crumbs={[{ label: "BOM" }, { label: "Bill of Material", to: "/bom" }, { label: bom.fatherCode }]}
        actions={
          <>
            {can("bom.status") && (
              <Button onClick={() => setDialog({ kind: "status" })} variant={active ? "secondary" : "primary"}>
                {active ? "Deactivate" : "Activate"}
              </Button>
            )}
            {(can("bom.edit") || can("bom.artwork.upload")) && (
              <Button variant="primary" icon={<Pencil className="size-4" />} onClick={() => setDialog({ kind: "artwork" })}>
                Edit artwork
              </Button>
            )}
          </>
        }
      />

      {!active && (
        <div className="mb-4 rounded-lg border border-line bg-surface-2 px-4 py-3 text-sm text-muted">
          This Father Code is inactive: it can't be used for new Production Job Orders. History is kept.
        </div>
      )}

      {/* Section A – Artwork Information */}
      <Card title="Artwork Information" className="mb-4">
        <div className="grid gap-5 lg:grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)]">
          <ArtworkPreview file={bom.artwork.file} />
          <dl className="grid content-start gap-x-4 gap-y-3 text-sm sm:grid-cols-[9rem_1fr]">
            <Info label="Father Code">
              <span className="font-semibold">{bom.fatherCode}</span>
            </Info>
            <Info label="Label Description">{bom.labelDescription}</Info>
            <Info label="Artwork File">{bom.artwork.file.originalName}</Info>
            <Info label="Current Revision">
              <span className="flex flex-wrap gap-1.5">
                <Badge tone="primary">Artwork {rev(bom.artwork.revisionNo)}</Badge>
                <Badge tone="info">{compRev ? `BOM ${rev(compRev)}` : "No component list yet"}</Badge>
              </span>
            </Info>
            <Info label="Status">
              <Badge tone={active ? "success" : "neutral"}>{active ? "Active" : "Inactive"}</Badge>
            </Info>
            <Info label="Created">
              {formatDateTime(bom.createdAt)} · {bom.createdBy}
            </Info>
            <Info label="Last Updated">
              {formatDateTime(bom.updatedAt)} · {bom.updatedBy}
            </Info>
          </dl>
        </div>
      </Card>

      {/* Section B – BOM Component List */}
      <Card
        className="mb-6"
        title={
          <span>
            BOM Component List <span className="font-normal text-muted">· {bom.components.length} Son Code{bom.components.length === 1 ? "" : "s"}</span>
          </span>
        }
        actions={
          can("bom.son.add") && (
            <Button size="sm" variant="primary" icon={<Plus className="size-4" />} onClick={() => setDialog({ kind: "add" })}>
              Add Son Code
            </Button>
          )
        }
      >
        {bom.components.length === 0 ? (
          <EmptyState
            title="No Son Codes yet"
            description={can("bom.son.add") ? "Add the components used for this artwork. Description and unit come from the material list." : "No components have been added to this Father Code."}
          />
        ) : (
          <ComponentTable
            lines={bom.components}
            actions={(l) => (
              <div className="flex justify-end gap-1">
                {can("bom.son.edit") && <Button size="sm" variant="ghost" icon={<Pencil className="size-4" />} aria-label={`Edit ${l.sonCode}`} onClick={() => setDialog({ kind: "edit", line: l })} />}
                {can("bom.son.remove") && (
                  <Button size="sm" variant="ghost" icon={<Trash2 className="size-4 text-danger" />} aria-label={`Remove ${l.sonCode}`} onClick={() => setDialog({ kind: "remove", line: l })} />
                )}
              </div>
            )}
          />
        )}
        {bom.removedSonCount > 0 && (
          <p className="mt-3 text-xs text-muted">
            {bom.removedSonCount} removed Son Code{bom.removedSonCount === 1 ? " is" : "s are"} kept in the BOM revision history.
          </p>
        )}
      </Card>

      <Tabs<Tab>
        value={tab}
        onChange={(t) => setParams(t === "artwork" ? {} : { tab: t }, { replace: true })}
        tabs={[
          { id: "artwork", label: "Artwork revisions" },
          { id: "master-card", label: bom.finishedPart ? `Master Card · ${bom.finishedPart.code}` : "Master Card" },
          { id: "components", label: "BOM revisions" },
          { id: "usage", label: "Production usage" },
          { id: "history", label: "History" },
        ]}
      />
      {tab === "master-card" &&
        (bom.finishedPart ? (
          <Card>
            <div className="flex flex-col items-start gap-3 py-2 sm:flex-row sm:items-center sm:justify-between">
              <div className="text-sm">
                <p className="font-medium">Finished-good part {bom.finishedPart.code}</p>
                <p className="text-muted">{bom.finishedPart.currentCardRevNo ? `Master Card ${rev(bom.finishedPart.currentCardRevNo)} is released for production.` : "No Master Card released yet."} The card is maintained under BOM › Master Card.</p>
              </div>
              <Link to={`/bom/master-card/${bom.finishedPart.productId}`}>
                <Button variant="primary">Open Master Card</Button>
              </Link>
            </div>
          </Card>
        ) : (
          <Card>
            <div className="flex flex-col items-start gap-3 py-2 sm:flex-row sm:items-center sm:justify-between">
              <p className="text-sm text-muted">No finished-good part uses this Father Code yet. Create the part in Part Master with this Father Code as its Artwork No.; its Master Card then appears here.</p>
              {can("bom.material.manage") && (
                <Link to="/master-data/part-master?new=fg">
                  <Button variant="primary">New finished-good part</Button>
                </Link>
              )}
            </div>
          </Card>
        ))}
      {tab === "artwork" && <ArtworkRevisions bom={bom} onRestore={(n) => setDialog({ kind: "restoreArtwork", revisionNo: n })} />}
      {tab === "components" && <ComponentRevisions bom={bom} onRestore={(n) => setDialog({ kind: "restoreComponents", revisionNo: n })} />}
      {tab === "usage" && <ProductionUsage />}
      {tab === "history" && <History bomId={bom.id} />}

      {dialog?.kind === "artwork" && <EditArtworkDialog bom={bom} onClose={close} />}
      {dialog?.kind === "add" && <AddSonCodesDialog bom={bom} onClose={close} />}
      {dialog?.kind === "edit" && <EditSonCodeDialog bom={bom} line={dialog.line} onClose={close} />}
      {dialog?.kind === "remove" && (
        <NoteConfirmDialog
          title={`Remove ${dialog.line.sonCode}?`}
          message={`${dialog.line.materialCode} – ${dialog.line.materialDescription} is removed from the active BOM as a new component revision. Earlier revisions (and any production that used them) keep it. The Son Code is never reused.`}
          confirmLabel="Remove Son Code"
          tone="danger"
          run={(note) => api.post(`/boms/${bom.id}/son-codes/${dialog.line.sonCodeId}/remove`, { changeNote: note, expectedComponentRevNo: compRev })}
          success={`${dialog.line.sonCode} removed.`}
          onClose={close}
        />
      )}
      {dialog?.kind === "status" && (
        <NoteConfirmDialog
          title={active ? `Deactivate ${bom.fatherCode}?` : `Activate ${bom.fatherCode}?`}
          message={active ? "It can't be selected for new Production Job Orders. Existing jobs and all history stay as they are." : "It can be used for new Production Job Orders again."}
          confirmLabel={active ? "Deactivate" : "Activate"}
          tone={active ? "danger" : "primary"}
          run={(reason) => api.put(`/boms/${bom.id}/status`, { status: active ? "INACTIVE" : "ACTIVE", reason })}
          success={active ? `${bom.fatherCode} deactivated.` : `${bom.fatherCode} activated.`}
          onClose={close}
        />
      )}
      {dialog?.kind === "restoreArtwork" && (
        <NoteConfirmDialog
          title={`Restore artwork ${rev(dialog.revisionNo)}?`}
          message={`The artwork and label description of ${rev(dialog.revisionNo)} become current again, saved as artwork ${rev(bom.artwork.revisionNo + 1)}. Nothing is deleted. The Son Code list is not changed.`}
          confirmLabel="Restore"
          noteLabel="Change note"
          run={(note) => api.post(`/boms/${bom.id}/artwork-revisions/restore`, { revisionNo: dialog.revisionNo, changeNote: note, expectedRevNo: bom.artwork.revisionNo })}
          success={`Artwork ${rev(dialog.revisionNo)} restored as ${rev(bom.artwork.revisionNo + 1)}.`}
          onClose={close}
        />
      )}
      {dialog?.kind === "restoreComponents" && (
        <NoteConfirmDialog
          title={`Restore BOM ${rev(dialog.revisionNo)}?`}
          message={`The component list of ${rev(dialog.revisionNo)} becomes current again, saved as BOM ${rev(compRev + 1)}. Nothing is deleted. The artwork is not changed.`}
          confirmLabel="Restore"
          noteLabel="Change note"
          run={(note) => api.post(`/boms/${bom.id}/component-revisions/restore`, { revisionNo: dialog.revisionNo, changeNote: note, expectedRevNo: compRev })}
          success={`BOM ${rev(dialog.revisionNo)} restored as ${rev(compRev + 1)}.`}
          onClose={close}
        />
      )}
    </>
  );
}

const Info = ({ label, children }: { label: string; children: ReactNode }) => (
  <div className="contents">
    <dt className="text-muted">{label}</dt>
    <dd className="min-w-0 break-words">{children}</dd>
  </div>
);

function ComponentTable({ lines, actions }: { lines: (Omit<ComponentLine, "sonCodeId" | "materialId" | "status" | "materialActive"> & Partial<ComponentLine>)[]; actions?: (l: ComponentLine) => ReactNode }) {
  return (
    <div className="relative -mx-4 overflow-x-auto">
      <table className="w-full text-left text-sm">
        <thead className="bg-surface-2 text-xs font-medium tracking-wide text-muted uppercase">
          <tr>
            <th className="px-4 py-2">Son Code</th>
            <th className="px-3 py-2">Component / Material Code</th>
            <th className="px-3 py-2">Component / Material Description</th>
            <th className="px-3 py-2 text-right">Required Qty</th>
            <th className="px-3 py-2">Unit</th>
            <th className="hidden px-3 py-2 md:table-cell">Remarks</th>
            {actions && <th className="px-3 py-2">Status</th>}
            {actions && <th className="px-4 py-2" />}
          </tr>
        </thead>
        <tbody className="divide-y divide-line">
          {lines.map((l) => (
            <tr key={l.sonCode}>
              <td className="px-4 py-2 font-medium whitespace-nowrap">{l.sonCode}</td>
              <td className="px-3 py-2 whitespace-nowrap">{l.materialCode}</td>
              <td className="px-3 py-2">
                {l.materialDescription}
                {l.materialActive === false && (
                  <Badge tone="warning" className="ml-2">
                    Material inactive
                  </Badge>
                )}
              </td>
              <td className="px-3 py-2 text-right tabular-nums">{l.quantity ?? <span className="text-muted">—</span>}</td>
              <td className="px-3 py-2">{l.uom ?? <span className="text-muted">—</span>}</td>
              <td className="hidden max-w-xs px-3 py-2 text-muted md:table-cell">{l.remarks ?? "—"}</td>
              {actions && (
                <td className="px-3 py-2">
                  <Badge tone="success">Active</Badge>
                </td>
              )}
              {actions && <td className="px-4 py-2">{actions(l as ComponentLine)}</td>}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

const CHANGE_LABEL: Record<string, string> = {
  CREATED: "Created",
  ARTWORK_REPLACED: "Artwork replaced",
  DESCRIPTION_CHANGED: "Description changed",
  ARTWORK_AND_DESCRIPTION: "Artwork and description changed",
  RESTORED: "Restored",
  ADDED: "Son Codes added",
  MODIFIED: "Son Code modified",
  REMOVED: "Son Code removed",
};

function ArtworkRevisions({ bom, onRestore }: { bom: BomDetail; onRestore: (n: number) => void }) {
  const { can } = useAuth();
  const revs = useArtworkRevisions(bom.id);
  if (revs.isPending) return <LoadingState />;
  if (revs.error) return <ErrorState error={revs.error} onRetry={() => void revs.refetch()} />;
  return (
    <div className="space-y-2">
      {revs.data.map((r) => {
        const current = r.revisionNo === bom.artwork.revisionNo;
        return (
          <div key={r.revisionNo} className="flex min-w-0 flex-col gap-3 rounded-lg border border-line bg-surface p-3 sm:flex-row sm:items-center">
            <ArtworkThumb file={r.file} className="size-16" />
            <div className="min-w-0 flex-1">
              <p className="flex flex-wrap items-center gap-2 text-sm font-medium">
                Artwork {rev(r.revisionNo)}
                {current && <Badge tone="primary">Current</Badge>}
                <span className="font-normal text-muted">
                  {CHANGE_LABEL[r.changeType] ?? humanize(r.changeType)}
                  {r.restoredFromRevisionNo ? ` from ${rev(r.restoredFromRevisionNo)}` : ""}
                </span>
              </p>
              <p className="truncate text-sm">{r.labelDescription}</p>
              <p className="text-xs text-muted">
                {r.file.originalName} · {formatDateTime(r.createdAt)} · {r.createdBy}
                {r.changeNote ? ` · “${r.changeNote}”` : ""}
              </p>
            </div>
            <div className="flex shrink-0 gap-2">
              <a href={fileUrl(r.file.id, { download: true })}>
                <Button size="sm">Download</Button>
              </a>
              {!current && can("bom.artwork.revise") && (
                <Button size="sm" icon={<RotateCcw className="size-4" />} onClick={() => onRestore(r.revisionNo)}>
                  Restore
                </Button>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function changeSummary(r: ComponentRevision) {
  const parts = [];
  if (r.changes.added.length) parts.push(`${r.changes.added.length} added`);
  if (r.changes.modified.length) parts.push(`${r.changes.modified.length} modified`);
  if (r.changes.removed.length) parts.push(`${r.changes.removed.length} removed`);
  return parts.join(" · ");
}

const describe = (c: LineChange) =>
  [c.materialCode && `${c.materialCode}${c.materialDescription ? ` (${c.materialDescription})` : ""}`, c.quantity !== undefined && `qty ${c.quantity ?? "—"}`, c.uom !== undefined && `unit ${c.uom ?? "—"}`, c.remarks !== undefined && `remarks ${c.remarks ?? "—"}`]
    .filter(Boolean)
    .join(", ");

function ComponentRevisions({ bom, onRestore }: { bom: BomDetail; onRestore: (n: number) => void }) {
  const { can } = useAuth();
  const revs = useComponentRevisions(bom.id);
  const [open, setOpen] = useState<number | null>(null);
  if (revs.isPending) return <LoadingState />;
  if (revs.error) return <ErrorState error={revs.error} onRetry={() => void revs.refetch()} />;
  if (!revs.data.length) return <EmptyState title="No BOM revisions yet" description="The first revision is created when Son Codes are added." />;
  const current = bom.componentRevision?.revisionNo;
  return (
    <div className="space-y-2">
      {revs.data.map((r) => (
        <div key={r.revisionNo} className="rounded-lg border border-line bg-surface">
          <div className="flex flex-col gap-2 p-3 sm:flex-row sm:items-center">
            <button className="flex min-w-0 flex-1 items-start gap-2 text-left" onClick={() => setOpen(open === r.revisionNo ? null : r.revisionNo)} aria-expanded={open === r.revisionNo}>
              {open === r.revisionNo ? <ChevronDown className="mt-0.5 size-4 shrink-0" /> : <ChevronRight className="mt-0.5 size-4 shrink-0" />}
              <span className="min-w-0">
                <span className="flex flex-wrap items-center gap-2 text-sm font-medium">
                  BOM {rev(r.revisionNo)}
                  {r.revisionNo === current && <Badge tone="info">Current</Badge>}
                  <span className="font-normal text-muted">
                    {CHANGE_LABEL[r.changeType] ?? humanize(r.changeType)}
                    {r.restoredFromRevisionNo ? ` from ${rev(r.restoredFromRevisionNo)}` : ""} · {changeSummary(r)} · {r.lineCount} line{r.lineCount === 1 ? "" : "s"}
                  </span>
                </span>
                <span className="block text-xs text-muted">
                  {formatDateTime(r.createdAt)} · {r.createdBy}
                  {r.changeNote ? ` · “${r.changeNote}”` : ""}
                </span>
              </span>
            </button>
            {r.revisionNo !== current && can("bom.revision.manage") && (
              <Button size="sm" icon={<RotateCcw className="size-4" />} onClick={() => onRestore(r.revisionNo)}>
                Restore
              </Button>
            )}
          </div>
          {open === r.revisionNo && (
            <div className="space-y-3 border-t border-line p-3">
              <ul className="space-y-1 text-sm">
                {r.changes.added.map((c) => (
                  <li key={`a${c.sonCode}`}>
                    <Badge tone="success">Added</Badge> <span className="font-medium">{c.sonCode}</span> {describe(c)}
                  </li>
                ))}
                {r.changes.modified.map((c) => (
                  <li key={`m${c.sonCode}`}>
                    <Badge tone="warning">Modified</Badge> <span className="font-medium">{c.sonCode}</span> {describe(c.before)} → {describe(c.after)}
                  </li>
                ))}
                {r.changes.removed.map((c) => (
                  <li key={`r${c.sonCode}`}>
                    <Badge tone="danger">Removed</Badge> <span className="font-medium">{c.sonCode}</span> {describe(c)}
                  </li>
                ))}
              </ul>
              <RevisionLines bomId={bom.id} revisionNo={r.revisionNo} />
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

function RevisionLines({ bomId, revisionNo }: { bomId: string; revisionNo: number }) {
  const q = useQuery({
    queryKey: ["boms", "detail", bomId, "components", revisionNo],
    queryFn: () => api.get<{ lines: LineChange[] }>(`/boms/${bomId}/component-revisions/${revisionNo}`),
    staleTime: Infinity,
  });
  if (q.isPending) return <LoadingState label="Loading component list…" />;
  if (q.error) return <ErrorState error={q.error} />;
  if (!q.data.lines.length) return <p className="text-sm text-muted">This revision has no components.</p>;
  return (
    <div>
      <p className="mb-1 text-xs font-semibold tracking-wide text-muted uppercase">Component list in BOM {rev(revisionNo)}</p>
      <ComponentTable lines={q.data.lines.map((l) => ({ ...l, materialCode: l.materialCode ?? "", materialDescription: l.materialDescription ?? "", quantity: l.quantity ?? null, uom: l.uom ?? null, remarks: l.remarks ?? null }))} />
    </div>
  );
}

function ProductionUsage() {
  return (
    <Card>
      <EmptyState
        title="No production records yet"
        description={`Production Job Orders arrive in ${PHASE_NAMES[3]}. When a job is released it records this Father Code with the exact artwork and BOM revisions, and they will be listed here automatically (read-only).`}
      />
    </Card>
  );
}

function History({ bomId }: { bomId: string }) {
  const h = useBomHistory(bomId);
  if (h.isPending) return <LoadingState />;
  if (h.error) return <ErrorState error={h.error} onRetry={() => void h.refetch()} />;
  return (
    <div className="rounded-lg border border-line bg-surface">
      <ul className="divide-y divide-line">
        {h.data.map((row) => (
          <li key={row.id} className="flex flex-col gap-1 px-4 py-3 text-sm sm:flex-row sm:gap-4">
            <span className="shrink-0 text-xs text-muted sm:w-40">{formatDateTime(row.occurredAt)}</span>
            <span className="min-w-0 flex-1">
              <span className="font-medium">{humanize(row.action)}</span> <span className="text-muted">by {row.userName ?? "system"}</span>
              {row.remarks && <span className="block text-xs text-muted">“{row.remarks}”</span>}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
