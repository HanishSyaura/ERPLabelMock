import { useQuery } from "@tanstack/react-query";
import { ArrowDownToLine, ArrowUpFromLine, Ban, PackagePlus, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import { Navigate, useNavigate, useParams } from "react-router";
import { StatusBadge } from "@/components/status";
import { Button, Spinner } from "@/components/ui";
import { api, qs } from "@/lib/api";
import { cn } from "@/lib/utils";
import { useAuth } from "@/stores/auth";
import { MOVEMENT_LABEL, MOVEMENT_PATH, MOVEMENT_PERMISSION, type MovementType, type MrsDetail, type MrsLineView, type MrsRow } from "@/modules/planning/ops-api";
import { Alert, BackLink, Centered, ErrorPanel, QtyInput, ResultPanel, TextInput, TxButton, TxError, useTransaction } from "./handheld-app";
import { ModuleBand } from "./handheld-home";
import { ScanBox } from "./scan-box";

/**
 * Handheld material movements for the store and the floor: scan the MRS (or
 * the Job Order barcode), pick the material, enter the quantity. Same API and
 * limits as the desktop MRS screens; every save has a transaction id, so a
 * retry after a network drop is never counted twice.
 */

export const MATERIAL_TASKS: { type: MovementType; label: string; hint: string; icon: typeof PackagePlus }[] = [
  { type: "ISSUE", label: "Issue material", hint: "Hand material to a job", icon: ArrowUpFromLine },
  { type: "ADDITIONAL_ISSUE", label: "Additional issue", hint: "More than the MRS asked for", icon: PackagePlus },
  { type: "RETURN", label: "Return material", hint: "Unused material back to store", icon: ArrowDownToLine },
  { type: "REJECT", label: "Reject material", hint: "Damaged or defective", icon: Ban },
  { type: "SCRAP", label: "Scrap material", hint: "Destroyed during production", icon: Trash2 },
];
const SLUG: Record<string, MovementType> = { issue: "ISSUE", "additional-issue": "ADDITIONAL_ISSUE", return: "RETURN", reject: "REJECT", scrap: "SCRAP" };
const REASON: Partial<Record<MovementType, string>> = { ADDITIONAL_ISSUE: "ADDITIONAL_ISSUE", REJECT: "REJECT", SCRAP: "SCRAP" };

function lineAllowed(type: MovementType, l: MrsLineView) {
  if (type === "ISSUE") return Number(l.remainingToIssue) > 0;
  if (type === "ADDITIONAL_ISSUE") return Number(l.remainingToIssue) === 0;
  return Number(l.onHand) > 0;
}
function lineLimit(type: MovementType, l: MrsLineView) {
  if (type === "ISSUE") return `${l.remainingToIssue} ${l.uom} to issue`;
  if (type === "ADDITIONAL_ISSUE") return `request fully issued (${l.issued} ${l.uom})`;
  return `${l.onHand} ${l.uom} out on this line`;
}

export function HandheldMaterial() {
  const { type: slug = "" } = useParams();
  const type = SLUG[slug];
  const { can } = useAuth();
  const navigate = useNavigate();
  const [mrsId, setMrsId] = useState<string | null>(null);
  const [lineId, setLineId] = useState<string | null>(null);
  if (!type) return <Navigate to="/hh" replace />;
  if (!can(MOVEMENT_PERMISSION[type])) return <ErrorPanel message={`This account can't record ${MOVEMENT_LABEL[type].toLowerCase()}.`} onRetry={() => navigate("/hh")} retryLabel="Back" />;
  const task = MATERIAL_TASKS.find((t) => t.type === type)!;
  const toModule = () => navigate("/hh/module/material");
  return (
    <>
      <ModuleBand module="material" title={task.label} onBack={toModule} />
      {!mrsId ? (
        <FindMrs type={type} title={task.label} onBack={toModule} onPick={setMrsId} />
      ) : !lineId ? (
        <PickLine type={type} mrsId={mrsId} onBack={() => setMrsId(null)} onPick={setLineId} />
      ) : (
        <MovementForm type={type} mrsId={mrsId} lineId={lineId} onBack={() => setLineId(null)} onDone={(next) => (next === "line" ? setLineId(null) : (setLineId(null), setMrsId(null)))} />
      )}
    </>
  );
}

function FindMrs({ type, title, onBack, onPick }: { type: MovementType; title: string; onBack: () => void; onPick: (id: string) => void }) {
  const [code, setCode] = useState<string | null>(null);
  const outward = type === "ISSUE" || type === "ADDITIONAL_ISSUE";
  const found = useQuery({
    queryKey: ["hh", "mrs-find", code, outward],
    queryFn: () => api.list<MrsRow>(`/material/requisitions${qs({ q: code ?? "", pageSize: 20, ...(outward ? {} : { withOnHand: "1" }) })}`),
    enabled: code !== null,
  });
  const open = (found.data?.data ?? []).filter((m) => !["CLOSED", "CANCELLED"].includes(m.status));
  const single = code !== null && found.data && open.length === 1 ? open[0]!.id : null;
  // One match: go straight to it (the scan already identified the sheet).
  useEffect(() => {
    if (single) onPick(single);
  }, [single, onPick]);
  if (single) return <Centered><Spinner className="size-8" /></Centered>;
  return (
    <div className="space-y-4">
      <BackLink onClick={onBack} />
      <h2 className="text-xl font-semibold">{title}</h2>
      <ScanBox label="Scan the MRS or Job Order barcode" placeholder="e.g. MRS-2026-00001 or JO-2026-00001" onScan={setCode} busy={found.isFetching} />
      {found.error && <Alert tone="danger">{(found.error as Error).message}</Alert>}
      {code !== null && found.data && open.length === 0 && (
        <Alert tone="warning">{outward ? `No open MRS found for "${code}".` : `No open MRS with material out found for "${code}".`}</Alert>
      )}
      {open.length > 1 && (
        <div className="space-y-2">
          <p className="text-base font-medium">Several MRS match. Choose one:</p>
          {open.map((m) => (
            <button key={m.id} onClick={() => onPick(m.id)} className="flex w-full items-center justify-between gap-3 rounded-xl border-2 border-line bg-surface p-4 text-left">
              <span className="min-w-0">
                <span className="block text-lg font-semibold">{m.mrsNo}</span>
                <span className="block truncate text-sm text-muted">
                  {m.workOrder.woNo} · {m.fatherCode}
                </span>
              </span>
              <StatusBadge kind="mrs" value={m.status} />
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function useMrsDetail(id: string) {
  return useQuery({ queryKey: ["hh", "mrs", id], queryFn: () => api.get<MrsDetail>(`/material/requisitions/${id}`) });
}

function PickLine({ type, mrsId, onBack, onPick }: { type: MovementType; mrsId: string; onBack: () => void; onPick: (id: string) => void }) {
  const mrs = useMrsDetail(mrsId);
  if (mrs.isPending) return <Centered><Spinner className="size-8" /></Centered>;
  if (mrs.error) return <ErrorPanel message={(mrs.error as Error).message} onRetry={() => void mrs.refetch()} />;
  const m = mrs.data;
  const usable = m.lines.filter((l) => lineAllowed(type, l));
  return (
    <div className="space-y-4">
      <BackLink onClick={onBack} label="Scan another" />
      <div>
        <p className="text-2xl font-bold">{m.mrsNo}</p>
        <p className="text-base">
          {m.workOrder.woNo} · {m.pjo.fatherCode}
        </p>
        <p className="line-clamp-2 text-sm text-muted">{m.pjo.labelDescription}</p>
      </div>
      {m.workOrder.status === "ON_HOLD" && (type === "ISSUE" || type === "ADDITIONAL_ISSUE") && <Alert tone="danger">Job Order on hold: {m.workOrder.holdReason}. Issue is refused until the hold is released.</Alert>}
      <p className="text-base font-medium">Which material?</p>
      <div className="space-y-2">
        {m.lines.map((l) => {
          const ok = lineAllowed(type, l);
          return (
            <button key={l.id} disabled={!ok} onClick={() => onPick(l.id)} className={cn("w-full rounded-xl border-2 p-4 text-left", ok ? "border-line bg-surface active:bg-surface-2" : "border-line bg-surface-2 opacity-50")}>
              <p className="text-lg font-semibold">{l.materialCode}</p>
              <p className="text-sm text-muted">{l.materialDescription}</p>
              <p className="mt-1 text-base tabular-nums">{lineLimit(type, l)}</p>
            </button>
          );
        })}
      </div>
      {usable.length === 0 && <Alert tone="info">Nothing on this MRS can be {MOVEMENT_LABEL[type].toLowerCase().replace("issue", "issued")} right now.</Alert>}
    </div>
  );
}

function MovementForm({ type, mrsId, lineId, onBack, onDone }: { type: MovementType; mrsId: string; lineId: string; onBack: () => void; onDone: (next: "line" | "new") => void }) {
  const mrs = useMrsDetail(mrsId);
  const reasonCategory = REASON[type];
  const reasons = useQuery({ queryKey: ["hh", "reasons", reasonCategory], queryFn: () => api.get<{ id: string; code: string; description: string }[]>(`/material/reasons${qs({ category: reasonCategory, status: "ACTIVE" })}`), enabled: !!reasonCategory });
  const device = useQuery({ queryKey: ["hh", "device"], queryFn: () => api.get<{ assignedMachine: { id: string; code: string } | null }>("/shopfloor/device"), enabled: type === "SCRAP" });
  const [qty, setQty] = useState("");
  const [lot, setLot] = useState("");
  const [reason, setReason] = useState("");
  const [step, setStep] = useState("");
  const [remarks, setRemarks] = useState("");
  const [done, setDone] = useState<{ txnNo: string; line: MrsLineView; replayed: boolean } | null>(null);
  const tx = useTransaction();
  if (mrs.isPending) return <Centered><Spinner className="size-8" /></Centered>;
  if (mrs.error) return <ErrorPanel message={(mrs.error as Error).message} onRetry={() => void mrs.refetch()} />;
  const line = mrs.data.lines.find((l) => l.id === lineId);
  if (!line) return <ErrorPanel message="This material line was not found." onRetry={onBack} retryLabel="Back" />;

  if (done) {
    const more = lineAllowed(type, done.line);
    return (
      <div className="space-y-3">
        <ResultPanel
          ok
          title={`${MOVEMENT_LABEL[type]} saved`}
          lines={[`${done.txnNo}${done.replayed ? " (already saved earlier)" : ""}`, `${qty} ${line.uom} ${line.materialCode}`, `Out on line now: ${done.line.onHand} ${line.uom}`, ...(type === "ISSUE" ? [`Still to issue: ${done.line.remainingToIssue}`] : [])]}
          onDone={() => onDone("new")}
        />
        <Button size="lg" className="w-full" onClick={() => onDone("line")}>
          Another material on {mrs.data.mrsNo}
        </Button>
        {more && <p className="text-center text-sm text-muted">This line can take more.</p>}
      </div>
    );
  }

  const submit = () =>
    void tx.run<{ txnNo: string; line: MrsLineView; replayed: boolean }>(
      `/material/lines/${lineId}/${MOVEMENT_PATH[type]}`,
      {
        qty,
        lotRef: lot || null,
        reasonCodeId: reason || null,
        machineId: type === "SCRAP" ? (device.data?.assignedMachine?.id ?? null) : null,
        woProcessId: step || null,
        remarks: remarks || null,
      },
      setDone,
    );

  return (
    <div className="space-y-4">
      <BackLink onClick={onBack} label="Other material" />
      <div>
        <h2 className="text-xl font-semibold">{MOVEMENT_LABEL[type]}</h2>
        <p className="text-base">
          {line.materialCode} · {mrs.data.mrsNo}
        </p>
        <p className="text-sm text-muted">{lineLimit(type, line)}</p>
      </div>
      <QtyInput label="Quantity" value={qty} onChange={setQty} unit={line.uom} autoFocus />
      <TextInput label="Lot / roll no. (scan or type)" value={lot} onChange={setLot} />
      {reasonCategory && (
        <fieldset>
          <legend className="mb-2 text-base font-semibold">Reason</legend>
          {reasons.data?.length === 0 ? (
            <Alert tone="warning">No reasons set up yet. A supervisor adds them on the desktop register page.</Alert>
          ) : (
            <div className="grid grid-cols-2 gap-2">
              {reasons.data?.map((r) => (
                <button key={r.id} type="button" onClick={() => setReason(r.id)} aria-pressed={reason === r.id} className={cn("min-h-14 rounded-xl border-2 p-2 text-base font-medium", reason === r.id ? "border-primary bg-primary-soft text-primary" : "border-line bg-surface")}>
                  {r.description}
                </button>
              ))}
            </div>
          )}
        </fieldset>
      )}
      {type === "SCRAP" && (
        <fieldset>
          <legend className="mb-2 text-base font-semibold">At which process? (optional)</legend>
          <div className="grid grid-cols-2 gap-2">
            {mrs.data.workOrder.processes.map((p) => (
              <button key={p.id} type="button" onClick={() => setStep(step === p.id ? "" : p.id)} aria-pressed={step === p.id} className={cn("min-h-14 rounded-xl border-2 p-2 text-base", step === p.id ? "border-primary bg-primary-soft text-primary" : "border-line bg-surface")}>
                {p.seq}. {p.name}
              </button>
            ))}
          </div>
          {device.data?.assignedMachine && <p className="mt-2 text-sm text-muted">Recorded on machine {device.data.assignedMachine.code} (this handheld's machine).</p>}
        </fieldset>
      )}
      <TextInput label="Remarks (optional)" value={remarks} onChange={setRemarks} />
      <TxError tx={tx} onRetry={submit} />
      <TxButton tx={tx} size="xl" variant="primary" className="w-full" disabled={!qty || (!!reasonCategory && !reason)} onClick={submit}>
        Save {MOVEMENT_LABEL[type].toLowerCase()}
      </TxButton>
    </div>
  );
}


