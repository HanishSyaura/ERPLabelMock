import { randomUUID } from "node:crypto";
import sharp from "sharp";
import { beforeEach, describe, expect, it } from "vitest";
import { setupDb } from "./db-helpers";

/** Phase 5: Defect Master, inspection templates, IQC / OQC and shipping labels. */
const t = setupDb();
type Api = Awaited<ReturnType<typeof t.login>>;
const txn = () => randomUUID();

interface World {
  admin: Api;
  insp: Api;
  sup: Api;
  partId: string;
  woId: string;
  woNo: string;
  defects: { scratch: string; colour: string; critical: string };
}
let w: World;

beforeEach(async () => {
  await t.createAdmin();
  const admin = await t.login("admin");
  await t.createUser("insp", ["QC_INSPECTOR"]);
  await t.createUser("qcsup", ["QC_SUPERVISOR"]);

  const stock = (await admin.post("/parts/categories", { code: "LS", name: "Label stock", kind: "LABEL_STOCK" }).expect(201)).body.data.id;
  const part = (await admin.post("/materials", { code: "PP80", description: "PP white 80", uom: "M2", categoryId: stock, supplierName: "Avery" }).expect(201)).body.data.id;
  await admin.post("/qc/inspection-templates", {
    code: "IQC-LS",
    name: "Label stock receiving",
    type: "IQC",
    partCategoryId: stock,
    items: [
      { label: "Roll width", kind: "MEASURE", target: "330", min: 329, max: 331, unit: "mm" },
      { label: "Adhesive tack", kind: "PASS_FAIL" },
      { label: "Core damage", kind: "PASS_FAIL", required: false },
    ],
  }).expect(201);
  await admin.post("/qc/inspection-templates", { code: "OQC-STD", name: "Finished labels", type: "OQC", items: [{ label: "Print vs approved artwork", kind: "PASS_FAIL" }, { label: "Label length", kind: "MEASURE", min: 49.5, max: 50.5, unit: "mm" }] }).expect(201);
  const d = async (code: string, severity: string) => (await admin.post("/qc/defects", { code, name: code, category: "PRINT", severity }).expect(201)).body.data.id as string;

  // A Job Order with 1000 good on its only process.
  const print = (await admin.post("/planning/processes", { code: "PRINT", name: "Printing", sequence: 10 }).expect(201)).body.data.id;
  const cat = (await admin.post("/planning/machine-categories", { code: "FLEXO", name: "Flexo", processIds: [print] }).expect(201)).body.data.id;
  const fx = (await admin.post("/planning/machines", { code: "FX-01", name: "Flexo 1", categoryId: cat }).expect(201)).body.data.id;
  const png = await sharp({ create: { width: 10, height: 10, channels: 3, background: "#00a" } }).png().toBuffer();
  const file = (await admin.upload("l.png", png).expect(201)).body.data.file.id;
  const bomId = (await admin.post("/boms", { fileId: file, labelDescription: "Mango juice front" }).expect(201)).body.data.id;
  const pjo = (await admin.post("/planning/production-job-orders", { bomId, orderQty: 1000, uom: "PCS", customerRef: "PO-77" }).expect(201)).body.data;
  await admin.post(`/planning/production-job-orders/${pjo.id}/release`).expect(200);
  const wo = (await admin.post("/planning/work-orders", { pjoId: pjo.id, quantity: 1000, processIds: [print] }).expect(201)).body.data;
  await admin.post(`/planning/work-orders/${wo.id}/release`).expect(200);
  const s = (await admin.post("/shopfloor/check-in", { machineId: fx, workOrderId: wo.id, clientTxnId: txn() }).expect(201)).body.data.sessionId;
  await admin.post(`/shopfloor/sessions/${s}/check-out`, { type: "COMPLETED", totalGood: 1000, totalReject: 0, clientTxnId: txn() }).expect(200);

  w = {
    admin,
    insp: await t.login("insp"),
    sup: await t.login("qcsup"),
    partId: part,
    woId: wo.id,
    woNo: wo.woNo,
    defects: { scratch: await d("SCR", "MINOR"), colour: await d("CLR", "MAJOR"), critical: await d("MIX", "CRITICAL") },
  };
});

