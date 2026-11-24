import sharp from "sharp";
import { beforeEach, describe, expect, it } from "vitest";
import { diffLines, normQty, type LineState } from "../src/modules/bom/bom.rules";
import { setupDb } from "./db-helpers";

const t = setupDb();

const png = (color: string) => sharp({ create: { width: 40, height: 20, channels: 3, background: color } }).png().toBuffer();
const PDF = Buffer.from("%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n");
const SVG = Buffer.from('<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg" width="20" height="10"><rect width="20" height="10" fill="#00f"/></svg>');

type Api = Awaited<ReturnType<typeof t.login>>;

async function upload(api: Api, name: string, bytes: Buffer) {
  const res = await api.upload(name, bytes);
  if (res.status !== 201) throw new Error(`upload failed ${res.status} ${JSON.stringify(res.body)}`);
  return res.body.data as { file: { id: string; previewKind: string; hasThumbnail: boolean; sha256: string }; warnings: { type: string }[] };
}

async function createFather(api: Api, description = "Mango Juice 500ml Front Label", name = "mango.png", color = "#f80") {
  const up = await upload(api, name, await png(color));
  const res = await api.post("/boms", { fileId: up.file.id, labelDescription: description }).expect(201);
  return res.body.data as { id: string; fatherCode: string };
}

async function material(api: Api, code: string, description = `Material ${code}`, uom = "M2") {
  const res = await api.post("/materials", { code, description, uom }).expect(201);
  return res.body.data as { id: string; code: string };
}

let admin: Api;
beforeEach(async () => {
  await t.createAdmin();
  admin = await t.login("admin");
});

describe("artwork upload", () => {
  it("accepts PNG / SVG with a thumbnail and PDF with an inline preview", async () => {
    const p = await upload(admin, "front.png", await png("#f00"));
    expect(p.file).toMatchObject({ previewKind: "image", hasThumbnail: true });
    const s = await upload(admin, "logo.svg", SVG);
    expect(s.file).toMatchObject({ previewKind: "image", hasThumbnail: true });
    const d = await upload(admin, "artwork.pdf", PDF);
    expect(d.file).toMatchObject({ previewKind: "pdf", hasThumbnail: false });
    const thumb = await admin.get(`/bom-files/${p.file.id}/thumbnail`).expect(200);
    expect(thumb.headers["content-type"]).toBe("image/png");
    const svg = await admin.get(`/bom-files/${s.file.id}/content`).expect(200);
    expect(svg.headers["content-security-policy"]).toContain("sandbox");
  });

  it("rejects unsupported extensions, renamed files, oversize files and empty files", async () => {
    const exe = await admin.upload("setup.exe", Buffer.from("MZ...."));
    expect(exe.body.code).toBe("UNSUPPORTED_FILE");
    const fake = await admin.upload("artwork.pdf", Buffer.from("MZ this is not a pdf"));
    expect(fake.body.code).toBe("FILE_CONTENT_MISMATCH");
    const big = await admin.upload("huge.pdf", Buffer.concat([PDF, Buffer.alloc(3 * 1024 * 1024)]));
    expect(big.body.code).toBe("FILE_TOO_LARGE");
    const empty = await admin.upload("empty.png", Buffer.alloc(0));
    expect(empty.status).toBe(400);
    const entity = await admin.upload("x.svg", Buffer.from('<!DOCTYPE svg [<!ENTITY a "b">]><svg xmlns="http://www.w3.org/2000/svg"></svg>'));
    expect(entity.body.code).toBe("FILE_CONTENT_MISMATCH");
  });

  it("keeps unattached uploads private to the uploader", async () => {
    const up = await upload(admin, "draft.png", await png("#0f0"));
    await t.createUser("viewer", ["MANAGEMENT"]);
    const viewer = await t.login("viewer");
    await viewer.get(`/bom-files/${up.file.id}/content`).expect(404);
    await viewer.upload("x.png", await png("#000")).expect(403);
  });
});

