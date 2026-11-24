import { useMutation, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, Plus, Trash2 } from "lucide-react";
import { useEffect, useState, type FormEvent } from "react";
import { useNavigate } from "react-router";
import { Button, Checkbox, Dialog, Field, Input, Select, Textarea } from "@/components/ui";
import { api, ApiError } from "@/lib/api";
import { useAuth } from "@/stores/auth";
import { useToast } from "@/stores/toast";
import { useUoms, type BomDetail, type ComponentLine, type DuplicateWarning } from "./api";
import { ArtworkDropzone, ArtworkPreview, DuplicateWarnings, type UploadResult } from "./artwork";
import { MaterialPicker, type PickedMaterial } from "./material-picker";

/** Refresh every BOM query (list, detail, revisions, history). */
function useBomMutation<V, R>(fn: (v: V) => Promise<R>) {
  const qc = useQueryClient();
  return useMutation({ mutationFn: fn, onSettled: () => qc.invalidateQueries({ queryKey: ["boms"] }) });
}

/** Field errors go to the form; everything else to a toast. Returns the ApiError for special codes. */
function useErrorRouting() {
  const toast = useToast();
  const [error, setError] = useState<ApiError | null>(null);
  const handle = (e: unknown) => {
    if (e instanceof ApiError && e.issues.length) setError(e);
    else toast.error(e);
  };
  return { error, setError, handle };
}

function useDebouncedDuplicateCheck(labelDescription: string, excludeBomId?: string) {
  const [warnings, setWarnings] = useState<DuplicateWarning[]>([]);
  useEffect(() => {
    const text = labelDescription.trim();
    if (text.length < 3) return setWarnings([]);
    const t = setTimeout(() => {
      api
        .post<DuplicateWarning[]>("/boms/duplicate-check", { labelDescription: text, excludeBomId })
        .then(setWarnings)
        .catch(() => setWarnings([]));
    }, 400);
    return () => clearTimeout(t);
  }, [labelDescription, excludeBomId]);
  return warnings;
}

const NoteField = ({ value, onChange, label = "Change note", hint }: { value: string; onChange: (v: string) => void; label?: string; hint?: string }) => (
  <Field label={label} hint={hint ?? "Optional. Shown in the revision history."}>
    {(p) => <Input {...p} value={value} maxLength={500} onChange={(e) => onChange(e.target.value)} />}
  </Field>
);

// ---------------------------------------------------------------------------

export function NewFatherCodeDialog({ onClose }: { onClose: () => void }) {
  const toast = useToast();
  const navigate = useNavigate();
  const [upload, setUpload] = useState<UploadResult | null>(null);
  const [description, setDescription] = useState("");
  const { error, handle } = useErrorRouting();
  const descWarnings = useDebouncedDuplicateCheck(description);
  const create = useBomMutation(() => api.post<{ id: string; fatherCode: string }>("/boms", { fileId: upload?.file.id, labelDescription: description }));

  const submit = (e: FormEvent) => {
    e.preventDefault();
    create.mutate(undefined, {
      onSuccess: (bom) => {
        toast.success(`Father Code ${bom.fatherCode} created. Add its Son Codes next.`);
        navigate(`/bom/${bom.id}`);
      },
      onError: handle,
    });
  };

  return (
    <Dialog
      open
      onClose={onClose}
      size="lg"
      title="New Father Code"
      description="Upload the artwork and enter the label description. The Father Code and revision are generated automatically."
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" type="submit" form="new-father" loading={create.isPending} disabled={!upload}>
            Create Father Code
          </Button>
        </>
      }
    >
      <form id="new-father" onSubmit={submit} className="space-y-4" noValidate>
        <div>
          <p className="mb-1.5 text-sm font-medium">
            Artwork<span className="ml-0.5 text-danger">*</span>
          </p>
          <ArtworkDropzone value={upload} onChange={setUpload} error={error?.field("fileId")} />
        </div>
        <Field label="Label description" required error={error?.field("labelDescription")}>
          {(p) => <Textarea {...p} value={description} maxLength={500} onChange={(e) => setDescription(e.target.value)} placeholder="e.g. Mango Juice 500ml – Front Label" />}
        </Field>
        <DuplicateWarnings warnings={descWarnings} />
      </form>
    </Dialog>
  );
}

