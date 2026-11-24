import sharp from "sharp";
import { beforeEach, describe, expect, it } from "vitest";
import { setupDb } from "./db-helpers";

/**
 * Product Master and Master Card: one Father Code per product; released
 * Master Card revisions are frozen; Production Job Orders freeze them.
 */
const t = setupDb();
type Api = Awaited<ReturnType<typeof t.login>>;

interface World {
  admin: Api;
  planner: Api;
  operator: Api;
  bomId: string;
  bomId2: string;
}
let w: World;

const SPEC = { labelWidthMm: 80, labelHeightMm: 120, across: 3, coreMm: 76, labelsPerRoll: 1000, winding: "3", shape: "Rectangle" };

async function fatherCode(admin: Api, description: string, withComponents = true) {
  const png = await sharp({ create: { width: 10, height: 10, channels: 3, background: "#f80" } }).png().toBuffer();
  const file = (await admin.upload("label.png", png).expect(201)).body.data.file.id;
  const bomId = (await admin.post("/boms", { fileId: file, labelDescription: description }).expect(201)).body.data.id as string;
  if (withComponents) {
    const m = (await admin.post("/materials", { code: `MAT-${description.length}-${Date.now() % 100000}`, description: "Face stock", uom: "M2" }).expect(201)).body.data.id;
    await admin.post(`/boms/${bomId}/son-codes`, { lines: [{ materialId: m, quantity: 10 }] }).expect(201);
  }
  return bomId;
}

beforeEach(async () => {
  await t.createAdmin();
  const admin = await t.login("admin");
  await t.createUser("planner", ["PRODUCTION_PLANNER"]);
  await t.createUser("op", ["PRODUCTION_OPERATOR"]);
  w = {
    admin,
    planner: await t.login("planner"),
    operator: await t.login("op"),
    bomId: await fatherCode(admin, "Mango juice 1L front"),
    bomId2: await fatherCode(admin, "Mango juice 1L back", false),
  };
});

/** A finished-good part with its Artwork No.; the response carries the Master Card holder as `product`. */
const newProduct = (api: Api, bomId: string, code = "FG-10482") => api.post("/materials", { code, description: "Mango Juice 1L front label", uom: "PCS", partType: "FINISHED_GOOD", bomId });

async function releasedProduct() {
  const id = (await newProduct(w.planner, w.bomId).expect(201)).body.data.product.id as string;
  const card = (await w.planner.post(`/products/${id}/cards`).expect(201)).body.data;
  await w.planner.patch(`/products/${id}/cards/${card.id}`, { spec: SPEC, changeNote: "First issue" }).expect(200);
  await w.planner.post(`/products/${id}/cards/${card.id}/release`).expect(200);
  return { id, cardId: card.id as string };
}