describe("IQC", () => {
  it("checks in a lot with the category template, judges measurements, and needs a supervisor disposition on fail", async () => {
    const lot = (await w.insp.post("/qc/iqc", { materialId: w.partId, lotRef: "R-1001", qty: 5000, deliveryRef: "DO-55" }).expect(201)).body.data;
    expect(lot.inspNo).toMatch(/^IQC-\d{4}-00001$/);
    const dup = await w.insp.post("/qc/iqc", { materialId: w.partId, lotRef: "R-1001", qty: 1 }).expect(422);
    expect(dup.body.issues[0].message).toContain("already in inspection");
    let detail = (await w.insp.get(`/qc/inspections/${lot.id}`).expect(200)).body.data;
    expect(detail).toMatchObject({ status: "IN_INSPECTION", supplierName: "Avery", uom: "M2", template: { code: "IQC-LS" } });
    expect(detail.checks).toHaveLength(3);

    const missing = await w.insp.post(`/qc/inspections/${lot.id}/check-out`, { results: [{ index: 0, value: 330 }] }).expect(422);
    expect(missing.body.issues[0].message).toContain("Adhesive tack");
    // 332 mm is out of 329–331: fail.
    const out = (await w.insp.post(`/qc/inspections/${lot.id}/check-out`, { results: [{ index: 0, value: 332 }, { index: 1, pass: true }], defects: [{ defectCodeId: w.defects.scratch, qty: 2 }] }).expect(200)).body.data;
    expect(out).toEqual({ status: "PENDING_DISPOSITION", result: "FAIL" });
    detail = (await w.insp.get(`/qc/inspections/${lot.id}`).expect(200)).body.data;
    expect(detail.checks[0]).toMatchObject({ value: 332, pass: false });

    // Inspector can't dispose; supervisor can, with a reason; REWORK isn't an IQC option.
    await w.insp.post(`/qc/inspections/${lot.id}/disposition`, { disposition: "USE_AS_IS", note: "ok" }).expect(403);
    await w.sup.post(`/qc/inspections/${lot.id}/disposition`, { disposition: "REWORK", note: "x" }).expect(422);
    await w.sup.post(`/qc/inspections/${lot.id}/disposition`, { disposition: "USE_AS_IS", note: "" }).expect(422);
    expect((await w.sup.post(`/qc/inspections/${lot.id}/disposition`, { disposition: "USE_AS_IS", note: "1 mm over, slitter can trim" }).expect(200)).body.data).toEqual({ status: "ACCEPTED" });

    const list = (await w.insp.get("/qc/iqc?view=closed").expect(200)).body;
    expect(list.data.map((i: { status: string }) => i.status)).toEqual(["ACCEPTED"]);
    const audit = await t.db.auditLog.findMany({ where: { entityType: "qc_inspection" }, orderBy: { id: "asc" } });
    expect(audit.map((a) => a.action)).toEqual(["IQC_CHECKED_IN", "IQC_CHECKED_OUT", "IQC_DISPOSITION"]);
  });
});

