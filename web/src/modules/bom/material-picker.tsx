import { useQuery } from "@tanstack/react-query";
import { ChevronDown, Search } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import { Input, Spinner } from "@/components/ui";
import { api, qs } from "@/lib/api";
import { cn } from "@/lib/utils";
import type { Material } from "./api";

export type PickedMaterial = Pick<Material, "id" | "code" | "description" | "uom">;

/**
 * Search-as-you-type material picker (active materials only). Description and
 * unit come from the material, so the user never retypes them.
 */
export function MaterialPicker({
  value,
  onChange,
  invalid,
  autoFocus,
}: {
  value: PickedMaterial | null;
  onChange: (m: PickedMaterial) => void;
  invalid?: boolean;
  autoFocus?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const [debounced, setDebounced] = useState("");
  const [active, setActive] = useState(0);
  const listId = useId();
  const wrap = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const t = setTimeout(() => setDebounced(text.trim()), 200);
    return () => clearTimeout(t);
  }, [text]);
  useEffect(() => {
    const close = (e: MouseEvent) => !wrap.current?.contains(e.target as Node) && setOpen(false);
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, []);

  const results = useQuery({
    queryKey: ["materials", "lookup", debounced],
    queryFn: () => api.get<PickedMaterial[]>(`/materials/lookup${qs({ q: debounced })}`),
    enabled: open,
    staleTime: 30_000,
  });
  const items = results.data ?? [];
  useEffect(() => setActive(0), [debounced]);

  const pick = (m: PickedMaterial) => {
    onChange(m);
    setOpen(false);
    setText("");
  };

  return (
    <div ref={wrap} className="relative min-w-0">
      {!open && value ? (
        <button
          type="button"
          onClick={() => setOpen(true)}
          className={cn(
            "flex h-9 w-full items-center gap-2 rounded-md border bg-surface px-3 text-left text-sm",
            invalid ? "border-danger" : "border-line hover:border-focus",
          )}
        >
          <span className="font-medium">{value.code}</span>
          <span className="min-w-0 flex-1 truncate text-muted">{value.description}</span>
          <ChevronDown className="size-4 text-muted" />
        </button>
      ) : (
        <div className="relative">
          <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted" />
          <Input
            autoFocus={autoFocus || open}
            role="combobox"
            aria-expanded={open}
            aria-controls={listId}
            aria-invalid={invalid}
            placeholder="Search material code or description"
            className="pl-8"
            value={text}
            onFocus={() => setOpen(true)}
            onChange={(e) => {
              setText(e.target.value);
              setOpen(true);
            }}
            onKeyDown={(e) => {
              if (e.key === "ArrowDown") {
                e.preventDefault();
                setActive((a) => Math.min(a + 1, items.length - 1));
              } else if (e.key === "ArrowUp") {
                e.preventDefault();
                setActive((a) => Math.max(a - 1, 0));
              } else if (e.key === "Enter" && items[active]) {
                e.preventDefault();
                pick(items[active]);
              } else if (e.key === "Escape") {
                e.stopPropagation();
                setOpen(false);
              }
            }}
          />
        </div>
      )}
      {open && (
        <ul id={listId} role="listbox" className="absolute z-20 mt-1 max-h-64 w-full overflow-y-auto rounded-md border border-line bg-surface py-1 shadow-lg">
          {results.isPending && (
            <li className="flex items-center gap-2 px-3 py-2 text-sm text-muted">
              <Spinner className="size-4" /> Searching…
            </li>
          )}
          {!results.isPending && items.length === 0 && (
            <li className="px-3 py-2 text-sm text-muted">No active material matches. Add it in the Materials tab first.</li>
          )}
          {items.map((m, i) => (
            <li
              key={m.id}
              role="option"
              aria-selected={i === active}
              onMouseDown={(e) => {
                e.preventDefault();
                pick(m);
              }}
              onMouseEnter={() => setActive(i)}
              className={cn("cursor-pointer px-3 py-1.5 text-sm", i === active && "bg-primary-soft")}
            >
              <span className="font-medium">{m.code}</span> <span className="text-muted">· {m.uom}</span>
              <span className="block truncate text-xs text-muted">{m.description}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