export function EditArtworkDialog({ bom, onClose }: { bom: BomDetail; onClose: () => void }) {
  const { can } = useAuth();
  const toast = useToast();
  const canFile = can("bom.artwork.upload");
  const canDesc = can("bom.edit");
  const [upload, setUpload] = useState<UploadResult | null>(null);
  const [description, setDescription] = useState(bom.labelDescription);
  const [note, setNote] = useState("");
  const { error, handle } = useErrorRouting();
  const descWarnings = useDebouncedDuplicateCheck(description === bom.labelDescription ? "" : description, bom.id);
  const save = useBomMutation(() =>
    api.patch<{ changed: boolean; artworkRevision: number }>(`/boms/${bom.id}/artwork`, {
      ...(upload ? { fileId: upload.file.id } : {}),
      ...(canDesc ? { labelDescription: description } : {}),
      changeNote: note || null,
      expectedArtworkRevNo: bom.artwork.revisionNo,
    }),
  );
  const submit = (e: FormEvent) => {
    e.preventDefault();
    save.mutate(undefined, {
      onSuccess: (r) => {
        toast.success(r.changed ? `Saved as artwork revision ${r.artworkRevision}. The Son Code list is unchanged.` : "No changes to save – no new revision created.");
        onClose();
      },
      onError: handle,
    });
  };
  return (
    <Dialog
      open
      onClose={onClose}
      size="lg"
      title={`Edit artwork – ${bom.fatherCode}`}
      description="Saving a new file or a changed description creates a new artwork revision. Previous revisions stay available."
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" type="submit" form="edit-artwork" loading={save.isPending}>
            Save
          </Button>
        </>
      }
    >
      <form id="edit-artwork" onSubmit={submit} className="space-y-4" noValidate>
        {canFile ? (
          <div>
            <p className="mb-1.5 text-sm font-medium">Artwork</p>
            {upload ? (
              <ArtworkDropzone value={upload} onChange={setUpload} />
            ) : (
              <div className="grid gap-3 sm:grid-cols-2">
                <div>
                  <p className="mb-1 text-xs text-muted">Current ({bom.artwork.file.originalName})</p>
                  <ArtworkPreview file={bom.artwork.file} height="h-40" />
                </div>
                <div>
                  <p className="mb-1 text-xs text-muted">Replace with (optional)</p>
                  <ArtworkDropzone value={null} onChange={setUpload} />
                </div>
              </div>
            )}
          </div>
        ) : (
          <p className="text-sm text-muted">You can change the label description. Replacing artwork needs the "Upload artwork" permission.</p>
        )}
        <Field label="Label description" required error={error?.field("labelDescription")} hint={canDesc ? undefined : "You don't have permission to change the description."}>
          {(p) => <Textarea {...p} value={description} disabled={!canDesc} maxLength={500} onChange={(e) => setDescription(e.target.value)} />}
        </Field>
        <DuplicateWarnings warnings={descWarnings} />
        <NoteField value={note} onChange={setNote} hint="Optional. Why the artwork or description changed." />
      </form>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------

interface DraftLine {
  key: number;
  material: PickedMaterial | null;
  quantity: string;
  uom: string;
  remarks: string;
}
const emptyLine = (key: number): DraftLine => ({ key, material: null, quantity: "", uom: "", remarks: "" });

export function AddSonCodesDialog({ bom, onClose }: { bom: BomDetail; onClose: () => void }) {
  const toast = useToast();
  const uoms = useUoms();
  const [lines, setLines] = useState<DraftLine[]>([emptyLine(1)]);
  const [note, setNote] = useState("");
  const [dupConfirm, setDupConfirm] = useState<{ message: string } | null>(null);
  const [allowDuplicate, setAllowDuplicate] = useState(false);
  const { error, setError, handle } = useErrorRouting();
  const add = useBomMutation(() =>
    api.post<{ revisionNo: number; sonCodes: string[] }>(`/boms/${bom.id}/son-codes`, {
      lines: lines.map((l) => ({ materialId: l.material?.id, quantity: l.quantity || null, uom: l.uom || null, remarks: l.remarks || null })),
      changeNote: note || null,
      allowDuplicate,
      expectedComponentRevNo: bom.componentRevision?.revisionNo ?? 0,
    }),
  );
  const set = (key: number, patch: Partial<DraftLine>) => setLines((ls) => ls.map((l) => (l.key === key ? { ...l, ...patch } : l)));
  const lineError = (i: number, field: string) => error?.field(`lines.${i}.${field}`);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    if (lines.some((l) => !l.material)) {
      setError(new ApiError(422, "VALIDATION_FAILED", "", lines.flatMap((l, i) => (l.material ? [] : [{ path: `lines.${i}.materialId`, message: "Choose a material" }]))));
      return;
    }
    add.mutate(undefined, {
      onSuccess: (r) => {
        toast.success(`Added ${r.sonCodes.join(", ")} – BOM component revision ${r.revisionNo}. Artwork unchanged.`);
        onClose();
      },
      onError: (err) => {
        if (err instanceof ApiError && err.code === "DUPLICATE_COMPONENT") setDupConfirm({ message: err.message });
        else handle(err);
      },
    });
  };

  return (
    <Dialog
      open
      onClose={onClose}
      size="lg"
      title={`Add Son Codes – ${bom.fatherCode}`}
      description="Pick materials from the material list; description and unit fill in automatically. All lines are saved as one BOM component revision."
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" type="submit" form="add-sons" loading={add.isPending}>
            Add {lines.length} Son Code{lines.length === 1 ? "" : "s"}
          </Button>
        </>
      }
    >
      <form id="add-sons" onSubmit={submit} className="space-y-3" noValidate>
        {lines.map((l, i) => (
          <div key={l.key} className="rounded-lg border border-line p-3">
            <div className="mb-2 flex items-center justify-between">
              <span className="text-xs font-semibold text-muted uppercase">Line {i + 1}</span>
              {lines.length > 1 && (
                <Button size="sm" variant="ghost" icon={<Trash2 className="size-4" />} onClick={() => setLines((ls) => ls.filter((x) => x.key !== l.key))} aria-label={`Remove line ${i + 1}`} />
              )}
            </div>
            <div className="grid gap-3 sm:grid-cols-[1fr_7rem_7rem]">
              <div className="min-w-0">
                <p className="mb-1.5 text-sm font-medium">
                  Component / Material<span className="ml-0.5 text-danger">*</span>
                </p>
                <MaterialPicker value={l.material} autoFocus={i === lines.length - 1 && !l.material} invalid={!!lineError(i, "materialId")} onChange={(m) => set(l.key, { material: m, uom: m.uom })} />
                {lineError(i, "materialId") && <p className="mt-1 text-xs text-danger">{lineError(i, "materialId")}</p>}
              </div>
              <Field label="Quantity" error={lineError(i, "quantity")}>
                {(p) => <Input {...p} inputMode="decimal" value={l.quantity} placeholder="Optional" onChange={(e) => set(l.key, { quantity: e.target.value })} />}
              </Field>
              <Field label="Unit" error={lineError(i, "uom")}>
                {(p) => (
                  <Select {...p} value={l.uom} onChange={(e) => set(l.key, { uom: e.target.value })}>
                    <option value="">—</option>
                    {uoms.data?.map((u) => (
                      <option key={u.code} value={u.code}>
                        {u.code}
                      </option>
                    ))}
                  </Select>
                )}
              </Field>
            </div>
            <Field label="Remarks" className="mt-3" error={lineError(i, "remarks")}>
              {(p) => <Input {...p} value={l.remarks} maxLength={500} placeholder="Optional" onChange={(e) => set(l.key, { remarks: e.target.value })} />}
            </Field>
          </div>
        ))}
        <Button size="sm" icon={<Plus className="size-4" />} onClick={() => setLines((ls) => [...ls, emptyLine(Math.max(...ls.map((x) => x.key)) + 1)])}>
          Add another line
        </Button>
        <NoteField value={note} onChange={setNote} />
        {dupConfirm && (
          <div className="rounded-lg border border-warning/40 bg-warning-soft p-3 text-sm">
            <p className="flex items-start gap-1.5 font-medium text-warning">
              <AlertTriangle className="mt-0.5 size-4 shrink-0" /> {dupConfirm.message}
            </p>
            <div className="mt-2">
              <Checkbox label="Yes, this component is needed more than once in this BOM" checked={allowDuplicate} onChange={(e) => setAllowDuplicate(e.target.checked)} />
            </div>
          </div>
        )}
      </form>
    </Dialog>
  );
}

