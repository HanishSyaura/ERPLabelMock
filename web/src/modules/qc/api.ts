import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, qs } from "@/lib/api";

/** Phase 5 QC: Defect Master, inspection / label templates, IQC, OQC, shipping labels. */

export type QcType = "IQC" | "OQC";
export type QcStatus = "IN_INSPECTION" | "PASSED" | "PENDING_DISPOSITION" | "ACCEPTED" | "REJECTED" | "REWORK" | "RETURNED";
export type Disposition = "USE_AS_IS" | "REJECT" | "REWORK" | "RETURN_TO_SUPPLIER";
export type Severity = "MINOR" | "MAJOR" | "CRITICAL";
export type DefectCategory = "PRINT" | "COLOUR" | "REGISTRATION" | "DIE_CUT" | "MATERIAL" | "ADHESIVE" | "LAMINATION" | "SLITTING" | "WINDING" | "CONTAMINATION" | "PACKAGING" | "OTHER";

export const DEFECT_CATEGORY_LABEL: Record<DefectCategory, string> = {
  PRINT: "Print",
  COLOUR: "Colour",
  REGISTRATION: "Registration",
  DIE_CUT: "Die cut",
  MATERIAL: "Material",
  ADHESIVE: "Adhesive",
  LAMINATION: "Lamination",
  SLITTING: "Slitting",
  WINDING: "Winding / rewind",
  CONTAMINATION: "Contamination",
  PACKAGING: "Packaging",
  OTHER: "Other",
};
export const DISPOSITION_LABEL: Record<Disposition, string> = { USE_AS_IS: "Use as is (concession)", REJECT: "Reject", REWORK: "Rework, then reinspect", RETURN_TO_SUPPLIER: "Return to supplier" };
export const DISPOSITIONS: Record<QcType, Disposition[]> = { IQC: ["USE_AS_IS", "REJECT", "RETURN_TO_SUPPLIER"], OQC: ["USE_AS_IS", "REJECT", "REWORK"] };

export interface DefectCode {
  id: string;
  code: string;
  name: string;
  category: DefectCategory;
  severity: Severity;
  appliesIqc: boolean;
  appliesOqc: boolean;
  description: string | null;
  status: "ACTIVE" | "INACTIVE";
  findingCount: number;
}

export interface TemplateItem {
  label: string;
  kind: "PASS_FAIL" | "MEASURE";
  target: string | null;
  min: number | null;
  max: number | null;
  unit: string | null;
  required: boolean;
}
export interface InspectionTemplate {
  id: string;
  code: string;
  name: string;
  type: QcType;
  partCategoryId: string | null;
  partCategory: { id: string; code: string; name: string } | null;
  items: TemplateItem[];
  status: "ACTIVE" | "INACTIVE";
  inspectionCount: number;
}

export const LABEL_FIELDS = [
  ["labelNo", "Label no."],
  ["customerName", "Customer"],
  ["productCode", "Product code"],
  ["productName", "Product name"],
  ["customerPartNo", "Customer part no."],
  ["customerRef", "Customer PO / ref"],
  ["fatherCode", "Father Code"],
  ["labelDescription", "Label description"],
  ["pjoNo", "PJO no."],
  ["woNo", "Job Order"],
  ["lotNo", "Lot (OQC no.)"],
  ["qty", "Quantity"],
  ["cartonNo", "Carton x / y"],
  ["packedDate", "Packed date"],
  ["inspector", "Inspector"],
] as const;
export type LabelField = (typeof LABEL_FIELDS)[number][0];
export const labelFieldName = (k: string) => LABEL_FIELDS.find(([f]) => f === k)?.[1] ?? k;

export interface LabelTemplate {
  id: string;
  code: string;
  name: string;
  widthMm: number;
  heightMm: number;
  fields: LabelField[];
  barcode: "CODE128" | "QR";
  barcodeField: LabelField;
  status: "ACTIVE" | "INACTIVE";
}

