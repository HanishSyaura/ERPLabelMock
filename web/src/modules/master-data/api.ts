import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, qs } from "@/lib/api";
import type { FileInfo } from "@/modules/bom/api";

/** Part Category / Part Group / Part Master specs / Die Cut Master. */

export type RecordStatus = "ACTIVE" | "INACTIVE";
export type PartKind = "LABEL_STOCK" | "FILM" | "PAPER" | "LAMINATE" | "ADHESIVE" | "INK" | "VARNISH" | "FOIL" | "RIBBON" | "CORE" | "PLATE" | "PACKAGING" | "OTHER";

export const PART_KIND_LABEL: Record<PartKind, string> = {
  LABEL_STOCK: "Label stock (self-adhesive)",
  FILM: "Face film",
  PAPER: "Face paper",
  LAMINATE: "Over-laminate",
  ADHESIVE: "Adhesive / glue",
  INK: "Ink",
  VARNISH: "Varnish / coating",
  FOIL: "Hot / cold foil",
  RIBBON: "Thermal transfer ribbon",
  CORE: "Core",
  PLATE: "Printing plate",
  PACKAGING: "Packaging",
  OTHER: "Other",
};

export interface PartCategory {
  id: string;
  code: string;
  name: string;
  kind: PartKind;
  description: string | null;
  status: RecordStatus;
  groupCount: number;
  partCount: number;
}
export interface PartGroup {
  id: string;
  code: string;
  name: string;
  categoryId: string;
  description: string | null;
  status: RecordStatus;
  category: { id: string; code: string; name: string; kind: PartKind; status: RecordStatus };
  partCount: number;
}

/** Spec fields on a part; which ones show depends on the category kind. */
export type SpecKey =
  | "stockForm"
  | "widthMm"
  | "lengthM"
  | "thicknessMicron"
  | "gsm"
  | "faceFinish"
  | "adhesive"
  | "liner"
  | "coreIdMm"
  | "colour"
  | "system"
  | "shelfLifeDays"
  | "certifications";

export type PartType = "RAW_MATERIAL" | "FINISHED_GOOD" | "SEMI_FINISHED" | "PACKAGING" | "CONSUMABLE";
export const PART_TYPE_LABEL: Record<PartType, string> = { RAW_MATERIAL: "Raw material", FINISHED_GOOD: "Finished good", SEMI_FINISHED: "Semi-finished", PACKAGING: "Packaging", CONSUMABLE: "Consumable" };

export interface Part {
  id: string;
  code: string;
  description: string;
  uom: string;
  partType: PartType;
  bomId: string | null;
  bom: { id: string; fatherCode: string; labelDescription: string } | null;
  product: { id: string; currentCardRevNo: number } | null;
  nmiNo: string | null;
  specification: string | null;
  source: string | null;
  revisionNo: number;
  revisedAt: string | null;
  pcsPerRoll: string | null;
  packQty: string | null;
  cartonsPerPallet: number | null;
  materialType: string | null;
  measureHMm: string | null;
  measureWMm: string | null;
  measureLMm: string | null;
  decisionCost: string | null;
  tariffCode: string | null;
  reorderLevel: string | null;
  reorderQty: string | null;
  maxQty: string | null;
  leadTimeDays: number | null;
  overReceivePct: number | null;
  customCode: string | null;
  obsolete: boolean;
  obsoleteAt: string | null;
  obsoleteBy: string | null;
  requireIqc: boolean;
  controlPoint: string | null;
  imageFileId: string | null;
  image: FileInfo | null;
  updatedAt: string;
  updatedBy: string | null;
  stockQty?: string;
  holdQty?: string;
  categoryId: string | null;
  groupId: string | null;
  category: { id: string; code: string; name: string; kind: PartKind; status: RecordStatus } | null;
  group: { id: string; code: string; name: string; status: RecordStatus } | null;
  stockForm: "ROLL" | "SHEET" | "FANFOLD" | "UNIT" | null;
  widthMm: string | null;
  lengthM: string | null;
  thicknessMicron: string | null;
  gsm: string | null;
  faceFinish: string | null;
  adhesive: string | null;
  liner: string | null;
  coreIdMm: string | null;
  colour: string | null;
  system: string | null;
  supplierName: string | null;
  supplierPartNo: string | null;
  shelfLifeDays: number | null;
  certifications: string | null;
  remarks: string | null;
  status: RecordStatus;
  activeSonCodes: number;
}
export interface PartDetail extends Part {
  uomConversions: { id: string; uom: string; factor: string; remark: string | null }[];
  locations: { id: string; warehouseCode: string; locationCode: string; shelfLocation: string | null; lotNo: string | null; doHoldQty: string; qty: string; updatedAt: string; updatedBy: string | null }[];
}

