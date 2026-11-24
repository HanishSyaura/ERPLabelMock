import { Plus } from "lucide-react";
import { useCallback, useState } from "react";
import { Link, Navigate, useNavigate, useSearchParams } from "react-router";
import { DataTable, PageHeader, SearchInput, type Column, type SortState } from "@/components/common";
import { Badge, Button, Select } from "@/components/ui";
import { formatDateTime } from "@/lib/utils";
import { useAuth } from "@/stores/auth";
import { rev, useBoms, type BomRow } from "./api";
import { ArtworkThumb } from "./artwork";
import { NewFatherCodeDialog } from "./bom-dialogs";

/**
 * BOM menu page: one list of Father Codes with the product that owns each one
 * (one Father Code per product). Materials live in Master Data.
 */
export function BomPage() {
  const [params] = useSearchParams();
  const raw = params.get("tab");
  if (raw === "materials") return <Navigate to="/master-data/part-master" replace />;
  if (raw === "products") return <Navigate to="/bom?product=with" replace />;
  return (
    <>
      <PageHeader
        title="Bill of Material"
        description="Father Code = artwork and label description. Son Codes = the components used for that artwork. Each finished-good part (Part Master) owns one Father Code; its Master Card is on the Father Code page."
        crumbs={[{ label: "BOM" }, { label: "Bill of Material" }]}
      />
      <FatherCodeList />
    </>
  );
}

function FatherCodeList() {
  const { can } = useAuth();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const page = Number(params.get("page") ?? 1);
  const q = params.get("q") ?? "";
  const status = params.get("status") ?? "";
  const product = params.get("product") ?? "";
  const sortParam = params.get("sort") ?? "updatedAt:desc";
  const [sf, sd] = sortParam.split(":");
  const sort: SortState = { field: sf ?? "updatedAt", dir: sd === "asc" ? "asc" : "desc" };
  const [creating, setCreating] = useState(false);
  const boms = useBoms({ page, q, status, product, sort: sortParam });

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

  const columns: Column<BomRow>[] = [
    { key: "thumb", header: "Artwork", cell: (b) => <ArtworkThumb file={b.artworkFile} /> },
    {
      key: "father",
      header: "Father Code",
      sortKey: "fatherCode",
      cell: (b) => (
        <div className="min-w-0">
          <p className="font-medium whitespace-nowrap">{b.fatherCode}</p>
          <p className="max-w-xs truncate text-xs text-muted sm:hidden">{b.labelDescription}</p>
        </div>
      ),
    },
    { key: "desc", header: "Label Description", sortKey: "labelDescription", hideOnMobile: true, cell: (b) => <span className="line-clamp-2 max-w-md">{b.labelDescription}</span> },
    {
      key: "product",
      header: "Finished-good part / Master Card",
      cell: (b) =>
        b.product ? (
          <div className="min-w-0">
            <Link to={`/bom/master-card/${b.product.id}`} onClick={(e) => e.stopPropagation()} className="font-medium text-primary hover:underline">
              {b.product.productCode}
            </Link>
            <p className="line-clamp-1 max-w-56 text-xs text-muted">{[b.product.name, b.product.customerName].filter(Boolean).join(" · ")}</p>
            <div className="mt-1 flex flex-wrap gap-1">
              {b.product.currentCardRevNo ? <Badge tone="success">Card {rev(b.product.currentCardRevNo)}</Badge> : <Badge tone="warning">Card not released</Badge>}
              {b.product.draftRevNo && <Badge tone="primary">{rev(b.product.draftRevNo)} draft</Badge>}
              {b.product.status === "INACTIVE" && <Badge tone="neutral">Product inactive</Badge>}
            </div>
          </div>
        ) : (
          <span className="text-xs text-muted">No finished-good part</span>
        ),
    },
    { key: "sons", header: "Son Codes", className: "text-center", cell: (b) => <span className="tabular-nums">{b.sonCount}</span> },
    {
      key: "rev",
      header: "Revision",
      hideOnMobile: true,
      cell: (b) => (
        <div className="text-xs whitespace-nowrap">
          <p>Artwork {rev(b.artworkRevision)}</p>
          <p className="text-muted">{b.componentRevision ? `BOM ${rev(b.componentRevision)}` : "No components yet"}</p>
        </div>
      ),
    },
    { key: "status", header: "Status", cell: (b) => <Badge tone={b.status === "ACTIVE" ? "success" : "neutral"}>{b.status === "ACTIVE" ? "Active" : "Inactive"}</Badge> },
    {
      key: "updated",
      header: "Last Updated",
      sortKey: "updatedAt",
      hideOnMobile: true,
      cell: (b) => (
        <div className="text-xs whitespace-nowrap">
          <p>{formatDateTime(b.updatedAt)}</p>
          <p className="text-muted">{b.updatedBy}</p>
        </div>
      ),
    },
  ];

  return (
    <>
      <DataTable
        columns={columns}
        rows={boms.data?.data}
        rowKey={(b) => b.id}
        loading={boms.isPending}
        error={boms.error}
        onRetry={() => void boms.refetch()}
        sort={sort}
        onSort={(s) => setParam({ sort: `${s.field}:${s.dir}` })}
        page={page}
        pageCount={boms.data?.meta.pageCount}
        total={boms.data?.meta.total}
        onPage={(p) => setParam({ page: String(p) })}
        onRowClick={(b) => navigate(`/bom/${b.id}`)}
        toolbar={
          <>
            <SearchInput value={q} onChange={(v) => setParam({ q: v })} placeholder="Father Code, product, customer, Son Code, material" />
            <Select value={product} onChange={(e) => setParam({ product: e.target.value })} className="sm:w-44" aria-label="Product filter">
              <option value="">With or without part</option>
              <option value="with">With a finished-good part</option>
              <option value="without">No part yet</option>
            </Select>
            <Select value={status} onChange={(e) => setParam({ status: e.target.value })} className="sm:w-40" aria-label="Status filter">
              <option value="">All statuses</option>
              <option value="ACTIVE">Active</option>
              <option value="INACTIVE">Inactive</option>
            </Select>
            <div className="flex-1" />
            {can("bom.product.manage") && (
              <Button icon={<Plus className="size-4" />} onClick={() => navigate("/bom/new-product")}>
                New product
              </Button>
            )}
            {can("bom.create") && (
              <Button variant="primary" icon={<Plus className="size-4" />} onClick={() => setCreating(true)}>
                New Father Code
              </Button>
            )}
          </>
        }
        empty={
          <div className="px-4 py-12 text-center">
            <p className="font-medium">{q || status || product ? "No Father Codes match." : "No Father Codes yet."}</p>
            <p className="mt-1 text-sm text-muted">{can("bom.create") && !q && !status ? "Create the first one: upload the artwork and enter its label description." : "Try a different search or filter."}</p>
          </div>
        }
      />
      {creating && <NewFatherCodeDialog onClose={() => setCreating(false)} />}
    </>
  );
}
