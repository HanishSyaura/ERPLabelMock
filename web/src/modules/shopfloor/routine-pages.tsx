import { ArrowDown, ArrowUp, Plus, Trash2 } from "lucide-react";
import { useState, type FormEvent } from "react";
import { DataTable, PageHeader, type Column } from "@/components/common";
import { StatusBadge } from "@/components/status";
import { Button, Dialog, Field, Input, Select } from "@/components/ui";
import { api } from "@/lib/api";
import { useFormError } from "@/lib/use-form-error";
import { useAuth } from "@/stores/auth";
import { useToast } from "@/stores/toast";
import { usePlanningMutation, useProcesses, useRoutines, type Routine } from "@/modules/planning/api";

const Footer = ({ form, busy, onClose }: { form: string; busy: boolean; onClose: () => void }) => (
  <>
    <Button onClick={onClose}>Cancel</Button>
    <Button variant="primary" type="submit" form={form} loading={busy}>
      Save
    </Button>
  </>
);

export function RoutineMasterPage() {
  const { can } = useAuth();
  const manage = can("shopfloor.routine.manage");
  const list = useRoutines();
  const [editing, setEditing] = useState<Routine | "new" | null>(null);
  const columns: Column<Routine>[] = [
    { key: "code", header: "Routine Code", cell: (r) => <span className="font-medium">{r.code}</span> },
    { key: "name", header: "Routine Name", cell: (r) => r.name },
    { key: "steps", header: "Process sequence", cell: (r) => <span className="text-sm">{r.steps.map((s) => s.process.name).join(" → ")}</span> },
    { key: "used", header: "Master Cards", hideOnMobile: true, cell: (r) => r.masterCardCount },
    { key: "status", header: "Status", cell: (r) => <StatusBadge kind="record" value={r.status} /> },
  ];
  return (
    <>
      <PageHeader
        title="Routine Master"
        description="Standard process sequences. A Job Order copies its route from a routine when it is created, so later edits don't change existing Job Orders."
        crumbs={[{ label: "Master Data" }, { label: "Routine Master" }]}
        actions={manage && <Button variant="primary" icon={<Plus className="size-4" />} onClick={() => setEditing("new")}>New routine</Button>}
      />
      <DataTable columns={columns} rows={list.data} rowKey={(r) => r.id} loading={list.isPending} error={list.error} onRetry={() => void list.refetch()} onRowClick={manage ? setEditing : undefined} empty={<p className="px-4 py-12 text-center text-sm text-muted">No routines yet.</p>} />
      {editing && <RoutineDialog routine={editing === "new" ? null : editing} onClose={() => setEditing(null)} />}
    </>
  );
}

function RoutineDialog({ routine, onClose }: { routine: Routine | null; onClose: () => void }) {
  const toast = useToast();
  const processes = useProcesses("ACTIVE");
  const [form, setForm] = useState({ code: routine?.code ?? "", name: routine?.name ?? "", description: routine?.description ?? "", status: routine?.status ?? "ACTIVE" });
  const [steps, setSteps] = useState<string[]>(routine?.steps.map((s) => s.process.id) ?? []);
  const [add, setAdd] = useState("");
  const { field, handle } = useFormError();
  const save = usePlanningMutation(() =>
    routine
      ? api.patch(`/shopfloor/routines/${routine.id}`, { name: form.name, description: form.description, status: form.status, processIds: steps })
      : api.post("/shopfloor/routines", { code: form.code, name: form.name, description: form.description, processIds: steps }),
  );
  const names = new Map([...(processes.data ?? []), ...(routine?.steps.map((s) => s.process) ?? [])].map((p) => [p.id, p.name]));
  const move = (i: number, d: -1 | 1) => {
    const n = [...steps];
    [n[i], n[i + d]] = [n[i + d]!, n[i]!];
    setSteps(n);
  };
  const submit = (e: FormEvent) => {
    e.preventDefault();
    save.mutate(undefined, { onSuccess: () => (toast.success("Routine saved."), onClose()), onError: handle });
  };
  const set = (k: keyof typeof form) => (e: { target: { value: string } }) => setForm((f) => ({ ...f, [k]: e.target.value }));
  return (
    <Dialog open onClose={onClose} title={routine ? `Edit ${routine.code}` : "New routine"} footer={<Footer form="routine-form" busy={save.isPending} onClose={onClose} />}>
      <form id="routine-form" onSubmit={submit} className="grid gap-4 sm:grid-cols-2" noValidate>
        <Field label="Routine code" required error={field("code")} hint={routine ? "Codes can't be changed." : undefined}>
          {(p) => <Input {...p} value={form.code} disabled={!!routine} onChange={set("code")} />}
        </Field>
        <Field label="Routine name" required error={field("name")}>{(p) => <Input {...p} value={form.name} onChange={set("name")} />}</Field>
        <Field label="Description" className="sm:col-span-2">{(p) => <Input {...p} value={form.description} onChange={set("description")} />}</Field>
        <fieldset className="sm:col-span-2">
          <legend className="mb-2 text-sm font-medium">Process sequence</legend>
          {field("processIds") && <p className="mb-2 text-xs text-danger">{field("processIds")}</p>}
          <ol className="mb-2 space-y-1">
            {steps.map((id, i) => (
              <li key={`${id}-${i}`} className="flex items-center gap-2 rounded-md border border-line px-2 py-1.5 text-sm">
                <span className="w-6 text-center text-xs font-semibold text-muted">{i + 1}</span>
                <span className="flex-1">{names.get(id) ?? "…"}</span>
                <Button size="sm" variant="ghost" disabled={i === 0} icon={<ArrowUp className="size-4" />} onClick={() => move(i, -1)} aria-label="Move up" />
                <Button size="sm" variant="ghost" disabled={i === steps.length - 1} icon={<ArrowDown className="size-4" />} onClick={() => move(i, 1)} aria-label="Move down" />
                <Button size="sm" variant="ghost" icon={<Trash2 className="size-4" />} onClick={() => setSteps(steps.filter((_, j) => j !== i))} aria-label="Remove" />
              </li>
            ))}
          </ol>
          <div className="flex gap-2">
            <Select value={add} onChange={(e) => setAdd(e.target.value)} aria-label="Process to add">
              <option value="">Add a process…</option>
              {processes.data?.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name} ({p.code})
                </option>
              ))}
            </Select>
            <Button icon={<Plus className="size-4" />} disabled={!add} onClick={() => (setSteps([...steps, add]), setAdd(""))}>
              Add
            </Button>
          </div>
        </fieldset>
        {routine && (
          <Field label="Status">
            {(p) => (
              <Select {...p} value={form.status} onChange={set("status")}>
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
