import { Check } from "lucide-react";
import { useRef, type KeyboardEvent } from "react";
import { cn } from "@/lib/utils";
import { WindingIcon } from "./winding-icon";

export { WindingIcon };

const GROUPS = [
  { title: "Wound out", hint: "Labels on the outside of the roll", positions: [1, 2, 3, 4] },
  { title: "Wound in", hint: "Labels on the inside of the roll (facing the core)", positions: [5, 6, 7, 8] },
];

const INFO: Record<number, { short: string; lead: string }> = {
  1: { short: "Top first", lead: "the top of the label comes off the roll first" },
  2: { short: "Bottom first", lead: "the bottom of the label comes off the roll first" },
  3: { short: "Right first", lead: "the right side of the label comes off the roll first" },
  4: { short: "Left first", lead: "the left side of the label comes off the roll first" },
  5: { short: "Top first", lead: "the top of the label comes off the roll first" },
  6: { short: "Bottom first", lead: "the bottom of the label comes off the roll first" },
  7: { short: "Right first", lead: "the right side of the label comes off the roll first" },
  8: { short: "Left first", lead: "the left side of the label comes off the roll first" },
};
const describe = (n: number) => `Position ${n} – ${n <= 4 ? "wound out" : "wound in"}, ${INFO[n]!.short.toLowerCase()}`;

/**
 * Printing direction (winding position 1–8) as a picture chart, like the TBS
 * Master Card: large tiles, a preview of the chosen position with what it
 * means, and arrow-key navigation (← → move, Home / End jump).
 */
export function WindingPicker({ value, onChange, disabled, error }: { value: string; onChange: (v: string) => void; disabled?: boolean; error?: string }) {
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const current = Number(value) || 0;

  const move = (e: KeyboardEvent, n: number) => {
    const next = e.key === "ArrowRight" || e.key === "ArrowDown" ? (n % 8) + 1 : e.key === "ArrowLeft" || e.key === "ArrowUp" ? ((n + 6) % 8) + 1 : e.key === "Home" ? 1 : e.key === "End" ? 8 : 0;
    if (!next) return;
    e.preventDefault();
    onChange(String(next));
    refs.current[next - 1]?.focus();
  };

  return (
    <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_17rem]">
      <div role="radiogroup" aria-label="Printing direction (winding position)" className="space-y-3">
        {GROUPS.map((g) => (
          <div key={g.title} className="rounded-lg border border-line p-3">
            <p className="mb-2 flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5">
              <span className="text-sm font-semibold">{g.title}</span>
              <span className="text-xs text-muted">{g.hint}</span>
            </p>
            <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-4">
              {g.positions.map((n) => {
                const on = current === n;
                return (
                  <button
                    key={n}
                    ref={(el) => {
                      refs.current[n - 1] = el;
                    }}
                    type="button"
                    role="radio"
                    aria-checked={on}
                    aria-label={describe(n)}
                    tabIndex={on || (!current && n === 1) ? 0 : -1}
                    disabled={disabled}
                    onClick={() => onChange(on ? "" : String(n))}
                    onKeyDown={(e) => move(e, n)}
                    className={cn(
                      "group relative flex flex-col items-center rounded-lg border-2 bg-white p-2 text-slate-900 transition focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary disabled:cursor-not-allowed",
                      on ? "border-primary shadow-md" : "border-line hover:border-primary/50 hover:shadow-sm",
                      disabled && !on && "opacity-60",
                    )}
                  >
                    {on && (
                      <span className="absolute top-1.5 right-1.5 grid size-6 place-items-center rounded-full bg-primary text-white shadow">
                        <Check className="size-4" strokeWidth={3} />
                      </span>
                    )}
                    <WindingIcon position={n} className="h-36 w-auto transition-transform group-hover:scale-[1.04] sm:h-40" />
                    <span className="mt-1 flex items-center gap-1.5">
                      <span className={cn("grid size-7 place-items-center rounded-full text-sm font-bold", on ? "bg-primary text-white" : "bg-slate-100 text-slate-900")}>{n}</span>
                      <span className="text-xs font-medium text-slate-600">{INFO[n]!.short}</span>
                    </span>
                  </button>
                );
              })}
            </div>
          </div>
        ))}
        <p className="text-xs text-muted">Click a roll to choose it (click again to clear). With the keyboard: ← → to move.</p>
        {error && <p className="text-sm text-danger">{error}</p>}
      </div>

      {/* Preview of the chosen position. */}
      <div className="rounded-lg border border-line bg-surface-2 p-3 xl:sticky xl:top-4 xl:self-start" aria-live="polite">
        <p className="mb-2 text-sm font-semibold">Selected printing direction</p>
        {current ? (
          <>
            <div className="grid place-items-center rounded-md border border-line bg-white p-3">
              <WindingIcon position={current} className="h-64 w-auto" />
            </div>
            <p className="mt-3 text-base font-semibold">{describe(current)}</p>
            <p className="mt-1 text-sm text-muted">
              Labels on the {current <= 4 ? "outside" : "inside"} of the roll; as the roll unwinds, {INFO[current]!.lead}.
            </p>
          </>
        ) : (
          <div className="grid h-64 place-items-center rounded-md border border-dashed border-line bg-white p-4 text-center text-sm text-muted">No direction chosen yet. Pick one of the 8 rolls.</div>
        )}
      </div>
    </div>
  );
}
