import { ArrowDown, ArrowLeft, ArrowRight, ArrowUp, Building2, Check, Plus, Star, Trash2 } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useSearchParams } from "react-router";
import { PageHeader, Tabs } from "@/components/common";
import { Badge, Button, Card, Checkbox, Dialog, Field, Input, Select, Spinner, Textarea } from "@/components/ui";
import { api, ApiError } from "@/lib/api";
import { cn } from "@/lib/utils";
import { useAuth } from "@/stores/auth";
import { useToast } from "@/stores/toast";
import { useDocumentMutation, useDocumentTemplates, useLetterhead, type DocumentTemplate, type Letterhead } from "./api";
import { DOC_TYPES, docTypeDef, FOOTER_TOKENS, normalizeLayout, pageMm, type Accent, type DocLayout, type DocType } from "./config";
import { sampleDocument } from "./data";
import { DocumentPages, MM } from "./render";

/**
 * System › Document Templates: end users design every printed document –
 * page, header (letterhead, title, number, date, barcode), content sections
 * (show / hide, order, titles, table columns), notes, signature boxes and
 * footer – with a live preview. One template per document is the default;
 * the print dialog of each record lets the user pick another.
 */
type Tab = "page" | "header" | "content" | "footer";
const ACCENTS: { id: Accent; label: string; cls: string }[] = [
  { id: "primary", label: "Blue", cls: "bg-primary" },
  { id: "neutral", label: "Black", cls: "bg-text" },
  { id: "success", label: "Green", cls: "bg-success" },
  { id: "warning", label: "Amber", cls: "bg-warning" },
  { id: "danger", label: "Red", cls: "bg-danger" },
  { id: "info", label: "Teal", cls: "bg-info" },
];

