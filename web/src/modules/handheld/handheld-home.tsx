import { useQuery } from "@tanstack/react-query";
import { ArrowLeft, ChevronRight, ClipboardCheck, Factory, Monitor, PackageOpen, ScanLine, type LucideIcon } from "lucide-react";
import { useState, type ReactNode } from "react";
import { Navigate, useNavigate, useParams, useSearchParams } from "react-router";
import { Spinner } from "@/components/ui";
import { api, ApiError } from "@/lib/api";
import { cn } from "@/lib/utils";
import { useAuth } from "@/stores/auth";
import { MOVEMENT_PATH, MOVEMENT_PERMISSION } from "@/modules/planning/ops-api";
import { Alert, Centered, ErrorPanel } from "./handheld-app";
import { MATERIAL_TASKS } from "./handheld-material";
import { ScanBox } from "./scan-box";

/**
 * Handheld home for the production floor: modules first, functions inside.
 * Each module has its own colour so operators always know where they are:
 *   Production (blue)  – machine work: go to my machine / scan a machine
 *   Material (amber)   – issue, additional issue, return, reject, scrap
 *   Quality (green)    – receive a lot (IQC), OQC lots to inspect
 */
interface DeviceInfo {
  id: string;
  name: string | null;
  assignedMachine: { id: string; code: string; name: string } | null;
}
type ModuleId = "production" | "material" | "quality";
interface Fn {
  key: string;
  label: string;
  hint: string;
  icon: LucideIcon;
  to?: string;
}
const TONE: Record<ModuleId, { band: string; soft: string; icon: string; ring: string }> = {
  production: { band: "bg-primary text-white", soft: "bg-primary-soft", icon: "text-primary", ring: "border-primary" },
  material: { band: "bg-warning text-white", soft: "bg-warning-soft", icon: "text-warning", ring: "border-warning" },
  quality: { band: "bg-success text-white", soft: "bg-success-soft", icon: "text-success", ring: "border-success" },
};

function useModules() {
  const { can } = useAuth();
  const material: Fn[] = MATERIAL_TASKS.filter((t) => can(MOVEMENT_PERMISSION[t.type])).map((t) => ({ key: t.type, label: t.label, hint: t.hint, icon: t.icon, to: `/hh/material/${MOVEMENT_PATH[t.type]}` }));
  const quality: Fn[] = [
    ...(can("qc.iqc.inspect") ? [{ key: "iqc", label: "Receive a lot (IQC)", hint: "Check in a delivered lot, inspect it, release it", icon: ClipboardCheck, to: "/hh/qc/iqc" }] : []),
    ...(can("qc.oqc.inspect") || can("qc.oqc.disposition") ? [{ key: "oqc", label: "OQC – finished labels", hint: "Offer a Job Order, inspect waiting lots, decide", icon: Monitor, to: "/hh/qc/oqc" }] : []),
  ];
  const production = can("shopfloor.output.record");
  return [
    { id: "production" as const, label: "Production", hint: "Machine work: Check In, output, Check Out, breakdown", icon: Factory, count: production ? 2 : 0 },
    { id: "material" as const, label: "Material", hint: "Store moves against the MRS", icon: PackageOpen, count: material.length, fns: material },
    { id: "quality" as const, label: "Quality", hint: "IQC receiving and OQC", icon: ClipboardCheck, count: quality.length, fns: quality },
  ].filter((m) => m.count > 0);
}

export function HandheldHome() {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const device = useQuery({ queryKey: ["hh", "device"], queryFn: () => api.get<DeviceInfo>("/shopfloor/device") });
  const modules = useModules();
  if (device.isPending) return <Centered><Spinner className="size-8" /></Centered>;
  if (device.error) return <ErrorPanel message={(device.error as Error).message} onRetry={() => void device.refetch()} />;
  const pinned = device.data.assignedMachine;
  // A handheld pinned to a machine and used only for production goes straight to it.
  if (pinned && params.get("another") !== "1" && modules.length === 1 && modules[0]!.id === "production") return <Navigate to={`/hh/m/${pinned.id}`} replace />;
  if (modules.length === 1 && params.get("home") !== "1") return <Navigate to={`/hh/module/${modules[0]!.id}`} replace />;
  return (
    <div className="space-y-4">
      <h1 className="text-xl font-bold">Choose a module</h1>
      {!modules.length && <Alert tone="info">This account has no handheld tasks yet. Ask a supervisor to check its role.</Alert>}
      <div className="grid gap-3">
        {modules.map((m) => {
          const t = TONE[m.id];
          return (
            <button
              key={m.id}
              onClick={() => navigate(`/hh/module/${m.id}`)}
              className={cn("flex items-center gap-4 rounded-2xl border-2 bg-surface p-4 text-left shadow-sm transition active:scale-[0.99]", t.ring)}
            >
              <span className={cn("grid size-16 shrink-0 place-items-center rounded-xl", t.band)}>
                <m.icon className="size-9" strokeWidth={2} />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block text-xl font-bold">{m.label}</span>
                <span className="block text-sm text-muted">{m.hint}</span>
                <span className={cn("mt-1 inline-block rounded-full px-2 py-0.5 text-xs font-semibold", t.soft, t.icon)}>
                  {m.id === "production" ? (pinned ? `Machine ${pinned.code}` : "Scan a machine") : `${m.count} function${m.count === 1 ? "" : "s"}`}
                </span>
              </span>
              <ChevronRight className="size-7 text-muted" />
            </button>
          );
        })}
      </div>
      {device.data.name && <p className="text-xs text-muted">Device: {device.data.name}</p>}
    </div>
  );
}