describe("Product Master", () => {
  it("links exactly one finished-good part to a Father Code and keeps the code immutable and upper-case", async () => {
    const created = await newProduct(w.planner, w.bomId, "fg-10482").expect(201);
    expect(created.body.data).toMatchObject({ code: "FG-10482", partType: "FINISHED_GOOD", bom: { id: w.bomId }, product: { currentCardRevNo: 0 } });
    const again = await newProduct(w.planner, w.bomId, "FG-99999").expect(422);
    expect(again.body.issues[0]).toMatchObject({ path: "bomId" });
    expect(again.body.issues[0].message).toContain("already belongs to part FG-10482");
    // Only finished goods carry an Artwork No.
    const raw = await w.planner.post("/materials", { code: "RAW-1", description: "x", uom: "M2", bomId: w.bomId2 }).expect(422);
    expect(raw.body.issues[0].path).toBe("bomId");

    // The BOM list shows each Father Code with its finished-good part.
    const withProduct = (await w.planner.get("/boms?product=with").expect(200)).body.data;
    expect(withProduct.map((b: { id: string; product: { productCode: string } }) => [b.id, b.product.productCode])).toEqual([[w.bomId, "FG-10482"]]);
    const without = (await w.planner.get("/boms?product=without").expect(200)).body.data;
    expect(without.map((b: { id: string; product: unknown }) => [b.id, b.product])).toEqual([[w.bomId2, null]]);
    expect((await w.planner.get("/boms?q=fg-10482").expect(200)).body.data.map((b: { id: string }) => b.id)).toEqual([w.bomId]);

    const available = (await w.planner.get("/products/available-father-codes").expect(200)).body.data;
    expect(available.map((b: { id: string }) => b.id)).toEqual([w.bomId2]);

    // Renaming the part renames the card holder; the Artwork No. can't move once the card exists.
    const partId = created.body.data.id;
    await w.planner.patch(`/materials/${partId}`, { description: "Mango Juice 1L front (new)" }).expect(200);
    const p = (await w.planner.get(`/products/${created.body.data.product.id}`).expect(200)).body.data;
    expect(p).toMatchObject({ productCode: "FG-10482", name: "Mango Juice 1L front (new)", part: { id: partId }, currentCardRevNo: 0, released: null });
    await w.planner.patch(`/materials/${partId}`, { bomId: w.bomId2 }).expect(422);
    await w.planner.patch(`/materials/${partId}`, { partType: "RAW_MATERIAL" }).expect(422);
    await w.operator.post("/materials", { code: "X", description: "x", uom: "PCS", partType: "FINISHED_GOOD", bomId: w.bomId2 }).expect(403);
    await expect(t.db.$executeRawUnsafe("DELETE FROM products")).rejects.toThrow(/never deleted/);
  });
});

describe("Master Card", () => {
  it("drafts from the Father Code, needs a complete spec and components to release, and supersedes the previous release", async () => {
    const id = (await newProduct(w.planner, w.bomId2, "FG-2").expect(201)).body.data.product.id;
    const d1 = (await w.planner.post(`/products/${id}/cards`).expect(201)).body.data;
    expect(d1.revisionNo).toBe(1);
    await w.planner.post(`/products/${id}/cards`).expect(422);
    const missing = await w.planner.post(`/products/${id}/cards/${d1.id}/release`).expect(422);
    expect(missing.body.code).toBe("CARD_INCOMPLETE");
    expect(missing.body.problems).toEqual(expect.arrayContaining(["Label width is required", "The Father Code has no component list (Son Codes) yet"]));
    await w.planner.patch(`/products/${id}/cards/${d1.id}`, { spec: { ...SPEC, bogus: 1 } }).expect(422);

    // Add components to the Father Code, then refresh the draft's revisions.
    const m = (await w.admin.post("/materials", { code: "INK-CYAN", description: "Cyan ink", uom: "KG" }).expect(201)).body.data.id;
    await w.admin.post(`/boms/${w.bomId2}/son-codes`, { lines: [{ materialId: m, quantity: 1 }] }).expect(201);
    await w.planner.patch(`/products/${id}/cards/${d1.id}`, { spec: SPEC, refreshRevisions: true }).expect(200);
    // Operators can't release; the planner can.
    await w.operator.post(`/products/${id}/cards/${d1.id}/release`).expect(403);
    expect((await w.planner.post(`/products/${id}/cards/${d1.id}/release`).expect(200)).body.data).toEqual({ revisionNo: 1, superseded: null });

    const d2 = (await w.planner.post(`/products/${id}/cards`).expect(201)).body.data;
    const detail = (await w.planner.get(`/products/${id}`).expect(200)).body.data;
    expect(detail.draft).toMatchObject({ revisionNo: 2, spec: SPEC, artwork: { revisionNo: 1 }, component: { revisionNo: 1 } });
    await w.planner.patch(`/products/${id}/cards/${d2.id}`, { spec: { ...SPEC, labelsPerRoll: 2000 }, changeNote: "Bigger rolls" }).expect(200);
    expect((await w.planner.post(`/products/${id}/cards/${d2.id}/release`).expect(200)).body.data).toEqual({ revisionNo: 2, superseded: 1 });
    const after = (await w.planner.get(`/products/${id}`).expect(200)).body.data;
    expect(after.currentCardRevNo).toBe(2);
    expect(after.cards.map((c: { revisionNo: number; status: string }) => [c.revisionNo, c.status])).toEqual([
      [2, "RELEASED"],
      [1, "SUPERSEDED"],
    ]);
    expect(after.released.spec.labelsPerRoll).toBe(2000);
    // Released and superseded cards can't be edited or discarded.
    await w.planner.patch(`/products/${id}/cards/${d2.id}`, { changeNote: "edit" }).expect(422);
    await w.planner.delete(`/products/${id}/cards/${d1.id}`).expect(422);
    const actions = (await w.planner.get(`/products/${id}/history`).expect(200)).body.data.map((h: { action: string }) => h.action);
    expect(actions).toContain("MASTER_CARD_RELEASED");
  });

  it("the database refuses changes to released cards; drafts can be discarded", async () => {
    const { id, cardId } = await releasedProduct();
    await expect(t.db.$executeRawUnsafe(`UPDATE master_card_revisions SET spec = JSON_OBJECT('labelWidthMm', 1) WHERE id = '${cardId}'`)).rejects.toThrow(/immutable/);
    await expect(t.db.$executeRawUnsafe(`UPDATE master_card_revisions SET status = 'DRAFT' WHERE id = '${cardId}'`)).rejects.toThrow(/immutable/);
    await expect(t.db.$executeRawUnsafe(`DELETE FROM master_card_revisions WHERE id = '${cardId}'`)).rejects.toThrow(/never deleted/);
    const d = (await w.planner.post(`/products/${id}/cards`).expect(201)).body.data;
    await w.planner.delete(`/products/${id}/cards/${d.id}`).expect(200);
    expect(await t.db.masterCardRevision.count({ where: { productId: id } })).toBe(1);
  });
});