export function DocumentTemplatesPage() {
  const { session } = useAuth();
  const toast = useToast();
  const [params, setParams] = useSearchParams();
  const type = (DOC_TYPES.find((d) => d.type === params.get("type"))?.type ?? "PJO") as DocType;
  const all = useDocumentTemplates();
  const letterhead = useLetterhead();
  const list = useMemo(() => all.data?.filter((t) => t.docType === type) ?? [], [all.data, type]);
  const selectedId = params.get("id");
  const selected: DocumentTemplate | null = list.find((t) => t.id === selectedId) ?? list.find((t) => t.isDefault) ?? list[0] ?? null;
  const [draft, setDraft] = useState<DocLayout>(() => normalizeLayout(type, selected?.layout));
  const [name, setName] = useState("");
  const [creating, setCreating] = useState<{ code: string; name: string } | null>(null);
  const [tab, setTab] = useState<Tab>("header");
  const [showLetterhead, setShowLetterhead] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const loadedKey = `${type}:${selected?.id ?? "builtin"}:${selected?.updatedAt ?? ""}`;
  const [loaded, setLoaded] = useState("");
  useEffect(() => {
    if (all.isPending || loaded === loadedKey) return;
    setDraft(normalizeLayout(type, selected?.layout));
    setName(selected?.name ?? "");
    setLoaded(loadedKey);
    setError(null);
  }, [all.isPending, loaded, loadedKey, selected, type]);
  const dirty = loaded === loadedKey && JSON.stringify(draft) !== JSON.stringify(normalizeLayout(type, selected?.layout));

  const save = useDocumentMutation(async () => {
    if (selected) return api.patch<DocumentTemplate>(`/documents/templates/${selected.id}`, { name, layout: draft });
    return api.post<DocumentTemplate>("/documents/templates", { code: `STD-${type}`.slice(0, 20), name: `Standard ${docTypeDef(type).label}`.slice(0, 80), docType: type, layout: draft });
  });
  const create = useDocumentMutation((v: { code: string; name: string }) => api.post<DocumentTemplate>("/documents/templates", { ...v, docType: type, layout: draft }));
  const makeDefault = useDocumentMutation((id: string) => api.post(`/documents/templates/${id}/default`));
  const setStatus = useDocumentMutation((v: { id: string; status: "ACTIVE" | "INACTIVE" }) => api.put(`/documents/templates/${v.id}/status`, { status: v.status }));
  const fail = (e: unknown) => setError(e instanceof ApiError ? (e.issues[0] ? `${e.issues[0].message} (${e.issues[0].path})` : e.message) : String(e));
  const pick = (next: { type?: DocType; id?: string | null }) => {
    const p = new URLSearchParams(params);
    if (next.type) p.set("type", next.type);
    if (next.id) p.set("id", next.id);
    else p.delete("id");
    setParams(p, { replace: true });
  };

  // Preview zoom fits the preview column.
  const boxRef = useRef<HTMLDivElement>(null);
  const [zoom, setZoom] = useState(0.6);
  const [pw] = pageMm(draft.page);
  useEffect(() => {
    const el = boxRef.current;
    if (!el) return;
    const fit = () => setZoom(Math.min(1, Math.max(0.25, (el.clientWidth - 32) / (pw * MM))));
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(el);
    return () => ro.disconnect();
  }, [pw]);
  const sample = useMemo(() => sampleDocument(type), [type]);
  const set = <K extends keyof DocLayout>(k: K, patch: Partial<DocLayout[K]>) => setDraft((d) => ({ ...d, [k]: { ...(d[k] as object), ...patch } }));

  return (
    <>
      <PageHeader
        title="Document Templates"
        description="Design how each printed document looks: header, content and footer. Every record's Print button uses the default template; PDF and print come out the same."
        actions={
          <Button icon={<Building2 className="size-4" />} onClick={() => setShowLetterhead(true)}>
            Company letterhead
          </Button>
        }
      />
      {!letterhead.isPending && !letterhead.data && (
        <p className="mb-4 rounded-lg border border-warning/40 bg-warning-soft px-4 py-2.5 text-sm text-warning">
          The company letterhead (name, address, logo) is not set yet. Documents show a placeholder until you{" "}
          <button className="font-semibold underline" onClick={() => setShowLetterhead(true)}>
            set it
          </button>
          .
        </p>
      )}

      <div className="mb-4 flex gap-2 overflow-x-auto pb-1">
        {DOC_TYPES.map((d) => {
          const n = all.data?.filter((t) => t.docType === d.type).length ?? 0;
          return (
            <button
              key={d.type}
              onClick={() => pick({ type: d.type, id: null })}
              className={cn("shrink-0 rounded-lg border px-3 py-2 text-left text-sm transition", d.type === type ? "border-primary bg-primary-soft text-primary" : "border-line bg-surface hover:border-primary/50")}
            >
              <span className="block font-semibold">{d.label}</span>
              <span className="text-xs text-muted">{n ? `${n} template${n === 1 ? "" : "s"}` : "Built-in standard"}</span>
            </button>
          );
        })}
      </div>

      <div className="grid gap-4 xl:grid-cols-[26rem_minmax(0,1fr)]">
        <div className="min-w-0 space-y-4">
          <Card>
            <p className="mb-3 text-sm text-muted">{docTypeDef(type).hint}</p>
            <div className="flex flex-wrap items-end gap-2">
              <Field label="Template" className="min-w-0 flex-1">
                {(p) => (
                  <Select {...p} value={selected?.id ?? ""} onChange={(e) => pick({ id: e.target.value || null })} disabled={!list.length}>
                    {!list.length && <option value="">Standard (built-in, not saved yet)</option>}
                    {list.map((t) => (
                      <option key={t.id} value={t.id}>
                        {t.name}
                        {t.isDefault ? " · default" : ""}
                        {t.status === "INACTIVE" ? " · inactive" : ""}
                      </option>
                    ))}
                  </Select>
                )}
              </Field>
              <Button icon={<Plus className="size-4" />} onClick={() => setCreating({ code: "", name: "" })}>
                New
              </Button>
            </div>
            {selected && (
              <div className="mt-3 flex flex-wrap items-center gap-2">
                <Field label="Name" className="min-w-0 flex-1">{(p) => <Input {...p} value={name} onChange={(e) => setName(e.target.value)} />}</Field>
              </div>
            )}
            {selected && (
              <div className="mt-3 flex flex-wrap items-center gap-2 text-sm">
                <Badge tone="neutral">{selected.code}</Badge>
                {selected.isDefault ? (
                  <Badge tone="success">Default for printing</Badge>
                ) : (
                  selected.status === "ACTIVE" && (
                    <Button size="sm" icon={<Star className="size-3.5" />} loading={makeDefault.isPending} onClick={() => makeDefault.mutate(selected.id, { onSuccess: () => toast.success(`${selected.name} is now the default.`), onError: fail })}>
                      Make default
                    </Button>
                  )
                )}
                {!selected.isDefault && (
                  <Button size="sm" variant="ghost" loading={setStatus.isPending} onClick={() => setStatus.mutate({ id: selected.id, status: selected.status === "ACTIVE" ? "INACTIVE" : "ACTIVE" }, { onError: fail })}>
                    {selected.status === "ACTIVE" ? "Deactivate" : "Activate"}
                  </Button>
                )}
              </div>
            )}
          </Card>

          <Card>
            <Tabs<Tab>
              value={tab}
              onChange={setTab}
              tabs={[
                { id: "header", label: "Header" },
                { id: "content", label: "Content" },
                { id: "footer", label: "Footer" },
                { id: "page", label: "Page" },
              ]}
            />
            <div className="mt-4 space-y-4">
              {tab === "page" && <PageTab draft={draft} set={set} />}
              {tab === "header" && <HeaderTab draft={draft} set={set} onLetterhead={() => setShowLetterhead(true)} />}
              {tab === "content" && <ContentTab type={type} draft={draft} setDraft={setDraft} set={set} />}
              {tab === "footer" && <FooterTab draft={draft} setDraft={setDraft} set={set} />}
            </div>
          </Card>

          <div className="sticky bottom-0 z-10 flex flex-wrap items-center gap-2 rounded-lg border border-line bg-surface px-4 py-3 shadow-sm">
            <span className="text-xs text-muted">{dirty || !selected ? (selected ? "Unsaved changes" : "Built-in standard – save to keep your design") : "Saved"}</span>
            <div className="flex-1" />
            <Button disabled={!dirty} onClick={() => setDraft(normalizeLayout(type, selected?.layout))}>
              Discard
            </Button>
            <Button
              variant="primary"
              icon={<Check className="size-4" />}
              loading={save.isPending}
              disabled={selected ? !dirty && name === selected.name : false}
              onClick={() => {
                setError(null);
                save.mutate(undefined, { onSuccess: (t) => (toast.success("Template saved."), pick({ id: t.id })), onError: fail });
              }}
            >
              Save template
            </Button>
          </div>
          {error && <p className="rounded-md bg-danger-soft px-3 py-2 text-sm text-danger">{error}</p>}
        </div>

        <div className="min-w-0">
          <div className="mb-2 flex items-center gap-2 text-sm">
            <span className="font-semibold">Live preview</span>
            <Badge tone="warning">Sample data</Badge>
            <span className="text-muted">
              {draft.page.size} {draft.page.orientation} · {Math.round(zoom * 100)}%
            </span>
          </div>
          <div ref={boxRef} className="relative min-w-0 overflow-auto rounded-lg bg-neutral-soft p-4 xl:sticky xl:top-4" style={{ height: "calc(100vh - 12rem)", minHeight: 420 }}>
            {all.isPending || letterhead.isPending ? (
              <Spinner />
            ) : (
              <DocumentPages type={type} layout={draft} letterhead={letterhead.data ?? null} data={sample} printedBy={session?.user.fullName ?? ""} zoom={zoom} />
            )}
          </div>
        </div>
      </div>

      {creating && (
        <Dialog
          open
          onClose={() => setCreating(null)}
          title={`New ${docTypeDef(type).label} template`}
          description="Starts from the design on screen. The first template of a document becomes its default."
          footer={
            <>
              <Button onClick={() => setCreating(null)}>Cancel</Button>
              <Button
                variant="primary"
                loading={create.isPending}
                onClick={() => create.mutate(creating, { onSuccess: (t) => (setCreating(null), toast.success(`${t.name} created.`), pick({ id: t.id })), onError: fail })}
              >
                Create
              </Button>
            </>
          }
        >
          <div className="grid gap-3 sm:grid-cols-[10rem_1fr]">
            <Field label="Code" required hint="Letters, numbers, - _">{(p) => <Input {...p} value={creating.code} onChange={(e) => setCreating({ ...creating, code: e.target.value })} />}</Field>
            <Field label="Name" required>{(p) => <Input {...p} value={creating.name} onChange={(e) => setCreating({ ...creating, name: e.target.value })} />}</Field>
          </div>
          {error && <p className="mt-3 rounded-md bg-danger-soft px-3 py-2 text-sm text-danger">{error}</p>}
        </Dialog>
      )}
      {showLetterhead && <LetterheadDialog current={letterhead.data ?? null} onClose={() => setShowLetterhead(false)} />}
    </>
  );
}

