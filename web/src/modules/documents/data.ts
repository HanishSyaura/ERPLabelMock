import { statusLabel } from "@/components/status";
import { api } from "@/lib/api";
import { formatDate, formatDateTime, humanize } from "@/lib/utils";
import { fileUrl, thumbUrl, type FileInfo } from "@/modules/bom/api";
import type { ProductDetail } from "@/modules/bom/product-api";
import type { PjoDetail, WoView } from "@/modules/planning/api";
import type { MrsDetail } from "@/modules/planning/ops-api";
import { DEFECT_CATEGORY_LABEL, DISPOSITION_LABEL, type InspectionDetail } from "@/modules/qc/api";
import type { DocType } from "./config";

/**
 * Document content: each section's block, built on demand from the same
 * detail endpoints the screens use. Nothing here is stored.
 */
export type Block =
  | { kind: "fields"; items: { label: string; value: string }[] }
  | { kind: "table"; rows: Record<string, string>[] }
  | { kind: "text"; text: string }
  | { kind: "image"; src: string | null; caption: string };
export interface DocData {
  docNo: string;
  docDate: string;
  barcode?: string;
  blocks: Record<string, Block | undefined>;
}

const n = (v: string | number | null | undefined, unit?: string | null) => (v === null || v === undefined || v === "" ? "—" : `${Number(v).toLocaleString(undefined, { maximumFractionDigits: 4 })}${unit ? ` ${unit}` : ""}`);
const t = (v: string | number | null | undefined) => (v === null || v === undefined || v === "" ? "—" : String(v));
const rev = (r: number | null | undefined) => (r == null ? "—" : `Rev ${String(r).padStart(2, "0")}`);
const fields = (items: [string, string][]): Block => ({ kind: "fields", items: items.map(([label, value]) => ({ label, value })) });
const art = (file: FileInfo | null | undefined, caption: string): Block => ({
  kind: "image",
  src: file ? (file.hasThumbnail ? thumbUrl(file.id) : file.previewKind === "image" ? fileUrl(file.id) : null) : null,
  caption,
});
const text = (v: string | null | undefined): Block | undefined => (v?.trim() ? { kind: "text", text: v } : undefined);

