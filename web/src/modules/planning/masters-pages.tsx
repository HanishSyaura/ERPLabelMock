import { useQuery } from "@tanstack/react-query";
import { Barcode as BarcodeIcon, Plus, Users } from "lucide-react";
import { useMemo, useState, type FormEvent } from "react";
import { useSearchParams } from "react-router";
import { Barcode, BarcodePrintDialog } from "@/components/barcode";
import { DataTable, PageHeader, SearchInput, Tabs, type Column } from "@/components/common";
import { StatusBadge } from "@/components/status";
import { Button, Checkbox, Dialog, Field, Input, Select, Textarea } from "@/components/ui";
import { api, qs } from "@/lib/api";
import { useFormError } from "@/lib/use-form-error";
import { formatDateTime } from "@/lib/utils";
import { useAuth } from "@/stores/auth";
import { useToast } from "@/stores/toast";
import { useDevices, useMachineCategories, useMachines, usePlanningMutation, useProcesses, type Device, type Machine, type MachineCategory, type Process } from "./api";

// ---------------------------------------------------------------------------
// Process
// ---------------------------------------------------------------------------

export function ProcessPage() {
  const { can } = useAuth();
  const manage = can("planning.master.manage");
  const list = useProcesses();
  const [editing, setEditing] = useState<Process | "new" | null>(null);
  const toggle = usePlanningMutation((p: Process) => api.put(`/planning/processes/${p.id}/status`, { status: p.status === "ACTIVE" ? "INACTIVE" : "ACTIVE" }));
  const toast = useToast();
  const columns: Column<Process>[] = [
    { key: "seq", header: "Seq", className: "w-16 tabular-nums", cell: (p) => p.sequence },
    { key: "code", header: "Process Code", cell: (p) => <span className="font-medium">{p.code}</span> },
    { key: "name", header: "Process Name", cell: (p) => p.name },
    { key: "desc", header: "Description", hideOnMobile: true, cell: (p) => p.description ?? <span className="text-muted">—</span> },
    { key: "cats", header: "Machine categories", hideOnMobile: true, cell: (p) => p.categoryCount },
    { key: "status", header: "Status", cell: (p) => <StatusBadge kind="record" value={p.status} /> },
    ...(manage
      ? [
          {
            key: "act",
            header: "",
            className: "text-right",
            cell: (p: Process) => (
              <Button size="sm" variant="ghost" onClick={(e) => (e.stopPropagation(), toggle.mutate(p, { onSuccess: () => toast.success(`${p.code} ${p.status === "ACTIVE" ? "deactivated" : "activated"}.`), onError: toast.error }))}>
                {p.status === "ACTIVE" ? "Deactivate" : "Activate"}
              </Button>
            ),
          },
        ]
      : []),
  ];
  return (
    <>
      <PageHeader
        title="Process"
        description="Manufacturing activities (printing, lamination, die cutting, slitting…). Machine categories say which machines can do each process."
        crumbs={[{ label: "Master Data" }, { label: "Process" }]}
        actions={manage && <Button variant="primary" icon={<Plus className="size-4" />} onClick={() => setEditing("new")}>New process</Button>}
      />
      <DataTable columns={columns} rows={list.data} rowKey={(p) => p.id} loading={list.isPending} error={list.error} onRetry={() => void list.refetch()} onRowClick={manage ? setEditing : undefined} empty={<Empty text="No processes yet. Add the label printing processes your factory uses." />} />
      {editing && <ProcessDialog process={editing === "new" ? null : editing} onClose={() => setEditing(null)} />}
    </>
  );
}

const Empty = ({ text }: { text: string }) => <p className="px-4 py-12 text-center text-sm text-muted">{text}</p>;

