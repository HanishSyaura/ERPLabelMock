import { useQuery } from "@tanstack/react-query";
import { Plus, Trash2 } from "lucide-react";
import { useMemo, useState, type FormEvent } from "react";
import { Link, useNavigate, useParams as useRouteParams, useSearchParams } from "react-router";
import { ConfirmDialog, DataTable, ErrorState, LoadingState, PageHeader, SearchInput, Tabs, type Column } from "@/components/common";
import { StatusBadge } from "@/components/status";
import { Badge, Button, Card, Checkbox, Dialog, Field, Input, Select, Textarea } from "@/components/ui";
import { api, qs } from "@/lib/api";
import { formatDate, formatDateTime } from "@/lib/utils";
import { useFormError } from "@/lib/use-form-error";
import { useAuth } from "@/stores/auth";
import { useToast } from "@/stores/toast";
import { useUoms } from "@/modules/bom/api";
import { ArtworkDropzone, ArtworkPreview, ArtworkThumb, type UploadResult } from "@/modules/bom/artwork";
import { PART_KIND_LABEL, PART_TYPE_LABEL, specFieldsFor, specMeta, specSummary, useMasterMutation, usePart, useParts, usePartCategories, usePartGroups, type Part, type PartCategory, type PartDetail, type PartGroup, type PartKind, type PartType, type RecordStatus, type SpecKey } from "./api";

const MANAGE = "bom.material.manage";

function useParams() {
  const [params, setParams] = useSearchParams();
  const set = (patch: Record<string, string>) =>
    setParams((prev) => {
      const next = new URLSearchParams(prev);
      for (const [k, v] of Object.entries(patch)) v ? next.set(k, v) : next.delete(k);
      if (!("page" in patch)) next.delete("page");
      return next;
    });
  return { params, set };
}

/** Activate / deactivate confirmation shared by the three part masters. */
function StatusToggle({ what, code, status, path, onClose, effect }: { what: string; code: string; status: RecordStatus; path: string; onClose: () => void; effect: string }) {
  const toast = useToast();
  const activate = status !== "ACTIVE";
  const m = useMasterMutation(() => api.put(path, { status: activate ? "ACTIVE" : "INACTIVE" }));
  return (
    <ConfirmDialog
      open
      onClose={onClose}
      title={`${activate ? "Activate" : "Deactivate"} ${what} ${code}?`}
      message={activate ? `It can be chosen again.` : effect}
      confirmLabel={activate ? "Activate" : "Deactivate"}
      tone={activate ? "primary" : "danger"}
      busy={m.isPending}
      onConfirm={() => m.mutate(undefined, { onSuccess: () => (toast.success(`${code} ${activate ? "activated" : "deactivated"}.`), onClose()), onError: (e) => toast.error(e) })}
    />
  );
}

const toggleColumn = <T,>(can: boolean, onToggle: (row: T) => void, status: (row: T) => RecordStatus): Column<T>[] =>
  can
    ? [
        {
          key: "actions",
          header: "",
          className: "text-right",
          cell: (row: T) => (
            <Button
              size="sm"
              variant="ghost"
              onClick={(e) => {
                e.stopPropagation();
                onToggle(row);
              }}
            >
              {status(row) === "ACTIVE" ? "Deactivate" : "Activate"}
            </Button>
          ),
        },
      ]
    : [];

// ---------------------------------------------------------------------------
// Part Category Master
// ---------------------------------------------------------------------------

export function PartCategoryPage() {
  const { can } = useAuth();
  const manage = can(MANAGE);
  const list = usePartCategories();
  const [editing, setEditing] = useState<PartCategory | "new" | null>(null);
  const [toggling, setToggling] = useState<PartCategory | null>(null);
  const columns: Column<PartCategory>[] = [
    { key: "code", header: "Code", cell: (c) => <span className="font-medium">{c.code}</span> },
    { key: "name", header: "Category", cell: (c) => c.name },
    { key: "kind", header: "Kind", cell: (c) => PART_KIND_LABEL[c.kind] },
    { key: "count", header: "Groups / Parts", hideOnMobile: true, cell: (c) => <span className="tabular-nums">{c.groupCount} / {c.partCount}</span> },
    { key: "status", header: "Status", cell: (c) => <StatusBadge kind="record" value={c.status} /> },
    ...toggleColumn<PartCategory>(manage, setToggling, (c) => c.status),
  ];
  return (
    <>
      <PageHeader
        title="Part Category Master"
        description="What a part is: label stock, film, ink, foil, ribbon, core… The kind decides which specification fields its parts show."
        crumbs={[{ label: "Master Data" }, { label: "Part Category Master" }]}
        actions={
          manage && (
            <Button variant="primary" icon={<Plus className="size-4" />} onClick={() => setEditing("new")}>
              New category
            </Button>
          )
        }
      />
      <DataTable
        columns={columns}
        rows={list.data}
        rowKey={(c) => c.id}
        loading={list.isPending}
        error={list.error}
        onRetry={() => void list.refetch()}
        onRowClick={manage ? setEditing : undefined}
        empty={<p className="px-4 py-12 text-center text-sm text-muted">No part categories yet. Start with the main ones: label stock, ink, varnish, foil, ribbon, core.</p>}
      />
      {editing && <CategoryDialog category={editing === "new" ? null : editing} onClose={() => setEditing(null)} />}
      {toggling && (
        <StatusToggle
          what="category"
          code={toggling.code}
          status={toggling.status}
          path={`/parts/categories/${toggling.id}/status`}
          effect="It can't be chosen for parts or groups any more. Parts that use it keep it."
          onClose={() => setToggling(null)}
        />
      )}
    </>
  );
}