export async function loadDocument(type: DocType, id: string): Promise<DocData> {
  switch (type) {
    case "PJO": {
      const p = await api.get<PjoDetail>(`/planning/production-job-orders/${id}`);
      return {
        docNo: p.pjoNo,
        docDate: formatDate(p.releasedAt ?? p.createdAt),
        barcode: p.pjoNo,
        blocks: {
          order: fields([
            ["PJO No.", p.pjoNo],
            ["Status", statusLabel("pjo", p.status)],
            ["Customer ref.", t(p.customerRef)],
            ["Product ref.", t(p.productRef)],
            ["Order quantity", n(p.orderQty, p.uom)],
            ["Allocated to Job Orders", n(p.allocatedQty, p.uom)],
            ["Required date", formatDate(p.requiredDate)],
            ["Priority", statusLabel("priority", p.priority)],
            ["Master Card", p.masterCard ? `${p.masterCard.productCode} ${rev(p.masterCard.revisionNo)}` : "—"],
            ["Released", formatDateTime(p.releasedAt)],
          ]),
          product: fields([
            ["Father Code", p.bom.fatherCode],
            ["Label description", p.bom.labelDescription],
            ["Artwork", rev(p.bom.artworkRevision)],
            ["Son Codes", rev(p.bom.componentRevision)],
            ["Product", p.product ? `${p.product.productCode} – ${p.product.name}` : "—"],
          ]),
          artwork: art(p.bom.artworkFile, `${p.bom.fatherCode} · Artwork ${rev(p.bom.artworkRevision)}`),
          components: { kind: "table", rows: p.bom.components.map((c) => ({ sonCode: c.sonCode, materialCode: c.materialCode, description: c.materialDescription, quantity: n(c.quantity), uom: t(c.uom) })) },
          jobOrders: { kind: "table", rows: p.workOrders.map((w) => ({ woNo: w.woNo, status: statusLabel("wo", w.status), quantity: n(w.quantity, p.uom), plannedDate: formatDate(w.plannedDate), priority: statusLabel("priority", w.priority) })) },
          remarks: text(p.remarks),
        },
      };
    }
    case "JOB_ORDER": {
      const w = await api.get<WoView>(`/planning/work-orders/${id}`);
      return {
        docNo: w.woNo,
        docDate: formatDate(w.releasedAt ?? w.plannedDate),
        barcode: w.woNo,
        blocks: {
          job: fields([
            ["Job Order", w.woNo],
            ["Status", statusLabel("wo", w.status)],
            ["Quantity", n(w.quantity, w.uom)],
            ["Planned date", formatDate(w.plannedDate)],
            ["Priority", statusLabel("priority", w.priority)],
            ["Production Job Order", w.pjo.pjoNo],
            ["Customer ref.", t(w.pjo.customerRef)],
            ["Released", formatDateTime(w.releasedAt)],
          ]),
          product: fields([
            ["Father Code", w.pjo.fatherCode],
            ["Label description", w.pjo.labelDescription],
            ["Artwork", rev(w.pjo.artworkRevision)],
            ["Son Codes", rev(w.pjo.componentRevision)],
          ]),
          artwork: art(w.pjo.artworkFile, `${w.pjo.fatherCode} · Artwork ${rev(w.pjo.artworkRevision)}`),
          route: {
            kind: "table",
            rows: w.processes.map((p) => ({
              seq: String(p.seq),
              process: p.process.name,
              machine: p.assignedMachine?.code ?? "",
              target: n(p.quantities.target),
              good: Number(p.quantities.good) ? n(p.quantities.good) : "",
              reject: Number(p.quantities.reject) ? n(p.quantities.reject) : "",
              status: statusLabel("process", p.status),
              operator: "",
              date: "",
            })),
          },
          remarks: text([w.remarks, w.holdReason ? `On hold: ${w.holdReason}` : null].filter(Boolean).join("\n")),
        },
      };
    }
    case "MRS": {
      const m = await api.get<MrsDetail>(`/material/requisitions/${id}`);
      return {
        docNo: m.mrsNo,
        docDate: formatDate(m.createdAt),
        barcode: m.mrsNo,
        blocks: {
          details: fields([
            ["MRS No.", m.mrsNo],
            ["Status", statusLabel("mrs", m.status)],
            ["Job Order", `${m.workOrder.woNo} (${n(m.workOrder.quantity, m.workOrder.uom)})`],
            ["Production Job Order", m.pjo.pjoNo],
            ["Father Code", m.pjo.fatherCode],
            ["Label description", m.pjo.labelDescription],
            ["Raised", `${formatDateTime(m.createdAt)}${m.createdBy ? ` by ${m.createdBy}` : ""}`],
            ["Route", m.workOrder.processes.map((p) => p.name).join(" → ") || "—"],
          ]),
          lines: {
            kind: "table",
            rows: m.lines.map((l) => ({
              lineNo: String(l.lineNo),
              sonCode: t(l.sonCode),
              materialCode: l.materialCode,
              description: l.materialDescription,
              uom: l.uom,
              requested: n(l.requested),
              issued: n(l.issued),
              additional: Number(l.additional) ? n(l.additional) : "",
              returned: Number(l.returned) ? n(l.returned) : "",
              rejected: Number(l.rejected) ? n(l.rejected) : "",
              remaining: n(l.remainingToIssue),
              lot: "",
            })),
          },
          movements: { kind: "table", rows: m.transactions.map((x) => ({ txnNo: x.txnNo, type: humanize(x.type), material: t(x.materialCode), qty: n(x.qty, x.uom), lot: t(x.lotRef), by: t(x.by), at: formatDateTime(x.at) })) },
          remarks: text(m.remarks),
        },
      };
    }
    case "MASTER_CARD": {
      const p = await api.get<ProductDetail>(`/products/${id}`);
      const c = p.released ?? p.draft;
      const s = c?.spec ?? {};
      return {
        docNo: `${p.productCode} ${rev(c?.revisionNo)}`,
        docDate: formatDate(c?.releasedAt ?? c?.createdAt),
        barcode: p.productCode,
        blocks: {
          header: fields([
            ["Product code", p.productCode],
            ["Description", p.name],
            ["Part code", p.part.code],
            ["NMI No.", t(p.part.nmiNo)],
            ["Customer code", t(s.customerCode)],
            ["Customer part code", t(s.customerPartCode)],
            ["End user", t(s.endUser)],
            ["Father Code", `${p.fatherCode.fatherCode} · Artwork ${rev(c?.artwork.revisionNo)}`],
            ["Card", c ? `${rev(c.revisionNo)} · ${statusLabel("card", c.status)}` : "No card yet"],
            ["Prepared", c ? `${t(c.createdBy)} · ${formatDate(c.createdAt)}` : "—"],
            ["Approved", c?.releasedAt ? `${t(c.releasedBy)} · ${formatDate(c.releasedAt)}` : "Not released"],
          ]),
          artwork: art(c?.artwork.file ?? p.artworkFile, `${p.fatherCode.fatherCode} · ${c?.artwork.labelDescription ?? p.fatherCode.labelDescription}`),
          afrf: fields([
            ["Material", t(s.afrfMaterial)],
            ["Color", t(s.afrfColor)],
            ["Form", t(s.afrfForm)],
            ["Supplier code", t(s.supplierCode)],
            ["Printing direction", s.winding ? `Position ${s.winding}${s.printingDirection ? ` – ${s.printingDirection}` : ""}` : t(s.printingDirection)],
            ["Packing instruction", t(s.packingInstruction)],
            ["Detail", t(s.afrfDetail)],
            ["Special instruction", t(s.specialInstruction)],
            ["Remark", t(s.afrfRemark)],
          ]),
          spec: fields([
            ["Label size (W × H)", s.labelWidthMm ? `${s.labelWidthMm} × ${s.labelHeightMm ?? "—"} mm` : "—"],
            ["Shape", t(s.shape)],
            ["Corner radius", n(s.cornerRadiusMm, "mm")],
            ["Across", t(s.across)],
            ["Gap across / around", s.gapAcrossMm != null || s.gapAroundMm != null ? `${t(s.gapAcrossMm)} / ${t(s.gapAroundMm)} mm` : "—"],
            ["Core", n(s.coreMm, "mm")],
            ["Labels per roll", n(s.labelsPerRoll)],
            ["Max roll diameter", n(s.maxRollDiameterMm, "mm")],
            ["Rolls per carton", n(s.rollsPerCarton)],
            ["Print method", t(s.printMethod)],
            ["Colours", t(s.colours)],
            ["Varnish", t(s.varnish)],
            ["Finishing", t(s.finishing)],
            ["Die / plate ref.", [s.dieRef, s.plateRef].filter(Boolean).join(" / ") || "—"],
          ]),
          die: fields([
            ["Die cut code", c?.die ? `${c.die.code} – ${c.die.description}` : "—"],
            ["Across × around", c?.die ? `${c.die.across} × ${c.die.around}` : "—"],
            ["Feed length", n(c?.dieSpec.feedLengthMm, "mm")],
            ["Feed UPS", t(c?.dieSpec.feedUps)],
            ["Actual UPS", t(c?.dieSpec.actualUps)],
            ["Sample count", t(s.sampleCount)],
          ]),
          materials: { kind: "table", rows: (c?.qpa ?? []).map((l) => ({ sonCode: l.sonCode, materialCode: l.materialCode, description: l.materialDescription, uom: l.uom, qpa: l.qpa == null ? "—" : String(l.qpa), source: humanize(l.source), formula: l.formula })) },
          process: {
            kind: "table",
            rows: (c?.routine?.stepDetail ?? []).map((st) => {
              const d = s.processDetail?.find((x) => x.seq === st.seq);
              return { seq: String(st.seq), process: st.process, setup: n(d?.setupMins), output: n(d?.outputPerPress), prints: n(d?.noOfPrint), speed: d?.speed != null ? `${d.speed} ${d.speedUom ?? ""}` : "—" };
            }),
          },
          requirements: text(s.customerRequirements),
        },
      };
    }
    case "IQC_REPORT":
    case "OQC_REPORT": {
      const i = await api.get<InspectionDetail>(`/qc/inspections/${id}`);
      const iqc = i.type === "IQC";
      return {
        docNo: i.inspNo,
        docDate: formatDate(i.checkedOutAt ?? i.checkedInAt),
        barcode: i.inspNo,
        blocks: {
          details: fields([
            ["Inspection No.", i.inspNo],
            ["Status", statusLabel("qc", i.status)],
            ["Result", i.result ?? "Pending"],
            ...(iqc
              ? ([
                  ["Part", i.part ? `${i.part.code} – ${i.part.description}` : "—"],
                  ["Lot / roll", t(i.lotRef)],
                  ["Supplier", t(i.supplierName)],
                  ["DO / delivery ref.", t(i.deliveryRef)],
                ] as [string, string][])
              : ([
                  ["Job Order", i.workOrder ? `${i.workOrder.woNo} (${i.workOrder.pjoNo})` : "—"],
                  ["Father Code", i.workOrder ? `${i.workOrder.fatherCode} – ${i.workOrder.labelDescription}` : "—"],
                  ["Customer ref.", t(i.workOrder?.customerRef)],
                ] as [string, string][])),
            ["Lot quantity", n(i.qty, i.uom)],
            ["Sample size", n(i.sampleSize, i.uom)],
            ["Good / reject", `${n(i.goodQty)} / ${n(i.rejectQty)} ${i.uom}`],
            ["Template", i.template ? `${i.template.code} – ${i.template.name}` : "—"],
            ["Checked in", `${formatDateTime(i.checkedInAt)}${i.checkedInBy ? ` · ${i.checkedInBy}` : ""}`],
            ["Checked out", i.checkedOutAt ? `${formatDateTime(i.checkedOutAt)}${i.checkedOutBy ? ` · ${i.checkedOutBy}` : ""}` : "—"],
          ]),
          checks: {
            kind: "table",
            rows: i.checks.map((c, k) => ({
              no: String(k + 1),
              check: c.label,
              spec: [c.target, c.min != null ? `min ${c.min}` : null, c.max != null ? `max ${c.max}` : null].filter(Boolean).join(" · ") + (c.unit ? ` ${c.unit}` : "") || "—",
              result: c.kind === "MEASURE" ? `${c.value ?? "—"}${c.pass === false ? " (OUT)" : ""}` : c.pass == null ? "—" : c.pass ? "Pass" : "Fail",
              note: t(c.note),
            })),
          },
          defects: { kind: "table", rows: i.defects.map((d) => ({ code: d.code, name: d.name, category: DEFECT_CATEGORY_LABEL[d.category], severity: humanize(d.severity), qty: n(d.qty), remark: t(d.remark) })) },
          disposition: fields([
            ["Disposition", i.disposition ? DISPOSITION_LABEL[i.disposition] : i.status === "PENDING_DISPOSITION" ? "Pending" : "Not required"],
            ["Reason", t(i.dispositionNote)],
            ["Decided", i.dispositionAt ? `${formatDateTime(i.dispositionAt)}${i.dispositionBy ? ` · ${i.dispositionBy}` : ""}` : "—"],
          ]),
          remarks: text(i.remarks),
        },
      };
    }
  }
}

