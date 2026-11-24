import { beforeEach, describe, expect, it } from "vitest";
import { setupDb } from "./db-helpers";

/** Part Category, Part Group, Part Master specs and Die Cut Master. */
const t = setupDb();
type Api = Awaited<ReturnType<typeof t.login>>;
let admin: Api;
let op: Api;

beforeEach(async () => {
  await t.createAdmin();
  admin = await t.login("admin");
  await t.createUser("op", ["PRODUCTION_OPERATOR"]);
  op = await t.login("op");
});

describe("Part Category and Part Group", () => {
  it("keeps codes unique and immutable, and groups inside one category", async () => {
    const stock = (await admin.post("/parts/categories", { code: "ls", name: "Label stock", kind: "LABEL_STOCK" }).expect(201)).body.data;
    expect(stock.code).toBe("LS");
    expect((await admin.post("/parts/categories", { code: "LS", name: "Other", kind: "INK" }).expect(422)).body.issues[0].path).toBe("code");
    expect((await admin.post("/parts/categories", { code: "LS2", name: "Label stock", kind: "INK" }).expect(422)).body.issues[0].path).toBe("name");
    const ink = (await admin.post("/parts/categories", { code: "INK", name: "Ink", kind: "INK" }).expect(201)).body.data;

    const pp = (await admin.post("/parts/groups", { code: "PP-WG", name: "PP white gloss", categoryId: stock.id }).expect(201)).body.data;
    expect((await admin.post("/parts/groups", { code: "PP-2", name: "PP white gloss", categoryId: stock.id }).expect(422)).body.issues[0].path).toBe("name");
    // Same name in another category is fine.
    await admin.post("/parts/groups", { code: "PP-3", name: "PP white gloss", categoryId: ink.id }).expect(201);

    // A part in the group pins the group to its category.
    const part = (await admin.post("/materials", { code: "PP80", description: "PP white gloss 80 µm", uom: "M2", categoryId: stock.id, groupId: pp.id }).expect(201)).body.data;
    expect(part).toMatchObject({ category: { code: "LS", kind: "LABEL_STOCK" }, group: { code: "PP-WG" } });
    const move = await admin.patch(`/parts/groups/${pp.id}`, { categoryId: ink.id }).expect(422);
    expect(move.body.issues[0].message).toContain("1 part(s) use this group");

    const cats = (await admin.get("/parts/categories").expect(200)).body.data;
    expect(cats.find((c: { code: string }) => c.code === "LS")).toMatchObject({ groupCount: 1, partCount: 1 });

    // Inactive categories can't be chosen for new parts.
    await admin.put(`/parts/categories/${ink.id}/status`, { status: "INACTIVE" }).expect(200);
    expect((await admin.post("/materials", { code: "INK-C", description: "Cyan", uom: "KG", categoryId: ink.id }).expect(422)).body.issues[0].path).toBe("categoryId");
    // Operators can view but not maintain.
    await op.post("/parts/categories", { code: "X", name: "X", kind: "OTHER" }).expect(403);

    const audit = await t.db.auditLog.findMany({ where: { module: "masterdata" }, orderBy: { id: "asc" } });
    expect(audit.map((a) => a.action)).toEqual(["PART_CATEGORY_CREATED", "PART_CATEGORY_CREATED", "PART_GROUP_CREATED", "PART_GROUP_CREATED", "PART_CREATED", "PART_CATEGORY_DEACTIVATED"]);
  });
});

