import { useQuery } from "@tanstack/react-query";
import { ArrowDown, ArrowUp, Plus, Trash2 } from "lucide-react";
import { useState, type FormEvent } from "react";
import { useNavigate } from "react-router";
import { Button, Checkbox, Dialog, Field, Input, Select, Textarea } from "@/components/ui";
import { api, qs } from "@/lib/api";
import { newTxnId, useFormError } from "@/lib/use-form-error";
import { useToast } from "@/stores/toast";
import { useUoms, type BomRow } from "@/modules/bom/api";
import { ArtworkThumb } from "@/modules/bom/artwork";
import { PRIORITIES, usePlanningMutation, useProcesses, useRoutines, type PjoDetail, type WoProcess, type WoView } from "./api";

const footer = (form: string, busy: boolean, onClose: () => void, label: string) => (
  <>
    <Button onClick={onClose}>Cancel</Button>
    <Button variant="primary" type="submit" form={form} loading={busy}>
      {label}
    </Button>
  </>
);

/** Search active Father Codes. */
function FatherCodePicker({ value, onChange, invalid }: { value: BomRow | null; onChange: (b: BomRow) => void; invalid?: boolean }) {
  const [q, setQ] = useState("");
  const list = useQuery({ queryKey: ["boms", "pick", q], queryFn: () => api.list<BomRow>(`/boms${qs({ q, status: "ACTIVE", pageSize: 8 })}`) });
  return (
    <div className="space-y-2">
      <Input placeholder="Search Father Code or label description" value={q} onChange={(e) => setQ(e.target.value)} aria-invalid={invalid} />
      <div className="max-h-56 space-y-1 overflow-y-auto rounded-md border border-line p-1">
        {list.data?.data.map((b) => (
          <button
            key={b.id}
            type="button"
            onClick={() => onChange(b)}
            className={`flex w-full items-center gap-3 rounded-md p-2 text-left text-sm hover:bg-surface-2 ${value?.id === b.id ? "bg-primary-soft" : ""}`}
          >
            <ArtworkThumb file={b.artworkFile} className="size-10" />
            <span className="min-w-0">
              <span className="block font-medium">{b.fatherCode}</span>
              <span className="block truncate text-xs text-muted">
                {b.labelDescription} · Artwork Rev {String(b.artworkRevision).padStart(2, "0")} · {b.sonCount} Son Codes
              </span>
            </span>
          </button>
        ))}
        {list.data?.data.length === 0 && <p className="p-2 text-sm text-muted">No active Father Code matches.</p>}
      </div>
    </div>
  );
}