describe("OQC and shipping labels", () => {
  it("limits OQC to finished output, reinspects after rework, and labels only released quantity", async () => {
    const cands = (await w.insp.get("/qc/oqc-candidates").expect(200)).body.data;
    expect(cands[0]).toMatchObject({ woNo: w.woNo, finishedQty: "1000", availableQty: "1000" });
    await w.insp.post("/qc/oqc", { workOrderId: w.woId, qty: 1001 }).expect(422);
    const a = (await w.insp.post("/qc/oqc", { workOrderId: w.woId, qty: 600, sampleSize: 50 }).expect(201)).body.data;
    const b = (await w.insp.post("/qc/oqc", { workOrderId: w.woId, qty: 400 }).expect(201)).body.data;
    expect((await w.insp.post("/qc/oqc", { workOrderId: w.woId, qty: 1 }).expect(422)).body.issues[0].message).toContain("no finished output");

    // Lot A passes with 10 rejects? No: any reject fails. Pass clean.
    expect((await w.insp.post(`/qc/inspections/${a.id}/check-out`, { results: [{ index: 0, pass: true }, { index: 1, value: 50 }], defects: [{ defectCodeId: w.defects.scratch, qty: 1 }] }).expect(200)).body.data.result).toBe("PASS");
    // Lot B: critical defect -> fail -> rework -> reinspection passes.
    expect((await w.insp.post(`/qc/inspections/${b.id}/check-out`, { results: [{ index: 0, pass: true }, { index: 1, value: 50 }], defects: [{ defectCodeId: w.defects.critical, qty: 1 }] }).expect(200)).body.data.result).toBe("FAIL");
    await w.insp.post(`/qc/inspections/${b.id}/reinspect`, {}).expect(422);
    await w.sup.post(`/qc/inspections/${b.id}/disposition`, { disposition: "REWORK", note: "Mixed labels: sort the rolls" }).expect(200);
    const b2 = (await w.insp.post(`/qc/inspections/${b.id}/reinspect`, { qty: 380 }).expect(201)).body.data;
    await w.insp.post(`/qc/inspections/${b.id}/reinspect`, {}).expect(422);
    await w.insp.post(`/qc/inspections/${b2.id}/check-out`, { results: [{ index: 0, pass: true }, { index: 1, value: 50.2 }] }).expect(200);
    const b2detail = (await w.insp.get(`/qc/inspections/${b2.id}`).expect(200)).body.data;
    expect(b2detail).toMatchObject({ status: "PASSED", releasedQty: "380", reinspectionOf: { id: b.id } });

    // Labels: 600 released on A, 250 per carton = 3 cartons (250, 250, 100).
    const tpl = (await w.admin.post("/qc/label-templates", { code: "CTN-100", name: "Carton 100 x 75", widthMm: 100, heightMm: 75, fields: ["customerRef", "fatherCode", "woNo", "lotNo", "qty", "cartonNo"], barcode: "CODE128", barcodeField: "labelNo" }).expect(201)).body.data.id;
    const ready = (await w.insp.get("/qc/labels/ready").expect(200)).body.data;
    expect(ready.map((x: { remainingQty: string }) => x.remainingQty).sort()).toEqual(["380", "600"]);
    await w.insp.post("/qc/labels", { inspectionId: a.id, templateId: tpl, totalQty: 601, qtyPerCarton: 250 }).expect(422);
    await w.insp.post("/qc/labels", { inspectionId: b.id, templateId: tpl, totalQty: 10, qtyPerCarton: 10 }).expect(422);
    const gen = (await w.insp.post("/qc/labels", { inspectionId: a.id, templateId: tpl, totalQty: 600, qtyPerCarton: 250 }).expect(201)).body.data;
    expect(gen.cartons).toBe(3);
    const labels = (await w.insp.get(`/qc/inspections/${a.id}`).expect(200)).body.data.labels;
    expect(labels.map((l: { qty: string }) => l.qty)).toEqual(["250", "250", "100"]);
    const listed = (await w.insp.get("/qc/labels").expect(200)).body.data;
    expect(listed[0].data).toMatchObject({ customerRef: "PO-77", woNo: w.woNo, cartonNo: expect.stringMatching(/\/ 3$/) });

    // First print is free; a reprint needs the permission and a reason.
    await w.insp.post("/qc/labels/print", { ids: gen.ids }).expect(200);
    await w.insp.post("/qc/labels/print", { ids: [gen.ids[0]] }).expect(403);
    await w.sup.post("/qc/labels/print", { ids: [gen.ids[0]] }).expect(422);
    expect((await w.sup.post("/qc/labels/print", { ids: [gen.ids[0]], reason: "Carton label torn" }).expect(200)).body.data).toEqual({ printed: 1, reprinted: 1 });

    // Voiding frees the quantity for relabelling.
    await w.insp.post(`/qc/labels/${gen.ids[2]}/void`, { reason: "Wrong carton count" }).expect(200);
    await w.insp.post("/qc/labels/print", { ids: [gen.ids[2]] }).expect(422);
    const again = (await w.insp.get("/qc/labels/ready").expect(200)).body.data.find((x: { id: string }) => x.id === a.id);
    expect(again.remainingQty).toBe("100");
  });
});

describe("QC masters", () => {
  it("validates templates and keeps defect scope", async () => {
    const bad = await w.admin.post("/qc/inspection-templates", { code: "X", name: "x", type: "OQC", items: [{ label: "Length", kind: "MEASURE" }] }).expect(422);
    expect(bad.body.issues[0].path).toContain("min");
    await w.admin.post("/qc/defects", { code: "N", name: "n", category: "OTHER", appliesIqc: false, appliesOqc: false }).expect(422);
    const iqcOnly = (await w.admin.post("/qc/defects", { code: "WET", name: "Wet roll", category: "MATERIAL", appliesOqc: false }).expect(201)).body.data.id;
    const oqcList = (await w.insp.get("/qc/defects?type=OQC").expect(200)).body.data;
    expect(oqcList.find((d: { id: string }) => d.id === iqcOnly)).toBeUndefined();
    const lot = (await w.insp.post("/qc/oqc", { workOrderId: w.woId, qty: 10 }).expect(201)).body.data;
    const wrong = await w.insp.post(`/qc/inspections/${lot.id}/check-out`, { results: [{ index: 0, pass: true }, { index: 1, value: 50 }], defects: [{ defectCodeId: iqcOnly, qty: 1 }] }).expect(422);
    expect(wrong.body.issues[0].path).toBe("defects.0.defectCodeId");
    await w.insp.post("/qc/defects", { code: "Z", name: "z", category: "OTHER" }).expect(403);
  });
});