describe("Production Job Orders run from the released Master Card", () => {
  it("refuses an order before release, then freezes the card and keeps it after later changes", async () => {
    const id = (await newProduct(w.planner, w.bomId).expect(201)).body.data.product.id;
    const refused = await w.planner.post("/planning/production-job-orders", { bomId: w.bomId, orderQty: 5000, uom: "PCS" }).expect(422);
    expect(refused.body.code).toBe("NO_RELEASED_CARD");
    const d1 = (await w.planner.post(`/products/${id}/cards`).expect(201)).body.data;
    await w.planner.patch(`/products/${id}/cards/${d1.id}`, { spec: SPEC }).expect(200);
    await w.planner.post(`/products/${id}/cards/${d1.id}/release`).expect(200);

    const pjo = (await w.planner.post("/planning/production-job-orders", { bomId: w.bomId, orderQty: 5000, uom: "PCS" }).expect(201)).body.data;
    await w.planner.post(`/planning/production-job-orders/${pjo.id}/release`).expect(200);

    // New artwork revision + new card release afterwards.
    await w.admin.patch(`/boms/${w.bomId}/artwork`, { labelDescription: "Mango juice 1L front (Halal)" }).expect(200);
    const d2 = (await w.planner.post(`/products/${id}/cards`).expect(201)).body.data;
    await w.planner.post(`/products/${id}/cards/${d2.id}/release`).expect(200);

    const view = (await w.planner.get(`/planning/production-job-orders/${pjo.id}`).expect(200)).body.data;
    expect(view.masterCard).toEqual({ productCode: "FG-10482", revisionNo: 1, newerAvailable: true });
    expect(view.bom.artworkRevision).toBe(1);
    const row = await t.db.productionJobOrder.findUniqueOrThrow({ where: { id: pjo.id } });
    expect(row.masterCardRevisionId).toBe(d1.id);

    // A new order uses Rev 2 (artwork 2).
    const pjo2 = (await w.planner.post("/planning/production-job-orders", { bomId: w.bomId, orderQty: 100, uom: "PCS" }).expect(201)).body.data;
    const v2 = (await w.planner.get(`/planning/production-job-orders/${pjo2.id}`).expect(200)).body.data;
    expect(v2).toMatchObject({ masterCard: { revisionNo: 2, newerAvailable: false }, bom: { artworkRevision: 2 } });
    const orders = (await w.planner.get(`/products/${id}`).expect(200)).body.data.orders;
    expect(orders.map((o: { cardRevisionNo: number }) => o.cardRevisionNo).sort()).toEqual([1, 2]);

    // Inactive product: no new orders.
    // Deactivating the finished-good part stops new orders.
    const partId = (await t.db.product.findUniqueOrThrow({ where: { id } })).partId;
    await w.planner.put(`/materials/${partId}/status`, { status: "INACTIVE" }).expect(200);
    const inactive = await w.planner.post("/planning/production-job-orders", { bomId: w.bomId, orderQty: 1, uom: "PCS" }).expect(422);
    expect(inactive.body.code).toBe("PRODUCT_INACTIVE");
  });

  it("a Job Order takes its route from the routine on the order's frozen Master Card", async () => {
    const print = (await w.admin.post("/planning/processes", { code: "PRINT", name: "Printing", sequence: 10 }).expect(201)).body.data.id;
    const slit = (await w.admin.post("/planning/processes", { code: "SLIT", name: "Slitting", sequence: 20 }).expect(201)).body.data.id;
    const std = (await w.admin.post("/shopfloor/routines", { code: "STD", name: "Print + slit", processIds: [print, slit] }).expect(201)).body.data.id;
    const id = (await newProduct(w.planner, w.bomId).expect(201)).body.data.product.id;
    const d1 = (await w.planner.post(`/products/${id}/cards`).expect(201)).body.data;
    await w.planner.patch(`/products/${id}/cards/${d1.id}`, { spec: SPEC, routineId: std }).expect(200);
    await w.planner.post(`/products/${id}/cards/${d1.id}/release`).expect(200);
    // The next draft starts with the released card's routine.
    const d2 = (await w.planner.post(`/products/${id}/cards`).expect(201)).body.data;
    expect((await t.db.masterCardRevision.findUniqueOrThrow({ where: { id: d2.id } })).routineId).toBe(std);

    const pjo = (await w.planner.post("/planning/production-job-orders", { bomId: w.bomId, orderQty: 100, uom: "PCS" }).expect(201)).body.data;
    await w.planner.post(`/planning/production-job-orders/${pjo.id}/release`).expect(200);
    const wo = (await w.admin.post("/planning/work-orders", { pjoId: pjo.id, quantity: 100 }).expect(201)).body.data;
    const view = (await w.admin.get(`/planning/work-orders/${wo.id}`).expect(200)).body.data;
    expect(view.processes.map((p: { process: { code: string } }) => p.process.code)).toEqual(["PRINT", "SLIT"]);
  });

  it("Father Codes without a product keep using their current revisions", async () => {
    const pjo = (await w.planner.post("/planning/production-job-orders", { bomId: w.bomId, orderQty: 10, uom: "PCS" }).expect(201)).body.data;
    const view = (await w.planner.get(`/planning/production-job-orders/${pjo.id}`).expect(200)).body.data;
    expect(view.masterCard).toBeNull();
    expect(view.bom.artworkRevision).toBe(1);
  });
});

