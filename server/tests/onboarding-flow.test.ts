import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { setupDb } from "./db-helpers";

/** The Product onboarding and New PJO journeys: the same API calls, in the same order. */
const t = setupDb();

describe("guided journeys", () => {
  it("onboards a product (artwork → Son Codes → part → Master Card → release) and creates an order with Job Orders and MRS", async () => {
    await t.createAdmin();
    const a = await t.login("admin");
    const ls = (await a.post("/parts/categories", { code: "LS", name: "Label stock", kind: "LABEL_STOCK" }).expect(201)).body.data.id;
    const core = (await a.post("/parts/categories", { code: "CORE", name: "Core", kind: "CORE" }).expect(201)).body.data.id;
    const pp = (await a.post("/materials", { code: "PP330", description: "PP 330", uom: "M2", categoryId: ls, widthMm: 330 }).expect(201)).body.data.id;
    const cr = (await a.post("/materials", { code: "CORE76", description: "Core", uom: "PCS", categoryId: core }).expect(201)).body.data.id;
    const print = (await a.post("/planning/processes", { code: "PRINT", name: "Printing", sequence: 10 }).expect(201)).body.data.id;
    const rt = (await a.post("/shopfloor/routines", { code: "R1", name: "Print", processIds: [print] }).expect(201)).body.data.id;
    const die = (await a.post("/die-cuts", { code: "D-1", description: "80 x 120", dieType: "ROTARY_SOLID", labelWidthMm: 80, labelHeightMm: 120, across: 3, around: 2, gearTeeth: 80 }).expect(201)).body.data.id;

    // Product onboarding
    const png = await sharp({ create: { width: 10, height: 10, channels: 3, background: "#0a0" } }).png().toBuffer();
    const file = (await a.upload("art.png", png).expect(201)).body.data.file.id;
    const bom = (await a.post("/boms", { fileId: file, labelDescription: "Onboarded label" }).expect(201)).body.data;
    await a.post(`/boms/${bom.id}/son-codes`, { lines: [{ materialId: pp }, { materialId: cr }], changeNote: "Product onboarding" }).expect(201);
    const part = (await a.post("/materials", { code: "FG-NEW", description: "Onboarded label", uom: "PCS", nmiNo: "NMI-9", partType: "FINISHED_GOOD", source: "Manufactured", bomId: bom.id }).expect(201)).body.data;
    const pid = part.product.id;
    const card = (await a.post(`/products/${pid}/cards`).expect(201)).body.data;
    await a.patch(`/products/${pid}/cards/${card.id}`, { spec: { customerCode: "C1", labelWidthMm: 80, labelHeightMm: 120, across: 3, coreMm: 76, labelsPerRoll: 2000, winding: "3", dieCutId: die }, routineId: rt }).expect(200);
    const detail = (await a.get(`/products/${pid}`).expect(200)).body.data;
    expect(detail.draft.releaseProblems).toEqual([]);
    await a.post(`/products/${pid}/cards/${card.id}/release`).expect(200);

    // New PJO journey
    const pjo = (await a.post("/planning/production-job-orders", { bomId: bom.id, orderQty: 6000, uom: "PCS", customerRef: "PO-1" }).expect(201)).body.data;
    await a.post(`/planning/production-job-orders/${pjo.id}/release`).expect(200);
    const qpa = new Map((await a.get(`/products/${pid}`).expect(200)).body.data.released.qpa.map((l: { sonCode: string; qpa: number }) => [l.sonCode, l.qpa]));
    for (const qty of [4000, 2000]) {
      const wo = (await a.post("/planning/work-orders", { pjoId: pjo.id, quantity: qty }).expect(201)).body.data;
      await a.post(`/planning/work-orders/${wo.id}/release`).expect(200);
      const tpl = (await a.get(`/material/work-orders/${wo.id}/mrs-template`).expect(200)).body.data;
      const lines = tpl.lines.map((l: { sonCodeId: string; sonCode: string }) => ({ sonCodeId: l.sonCodeId, requestedQty: Math.ceil(Number(qpa.get(l.sonCode)) * qty * 10000 - 1e-9) / 10000 }));
      const mrs = (await a.post("/material/requisitions", { workOrderId: wo.id, lines }).expect(201)).body.data;
      const m = (await a.get(`/material/requisitions/${mrs.id}`).expect(200)).body.data;
      // 330 × 254 ÷ 6 ÷ 1e6 = 0.01397 m² per label; core 1/2000.
      expect(m.lines.map((l: { requested: string }) => l.requested)).toEqual([String(Math.ceil(0.01397 * qty * 10000) / 10000), String(qty / 2000)]);
    }
  });
  it("saves everything the onboarding journey captures (classified part with engineering data, full Master Card)", async () => {
    await t.createAdmin();
    const a = await t.login("admin");
    const ls = (await a.post("/parts/categories", { code: "LS", name: "Label stock", kind: "LABEL_STOCK" }).expect(201)).body.data.id;
    const fgCat = (await a.post("/parts/categories", { code: "FGL", name: "Finished labels", kind: "OTHER" }).expect(201)).body.data.id;
    const grp = (await a.post("/parts/groups", { code: "FGL-JUICE", name: "Juice labels", categoryId: fgCat }).expect(201)).body.data.id;
    const pp = (await a.post("/materials", { code: "PP330", description: "PP 330", uom: "M2", categoryId: ls, widthMm: 330 }).expect(201)).body.data.id;
    const print = (await a.post("/planning/processes", { code: "PRINT", name: "Printing", sequence: 10 }).expect(201)).body.data.id;
    const rt = (await a.post("/shopfloor/routines", { code: "R1", name: "Print", processIds: [print] }).expect(201)).body.data.id;
    const png = await sharp({ create: { width: 10, height: 10, channels: 3, background: "#00a" } }).png().toBuffer();
    const file = (await a.upload("art.png", png).expect(201)).body.data.file.id;
    const bom = (await a.post("/boms", { fileId: file, labelDescription: "Mango juice front" }).expect(201)).body.data;
    const added = (await a.post(`/boms/${bom.id}/son-codes`, { lines: [{ materialId: pp, quantity: 1 }], changeNote: "Product onboarding" }).expect(201)).body.data;
    expect(added.sonCodes).toHaveLength(1);
    const part = (
      await a
        .post("/materials", {
          code: "FG-FULL", description: "Mango juice front", uom: "PCS", nmiNo: "NMI-77", source: "Manufactured", categoryId: fgCat, groupId: grp,
          specification: "80 × 120 mm", partType: "FINISHED_GOOD", bomId: bom.id, measureWMm: 80, measureHMm: 120, pcsPerRoll: 2000, packQty: 8, cartonsPerPallet: 40, materialType: "Self-adhesive label",
        })
        .expect(201)
    ).body.data;
    const pid = part.product.id;
    const card = (await a.post(`/products/${pid}/cards`).expect(201)).body.data;
    const spec = {
      customerCode: "C1", customerPartCode: "CP-1", endUser: "Juice Co", afrfMaterial: "PP white", afrfColor: "4C", afrfForm: "Roll", supplierCode: "S-1", printingDirection: "Head first",
      afrfDetail: "d", packingInstruction: "8 rolls / carton", specialInstruction: "s", afrfRemark: "r", labelWidthMm: 80, labelHeightMm: 120, shape: "Rectangle", cornerRadiusMm: 2,
      across: 3, gapAcrossMm: 3, gapAroundMm: 0, coreMm: 76, labelsPerRoll: 2000, winding: "3", maxRollDiameterMm: 300, rollsPerCarton: 8, printMethod: "UV flexo", colours: "CMYK",
      feedLengthMm: 254, feedUps: 6, actualUps: 6, sampleCount: 5, bomDetail: [{ sonCode: added.sonCodes[0], manualQpa: 0.02 }],
      processDetail: [{ seq: 1, setupMins: 30, outputPerPress: 6, noOfPrint: 4, speed: 60, speedUom: "m/min" }],
    };
    await a.patch(`/products/${pid}/cards/${card.id}`, { spec, routineId: rt, changeNote: "First issue (product onboarding)" }).expect(200);
    const detail = (await a.get(`/products/${pid}`).expect(200)).body.data;
    expect(detail.draft.releaseProblems).toEqual([]);
    expect(detail.draft.spec).toMatchObject({ afrfMaterial: "PP white", packingInstruction: "8 rolls / carton", processDetail: [{ seq: 1, speed: 60 }] });
    const qpa = detail.draft.qpa.find((l: { sonCode: string }) => l.sonCode === added.sonCodes[0]);
    expect(qpa.qpa).toBe(0.02);
    const m = (await a.get(`/materials/${part.id}`).expect(200)).body.data;
    expect(m).toMatchObject({ groupId: grp, nmiNo: "NMI-77", cartonsPerPallet: 40 });
    expect(Number(m.measureWMm)).toBe(80);
    expect(Number(m.pcsPerRoll)).toBe(2000);
  });
});
