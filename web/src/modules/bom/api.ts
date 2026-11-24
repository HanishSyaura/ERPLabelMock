import { useQuery } from "@tanstack/react-query";
import { api, API_BASE, qs } from "@/lib/api";

export interface FileInfo {
  id: string;
  originalName: string;
  extension: string;
  mimeType: string;
  sizeBytes: number;
  sha256: string;
  previewKind: "image" | "pdf" | "none";
  hasThumbnail: boolean;
  uploadedAt: string;
}

export interface DuplicateWarning {
  type: "FILE_HASH" | "FILE_NAME" | "DESCRIPTION";
  message: string;
  matches: { bomId: string; fatherCode: string; labelDescription: string; artworkRevision: number | null; current: boolean }[];
}

export interface BomRow {
  id: string;
  fatherCode: string;
  labelDescription: string;
  status: "ACTIVE" | "INACTIVE";
  artworkRevision: number;
  componentRevision: number;
  sonCount: number;
  artworkFile: FileInfo | null;
  updatedAt: string;
  updatedBy: string | null;
  /** The product that owns this Father Code (one per product), if any. */
  product: { id: string; productCode: string; name: string; customerName: string | null; status: "ACTIVE" | "INACTIVE"; currentCardRevNo: number; draftRevNo: number | null } | null;
}

export interface ComponentLine {
  sonCodeId: string;
  sonCode: string;
  materialId: string;
  materialCode: string;
  materialDescription: string;
  quantity: string | null;
  uom: string | null;
  remarks: string | null;
  status: "ACTIVE" | "REMOVED";
  materialActive: boolean;
}

export interface BomDetail {
  id: string;
  fatherCode: string;
  /** The finished-good part whose Master Card this Father Code carries. */
  finishedPart: { productId: string; partId: string; code: string; currentCardRevNo: number } | null;
  status: "ACTIVE" | "INACTIVE";
  labelDescription: string;
  createdAt: string;
  createdBy: string | null;
  updatedAt: string;
  updatedBy: string | null;
  artwork: { revisionNo: number; changeType: string; createdAt: string; createdBy: string | null; file: FileInfo };
  componentRevision: { revisionNo: number; createdAt: string; createdBy: string | null } | null;
  components: ComponentLine[];
  removedSonCount: number;
}

export interface ArtworkRevision {
  revisionNo: number;
  labelDescription: string;
  changeType: string;
  changeNote: string | null;
  restoredFromRevisionNo: number | null;
  createdAt: string;
  createdBy: string | null;
  file: FileInfo;
}

export interface LineChange {
  sonCode: string;
  materialCode?: string;
  materialDescription?: string;
  quantity?: string | null;
  uom?: string | null;
  remarks?: string | null;
}
export interface ComponentRevision {
  revisionNo: number;
  changeType: string;
  changes: { added: LineChange[]; modified: { sonCode: string; before: LineChange; after: LineChange }[]; removed: LineChange[] };
  changeNote: string | null;
  restoredFromRevisionNo: number | null;
  lineCount: number;
  createdAt: string;
  createdBy: string | null;
}

export interface Material {
  id: string;
  code: string;
  description: string;
  uom: string;
  remarks: string | null;
  status: "ACTIVE" | "INACTIVE";
  activeSonCodes?: number;
  updatedAt?: string;
}

export interface Uom {
  code: string;
  label: string;
}

export const fileUrl = (id: string, opts: { download?: boolean } = {}) => `${API_BASE}/bom-files/${id}/content${opts.download ? "?download=1" : ""}`;
export const thumbUrl = (id: string) => `${API_BASE}/bom-files/${id}/thumbnail`;

export const useBoms = (p: { page: number; q?: string; status?: string; product?: string; sort?: string }) =>
  useQuery({ queryKey: ["boms", p], queryFn: () => api.list<BomRow>(`/boms${qs(p)}`), placeholderData: (prev) => prev });
export const useBom = (id: string) => useQuery({ queryKey: ["boms", "detail", id], queryFn: () => api.get<BomDetail>(`/boms/${id}`) });
export const useArtworkRevisions = (id: string) =>
  useQuery({ queryKey: ["boms", "detail", id, "artwork"], queryFn: () => api.get<ArtworkRevision[]>(`/boms/${id}/artwork-revisions`) });
export const useComponentRevisions = (id: string) =>
  useQuery({ queryKey: ["boms", "detail", id, "components"], queryFn: () => api.get<ComponentRevision[]>(`/boms/${id}/component-revisions`) });
export const useBomHistory = (id: string) =>
  useQuery({
    queryKey: ["boms", "detail", id, "history"],
    queryFn: () => api.get<{ id: string; occurredAt: string; userName: string | null; action: string; previous: unknown; next: unknown; remarks: string | null }[]>(`/boms/${id}/history`),
  });
export const useUoms = () => useQuery({ queryKey: ["uoms"], queryFn: () => api.get<Uom[]>("/materials/uoms"), staleTime: Infinity });
export const useMaterials = (p: { page: number; q?: string; status?: string; sort?: string }) =>
  useQuery({ queryKey: ["materials", p], queryFn: () => api.list<Material>(`/materials${qs(p)}`), placeholderData: (prev) => prev });

export const formatBytes = (n: number) => (n < 1024 * 1024 ? `${Math.max(1, Math.round(n / 1024))} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`);
export const rev = (n: number) => `Rev ${String(n).padStart(2, "0")}`;
