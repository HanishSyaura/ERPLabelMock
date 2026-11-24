import { Check, X } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

export interface JourneyStep<T extends string = string> {
  id: T;
  label: string;
  hint?: string;
  /** done = completed, error = needs attention, skipped = not applicable. */
  state?: "todo" | "done" | "error" | "skipped";
}

/**
 * Form journey: the whole flow from start to end as numbered steps, the
 * current one highlighted. Steps can be clicked when `onSelect` is given and
 * the step isn't `locked`.
 */
export function Journey<T extends string>({ steps, current, onSelect, locked }: { steps: JourneyStep<T>[]; current: T; onSelect?: (id: T) => void; locked?: (id: T) => boolean }) {
  const idx = steps.findIndex((s) => s.id === current);
  return (
    <nav aria-label="Form journey" className="relative overflow-x-auto pb-1">
      <ol className="flex min-w-max items-start">
        {steps.map((s, i) => {
          const on = s.id === current;
          const done = s.state === "done" || (s.state !== "error" && s.state !== "skipped" && i < idx);
          const error = s.state === "error";
          const skipped = s.state === "skipped";
          const clickable = !!onSelect && !(locked?.(s.id) ?? false);
          return (
            <li key={s.id} className="flex items-start">
              <button
                type="button"
                disabled={!clickable}
                onClick={() => onSelect?.(s.id)}
                aria-current={on ? "step" : undefined}
                className={cn("flex w-28 flex-col items-center gap-1.5 text-center sm:w-32", clickable ? "cursor-pointer" : "cursor-default")}
              >
                <span
                  className={cn(
                    "grid size-9 place-items-center rounded-full border-2 text-sm font-bold transition",
                    on && !error && "border-primary bg-primary text-white shadow",
                    !on && done && "border-success bg-success text-white",
                    error && "border-danger bg-danger text-white",
                    !on && !done && !error && (skipped ? "border-dashed border-line text-muted" : "border-line bg-surface text-muted"),
                  )}
                >
                  {error ? <X className="size-4" strokeWidth={3} /> : done && !on ? <Check className="size-4" strokeWidth={3} /> : i + 1}
                </span>
                <span className={cn("text-xs leading-tight font-semibold", on ? "text-text" : "text-muted")}>{s.label}</span>
                {s.hint && <span className="hidden text-[11px] leading-tight text-muted sm:block">{s.hint}</span>}
              </button>
              {i < steps.length - 1 && <span className={cn("mt-[18px] h-0.5 w-6 shrink-0 sm:w-10", i < idx ? "bg-success" : "bg-line")} aria-hidden />}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}

/** "What happens next" after a flow: the following steps on the floor, each with a link. */
export function NextJourney({ title = "What happens next", items }: { title?: string; items: { label: string; detail: string; action?: ReactNode }[] }) {
  return (
    <div className="rounded-lg border border-line p-4">
      <p className="mb-3 text-sm font-semibold">{title}</p>
      <ol className="space-y-3">
        {items.map((it, i) => (
          <li key={it.label} className="flex gap-3">
            <span className="grid size-7 shrink-0 place-items-center rounded-full bg-primary-soft text-xs font-bold text-primary">{i + 1}</span>
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium">{it.label}</p>
              <p className="text-xs text-muted">{it.detail}</p>
            </div>
            {it.action}
          </li>
        ))}
      </ol>
    </div>
  );
}
