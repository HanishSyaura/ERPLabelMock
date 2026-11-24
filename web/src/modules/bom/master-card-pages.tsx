import { PrintDocumentButton } from "@/modules/documents/print-dialog";
import { Plus } from "lucide-react";
import { useCallback } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router";
import { DataTable, ErrorState, LoadingState, PageHeader, SearchInput, type Column } from "@/components/common";
import { StatusBadge } from "@/components/status";
import { Badge, Button, Select } from "@/components/ui";
import { formatDate } from "@/lib/utils";
import { useAuth } from "@/stores/auth";
import { rev } from "./api";
import { ArtworkThumb } from "./artwork";
import { useProduct, useProducts, type ProductRow } from "./product-api";
import { MasterCardPanel } from "./product-detail-page";

/**
 * BOM › Master Card: every finished-good part's engineering card. A card
 * exists for each finished-good part that has an Artwork No. (Father Code);
 * new ones start from Part Master.
 */
export function MasterCardListPage() {
  const { can } = useAuth();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const page = Number(params.get("page") ?? 1);
  const q = params.get("q") ?? "";
  const card = params.get("card") ?? "";
  const status = params.get("status") ?? "";
  const set = useCallback(
    (patch: Record<string, string>) =>
      setParams((prev) => {
        const next = new URLSearchParams(prev);
        for (const [k, v] of Object.entries(patch)) v ? next.set(k, v) : next.delete(k);
        if (!("page" in patch)) next.delete("page");
        return next;
      }),
    [setParams],
  );
  const list = useProducts({ page, q, card, status });
  const columns: Column<ProductRow>[] = [
    { key: "art", header: "Artwork", cell: (p) => <ArtworkThumb file={p.artworkFile} className="size-12" /> },
    {
      key: "part",
      header: "Part code",
      cell: (p) => (
        <div className="min-w-0">
          <p className="font-medium whitespace-nowrap">{p.productCode}</p>
          <p className="line-clamp-1 max-w-xs text-xs text-muted">{p.name}</p>
        </div>
      ),
    },
    { key: "nmi", header: "NMI No.", hideOnMobile: true, cell: (p) => p.nmiNo ?? "—" },
    {
      key: "fc",
      header: "Artwork No.",
      hideOnMobile: true,
      cell: (p) => (
        <Link to={`/bom/${p.bomId}`} onClick={(e) => e.stopPropagation()} className="text-primary hover:underline">
          {p.fatherCode}
        </Link>
      ),
    },
    {
      key: "cust",
      header: "Customer",
      hideOnMobile: true,
      cell: (p) => (
        <div className="min-w-0 text-sm">
          <p>{p.customerName ?? "—"}</p>
          {p.customerPartNo && <p className="text-xs text-muted">{p.customerPartNo}</p>}
        </div>
      ),
    },
    {
      key: "card",
      header: "Master Card",
      cell: (p) => (
        <div className="flex flex-wrap items-center gap-1">
          {p.currentCardRevNo ? <Badge tone="success">{rev(p.currentCardRevNo)} released</Badge> : <Badge tone="warning">Not released</Badge>}
          {p.draftRevNo && <Badge tone="primary">{rev(p.draftRevNo)} draft</Badge>}
          {p.releasedAt && <span className="text-xs text-muted">{formatDate(p.releasedAt)}</span>}
        </div>
      ),
    },
    { key: "status", header: "Status", hideOnMobile: true, cell: (p) => <StatusBadge kind="record" value={p.status} /> },
  ];
  return (
    <>
      <PageHeader
        title="Master Card"
        description="The engineering card of each finished-good part: header, AFRF-CS, specification and printing direction, material spec with QPA, and process detail. Production runs from the released revision."
        crumbs={[{ label: "BOM" }, { label: "Master Card" }]}
        actions={
          can("bom.material.manage") && (
            <Button variant="primary" icon={<Plus className="size-4" />} onClick={() => navigate("/bom/new-product")}>
              New Master Card
            </Button>
          )
        }
      />
      <DataTable
        columns={columns}
        rows={list.data?.data}
        rowKey={(p) => p.id}
        loading={list.isPending}
        error={list.error}
        onRetry={() => void list.refetch()}
        page={page}
        pageCount={list.data?.meta.pageCount}
        total={list.data?.meta.total}
        onPage={(p) => set({ page: String(p) })}
        onRowClick={(p) => navigate(`/bom/master-card/${p.id}`)}
        toolbar={
          <>
            <SearchInput value={q} onChange={(v) => set({ q: v })} placeholder="Part code, name, NMI, Father Code, customer" />
            <Select value={card} onChange={(e) => set({ card: e.target.value })} className="sm:w-48" aria-label="Master Card state">
              <option value="">All cards</option>
              <option value="released">Released (in production)</option>
              <option value="draft">Draft waiting</option>
              <option value="none">No card yet</option>
            </Select>
            <Select value={status} onChange={(e) => set({ status: e.target.value })} className="sm:w-36" aria-label="Status">
              <option value="">All statuses</option>
              <option value="ACTIVE">Active</option>
              <option value="INACTIVE">Inactive</option>
            </Select>
          </>
        }
        empty={
          <p className="px-4 py-12 text-center text-sm text-muted">
            {q || card || status ? "No Master Cards match." : "No Master Cards yet. Use “New Master Card” to set up a product from artwork to Master Card."}
          </p>
        }
      />
    </>
  );
}


/** BOM › Master Card › one part. */
export function MasterCardPage() {
  const { id = "" } = useParams();
  const product = useProduct(id);
  if (product.isPending) return <LoadingState />;
  if (product.error) return <ErrorState error={product.error} onRetry={() => void product.refetch()} />;
  const p = product.data;
  return (
    <>
      <PageHeader
        title={`${p.productCode} – Master Card`}
        description={p.name}
        crumbs={[{ label: "BOM" }, { label: "Master Card", to: "/bom/master-card" }, { label: p.productCode }]}
        actions={
          <>
            {(p.released || p.draft) && <PrintDocumentButton type="MASTER_CARD" id={p.id} />}
            <Link to={`/bom/${p.fatherCode.id}`}>
              <Button>Bill of Material ({p.fatherCode.fatherCode})</Button>
            </Link>
            <Link to={`/master-data/part-master/${p.part.id}`}>
              <Button>Part Master</Button>
            </Link>
          </>
        }
      />
      <MasterCardPanel productId={p.id} />
    </>
  );
}
