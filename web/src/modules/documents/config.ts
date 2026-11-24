/**
 * Printed documents: what each one can contain (sections, table columns) and
 * its built-in default layout. End users change the layout in Document
 * Templates (System); the server stores only the layout, never a printed copy.
 */
export type DocType = "PJO" | "JOB_ORDER" | "MRS" | "MASTER_CARD" | "IQC_REPORT" | "OQC_REPORT";
export type Accent = "primary" | "neutral" | "success" | "warning" | "danger" | "info";

export interface DocLayout {
  page: { size: "A4" | "A5" | "LETTER"; orientation: "portrait" | "landscape"; marginMm: number; fontSizePt: number; accent: Accent; density: "compact" | "comfortable" };
  header: {
    showLogo: boolean;
    logoAlign: "left" | "right";
    showCompanyName: boolean;
    showAddress: boolean;
    showContact: boolean;
    showRegistration: boolean;
    title: string;
    subtitle: string;
    showDocNo: boolean;
    showDocDate: boolean;
    showBarcode: boolean;
    repeat: "all" | "first";
    divider: boolean;
    extraText: string;
  };
  sections: { key: string; enabled: boolean; title: string; columns?: string[] }[];
  notes: { title: string; text: string };
  signatures: { label: string }[];
  footer: { left: string; center: string; right: string; showPageNumbers: boolean; divider: boolean };
}

export interface SectionDef {
  key: string;
  label: string;
  kind: "fields" | "table" | "text" | "image";
  /** Table columns, in the default order. */
  columns?: { key: string; label: string; align?: "right" | "center"; blank?: boolean }[];
  /** Off by default (the user can turn it on). */
  off?: boolean;
}
export interface DocTypeDef {
  type: DocType;
  label: string;
  title: string;
  hint: string;
  sections: SectionDef[];
  signatures: string[];
  notes?: string;
  /** Print a barcode of the document number by default. */
  barcode?: boolean;
  orientation?: "portrait" | "landscape";
}

const col = (key: string, label: string, align?: "right" | "center", blank?: boolean) => ({ key, label, align, blank });

export const DOC_TYPES: DocTypeDef[] = [
  {
    type: "PJO",
    label: "Production Job Order",
    title: "Production Job Order",
    hint: "Order sheet: order details, product, artwork, Son Codes and its Job Orders.",
    sections: [
      { key: "order", label: "Order details", kind: "fields" },
      { key: "product", label: "Product", kind: "fields" },
      { key: "artwork", label: "Artwork", kind: "image" },
      { key: "components", label: "Son Codes (BOM)", kind: "table", columns: [col("sonCode", "Son Code"), col("materialCode", "Material"), col("description", "Description"), col("quantity", "Qty", "right"), col("uom", "UOM")] },
      { key: "jobOrders", label: "Job Orders", kind: "table", columns: [col("woNo", "Job Order"), col("status", "Status"), col("quantity", "Qty", "right"), col("plannedDate", "Planned"), col("priority", "Priority")] },
      { key: "remarks", label: "Remarks", kind: "text" },
    ],
    signatures: ["Prepared by", "Approved by"],
    barcode: true,
  },
  {
    type: "JOB_ORDER",
    label: "Job Order traveller",
    title: "Job Order",
    hint: "Travels with the job on the floor: barcode, product, artwork and the process route with sign-off columns.",
    sections: [
      { key: "job", label: "Job details", kind: "fields" },
      { key: "product", label: "Product", kind: "fields" },
      { key: "artwork", label: "Artwork", kind: "image" },
      {
        key: "route",
        label: "Process route",
        kind: "table",
        columns: [col("seq", "#", "center"), col("process", "Process"), col("machine", "Machine"), col("target", "Target", "right"), col("good", "Good", "right"), col("reject", "Reject", "right"), col("status", "Status"), col("operator", "Operator", undefined, true), col("date", "Date / time", undefined, true)],
      },
      { key: "remarks", label: "Remarks", kind: "text" },
    ],
    signatures: ["Issued by", "Supervisor", "QC"],
    barcode: true,
    orientation: "landscape",
  },
  {
    type: "MRS",
    label: "Material Requisition Sheet",
    title: "Material Requisition Sheet",
    hint: "Store picking and issue record: lines with requested / issued balances and movements.",
    sections: [
      { key: "details", label: "Requisition", kind: "fields" },
      {
        key: "lines",
        label: "Material lines",
        kind: "table",
        columns: [col("lineNo", "#", "center"), col("sonCode", "Son Code"), col("materialCode", "Material"), col("description", "Description"), col("uom", "UOM"), col("requested", "Requested", "right"), col("issued", "Issued", "right"), col("additional", "Additional", "right"), col("returned", "Returned", "right"), col("rejected", "Rejected", "right"), col("remaining", "To issue", "right"), col("lot", "Lot / roll", undefined, true)],
      },
      { key: "movements", label: "Movements", kind: "table", off: true, columns: [col("txnNo", "Txn"), col("type", "Type"), col("material", "Material"), col("qty", "Qty", "right"), col("lot", "Lot"), col("by", "By"), col("at", "At")] },
      { key: "remarks", label: "Remarks", kind: "text" },
    ],
    signatures: ["Requested by", "Issued by (store)", "Received by"],
    barcode: true,
    orientation: "landscape",
  },
  {
    type: "MASTER_CARD",
    label: "Master Card",
    title: "Master Card",
    hint: "Engineering card: header, AFRF-CS, specification, die cut spec, material spec with QPA, process detail.",
    sections: [
      { key: "header", label: "Header", kind: "fields" },
      { key: "artwork", label: "Artwork", kind: "image" },
      { key: "afrf", label: "AFRF-CS", kind: "fields" },
      { key: "spec", label: "Specification", kind: "fields" },
      { key: "die", label: "Die Cut Spec", kind: "fields" },
      { key: "materials", label: "Material Spec (QPA)", kind: "table", columns: [col("sonCode", "Son Code"), col("materialCode", "Material"), col("description", "Description"), col("uom", "UOM"), col("qpa", "QPA", "right"), col("source", "Source"), col("formula", "Formula")] },
      { key: "process", label: "Process Detail", kind: "table", columns: [col("seq", "#", "center"), col("process", "Process"), col("setup", "Setup (min)", "right"), col("output", "Output / press", "right"), col("prints", "No. of print", "right"), col("speed", "Speed", "right")] },
      { key: "requirements", label: "Customer requirements", kind: "text" },
    ],
    signatures: ["Prepared by", "Checked by", "Approved by"],
  },
  {
    type: "IQC_REPORT",
    label: "IQC inspection report",
    title: "Incoming Inspection Report",
    hint: "Incoming lot: details, check results, defects and disposition.",
    sections: [
      { key: "details", label: "Lot details", kind: "fields" },
      { key: "checks", label: "Check results", kind: "table", columns: [col("no", "#", "center"), col("check", "Check"), col("spec", "Specification"), col("result", "Result", "center"), col("note", "Note")] },
      { key: "defects", label: "Defects", kind: "table", columns: [col("code", "Code"), col("name", "Defect"), col("category", "Category"), col("severity", "Severity"), col("qty", "Qty", "right"), col("remark", "Remark")] },
      { key: "disposition", label: "Disposition", kind: "fields" },
      { key: "remarks", label: "Remarks", kind: "text" },
    ],
    signatures: ["Inspected by", "Approved by (QC)"],
    barcode: true,
  },
  {
    type: "OQC_REPORT",
    label: "OQC inspection report",
    title: "Outgoing Quality Report",
    hint: "Finished lot: Job Order, check results, defects, disposition – usable as a certificate of conformance.",
    sections: [
      { key: "details", label: "Lot details", kind: "fields" },
      { key: "checks", label: "Check results", kind: "table", columns: [col("no", "#", "center"), col("check", "Check"), col("spec", "Specification"), col("result", "Result", "center"), col("note", "Note")] },
      { key: "defects", label: "Defects", kind: "table", columns: [col("code", "Code"), col("name", "Defect"), col("category", "Category"), col("severity", "Severity"), col("qty", "Qty", "right"), col("remark", "Remark")] },
      { key: "disposition", label: "Disposition", kind: "fields" },
      { key: "remarks", label: "Remarks", kind: "text" },
    ],
    signatures: ["Inspected by", "Approved by (QC)"],
    notes: "We certify that the goods above were inspected and conform to the agreed specification unless stated otherwise.",
    barcode: true,
  },
];