type SetFn = <K extends keyof DocLayout>(k: K, patch: Partial<DocLayout[K]>) => void;

const Group = ({ title, children }: { title: string; children: ReactNode }) => (
  <fieldset className="space-y-3">
    <legend className="mb-2 text-xs font-semibold tracking-wide text-muted uppercase">{title}</legend>
    {children}
  </fieldset>
);

function PageTab({ draft, set }: { draft: DocLayout; set: SetFn }) {
  const p = draft.page;
  return (
    <>
      <Group title="Paper">
        <div className="grid grid-cols-2 gap-3">
          <Field label="Size">
            {(f) => (
              <Select {...f} value={p.size} onChange={(e) => set("page", { size: e.target.value as DocLayout["page"]["size"] })}>
                <option value="A4">A4 (210 × 297 mm)</option>
                <option value="A5">A5 (148 × 210 mm)</option>
                <option value="LETTER">Letter (216 × 279 mm)</option>
              </Select>
            )}
          </Field>
          <Field label="Orientation">
            {(f) => (
              <Select {...f} value={p.orientation} onChange={(e) => set("page", { orientation: e.target.value as "portrait" | "landscape" })}>
                <option value="portrait">Portrait</option>
                <option value="landscape">Landscape</option>
              </Select>
            )}
          </Field>
          <Field label={`Margin: ${p.marginMm} mm`}>{(f) => <input {...f} type="range" min={5} max={30} value={p.marginMm} onChange={(e) => set("page", { marginMm: Number(e.target.value) })} className="w-full accent-primary" />}</Field>
          <Field label={`Text size: ${p.fontSizePt} pt`}>{(f) => <input {...f} type="range" min={7} max={14} step={0.5} value={p.fontSizePt} onChange={(e) => set("page", { fontSizePt: Number(e.target.value) })} className="w-full accent-primary" />}</Field>
        </div>
      </Group>
      <Group title="Style">
        <div className="flex flex-wrap gap-2">
          {ACCENTS.map((a) => (
            <button key={a.id} type="button" onClick={() => set("page", { accent: a.id })} aria-pressed={p.accent === a.id} className={cn("flex items-center gap-2 rounded-md border px-2.5 py-1.5 text-sm", p.accent === a.id ? "border-primary bg-primary-soft" : "border-line")}>
              <span className={cn("size-4 rounded-full", a.cls)} /> {a.label}
            </button>
          ))}
        </div>
        <Field label="Spacing">
          {(f) => (
            <Select {...f} value={p.density} onChange={(e) => set("page", { density: e.target.value as "compact" | "comfortable" })}>
              <option value="comfortable">Comfortable</option>
              <option value="compact">Compact (more rows per page)</option>
            </Select>
          )}
        </Field>
      </Group>
    </>
  );
}

