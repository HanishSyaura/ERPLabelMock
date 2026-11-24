import { AlertTriangle, ArrowDown, ArrowUp, ArrowUpDown, ChevronLeft, ChevronRight, Inbox, Search } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { Link } from "react-router";
import { ApiError } from "@/lib/api";
import { cn } from "@/lib/utils";
import { Button, Dialog, Input, Spinner } from "./ui";

/* ---------- Page header (every page) ---------- */
export function PageHeader({
  title,
  description,
  actions,
  crumbs,
}: {
  title: string;
  description?: string;
  actions?: ReactNode;
  crumbs?: { label: string; to?: string }[];
}) {
  return (
    <div className="mb-5 flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
      <div className="min-w-0">
        {crumbs && crumbs.length > 0 && (
          <nav aria-label="Breadcrumb" className="mb-1 flex flex-wrap items-center gap-1 text-xs text-muted">
            {crumbs.map((c, i) => (
              <span key={i} className="flex items-center gap-1">
                {i > 0 && <ChevronRight className="size-3" />}
                {c.to ? (
                  <Link to={c.to} className="hover:text-text hover:underline">
                    {c.label}
                  </Link>
                ) : (
                  <span>{c.label}</span>
                )}
              </span>
            ))}
          </nav>
        )}
        <h1 className="text-xl font-semibold tracking-tight">{title}</h1>
        {description && <p className="mt-1 text-sm text-muted">{description}</p>}
      </div>
      {actions && <div className="flex flex-wrap gap-2">{actions}</div>}
    </div>
  );
}

/* ---------- Tabs (state kept by the caller, usually in the URL) ---------- */
export function Tabs<T extends string>({ tabs, value, onChange }: { tabs: { id: T; label: ReactNode }[]; value: T; onChange: (id: T) => void }) {
  return (
    <div role="tablist" className="relative mb-4 flex gap-1 overflow-x-auto border-b border-line">
      {tabs.map((t) => (
        <button
          key={t.id}
          role="tab"
          aria-selected={value === t.id}
          onClick={() => onChange(t.id)}
          className={cn(
            "-mb-px shrink-0 border-b-2 px-3 py-2 text-sm font-medium whitespace-nowrap transition-colors",
            value === t.id ? "border-primary text-primary" : "border-transparent text-muted hover:text-text",
          )}
        >
          {t.label}
        </button>
      ))}
    </div>
  );
}

/* ---------- States ---------- */
export function EmptyState({ title, description, action }: { title: string; description?: string; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 px-4 py-12 text-center">
      <Inbox className="size-8 text-muted" />
      <p className="font-medium">{title}</p>
      {description && <p className="max-w-md text-sm text-muted">{description}</p>}
      {action}
    </div>
  );
}

export function ErrorState({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  const message = error instanceof ApiError || error instanceof Error ? error.message : "Something went wrong.";
  return (
    <div role="alert" className="flex flex-col items-center gap-3 px-4 py-10 text-center">
      <AlertTriangle className="size-8 text-danger" />
      <p className="max-w-md text-sm">{message}</p>
      {onRetry && (
        <Button size="sm" onClick={onRetry}>
          Try again
        </Button>
      )}
    </div>
  );
}

export const LoadingState = ({ label = "Loading…" }: { label?: string }) => (
  <div className="flex items-center justify-center gap-2 py-12 text-sm text-muted">
    <Spinner /> {label}
  </div>
);

/* ---------- Confirm dialog ---------- */
export function ConfirmDialog({
  open,
  title,
  message,
  confirmLabel,
  tone = "primary",
  busy,
  onConfirm,
  onClose,
}: {
  open: boolean;
  title: string;
  message: ReactNode;
  confirmLabel: string;
  tone?: "primary" | "danger";
  busy?: boolean;
  onConfirm: () => void;
  onClose: () => void;
}) {
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={title}
      size="sm"
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant={tone === "danger" ? "danger" : "primary"} loading={busy} onClick={onConfirm}>
            {confirmLabel}
          </Button>
        </>
      }
    >
      <div className="text-sm">{message}</div>
    </Dialog>
  );
}