export const docTypeDef = (t: DocType) => DOC_TYPES.find((d) => d.type === t)!;

export const FOOTER_TOKENS = ["{docNo}", "{printedBy}", "{printedAt}", "{page}", "{pages}", "{company}"];

export function defaultLayout(t: DocType): DocLayout {
  const d = docTypeDef(t);
  return {
    page: { size: "A4", orientation: d.orientation ?? "portrait", marginMm: 12, fontSizePt: 9, accent: "primary", density: "comfortable" },
    header: {
      showLogo: true,
      logoAlign: "left",
      showCompanyName: true,
      showAddress: true,
      showContact: true,
      showRegistration: false,
      title: d.title,
      subtitle: "",
      showDocNo: true,
      showDocDate: true,
      showBarcode: !!d.barcode,
      repeat: "all",
      divider: true,
      extraText: "",
    },
    sections: d.sections.map((s) => ({ key: s.key, enabled: !s.off, title: s.label, ...(s.columns ? { columns: s.columns.map((c) => c.key) } : {}) })),
    notes: { title: d.notes ? "Declaration" : "", text: d.notes ?? "" },
    signatures: d.signatures.map((label) => ({ label })),
    footer: { left: "{company}", center: "Printed {printedAt} by {printedBy}", right: "", showPageNumbers: true, divider: true },
  };
}

/** A stored layout with any section added since it was saved (appended, off). */
export function normalizeLayout(t: DocType, stored: DocLayout | null | undefined): DocLayout {
  const base = defaultLayout(t);
  if (!stored) return base;
  const known = docTypeDef(t).sections;
  const sections = stored.sections.filter((s) => known.some((k) => k.key === s.key));
  for (const k of known) if (!sections.some((s) => s.key === k.key)) sections.push({ key: k.key, enabled: false, title: k.label, ...(k.columns ? { columns: k.columns.map((c) => c.key) } : {}) });
  return { ...base, ...stored, page: { ...base.page, ...stored.page }, header: { ...base.header, ...stored.header }, footer: { ...base.footer, ...stored.footer }, notes: { ...base.notes, ...stored.notes }, sections };
}

export const PAPER_MM: Record<DocLayout["page"]["size"], [number, number]> = { A4: [210, 297], A5: [148, 210], LETTER: [216, 279] };
export const pageMm = (p: DocLayout["page"]): [number, number] => {
  const [w, h] = PAPER_MM[p.size];
  return p.orientation === "landscape" ? [h, w] : [w, h];
};