describe("Father Code and artwork revisions", () => {
  it("creates a Father Code at artwork revision 1 with a generated code and audit", async () => {
    const bom = await createFather(admin);
    expect(bom.fatherCode).toBe("BOM-000001");
    const detail = await admin.get(`/boms/${bom.id}`).expect(200);
    expect(detail.body.data).toMatchObject({
      fatherCode: "BOM-000001",
      status: "ACTIVE",
      labelDescription: "Mango Juice 500ml Front Label",
      artwork: { revisionNo: 1, changeType: "CREATED" },
      componentRevision: null,
      components: [],
    });
    const history = await admin.get(`/boms/${bom.id}/history`).expect(200);
    expect(history.body.data.map((h: { action: string }) => h.action)).toEqual(["FATHER_CODE_CREATED"]);
  });

  it("an upload can be used by one revision only", async () => {
    const up = await upload(admin, "a.png", await png("#123"));
    await admin.post("/boms", { fileId: up.file.id, labelDescription: "A" }).expect(201);
    const again = await admin.post("/boms", { fileId: up.file.id, labelDescription: "B" });
    expect(again.status).toBe(422);
  });

  it("warns about duplicate checksum, file name and description without blocking", async () => {
    const bytes = await png("#abc");
    const first = await upload(admin, "same.png", bytes);
    await admin.post("/boms", { fileId: first.file.id, labelDescription: "Chilli Sauce 340g" }).expect(201);

    const sameContent = await upload(admin, "other-name.png", bytes);
    expect(sameContent.warnings.map((w) => w.type)).toEqual(["FILE_HASH"]);
    const sameName = await upload(admin, "same.png", await png("#def"));
    expect(sameName.warnings.map((w) => w.type)).toEqual(["FILE_NAME"]);

    const desc = await admin.post("/boms/duplicate-check", { labelDescription: "  chilli   SAUCE 340g " }).expect(200);
    expect(desc.body.data[0]).toMatchObject({ type: "DESCRIPTION", matches: [{ fatherCode: "BOM-000001" }] });
    // Still allowed
    await admin.post("/boms", { fileId: sameContent.file.id, labelDescription: "Chilli Sauce 340g" }).expect(201);
  });

  it("creates artwork revisions only for meaningful changes", async () => {
    const bom = await createFather(admin, "Soy Sauce 1L");
    // whitespace-only edit -> no revision
    const same = await admin.patch(`/boms/${bom.id}/artwork`, { labelDescription: "  Soy   Sauce 1L " }).expect(200);
    expect(same.body.data).toEqual({ changed: false, artworkRevision: 1 });

    const desc = await admin.patch(`/boms/${bom.id}/artwork`, { labelDescription: "Soy Sauce 1L (Halal)", changeNote: "Halal logo text" }).expect(200);
    expect(desc.body.data).toEqual({ changed: true, artworkRevision: 2 });

    const newFile = await upload(admin, "soy-v3.png", await png("#321"));
    const art = await admin.patch(`/boms/${bom.id}/artwork`, { fileId: newFile.file.id, expectedArtworkRevNo: 2 }).expect(200);
    expect(art.body.data.artworkRevision).toBe(3);

    // identical file re-uploaded -> no revision
    const identical = await upload(admin, "soy-v3-copy.png", await png("#321"));
    const noop = await admin.patch(`/boms/${bom.id}/artwork`, { fileId: identical.file.id }).expect(200);
    expect(noop.body.data.changed).toBe(false);

    const revs = await admin.get(`/boms/${bom.id}/artwork-revisions`).expect(200);
    expect(revs.body.data.map((r: { revisionNo: number; changeType: string }) => [r.revisionNo, r.changeType])).toEqual([
      [3, "ARTWORK_REPLACED"],
      [2, "DESCRIPTION_CHANGED"],
      [1, "CREATED"],
    ]);
    // Revision 1 artwork is still downloadable
    const rev1 = revs.body.data[2];
    await admin.get(`/bom-files/${rev1.file.id}/content?download=1`).expect(200);
  });

  it("refuses a stale artwork edit and restores an old revision as a new one", async () => {
    const bom = await createFather(admin, "Coconut Milk 200ml");
    await admin.patch(`/boms/${bom.id}/artwork`, { labelDescription: "Coconut Milk 200ml NEW" }).expect(200);
    const stale = await admin.patch(`/boms/${bom.id}/artwork`, { labelDescription: "X", expectedArtworkRevNo: 1 });
    expect(stale.status).toBe(409);
    const restored = await admin.post(`/boms/${bom.id}/artwork-revisions/restore`, { revisionNo: 1, changeNote: "Customer rejected new text" }).expect(200);
    expect(restored.body.data.artworkRevision).toBe(3);
    const detail = await admin.get(`/boms/${bom.id}`).expect(200);
    expect(detail.body.data.labelDescription).toBe("Coconut Milk 200ml");
    const again = await admin.post(`/boms/${bom.id}/artwork-revisions/restore`, { revisionNo: 1 });
    expect(again.body.code).toBe("NO_CHANGE");
  });

  it("checks the specific permission for description vs artwork changes", async () => {
    const bom = await createFather(admin, "Kicap 500ml");
    const role = await t.db.role.create({
      data: { code: "ARTWORK_ONLY", name: "Artwork only", permissions: { create: ["bom.view", "bom.artwork.upload"].map((permissionKey) => ({ permissionKey })) } },
    });
    const u = await t.createUser("artist");
    await t.db.userRole.create({ data: { userId: u.id, roleId: role.id } });
    const artist = await t.login("artist");
    const desc = await artist.patch(`/boms/${bom.id}/artwork`, { labelDescription: "Changed" });
    expect(desc.status).toBe(403);
    const up = await upload(artist, "new.png", await png("#999"));
    await artist.patch(`/boms/${bom.id}/artwork`, { fileId: up.file.id }).expect(200);
  });

  it("deactivated Father Codes can't feed new production; historical rows can't be deleted", async () => {
    const bom = await createFather(admin, "Sambal 200g");
    await admin.get(`/boms/${bom.id}/production-snapshot`).expect(200);
    await admin.put(`/boms/${bom.id}/status`, { status: "INACTIVE", reason: "Product discontinued" }).expect(200);
    const snap = await admin.get(`/boms/${bom.id}/production-snapshot`);
    expect(snap.body.code).toBe("BOM_INACTIVE");
    await expect(t.db.bom.delete({ where: { id: bom.id } })).rejects.toThrow(/never deleted/);
    const rev = await t.db.bomArtworkRevision.findFirstOrThrow({ where: { bomId: bom.id } });
    await expect(t.db.bomArtworkRevision.update({ where: { id: rev.id }, data: { labelDescription: "x" } })).rejects.toThrow(/immutable/);
  });

  it("lists with thumbnail info, Son Code count, search by material code and paging", async () => {
    const a = await createFather(admin, "Apple Juice", "apple.png", "#0a0");
    await createFather(admin, "Banana Chips", "banana.png", "#ff0");
    const m = await material(admin, "PP-WHITE-80");
    await admin.post(`/boms/${a.id}/son-codes`, { lines: [{ materialId: m.id, quantity: 1.5 }] }).expect(201);
    const all = await admin.get("/boms?sort=fatherCode:asc").expect(200);
    expect(all.body.meta.total).toBe(2);
    expect(all.body.data[0]).toMatchObject({ fatherCode: "BOM-000001", sonCount: 1, artworkRevision: 1, componentRevision: 1, artworkFile: { hasThumbnail: true } });
    const byMaterial = await admin.get("/boms?q=PP-WHITE").expect(200);
    expect(byMaterial.body.data.map((b: { labelDescription: string }) => b.labelDescription)).toEqual(["Apple Juice"]);
  });
});