export function NewPjoDialog({ onClose }: { onClose: () => void }) {
  const toast = useToast();
  const navigate = useNavigate();
  const uoms = useUoms();
  const [bom, setBom] = useState<BomRow | null>(null);
  const [form, setForm] = useState({ orderQty: "", uom: "PCS", requiredDate: "", priority: "NORMAL", customerRef: "", productRef: "", remarks: "" });
  const { field, handle } = useFormError();
  const save = usePlanningMutation(() => api.post<{ id: string; pjoNo: string }>("/planning/production-job-orders", { ...form, bomId: bom?.id, requiredDate: form.requiredDate || null }));
  const set = (k: keyof typeof form) => (e: { target: { value: string } }) => setForm((f) => ({ ...f, [k]: e.target.value }));
  const submit = (e: FormEvent) => {
    e.preventDefault();
    save.mutate(undefined, {
      onSuccess: (r) => {
        toast.success(`${r.pjoNo} created as draft. Add Job Orders, then release it.`);
        navigate(`/planning/production-job-order/${r.id}`);
      },
      onError: handle,
    });
  };
  return (
    <Dialog open onClose={onClose} size="lg" title="New Production Job Order" description="Choose the Father Code; its current artwork and BOM revisions are frozen when the order is released." footer={footer("pjo-form", save.isPending, onClose, "Create")}>
      <form id="pjo-form" onSubmit={submit} className="grid gap-4 sm:grid-cols-2" noValidate>
        <div className="sm:col-span-2">
          <p className="mb-1.5 text-sm font-medium">
            Father Code<span className="ml-0.5 text-danger">*</span>
          </p>
          <FatherCodePicker value={bom} onChange={setBom} invalid={!!field("bomId")} />
          {field("bomId") && <p className="mt-1 text-xs text-danger">{field("bomId")}</p>}
        </div>
        <Field label="Order quantity" required error={field("orderQty")}>{(p) => <Input {...p} inputMode="decimal" value={form.orderQty} onChange={set("orderQty")} />}</Field>
        <Field label="Unit" required error={field("uom")}>
          {(p) => (
            <Select {...p} value={form.uom} onChange={set("uom")}>
              {uoms.data?.map((u) => (
                <option key={u.code} value={u.code}>
                  {u.code} – {u.label}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field label="Required date" error={field("requiredDate")}>{(p) => <Input {...p} type="date" value={form.requiredDate} onChange={set("requiredDate")} />}</Field>
        <Field label="Priority">
          {(p) => (
            <Select {...p} value={form.priority} onChange={set("priority")}>
              {PRIORITIES.map((x) => (
                <option key={x} value={x}>
                  {x.charAt(0) + x.slice(1).toLowerCase()}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field label="Customer reference" hint="e.g. customer PO number" error={field("customerRef")}>{(p) => <Input {...p} value={form.customerRef} onChange={set("customerRef")} />}</Field>
        <Field label="Product reference" error={field("productRef")}>{(p) => <Input {...p} value={form.productRef} onChange={set("productRef")} />}</Field>
        <Field label="Remarks" className="sm:col-span-2" error={field("remarks")}>{(p) => <Textarea {...p} value={form.remarks} onChange={set("remarks")} />}</Field>
      </form>
    </Dialog>
  );
}

/** Ordered list of processes (route editor). */
function RouteEditor({ value, onChange }: { value: string[]; onChange: (ids: string[]) => void }) {
  const processes = useProcesses("ACTIVE");
  const byId = new Map(processes.data?.map((p) => [p.id, p]));
  const [add, setAdd] = useState("");
  const move = (i: number, d: -1 | 1) => {
    const next = [...value];
    [next[i], next[i + d]] = [next[i + d]!, next[i]!];
    onChange(next);
  };
  return (
    <div className="space-y-2">
      <ol className="space-y-1">
        {value.map((id, i) => (
          <li key={`${id}-${i}`} className="flex items-center gap-2 rounded-md border border-line px-2 py-1.5 text-sm">
            <span className="w-6 text-center text-xs font-semibold text-muted">{i + 1}</span>
            <span className="flex-1">{byId.get(id)?.name ?? "…"}</span>
            <Button size="sm" variant="ghost" disabled={i === 0} icon={<ArrowUp className="size-4" />} onClick={() => move(i, -1)} aria-label="Move up" />
            <Button size="sm" variant="ghost" disabled={i === value.length - 1} icon={<ArrowDown className="size-4" />} onClick={() => move(i, 1)} aria-label="Move down" />
            <Button size="sm" variant="ghost" icon={<Trash2 className="size-4" />} onClick={() => onChange(value.filter((_, j) => j !== i))} aria-label="Remove step" />
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
        <Button icon={<Plus className="size-4" />} disabled={!add} onClick={() => (onChange([...value, add]), setAdd(""))}>
          Add
        </Button>
      </div>
    </div>
  );
}

export function JobOrderDialog({ pjo, wo, onClose }: { pjo?: PjoDetail; wo?: WoView; onClose: () => void }) {
  const toast = useToast();
  const routines = useRoutines();
  const remaining = pjo ? Number(pjo.orderQty) - Number(pjo.allocatedQty) : null;
  const [form, setForm] = useState({
    quantity: wo?.quantity ?? (remaining && remaining > 0 ? String(remaining) : ""),
    plannedDate: wo?.plannedDate?.slice(0, 10) ?? "",
    priority: wo?.priority ?? pjo?.priority ?? "NORMAL",
    remarks: wo?.remarks ?? "",
  });
  const [mode, setMode] = useState<"default" | "routine" | "custom">(wo ? "custom" : "default");
  const [routineId, setRoutineId] = useState("");
  const [processIds, setProcessIds] = useState<string[]>(wo?.processes.map((p) => p.process.id) ?? []);
  const { field, handle } = useFormError();
  const set = (k: keyof typeof form) => (e: { target: { value: string } }) => setForm((f) => ({ ...f, [k]: e.target.value }));
  const route = mode === "routine" ? { routineId } : mode === "custom" ? { processIds } : {};
  const save = usePlanningMutation(() =>
    wo
      ? api.patch(`/planning/work-orders/${wo.id}`, { ...form, plannedDate: form.plannedDate || null, ...route })
      : api.post<{ id: string; woNo: string }>("/planning/work-orders", { ...form, plannedDate: form.plannedDate || null, pjoId: pjo!.id, ...route }),
  );
  const submit = (e: FormEvent) => {
    e.preventDefault();
    save.mutate(undefined, { onSuccess: (r) => (toast.success(wo ? "Job Order saved." : `Job Order ${(r as { woNo: string }).woNo} created (planned). Release it when ready.`), onClose()), onError: handle });
  };
  return (
    <Dialog
      open
      onClose={onClose}
      size="lg"
      title={wo ? `Edit ${wo.woNo}` : `New Job Order – ${pjo?.pjoNo}`}
      description={pjo ? `${pjo.bom.fatherCode} · ${pjo.bom.labelDescription}. ${remaining ?? 0} ${pjo.uom} not yet in a Job Order.` : undefined}
      footer={footer("wo-form", save.isPending, onClose, wo ? "Save" : "Create Job Order")}
    >
      <form id="wo-form" onSubmit={submit} className="grid gap-4 sm:grid-cols-2" noValidate>
        <Field label={`Quantity${pjo ? ` (${pjo.uom})` : wo ? ` (${wo.uom})` : ""}`} required error={field("quantity")}>{(p) => <Input {...p} inputMode="decimal" value={form.quantity} onChange={set("quantity")} />}</Field>
        <Field label="Planned production date" error={field("plannedDate")}>{(p) => <Input {...p} type="date" value={form.plannedDate} onChange={set("plannedDate")} />}</Field>
        <Field label="Priority">
          {(p) => (
            <Select {...p} value={form.priority} onChange={set("priority")}>
              {PRIORITIES.map((x) => (
                <option key={x} value={x}>
                  {x.charAt(0) + x.slice(1).toLowerCase()}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field label="Remarks" error={field("remarks")}>{(p) => <Input {...p} value={form.remarks} onChange={set("remarks")} />}</Field>
        <fieldset className="sm:col-span-2">
          <legend className="mb-2 text-sm font-medium">Process route</legend>
          <div className="mb-3 flex flex-wrap gap-4 text-sm">
            {!wo && (
              <label className="flex items-center gap-2">
                <input type="radio" checked={mode === "default"} onChange={() => setMode("default")} /> Routine on the Master Card
              </label>
            )}
            <label className="flex items-center gap-2">
              <input type="radio" checked={mode === "routine"} onChange={() => setMode("routine")} /> A routine
            </label>
            <label className="flex items-center gap-2">
              <input type="radio" checked={mode === "custom"} onChange={() => setMode("custom")} /> Choose processes
            </label>
          </div>
          {mode === "routine" && (
            <Select value={routineId} onChange={(e) => setRoutineId(e.target.value)} aria-label="Routine">
              <option value="">Choose a routine…</option>
              {routines.data
                ?.filter((r) => r.status === "ACTIVE")
                .map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.code} – {r.name} ({r.steps.map((s) => s.process.name).join(" → ")})
                  </option>
                ))}
            </Select>
          )}
          {mode === "custom" && <RouteEditor value={processIds} onChange={setProcessIds} />}
          {(field("processIds") || field("routineId")) && <p className="mt-1 text-xs text-danger">{field("processIds") ?? field("routineId")}</p>}
        </fieldset>
      </form>
    </Dialog>
  );
}

export function AuthorizeDialog({ step, onClose }: { step: WoProcess; onClose: () => void }) {
  const toast = useToast();
  const [form, setForm] = useState({ allowPartialTransfer: step.allowPartialTransfer, allowSplit: step.allowSplit, extraAllowedQty: step.extraAllowedQty, note: "" });
  const { field, handle } = useFormError();
  const save = usePlanningMutation(() => api.put(`/planning/work-order-processes/${step.id}/authorization`, form));
  const submit = (e: FormEvent) => {
    e.preventDefault();
    save.mutate(undefined, { onSuccess: () => (toast.success("Authorisation saved."), onClose()), onError: handle });
  };
  return (
    <Dialog open onClose={onClose} title={`Authorise – ${step.process.name}`} description="Supervisor decisions for this route step. Recorded in the audit trail." footer={footer("auth-form", save.isPending, onClose, "Save")}>
      <form id="auth-form" onSubmit={submit} className="space-y-4" noValidate>
        {step.seq > 1 && (
          <Checkbox
            label="Allow partial transfer"
            description="This process may start on what the previous process has already produced, before it is completed."
            checked={form.allowPartialTransfer}
            onChange={(e) => setForm((f) => ({ ...f, allowPartialTransfer: e.target.checked }))}
          />
        )}
        <Checkbox
          label="Allow split production"
          description="Run this process on more than one machine at the same time. Combined output still can't exceed the authorised quantity."
          checked={form.allowSplit}
          onChange={(e) => setForm((f) => ({ ...f, allowSplit: e.target.checked }))}
        />
        <Field label="Extra authorised quantity" hint="Approved overrun beyond the target (or beyond what the previous process passed on)." error={field("extraAllowedQty")}>
          {(p) => <Input {...p} inputMode="decimal" value={form.extraAllowedQty} onChange={(e) => setForm((f) => ({ ...f, extraAllowedQty: e.target.value }))} />}
        </Field>
        <Field label="Reason" required error={field("note")}>{(p) => <Input {...p} value={form.note} onChange={(e) => setForm((f) => ({ ...f, note: e.target.value }))} />}</Field>
      </form>
    </Dialog>
  );
}

interface AltMachine {
  id: string;
  code: string;
  name: string;
  category: { code: string; name: string };
  status: string;
  available: boolean;
  note: string | null;
}

/** Change Machine for a paused / broken-down route step. */
export function ChangeMachineDialog({ step, canApprove, onClose }: { step: WoProcess; canApprove: boolean; onClose: () => void }) {
  const toast = useToast();
  const alts = useQuery({ queryKey: ["shopfloor", "alts", step.id], queryFn: () => api.get<AltMachine[]>(`/shopfloor/work-order-processes/${step.id}/alternative-machines`) });
  const [to, setTo] = useState("");
  const [reason, setReason] = useState("");
  const [txn] = useState(newTxnId);
  const { field, handle } = useFormError();
  const save = usePlanningMutation(() => api.post<{ status: string }>("/shopfloor/machine-changes", { woProcessId: step.id, toMachineId: to, reason, clientTxnId: txn }));
  const submit = (e: FormEvent) => {
    e.preventDefault();
    save.mutate(undefined, {
      onSuccess: (r) => (toast.success(r.status === "APPROVED" ? "Machine changed. The operator can Check In on the new machine." : "Machine change requested. A supervisor must approve it."), onClose()),
      onError: handle,
    });
  };
  return (
    <Dialog
      open
      onClose={onClose}
      title={`Change machine – ${step.process.name}`}
      description={`Currently ${step.assignedMachine ? `${step.assignedMachine.code} (${step.assignedMachine.name})` : "not assigned"}. Output so far stays with that machine; only the remaining ${step.quantities.outstanding} moves.`}
      footer={footer("change-form", save.isPending, onClose, canApprove ? "Change machine" : "Request change")}
    >
      <form id="change-form" onSubmit={submit} className="space-y-4" noValidate>
        <fieldset>
          <legend className="mb-2 text-sm font-medium">New machine</legend>
          {field("toMachineId") && <p className="mb-2 text-xs text-danger">{field("toMachineId")}</p>}
          <div className="space-y-1">
            {alts.data?.map((m) => (
              <label key={m.id} className={`flex items-start gap-2 rounded-md border border-line p-2 text-sm ${m.available ? "cursor-pointer hover:bg-surface-2" : "opacity-60"}`}>
                <input type="radio" name="to" disabled={!m.available} checked={to === m.id} onChange={() => setTo(m.id)} className="mt-1" />
                <span>
                  <span className="font-medium">{m.code}</span> – {m.name} <span className="text-muted">({m.category.name})</span>
                  {m.note && <span className="block text-xs text-muted">{m.note}</span>}
                </span>
              </label>
            ))}
            {alts.data?.length === 0 && <p className="text-sm text-muted">No other machine can do {step.process.name}.</p>}
          </div>
        </fieldset>
        <Field label="Reason" required error={field("reason")}>{(p) => <Input {...p} value={reason} onChange={(e) => setReason(e.target.value)} />}</Field>
        {!canApprove && <p className="text-xs text-muted">Your request waits for a supervisor's approval before anyone can Check In on the new machine.</p>}
      </form>
    </Dialog>
  );
}