export interface InspectionRow {
  id: string;
  inspNo: string;
  type: QcType;
  status: QcStatus;
  result: "PASS" | "FAIL" | null;
  disposition: Disposition | null;
  qty: string;
  uom: string;
  sampleSize: string | null;
  goodQty: string | null;
  rejectQty: string | null;
  part: { id: string; code: string; description: string; category: string | null } | null;
  lotRef: string | null;
  supplierName: string | null;
  deliveryRef: string | null;
  workOrder: { id: string; woNo: string; pjoId: string; pjoNo: string; customerRef: string | null; fatherCode: string; labelDescription: string } | null;
  template: { id: string; code: string; name: string } | null;
  reinspection: { id: string; inspNo: string; status: QcStatus } | null;
  reinspectionOf: { id: string; inspNo: string } | null;
  checkedInAt: string;
  checkedInBy: string | null;
  checkedOutAt: string | null;
  checkedOutBy: string | null;
}
export interface CheckResult extends TemplateItem {
  pass: boolean | null;
  value: number | null;
  note: string | null;
}
export interface ShippingLabelRow {
  id: string;
  labelNo: string;
  cartonNo: number;
  cartonCount: number;
  qty: string;
  uom: string;
  status: "ACTIVE" | "VOID";
  printCount: number;
  lastPrintedAt: string | null;
  voidReason: string | null;
  createdBy?: string | null;
  data?: LabelData;
  inspection?: { id: string; inspNo: string };
  template?: { code: string; name: string };
}
export interface LabelData extends Partial<Record<LabelField, string | null>> {
  fields: LabelField[];
  barcode: "CODE128" | "QR";
  barcodeValue: string;
  widthMm: number;
  heightMm: number;
}
export interface InspectionDetail extends InspectionRow {
  checks: CheckResult[];
  remarks: string | null;
  dispositionNote: string | null;
  dispositionAt: string | null;
  dispositionBy: string | null;
  defects: { id: string; qty: string; remark: string | null; code: string; name: string; category: DefectCategory; severity: Severity }[];
  releasedQty: string;
  labelledQty: string;
  labels: ShippingLabelRow[];
}
export interface OqcCandidate {
  id: string;
  woNo: string;
  status: string;
  pjoNo: string;
  fatherCode: string;
  uom: string;
  finishedQty: string;
  offeredQty: string;
  availableQty: string;
}
export interface ReadyLot {
  id: string;
  inspNo: string;
  status: QcStatus;
  woNo: string | null;
  pjoNo: string | null;
  fatherCode: string | null;
  uom: string;
  releasedQty: string;
  labelledQty: string;
  remainingQty: string;
}

export const useDefects = (p: { status?: string; type?: QcType } = {}) => useQuery({ queryKey: ["qc", "defects", p], queryFn: () => api.get<DefectCode[]>(`/qc/defects${qs(p)}`) });
export const useInspectionTemplates = (p: { type?: QcType; status?: string } = {}) =>
  useQuery({ queryKey: ["qc", "inspection-templates", p], queryFn: () => api.get<InspectionTemplate[]>(`/qc/inspection-templates${qs(p)}`) });
export const useLabelTemplates = (status?: string) => useQuery({ queryKey: ["qc", "label-templates", status], queryFn: () => api.get<LabelTemplate[]>(`/qc/label-templates${qs({ status })}`) });
export const useInspections = (type: QcType, p: { page: number; q?: string; view: string }) =>
  useQuery({
    queryKey: ["qc", "inspections", type, p],
    queryFn: () => api.list<InspectionRow>(`/qc/${type.toLowerCase()}${qs(p)}`),
    placeholderData: (prev) => prev,
  });
export const useInspection = (id: string) => useQuery({ queryKey: ["qc", "inspection", id], queryFn: () => api.get<InspectionDetail>(`/qc/inspections/${id}`) });
export const useOqcCandidates = (q: string, enabled = true) => useQuery({ queryKey: ["qc", "oqc-candidates", q], queryFn: () => api.get<OqcCandidate[]>(`/qc/oqc-candidates${qs({ q })}`), enabled });
export const useReadyLots = (enabled = true) => useQuery({ queryKey: ["qc", "labels-ready"], queryFn: () => api.get<ReadyLot[]>("/qc/labels/ready"), enabled });
export const useLabels = (p: { page: number; q?: string; status?: string; ids?: string; pageSize?: number }) =>
  useQuery({ queryKey: ["qc", "labels", p], queryFn: () => api.list<ShippingLabelRow>(`/qc/labels${qs(p)}`), placeholderData: (prev) => prev });

/** Mutation that refreshes every QC query afterwards. */
export function useQcMutation<V, R = unknown>(fn: (v: V) => Promise<R>) {
  const qc = useQueryClient();
  return useMutation({ mutationFn: fn, onSuccess: () => qc.invalidateQueries({ queryKey: ["qc"] }) });
}