/** Module band: colour, icon, name, and the way back to the modules. */
export function ModuleBand({ module, title, onBack }: { module: ModuleId; title?: string; onBack: () => void }) {
  const t = TONE[module];
  const label = module === "production" ? "Production" : module === "material" ? "Material" : "Quality";
  const Icon = module === "production" ? Factory : module === "material" ? PackageOpen : ClipboardCheck;
  return (
    <div className={cn("-mx-4 -mt-4 mb-4 flex items-center gap-3 px-4 py-3", t.band)}>
      <button onClick={onBack} className="grid size-11 place-items-center rounded-lg bg-white/15 active:bg-white/25" aria-label="Back to modules">
        <ArrowLeft className="size-6" />
      </button>
      <Icon className="size-7" />
      <div className="min-w-0 leading-tight">
        <p className="text-lg font-bold">{label}</p>
        {title && <p className="truncate text-sm opacity-90">{title}</p>}
      </div>
    </div>
  );
}

function FnRow({ fn, module }: { fn: Fn; module: ModuleId }) {
  const navigate = useNavigate();
  const t = TONE[module];
  return (
    <button onClick={() => fn.to && navigate(fn.to)} className="flex min-h-20 w-full items-center gap-4 rounded-xl border-2 border-line bg-surface p-3 text-left transition active:scale-[0.99] active:bg-surface-2">
      <span className={cn("grid size-12 shrink-0 place-items-center rounded-lg", t.soft)}>
        <fn.icon className={cn("size-7", t.icon)} />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-lg font-semibold">{fn.label}</span>
        <span className="block text-sm text-muted">{fn.hint}</span>
      </span>
      <ChevronRight className="size-6 text-muted" />
    </button>
  );
}

export function HandheldModule() {
  const { moduleId = "" } = useParams();
  const navigate = useNavigate();
  const modules = useModules();
  const m = modules.find((x) => x.id === moduleId);
  const back = () => navigate("/hh?home=1");
  if (!m) return <Navigate to="/hh?home=1" replace />;
  return (
    <div>
      <ModuleBand module={m.id} title={m.hint} onBack={back} />
      {m.id === "production" ? (
        <ProductionModule />
      ) : (
        <div className="space-y-2.5">
          {m.fns!.map((fn) => (
            <FnRow key={fn.key} fn={fn} module={m.id} />
          ))}
        </div>
      )}
    </div>
  );
}

function ProductionModule() {
  const navigate = useNavigate();
  const device = useQuery({ queryKey: ["hh", "device"], queryFn: () => api.get<DeviceInfo>("/shopfloor/device") });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const scan = async (code: string) => {
    setBusy(true);
    setError(null);
    try {
      const machine = await api.get<{ id: string }>(`/shopfloor/machines/by-code/${encodeURIComponent(code)}`);
      navigate(`/hh/m/${machine.id}`);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Scan failed.");
    } finally {
      setBusy(false);
    }
  };
  const pinned = device.data?.assignedMachine;
  return (
    <div className="space-y-4">
      {pinned && (
        <Section title="My machine">
          <button onClick={() => navigate(`/hh/m/${pinned.id}`)} className="flex min-h-20 w-full items-center gap-4 rounded-xl border-2 border-primary bg-primary-soft p-3 text-left active:scale-[0.99]">
            <span className="grid size-12 place-items-center rounded-lg bg-primary text-white">
              <Factory className="size-7" />
            </span>
            <span className="min-w-0 flex-1">
              <span className="block text-xl font-bold">{pinned.code}</span>
              <span className="block text-sm text-muted">{pinned.name} · this handheld's machine</span>
            </span>
            <ChevronRight className="size-6 text-muted" />
          </button>
        </Section>
      )}
      <Section title={pinned ? "Another machine" : "Scan the machine"}>
        <div className="rounded-xl border-2 border-line bg-surface p-3">
          <p className="mb-2 flex items-center gap-2 text-sm text-muted">
            <ScanLine className="size-5 text-primary" /> Scan the barcode on the machine (or type its code).
          </p>
          <ScanBox label="Machine barcode" placeholder="e.g. FX-01" onScan={(c) => void scan(c)} busy={busy} autoFocus={!pinned} />
        </div>
        {error && <Alert tone="danger">{error}</Alert>}
      </Section>
      <p className="text-sm text-muted">On the machine: Check In a Job Order, record output, Check Out, report a breakdown or change machine.</p>
    </div>
  );
}

const Section = ({ title, children }: { title: string; children: ReactNode }) => (
  <section className="space-y-2">
    <h2 className="text-sm font-semibold tracking-wide text-muted uppercase">{title}</h2>
    {children}
  </section>
);