/* ---------- Search box with debounce ---------- */
export function SearchInput({ value, onChange, placeholder = "Search…" }: { value: string; onChange: (v: string) => void; placeholder?: string }) {
  const [text, setText] = useState(value);
  useEffect(() => setText(value), [value]);
  useEffect(() => {
    const t = setTimeout(() => text !== value && onChange(text), 300);
    return () => clearTimeout(t);
  }, [text, value, onChange]);
  return (
    <div className="relative w-full sm:w-72">
      <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted" />
      <Input value={text} onChange={(e) => setText(e.target.value)} placeholder={placeholder} className="pl-8" aria-label={placeholder} />
    </div>
  );
}

/* ---------- Data table (server-side paging & sorting) ---------- */
export interface Column<T> {
  key: string;
  header: string;
  cell: (row: T) => ReactNode;
  /** Server sort field; omit for unsortable columns. */
  sortKey?: string;
  className?: string;
  /** Hide below the sm breakpoint. */
  hideOnMobile?: boolean;
  /**
   * Place in the phone card layout. Defaults: key "art" = media, key "status" =
   * aside, first other column = title, hideOnMobile = hide, empty header =
   * footer (actions), everything else = a label/value row.
   */
  mobile?: "title" | "aside" | "media" | "row" | "footer" | "hide";
}

function mobilePlace<T>(c: Column<T>, i: number, firstTitle: number): NonNullable<Column<T>["mobile"]> {
  if (c.mobile) return c.mobile;
  if (c.key === "art") return "media";
  if (c.key === "status") return "aside";
  if (c.hideOnMobile) return "hide";
  if (i === firstTitle) return "title";
  if (!c.header) return "footer";
  return "row";
}

/** Phone layout: one tappable card per row. */
function MobileRows<T>({ columns, rows, rowKey, onRowClick }: { columns: Column<T>[]; rows: T[]; rowKey: (row: T) => string; onRowClick?: (row: T) => void }) {
  const firstTitle = columns.findIndex((c) => !c.mobile && c.key !== "art" && c.key !== "status" && !c.hideOnMobile && !!c.header);
  const placed = columns.map((c, i) => ({ c, place: mobilePlace(c, i, firstTitle) }));
  const pick = (p: string) => placed.filter((x) => x.place === p).map((x) => x.c);
  const [media, titles, asides, rowsCols, footers] = [pick("media"), pick("title"), pick("aside"), pick("row"), pick("footer")];
  return (
    <ul className="divide-y divide-line sm:hidden">
      {rows.map((row) => {
        const body = (
          <>
            <div className="flex items-start gap-3">
              {media.map((c) => (
                <div key={c.key} className="shrink-0">
                  {c.cell(row)}
                </div>
              ))}
              <div className="min-w-0 flex-1 space-y-0.5">{titles.map((c) => <div key={c.key} className="min-w-0 break-words">{c.cell(row)}</div>)}</div>
              {asides.length > 0 && <div className="flex shrink-0 flex-col items-end gap-1">{asides.map((c) => <div key={c.key}>{c.cell(row)}</div>)}</div>}
              {onRowClick && <ChevronRight className="mt-0.5 size-4 shrink-0 text-muted" />}
            </div>
            {rowsCols.length > 0 && (
              <dl className="mt-2 grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-sm">
                {rowsCols.map((c) => (
                  <div key={c.key} className="contents">
                    <dt className="text-xs text-muted uppercase">{c.header}</dt>
                    <dd className="min-w-0 text-right break-words [&_*]:!text-right">{c.cell(row)}</dd>
                  </div>
                ))}
              </dl>
            )}
          </>
        );
        return (
          <li key={rowKey(row)}>
            {onRowClick ? (
              <div role="button" tabIndex={0} onClick={() => onRowClick(row)} onKeyDown={(e) => e.key === "Enter" && onRowClick(row)} className="block w-full cursor-pointer px-3 py-3 text-left active:bg-surface-2">
                {body}
              </div>
            ) : (
              <div className="px-3 py-3">{body}</div>
            )}
            {footers.length > 0 && (
              <div className="flex flex-wrap justify-end gap-2 px-3 pb-3" onClick={(e) => e.stopPropagation()}>
                {footers.map((c) => <div key={c.key}>{c.cell(row)}</div>)}
              </div>
            )}
          </li>
        );
      })}
    </ul>
  );
}