function ProcessDialog({ process, onClose }: { process: Process | null; onClose: () => void }) {
  const toast = useToast();
  const [form, setForm] = useState({ code: process?.code ?? "", name: process?.name ?? "", description: process?.description ?? "", sequence: String(process?.sequence ?? 0) });
  const { field, handle } = useFormError();
  const save = usePlanningMutation(() =>
    process
      ? api.patch(`/planning/processes/${process.id}`, { name: form.name, description: form.description, sequence: Number(form.sequence) || 0 })
      : api.post("/planning/processes", { ...form, sequence: Number(form.sequence) || 0 }),
  );
  const submit = (e: FormEvent) => {
    e.preventDefault();
    save.mutate(undefined, { onSuccess: () => (toast.success("Process saved."), onClose()), onError: handle });
  };
  const set = (k: keyof typeof form) => (e: { target: { value: string } }) => setForm((f) => ({ ...f, [k]: e.target.value }));
  return (
    <Dialog open onClose={onClose} title={process ? `Edit ${process.code}` : "New process"} footer={<FormFooter form="process-form" busy={save.isPending} onClose={onClose} />}>
      <form id="process-form" onSubmit={submit} className="grid gap-4 sm:grid-cols-2" noValidate>
        <Field label="Process code" required error={field("code")} hint={process ? "Codes can't be changed." : "e.g. PRINT"}>
          {(p) => <Input {...p} value={form.code} disabled={!!process} onChange={set("code")} />}
        </Field>
        <Field label="Process name" required error={field("name")}>{(p) => <Input {...p} value={form.name} onChange={set("name")} />}</Field>
        <Field label="Sequence" hint="Typical position in the flow (display order)" error={field("sequence")}>
          {(p) => <Input {...p} inputMode="numeric" value={form.sequence} onChange={set("sequence")} />}
        </Field>
        <Field label="Description" className="sm:col-span-2" error={field("description")}>{(p) => <Input {...p} value={form.description} onChange={set("description")} />}</Field>
      </form>
    </Dialog>
  );
}

const FormFooter = ({ form, busy, onClose, label = "Save" }: { form: string; busy: boolean; onClose: () => void; label?: string }) => (
  <>
    <Button onClick={onClose}>Cancel</Button>
    <Button variant="primary" type="submit" form={form} loading={busy}>
      {label}
    </Button>
  </>
);

// ---------------------------------------------------------------------------
// Machine Category
// ---------------------------------------------------------------------------

export function MachineCategoryPage() {
  const { can } = useAuth();
  const manage = can("planning.master.manage");
  const list = useMachineCategories();
  const [editing, setEditing] = useState<MachineCategory | "new" | null>(null);
  const [operators, setOperators] = useState<MachineCategory | null>(null);
  const columns: Column<MachineCategory>[] = [
    { key: "code", header: "Category Code", cell: (c) => <span className="font-medium">{c.code}</span> },
    { key: "name", header: "Category Name", cell: (c) => c.name },
    { key: "proc", header: "Processes", cell: (c) => (c.processes.length ? c.processes.map((p) => p.name).join(", ") : <span className="text-muted">None</span>) },
    { key: "mach", header: "Machines", hideOnMobile: true, cell: (c) => c.machineCount },
    { key: "ops", header: "Qualified operators", hideOnMobile: true, cell: (c) => c.qualifiedOperatorCount },
    { key: "status", header: "Status", cell: (c) => <StatusBadge kind="record" value={c.status} /> },
    {
      key: "act",
      header: "",
      className: "text-right",
      cell: (c) => (
        <Button size="sm" variant="ghost" icon={<Users className="size-4" />} onClick={(e) => (e.stopPropagation(), setOperators(c))}>
          Operators
        </Button>
      ),
    },
  ];
  return (
    <>
      <PageHeader
        title="Machine Category"
        description="Groups machines of the same type. Each category lists the processes it can do and the operators authorised to run it."
        crumbs={[{ label: "Master Data" }, { label: "Machine Category" }]}
        actions={manage && <Button variant="primary" icon={<Plus className="size-4" />} onClick={() => setEditing("new")}>New category</Button>}
      />
      <DataTable columns={columns} rows={list.data} rowKey={(c) => c.id} loading={list.isPending} error={list.error} onRetry={() => void list.refetch()} onRowClick={manage ? setEditing : undefined} empty={<Empty text="No machine categories yet." />} />
      {editing && <CategoryDialog category={editing === "new" ? null : editing} onClose={() => setEditing(null)} />}
      {operators && <OperatorsDialog category={operators} editable={manage} onClose={() => setOperators(null)} />}
    </>
  );
}

