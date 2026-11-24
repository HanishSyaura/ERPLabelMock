import { describe, expect, it } from "vitest";
import { setupDb } from "./db-helpers";

/** Document templates (letterhead, default per document) and the live dashboard. */
const t = setupDb();

const layout = () => ({
  page: { size: "A4", orientation: "portrait", marginMm: 12, fontSizePt: 9, accent: "primary", density: "comfortable" },
  header: { showLogo: true, logoAlign: "left", showCompanyName: true, showAddress: true, showContact: true, showRegistration: false, title: "Production Job Order", subtitle: "", showDocNo: true, showDocDate: true, showBarcode: true, repeat: "all", divider: true, extraText: "" },
  sections: [{ key: "order", enabled: true, title: "Order details" }, { key: "components", enabled: true, title: "Son Codes", columns: ["sonCode", "materialCode"] }],
  notes: { title: "", text: "" },
  signatures: [{ label: "Prepared by" }, { label: "Approved by" }],
  footer: { left: "{company}", center: "Printed {printedAt}", right: "", showPageNumbers: true, divider: true },
});

describe("document templates", () => {
  it("keeps one default per document, guards the default, and stores the letterhead", async () => {
    await t.createAdmin();
    await t.createUser("insp", ["QC_INSPECTOR"]);
    const a = await t.login("admin");
    const insp = await t.login("insp");

    const first = (await a.post("/documents/templates", { code: "pjo-std", name: "Standard PJO", docType: "PJO", layout: layout() }).expect(201)).body.data;
    expect(first).toMatchObject({ code: "PJO-STD", isDefault: true });
    const second = (await a.post("/documents/templates", { code: "PJO-CUST", name: "Customer copy", docType: "PJO", layout: { ...layout(), page: { ...layout().page, accent: "neutral" } } }).expect(201)).body.data;
    expect(second.isDefault).toBe(false);

    // Strict layout: unknown keys are refused.
    await a.post("/documents/templates", { code: "BAD", name: "Bad", docType: "PJO", layout: { ...layout(), extra: 1 } }).expect(422);

    // The default can't be deactivated; switching the default moves it.
    await a.put(`/documents/templates/${first.id}/status`, { status: "INACTIVE" }).expect(422);
    await a.post(`/documents/templates/${second.id}/default`).expect(200);
    const list = (await insp.get("/documents/templates?docType=PJO").expect(200)).body.data as { code: string; isDefault: boolean }[];
    expect(list.filter((x) => x.isDefault).map((x) => x.code)).toEqual(["PJO-CUST"]);
    await a.put(`/documents/templates/${first.id}/status`, { status: "INACTIVE" }).expect(200);
    await a.post(`/documents/templates/${first.id}/default`).expect(422);

    // Everyone signed in reads templates (to print); only the permission holder edits.
    await insp.patch(`/documents/templates/${second.id}`, { name: "x" }).expect(403);
    await a.patch(`/documents/templates/${second.id}`, { name: "Customer copy v2", layout: layout() }).expect(200);

    // Letterhead: PNG / JPEG data URL only.
    await a.put("/documents/settings", { companyName: "Acme Labels Sdn Bhd", logo: "data:image/svg+xml;base64,AAAA" }).expect(422);
    await a.put("/documents/settings", { companyName: "Acme Labels Sdn Bhd", address: "Lot 1, Shah Alam", logo: "data:image/png;base64,iVBORw0KGgo=" }).expect(200);
    const s = (await insp.get("/documents/settings").expect(200)).body.data;
    expect(s).toMatchObject({ companyName: "Acme Labels Sdn Bhd", address: "Lot 1, Shah Alam", logo: "data:image/png;base64,iVBORw0KGgo=" });
    // Saving without a logo field keeps the logo.
    await a.put("/documents/settings", { companyName: "Acme Labels" }).expect(200);
    expect((await a.get("/documents/settings").expect(200)).body.data.logo).toBe("data:image/png;base64,iVBORw0KGgo=");
    await insp.put("/documents/settings", { companyName: "Nope" }).expect(403);
  });

  it("dashboard shows only the sections the user may view, counted live; quick find respects permissions", async () => {
    await t.createAdmin();
    await t.createUser("insp", ["QC_INSPECTOR"]);
    const a = await t.login("admin");
    const insp = await t.login("insp");
    const full = (await a.get("/dashboard").expect(200)).body.data;
    expect(Object.keys(full)).toEqual(expect.arrayContaining(["orders", "jobs", "floor", "material", "quality"]));
    expect(full.floor.output).toHaveLength(7);
    expect(full.kpis).toMatchObject({ activeOrders: 0, overdue: 0, pendingMrs: 0 });
    expect(Array.isArray(full.alerts)).toBe(true);

    const qc = (await insp.get("/dashboard").expect(200)).body.data;
    expect(qc.quality.lots.map((l: { type: string }) => l.type)).toEqual(["IQC", "OQC"]);
    expect(qc.floor).toBeUndefined();
    expect(qc.material).toBeUndefined();

    const cat = (await a.post("/parts/categories", { code: "LS", name: "Label stock", kind: "LABEL_STOCK" }).expect(201)).body.data.id;
    await a.post("/materials", { code: "PPWHITE80", description: "PP white 80", uom: "M2", categoryId: cat }).expect(201);
    const hits = (await a.get("/dashboard/find?q=PPWH").expect(200)).body.data;
    expect(hits[0]).toMatchObject({ type: "Part", label: "PPWHITE80" });
    await a.get("/dashboard/find?q=P").expect(422);
  });
});
