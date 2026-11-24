import { useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertOctagon, ArrowLeft, CheckCircle2, ClipboardList, LogOut, Pause, Play, Square, Wrench, XCircle } from "lucide-react";
import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { Navigate, Outlet, useNavigate, useParams } from "react-router";
import { checkoutLabel, CHECKOUT_TYPES, StatusBadge } from "@/components/status";
import { Button, Spinner } from "@/components/ui";
import { api, ApiError } from "@/lib/api";
import { newTxnId } from "@/lib/use-form-error";
import { cn, formatDateTime } from "@/lib/utils";
import { useAuth } from "@/stores/auth";
import { ArtworkThumb } from "@/modules/bom/artwork";
import type { MachineStatus, Quantities, WoView } from "@/modules/planning/api";
import { ModuleBand } from "./handheld-home";
import { ScanBox } from "./scan-box";

/**
 * Handheld app (/hh). Mobile-first, scanner-first. Same API and server rules
 * as the desktop; nothing is committed on the device: every action is a
 * server transaction with an idempotency key, retried with the same key after
 * a network failure.
 */

const DEVICE_KEY = "mes.deviceId";
function ensureDeviceId() {
  try {
    let id = localStorage.getItem(DEVICE_KEY);
    if (!id) {
      id = `hh-${newTxnId()}`;
      localStorage.setItem(DEVICE_KEY, id);
    }
    return id;
  } catch {
    return null;
  }
}

interface Blocker {
  code: string;
  message: string;
}
interface Dashboard {
  machine: { id: string; code: string; name: string; status: MachineStatus; statusChangedAt: string; isActive: boolean; category: { code: string; name: string } };
  blockers: Blocker[];
  current: {
    sessionId: string;
    sessionNo: string;
    operator: string | null;
    isMine: boolean;
    checkInAt: string;
    machineGood: string;
    machineReject: string;
    workOrder: { id: string; woNo: string; status: string; quantity: string; uom: string; pjo: WoView["pjo"] };
    process: { id: string; name: string; seq: number; routeLength: number; quantities: Quantities; allowSplit: boolean };
  } | null;
  today: { good: string; reject: string };
  pausedWork: { woProcessId: string; workOrderId: string; woNo: string; woStatus: string; process: string; good: string }[];
  openBreakdown: { id: string; breakdownNo: string; reason: string; status: string; reportedAt: string } | null;
}

const STATUS_BANNER: Record<MachineStatus, string> = {
  AVAILABLE: "bg-success text-on-primary",
  RUNNING: "bg-primary text-on-primary",
  IDLE: "bg-info text-on-primary",
  BREAKDOWN: "bg-danger text-on-primary",
  MAINTENANCE: "bg-warning text-on-primary",
  OFFLINE: "bg-muted text-on-primary",
};

// ---------------------------------------------------------------------------
// Shell, sign-in
// ---------------------------------------------------------------------------

export function HandheldShell() {
  const { session, loading, signOut } = useAuth();
  useEffect(() => {
    ensureDeviceId();
    document.title = "Label MES – Handheld";
  }, []);
  if (loading) return <Centered><Spinner className="size-8" /></Centered>;
  if (!session) return <HandheldLogin />;
  if (session.user.mustChangePassword) return <Navigate to="/account/password" replace />;
  if (!session.permissions.includes("shopfloor.handheld")) {
    return (
      <Centered>
        <XCircle className="size-12 text-danger" />
        <p className="text-lg font-semibold">This account can't use the handheld app.</p>
        <Button size="lg" onClick={() => void signOut()}>Sign out</Button>
      </Centered>
    );
  }
  return (
    <div className="mx-auto flex min-h-full max-w-xl flex-col bg-bg">
      <header className="sticky top-0 z-20 flex items-center gap-3 border-b border-line bg-nav px-4 py-3 text-on-primary">
        <a href="/hh?home=1" className="grid size-10 place-items-center rounded-lg bg-nav-active text-lg font-bold" aria-label="Modules">L</a>
        <div className="min-w-0 flex-1 leading-tight">
          <p className="truncate font-semibold">{session.user.fullName}</p>
          <p className="text-xs text-nav-text">{session.user.employeeNo ?? session.user.username}</p>
        </div>
        <button onClick={() => void signOut()} className="flex items-center gap-1 rounded-lg px-3 py-2 text-sm hover:bg-nav-hover" aria-label="Sign out">
          <LogOut className="size-5" /> Sign out
        </button>
      </header>
      <main className="flex-1 p-4">
        <Outlet />
      </main>
    </div>
  );
}

export const Centered = ({ children }: { children: ReactNode }) => <div className="flex min-h-full flex-col items-center justify-center gap-4 p-6 text-center">{children}</div>;