const ALL_SPECS: SpecKey[] = ["stockForm", "widthMm", "lengthM", "thicknessMicron", "gsm", "faceFinish", "adhesive", "liner", "coreIdMm", "colour", "system", "shelfLifeDays", "certifications"];

/** Spec fields each kind shows (no category / Other = all). */
export const PART_KIND_FIELDS: Record<PartKind, SpecKey[]> = {
  LABEL_STOCK: ["stockForm", "widthMm", "lengthM", "thicknessMicron", "gsm", "faceFinish", "adhesive", "liner", "coreIdMm", "certifications"],
  FILM: ["stockForm", "widthMm", "lengthM", "thicknessMicron", "faceFinish", "coreIdMm", "certifications"],
  PAPER: ["stockForm", "widthMm", "lengthM", "gsm", "faceFinish", "coreIdMm", "certifications"],
  LAMINATE: ["stockForm", "widthMm", "lengthM", "thicknessMicron", "faceFinish", "adhesive", "liner", "coreIdMm"],
  ADHESIVE: ["adhesive", "system", "shelfLifeDays", "certifications"],
  INK: ["colour", "system", "shelfLifeDays", "certifications"],
  VARNISH: ["faceFinish", "system", "shelfLifeDays", "certifications"],
  FOIL: ["widthMm", "lengthM", "colour", "faceFinish", "coreIdMm"],
  RIBBON: ["widthMm", "lengthM", "colour", "system", "coreIdMm"],
  CORE: ["coreIdMm", "widthMm"],
  PLATE: ["thicknessMicron", "system"],
  PACKAGING: ["widthMm"],
  OTHER: ALL_SPECS,
};
export const specFieldsFor = (kind: PartKind | null | undefined) => (kind ? PART_KIND_FIELDS[kind] : ALL_SPECS);

/** Field label (some depend on the kind) and typical values offered as suggestions. */
export function specMeta(key: SpecKey, kind: PartKind | null | undefined): { label: string; unit?: string; suggestions?: string[] } {
  switch (key) {
    case "stockForm":
      return { label: "Stock form" };
    case "widthMm":
      return { label: kind === "CORE" ? "Core length" : "Width", unit: "mm" };
    case "lengthM":
      return { label: "Roll length", unit: "m" };
    case "thicknessMicron":
      return { label: kind === "PLATE" ? "Plate thickness" : "Thickness (caliper)", unit: "µm" };
    case "gsm":
      return { label: "Basis weight", unit: "gsm" };
    case "faceFinish":
      return {
        label: kind === "VARNISH" || kind === "FOIL" || kind === "LAMINATE" ? "Finish" : "Face material / finish",
        suggestions: kind === "VARNISH" || kind === "LAMINATE" ? ["Gloss", "Matt", "Soft touch", "Satin"] : kind === "FOIL" ? ["Gold", "Silver", "Holographic", "Matt gold"] : ["White gloss PP", "Clear PP", "White PE", "Silver PET", "Semi-gloss paper", "Vellum", "Direct thermal", "Thermal top"],
      };
    case "adhesive":
      return { label: "Adhesive", suggestions: ["Permanent acrylic", "Permanent hotmelt", "Removable", "Freezer grade", "High tack", "Wash-off"] };
    case "liner":
      return { label: "Liner (backing)", suggestions: ["Glassine 60 gsm", "Glassine 80 gsm", "PET 23 µm", "PET 30 µm", "Kraft"] };
    case "coreIdMm":
      return { label: "Core inner diameter", unit: "mm", suggestions: ["25", "40", "76", "152"] };
    case "colour":
      return { label: "Colour / Pantone" };
    case "system":
      return kind === "RIBBON"
        ? { label: "Ribbon type", suggestions: ["Wax", "Wax-resin", "Resin"] }
        : kind === "PLATE"
          ? { label: "Plate type", suggestions: ["Flexo photopolymer", "Letterpress", "Digital flexo"] }
          : kind === "ADHESIVE"
            ? { label: "Adhesive system", suggestions: ["Hotmelt", "Water-based", "UV"] }
            : { label: kind === "VARNISH" ? "Curing system" : "Ink system", suggestions: ["UV", "LED-UV", "Water-based", "Solvent", "EB"] };
    case "shelfLifeDays":
      return { label: "Shelf life", unit: "days" };
    case "certifications":
      return { label: "Certifications", suggestions: ["FSC", "FDA food contact", "Low migration", "UL / CSA", "BS 5609"] };
  }
}