function HeaderTab({ draft, set, onLetterhead }: { draft: DocLayout; set: SetFn; onLetterhead: () => void }) {
  const h = draft.header;
  const toggle = (k: keyof DocLayout["header"], label: string) => <Checkbox label={label} checked={!!h[k]} onChange={(e) => set("header", { [k]: e.target.checked } as Partial<DocLayout["header"]>)} />;
  return (
    <>
      <Group title="Title">
        <Field label="Document title">{(f) => <Input {...f} value={h.title} onChange={(e) => set("header", { title: e.target.value })} maxLength={80} />}</Field>
        <Field label="Subtitle">{(f) => <Input {...f} value={h.subtitle} onChange={(e) => set("header", { subtitle: e.target.value })} maxLength={160} placeholder="e.g. Form QF-07 Rev 2" />}</Field>
        <div className="grid grid-cols-2 gap-2">
          {toggle("showDocNo", "Document number")}
          {toggle("showDocDate", "Document date")}
          {toggle("showBarcode", "Barcode of the number")}
          {toggle("divider", "Line under the header")}
        </div>
      </Group>
      <Group title="Letterhead">
        <div className="grid grid-cols-2 gap-2">
          {toggle("showLogo", "Logo")}
          {toggle("showCompanyName", "Company name")}
          {toggle("showAddress", "Address")}
          {toggle("showContact", "Phone / e-mail / web")}
          {toggle("showRegistration", "Registration no.")}
        </div>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Logo side">
            {(f) => (
              <Select {...f} value={h.logoAlign} onChange={(e) => set("header", { logoAlign: e.target.value as "left" | "right" })}>
                <option value="left">Left (title right)</option>
                <option value="right">Right (title left)</option>
              </Select>
            )}
          </Field>
          <Field label="Header on">
            {(f) => (
              <Select {...f} value={h.repeat} onChange={(e) => set("header", { repeat: e.target.value as "all" | "first" })}>
                <option value="all">Every page</option>
                <option value="first">First page (short line after)</option>
              </Select>
            )}
          </Field>
        </div>
        <button className="text-sm text-primary hover:underline" onClick={onLetterhead}>
          Edit company name, address and logo
        </button>
      </Group>
      <Group title="Extra text">
        <Field label="Text under the header" hint="e.g. customer instructions, ISO reference">
          {(f) => <Textarea {...f} rows={2} value={h.extraText} onChange={(e) => set("header", { extraText: e.target.value })} maxLength={500} />}
        </Field>
      </Group>
    </>
  );
}