export function EditSonCodeDialog({ bom, line, onClose }: { bom: BomDetail; line: ComponentLine; onClose: () => void }) {
  const toast = useToast();
  const uoms = useUoms();
  const [material, setMaterial] = useState<PickedMaterial>({ id: line.materialId, code: line.materialCode, description: line.materialDescription, uom: line.uom ?? "" });
  const [quantity, setQuantity] = useState(line.quantity ?? "");
  const [uom, setUom] = useState(line.uom ?? "");
  const [remarks, setRemarks] = useState(line.remarks ?? "");
  const [note, setNote] = useState("");
  const [dup, setDup] = useState<string | null>(null);
  const [allowDuplicate, setAllowDuplicate] = useState(false);
  const { error, handle } = useErrorRouting();
  const save = useBomMutation(() =>
    api.patch<{ revisionNo: number; changed: boolean }>(`/boms/${bom.id}/son-codes/${line.sonCodeId}`, {
      ...(material.id !== line.materialId ? { materialId: material.id } : {}),
      quantity: quantity || null,
      uom: uom || null,
      remarks: remarks || null,
      changeNote: note || null,
      allowDuplicate,
      expectedComponentRevNo: bom.componentRevision?.revisionNo ?? 0,
    }),
  );
  const submit = (e: FormEvent) => {
    e.preventDefault();
    save.mutate(undefined, {
      onSuccess: (r) => {
        toast.success(r.changed ? `${line.sonCode} saved – BOM component revision ${r.revisionNo}.` : "No changes to save – no new revision created.");
        onClose();
      },
      onError: (err) => (err instanceof ApiError && err.code === "DUPLICATE_COMPONENT" ? setDup(err.message) : handle(err)),
    });
  };
  return (
    <Dialog
      open
      onClose={onClose}
      title={`Edit ${line.sonCode}`}
      description="Saving creates a new BOM component revision. The previous list is kept."
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" type="submit" form="edit-son" loading={save.isPending}>
            Save
          </Button>
        </>
      }
    >
      <form id="edit-son" onSubmit={submit} className="space-y-4" noValidate>
        <div>
          <p className="mb-1.5 text-sm font-medium">Component / Material</p>
          <MaterialPicker
            value={material}
            onChange={(m) => {
              setMaterial(m);
              setUom(m.uom);
            }}
          />
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Quantity" error={error?.field("quantity")}>
            {(p) => <Input {...p} inputMode="decimal" value={quantity} placeholder="Optional" onChange={(e) => setQuantity(e.target.value)} />}
          </Field>
          <Field label="Unit" error={error?.field("uom")}>
            {(p) => (
              <Select {...p} value={uom} onChange={(e) => setUom(e.target.value)}>
                <option value="">—</option>
                {uoms.data?.map((u) => (
                  <option key={u.code} value={u.code}>
                    {u.code} – {u.label}
                  </option>
                ))}
              </Select>
            )}
          </Field>
        </div>
        <Field label="Remarks" error={error?.field("remarks")}>
          {(p) => <Input {...p} value={remarks} maxLength={500} onChange={(e) => setRemarks(e.target.value)} />}
        </Field>
        <NoteField value={note} onChange={setNote} />
        {dup && (
          <div className="rounded-lg border border-warning/40 bg-warning-soft p-3 text-sm">
            <p className="font-medium text-warning">{dup}</p>
            <div className="mt-2">
              <Checkbox label="Yes, keep this component twice" checked={allowDuplicate} onChange={(e) => setAllowDuplicate(e.target.checked)} />
            </div>
          </div>
        )}
      </form>
    </Dialog>
  );
}

/** Confirm + note dialog shared by Remove Son Code, Restore revision and Activate / Deactivate. */
export function NoteConfirmDialog({
  title,
  message,
  confirmLabel,
  tone = "primary",
  noteLabel = "Reason",
  run,
  success,
  onClose,
}: {
  title: string;
  message: string;
  confirmLabel: string;
  tone?: "primary" | "danger";
  noteLabel?: string;
  run: (note: string | null) => Promise<unknown>;
  success: string;
  onClose: () => void;
}) {
  const toast = useToast();
  const [note, setNote] = useState("");
  const m = useBomMutation((n: string | null) => run(n));
  return (
    <Dialog
      open
      onClose={onClose}
      size="sm"
      title={title}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant={tone === "danger" ? "danger" : "primary"}
            loading={m.isPending}
            onClick={() =>
              m.mutate(note.trim() || null, {
                onSuccess: () => {
                  toast.success(success);
                  onClose();
                },
                onError: (e) => toast.error(e),
              })
            }
          >
            {confirmLabel}
          </Button>
        </>
      }
    >
      <p className="mb-4 text-sm">{message}</p>
      <NoteField value={note} onChange={setNote} label={noteLabel} hint="Optional. Recorded in the history." />
    </Dialog>
  );
}