/** One-line spec summary for lists: "330 mm × 1000 m · 80 µm · Permanent acrylic". */
export function specSummary(p: Part) {
  const size = [p.widthMm && `${p.widthMm} mm`, p.lengthM && `${p.lengthM} m`].filter(Boolean).join(" × ");
  return [size, p.thicknessMicron && `${p.thicknessMicron} µm`, p.gsm && `${p.gsm} gsm`, p.faceFinish, p.adhesive, p.colour, p.system].filter(Boolean).join(" · ");
}

export type DieType = "ROTARY_SOLID" | "FLEXIBLE" | "FLATBED";
export type DieShape = "RECTANGLE" | "ROUNDED_RECTANGLE" | "CIRCLE" | "OVAL" | "SPECIAL";
export type DieCutType = "KISS_CUT" | "THROUGH_CUT" | "PERFORATION";
export type DieCondition = "GOOD" | "WORN" | "DAMAGED";
export const DIE_TYPE_LABEL: Record<DieType, string> = { ROTARY_SOLID: "Rotary solid", FLEXIBLE: "Flexible (magnetic cylinder)", FLATBED: "Flatbed" };
export const DIE_SHAPE_LABEL: Record<DieShape, string> = { RECTANGLE: "Rectangle", ROUNDED_RECTANGLE: "Rounded rectangle", CIRCLE: "Circle", OVAL: "Oval", SPECIAL: "Special shape" };
export const DIE_CUT_LABEL: Record<DieCutType, string> = { KISS_CUT: "Kiss cut (face only)", THROUGH_CUT: "Through cut", PERFORATION: "Perforation" };
export const DIE_CONDITION_LABEL: Record<DieCondition, string> = { GOOD: "Good", WORN: "Worn", DAMAGED: "Damaged" };
/** 1/8" circular pitch: one gear tooth = 3.175 mm of repeat (same as the server). */
export const TOOTH_PITCH_MM = 3.175;

export interface DieCut {
  id: string;
  code: string;
  description: string;
  dieType: DieType;
  cutType: DieCutType;
  shape: DieShape;
  labelWidthMm: string;
  labelHeightMm: string;
  cornerRadiusMm: string | null;
  across: number;
  around: number;
  gapAcrossMm: string | null;
  gapAroundMm: string | null;
  gearTeeth: number | null;
  repeatMm: string | null;
  condition: DieCondition;
  location: string | null;
  supplierName: string | null;
  remarks: string | null;
  status: RecordStatus;
  updatedAt: string;
}

export const usePartCategories = (status?: RecordStatus) =>
  useQuery({ queryKey: ["parts", "categories", status], queryFn: () => api.get<PartCategory[]>(`/parts/categories${qs({ status })}`) });
export const usePartGroups = (p: { categoryId?: string; status?: RecordStatus } = {}) =>
  useQuery({ queryKey: ["parts", "groups", p], queryFn: () => api.get<PartGroup[]>(`/parts/groups${qs(p)}`) });
export const usePart = (id: string) => useQuery({ queryKey: ["materials", "detail", id], queryFn: () => api.get<PartDetail>(`/materials/${id}`) });
export const useParts = (p: { page: number; q?: string; status?: string; partType?: string; categoryId?: string; groupId?: string }) =>
  useQuery({ queryKey: ["materials", p], queryFn: () => api.list<Part>(`/materials${qs(p)}`), placeholderData: (prev) => prev });
export const useDieCuts = (p: { page: number; q?: string; status?: string; dieType?: string; width?: string; height?: string }) =>
  useQuery({ queryKey: ["die-cuts", p], queryFn: () => api.list<DieCut>(`/die-cuts${qs(p)}`), placeholderData: (prev) => prev });

/** Mutation that refreshes the master data lists afterwards. */
export function useMasterMutation<V, R = unknown>(fn: (v: V) => Promise<R>) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: fn,
    onSuccess: () => Promise.all([qc.invalidateQueries({ queryKey: ["parts"] }), qc.invalidateQueries({ queryKey: ["materials"] }), qc.invalidateQueries({ queryKey: ["die-cuts"] })]),
  });
}
