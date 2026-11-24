import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, qs } from "@/lib/api";
import type { FileInfo } from "./api";

export type CardStatus = "DRAFT" | "RELEASED" | "SUPERSEDED";

export interface CardSpec {
  labelWidthMm?: number;
  labelHeightMm?: number;
  shape?: string;
  cornerRadiusMm?: number;
  across?: number;
  gapAcrossMm?: number;
  gapAroundMm?: number;
  coreMm?: number;
  labelsPerRoll?: number;
  winding?: string;
  maxRollDiameterMm?: number;
  rollsPerCarton?: number;
  printMethod?: string;
  colours?: string;
  varnish?: string;
  finishing?: string;
  dieRef?: string;
  plateRef?: string;
  customerRequirements?: string;
  // Header
  customerCode?: string;
  customerPartCode?: string;
  endUser?: string;
  // AFRF-CS
  afrfMaterial?: string;
  afrfColor?: string;
  afrfDetail?: string;
  packingInstruction?: string;
  afrfForm?: string;
  supplierCode?: string;
  afrfRemark?: string;
  printingDirection?: string;
  specialInstruction?: string;
  // Die Cut Spec
  dieCutId?: string;
  feedLengthMm?: number;
  sampleCount?: number;
  feedUps?: number;
  actualUps?: number;
  // Material Spec / Process Detail
  bomDetail?: BomDetailRow[];
  processDetail?: ProcessDetailRow[];
  printingMachines?: PrintingMachineRow[];
}
export interface BomDetailRow {
  sonCode: string;
  widthMm?: number | null;
  lengthMm?: number | null;
  heightMm?: number | null;
  manualQpa?: number | null;
}
export interface ProcessDetailRow {
  seq: number;
  machineCategoryId?: string | null;
  defaultMachineId?: string | null;
  setupMins?: number | null;
  outputPerPress?: number | null;
  noOfPrint?: number | null;
  speed?: number | null;
  speedUom?: string | null;
}
export interface PrintingMachineRow {
  machineCategoryId?: string | null;
  machineId?: string | null;
  noOfPrint?: number | null;
  setupMins?: number | null;
  outputPerPress?: number | null;
  speed?: number | null;
}
export interface QpaLine {
  sonCode: string;
  materialCode: string;
  materialDescription: string;
  uom: string;
  widthMm: number | null;
  lengthMm: number | null;
  heightMm: number | null;
  bomQty: number | null;
  calculated: number | null;
  formula: string;
  manualQpa: number | null;
  qpa: number | null;
  source: "MANUAL" | "CALCULATED" | "BOM" | "MISSING";
}
export interface DieSpecView {
  feedLengthMm: number | null;
  feedLengthFrom: string | null;
  feedUps: number | null;
  feedUpsFormula: string | null;
  actualUps: number | null;
  qpa: number | null;
  formula: string;
}

export interface ProductRow {
  id: string;
  productCode: string;
  name: string;
  customerName: string | null;
  customerPartNo: string | null;
  uom: string;
  status: "ACTIVE" | "INACTIVE";
  bomId: string;
  partId: string;
  nmiNo: string | null;
  fatherCode: string;
  labelDescription: string;
  artworkFile: FileInfo | null;
  currentCardRevNo: number;
  draftRevNo: number | null;
  releasedAt: string | null;
}

export interface CardView {
  id: string;
  revisionNo: number;
  status: CardStatus;
  spec: CardSpec;
  changeNote: string | null;
  artwork: {
    revisionNo: number;
    labelDescription: string;
    file: FileInfo;
    current: boolean;
  };
  component: {
    revisionNo: number;
    current: boolean;
    lines: {
      sonCode: string;
      materialCode: string;
      materialDescription: string;
      quantity: string | null;
      uom: string | null;
    }[];
  } | null;
  routine: { id: string; code: string; name: string; steps: string[]; stepDetail: { seq: number; processId: string; process: string }[] } | null;
  die: { id: string; code: string; description: string; across: number; around: number; repeatMm: string | null; labelWidthMm: string; labelHeightMm: string } | null;
  dieSpec: DieSpecView;
  qpa: QpaLine[];
  releaseProblems: string[];
  createdBy: string | null;
  createdAt: string;
  releasedBy: string | null;
  releasedAt: string | null;
  supersededAt: string | null;
}