describe("Son Codes and component revisions", () => {
  it("adds several Son Codes in one component revision, filling description and unit from the material", async () => {
    const bom = await createFather(admin);
    const face = await material(admin, "pp-white-80", "PP White 80mic face stock", "M2");
    const ribbon = await material(admin, "RIB-WAX-110", "Wax ribbon 110mm", "ROLL");
    const res = await admin
      .post(`/boms/${bom.id}/son-codes`, { lines: [{ materialId: face.id, quantity: "12.50" }, { materialId: ribbon.id }], changeNote: "Initial BOM" })
      .expect(201);
    expect(res.body.data).toEqual({ revisionNo: 1, sonCodes: ["BOM-000001-01", "BOM-000001-02"] });
    const detail = await admin.get(`/boms/${bom.id}`).expect(200);
    expect(detail.body.data.components).toMatchObject([
      { sonCode: "BOM-000001-01", materialCode: "PP-WHITE-80", materialDescription: "PP White 80mic face stock", quantity: "12.5", uom: "M2", status: "ACTIVE" },
      { sonCode: "BOM-000001-02", materialCode: "RIB-WAX-110", quantity: null, uom: "ROLL" },
    ]);
    // Artwork untouched by component changes
    expect(detail.body.data.artwork.revisionNo).toBe(1);
  });

  it("asks for confirmation before adding the same material twice", async () => {
    const bom = await createFather(admin);
    const m = await material(admin, "INK-CYAN");
    await admin.post(`/boms/${bom.id}/son-codes`, { lines: [{ materialId: m.id }] }).expect(201);
    const dup = await admin.post(`/boms/${bom.id}/son-codes`, { lines: [{ materialId: m.id }] });
    expect(dup.body.code).toBe("DUPLICATE_COMPONENT");
    expect(dup.body.duplicates[0]).toMatchObject({ materialCode: "INK-CYAN" });
    await admin.post(`/boms/${bom.id}/son-codes`, { lines: [{ materialId: m.id }], allowDuplicate: true }).expect(201);
    const history = await admin.get(`/boms/${bom.id}/history`).expect(200);
    expect(history.body.data[0].remarks).toContain("Duplicate component confirmed: INK-CYAN");
  });

  it("edits, removes and never reuses Son Codes; each change is one revision with a diff", async () => {
    const bom = await createFather(admin);
    const a = await material(admin, "MAT-A", "Material A", "PCS");
    const b = await material(admin, "MAT-B", "Material B", "KG");
    await admin.post(`/boms/${bom.id}/son-codes`, { lines: [{ materialId: a.id, quantity: 2 }, { materialId: b.id, quantity: 1 }] }).expect(201);
    const detail = await admin.get(`/boms/${bom.id}`).expect(200);
    const [sonA, sonB] = detail.body.data.components;

    // no-op edit -> no revision
    const noop = await admin.patch(`/boms/${bom.id}/son-codes/${sonA.sonCodeId}`, { quantity: "2.0000" }).expect(200);
    expect(noop.body.data).toEqual({ revisionNo: 1, changed: false });

    await admin.patch(`/boms/${bom.id}/son-codes/${sonA.sonCodeId}`, { quantity: 3, remarks: "Increased", expectedComponentRevNo: 1 }).expect(200);
    await admin.post(`/boms/${bom.id}/son-codes/${sonB.sonCodeId}/remove`, { changeNote: "Not needed", expectedComponentRevNo: 2 }).expect(200);
    const added = await admin.post(`/boms/${bom.id}/son-codes`, { lines: [{ materialId: b.id }] }).expect(201);
    expect(added.body.data.sonCodes).toEqual(["BOM-000001-03"]);

    const revs = await admin.get(`/boms/${bom.id}/component-revisions`).expect(200);
    expect(revs.body.data.map((r: { revisionNo: number; changeType: string }) => [r.revisionNo, r.changeType])).toEqual([
      [4, "ADDED"],
      [3, "REMOVED"],
      [2, "MODIFIED"],
      [1, "ADDED"],
    ]);
    expect(revs.body.data[2].changes.modified[0]).toEqual({
      sonCode: "BOM-000001-01",
      before: { quantity: "2", remarks: null },
      after: { quantity: "3", remarks: "Increased" },
    });
    expect(revs.body.data[1].changes.removed[0]).toMatchObject({ sonCode: "BOM-000001-02", materialCode: "MAT-B" });

    // Revision 1 list is preserved exactly
    const rev1 = await admin.get(`/boms/${bom.id}/component-revisions/1`).expect(200);
    expect(rev1.body.data.lines.map((l: { sonCode: string; quantity: string }) => [l.sonCode, l.quantity])).toEqual([
      ["BOM-000001-01", "2"],
      ["BOM-000001-02", "1"],
    ]);
    // A removed Son Code can't be edited
    const gone = await admin.patch(`/boms/${bom.id}/son-codes/${sonB.sonCodeId}`, { quantity: 9 });
    expect(gone.body.code).toBe("SON_CODE_NOT_ACTIVE");
  });

  it("refuses stale component edits", async () => {
    const bom = await createFather(admin);
    const a = await material(admin, "MAT-A");
    await admin.post(`/boms/${bom.id}/son-codes`, { lines: [{ materialId: a.id }] }).expect(201);
    const stale = await admin.post(`/boms/${bom.id}/son-codes`, { lines: [{ materialId: a.id }], allowDuplicate: true, expectedComponentRevNo: 0 });
    expect(stale.status).toBe(409);
  });

  it("restores an earlier component list as a new revision and reactivates its Son Codes", async () => {
    const bom = await createFather(admin);
    const a = await material(admin, "MAT-A");
    const b = await material(admin, "MAT-B");
    await admin.post(`/boms/${bom.id}/son-codes`, { lines: [{ materialId: a.id }, { materialId: b.id }] }).expect(201);
    const sonB = (await admin.get(`/boms/${bom.id}`)).body.data.components[1];
    await admin.post(`/boms/${bom.id}/son-codes/${sonB.sonCodeId}/remove`, {}).expect(200);
    const res = await admin.post(`/boms/${bom.id}/component-revisions/restore`, { revisionNo: 1, changeNote: "Undo removal" }).expect(200);
    expect(res.body.data.revisionNo).toBe(3);
    const detail = await admin.get(`/boms/${bom.id}`).expect(200);
    expect(detail.body.data.components.map((c: { sonCode: string }) => c.sonCode)).toEqual(["BOM-000001-01", "BOM-000001-02"]);
    const son = await t.db.bomSonCode.findUniqueOrThrow({ where: { id: sonB.sonCodeId } });
    expect(son.status).toBe("ACTIVE");
  });

  it("inactive materials can't be added; renaming a material doesn't rewrite saved revisions", async () => {
    const bom = await createFather(admin);
    const m = await material(admin, "OLD-GLUE", "Old glue");
    await admin.post(`/boms/${bom.id}/son-codes`, { lines: [{ materialId: m.id }] }).expect(201);
    await admin.patch(`/materials/${m.id}`, { description: "Hotmelt glue (renamed)" }).expect(200);
    const detail = await admin.get(`/boms/${bom.id}`).expect(200);
    expect(detail.body.data.components[0].materialDescription).toBe("Old glue");
    await admin.put(`/materials/${m.id}/status`, { status: "INACTIVE" }).expect(200);
    const other = await createFather(admin, "Other", "o.png", "#010");
    const res = await admin.post(`/boms/${other.id}/son-codes`, { lines: [{ materialId: m.id }] });
    expect(res.body.code).toBe("MATERIAL_INACTIVE");
  });

  it("production snapshot freezes the exact artwork and component revisions", async () => {
    const bom = await createFather(admin, "Snapshot Label");
    const m = await material(admin, "MAT-S");
    await admin.post(`/boms/${bom.id}/son-codes`, { lines: [{ materialId: m.id, quantity: 4 }] }).expect(201);
    const snap = (await admin.get(`/boms/${bom.id}/production-snapshot`).expect(200)).body.data;
    expect(snap).toMatchObject({ fatherCode: "BOM-000001", artworkRevision: { revisionNo: 1 }, componentRevision: { revisionNo: 1, lines: [{ materialCode: "MAT-S", quantity: "4" }] } });
    await admin.patch(`/boms/${bom.id}/artwork`, { labelDescription: "Snapshot Label v2" }).expect(200);
    // The revision rows a released job points to are unchanged
    const frozen = await t.db.bomArtworkRevision.findUniqueOrThrow({ where: { id: snap.artworkRevision.id } });
    expect(frozen.labelDescription).toBe("Snapshot Label");
  });

  it("enforces Son Code permissions", async () => {
    const bom = await createFather(admin);
    const m = await material(admin, "MAT-P");
    await t.createUser("op", ["PRODUCTION_OPERATOR"]);
    const op = await t.login("op");
    await op.get(`/boms/${bom.id}`).expect(200);
    await op.post(`/boms/${bom.id}/son-codes`, { lines: [{ materialId: m.id }] }).expect(403);
    await op.post("/materials", { code: "X", description: "X", uom: "PCS" }).expect(403);
    await t.createUser("mc", ["MATERIAL_CONTROLLER"]);
    const mc = await t.login("mc");
    await mc.post("/materials", { code: "MC-1", description: "Allowed", uom: "PCS" }).expect(201);
  });
});