function CategoryDialog({ category, onClose }: { category: PartCategory | null; onClose: () => void }) {
  const toast = useToast();
  const { field, handle } = useFormError();
  const [form, setForm] = useState({ code: category?.code ?? "", name: category?.name ?? "", kind: category?.kind ?? ("" as PartKind | ""), description: category?.description ?? "" });
  const save = useMasterMutation(() =>
    category ? api.patch(`/parts/categories/${category.id}`, { name: form.name, kind: form.kind, description: form.description }) : api.post("/parts/categories", form),
  );
  const submit = (e: FormEvent) => {
    e.preventDefault();
    save.mutate(undefined, { onSuccess: () => (toast.success(category ? `${category.code} saved.` : `Category ${form.code.toUpperCase()} added.`), onClose()), onError: handle });
  };
  return (
    <Dialog
      open
      onClose={onClose}
      title={category ? `Edit ${category.code}` : "New part category"}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" type="submit" form="cat-form" loading={save.isPending}>
            Save
          </Button>
        </>
      }
    >
      <form id="cat-form" onSubmit={submit} className="grid gap-4 sm:grid-cols-2" noValidate>
        <Field label="Code" required error={field("code")} hint={category ? "Codes can't be changed." : "e.g. LS, INK, FOIL"}>
          {(p) => <Input {...p} value={form.code} disabled={!!category} onChange={(e) => setForm((f) => ({ ...f, code: e.target.value }))} autoFocus={!category} />}
        </Field>
        <Field label="Name" required error={field("name")}>{(p) => <Input {...p} value={form.name} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} />}</Field>
        <Field label="Kind" required error={field("kind")} className="sm:col-span-2" hint="Decides which specification fields parts in this category show.">
          {(p) => (
            <Select {...p} value={form.kind} onChange={(e) => setForm((f) => ({ ...f, kind: e.target.value as PartKind }))}>
              <option value="">Choose…</option>
              {Object.entries(PART_KIND_LABEL).map(([k, l]) => (
                <option key={k} value={k}>
                  {l}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field label="Description" error={field("description")} className="sm:col-span-2">
          {(p) => <Textarea {...p} rows={2} value={form.description} onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))} />}
        </Field>
      </form>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Part Group Master
// ---------------------------------------------------------------------------

export function PartGroupPage() {
  const { can } = useAuth();
  const manage = can(MANAGE);
  const { params, set } = useParams();
  const categoryId = params.get("categoryId") ?? "";
  const categories = usePartCategories();
  const list = usePartGroups(categoryId ? { categoryId } : {});
  const [editing, setEditing] = useState<PartGroup | "new" | null>(null);
  const [toggling, setToggling] = useState<PartGroup | null>(null);
  const columns: Column<PartGroup>[] = [
    { key: "code", header: "Code", cell: (g) => <span className="font-medium">{g.code}</span> },
    { key: "name", header: "Group", cell: (g) => g.name },
    { key: "cat", header: "Category", cell: (g) => <span>{g.category.name}</span> },
    { key: "count", header: "Parts", hideOnMobile: true, cell: (g) => <span className="tabular-nums">{g.partCount}</span> },
    { key: "status", header: "Status", cell: (g) => <StatusBadge kind="record" value={g.status} /> },
    ...toggleColumn<PartGroup>(manage, setToggling, (g) => g.status),
  ];
  return (
    <>
      <PageHeader
        title="Part Group Master"
        description="Finer grouping inside a category, e.g. PP white gloss, PE white, semi-gloss paper under Label stock."
        crumbs={[{ label: "Master Data" }, { label: "Part Group Master" }]}
        actions={
          manage && (
            <Button variant="primary" icon={<Plus className="size-4" />} onClick={() => setEditing("new")} disabled={!categories.data?.some((c) => c.status === "ACTIVE")}>
              New group
            </Button>
          )
        }
      />
      <DataTable
        columns={columns}
        rows={list.data}
        rowKey={(g) => g.id}
        loading={list.isPending}
        error={list.error}
        onRetry={() => void list.refetch()}
        onRowClick={manage ? setEditing : undefined}
        toolbar={
          <Select value={categoryId} onChange={(e) => set({ categoryId: e.target.value })} className="sm:w-56" aria-label="Category">
            <option value="">All categories</option>
            {categories.data?.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </Select>
        }
        empty={<p className="px-4 py-12 text-center text-sm text-muted">{categories.data?.length ? "No part groups yet." : "Add a part category first, then its groups."}</p>}
      />
      {editing && <GroupDialog group={editing === "new" ? null : editing} categories={categories.data ?? []} defaultCategoryId={categoryId} onClose={() => setEditing(null)} />}
      {toggling && (
        <StatusToggle
          what="group"
          code={toggling.code}
          status={toggling.status}
          path={`/parts/groups/${toggling.id}/status`}
          effect="It can't be chosen for parts any more. Parts that use it keep it."
          onClose={() => setToggling(null)}
        />
      )}
    </>
  );
}

function GroupDialog({ group, categories, defaultCategoryId, onClose }: { group: PartGroup | null; categories: PartCategory[]; defaultCategoryId: string; onClose: () => void }) {
  const toast = useToast();
  const { field, handle } = useFormError();
  const [form, setForm] = useState({ code: group?.code ?? "", name: group?.name ?? "", categoryId: group?.categoryId ?? defaultCategoryId, description: group?.description ?? "" });
  const save = useMasterMutation(() =>
    group ? api.patch(`/parts/groups/${group.id}`, { name: form.name, categoryId: form.categoryId, description: form.description }) : api.post("/parts/groups", form),
  );
  const submit = (e: FormEvent) => {
    e.preventDefault();
    save.mutate(undefined, { onSuccess: () => (toast.success(group ? `${group.code} saved.` : `Group ${form.code.toUpperCase()} added.`), onClose()), onError: handle });
  };
  return (
    <Dialog
      open
      onClose={onClose}
      title={group ? `Edit ${group.code}` : "New part group"}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" type="submit" form="group-form" loading={save.isPending}>
            Save
          </Button>
        </>
      }
    >
      <form id="group-form" onSubmit={submit} className="grid gap-4 sm:grid-cols-2" noValidate>
        <Field label="Code" required error={field("code")} hint={group ? "Codes can't be changed." : "e.g. PP-WG"}>
          {(p) => <Input {...p} value={form.code} disabled={!!group} onChange={(e) => setForm((f) => ({ ...f, code: e.target.value }))} autoFocus={!group} />}
        </Field>
        <Field label="Name" required error={field("name")}>{(p) => <Input {...p} value={form.name} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} />}</Field>
        <Field label="Category" required error={field("categoryId")} className="sm:col-span-2" hint={group?.partCount ? "Parts use this group, so it stays in its category." : undefined}>
          {(p) => (
            <Select {...p} value={form.categoryId} disabled={!!group?.partCount} onChange={(e) => setForm((f) => ({ ...f, categoryId: e.target.value }))}>
              <option value="">Choose…</option>
              {categories
                .filter((c) => c.status === "ACTIVE" || c.id === form.categoryId)
                .map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name} ({PART_KIND_LABEL[c.kind]})
                  </option>
                ))}
            </Select>
          )}
        </Field>
        <Field label="Description" error={field("description")} className="sm:col-span-2">
          {(p) => <Textarea {...p} rows={2} value={form.description} onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))} />}
        </Field>
      </form>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Part Master