export interface ProductDetail {
  id: string;
  productCode: string;
  name: string;
  part: { id: string; code: string; nmiNo: string | null; description: string };
  customerName: string | null;
  customerPartNo: string | null;
  uom: string;
  status: "ACTIVE" | "INACTIVE";
  remarks: string | null;
  currentCardRevNo: number;
  createdAt: string;
  fatherCode: {
    id: string;
    fatherCode: string;
    status: string;
    labelDescription: string;
    currentArtworkRevNo: number;
    currentComponentRevNo: number;
    newerThanReleased: boolean;
  };
  artworkFile: FileInfo | null;
  released: CardView | null;
  draft: CardView | null;
  cards: {
    id: string;
    revisionNo: number;
    status: CardStatus;
    artworkRevision: number;
    componentRevision: number | null;
    changeNote: string | null;
    releasedAt: string | null;
    releasedBy: string | null;
    supersededAt: string | null;
    createdAt: string;
  }[];
  orders: {
    id: string;
    pjoNo: string;
    status: string;
    orderQty: string;
    uom: string;
    requiredDate: string | null;
    cardRevisionNo: number | null;
  }[];
}

export interface AvailableFatherCode {
  id: string;
  fatherCode: string;
  labelDescription: string;
  artworkRevision: number;
  componentRevision: number;
  artworkFile: FileInfo | null;
}

export const useProducts = (p: { page: number; q?: string; status?: string; card?: string }) =>
  useQuery({
    queryKey: ["products", p],
    queryFn: () => api.list<ProductRow>(`/products${qs(p)}`),
    placeholderData: (prev) => prev,
  });
export const useProduct = (id: string) =>
  useQuery({
    queryKey: ["products", "detail", id],
    queryFn: () => api.get<ProductDetail>(`/products/${id}`),
    enabled: !!id,
  });
export const useProductHistory = (id: string, enabled: boolean) =>
  useQuery({
    queryKey: ["products", "detail", id, "history"],
    queryFn: () =>
      api.get<
        {
          id: string;
          occurredAt: string;
          userName: string | null;
          action: string;
          previous: unknown;
          next: unknown;
          remarks: string | null;
        }[]
      >(`/products/${id}/history`),
    enabled,
  });
export const useAvailableFatherCodes = (q: string) =>
  useQuery({
    queryKey: ["products", "available", q],
    queryFn: () =>
      api.get<AvailableFatherCode[]>(
        `/products/available-father-codes${qs({ q })}`,
      ),
  });

/** Mutation that refreshes products, BOM and planning queries. */
export function useProductMutation<V, R = unknown>(fn: (v: V) => Promise<R>) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: fn,
    onSettled: () =>
      Promise.all([
        qc.invalidateQueries({ queryKey: ["products"] }),
        qc.invalidateQueries({ queryKey: ["boms"] }),
        qc.invalidateQueries({ queryKey: ["planning"] }),
      ]),
  });
}

/** Winding positions on the standard rewind chart. */
export const WINDINGS: { value: string; label: string }[] = [
  { value: "1", label: "1 – outside wound, top off first" },
  { value: "2", label: "2 – outside wound, bottom off first" },
  { value: "3", label: "3 – outside wound, right side first" },
  { value: "4", label: "4 – outside wound, left side first" },
  { value: "5", label: "5 – inside wound, top off first" },
  { value: "6", label: "6 – inside wound, bottom off first" },
  { value: "7", label: "7 – inside wound, right side first" },
  { value: "8", label: "8 – inside wound, left side first" },
];