describe("Master Card sections and QPA", () => {
  it("calculates QPA from the die and BOM with the formula shown, takes Manual QPA, and copies the header customer on release", async () => {
    const ls = (await w.admin.post("/parts/categories", { code: "LS", name: "Label stock", kind: "LABEL_STOCK" }).expect(201)).body.data.id;
    const core = (await w.admin.post("/parts/categories", { code: "CORE", name: "Core", kind: "CORE" }).expect(201)).body.data.id;
    const pp = (await w.admin.post("/materials", { code: "PP330", description: "PP 330 mm", uom: "M2", categoryId: ls, widthMm: 330 }).expect(201)).body.data.id;
    const cr = (await w.admin.post("/materials", { code: "CORE76", description: "Core 76", uom: "PCS", categoryId: core }).expect(201)).body.data.id;
    const ink = (await w.admin.post("/materials", { code: "INKC", description: "Ink cyan", uom: "KG" }).expect(201)).body.data.id;
    await w.admin.post(`/boms/${w.bomId2}/son-codes`, { lines: [{ materialId: pp }, { materialId: cr }, { materialId: ink }] }).expect(201);
    const die = (await w.admin.post("/die-cuts", { code: "D-1", description: "80 x 120", dieType: "ROTARY_SOLID", labelWidthMm: 80, labelHeightMm: 120, across: 3, around: 2, gearTeeth: 80 }).expect(201)).body.data.id;
    const part = (await w.planner.post("/materials", { code: "FG-QPA", description: "QPA label", uom: "PCS", partType: "FINISHED_GOOD", bomId: w.bomId2, nmiNo: "NMI-0001" }).expect(201)).body.data;
    const id = part.product.id;
    const d = (await w.planner.post(`/products/${id}/cards`).expect(201)).body.data;
    const sons = (await w.admin.get(`/boms/${w.bomId2}`).expect(200)).body.data.components.map((c: { sonCode: string }) => c.sonCode);
    // A machine of another category is refused as the default machine.
    const pr = (await w.admin.post("/planning/processes", { code: "PRINT", name: "Printing", sequence: 10 }).expect(201)).body.data.id;
    const cat = (await w.admin.post("/planning/machine-categories", { code: "PRESS", name: "Press", processIds: [pr] }).expect(201)).body.data.id;
    const cat2 = (await w.admin.post("/planning/machine-categories", { code: "OTHER", name: "Other", processIds: [pr] }).expect(201)).body.data.id;
    const m = (await w.admin.post("/planning/machines", { code: "P-1", name: "Press 1", categoryId: cat2 }).expect(201)).body.data.id;
    const bad = await w.planner.patch(`/products/${id}/cards/${d.id}`, { spec: { ...SPEC, processDetail: [{ seq: 1, machineCategoryId: cat, defaultMachineId: m }] } }).expect(422);
    expect(bad.body.issues[0].path).toBe("spec.processDetail.0.defaultMachineId");

    await w.planner
      .patch(`/products/${id}/cards/${d.id}`, {
        spec: { ...SPEC, labelsPerRoll: 2000, customerCode: "C-FRESH", customerPartCode: "FV-77", endUser: "Fresh Valley", afrfMaterial: "PP white", printingDirection: "Head first", dieCutId: die, bomDetail: [{ sonCode: sons[2], manualQpa: 0.00012 }] },
        refreshRevisions: true,
      })
      .expect(200);
    const card = (await w.planner.get(`/products/${id}`).expect(200)).body.data.draft;
    // Die 3 x 2 = 6 UPS, 80 teeth x 3.175 = 254 mm feed.
    expect(card.dieSpec).toMatchObject({ feedLengthMm: 254, feedUps: 6, actualUps: 6, qpa: 42.333333 });
    const [face, cor, inkLine] = card.qpa;
    expect(face).toMatchObject({ materialCode: "PP330", widthMm: 330, calculated: 0.01397, source: "CALCULATED" });
    expect(face.formula).toBe("Width 330 mm × feed length 254 mm ÷ 6 UPS ÷ 1,000,000 = 0.01397 m² per label");
    expect(cor).toMatchObject({ calculated: 0.0005, qpa: 0.0005, source: "CALCULATED" });
    expect(cor.formula).toContain("2,000 labels per roll");
    expect(inkLine).toMatchObject({ calculated: null, manualQpa: 0.00012, qpa: 0.00012, source: "MANUAL" });
    expect(card.releaseProblems).toEqual([]);
    expect((await w.planner.get(`/products/${id}`).expect(200)).body.data.part).toMatchObject({ code: "FG-QPA", nmiNo: "NMI-0001" });

    await w.planner.post(`/products/${id}/cards/${d.id}/release`).expect(200);
    const after = await t.db.product.findUniqueOrThrow({ where: { id } });
    expect(after).toMatchObject({ customerName: "C-FRESH", customerPartNo: "FV-77" });
  });
});
