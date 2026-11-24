import { CheckCircle2, AlertTriangle, X } from "lucide-react";
import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { ApiError } from "@/lib/api";
import { cn } from "@/lib/utils";

type Tone = "success" | "error";
interface Toast {
  id: number;
  tone: Tone;
  message: string;
}

const ToastContext = createContext<{ success: (m: string) => void; error: (e: unknown) => void } | null>(null);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  // Toasts live in a manual popover so they sit in the top layer, above any
  // open native <dialog>. Re-showing it moves it to the top of that layer.
  const layer = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = layer.current;
    if (!el || typeof el.showPopover !== "function") return;
    try {
      if (el.matches(":popover-open")) el.hidePopover();
      if (toasts.length) el.showPopover();
    } catch {
      /* popover unsupported: falls back to normal stacking */
    }
  }, [toasts]);
  const push = useCallback((tone: Tone, message: string) => {
    const id = Date.now() + Math.random();
    setToasts((t) => [...t.slice(-3), { id, tone, message }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), tone === "error" ? 8000 : 4000);
  }, []);
  const value = {
    success: (m: string) => push("success", m),
    error: (e: unknown) => push("error", e instanceof ApiError || e instanceof Error ? e.message : String(e)),
  };
  return (
    <ToastContext.Provider value={value}>
      {children}
      <div
        ref={layer}
        popover="manual"
        className="pointer-events-none fixed inset-x-0 top-auto bottom-4 m-0 flex w-full max-w-none flex-col items-center gap-2 overflow-visible border-0 bg-transparent px-4 sm:items-end"
        aria-live="polite"
      >
        {toasts.map((t) => (
          <div
            key={t.id}
            role={t.tone === "error" ? "alert" : "status"}
            className={cn(
              "pointer-events-auto flex w-full max-w-sm items-start gap-3 rounded-lg border bg-surface p-3 text-sm shadow-lg",
              t.tone === "success" ? "border-success/40" : "border-danger/40",
            )}
          >
            {t.tone === "success" ? <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-success" /> : <AlertTriangle className="mt-0.5 size-4 shrink-0 text-danger" />}
            <p className="min-w-0 flex-1">{t.message}</p>
            <button className="text-muted hover:text-text" onClick={() => setToasts((x) => x.filter((y) => y.id !== t.id))} aria-label="Dismiss">
              <X className="size-4" />
            </button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast() {
  const v = useContext(ToastContext);
  if (!v) throw new Error("useToast outside ToastProvider");
  return v;
}