/** Sample content for the template designer preview (clearly marked as a sample). */
export function sampleDocument(type: DocType): DocData {
  const rows = (n: number, f: (i: number) => Record<string, string>) => Array.from({ length: n }, (_, i) => f(i));
  const base = { docDate: formatDate(new Date()), barcode: "SAMPLE-0001" };
  const f = (items: string[]) => fields(items.map((l, i) => [l, `Sample ${i + 1}`] as [string, string]));
  const img: Block = { kind: "image", src: null, caption: "Artwork appears here" };
  const remarks: Block = { kind: "text", text: "Sample remarks text from the record." };
  switch (type) {
    case "PJO":
      return { ...base, docNo: "PJO-SAMPLE", blocks: { order: f(["PJO No.", "Status", "Customer ref.", "Order quantity", "Required date", "Priority"]), product: f(["Father Code", "Label description", "Artwork", "Son Codes"]), artwork: img, components: { kind: "table", rows: rows(4, (i) => ({ sonCode: `FC-0${i + 1}`, materialCode: `MAT-${100 + i}`, description: "Sample material", quantity: "1", uom: "M2" })) }, jobOrders: { kind: "table", rows: rows(3, (i) => ({ woNo: `WO-00${i + 1}`, status: "Released", quantity: "10,000 PCS", plannedDate: base.docDate, priority: "Normal" })) }, remarks } };
    case "JOB_ORDER":
      return { ...base, docNo: "WO-SAMPLE", blocks: { job: f(["Job Order", "Status", "Quantity", "Planned date", "Production Job Order"]), product: f(["Father Code", "Label description", "Artwork"]), artwork: img, route: { kind: "table", rows: ["Printing", "Lamination", "Die cutting", "Slitting", "Packing"].map((p, i) => ({ seq: String(i + 1), process: p, machine: `M-0${i + 1}`, target: "10,000", good: "", reject: "", status: "Pending", operator: "", date: "" })) }, remarks } };
    case "MRS":
      return { ...base, docNo: "MRS-SAMPLE", blocks: { details: f(["MRS No.", "Status", "Job Order", "Production Job Order", "Father Code"]), lines: { kind: "table", rows: rows(5, (i) => ({ lineNo: String(i + 1), sonCode: `FC-0${i + 1}`, materialCode: `MAT-${100 + i}`, description: "Sample material", uom: "M2", requested: "120", issued: "100", additional: "", returned: "", rejected: "", remaining: "20", lot: "" })) }, movements: { kind: "table", rows: rows(3, (i) => ({ txnNo: `TX-${i + 1}`, type: "Issue", material: `MAT-${100 + i}`, qty: "50 M2", lot: `LOT-${i + 1}`, by: "Store", at: base.docDate })) }, remarks } };
    case "MASTER_CARD":
      return { ...base, docNo: "FG-SAMPLE Rev 01", blocks: { header: f(["Product code", "Description", "Part code", "NMI No.", "Customer code", "End user", "Card"]), artwork: img, afrf: f(["Material", "Color", "Form", "Printing direction", "Packing instruction"]), spec: f(["Label size (W × H)", "Shape", "Across", "Core", "Labels per roll", "Print method", "Colours"]), die: f(["Die cut code", "Feed length", "Feed UPS", "Actual UPS"]), materials: { kind: "table", rows: rows(3, (i) => ({ sonCode: `FC-0${i + 1}`, materialCode: `MAT-${100 + i}`, description: "Sample material", uom: "M2", qpa: "0.0140", source: "Calculated", formula: "width × feed ÷ UPS ÷ 1e6" })) }, process: { kind: "table", rows: rows(3, (i) => ({ seq: String(i + 1), process: ["Printing", "Die cutting", "Slitting"][i]!, setup: "30", output: "6", prints: "4", speed: "60 m/min" })) }, requirements: remarks } };
    default:
      return { ...base, docNo: "QC-SAMPLE", blocks: { details: f(["Inspection No.", "Status", "Result", "Lot quantity", "Sample size", "Good / reject", "Checked in"]), checks: { kind: "table", rows: rows(4, (i) => ({ no: String(i + 1), check: `Sample check ${i + 1}`, spec: "min 1 · max 2 mm", result: i === 2 ? "Fail" : "Pass", note: "" })) }, defects: { kind: "table", rows: [{ code: "PR-01", name: "Ink smear", category: "Print", severity: "Minor", qty: "3", remark: "" }] }, disposition: f(["Disposition", "Reason", "Decided"]), remarks } };
  }
}