function ContentTab({ type, draft, setDraft, set }: { type: DocType; draft: DocLayout; setDraft: (f: (d: DocLayout) => DocLayout) => void; set: SetFn }) {
  const def = docTypeDef(type);
  const update = (i: number, patch: Partial<DocLayout["sections"][number]>) => setDraft((d) => ({ ...d, sections: d.sections.map((s, k) => (k === i ? { ...s, ...patch } : s)) }));
  const move = (i: number, by: number) =>
    setDraft((d) => {
      const s = [...d.sections];
      const j = i + by;
      if (j < 0 || j >= s.length) return d;
      [s[i], s[j]] = [s[j]!, s[i]!];
      return { ...d, sections: s };
    });
  return (
    <>
      <Group title="Sections (top to bottom)">
        <ul className="space-y-2">
          {draft.sections.map((s, i) => {
            const sd = def.sections.find((x) => x.key === s.key)!;
            const cols = s.columns ?? [];
            return (
              <li key={s.key} className={cn("rounded-md border p-2.5", s.enabled ? "border-line" : "border-dashed border-line opacity-70")}>
                <div className="flex items-center gap-2">
                  <input type="checkbox" checked={s.enabled} onChange={(e) => update(i, { enabled: e.target.checked })} aria-label={`Show ${sd.label}`} className="size-4 accent-primary" />
                  <Input value={s.title} onChange={(e) => update(i, { title: e.target.value })} className="h-8 min-w-0 flex-1 text-sm" aria-label={`${sd.label} title`} maxLength={80} />
                  <span className="hidden text-[11px] text-muted sm:inline">{sd.kind}</span>
                  <button className="rounded p-1 text-muted hover:bg-neutral-soft disabled:opacity-30" disabled={i === 0} onClick={() => move(i, -1)} aria-label="Move up">
                    <ArrowUp className="size-4" />
                  </button>
                  <button className="rounded p-1 text-muted hover:bg-neutral-soft disabled:opacity-30" disabled={i === draft.sections.length - 1} onClick={() => move(i, 1)} aria-label="Move down">
                    <ArrowDown className="size-4" />
                  </button>
                </div>
                {s.enabled && sd.columns && (
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    {cols.map((k, ci) => {
                      const c = sd.columns!.find((x) => x.key === k);
                      if (!c) return null;
                      const shift = (by: number) => {
                        const next = [...cols];
                        const j = ci + by;
                        if (j < 0 || j >= next.length) return;
                        [next[ci], next[j]] = [next[j]!, next[ci]!];
                        update(i, { columns: next });
                      };
                      return (
                        <span key={k} className="inline-flex items-center gap-0.5 rounded bg-primary-soft py-0.5 pr-0.5 pl-1.5 text-xs text-primary">
                          <button onClick={() => shift(-1)} disabled={ci === 0} className="disabled:opacity-30" aria-label={`Move ${c.label} left`}>
                            <ArrowLeft className="size-3" />
                          </button>
                          {c.label}
                          <button onClick={() => shift(1)} disabled={ci === cols.length - 1} className="disabled:opacity-30" aria-label={`Move ${c.label} right`}>
                            <ArrowRight className="size-3" />
                          </button>
                          <button onClick={() => update(i, { columns: cols.filter((x) => x !== k) })} className="ml-0.5 rounded px-1 hover:bg-primary/15" aria-label={`Hide ${c.label}`}>
                            ×
                          </button>
                        </span>
                      );
                    })}
                    {sd.columns
                      .filter((c) => !cols.includes(c.key))
                      .map((c) => (
                        <button key={c.key} onClick={() => update(i, { columns: [...cols, c.key] })} className="rounded border border-dashed border-line px-1.5 py-0.5 text-xs text-muted hover:border-primary hover:text-primary">
                          + {c.label}
                        </button>
                      ))}
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      </Group>
      <Group title="Notes / declaration (after the content)">
        <Field label="Title">{(f) => <Input {...f} value={draft.notes.title} onChange={(e) => set("notes", { title: e.target.value })} maxLength={80} />}</Field>
        <Field label="Text" hint="Terms, declaration or instructions printed on every copy. Empty = not printed.">
          {(f) => <Textarea {...f} rows={3} value={draft.notes.text} onChange={(e) => set("notes", { text: e.target.value })} maxLength={2000} />}
        </Field>
      </Group>
    </>
  );
}

function FooterTab({ draft, setDraft, set }: { draft: DocLayout; setDraft: (f: (d: DocLayout) => DocLayout) => void; set: SetFn }) {
  const f = draft.footer;
  return (
    <>
      <Group title="Footer (every page)">
        <div className="grid gap-3 sm:grid-cols-3">
          <Field label="Left">{(p) => <Input {...p} value={f.left} onChange={(e) => set("footer", { left: e.target.value })} maxLength={300} />}</Field>
          <Field label="Centre">{(p) => <Input {...p} value={f.center} onChange={(e) => set("footer", { center: e.target.value })} maxLength={300} />}</Field>
          <Field label="Right">{(p) => <Input {...p} value={f.right} onChange={(e) => set("footer", { right: e.target.value })} maxLength={300} />}</Field>
        </div>
        <p className="text-xs text-muted">
          Fill-ins:{" "}
          {FOOTER_TOKENS.map((t) => (
            <code key={t} className="mr-1 rounded bg-surface-2 px-1">
              {t}
            </code>
          ))}
        </p>
        <div className="grid grid-cols-2 gap-2">
          <Checkbox label="Page x of y (right)" checked={f.showPageNumbers} onChange={(e) => set("footer", { showPageNumbers: e.target.checked })} />
          <Checkbox label="Line above the footer" checked={f.divider} onChange={(e) => set("footer", { divider: e.target.checked })} />
        </div>
      </Group>
      <Group title="Signature boxes (end of the document)">
        <ul className="space-y-2">
          {draft.signatures.map((s, i) => (
            <li key={i} className="flex items-center gap-2">
              <Input value={s.label} onChange={(e) => setDraft((d) => ({ ...d, signatures: d.signatures.map((x, k) => (k === i ? { label: e.target.value } : x)) }))} maxLength={60} aria-label={`Signature ${i + 1}`} />
              <Button variant="ghost" icon={<Trash2 className="size-4" />} aria-label="Remove" onClick={() => setDraft((d) => ({ ...d, signatures: d.signatures.filter((_, k) => k !== i) }))} />
            </li>
          ))}
        </ul>
        {draft.signatures.length < 4 && (
          <Button size="sm" icon={<Plus className="size-4" />} onClick={() => setDraft((d) => ({ ...d, signatures: [...d.signatures, { label: "Signature" }] }))}>
            Add signature box
          </Button>
        )}
      </Group>
    </>
  );
}

/** Company letterhead shared by every template. The logo is scaled down in the browser. */
function LetterheadDialog({ current, onClose }: { current: Letterhead | null; onClose: () => void }) {
  const toast = useToast();
  const [v, setV] = useState({ companyName: current?.companyName ?? "", registrationNo: current?.registrationNo ?? "", address: current?.address ?? "", phone: current?.phone ?? "", email: current?.email ?? "", website: current?.website ?? "" });
  const [logo, setLogo] = useState<string | null>(current?.logo ?? null);
  const [error, setError] = useState<string | null>(null);
  const save = useDocumentMutation(() => api.put("/documents/settings", { ...v, logo }));
  const onFile = (file: File | undefined) => {
    if (!file) return;
    if (!/^image\/(png|jpeg)$/.test(file.type)) return setError("Choose a PNG or JPEG image.");
    const img = new Image();
    img.onload = () => {
      const scale = Math.min(1, 600 / img.width, 240 / img.height);
      const c = document.createElement("canvas");
      c.width = Math.round(img.width * scale);
      c.height = Math.round(img.height * scale);
      c.getContext("2d")!.drawImage(img, 0, 0, c.width, c.height);
      const url = c.toDataURL(file.type === "image/png" ? "image/png" : "image/jpeg", 0.9);
      URL.revokeObjectURL(img.src);
      if (url.length > 400_000) return setError("The logo is too large even after scaling. Use a simpler image.");
      setError(null);
      setLogo(url);
    };
    img.src = URL.createObjectURL(file);
  };
  const field = (k: keyof typeof v, label: string, max: number) => <Field label={label}>{(p) => <Input {...p} value={v[k]} maxLength={max} onChange={(e) => setV((x) => ({ ...x, [k]: e.target.value }))} />}</Field>;
  return (
    <Dialog
      open
      onClose={onClose}
      size="lg"
      title="Company letterhead"
      description="Used in the header of every document template."
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            loading={save.isPending}
            disabled={!v.companyName.trim()}
            onClick={() =>
              save.mutate(undefined, {
                onSuccess: () => (toast.success("Letterhead saved."), onClose()),
                onError: (e) => setError(e instanceof ApiError ? (e.issues[0]?.message ?? e.message) : String(e)),
              })
            }
          >
            Save
          </Button>
        </>
      }
    >
      <div className="grid gap-4 sm:grid-cols-[1fr_12rem]">
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Company name" required className="sm:col-span-2">{(p) => <Input {...p} value={v.companyName} maxLength={160} onChange={(e) => setV((x) => ({ ...x, companyName: e.target.value }))} />}</Field>
          {field("registrationNo", "Registration no.", 60)}
          {field("phone", "Phone", 60)}
          <Field label="Address" className="sm:col-span-2">{(p) => <Textarea {...p} rows={3} value={v.address} maxLength={500} onChange={(e) => setV((x) => ({ ...x, address: e.target.value }))} />}</Field>
          {field("email", "E-mail", 120)}
          {field("website", "Website", 120)}
        </div>
        <div>
          <p className="mb-1 text-sm font-medium">Logo</p>
          <div className="flex h-28 items-center justify-center rounded-md border border-dashed border-line bg-white p-2">
            {logo ? <img src={logo} alt="Company logo" className="max-h-full max-w-full object-contain" /> : <span className="text-xs text-muted">No logo</span>}
          </div>
          <label className="mt-2 block cursor-pointer text-center text-sm text-primary hover:underline">
            {logo ? "Replace" : "Upload"} PNG / JPEG
            <input type="file" accept="image/png,image/jpeg" className="sr-only" onChange={(e) => onFile(e.target.files?.[0])} />
          </label>
          {logo && (
            <button className="mt-1 block w-full text-center text-xs text-muted hover:text-danger" onClick={() => setLogo(null)}>
              Remove logo
            </button>
          )}
        </div>
      </div>
      {error && <p className="mt-3 rounded-md bg-danger-soft px-3 py-2 text-sm text-danger">{error}</p>}
    </Dialog>
  );
}