// ---------------------------------------------------------------------------

export function PartMasterPage() {
  const { can } = useAuth();
  const manage = can(MANAGE);
  const navigate = useNavigate();
  const { params, set } = useParams();
  const page = Number(params.get("page") ?? 1);
  const q = params.get("q") ?? "";
  const status = params.get("status") ?? "";
  const partType = params.get("partType") ?? "";
  const categoryId = params.get("categoryId") ?? "";
  const groupId = params.get("groupId") ?? "";
  const categories = usePartCategories();
  const groups = usePartGroups(categoryId ? { categoryId } : {});
  const list = useParts({ page, q, status, partType, categoryId, groupId });
  const [creating, setCreating] = useState(params.get("new") === "fg" ? "FINISHED_GOOD" : params.get("new") ? "RAW_MATERIAL" : null);
  const [toggling, setToggling] = useState<Part | null>(null);
  const columns: Column<Part>[] = [
    {
      key: "code",
      header: "Part",
      cell: (m) => (
        <div className="min-w-0">
          <p className="font-medium whitespace-nowrap">{m.code}</p>
          <p className="line-clamp-1 max-w-sm text-xs text-muted">{m.description}</p>
        </div>
      ),
    },
    {
      key: "type",
      header: "Type",
      cell: (m) => (
        <div className="text-sm">
          <p className="whitespace-nowrap">{PART_TYPE_LABEL[m.partType]}</p>
          {m.bom && <p className="text-xs text-muted">Artwork {m.bom.fatherCode}</p>}
        </div>
      ),
    },
    {
      key: "class",
      header: "Category / Group",
      hideOnMobile: true,
      cell: (m) =>
        m.category ? (
          <div className="min-w-0 text-sm">
            <p>{m.category.name}</p>
            <p className="text-xs text-muted">{m.group?.name ?? "—"}</p>
          </div>
        ) : (
          <span className="text-xs text-muted">Not classified</span>
        ),
    },
    { key: "nmi", header: "NMI No.", hideOnMobile: true, cell: (m) => m.nmiNo ?? "—" },
    {
      key: "stock",
      header: "Location qty",
      className: "text-right",
      hideOnMobile: true,
      cell: (m) => (
        <span className="whitespace-nowrap tabular-nums">
          {m.stockQty ?? "0"} {m.uom}
          {m.holdQty && m.holdQty !== "0" && <span className="block text-xs text-warning">DO hold {m.holdQty}</span>}
        </span>
      ),
    },
    { key: "rev", header: "Rev", hideOnMobile: true, cell: (m) => <span className="tabular-nums">{m.revisionNo}</span> },
    { key: "status", header: "Status", cell: (m) => (m.obsolete ? <Badge tone="neutral">Obsolete</Badge> : <StatusBadge kind="record" value={m.status} />) },
    ...toggleColumn<Part>(manage, setToggling, (m) => m.status),
  ];
  return (
    <>
      <PageHeader
        title="Part Master"
        description="Every item code: label stock, film, ink, varnish, foil, ribbon, core, packaging and the finished labels. Son Codes and the MRS pick raw parts from here; a finished-good part's Artwork No. is its Father Code."
        crumbs={[{ label: "Master Data" }, { label: "Part Master" }]}
      />
      <DataTable
        columns={columns}
        rows={list.data?.data}
        rowKey={(m) => m.id}
        loading={list.isPending}
        error={list.error}
        onRetry={() => void list.refetch()}
        page={page}
        pageCount={list.data?.meta.pageCount}
        total={list.data?.meta.total}
        onPage={(p) => set({ page: String(p) })}
        onRowClick={(m) => navigate(`/master-data/part-master/${m.id}`)}
        toolbar={
          <>
            <SearchInput value={q} onChange={(v) => set({ q: v })} placeholder="Code, description, NMI, Father Code, supplier" />
            <Select value={partType} onChange={(e) => set({ partType: e.target.value })} className="sm:w-40" aria-label="Part type">
              <option value="">All types</option>
              {Object.entries(PART_TYPE_LABEL).map(([k, l]) => (
                <option key={k} value={k}>
                  {l}
                </option>
              ))}
            </Select>
            <Select value={categoryId} onChange={(e) => set({ categoryId: e.target.value, groupId: "" })} className="sm:w-44" aria-label="Category">
              <option value="">All categories</option>
              {categories.data?.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </Select>
            {categoryId && (
              <Select value={groupId} onChange={(e) => set({ groupId: e.target.value })} className="sm:w-44" aria-label="Group">
                <option value="">All groups</option>
                {groups.data?.map((g) => (
                  <option key={g.id} value={g.id}>
                    {g.name}
                  </option>
                ))}
              </Select>
            )}
            <Select value={status} onChange={(e) => set({ status: e.target.value })} className="sm:w-36" aria-label="Status">
              <option value="">All statuses</option>
              <option value="ACTIVE">Active</option>
              <option value="INACTIVE">Inactive / obsolete</option>
            </Select>
            <div className="flex-1" />
            {manage && (
              <Button variant="primary" icon={<Plus className="size-4" />} onClick={() => navigate("/master-data/part-master/new")}>
                New part
              </Button>
            )}
          </>
        }
        empty={<p className="px-4 py-12 text-center text-sm text-muted">{q || status || categoryId || partType ? "No parts match." : "No parts yet."}</p>}
      />
      {creating && (
        <PartDialog
          part={null}
          defaultType={creating as PartType}
          categories={categories.data ?? []}
          onClose={() => setCreating(null)}
          onCreated={(id) => navigate(`/master-data/part-master/${id}`)}
        />
      )}
      {toggling && (
        <StatusToggle
          what="part"
          code={toggling.code}
          status={toggling.status}
          path={`/materials/${toggling.id}/status`}
          effect="It can no longer be added to Son Codes. BOMs that already use it keep it."
          onClose={() => setToggling(null)}
        />
      )}
    </>
  );
}

type PartForm = Record<"code" | "description" | "uom" | "partType" | "bomId" | "nmiNo" | "specification" | "source" | "categoryId" | "groupId" | "supplierName" | "supplierPartNo" | "remarks" | SpecKey, string>;
const SPEC_KEYS: SpecKey[] = ["stockForm", "widthMm", "lengthM", "thicknessMicron", "gsm", "faceFinish", "adhesive", "liner", "coreIdMm", "colour", "system", "shelfLifeDays", "certifications"];
const NUMERIC: SpecKey[] = ["widthMm", "lengthM", "thicknessMicron", "gsm", "coreIdMm", "shelfLifeDays"];
const SOURCES = ["Purchased", "Manufactured", "Customer supplied", "Local", "Import"];

/** General + technical specification of a part (create, and the General tab's Edit). */
function PartDialog({ part, defaultType = "RAW_MATERIAL", categories, onClose, onCreated }: { part: Part | null; defaultType?: PartType; categories: PartCategory[]; onClose: () => void; onCreated?: (id: string) => void }) {
  const toast = useToast();
  const navigate = useNavigate();
  const { can } = useAuth();
  const uoms = useUoms();
  const { field, handle } = useFormError();
  const [form, setForm] = useState<PartForm>(() => {
    const f = {
      code: part?.code ?? "",
      description: part?.description ?? "",
      uom: part?.uom ?? (defaultType === "FINISHED_GOOD" ? "PCS" : ""),
      partType: part?.partType ?? defaultType,
      bomId: part?.bomId ?? "",
      nmiNo: part?.nmiNo ?? "",
      specification: part?.specification ?? "",
      source: part?.source ?? (defaultType === "FINISHED_GOOD" ? "Manufactured" : ""),
      categoryId: part?.categoryId ?? "",
      groupId: part?.groupId ?? "",
      supplierName: part?.supplierName ?? "",
      supplierPartNo: part?.supplierPartNo ?? "",
      remarks: part?.remarks ?? "",
    } as PartForm;
    for (const k of SPEC_KEYS) f[k] = part?.[k] == null ? "" : String(part[k]);
    return f;
  });
  const fg = form.partType === "FINISHED_GOOD";
  const [artSearch, setArtSearch] = useState("");
  const fathers = useQuery({
    queryKey: ["products", "available-father-codes", artSearch],
    queryFn: () => api.get<{ id: string; fatherCode: string; labelDescription: string }[]>(`/products/available-father-codes${qs({ q: artSearch })}`),
    enabled: fg && !part?.product,
  });
  const groups = usePartGroups(form.categoryId ? { categoryId: form.categoryId } : {});
  const kind = categories.find((c) => c.id === form.categoryId)?.kind ?? null;
  const shown = useMemo(() => new Set(fg ? [] : specFieldsFor(kind)), [kind, fg]);
  const set = (k: keyof PartForm) => (e: { target: { value: string } }) => setForm((f) => ({ ...f, [k]: e.target.value }));
  const save = useMasterMutation(() => {
    const payload: Record<string, unknown> = {
      description: form.description,
      uom: form.uom,
      partType: form.partType,
      nmiNo: form.nmiNo,
      specification: form.specification,
      source: form.source,
      categoryId: form.categoryId || null,
      groupId: form.groupId || null,
      supplierName: form.supplierName,
      supplierPartNo: form.supplierPartNo,
      remarks: form.remarks,
    };
    if (fg && !part?.product) payload.bomId = form.bomId || null;
    // Only the fields this kind shows are sent; values saved earlier for other fields are kept.
    for (const k of SPEC_KEYS) if (shown.has(k)) payload[k] = k === "stockForm" ? form[k] || null : form[k];
    return part ? api.patch<Part>(`/materials/${part.id}`, payload) : api.post<Part>("/materials", { ...payload, code: form.code });
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    save.mutate(undefined, {
      onSuccess: async (r) => {
        onClose();
        if (!part?.product && r.product) {
          // A finished good that just got its Artwork No.: carry on with its Master Card.
          if (can("bom.product.manage")) await api.post(`/products/${r.product.id}/cards`).catch(() => undefined);
          toast.success(`${r.code} saved. Continue with its Master Card.`);
          navigate(`/bom/master-card/${r.product.id}`);
          return;
        }
        toast.success(part ? `${part.code} saved.` : `Part ${r.code} added.`);
        if (!part) onCreated?.(r.id);
      },
      onError: handle,
    });
  };
  return (
    <Dialog
      open
      onClose={onClose}
      size="lg"
      title={part ? `Edit ${part.code}` : fg ? "New finished-good part" : "New part"}
      description={part ? "Changes to the description, specification, unit or technical data raise the part revision. BOM revisions keep the description they were saved with." : fg ? "A finished label. Its Artwork No. (Father Code) gets the Master Card." : "Choose the category first: it decides which specification fields apply."}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" type="submit" form="part-form" loading={save.isPending}>
            {part ? "Save" : "Add part"}
          </Button>
        </>
      }
    >
      <form id="part-form" onSubmit={submit} className="space-y-5" noValidate>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Part code" required error={field("code")} hint={part ? "Codes can't be changed." : undefined}>
            {(p) => <Input {...p} value={form.code} disabled={!!part} onChange={set("code")} autoFocus={!part} />}
          </Field>
          <Field label="Part type" required error={field("partType")} hint={part?.product ? "Has a Master Card: stays a finished good." : undefined}>
            {(p) => (
              <Select {...p} value={form.partType} disabled={!!part?.product} onChange={(e) => setForm((f) => ({ ...f, partType: e.target.value, bomId: e.target.value === "FINISHED_GOOD" ? f.bomId : "" }))}>
                {Object.entries(PART_TYPE_LABEL).map(([k, l]) => (
                  <option key={k} value={k}>
                    {l}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <Field label="Part description" required className="sm:col-span-2" error={field("description")}>{(p) => <Input {...p} value={form.description} onChange={set("description")} />}</Field>
          {fg && (
            <Field label="Artwork No. (Father Code)" error={field("bomId")} className="sm:col-span-2" hint={part?.product ? "Fixed once the Master Card exists." : "Father Codes not yet used by another finished-good part. You can add it later."}>
              {(p) =>
                part?.product ? (
                  <Input {...p} value={part.bom ? `${part.bom.fatherCode} – ${part.bom.labelDescription}` : "—"} disabled />
                ) : (
                  <div className="space-y-2">
                    <Input value={artSearch} onChange={(e) => setArtSearch(e.target.value)} placeholder="Search Father Code or label description" aria-label="Search Father Code" />
                    <Select {...p} value={form.bomId} onChange={set("bomId")}>
                      <option value="">Not linked yet</option>
                      {part?.bom && <option value={part.bom.id}>{part.bom.fatherCode} – {part.bom.labelDescription}</option>}
                      {fathers.data?.map((b) => (
                        <option key={b.id} value={b.id}>
                          {b.fatherCode} – {b.labelDescription}
                        </option>
                      ))}
                    </Select>
                  </div>
                )
              }
            </Field>
          )}
          <Field label="Part UOM" required error={field("uom")}>
            {(p) => (
              <Select {...p} value={form.uom} onChange={set("uom")}>
                <option value="">Choose…</option>
                {uoms.data?.map((u) => (
                  <option key={u.code} value={u.code}>
                    {u.code} – {u.label}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <Field label="NMI No." error={field("nmiNo")} hint="Same number as on the Master Card.">{(p) => <Input {...p} value={form.nmiNo} onChange={set("nmiNo")} />}</Field>
          <Field label="Source" error={field("source")}>
            {(p) => (
              <>
                <Input {...p} value={form.source} onChange={set("source")} list="part-sources" />
                <datalist id="part-sources">
                  {SOURCES.map((x) => (
                    <option key={x} value={x} />
                  ))}
                </datalist>
              </>
            )}
          </Field>
          <Field label="Part category" error={field("categoryId")}>
            {(p) => (
              <Select {...p} value={form.categoryId} onChange={(e) => setForm((f) => ({ ...f, categoryId: e.target.value, groupId: "" }))}>
                <option value="">Not classified</option>
                {categories
                  .filter((c) => c.status === "ACTIVE" || c.id === form.categoryId)
                  .map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
              </Select>
            )}
          </Field>
          <Field label="Part group" error={field("groupId")}>
            {(p) => (
              <Select {...p} value={form.groupId} disabled={!form.categoryId} onChange={set("groupId")}>
                <option value="">{form.categoryId ? "No group" : "Choose a category first"}</option>
                {groups.data
                  ?.filter((g) => g.status === "ACTIVE" || g.id === form.groupId)
                  .map((g) => (
                    <option key={g.id} value={g.id}>
                      {g.name}
                    </option>
                  ))}
              </Select>
            )}
          </Field>
          <Field label="Specification" error={field("specification")} className="sm:col-span-2">{(p) => <Textarea {...p} rows={2} value={form.specification} onChange={set("specification")} />}</Field>
        </div>

        {!fg && shown.size > 0 && (
          <fieldset>
            <legend className="mb-3 text-sm font-semibold">Technical data{kind ? ` – ${PART_KIND_LABEL[kind]}` : ""}</legend>
            <div className="grid gap-4 sm:grid-cols-2">
              {SPEC_KEYS.filter((k) => shown.has(k)).map((k) => {
                const meta = specMeta(k, kind);
                const label = meta.unit ? `${meta.label} (${meta.unit})` : meta.label;
                if (k === "stockForm")
                  return (
                    <Field key={k} label={label} error={field(k)}>
                      {(p) => (
                        <Select {...p} value={form.stockForm} onChange={set("stockForm")}>
                          <option value="">—</option>
                          <option value="ROLL">Roll</option>
                          <option value="SHEET">Sheet</option>
                          <option value="FANFOLD">Fanfold</option>
                          <option value="UNIT">Unit / piece</option>
                        </Select>
                      )}
                    </Field>
                  );
                const listId = meta.suggestions ? `part-${k}-options` : undefined;
                return (
                  <Field key={k} label={label} error={field(k)}>
                    {(p) => (
                      <>
                        <Input {...p} value={form[k]} onChange={set(k)} inputMode={NUMERIC.includes(k) ? "decimal" : undefined} list={listId} />
                        {listId && (
                          <datalist id={listId}>
                            {meta.suggestions!.map((s) => (
                              <option key={s} value={s} />
                            ))}
                          </datalist>
                        )}
                      </>
                    )}
                  </Field>
                );
              })}
            </div>
          </fieldset>
        )}
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Supplier" error={field("supplierName")}>{(p) => <Input {...p} value={form.supplierName} onChange={set("supplierName")} />}</Field>
          <Field label="Supplier part no." error={field("supplierPartNo")}>{(p) => <Input {...p} value={form.supplierPartNo} onChange={set("supplierPartNo")} />}</Field>
        </div>
      </form>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Part detail: General | Engineering | Shipping | UOM Conversion | Location Qty | Others
// ---------------------------------------------------------------------------

type PartTab = "general" | "engineering" | "shipping" | "uom" | "location" | "others";

const Row = ({ label, children }: { label: string; children: React.ReactNode }) => (
  <div className="contents">
    <dt className="text-muted">{label}</dt>
    <dd className="min-w-0 break-words">{children ?? "—"}</dd>
  </div>
);

export function PartDetailPage() {
  const { id = "" } = useRouteParams();
  const { can } = useAuth();
  const manage = can(MANAGE);
  const [params, setParams] = useSearchParams();
  const tab = (params.get("tab") as PartTab | null) ?? "general";
  const part = usePart(id);
  const categories = usePartCategories();
  const [editing, setEditing] = useState(false);
  if (part.isPending) return <LoadingState />;
  if (part.error) return <ErrorState error={part.error} onRetry={() => void part.refetch()} />;
  const p = part.data;
  const kind = p.category?.kind ?? null;
  return (
    <>
      <PageHeader
        title={p.code}
        description={p.description}
        crumbs={[{ label: "Master Data" }, { label: "Part Master", to: "/master-data/part-master" }, { label: p.code }]}
        actions={
          <>
            {p.product && (
              <Link to={`/bom/master-card/${p.product.id}`}>
                <Button>Master Card</Button>
              </Link>
            )}
            {manage && (
              <Button variant="primary" onClick={() => setEditing(true)}>
                Edit general
              </Button>
            )}
          </>
        }
      />
      <div className="mb-4 flex flex-col gap-4 rounded-lg border border-line bg-surface p-4 sm:flex-row sm:items-center">
        <ArtworkThumb file={p.image} className="size-20 shrink-0" />
        <dl className="grid min-w-0 flex-1 grid-cols-2 gap-x-6 gap-y-2 text-sm lg:grid-cols-5">
          <div>
            <dt className="text-xs text-muted">Type</dt>
            <dd>{PART_TYPE_LABEL[p.partType]}</dd>
          </div>
          <div>
            <dt className="text-xs text-muted">Status</dt>
            <dd>{p.obsolete ? <Badge tone="neutral">Obsolete</Badge> : <StatusBadge kind="record" value={p.status} />}</dd>
          </div>
          <div>
            <dt className="text-xs text-muted">Revision No.</dt>
            <dd>
              {p.revisionNo}
              {p.revisedAt && <span className="block text-xs text-muted">Revised {formatDate(p.revisedAt)}</span>}
            </dd>
          </div>
          <div>
            <dt className="text-xs text-muted">Last update (ID / date)</dt>
            <dd>
              {p.updatedBy ?? "—"}
              <span className="block text-xs text-muted">{formatDateTime(p.updatedAt)}</span>
            </dd>
          </div>
          <div>
            <dt className="text-xs text-muted">Location qty</dt>
            <dd className="tabular-nums">
              {p.locations.reduce((s, l) => s + Number(l.qty), 0).toLocaleString()} {p.uom}
            </dd>
          </div>
        </dl>
      </div>
      <Tabs<PartTab>
        value={tab}
        onChange={(t) => setParams(t === "general" ? {} : { tab: t })}
        tabs={[
          { id: "general", label: "General" },
          { id: "engineering", label: "Engineering" },
          { id: "shipping", label: "Shipping" },
          { id: "uom", label: `UOM Conversion (${p.uomConversions.length})` },
          { id: "location", label: `Location Qty (${p.locations.length})` },
          { id: "others", label: "Others" },
        ]}
      />
      {tab === "general" && (
        <Card title="General">
          <dl className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-[11rem_1fr_11rem_1fr]">
            <Row label="Part code">{p.code}</Row>
            <Row label="Artwork No.">{p.bom ? <Link to={`/bom/${p.bom.id}`} className="text-primary hover:underline">{p.bom.fatherCode}</Link> : "—"}</Row>
            <Row label="Part description">{p.description}</Row>
            <Row label="NMI No.">{p.nmiNo}</Row>
            <Row label="Part category">{p.category?.name}</Row>
            <Row label="Part group">{p.group?.name}</Row>
            <Row label="Part UOM">{p.uom}</Row>
            <Row label="Source">{p.source}</Row>
            <Row label="Supplier">{[p.supplierName, p.supplierPartNo].filter(Boolean).join(" · ") || null}</Row>
            <Row label="Used in">{`${p.activeSonCodes} Son Code${p.activeSonCodes === 1 ? "" : "s"}`}</Row>
          </dl>
          <div className="mt-4 border-t border-line pt-3 text-sm">
            <p className="mb-1 text-muted">Specification</p>
            <p className="whitespace-pre-wrap">{p.specification ?? "—"}</p>
            {p.partType !== "FINISHED_GOOD" && specSummary(p) && <p className="mt-2 text-xs text-muted">Technical: {specSummary(p)}</p>}
          </div>
        </Card>
      )}
      {tab === "engineering" && (
        <SectionForm
          part={p}
          title="Engineering"
          note="Packing and dimensions. Changing these raises the part revision."
          fields={[
            ["pcsPerRoll", "Pcs per roll / sheet", "decimal"],
            ["packQty", "Roll / pcs per pack", "decimal"],
            ["cartonsPerPallet", "Carton per pallet", "int"],
            ["materialType", "Material type", "text"],
            ["measureHMm", "Measurement H (mm)", "decimal"],
            ["measureWMm", "Measurement W (mm)", "decimal"],
            ["measureLMm", "Measurement L (mm)", "decimal"],
            ["decisionCost", "Decision cost", "decimal"],
            ["tariffCode", "Tariff code", "text"],
          ]}
          readOnly={!manage}
        />
      )}
      {tab === "shipping" && (
        <SectionForm
          part={p}
          title="Shipping"
          note="Keyed in by hand until the WMS / purchasing integration. Obsolete deactivates the part; Require IQC means only lots that passed IQC can be issued."
          fields={[
            ["reorderLevel", `Reorder level (${p.uom})`, "decimal"],
            ["reorderQty", `Reorder qty (${p.uom})`, "decimal"],
            ["maxQty", `Max qty (${p.uom})`, "decimal"],
            ["leadTimeDays", "Lead time (days)", "int"],
            ["overReceivePct", "Over receive tolerance (%)", "decimal"],
            ["customCode", "Custom code", "text"],
            ["controlPoint", "Control point", "text"],
            ["requireIqc", "Require IQC", "bool"],
            ["obsolete", "Obsolete", "bool"],
          ]}
          extra={p.obsolete ? <p className="text-sm text-muted">Obsolete since {formatDateTime(p.obsoleteAt)} by {p.obsoleteBy ?? "—"}.</p> : null}
          readOnly={!manage}
        />
      )}
      {tab === "uom" && <UomConversions part={p} readOnly={!manage} />}
      {tab === "location" && <Locations part={p} readOnly={!manage} />}
      {tab === "others" && <Others part={p} readOnly={!manage} />}
      {editing && <PartDialog part={p} categories={categories.data ?? []} onClose={() => setEditing(false)} />}
      {kind && null}
    </>
  );
}

type FieldKind = "decimal" | "int" | "text" | "bool";
function SectionForm({ part, title, note, fields, extra, readOnly }: { part: PartDetail; title: string; note: string; fields: [keyof Part, string, FieldKind][]; extra?: React.ReactNode; readOnly: boolean }) {
  const toast = useToast();
  const { field, handle, setError } = useFormError();
  const initial = () => Object.fromEntries(fields.map(([k, , kind]) => [k, kind === "bool" ? Boolean(part[k]) : part[k] == null ? "" : String(part[k])])) as Record<string, string | boolean>;
  const [form, setForm] = useState(initial);
  const save = useMasterMutation(() => api.patch(`/materials/${part.id}`, form));
  const submit = (e: FormEvent) => {
    e.preventDefault();
    save.mutate(undefined, { onSuccess: () => (setError(null), toast.success(`${title} saved.`)), onError: handle });
  };
  return (
    <Card title={title}>
      <p className="mb-4 text-sm text-muted">{note}</p>
      <form onSubmit={submit} className="space-y-4" noValidate>
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {fields.map(([k, label, kind]) =>
            kind === "bool" ? (
              <div key={String(k)} className="flex items-end pb-2">
                <Checkbox label={label} checked={Boolean(form[k as string])} disabled={readOnly} onChange={(e) => setForm((f) => ({ ...f, [k]: e.target.checked }))} />
              </div>
            ) : (
              <Field key={String(k)} label={label} error={field(String(k))}>
                {(p) => <Input {...p} value={String(form[k as string] ?? "")} disabled={readOnly} inputMode={kind === "text" ? undefined : kind === "int" ? "numeric" : "decimal"} onChange={(e) => setForm((f) => ({ ...f, [k]: e.target.value }))} />}
              </Field>
            ),
          )}
        </div>
        {extra}
        {!readOnly && (
          <Button type="submit" variant="primary" loading={save.isPending}>
            Save {title.toLowerCase()}
          </Button>
        )}
      </form>
    </Card>
  );
}

function UomConversions({ part, readOnly }: { part: PartDetail; readOnly: boolean }) {
  const toast = useToast();
  const uoms = useUoms();
  const { field, handle, setError } = useFormError();
  const [items, setItems] = useState(part.uomConversions.map((c) => ({ uom: c.uom, factor: c.factor, remark: c.remark ?? "" })));
  const save = useMasterMutation(() => api.put(`/materials/${part.id}/uom-conversions`, { items }));
  const setItem = (i: number, patch: Partial<(typeof items)[number]>) => setItems((l) => l.map((x, j) => (j === i ? { ...x, ...patch } : x)));
  return (
    <Card title="UOM Conversion">
      <p className="mb-4 text-sm text-muted">
        How other units convert to this part's unit ({part.uom}). Example: 1 ROLL = 1000 {part.uom}.
      </p>
      <ul className="space-y-2">
        {items.map((it, i) => (
          <li key={i} className="grid items-start gap-2 sm:grid-cols-[3rem_9rem_1.5rem_9rem_3rem_1fr_auto]">
            <span className="pt-2.5 text-sm text-muted">1</span>
            <Select value={it.uom} disabled={readOnly} onChange={(e) => setItem(i, { uom: e.target.value })} aria-label="Unit">
              <option value="">Unit…</option>
              {uoms.data
                ?.filter((u) => u.code !== part.uom)
                .map((u) => (
                  <option key={u.code} value={u.code}>
                    {u.code}
                  </option>
                ))}
            </Select>
            <span className="pt-2.5 text-center text-sm">=</span>
            <Input inputMode="decimal" value={it.factor} disabled={readOnly} onChange={(e) => setItem(i, { factor: e.target.value })} aria-label="Factor" />
            <span className="pt-2.5 text-sm">{part.uom}</span>
            <Input value={it.remark} disabled={readOnly} onChange={(e) => setItem(i, { remark: e.target.value })} placeholder="Remark" aria-label="Remark" />
            {!readOnly && <Button size="sm" variant="ghost" icon={<Trash2 className="size-4" />} onClick={() => setItems((l) => l.filter((_, j) => j !== i))} aria-label="Remove" />}
            {(field(`items.${i}.uom`) || field(`items.${i}.factor`)) && <p className="text-xs text-danger sm:col-span-7">{field(`items.${i}.uom`) ?? field(`items.${i}.factor`)}</p>}
          </li>
        ))}
      </ul>
      {!items.length && <p className="text-sm text-muted">No conversions.</p>}
      {!readOnly && (
        <div className="mt-4 flex flex-wrap gap-2">
          <Button icon={<Plus className="size-4" />} onClick={() => setItems((l) => [...l, { uom: "", factor: "", remark: "" }])}>
            Add conversion
          </Button>
          <Button variant="primary" loading={save.isPending} onClick={() => save.mutate(undefined, { onSuccess: () => (setError(null), toast.success("Conversions saved.")), onError: handle })}>
            Save conversions
          </Button>
        </div>
      )}
    </Card>
  );
}

type Loc = PartDetail["locations"][number];
function Locations({ part, readOnly }: { part: PartDetail; readOnly: boolean }) {
  const toast = useToast();
  const [editing, setEditing] = useState<Loc | "new" | null>(null);
  const [removing, setRemoving] = useState<Loc | null>(null);
  const remove = useMasterMutation((l: Loc) => api.delete(`/materials/${part.id}/locations/${l.id}`));
  const total = part.locations.reduce((s, l) => s + Number(l.qty), 0);
  const hold = part.locations.reduce((s, l) => s + Number(l.doHoldQty), 0);
  const columns: Column<Loc>[] = [
    { key: "wh", header: "Warehouse", cell: (l) => <span className="font-medium">{l.warehouseCode}</span> },
    { key: "loc", header: "Location", cell: (l) => l.locationCode },
    { key: "shelf", header: "Shelf", cell: (l) => l.shelfLocation ?? "—" },
    { key: "lot", header: "Lot no.", cell: (l) => l.lotNo ?? "—" },
    { key: "hold", header: "DO hold qty", className: "text-right", cell: (l) => <span className="tabular-nums">{l.doHoldQty}</span> },
    { key: "qty", header: "Location qty", className: "text-right", cell: (l) => <span className="font-medium tabular-nums">{l.qty}</span> },
    { key: "upd", header: "Updated", hideOnMobile: true, cell: (l) => <span className="text-xs">{l.updatedBy} · {formatDateTime(l.updatedAt)}</span> },
    ...(readOnly
      ? []
      : [
          {
            key: "actions",
            header: "",
            className: "text-right",
            cell: (l: Loc) => (
              <Button
                size="sm"
                variant="ghost"
                icon={<Trash2 className="size-4" />}
                aria-label="Remove"
                onClick={(e) => {
                  e.stopPropagation();
                  setRemoving(l);
                }}
              />
            ),
          },
        ]),
  ];
  return (
    <>
      <p className="mb-3 rounded-md bg-surface-2 px-3 py-2 text-sm text-muted">
        Keyed in by hand for now (the WMS integration will feed it later). MRS issues don't change these quantities. Total {total.toLocaleString()} {part.uom}
        {hold ? ` · DO hold ${hold.toLocaleString()}` : ""}.
      </p>
      <DataTable
        columns={columns}
        rows={part.locations}
        rowKey={(l) => l.id}
        onRowClick={readOnly ? undefined : setEditing}
        toolbar={
          !readOnly && (
            <>
              <div className="flex-1" />
              <Button variant="primary" icon={<Plus className="size-4" />} onClick={() => setEditing("new")}>
                Add location
              </Button>
            </>
          )
        }
        empty={<p className="px-4 py-12 text-center text-sm text-muted">No locations recorded.</p>}
      />
      {editing && <LocationDialog part={part} loc={editing === "new" ? null : editing} onClose={() => setEditing(null)} />}
      {removing && (
        <ConfirmDialog
          open
          onClose={() => setRemoving(null)}
          title={`Remove ${removing.warehouseCode} / ${removing.locationCode}?`}
          message="The row is removed; the audit trail keeps what it held."
          confirmLabel="Remove"
          tone="danger"
          busy={remove.isPending}
          onConfirm={() => remove.mutate(removing, { onSuccess: () => (toast.success("Location removed."), setRemoving(null)), onError: (e) => toast.error(e) })}
        />
      )}
    </>
  );
}

function LocationDialog({ part, loc, onClose }: { part: PartDetail; loc: Loc | null; onClose: () => void }) {
  const toast = useToast();
  const { field, handle } = useFormError();
  const [form, setForm] = useState({ warehouseCode: loc?.warehouseCode ?? "", locationCode: loc?.locationCode ?? "", shelfLocation: loc?.shelfLocation ?? "", lotNo: loc?.lotNo ?? "", doHoldQty: loc?.doHoldQty ?? "0", qty: loc?.qty ?? "" });
  const set = (k: keyof typeof form) => (e: { target: { value: string } }) => setForm((f) => ({ ...f, [k]: e.target.value }));
  const save = useMasterMutation(() => (loc ? api.patch(`/materials/${part.id}/locations/${loc.id}`, form) : api.post(`/materials/${part.id}/locations`, form)));
  const submit = (e: FormEvent) => {
    e.preventDefault();
    save.mutate(undefined, { onSuccess: () => (toast.success("Location saved."), onClose()), onError: handle });
  };
  return (
    <Dialog
      open
      onClose={onClose}
      title={loc ? "Edit location" : "Add location"}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" type="submit" form="loc-form" loading={save.isPending}>
            Save
          </Button>
        </>
      }
    >
      <form id="loc-form" onSubmit={submit} className="grid gap-4 sm:grid-cols-2" noValidate>
        <Field label="Warehouse code" required error={field("warehouseCode")}>{(p) => <Input {...p} value={form.warehouseCode} onChange={set("warehouseCode")} autoFocus />}</Field>
        <Field label="Location code" required error={field("locationCode")}>{(p) => <Input {...p} value={form.locationCode} onChange={set("locationCode")} />}</Field>
        <Field label="Shelf location" error={field("shelfLocation")}>{(p) => <Input {...p} value={form.shelfLocation} onChange={set("shelfLocation")} />}</Field>
        <Field label="Lot no." error={field("lotNo")}>{(p) => <Input {...p} value={form.lotNo} onChange={set("lotNo")} />}</Field>
        <Field label={`DO hold qty (${part.uom})`} error={field("doHoldQty")}>{(p) => <Input {...p} inputMode="decimal" value={form.doHoldQty} onChange={set("doHoldQty")} />}</Field>
        <Field label={`Location qty (${part.uom})`} required error={field("qty")}>{(p) => <Input {...p} inputMode="decimal" value={form.qty} onChange={set("qty")} />}</Field>
      </form>
    </Dialog>
  );
}

function Others({ part, readOnly }: { part: PartDetail; readOnly: boolean }) {
  const toast = useToast();
  const { handle } = useFormError();
  const [upload, setUpload] = useState<UploadResult | null>(null);
  const [remarks, setRemarks] = useState(part.remarks ?? "");
  const save = useMasterMutation((v: { imageFileId?: string | null; remarks?: string }) => api.patch(`/materials/${part.id}`, v));
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Card title="Image file">
        {part.image ? <ArtworkPreview file={part.image} height="h-48" /> : <p className="mb-3 text-sm text-muted">No image yet.</p>}
        {!readOnly && (
          <div className="mt-3 space-y-3">
            <ArtworkDropzone value={upload} onChange={setUpload} />
            <div className="flex flex-wrap gap-2">
              <Button variant="primary" disabled={!upload} loading={save.isPending} onClick={() => save.mutate({ imageFileId: upload?.file.id }, { onSuccess: () => (setUpload(null), toast.success("Image saved.")), onError: handle })}>
                Use this image
              </Button>
              {part.image && (
                <Button onClick={() => save.mutate({ imageFileId: null }, { onSuccess: () => toast.success("Image removed."), onError: handle })}>Remove image</Button>
              )}
            </div>
          </div>
        )}
      </Card>
      <Card title="Remark">
        <Textarea rows={5} value={remarks} disabled={readOnly} onChange={(e) => setRemarks(e.target.value)} aria-label="Remark" />
        {!readOnly && (
          <Button className="mt-3" variant="primary" loading={save.isPending} onClick={() => save.mutate({ remarks }, { onSuccess: () => toast.success("Remark saved."), onError: handle })}>
            Save remark
          </Button>
        )}
      </Card>
    </div>
  );
}