function HandheldLogin() {
  const { signIn } = useAuth();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await signIn(username.trim(), password);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Sign-in failed.");
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="mx-auto flex min-h-full max-w-md flex-col justify-center gap-6 p-6">
      <div className="flex items-center gap-3">
        <span className="grid size-12 place-items-center rounded-xl bg-primary text-xl font-bold text-on-primary">L</span>
        <div>
          <h1 className="text-xl font-semibold">Label MES Handheld</h1>
          <p className="text-sm text-muted">Machine work and material moves</p>
        </div>
      </div>
      <form onSubmit={submit} className="space-y-4">
        {error && <p role="alert" className="rounded-xl bg-danger-soft p-3 text-base text-danger">{error}</p>}
        <label className="block">
          <span className="mb-1 block text-base font-medium">Employee no. / username</span>
          <input value={username} onChange={(e) => setUsername(e.target.value)} autoFocus autoComplete="username" autoCapitalize="none" className="h-14 w-full rounded-xl border border-line bg-surface px-4 text-lg" placeholder="Scan badge or type" />
        </label>
        <label className="block">
          <span className="mb-1 block text-base font-medium">Password</span>
          <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" className="h-14 w-full rounded-xl border border-line bg-surface px-4 text-lg" />
        </label>
        <Button type="submit" variant="primary" size="xl" className="w-full" loading={busy}>
          Sign in
        </Button>
      </form>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Step 2 – identify the machine
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Machine dashboard (Steps 3–6)
// ---------------------------------------------------------------------------

type Panel = { kind: "output" } | { kind: "checkout" } | { kind: "breakdown" } | { kind: "result"; ok: boolean; title: string; lines: string[] } | null;

export function HandheldMachine() {
  const { machineId = "" } = useParams();
  const { can } = useAuth();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const dash = useQuery({ queryKey: ["hh", "dash", machineId], queryFn: () => api.get<Dashboard>(`/shopfloor/machines/${machineId}/dashboard`), refetchInterval: 15_000 });
  const [panel, setPanel] = useState<Panel>(null);
  const [scanError, setScanError] = useState<string | null>(null);
  const [listOpen, setListOpen] = useState(false);
  const refresh = () => qc.invalidateQueries({ queryKey: ["hh"] });

  if (dash.isPending) return <Centered><Spinner className="size-8" /></Centered>;
  if (dash.error) return <ErrorPanel message={(dash.error as Error).message} onRetry={() => void dash.refetch()} />;
  const d = dash.data;
  const m = d.machine;
  const cur = d.current;
  const canWork = cur ? cur.isMine || can("shopfloor.session.supervise") : false;

  if (panel?.kind === "result") {
    return <ResultPanel ok={panel.ok} title={panel.title} lines={panel.lines} onDone={() => (setPanel(null), void refresh())} />;
  }
  if (panel?.kind === "output" && cur) return <OutputForm session={cur} onCancel={() => setPanel(null)} onDone={(lines) => setPanel({ kind: "result", ok: true, title: "Output saved", lines })} />;
  if (panel?.kind === "checkout" && cur) return <CheckOutForm session={cur} onCancel={() => setPanel(null)} onDone={(title, lines) => setPanel({ kind: "result", ok: true, title, lines })} />;
  if (panel?.kind === "breakdown") return <BreakdownForm machine={m} session={cur} onCancel={() => setPanel(null)} onDone={(lines) => setPanel({ kind: "result", ok: true, title: "Breakdown reported", lines })} />;

  const scanWo = (code: string) => {
    setScanError(null);
    navigate(`/hh/m/${m.id}/wo/${encodeURIComponent(code.toUpperCase())}`);
  };

  return (
    <div className="space-y-4">
      <ModuleBand module="production" title={`Machine ${m.code}`} onBack={() => navigate("/hh/module/production")} />
      <div className={cn("rounded-2xl p-4", STATUS_BANNER[m.status])}>
        <div className="flex items-start justify-between gap-2">
          <div>
            <p className="text-2xl font-bold">{m.code}</p>
            <p className="text-sm opacity-90">
              {m.name} · {m.category.name}
            </p>
          </div>
          <span className="rounded-full bg-white/20 px-3 py-1 text-sm font-semibold uppercase">{m.status}</span>
        </div>
        <p className="mt-2 text-sm opacity-90">
          Today on this machine: {d.today.good} good · {d.today.reject} reject
        </p>
      </div>

      {d.openBreakdown && (
        <Alert tone="danger">
          {d.openBreakdown.breakdownNo}: {d.openBreakdown.reason.replace(/_/g, " ").toLowerCase()} – {d.openBreakdown.status === "UNDER_MAINTENANCE" ? "under maintenance" : "waiting for maintenance"}. No production until a supervisor releases the machine.
        </Alert>
      )}
      {!cur && d.blockers.filter((b) => b.code !== "MACHINE_BLOCKED").map((b) => <Alert key={b.code} tone="danger">{b.message}</Alert>)}

      {cur ? (
        <section className="space-y-3 rounded-2xl border border-line bg-surface p-4">
          <WoHeader pjo={cur.workOrder.pjo} woNo={cur.workOrder.woNo} process={`${cur.process.seq}/${cur.process.routeLength} ${cur.process.name}`} />
          <div className="grid grid-cols-2 gap-2">
            <Big label="This machine – good" value={cur.machineGood} unit={cur.workOrder.uom} strong />
            <Big label="This machine – reject" value={cur.machineReject} unit={cur.workOrder.uom} />
            <Big label="Process total good" value={cur.process.quantities.good} unit={`of ${cur.process.quantities.target}`} />
            <Big label="Outstanding" value={cur.process.quantities.outstanding} unit={cur.workOrder.uom} />
          </div>
          <Progress good={cur.process.quantities.good} target={cur.process.quantities.target} />
          <p className="text-sm text-muted">
            Started {formatDateTime(cur.checkInAt)} by {cur.operator} · {cur.sessionNo}
          </p>
          {canWork ? (
            <div className="grid gap-2">
              <Button size="xl" icon={<ClipboardList className="size-6" />} onClick={() => setPanel({ kind: "output" })}>
                Record output
              </Button>
              <Button size="xl" variant="primary" icon={<Square className="size-6" />} onClick={() => setPanel({ kind: "checkout" })}>
                CHECK OUT – END WORK
              </Button>
            </div>
          ) : (
            <Alert tone="info">This session belongs to {cur.operator}. Only they or a supervisor can record on it.</Alert>
          )}
        </section>
      ) : (
        m.status !== "BREAKDOWN" &&
        m.status !== "MAINTENANCE" &&
        m.status !== "OFFLINE" &&
        d.blockers.length === 0 && (
          <section className="space-y-3">
            <ScanBox label="Scan the Job Order barcode" placeholder="e.g. JO-2026-00001" onScan={scanWo} />
            {scanError && <Alert tone="danger">{scanError}</Alert>}
            <Button size="lg" className="w-full" onClick={() => setListOpen((o) => !o)}>
              {listOpen ? "Hide list" : "Choose from eligible Job Orders"}
            </Button>
            {listOpen && <EligibleList machineId={m.id} onPick={scanWo} />}
          </section>
        )
      )}

      {d.pausedWork.length > 0 && (
        <section className="space-y-2">
          <h3 className="text-base font-semibold">Paused work on this machine</h3>
          {d.pausedWork.map((p) => (
            <div key={p.woProcessId} className="flex items-center gap-3 rounded-xl border border-line bg-surface p-3">
              <div className="min-w-0 flex-1">
                <p className="font-semibold">{p.woNo}</p>
                <p className="text-sm text-muted">
                  {p.process} · {p.good} good so far {p.woStatus === "ON_HOLD" ? "· ON HOLD" : ""}
                </p>
              </div>
              {!cur && m.status !== "BREAKDOWN" && m.status !== "MAINTENANCE" && p.woStatus !== "ON_HOLD" && (
                <Button size="lg" variant="primary" icon={<Play className="size-5" />} onClick={() => scanWo(p.woNo)}>
                  Resume
                </Button>
              )}
              {(m.status === "BREAKDOWN" || m.status === "MAINTENANCE") && can("shopfloor.machine.change") && (
                <Button size="lg" onClick={() => navigate(`/hh/m/${m.id}/change/${p.woProcessId}?wo=${encodeURIComponent(p.woNo)}`)}>
                  Change machine
                </Button>
              )}
            </div>
          ))}
        </section>
      )}

      <div className="grid gap-2 pt-2">
        {can("shopfloor.breakdown.report") && m.status !== "BREAKDOWN" && (
          <Button size="xl" variant="danger" icon={<AlertOctagon className="size-6" />} onClick={() => setPanel({ kind: "breakdown" })}>
            Report breakdown
          </Button>
        )}
        <Button
          size="lg"
          icon={<ArrowLeft className="size-5" />}
          onClick={() => navigate("/hh?another=1")}
        >
          Use another machine
        </Button>
      </div>
    </div>
  );
}

function EligibleList({ machineId, onPick }: { machineId: string; onPick: (woNo: string) => void }) {
  const list = useQuery({
    queryKey: ["hh", "eligible", machineId],
    queryFn: () => api.get<{ id: string; woNo: string; priority: string; fatherCode: string; labelDescription: string; process: string; available: string; outstanding: string; uom: string }[]>(`/shopfloor/machines/${machineId}/eligible-work-orders`),
  });
  if (list.isPending) return <Spinner />;
  if (list.error) return <Alert tone="danger">{(list.error as Error).message}</Alert>;
  if (!list.data.length) return <Alert tone="info">No released Job Order can start on this machine now.</Alert>;
  return (
    <div className="space-y-2">
      {list.data.map((w) => (
        <button key={w.id} onClick={() => onPick(w.woNo)} className="block w-full rounded-xl border border-line bg-surface p-3 text-left active:bg-primary-soft">
          <div className="flex items-center justify-between gap-2">
            <span className="text-lg font-semibold">{w.woNo}</span>
            <StatusBadge kind="priority" value={w.priority} />
          </div>
          <p className="text-sm">
            {w.fatherCode} · {w.process}
          </p>
          <p className="truncate text-sm text-muted">{w.labelDescription}</p>
          <p className="text-sm">
            Available {w.available} {w.uom} · outstanding {w.outstanding}
          </p>
        </button>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Step 3 / 4 – Job Order preview and CHECK IN
// ---------------------------------------------------------------------------

export function HandheldWorkOrder() {
  const { machineId = "", woNo = "" } = useParams();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const scan = useQuery({
    queryKey: ["hh", "wo", woNo, machineId],
    queryFn: () => api.get<WoView & { eligibility: { canStart: boolean; woProcessId: string | null; process: string | null; blockers: Blocker[] } }>(`/shopfloor/work-orders/by-number/${encodeURIComponent(woNo)}?machineId=${machineId}`),
    retry: false,
  });
  const tx = useTransaction();
  const [result, setResult] = useState<{ title: string; lines: string[] } | null>(null);

  if (result) return <ResultPanel ok title={result.title} lines={result.lines} onDone={() => (void qc.invalidateQueries({ queryKey: ["hh"] }), navigate(`/hh/m/${machineId}`, { replace: true }))} />;
  if (scan.isPending) return <Centered><Spinner className="size-8" /></Centered>;
  if (scan.error) return <ErrorPanel message={(scan.error as Error).message} onRetry={() => navigate(`/hh/m/${machineId}`)} retryLabel="Back to machine" />;
  const wo = scan.data;
  const e = wo.eligibility;
  const step = wo.processes.find((p) => p.id === e.woProcessId) ?? wo.processes.find((p) => p.seq === wo.currentSeq) ?? null;

  const checkIn = () =>
    tx.run("/shopfloor/check-in", { machineId, workOrderId: wo.id }, (r: { sessionNo: string; process: string; available: string }) =>
      setResult({ title: "Production started", lines: [`${wo.woNo} – ${r.process}`, `Session ${r.sessionNo}`, `Available to produce: ${r.available} ${wo.uom}`] }),
    );

  return (
    <div className="space-y-4">
      <BackLink onClick={() => navigate(`/hh/m/${machineId}`)} />
      <section className="space-y-3 rounded-2xl border border-line bg-surface p-4">
        <WoHeader pjo={wo.pjo} woNo={wo.woNo} process={step ? `${step.seq}/${wo.processes.length} ${step.process.name}` : "—"} />
        <div className="flex flex-wrap gap-2">
          <StatusBadge kind="wo" value={wo.status} />
          {step && <StatusBadge kind="process" value={step.status} />}
        </div>
        {step && (
          <div className="grid grid-cols-2 gap-2">
            <Big label="Target" value={step.quantities.target} unit={wo.uom} />
            <Big label="Available now" value={step.quantities.available} unit={wo.uom} strong />
            <Big label="Good so far" value={step.quantities.good} unit={wo.uom} />
            <Big label="Outstanding" value={step.quantities.outstanding} unit={wo.uom} />
          </div>
        )}
        <ol className="space-y-1 text-sm">
          {wo.processes.map((p) => (
            <li key={p.id} className={cn("flex items-center justify-between rounded-lg px-2 py-1", p.id === step?.id && "bg-primary-soft")}>
              <span>
                {p.seq}. {p.process.name}
              </span>
              <StatusBadge kind="process" value={p.status} />
            </li>
          ))}
        </ol>
      </section>
      {e.canStart ? (
        <TxButton tx={tx} size="xl" variant="primary" className="w-full" icon={<Play className="size-6" />} onClick={checkIn}>
          CHECK IN – START WORK
        </TxButton>
      ) : (
        <div className="space-y-2">
          {e.blockers.map((b, i) => (
            <Alert key={i} tone="danger">
              {b.message}
            </Alert>
          ))}
        </div>
      )}
      <TxError tx={tx} onRetry={checkIn} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Step 5 – output, Step 6 – CHECK OUT, breakdown
// ---------------------------------------------------------------------------

type Session = NonNullable<Dashboard["current"]>;

function OutputForm({ session, onCancel, onDone }: { session: Session; onCancel: () => void; onDone: (lines: string[]) => void }) {
  const [good, setGood] = useState("");
  const [reject, setReject] = useState("");
  const [reason, setReason] = useState("");
  const tx = useTransaction();
  const save = () =>
    tx.run(`/shopfloor/sessions/${session.sessionId}/outputs`, { goodQty: good || 0, rejectQty: reject || 0, rejectReason: reason || null }, (r: { sessionGood: string; sessionReject: string }) =>
      onDone([`+${good || 0} good, +${reject || 0} reject`, `This session now: ${r.sessionGood} good / ${r.sessionReject} reject`]),
    );
  return (
    <FormScreen title="Record output" subtitle={`${session.workOrder.woNo} · ${session.process.name}`} onCancel={onCancel}>
      <QtyInput label="Good quantity (add)" value={good} onChange={setGood} unit={session.workOrder.uom} autoFocus />
      <QtyInput label="Reject quantity (add)" value={reject} onChange={setReject} unit={session.workOrder.uom} />
      {Number(reject) > 0 && <TextInput label="Reject reason" value={reason} onChange={setReason} />}
      <p className="text-sm text-muted">
        Session so far: {session.machineGood} good / {session.machineReject} reject. Can still add {session.process.quantities.available} {session.workOrder.uom}.
      </p>
      <TxButton tx={tx} size="xl" variant="primary" className="w-full" disabled={!Number(good) && !Number(reject)} onClick={save}>
        Save output
      </TxButton>
      <TxError tx={tx} onRetry={save} />
    </FormScreen>
  );
}

interface AltMachine {
  id: string;
  code: string;
  name: string;
  available: boolean;
  note: string | null;
}

function CheckOutForm({ session, onCancel, onDone }: { session: Session; onCancel: () => void; onDone: (title: string, lines: string[]) => void }) {
  const { can } = useAuth();
  const [type, setType] = useState<(typeof CHECKOUT_TYPES)[number]["value"] | null>(null);
  const [good, setGood] = useState(session.machineGood);
  const [reject, setReject] = useState(session.machineReject);
  const [remarks, setRemarks] = useState("");
  const [toMachineId, setTo] = useState("");
  const [changeReason, setChangeReason] = useState("");
  const [breakdownReason, setBreakdownReason] = useState("");
  const reasons = useReference();
  const alts = useQuery({
    queryKey: ["hh", "alts", session.process.id],
    queryFn: () => api.get<AltMachine[]>(`/shopfloor/work-order-processes/${session.process.id}/alternative-machines`),
    enabled: type === "MACHINE_CHANGE",
  });
  const tx = useTransaction();
  const types = CHECKOUT_TYPES.filter((t) => (t.value === "MACHINE_CHANGE" ? can("shopfloor.machine.change") : t.value === "MACHINE_BREAKDOWN" ? can("shopfloor.breakdown.report") : true));
  const target = Number(session.process.quantities.target);
  const processGoodAfter = Number(session.process.quantities.good) - Number(session.machineGood) + Number(good || 0);

  const submit = () =>
    tx.run(
      `/shopfloor/sessions/${session.sessionId}/check-out`,
      { type, totalGood: good || 0, totalReject: reject || 0, remarks: remarks || null, toMachineId: toMachineId || null, changeReason: changeReason || null, breakdownReason: breakdownReason || null },
      (r: { status: string; sessionGood: string; sessionReject: string; processGood: string; outstanding: string; breakdownNo: string | null; machineChange: { status: string } | null }) =>
        onDone("Production ended", [
          `${session.workOrder.woNo} – ${checkoutLabel(type)}`,
          `This session: ${r.sessionGood} good / ${r.sessionReject} reject`,
          `Process total: ${r.processGood} · outstanding ${r.outstanding}`,
          ...(r.breakdownNo ? [`Breakdown ${r.breakdownNo} recorded. Machine blocked until released.`] : []),
          ...(r.machineChange ? [r.machineChange.status === "APPROVED" ? "Machine change applied. Check In on the new machine." : "Machine change waiting for supervisor approval."] : []),
        ]),
    );

  return (
    <FormScreen title="Check Out – end work" subtitle={`${session.workOrder.woNo} · ${session.process.name}`} onCancel={onCancel}>
      <QtyInput label="Total good this session" value={good} onChange={setGood} unit={session.workOrder.uom} />
      <QtyInput label="Total reject this session" value={reject} onChange={setReject} unit={session.workOrder.uom} />
      <p className="text-sm text-muted">Already recorded: {session.machineGood} good / {session.machineReject} reject (totals can't be lower).</p>
      <fieldset className="space-y-2">
        <legend className="mb-1 text-base font-semibold">Check Out type</legend>
        {types.map((t) => (
          <button
            key={t.value}
            type="button"
            onClick={() => setType(t.value)}
            className={cn("block w-full rounded-xl border-2 p-3 text-left", type === t.value ? "border-primary bg-primary-soft" : "border-line bg-surface")}
            aria-pressed={type === t.value}
          >
            <span className="flex items-center gap-2 text-lg font-semibold">
              {t.value === "COMPLETED" ? <CheckCircle2 className="size-5 text-success" /> : t.value === "MACHINE_BREAKDOWN" ? <AlertOctagon className="size-5 text-danger" /> : t.value === "MACHINE_CHANGE" ? <Wrench className="size-5" /> : <Pause className="size-5" />}
              {t.label}
            </span>
            <span className="text-sm text-muted">{t.hint}</span>
          </button>
        ))}
      </fieldset>
      {type === "COMPLETED" && processGoodAfter < target && <Alert tone="warning">Process good output {processGoodAfter} is below the target {target}. Give a reason below.</Alert>}
      {type === "MACHINE_CHANGE" && (
        <div className="space-y-2">
          <p className="text-base font-semibold">Continue on</p>
          {alts.data?.map((m) => (
            <button key={m.id} type="button" disabled={!m.available} onClick={() => setTo(m.id)} className={cn("block w-full rounded-xl border-2 p-3 text-left disabled:opacity-50", toMachineId === m.id ? "border-primary bg-primary-soft" : "border-line bg-surface")}>
              <span className="text-lg font-semibold">{m.code}</span> <span className="text-muted">{m.name}</span>
              {m.note && <span className="block text-sm text-muted">{m.note}</span>}
            </button>
          ))}
          {alts.data?.length === 0 && <Alert tone="warning">No other machine can do this process.</Alert>}
          <TextInput label="Reason for machine change" value={changeReason} onChange={setChangeReason} />
        </div>
      )}
      {type === "MACHINE_BREAKDOWN" && <ReasonTiles reasons={reasons} value={breakdownReason} onChange={setBreakdownReason} />}
      <TextInput label={type === "COMPLETED" && processGoodAfter < target ? "Reason (required)" : "Remarks"} value={remarks} onChange={setRemarks} />
      <TxButton tx={tx} size="xl" variant="primary" className="w-full" disabled={!type} onClick={submit}>
        Confirm Check Out
      </TxButton>
      <TxError tx={tx} onRetry={submit} />
    </FormScreen>
  );
}

function BreakdownForm({ machine, session, onCancel, onDone }: { machine: Dashboard["machine"]; session: Session | null; onCancel: () => void; onDone: (lines: string[]) => void }) {
  const reasons = useReference();
  const [reason, setReason] = useState("");
  const [remarks, setRemarks] = useState("");
  const [good, setGood] = useState(session?.machineGood ?? "");
  const [reject, setReject] = useState(session?.machineReject ?? "");
  const tx = useTransaction();
  const submit = () =>
    tx.run(`/shopfloor/machines/${machine.id}/breakdowns`, { reason, remarks: remarks || null, ...(session ? { totalGood: good || 0, totalReject: reject || 0 } : {}) }, (r: { breakdownNo: string; sessionNo: string | null; outstanding: string | null }) =>
      onDone([`${r.breakdownNo} on ${machine.code}`, ...(r.sessionNo ? [`Session ${r.sessionNo} ended with your latest output. Outstanding ${r.outstanding}.`] : []), "The machine is blocked until maintenance releases it."]),
    );
  return (
    <FormScreen title={`Report breakdown – ${machine.code}`} subtitle={session ? `${session.workOrder.woNo} · ${session.process.name} will be stopped` : "No running session"} onCancel={onCancel}>
      {session && (
        <>
          <QtyInput label="Latest total good this session" value={good} onChange={setGood} unit={session.workOrder.uom} />
          <QtyInput label="Latest total reject this session" value={reject} onChange={setReject} unit={session.workOrder.uom} />
        </>
      )}
      <ReasonTiles reasons={reasons} value={reason} onChange={setReason} />
      <TextInput label="What happened" value={remarks} onChange={setRemarks} />
      <Alert tone="warning">Stop the machine and follow the factory's safety procedure. This report records the breakdown; it doesn't replace physical safety steps.</Alert>
      <TxButton tx={tx} size="xl" variant="danger" className="w-full" disabled={!reason} onClick={submit}>
        Report breakdown
      </TxButton>
      <TxError tx={tx} onRetry={submit} />
    </FormScreen>
  );
}

/** Change Machine for paused work on a broken-down machine. */
export function HandheldChangeMachine() {
  const { machineId = "", woProcessId = "" } = useParams();
  const navigate = useNavigate();
  const { can } = useAuth();
  const woNo = new URLSearchParams(window.location.search).get("wo") ?? "";
  const alts = useQuery({ queryKey: ["hh", "alts", woProcessId], queryFn: () => api.get<AltMachine[]>(`/shopfloor/work-order-processes/${woProcessId}/alternative-machines`) });
  const [to, setTo] = useState("");
  const [reason, setReason] = useState("");
  const tx = useTransaction();
  const [done, setDone] = useState<string | null>(null);
  const submit = () => tx.run("/shopfloor/machine-changes", { woProcessId, toMachineId: to, reason }, (r: { status: string }) => setDone(r.status));
  if (done) {
    return (
      <ResultPanel
        ok
        title={done === "APPROVED" ? "Machine changed" : "Change requested"}
        lines={[woNo, done === "APPROVED" ? "Go to the new machine, scan it and the Job Order, then Check In." : "A supervisor must approve the change before work can start on the new machine."]}
        onDone={() => navigate(`/hh/m/${machineId}`, { replace: true })}
      />
    );
  }
  return (
    <FormScreen title={`Change machine – ${woNo}`} subtitle={can("shopfloor.machine.change.approve") ? "Applies immediately" : "Needs supervisor approval"} onCancel={() => navigate(`/hh/m/${machineId}`)}>
      {alts.data?.map((m) => (
        <button key={m.id} type="button" disabled={!m.available} onClick={() => setTo(m.id)} className={cn("block w-full rounded-xl border-2 p-3 text-left disabled:opacity-50", to === m.id ? "border-primary bg-primary-soft" : "border-line bg-surface")}>
          <span className="text-lg font-semibold">{m.code}</span> <span className="text-muted">{m.name}</span>
          {m.note && <span className="block text-sm text-muted">{m.note}</span>}
        </button>
      ))}
      {alts.data?.length === 0 && <Alert tone="warning">No other machine can do this process.</Alert>}
      <TextInput label="Reason" value={reason} onChange={setReason} />
      <TxButton tx={tx} size="xl" variant="primary" className="w-full" disabled={!to || !reason.trim()} onClick={submit}>
        {can("shopfloor.machine.change.approve") ? "Change machine" : "Request change"}
      </TxButton>
      <TxError tx={tx} onRetry={submit} />
    </FormScreen>
  );
}

// ---------------------------------------------------------------------------
// Transactions with idempotency + retry
// ---------------------------------------------------------------------------

export interface Tx {
  busy: boolean;
  error: ApiError | null;
  /** Keeps the same transaction id until the server confirms, so a retry never doubles. */
  run: <R>(path: string, body: Record<string, unknown>, onOk: (r: R) => void) => Promise<void>;
}

export function useTransaction(): Tx {
  const [txnId, setTxnId] = useState(newTxnId);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const run: Tx["run"] = async (path, body, onOk) => {
    setBusy(true);
    setError(null);
    try {
      const r = await api.post<Parameters<typeof onOk>[0]>(path, { ...body, clientTxnId: txnId });
      setTxnId(newTxnId());
      onOk(r);
    } catch (e) {
      const err = e instanceof ApiError ? e : new ApiError(0, "UNKNOWN", "Something went wrong.");
      // A refused request (4xx) was not applied: new id for the next attempt.
      if (err.status !== 0 && err.status < 500) setTxnId(newTxnId());
      setError(err);
    } finally {
      setBusy(false);
    }
  };
  return { busy, error, run };
}

export function TxButton({ tx, children, ...rest }: { tx: Tx } & React.ComponentProps<typeof Button>) {
  return (
    <Button {...rest} loading={tx.busy}>
      {children}
    </Button>
  );
}

export function TxError({ tx, onRetry }: { tx: Tx; onRetry: () => void }) {
  if (!tx.error) return null;
  const network = tx.error.status === 0 || tx.error.status >= 500;
  return (
    <div role="alert" className="space-y-2 rounded-xl border-2 border-danger bg-danger-soft p-3 text-base text-danger">
      <p className="font-semibold">{network ? "Not saved – no connection to the server." : "Not saved."}</p>
      <p>{tx.error.message}</p>
      {tx.error.issues.map((i) => (
        <p key={i.path}>• {i.message}</p>
      ))}
      {network && (
        <Button size="lg" variant="danger" className="w-full" loading={tx.busy} onClick={onRetry}>
          Retry (safe – it won't be saved twice)
        </Button>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Small UI pieces
// ---------------------------------------------------------------------------

function useReference() {
  const ref = useQuery({ queryKey: ["hh", "reference"], queryFn: () => api.get<{ breakdownReasons: { code: string; label: string }[] }>("/shopfloor/reference"), staleTime: Infinity });
  return ref.data?.breakdownReasons ?? [];
}

function ReasonTiles({ reasons, value, onChange }: { reasons: { code: string; label: string }[]; value: string; onChange: (v: string) => void }) {
  return (
    <fieldset>
      <legend className="mb-2 text-base font-semibold">Breakdown reason</legend>
      <div className="grid grid-cols-2 gap-2">
        {reasons.map((r) => (
          <button key={r.code} type="button" onClick={() => onChange(r.code)} aria-pressed={value === r.code} className={cn("min-h-14 rounded-xl border-2 p-2 text-base font-medium", value === r.code ? "border-danger bg-danger-soft text-danger" : "border-line bg-surface")}>
            {r.label}
          </button>
        ))}
      </div>
    </fieldset>
  );
}

function WoHeader({ pjo, woNo, process }: { pjo: WoView["pjo"]; woNo: string; process: string }) {
  return (
    <div className="flex gap-3">
      <ArtworkThumb file={pjo.artworkFile} className="size-20" />
      <div className="min-w-0">
        <p className="text-2xl font-bold">{woNo}</p>
        <p className="text-base font-medium">{process}</p>
        <p className="text-sm text-muted">
          {pjo.pjoNo} · {pjo.fatherCode} · Art Rev {String(pjo.artworkRevision).padStart(2, "0")}
        </p>
        <p className="line-clamp-2 text-sm">{pjo.labelDescription}</p>
      </div>
    </div>
  );
}

const Big = ({ label, value, unit, strong }: { label: string; value: string; unit?: string; strong?: boolean }) => (
  <div className={cn("rounded-xl px-3 py-2", strong ? "bg-primary-soft" : "bg-surface-2")}>
    <p className="text-xs text-muted uppercase">{label}</p>
    <p className="text-2xl font-bold tabular-nums">
      {value} <span className="text-sm font-normal text-muted">{unit}</span>
    </p>
  </div>
);

function Progress({ good, target }: { good: string; target: string }) {
  const pct = Number(target) ? Math.min(100, Math.round((Number(good) / Number(target)) * 100)) : 0;
  return (
    <div>
      <div className="h-3 overflow-hidden rounded-full bg-neutral-soft" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100} aria-label="Process progress">
        <div className="h-full bg-primary" style={{ width: `${pct}%` }} />
      </div>
      <p className="mt-1 text-right text-sm text-muted">{pct}% of target</p>
    </div>
  );
}

export function QtyInput({ label, value, onChange, unit, autoFocus }: { label: string; value: string; onChange: (v: string) => void; unit: string; autoFocus?: boolean }) {
  return (
    <label className="block">
      <span className="mb-1 block text-base font-medium">{label}</span>
      <div className="flex items-center gap-2">
        <input
          value={value}
          onChange={(e) => onChange(e.target.value.replace(/[^\d.]/g, ""))}
          inputMode="decimal"
          autoFocus={autoFocus}
          className="h-14 min-w-0 flex-1 rounded-xl border border-line bg-surface px-4 text-2xl font-semibold tabular-nums focus:border-focus focus:ring-2 focus:ring-focus/30 focus:outline-none"
        />
        <span className="w-14 text-base text-muted">{unit}</span>
      </div>
    </label>
  );
}

export function TextInput({ label, value, onChange }: { label: string; value: string; onChange: (v: string) => void }) {
  return (
    <label className="block">
      <span className="mb-1 block text-base font-medium">{label}</span>
      <input value={value} onChange={(e) => onChange(e.target.value)} maxLength={500} className="h-14 w-full rounded-xl border border-line bg-surface px-4 text-lg focus:border-focus focus:ring-2 focus:ring-focus/30 focus:outline-none" />
    </label>
  );
}

export function FormScreen({ title, subtitle, onCancel, children }: { title: string; subtitle?: string; onCancel: () => void; children: ReactNode }) {
  return (
    <div className="space-y-4">
      <BackLink onClick={onCancel} label="Cancel" />
      <div>
        <h2 className="text-xl font-semibold">{title}</h2>
        {subtitle && <p className="text-base text-muted">{subtitle}</p>}
      </div>
      {children}
    </div>
  );
}

export const BackLink = ({ onClick, label = "Back" }: { onClick: () => void; label?: string }) => (
  <button onClick={onClick} className="flex items-center gap-1 py-1 text-base font-medium text-primary">
    <ArrowLeft className="size-5" /> {label}
  </button>
);

export function Alert({ tone, children }: { tone: "danger" | "warning" | "info"; children: ReactNode }) {
  const cls = { danger: "border-danger/50 bg-danger-soft text-danger", warning: "border-warning/50 bg-warning-soft text-warning", info: "border-info/50 bg-info-soft text-info" }[tone];
  return (
    <div role={tone === "danger" ? "alert" : "status"} className={cn("rounded-xl border-2 p-3 text-base", cls)}>
      {children}
    </div>
  );
}

export function ResultPanel({ ok, title, lines, onDone }: { ok: boolean; title: string; lines: string[]; onDone: () => void }) {
  return (
    <div className={cn("flex flex-col items-center gap-4 rounded-2xl p-6 text-center", ok ? "bg-success-soft" : "bg-danger-soft")} role="status">
      {ok ? <CheckCircle2 className="size-16 text-success" /> : <XCircle className="size-16 text-danger" />}
      <p className="text-2xl font-bold">{title}</p>
      <div className="space-y-1 text-lg">
        {lines.map((l, i) => (
          <p key={i}>{l}</p>
        ))}
      </div>
      <Button size="xl" variant="primary" className="w-full" onClick={onDone} autoFocus>
        OK
      </Button>
    </div>
  );
}

export function ErrorPanel({ message, onRetry, retryLabel = "Try again" }: { message: string; onRetry: () => void; retryLabel?: string }) {
  return (
    <div className="space-y-4 rounded-2xl bg-danger-soft p-6 text-center">
      <XCircle className="mx-auto size-14 text-danger" />
      <p className="text-lg">{message}</p>
      <Button size="xl" className="w-full" onClick={onRetry}>
        {retryLabel}
      </Button>
    </div>
  );
}