export interface SortState {
  field: string;
  dir: "asc" | "desc";
}

export function DataTable<T>({
  columns,
  rows,
  rowKey,
  loading,
  error,
  onRetry,
  sort,
  onSort,
  page,
  pageCount,
  total,
  onPage,
  onRowClick,
  empty,
  toolbar,
}: {
  columns: Column<T>[];
  rows: T[] | undefined;
  rowKey: (row: T) => string;
  loading?: boolean;
  error?: unknown;
  onRetry?: () => void;
  sort?: SortState;
  onSort?: (s: SortState) => void;
  page?: number;
  pageCount?: number;
  total?: number;
  onPage?: (p: number) => void;
  onRowClick?: (row: T) => void;
  empty?: ReactNode;
  toolbar?: ReactNode;
}) {
  return (
    <div className="min-w-0 rounded-lg border border-line bg-surface">
      {toolbar && <div className="flex flex-col gap-2 border-b border-line p-3 sm:flex-row sm:flex-wrap sm:items-center">{toolbar}</div>}
      {!loading && !error && rows && rows.length > 0 && <MobileRows columns={columns} rows={rows} rowKey={rowKey} onRowClick={onRowClick} />}
      <div className="relative overflow-x-auto">
        <table className="hidden w-full text-left text-sm sm:table">
          <thead className="bg-surface-2 text-xs font-medium tracking-wide text-muted uppercase">
            <tr>
              {columns.map((c) => {
                const active = sort?.field === c.sortKey;
                return (
                  <th key={c.key} scope="col" className={cn("px-3 py-2.5 whitespace-nowrap", c.hideOnMobile && "hidden sm:table-cell", c.className)}>
                    {c.sortKey && onSort ? (
                      <button
                        className="inline-flex items-center gap-1 uppercase hover:text-text"
                        onClick={() => onSort({ field: c.sortKey!, dir: active && sort?.dir === "asc" ? "desc" : "asc" })}
                        aria-label={`Sort by ${c.header}`}
                      >
                        {c.header}
                        {active ? sort?.dir === "asc" ? <ArrowUp className="size-3" /> : <ArrowDown className="size-3" /> : <ArrowUpDown className="size-3 opacity-50" />}
                      </button>
                    ) : (
                      c.header
                    )}
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {!loading &&
              !error &&
              rows?.map((row) => (
                <tr
                  key={rowKey(row)}
                  className={cn(onRowClick && "cursor-pointer hover:bg-surface-2 focus:bg-surface-2 focus:outline-none")}
                  onClick={onRowClick ? () => onRowClick(row) : undefined}
                  onKeyDown={onRowClick ? (e) => e.key === "Enter" && onRowClick(row) : undefined}
                  tabIndex={onRowClick ? 0 : undefined}
                >
                  {columns.map((c) => (
                    <td key={c.key} className={cn("px-3 py-2.5 align-middle", c.hideOnMobile && "hidden sm:table-cell", c.className)}>
                      {c.cell(row)}
                    </td>
                  ))}
                </tr>
              ))}
          </tbody>
        </table>
        {loading && <LoadingState />}
        {!loading && error ? <ErrorState error={error} onRetry={onRetry} /> : null}
        {!loading && !error && rows?.length === 0 && (empty ?? <EmptyState title="No records found" description="Try a different search or filter." />)}
      </div>
      {page !== undefined && pageCount !== undefined && onPage && (
        <div className="flex items-center justify-between gap-3 border-t border-line px-3 py-2 text-sm text-muted">
          <span>{total !== undefined ? `${total.toLocaleString()} record${total === 1 ? "" : "s"}` : ""}</span>
          <div className="flex items-center gap-2">
            <span>
              Page {page} of {pageCount}
            </span>
            <Button size="sm" variant="ghost" disabled={page <= 1} onClick={() => onPage(page - 1)} aria-label="Previous page" icon={<ChevronLeft className="size-4" />} />
            <Button size="sm" variant="ghost" disabled={page >= pageCount} onClick={() => onPage(page + 1)} aria-label="Next page" icon={<ChevronRight className="size-4" />} />
          </div>
        </div>
      )}
    </div>
  );
}