type FieldKind = "number" | "int" | "text" | "winding" | "long";
export interface SpecField {
  key: keyof CardSpec;
  label: string;
  unit?: string;
  kind: FieldKind;
  required?: boolean;
  /** Which record owns the attribute. */
  owner: string;
}
export const SPEC_GROUPS: { title: string; fields: SpecField[] }[] = [
  {
    title: "Label",
    fields: [
      {
        key: "labelWidthMm",
        label: "Label width",
        unit: "mm",
        kind: "number",
        required: true,
        owner: "Tooling (die)",
      },
      {
        key: "labelHeightMm",
        label: "Label height",
        unit: "mm",
        kind: "number",
        required: true,
        owner: "Tooling (die)",
      },
      { key: "shape", label: "Shape", kind: "text", owner: "Tooling (die)" },
      {
        key: "cornerRadiusMm",
        label: "Corner radius",
        unit: "mm",
        kind: "number",
        owner: "Tooling (die)",
      },
      {
        key: "across",
        label: "Across",
        kind: "int",
        required: true,
        owner: "Tooling (die)",
      },
      {
        key: "gapAcrossMm",
        label: "Gap across",
        unit: "mm",
        kind: "number",
        owner: "Tooling (die)",
      },
      {
        key: "gapAroundMm",
        label: "Gap around",
        unit: "mm",
        kind: "number",
        owner: "Tooling (die)",
      },
    ],
  },
  {
    title: "Print and finishing",
    fields: [
      {
        key: "printMethod",
        label: "Print method",
        kind: "text",
        owner: "Routing",
      },
      { key: "colours", label: "Colours", kind: "text", owner: "Artwork" },
      {
        key: "varnish",
        label: "Varnish / lamination",
        kind: "text",
        owner: "Artwork + BOM",
      },
      { key: "finishing", label: "Finishing", kind: "text", owner: "Routing" },
    ],
  },
  {
    title: "Delivery",
    fields: [
      {
        key: "coreMm",
        label: "Core",
        unit: "mm",
        kind: "number",
        required: true,
        owner: "Master Card",
      },
      {
        key: "labelsPerRoll",
        label: "Labels per roll",
        kind: "int",
        required: true,
        owner: "Master Card",
      },
      {
        key: "maxRollDiameterMm",
        label: "Max roll diameter",
        unit: "mm",
        kind: "number",
        owner: "Master Card",
      },
      {
        key: "rollsPerCarton",
        label: "Rolls per carton",
        kind: "int",
        owner: "Master Card",
      },
    ],
  },
  {
    title: "Tooling and customer",
    fields: [
      { key: "dieRef", label: "Die reference", kind: "text", owner: "Tooling" },
      {
        key: "plateRef",
        label: "Plate set reference",
        kind: "text",
        owner: "Tooling (per artwork revision)",
      },
      {
        key: "customerRequirements",
        label: "Customer requirements",
        kind: "long",
        owner: "Master Card",
      },
    ],
  },
];

SPEC_GROUPS.push(
  {
    title: "Header",
    fields: [
      { key: "customerCode", label: "Customer code", kind: "text", owner: "Master Card" },
      { key: "customerPartCode", label: "Customer part code", kind: "text", owner: "Master Card" },
      { key: "endUser", label: "End user", kind: "text", owner: "Master Card" },
    ],
  },
  {
    title: "AFRF-CS",
    fields: [
      { key: "winding", label: "Printing direction (winding)", kind: "winding", required: true, owner: "AFRF-CS" },
      { key: "afrfMaterial", label: "Material", kind: "text", owner: "AFRF-CS" },
      { key: "afrfColor", label: "Color", kind: "text", owner: "AFRF-CS" },
      { key: "afrfForm", label: "Form", kind: "text", owner: "AFRF-CS" },
      { key: "supplierCode", label: "Supplier code", kind: "text", owner: "AFRF-CS" },
      { key: "printingDirection", label: "Printing direction remark", kind: "text", owner: "AFRF-CS" },
      { key: "afrfDetail", label: "Detail", kind: "long", owner: "AFRF-CS" },
      { key: "packingInstruction", label: "Packing instruction", kind: "long", owner: "AFRF-CS" },
      { key: "specialInstruction", label: "Special instruction", kind: "long", owner: "AFRF-CS" },
      { key: "afrfRemark", label: "Remark", kind: "long", owner: "AFRF-CS" },
    ],
  },
  {
    title: "Die Cut Spec",
    fields: [
      { key: "feedLengthMm", label: "Feed length", unit: "mm", kind: "number", owner: "Die Cut Spec" },
      { key: "feedUps", label: "Feed UPS", kind: "int", owner: "Die Cut Spec" },
      { key: "actualUps", label: "Actual UPS", kind: "int", owner: "Die Cut Spec" },
      { key: "sampleCount", label: "Sample count", kind: "int", owner: "Die Cut Spec" },
    ],
  },
);

export const specValue = (f: SpecField, v: unknown) => {
  if (v === undefined || v === null || v === "") return "—";
  if (f.kind === "winding")
    return WINDINGS.find((w) => w.value === v)?.label ?? String(v);
  return f.unit ? `${v} ${f.unit}` : String(v);
};