describe("Part Master", () => {
  it("stores label-industry specs, checks the group's category and validates measurements", async () => {
    const stock = (await admin.post("/parts/categories", { code: "LS", name: "Label stock", kind: "LABEL_STOCK" }).expect(201)).body.data;
    const foil = (await admin.post("/parts/categories", { code: "FOIL", name: "Hot foil", kind: "FOIL" }).expect(201)).body.data;
    const pp = (await admin.post("/parts/groups", { code: "PP", name: "PP film", categoryId: stock.id }).expect(201)).body.data;

    const wrong = await admin.post("/materials", { code: "F1", description: "Gold foil", uom: "ROLL", categoryId: foil.id, groupId: pp.id }).expect(422);
    expect(wrong.body.issues[0]).toMatchObject({ path: "groupId", message: "This group belongs to another category" });
    const bad = await admin.post("/materials", { code: "F2", description: "x", uom: "ROLL", widthMm: "-5" }).expect(422);
    expect(bad.body.issues[0].path).toBe("widthMm");

    const part = (
      await admin
        .post("/materials", {
          code: "PPWG80-330",
          description: "PP white gloss 80 µm / acrylic / glassine, 330 mm",
          uom: "M2",
          categoryId: stock.id,
          groupId: pp.id,
          stockForm: "ROLL",
          widthMm: "330.00",
          lengthM: 1000,
          thicknessMicron: "80",
          faceFinish: "White gloss PP",
          adhesive: "Permanent acrylic",
          liner: "Glassine 60 gsm",
          coreIdMm: 76,
          supplierName: "Avery Dennison",
          supplierPartNo: "AD-PPWG80",
          shelfLifeDays: 730,
          certifications: "FSC",
        })
        .expect(201)
    ).body.data;
    expect(part).toMatchObject({ widthMm: "330", lengthM: "1000", thicknessMicron: "80", coreIdMm: "76", shelfLifeDays: 730, stockForm: "ROLL" });

    // Same value in another format is not a change; a new category clears the old group.
    await admin.patch(`/materials/${part.id}`, { widthMm: 330 }).expect(200);
    expect(await t.db.auditLog.count({ where: { action: "PART_UPDATED" } })).toBe(0);
    const moved = (await admin.patch(`/materials/${part.id}`, { categoryId: foil.id }).expect(200)).body.data;
    expect(moved).toMatchObject({ categoryId: foil.id, groupId: null });

    const found = (await admin.get("/materials?q=AD-PPWG80").expect(200)).body.data;
    expect(found.map((m: { code: string }) => m.code)).toEqual(["PPWG80-330"]);
    const lookup = (await admin.get("/materials/lookup?q=PPWG").expect(200)).body.data;
    expect(lookup[0]).toMatchObject({ code: "PPWG80-330", category: "Hot foil" });
  });
});

describe("Die Cut Master", () => {
  it("checks the layout, derives the rotary repeat from gear teeth and retires dies with a reason", async () => {
    const base = { code: "d-1001", description: "80 x 50 rounded, 3 across", dieType: "ROTARY_SOLID", shape: "ROUNDED_RECTANGLE", labelWidthMm: 80, labelHeightMm: 50, cornerRadiusMm: 3, across: 3, around: 6, gapAcrossMm: 3, gapAroundMm: 3.175 };
    expect((await admin.post("/die-cuts", base).expect(422)).body.issues[0].path).toBe("gearTeeth");
    // 96 teeth x 3.175 = 304.8 mm repeat; 6 x 50 = 300 mm fits.
    const die = (await admin.post("/die-cuts", { ...base, gearTeeth: 96 }).expect(201)).body.data;
    expect(die).toMatchObject({ code: "D-1001", repeatMm: "304.8", labelWidthMm: "80", condition: "GOOD", cutType: "KISS_CUT" });
    // 7 x 50 = 350 mm doesn't fit a 304.8 mm repeat.
    const tooMany = await admin.patch(`/die-cuts/${die.id}`, { around: 7 }).expect(422);
    expect(tooMany.body.issues[0].message).toContain("don't fit");
    const radius = await admin.post("/die-cuts", { ...base, code: "D-2", gearTeeth: 96, cornerRadiusMm: 30 }).expect(422);
    expect(radius.body.issues[0].path).toBe("cornerRadiusMm");
    const circle = await admin.post("/die-cuts", { ...base, code: "D-3", shape: "CIRCLE", dieType: "FLEXIBLE", cornerRadiusMm: null }).expect(422);
    expect(circle.body.issues[0].path).toBe("labelHeightMm");
    await admin.post("/die-cuts", { ...base, code: "D-1001", gearTeeth: 96 }).expect(422);

    // Search by label size.
    expect((await admin.get("/die-cuts?width=80.2&height=50").expect(200)).body.data).toHaveLength(1);
    expect((await admin.get("/die-cuts?width=100").expect(200)).body.data).toHaveLength(0);

    await admin.patch(`/die-cuts/${die.id}`, { condition: "WORN", location: "Rack B-3" }).expect(200);
    await admin.put(`/die-cuts/${die.id}/status`, { status: "INACTIVE" }).expect(422);
    await admin.put(`/die-cuts/${die.id}/status`, { status: "INACTIVE", reason: "Blade damaged" }).expect(200);
    const audit = await t.db.auditLog.findMany({ where: { entityType: "die_cut" }, orderBy: { id: "asc" } });
    expect(audit.map((a) => a.action)).toEqual(["DIE_CUT_CREATED", "DIE_CUT_UPDATED", "DIE_CUT_RETIRED"]);
    expect(audit[2]!.remarks).toBe("Blade damaged");
    // Operators have no planning master access.
    await op.get("/die-cuts").expect(403);
  });
});