describe("materials", () => {
  it("keeps codes unique and immutable, and audits changes", async () => {
    const m = await material(admin, "abc-1", "First");
    expect(m.code).toBe("ABC-1");
    const dup = await admin.post("/materials", { code: "ABC-1", description: "Again", uom: "PCS" });
    expect(dup.body.issues[0]).toMatchObject({ path: "code" });
    await admin.patch(`/materials/${m.id}`, { code: "NEW" }).expect(200);
    expect((await t.db.material.findUniqueOrThrow({ where: { id: m.id } })).code).toBe("ABC-1");
    const lookup = await admin.get("/materials/lookup?q=abc").expect(200);
    expect(lookup.body.data[0].code).toBe("ABC-1");
    expect(await t.db.auditLog.count({ where: { entityType: "material" } })).toBe(1);
  });
});

describe("pure rules", () => {
  it("normalises quantities and diffs component lists", () => {
    expect(normQty("12.5000")).toBe("12.5");
    expect(normQty(3)).toBe("3");
    expect(normQty(null)).toBeNull();
    const line = (id: string, q: string | null): LineState => ({
      sonCodeId: id, sonCode: `S-${id}`, materialId: "m", materialCode: "M", materialDescription: "Mat", quantity: q, uom: "PCS", remarks: null,
    });
    const d = diffLines([line("1", "1"), line("2", null)], [line("1", "2"), line("3", null)]);
    expect(d.added.map((x) => x.sonCode)).toEqual(["S-3"]);
    expect(d.removed.map((x) => x.sonCode)).toEqual(["S-2"]);
    expect(d.modified).toEqual([{ sonCode: "S-1", before: { quantity: "1" }, after: { quantity: "2" } }]);
  });
});