function CategoryDialog({ category, onClose }: { category: MachineCategory | null; onClose: () => void }) {
  const toast = useToast();
  const processes = useProcesses("ACTIVE");
  const [form, setForm] = useState({ code: category?.code ?? "", name: category?.name ?? "", description: category?.description ?? "" });
  const [processIds, setProcessIds] = useState<string[]>(category?.processes.map((p) => p.id) ?? []);
  const [status, setStatus] = useState(category?.status ?? "ACTIVE");
  const { field, handle } = useFormError();
  const save = usePlanningMutation(async () => {
    if (!category) return api.post("/planning/machine-categories", { ...form, processIds });
    await api.patch(`/planning/machine-categories/${category.id}`, { name: form.name, description: form.description, processIds });
    if (status !== category.status) await api.put(`/planning/machine-categories/${category.id}/status`, { status });
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    save.mutate(undefined, { onSuccess: () => (toast.success("Machine category saved."), onClose()), onError: handle });
  };
  const set = (k: keyof typeof form) => (e: { target: { value: string } }) => setForm((f) => ({ ...f, [k]: e.target.value }));
  return (
    <Dialog open onClose={onClose} title={category ? `Edit ${category.code}` : "New machine category"} footer={<FormFooter form="cat-form" busy={save.isPending} onClose={onClose} />}>
      <form id="cat-form" onSubmit={submit} className="grid gap-4 sm:grid-cols-2" noValidate>
        <Field label="Category code" required error={field("code")} hint={category ? "Codes can't be changed." : "e.g. FLEXO"}>
          {(p) => <Input {...p} value={form.code} disabled={!!category} onChange={set("code")} />}
        </Field>
        <Field label="Category name" required error={field("name")}>{(p) => <Input {...p} value={form.name} onChange={set("name")} />}</Field>
        <Field label="Description" className="sm:col-span-2" error={field("description")}>{(p) => <Input {...p} value={form.description} onChange={set("description")} />}</Field>
        <fieldset className="sm:col-span-2">
          <legend className="mb-2 text-sm font-medium">Processes this category can do</legend>
          {field("processIds") && <p className="mb-2 text-xs text-danger">{field("processIds")}</p>}
          <div className="grid gap-2 sm:grid-cols-2">
            {processes.data?.map((p) => (
              <Checkbox key={p.id} label={`${p.name} (${p.code})`} checked={processIds.includes(p.id)} onChange={(e) => setProcessIds((ids) => (e.target.checked ? [...ids, p.id] : ids.filter((x) => x !== p.id)))} />
            ))}
            {processes.data?.length === 0 && <p className="text-sm text-muted">Add processes on the Process page first.</p>}
          </div>
        </fieldset>
        {category && (
          <Field label="Status">
            {(p) => (
              <Select {...p} value={status} onChange={(e) => setStatus(e.target.value as typeof status)}>
                <option value="ACTIVE">Active</option>
                <option value="INACTIVE">Inactive</option>
              </Select>
            )}
          </Field>
        )}
      </form>
    </Dialog>
  );
}

interface UserLite {
  id: string;
  username: string;
  fullName: string;
  employeeNo: string | null;
  status: string;
}

function OperatorsDialog({ category, editable, onClose }: { category: MachineCategory; editable: boolean; onClose: () => void }) {
  const toast = useToast();
  const current = useQuery({ queryKey: ["planning", "categories", category.id, "ops"], queryFn: () => api.get<UserLite[]>(`/planning/machine-categories/${category.id}/operators`) });
  const [search, setSearch] = useState("");
  const candidates = useQuery({
    queryKey: ["users", "pick", search],
    queryFn: () => api.list<UserLite>(`/users${qs({ q: search, status: "ACTIVE", pageSize: 50 })}`),
    enabled: editable,
  });
  const [selected, setSelected] = useState<Set<string> | null>(null);
  const ids = selected ?? new Set(current.data?.map((u) => u.id) ?? []);
  const known = useMemo(() => {
    const m = new Map<string, UserLite>();
    current.data?.forEach((u) => m.set(u.id, u));
    candidates.data?.data.forEach((u) => m.set(u.id, u));
    return m;
  }, [current.data, candidates.data]);
  const save = usePlanningMutation(() => api.put(`/planning/machine-categories/${category.id}/operators`, { userIds: [...ids] }));
  const toggle = (id: string, on: boolean) => {
    const next = new Set(ids);
    if (on) next.add(id);
    else next.delete(id);
    setSelected(next);
  };
  const list = editable ? [...new Map([...(current.data ?? []), ...(candidates.data?.data ?? [])].map((u) => [u.id, u])).values()] : (current.data ?? []);
  return (
    <Dialog
      open
      onClose={onClose}
      title={`Qualified operators – ${category.name}`}
      description="Only these operators can Check In on machines of this category (unless they hold “Operate any machine”)."
      footer={
        editable ? (
          <>
            <Button onClick={onClose}>Cancel</Button>
            <Button variant="primary" loading={save.isPending} onClick={() => save.mutate(undefined, { onSuccess: () => (toast.success("Operators saved."), onClose()), onError: toast.error })}>
              Save ({ids.size})
            </Button>
          </>
        ) : undefined
      }
    >
      {editable && (
        <div className="mb-3">
          <SearchInput value={search} onChange={setSearch} placeholder="Search users" />
        </div>
      )}
      <div className="max-h-80 space-y-2 overflow-y-auto">
        {list.map((u) => (
          <Checkbox key={u.id} disabled={!editable} label={`${u.fullName} (${u.username}${u.employeeNo ? ` · ${u.employeeNo}` : ""})`} checked={ids.has(u.id)} onChange={(e) => toggle(u.id, e.target.checked)} />
        ))}
        {!list.length && <p className="text-sm text-muted">No operators yet.</p>}
        {[...ids].filter((id) => !known.has(id)).length > 0 && <p className="text-xs text-muted">Some selected users are hidden by the search.</p>}
      </div>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Machine (+ handheld devices)
// ---------------------------------------------------------------------------

export function MachinePage() {
  const { can } = useAuth();
  const [params, setParams] = useSearchParams();
  const tab = params.get("tab") === "devices" ? "devices" : "machines";
  return (
    <>
      <PageHeader
        title="Machine"
        description="Each machine has a unique code printed as its barcode. Operators scan it on shared handhelds; a handheld can also be pinned to one machine."
        crumbs={[{ label: "Master Data" }, { label: "Machine" }]}
      />
      <Tabs
        value={tab}
        onChange={(t) => setParams(t === "machines" ? {} : { tab: t })}
        tabs={[{ id: "machines", label: "Machines" }, ...(can("shopfloor.device.manage") || can("planning.master.view") ? [{ id: "devices" as const, label: "Handheld devices" }] : [])]}
      />
      {tab === "machines" ? <MachineList /> : <DeviceList />}
    </>
  );
}

function MachineList() {
  const { can } = useAuth();
  const manage = can("planning.master.manage");
  const [q, setQ] = useState("");
  const [status, setStatus] = useState("");
  const list = useMachines({ q, status });
  const [editing, setEditing] = useState<Machine | "new" | null>(null);
  const [label, setLabel] = useState<Machine | null>(null);
  const columns: Column<Machine>[] = [
    { key: "code", header: "Machine Code", cell: (m) => <span className="font-medium">{m.code}</span> },
    { key: "name", header: "Machine Name", cell: (m) => m.name },
    { key: "cat", header: "Machine Category", cell: (m) => m.category.name },
    { key: "loc", header: "Location", hideOnMobile: true, cell: (m) => m.location ?? <span className="text-muted">—</span> },
    { key: "state", header: "Machine Status", cell: (m) => (m.isActive ? <StatusBadge kind="machine" value={m.status} /> : <StatusBadge kind="record" value="INACTIVE" />) },
    { key: "dev", header: "Handheld", hideOnMobile: true, cell: (m) => (m.devices.length ? m.devices.map((d) => d.name ?? d.id.slice(0, 8)).join(", ") : <span className="text-muted">Shared</span>) },
    {
      key: "act",
      header: "",
      className: "text-right",
      cell: (m) => (
        <Button size="sm" variant="ghost" icon={<BarcodeIcon className="size-4" />} onClick={(e) => (e.stopPropagation(), setLabel(m))}>
          Barcode
        </Button>
      ),
    },
  ];
  return (
    <>
      <DataTable
        columns={columns}
        rows={list.data}
        rowKey={(m) => m.id}
        loading={list.isPending}
        error={list.error}
        onRetry={() => void list.refetch()}
        onRowClick={manage ? setEditing : undefined}
        toolbar={
          <>
            <SearchInput value={q} onChange={setQ} placeholder="Search code, name, location" />
            <Select value={status} onChange={(e) => setStatus(e.target.value)} className="sm:w-40" aria-label="Status">
              <option value="">All machines</option>
              <option value="ACTIVE">Active</option>
              <option value="INACTIVE">Deactivated</option>
            </Select>
            <div className="flex-1" />
            {manage && (
              <Button variant="primary" icon={<Plus className="size-4" />} onClick={() => setEditing("new")}>
                New machine
              </Button>
            )}
          </>
        }
        empty={<Empty text="No machines yet." />}
      />
      {editing && <MachineDialog machine={editing === "new" ? null : editing} onClose={() => setEditing(null)} />}
      {label && (
        <BarcodePrintDialog title={`Machine barcode – ${label.code}`} onClose={() => setLabel(null)}>
          <div className="flex flex-col items-center gap-2 text-center">
            <p className="text-xl font-bold">{label.code}</p>
            <p className="text-sm">
              {label.name} · {label.category.name}
            </p>
            <Barcode value={label.code} />
            <Barcode value={label.code} kind="qrcode" scale={4} />
          </div>
        </BarcodePrintDialog>
      )}
    </>
  );
}

function MachineDialog({ machine, onClose }: { machine: Machine | null; onClose: () => void }) {
  const toast = useToast();
  const cats = useMachineCategories();
  const [form, setForm] = useState({
    code: machine?.code ?? "",
    name: machine?.name ?? "",
    categoryId: machine?.categoryId ?? "",
    description: machine?.description ?? "",
    location: machine?.location ?? "",
    remarks: machine?.remarks ?? "",
  });
  const [active, setActive] = useState(machine?.isActive ?? true);
  const { field, handle } = useFormError();
  const save = usePlanningMutation(async () => {
    if (!machine) return api.post("/planning/machines", form);
    const { code: _code, ...rest } = form;
    void _code;
    await api.patch(`/planning/machines/${machine.id}`, rest);
    if (active !== machine.isActive) await api.put(`/planning/machines/${machine.id}/active`, { isActive: active });
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    save.mutate(undefined, { onSuccess: () => (toast.success("Machine saved."), onClose()), onError: handle });
  };
  const set = (k: keyof typeof form) => (e: { target: { value: string } }) => setForm((f) => ({ ...f, [k]: e.target.value }));
  return (
    <Dialog open onClose={onClose} title={machine ? `Edit ${machine.code}` : "New machine"} footer={<FormFooter form="machine-form" busy={save.isPending} onClose={onClose} />}>
      <form id="machine-form" onSubmit={submit} className="grid gap-4 sm:grid-cols-2" noValidate>
        <Field label="Machine code" required error={field("code")} hint={machine ? "The code is the barcode; it can't be changed." : "Printed as the machine barcode, e.g. FX-01"}>
          {(p) => <Input {...p} value={form.code} disabled={!!machine} onChange={set("code")} />}
        </Field>
        <Field label="Machine name" required error={field("name")}>{(p) => <Input {...p} value={form.name} onChange={set("name")} />}</Field>
        <Field label="Machine category" required error={field("categoryId")}>
          {(p) => (
            <Select {...p} value={form.categoryId} onChange={set("categoryId")}>
              <option value="">Choose…</option>
              {cats.data
                ?.filter((c) => c.status === "ACTIVE" || c.id === form.categoryId)
                .map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name} ({c.code})
                  </option>
                ))}
            </Select>
          )}
        </Field>
        <Field label="Location" error={field("location")}>{(p) => <Input {...p} value={form.location} onChange={set("location")} />}</Field>
        <Field label="Description" className="sm:col-span-2" error={field("description")}>{(p) => <Input {...p} value={form.description} onChange={set("description")} />}</Field>
        <Field label="Operational remarks" className="sm:col-span-2" error={field("remarks")}>{(p) => <Textarea {...p} value={form.remarks} onChange={set("remarks")} />}</Field>
        {machine && (
          <div className="sm:col-span-2">
            <Checkbox label="Machine is active" description="Deactivated machines can't be used. History is kept." checked={active} onChange={(e) => setActive(e.target.checked)} />
          </div>
        )}
      </form>
    </Dialog>
  );
}

function DeviceList() {
  const { can } = useAuth();
  const manage = can("shopfloor.device.manage");
  const devices = useDevices();
  const machines = useMachines({ status: "ACTIVE" });
  const toast = useToast();
  const save = usePlanningMutation((v: { id: string; assignedMachineId?: string | null; name?: string }) => api.patch(`/planning/handheld-devices/${encodeURIComponent(v.id)}`, v));
  const columns: Column<Device>[] = [
    {
      key: "name",
      header: "Device",
      cell: (d) =>
        manage ? (
          <Input
            defaultValue={d.name ?? ""}
            placeholder={d.id.slice(0, 12)}
            className="h-8 w-48"
            aria-label="Device name"
            onBlur={(e) => e.target.value !== (d.name ?? "") && save.mutate({ id: d.id, name: e.target.value }, { onSuccess: () => toast.success("Device renamed."), onError: toast.error })}
          />
        ) : (
          (d.name ?? d.id.slice(0, 12))
        ),
    },
    {
      key: "machine",
      header: "Pinned machine",
      cell: (d) =>
        manage ? (
          <Select
            value={d.assignedMachine?.id ?? ""}
            className="h-8 w-56"
            aria-label="Pinned machine"
            onChange={(e) =>
              save.mutate({ id: d.id, assignedMachineId: e.target.value || null }, { onSuccess: () => toast.success(e.target.value ? "Device pinned to the machine." : "Device is now shared."), onError: toast.error })
            }
          >
            <option value="">Shared (scan machine)</option>
            {machines.data?.map((m) => (
              <option key={m.id} value={m.id}>
                {m.code} – {m.name}
              </option>
            ))}
          </Select>
        ) : (
          (d.assignedMachine?.code ?? "Shared")
        ),
    },
    { key: "seen", header: "Last seen", hideOnMobile: true, cell: (d) => <span className="text-muted">{formatDateTime(d.lastSeenAt)}</span> },
    { key: "user", header: "Last operator", hideOnMobile: true, cell: (d) => d.lastUserName ?? "—" },
  ];
  return (
    <DataTable
      columns={columns}
      rows={devices.data}
      rowKey={(d) => d.id}
      loading={devices.isPending}
      error={devices.error}
      onRetry={() => void devices.refetch()}
      empty={<Empty text="No handheld has connected yet. A device appears here after an operator signs in on it (Handheld app at /hh)." />}
    />
  );
}