describe("Part Master TBS sections", () => {
  it("raises the revision on technical changes, keeps UOM conversions and manual Location Qty, and obsoletes parts", async () => {
    const p = (await admin.post("/materials", { code: "PP80", description: "PP 80", uom: "M2", nmiNo: "NMI-1", source: "Purchased", pcsPerRoll: 1000, reorderLevel: 500, leadTimeDays: 14, overReceivePct: 5, requireIqc: true }).expect(201)).body.data;
    expect(p).toMatchObject({ revisionNo: 0, nmiNo: "NMI-1", pcsPerRoll: "1000", reorderLevel: "500", overReceivePct: 5, requireIqc: true });
    expect((await admin.post("/materials", { code: "PP81", description: "x", uom: "M2", nmiNo: "NMI-1" }).expect(422)).body.issues[0].path).toBe("nmiNo");
    // Shipping data doesn't revise the part; specification does.
    expect((await admin.patch(`/materials/${p.id}`, { reorderQty: 2000 }).expect(200)).body.data.revisionNo).toBe(0);
    const r1 = (await admin.patch(`/materials/${p.id}`, { specification: "PP white gloss 80 µm" }).expect(200)).body.data;
    expect(r1.revisionNo).toBe(1);
    expect(r1.revisedAt).toBeTruthy();

    await admin.put(`/materials/${p.id}/uom-conversions`, { items: [{ uom: "ROLL", factor: 330 }, { uom: "M2", factor: 1 }] }).expect(422);
    await admin.put(`/materials/${p.id}/uom-conversions`, { items: [{ uom: "ROLL", factor: "330.5" }] }).expect(200);
    const loc = (await admin.post(`/materials/${p.id}/locations`, { warehouseCode: "wh1", locationCode: "a-01", lotNo: "L1", qty: 1200, doHoldQty: 200 }).expect(201)).body.data.id;
    await admin.post(`/materials/${p.id}/locations`, { warehouseCode: "WH1", locationCode: "A-01", lotNo: "L1", qty: 1 }).expect(422);
    await admin.patch(`/materials/${p.id}/locations/${loc}`, { qty: 1100 }).expect(200);
    const detail = (await admin.get(`/materials/${p.id}`).expect(200)).body.data;
    expect(detail.uomConversions).toEqual([expect.objectContaining({ uom: "ROLL", factor: "330.5" })]);
    expect(detail.locations).toEqual([expect.objectContaining({ warehouseCode: "WH1", locationCode: "A-01", qty: "1100", doHoldQty: "200" })]);
    const list = (await admin.get("/materials?q=PP80").expect(200)).body.data;
    expect(list[0]).toMatchObject({ stockQty: "1100", holdQty: "200" });

    const obs = (await admin.patch(`/materials/${p.id}`, { obsolete: true }).expect(200)).body.data;
    expect(obs).toMatchObject({ obsolete: true, status: "INACTIVE" });
    expect(obs.obsoleteAt).toBeTruthy();
    const back = (await admin.patch(`/materials/${p.id}`, { obsolete: false }).expect(200)).body.data;
    expect(back).toMatchObject({ obsolete: false, status: "ACTIVE", obsoleteAt: null });
    const actions = (await t.db.auditLog.findMany({ where: { entityId: p.id }, orderBy: { id: "asc" } })).map((a) => a.action);
    expect(actions).toEqual(expect.arrayContaining(["PART_CREATED", "PART_UPDATED", "PART_UOM_CONVERSIONS_SET", "PART_LOCATION_ADDED", "PART_LOCATION_UPDATED"]));
  });
});
