import { useQuery } from "@tanstack/react-query";
import { useCallback, useState } from "react";
import { useSearchParams } from "react-router";
import { DataTable, PageHeader, SearchInput, type Column } from "@/components/common";
import { Badge, Dialog, Input, Select } from "@/components/ui";
import { api, qs } from "@/lib/api";
import { formatDateTime, humanize } from "@/lib/utils";
import type { AuditRow } from "./api";

const RESULT_TONE = { SUCCESS: "success", DENIED: "warning", FAILED: "danger" } as const;

export function AuditPage() {
  const [params, setParams] = useSearchParams();
  const f = {
    page: Number(params.get("page") ?? 1),
    q: params.get("q") ?? "",
    module: params.get("module") ?? "",
    action: params.get("action") ?? "",
    result: params.get("result") ?? "",
    from: params.get("from") ?? "",
    to: params.get("to") ?? "",
  };
  const setParam = useCallback(
    (patch: Record<string, string>) =>
      setParams((prev) => {
        const next = new URLSearchParams(prev);
        for (const [k, v] of Object.entries(patch)) v ? next.set(k, v) : next.delete(k);
        if (!("page" in patch)) next.delete("page");
        return next;
      }),
    [setParams],
  );
  const list = useQuery({
    queryKey: ["audit", f],
    queryFn: () =>
      api.list<AuditRow>(
        `/audit${qs({
          ...f,
          pageSize: 50,
          // date inputs are local days: send the whole day
          from: f.from ? new Date(`${f.from}T00:00:00`).toISOString() : undefined,
          to: f.to ? new Date(`${f.to}T23:59:59.999`).toISOString() : undefined,
        })}`,
      ),
    placeholderData: (prev) => prev,
  });
  const facets = useQuery({ queryKey: ["audit-facets"], queryFn: () => api.get<{ modules: string[]; actions: string[] }>("/audit/facets") });
  const [open, setOpen] = useState<AuditRow | null>(null);

  const columns: Column<AuditRow>[] = [
    { key: "time", header: "When", cell: (r) => <span className="whitespace-nowrap">{formatDateTime(r.occurredAt)}</span> },
    { key: "user", header: "User", cell: (r) => r.userName ?? <span className="text-muted">—</span> },
    {
      key: "action",
      header: "Action",
      cell: (r) => (
        <div>
          <p className="font-medium">{humanize(r.action)}</p>
          <p className="text-xs text-muted">{r.module}</p>
        </div>
      ),
    },
    { key: "record", header: "Record", hideOnMobile: true, cell: (r) => r.recordRef ?? <span className="text-muted">—</span> },
    { key: "result", header: "Result", cell: (r) => <Badge tone={RESULT_TONE[r.result]}>{humanize(r.result)}</Badge> },
  ];

  return (
    <>
      <PageHeader
        title="Audit Trail"
        description="Append-only record of sign-ins and sensitive changes. Entries can't be edited or deleted."
        crumbs={[{ label: "System" }, { label: "Audit Trail" }]}
      />
      <DataTable
        columns={columns}
        rows={list.data?.data}
        rowKey={(r) => r.id}
        loading={list.isPending}
        error={list.error}
        onRetry={() => void list.refetch()}
        page={f.page}
        pageCount={list.data?.meta.pageCount}
        total={list.data?.meta.total}
        onPage={(p) => setParam({ page: String(p) })}
        onRowClick={setOpen}
        toolbar={
          <>
            <SearchInput value={f.q} onChange={(v) => setParam({ q: v })} placeholder="Search record, user, remarks" />
            <Select value={f.module} onChange={(e) => setParam({ module: e.target.value })} className="sm:w-36" aria-label="Module">
              <option value="">All modules</option>
              {facets.data?.modules.map((m) => (
                <option key={m}>{m}</option>
              ))}
            </Select>
            <Select value={f.action} onChange={(e) => setParam({ action: e.target.value })} className="sm:w-48" aria-label="Action">
              <option value="">All actions</option>
              {facets.data?.actions.map((a) => (
                <option key={a} value={a}>
                  {humanize(a)}
                </option>
              ))}
            </Select>
            <Select value={f.result} onChange={(e) => setParam({ result: e.target.value })} className="sm:w-32" aria-label="Result">
              <option value="">All results</option>
              <option value="SUCCESS">Success</option>
              <option value="DENIED">Denied</option>
              <option value="FAILED">Failed</option>
            </Select>
            <div className="flex items-center gap-2">
              <Input type="date" value={f.from} onChange={(e) => setParam({ from: e.target.value })} className="sm:w-40" aria-label="From date" />
              <span className="text-muted">–</span>
              <Input type="date" value={f.to} onChange={(e) => setParam({ to: e.target.value })} className="sm:w-40" aria-label="To date" />
            </div>
          </>
        }
      />
      {open && (
        <Dialog open onClose={() => setOpen(null)} title={humanize(open.action)} description={formatDateTime(open.occurredAt)} size="lg">
          <dl className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-[10rem_1fr]">
            {(
              [
                ["User", open.userName],
                ["Module", open.module],
                ["Record type", open.entityType],
                ["Record", open.recordRef],
                ["Result", open.result],
                ["Remarks", open.remarks],
                ["Device", open.deviceId],
                ["IP address", open.ip],
              ] as const
            ).map(([k, v]) => (
              <div key={k} className="contents">
                <dt className="text-muted">{k}</dt>
                <dd className="break-words">{v ?? "—"}</dd>
              </div>
            ))}
          </dl>
          {(open.previous != null || open.next != null) && (
            <div className="mt-4 grid gap-3 md:grid-cols-2">
              {(
                [
                  ["Previous value", open.previous],
                  ["New value", open.next],
                ] as const
              ).map(([label, value]) => (
                <div key={label} className="min-w-0">
                  <p className="mb-1 text-xs font-semibold tracking-wide text-muted uppercase">{label}</p>
                  <pre className="overflow-x-auto rounded-md bg-surface-2 p-3 text-xs">{value == null ? "—" : JSON.stringify(value, null, 2)}</pre>
                </div>
              ))}
            </div>
          )}
        </Dialog>
      )}
    </>
  );
}
