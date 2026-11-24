import { randomUUID } from "node:crypto";
import sharp from "sharp";
import request from "supertest";
import { API_BASE_PATH, createApp } from "../app";
import { loadConfig } from "../config/env";
import { createPasswordHasher } from "../lib/crypto";
import { createFileStore } from "../lib/file-store";
import { createLogger } from "../lib/logger";
import { createPrisma } from "../lib/prisma";

/**
 * DEVELOPMENT ONLY: demo data for the whole system (master data, BOM,
 * products + Master Cards, orders, shopfloor output, material movements, QC,
 * shipping labels). Every record goes through the real API as dev.admin, so
 * all business rules, numbering and audit apply. Run db:seed:dev first.
 * Refused unless the database name ends in _dev, _test or _local. Running it twice
 * is safe: masters are reused by code and the order scenarios run once.
 */
const config = loadConfig();
const dbName = new URL(config.DATABASE_URL).pathname.slice(1);
if (config.NODE_ENV === "production" || !/_(dev|test|local)$/.test(dbName)) {
  console.error(`Refusing to load demo data into "${dbName}" (only *_dev, *_test, *_local).`);
  process.exit(1);
}
if (!config.DEV_ACCOUNT_PASSWORD) {
  console.error("Set DEV_ACCOUNT_PASSWORD in server/.env and run db:seed:dev first.");
  process.exit(1);
}

const db = createPrisma(config.DATABASE_URL, 4);
const app = createApp({
  config,
  db,
  logger: createLogger("warn", false),
  hasher: createPasswordHasher(config.PASSWORD_PEPPER),
  files: createFileStore(config.UPLOAD_DIR),
  now: () => new Date(),
});

let cookie: string[] = [];
let csrf = "";
type Body = Record<string, unknown>;
async function call<T = Body>(method: "get" | "post" | "patch" | "put", path: string, body?: object): Promise<T> {
  let r = request(app)[method](`${API_BASE_PATH}${path}`).set("Cookie", cookie);
  if (csrf) r = r.set("X-CSRF-Token", csrf);
  const res = await (body ? r.send(body) : r);
  if (res.status >= 300) throw new Error(`${method.toUpperCase()} ${path} -> ${res.status} ${JSON.stringify(res.body).slice(0, 400)}`);
  return res.body.data as T;
}
const get = <T = Body>(p: string) => call<T>("get", p);
const post = <T = Body>(p: string, b: object = {}) => call<T>("post", p, b);
const patch = <T = Body>(p: string, b: object) => call<T>("patch", p, b);
const txn = () => randomUUID();
const day = (offset: number) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);

/** Find by code in a list endpoint, or create. */
async function ensure<T extends { id: string; code?: string }>(list: T[], code: string, create: () => Promise<{ id: string }>): Promise<string> {
  return list.find((x) => x.code === code)?.id ?? (await create()).id;
}

/** Artwork PNG with the label's name, so lists and Master Cards show something recognisable. */
async function artwork(title: string, sub: string, bg: string, fg = "#ffffff") {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="480" height="320">
    <rect width="480" height="320" rx="28" fill="${bg}"/>
    <rect x="18" y="18" width="444" height="284" rx="18" fill="none" stroke="${fg}" stroke-width="4" stroke-dasharray="10 8"/>
    <text x="240" y="150" font-family="Arial, sans-serif" font-size="40" font-weight="bold" fill="${fg}" text-anchor="middle">${title}</text>
    <text x="240" y="200" font-family="Arial, sans-serif" font-size="24" fill="${fg}" text-anchor="middle">${sub}</text>
  </svg>`;
  const png = await sharp(Buffer.from(svg)).png().toBuffer();
  const res = await request(app)
    .post(`${API_BASE_PATH}/bom-files`)
    .set("Cookie", cookie)
    .set("X-CSRF-Token", csrf)
    .set("Content-Type", "application/octet-stream")
    .set("X-File-Name", encodeURIComponent(`${title}.png`))
    .send(png);
  if (res.status !== 201) throw new Error(`artwork upload -> ${res.status}`);
  return res.body.data.file.id as string;
}

try {
  const login = await request(app).post(`${API_BASE_PATH}/auth/login`).send({ username: "dev.admin", password: config.DEV_ACCOUNT_PASSWORD });
  if (login.status !== 200) throw new Error("Can't sign in as dev.admin. Run db:seed:dev first.");
  cookie = ([] as string[]).concat(login.headers["set-cookie"] ?? []);
  csrf = login.body.data.csrfToken;
  console.log("Signed in as dev.admin");

  // ===== Master data ==========================================================
  console.log("Master data…");
  const cats = await get<{ id: string; code: string }[]>("/parts/categories");
  const cat: Record<string, string> = {};
  for (const [code, name, kind] of [
    ["LS", "Label stock", "LABEL_STOCK"],
    ["LAM", "Over-laminate", "LAMINATE"],
    ["INK", "Ink", "INK"],
    ["VAR", "Varnish", "VARNISH"],
    ["FOIL", "Hot foil", "FOIL"],
    ["RIB", "Thermal ribbon", "RIBBON"],
    ["CORE", "Core", "CORE"],
    ["PKG", "Packaging", "PACKAGING"],
  ] as const) {
    cat[code] = await ensure(cats, code, () => post("/parts/categories", { code, name, kind }));
  }
  const groups = await get<{ id: string; code: string }[]>("/parts/groups");
  const grp: Record<string, string> = {};
  for (const [code, name, c] of [
    ["PP-WG", "PP white gloss", "LS"],
    ["PP-CL", "PP clear", "LS"],
    ["PE-W", "PE white", "LS"],
    ["PAP-SG", "Semi-gloss paper", "LS"],
    ["DT-TOP", "Direct thermal", "LS"],
    ["BOPP", "BOPP laminate", "LAM"],
    ["UV-FLX", "UV flexo ink", "INK"],
    ["UV-VAR", "UV varnish", "VAR"],
    ["GOLD", "Gold foil", "FOIL"],
    ["P-CORE", "Paper core", "CORE"],
    ["CTN", "Carton", "PKG"],
  ] as const) {
    grp[code] = await ensure(groups, code, () => post("/parts/groups", { code, name, categoryId: cat[c] }));
  }
  const partList = (await get<{ id: string; code: string }[]>("/materials?pageSize=100"));
  const part: Record<string, string> = {};
  const parts: [string, string, string, string, string, Body][] = [
    ["PPWG80-330", "PP white gloss 80 µm / acrylic / glassine 330 mm", "M2", "LS", "PP-WG", { stockForm: "ROLL", widthMm: 330, lengthM: 1000, thicknessMicron: 80, faceFinish: "White gloss PP", adhesive: "Permanent acrylic", liner: "Glassine 60 gsm", coreIdMm: 76, supplierName: "Avery Dennison", supplierPartNo: "AD-PPWG80", certifications: "FDA food contact" }],
    ["PPCL50-330", "PP clear 50 µm / acrylic / PET liner 330 mm", "M2", "LS", "PP-CL", { stockForm: "ROLL", widthMm: 330, lengthM: 1500, thicknessMicron: 50, faceFinish: "Clear PP", adhesive: "Permanent acrylic", liner: "PET 30 µm", coreIdMm: 76, supplierName: "UPM Raflatac", supplierPartNo: "RAF-PPC50" }],
    ["PEW85-250", "PE white 85 µm squeezable / glassine 250 mm", "M2", "LS", "PE-W", { stockForm: "ROLL", widthMm: 250, lengthM: 1000, thicknessMicron: 85, faceFinish: "White PE", adhesive: "Permanent hotmelt", liner: "Glassine 60 gsm", coreIdMm: 76, supplierName: "Avery Dennison", supplierPartNo: "AD-PE85" }],
    ["SGP80-330", "Semi-gloss paper 80 gsm / acrylic 330 mm", "M2", "LS", "PAP-SG", { stockForm: "ROLL", widthMm: 330, lengthM: 2000, gsm: 80, faceFinish: "Semi-gloss paper", adhesive: "Permanent acrylic", liner: "Glassine 60 gsm", coreIdMm: 76, supplierName: "UPM Raflatac", certifications: "FSC" }],
    ["DT-ECO-110", "Direct thermal eco 110 mm", "M2", "LS", "DT-TOP", { stockForm: "ROLL", widthMm: 110, lengthM: 1000, gsm: 75, faceFinish: "Direct thermal", adhesive: "Permanent hotmelt", liner: "Glassine 60 gsm", coreIdMm: 76, supplierName: "Ricoh" }],
    ["BOPP-G-25", "BOPP gloss over-laminate 25 µm 330 mm", "M2", "LAM", "BOPP", { stockForm: "ROLL", widthMm: 330, lengthM: 3000, thicknessMicron: 25, faceFinish: "Gloss", adhesive: "Acrylic", coreIdMm: 76 }],
    ["INK-UV-C", "UV flexo ink cyan", "KG", "INK", "UV-FLX", { colour: "Process cyan", system: "UV", shelfLifeDays: 365, supplierName: "Flint Group" }],
    ["INK-UV-M", "UV flexo ink magenta", "KG", "INK", "UV-FLX", { colour: "Process magenta", system: "UV", shelfLifeDays: 365, supplierName: "Flint Group" }],
    ["INK-UV-Y", "UV flexo ink yellow", "KG", "INK", "UV-FLX", { colour: "Process yellow", system: "UV", shelfLifeDays: 365, supplierName: "Flint Group" }],
    ["INK-UV-K", "UV flexo ink black", "KG", "INK", "UV-FLX", { colour: "Process black", system: "UV", shelfLifeDays: 365, supplierName: "Flint Group" }],
    ["VAR-UV-M", "UV matt varnish", "KG", "VAR", "UV-VAR", { faceFinish: "Matt", system: "UV", shelfLifeDays: 270 }],
    ["FOIL-G-100", "Hot foil gold 100 mm x 300 m", "ROLL", "FOIL", "GOLD", { widthMm: 100, lengthM: 300, colour: "Gold", faceFinish: "Bright", coreIdMm: 25 }],
    ["CORE-76-330", "Paper core 76 mm x 330 mm", "PCS", "CORE", "P-CORE", { coreIdMm: 76, widthMm: 330 }],
    ["CTN-A4", "Carton box 400 x 300 x 300", "PCS", "PKG", "CTN", { widthMm: 400 }],
  ];
  for (const [code, description, uom, c, g, spec] of parts) {
    part[code] = await ensure(partList, code, () => post("/materials", { code, description, uom, categoryId: cat[c], groupId: grp[g], ...spec }));
  }

  // Processes, machine categories, machines (existing codes are reused).
  const procs = await get<{ id: string; code: string }[]>("/planning/processes");
  const proc: Record<string, string> = {};
  for (const [code, name, sequence] of [
    ["PRINT", "Printing", 10],
    ["LAMI", "Lamination", 20],
    ["FOIL", "Hot foil stamping", 25],
    ["DIECUT", "Die Cutting", 30],
    ["SLIT", "Slitting & Rewinding", 40],
  ] as const) {
    proc[code] = await ensure(procs, code, () => post("/planning/processes", { code, name, sequence }));
  }
  const mcats = await get<{ id: string; code: string }[]>("/planning/machine-categories");
  const mcat: Record<string, string> = {};
  for (const [code, name, processes] of [
    ["PRESS", "Flexo press (print + inline lamination / foil)", ["PRINT", "LAMI", "FOIL"]],
    ["DIESTN", "Rotary die-cutting station", ["DIECUT"]],
    ["REWIND", "Slitter rewinder", ["SLIT"]],
  ] as const) {
    mcat[code] = await ensure(mcats, code, () => post("/planning/machine-categories", { code, name, processIds: processes.map((p) => proc[p]) }));
  }
  const machines = await get<{ id: string; code: string }[]>("/planning/machines");
  const mach: Record<string, string> = {};
  for (const [code, name, c] of [
    ["FP-01", "Nilpeter FA-17 (8 colour)", "PRESS"],
    ["FP-02", "Mark Andy P5 (6 colour)", "PRESS"],
    ["DC-01", "Rotary die cutter 1", "DIESTN"],
    ["DC-02", "Rotary die cutter 2", "DIESTN"],
    ["SR-01", "Slitter rewinder 1", "REWIND"],
    ["SR-02", "Slitter rewinder 2", "REWIND"],
  ] as const) {
    mach[code] = await ensure(machines, code, () => post("/planning/machines", { code, name, categoryId: mcat[c] }));
  }

  const routines = await get<{ id: string; code: string }[]>("/shopfloor/routines");
  const routine: Record<string, string> = {};
  for (const [code, name, steps] of [
    ["STD-3", "Print → Die cut → Slit", ["PRINT", "DIECUT", "SLIT"]],
    ["LAM-4", "Print + laminate → Die cut → Slit", ["PRINT", "LAMI", "DIECUT", "SLIT"]],
    ["FOIL-4", "Print + foil → Die cut → Slit", ["PRINT", "FOIL", "DIECUT", "SLIT"]],
  ] as const) {
    routine[code] = await ensure(routines, code, () => post("/shopfloor/routines", { code, name, processIds: steps.map((s) => proc[s]) }));
  }

  const dies = await get<{ id: string; code: string }[]>("/die-cuts?pageSize=100");
  for (const d of [
    { code: "D-1001", description: "80 × 120 rounded, 3 across", dieType: "ROTARY_SOLID", shape: "ROUNDED_RECTANGLE", labelWidthMm: 80, labelHeightMm: 120, cornerRadiusMm: 3, across: 3, around: 2, gapAcrossMm: 3, gapAroundMm: 3.175, gearTeeth: 80, location: "Rack A-1", supplierName: "Rotometrics" },
    { code: "D-1002", description: "100 × 150 shipping, 1 across", dieType: "FLEXIBLE", shape: "ROUNDED_RECTANGLE", labelWidthMm: 100, labelHeightMm: 150, cornerRadiusMm: 2, across: 1, around: 2, gapAcrossMm: 0, gapAroundMm: 3, gearTeeth: 96, location: "Magnetic rack M-2", supplierName: "Kocher+Beck" },
    { code: "D-1003", description: "Ø 60 round, 4 across", dieType: "ROTARY_SOLID", shape: "CIRCLE", labelWidthMm: 60, labelHeightMm: 60, across: 4, around: 4, gapAcrossMm: 3, gapAroundMm: 3, gearTeeth: 80, location: "Rack A-2" },
    { code: "D-1004", description: "50 × 200 tube wrap, 2 across", dieType: "FLEXIBLE", shape: "RECTANGLE", labelWidthMm: 200, labelHeightMm: 50, across: 1, around: 5, gapAroundMm: 3.5, gearTeeth: 88, location: "Magnetic rack M-1", condition: "WORN" },
    { code: "D-0907", description: "70 × 40 rounded (old pharma)", dieType: "FLATBED", shape: "ROUNDED_RECTANGLE", labelWidthMm: 70, labelHeightMm: 40, cornerRadiusMm: 2, across: 4, around: 6, location: "Store B" },
  ]) {
    if (!dies.find((x) => x.code === d.code)) await post("/die-cuts", d);
  }

  for (const [category, code, description] of [
    ["ADDITIONAL_ISSUE", "SETUP", "Extra stock for make-ready / colour matching"],
    ["ADDITIONAL_ISSUE", "SHORT", "Roll shorter than labelled"],
    ["REJECT", "DMG", "Roll damaged (edges / crushed core)"],
    ["REJECT", "ADH", "Adhesive bleed / liner release problem"],
    ["SCRAP", "MKR", "Make-ready waste"],
    ["SCRAP", "WEB", "Web break"],
    ["SCRAP", "REG", "Out of register, cut out"],
  ] as const) {
    const existing = await get<{ code: string }[]>(`/material/reasons?category=${category}`);
    if (!existing.find((r) => r.code === code)) await post("/material/reasons", { category, code, description });
  }

  const defects = await get<{ id: string; code: string }[]>("/qc/defects");
  const defect: Record<string, string> = {};
  for (const [code, name, category, severity, iqc, oqc] of [
    ["PR-01", "Print smudge / ink set-off", "PRINT", "MINOR", false, true],
    ["CL-01", "Colour out of tolerance (ΔE > 2)", "COLOUR", "MAJOR", false, true],
    ["RG-01", "Out of register", "REGISTRATION", "MAJOR", false, true],
    ["DC-01", "Die strike / cut through liner", "DIE_CUT", "MAJOR", false, true],
    ["DC-02", "Matrix not stripped", "DIE_CUT", "MINOR", false, true],
    ["WD-01", "Wrong winding direction", "WINDING", "CRITICAL", false, true],
    ["MX-01", "Mixed labels in roll", "OTHER", "CRITICAL", false, true],
    ["MT-01", "Face stock wrinkles", "MATERIAL", "MAJOR", true, true],
    ["MT-02", "Width out of tolerance", "MATERIAL", "MAJOR", true, false],
    ["AD-01", "Adhesive ooze", "ADHESIVE", "MAJOR", true, true],
    ["PK-01", "Carton damaged / wrong count", "PACKAGING", "MINOR", false, true],
  ] as const) {
    defect[code] = await ensure(defects, code, () => post("/qc/defects", { code, name, category, severity, appliesIqc: iqc, appliesOqc: oqc }));
  }
  const tpls = await get<{ id: string; code: string }[]>("/qc/inspection-templates");
  await ensure(tpls, "IQC-LS", () =>
    post("/qc/inspection-templates", {
      code: "IQC-LS",
      name: "Label stock receiving",
      type: "IQC",
      partCategoryId: cat.LS,
      items: [
        { label: "Supplier CoA received", kind: "PASS_FAIL" },
        { label: "Roll width", kind: "MEASURE", target: "Nominal", min: -1, max: 1, unit: "mm deviation" },
        { label: "Face thickness", kind: "MEASURE", min: -5, max: 5, unit: "µm deviation" },
        { label: "Adhesive tack (loop test)", kind: "PASS_FAIL" },
        { label: "Core / edge damage", kind: "PASS_FAIL", required: false },
      ],
    }),
  );
  await ensure(tpls, "IQC-INK", () =>
    post("/qc/inspection-templates", { code: "IQC-INK", name: "Ink receiving", type: "IQC", partCategoryId: cat.INK, items: [{ label: "Batch within shelf life", kind: "PASS_FAIL" }, { label: "Drawdown vs standard", kind: "MEASURE", min: 0, max: 2, unit: "ΔE" }] }),
  );
  await ensure(tpls, "OQC-STD", () =>
    post("/qc/inspection-templates", {
      code: "OQC-STD",
      name: "Finished roll labels",
      type: "OQC",
      items: [
        { label: "Print vs approved proof", kind: "PASS_FAIL" },
        { label: "Colour", kind: "MEASURE", min: 0, max: 2, unit: "ΔE" },
        { label: "Label width", kind: "MEASURE", min: -0.5, max: 0.5, unit: "mm deviation" },
        { label: "Winding direction as Master Card", kind: "PASS_FAIL" },
        { label: "Labels per roll", kind: "PASS_FAIL" },
        { label: "Barcode grade (if printed)", kind: "PASS_FAIL", required: false },
      ],
    }),
  );
  const ltpls = await get<{ id: string; code: string }[]>("/qc/label-templates");
  const ctnLabel = await ensure(ltpls, "CTN-100", () =>
    post("/qc/label-templates", { code: "CTN-100", name: "Carton label 100 × 75", widthMm: 100, heightMm: 75, fields: ["customerName", "productCode", "productName", "customerRef", "woNo", "lotNo", "qty", "cartonNo", "packedDate"], barcode: "CODE128", barcodeField: "labelNo" }),
  );
  await ensure(ltpls, "PAL-QR", () =>
    post("/qc/label-templates", { code: "PAL-QR", name: "Pallet label with QR 100 × 100", widthMm: 100, heightMm: 100, fields: ["labelNo", "customerName", "customerPartNo", "pjoNo", "lotNo", "qty", "cartonNo"], barcode: "QR", barcodeField: "labelNo" }),
  );

  // ===== Order scenarios (run once) ===========================================
  if (await db.product.findUnique({ where: { productCode: "BP-PCM500" } })) {
    console.log("Order scenarios already loaded – masters checked, nothing else to do.");
  } else {
    console.log("Father Codes, products and Master Cards…");
    const SPEC = { winding: "3", coreMm: 76, maxRollDiameterMm: 300, rollsPerCarton: 12, printMethod: "UV flexo" };
    const fathers = [
      { key: "mango", desc: "Mango Juice 1L – front label", art: ["MANGO JUICE", "1 Litre · Front", "#f59e0b"], lines: [["PPWG80-330", 14], ["INK-UV-C", 0.15], ["INK-UV-M", 0.15], ["INK-UV-Y", 0.3], ["INK-UV-K", 0.1], ["CORE-76-330", 1]], product: ["FG-10501", "Mango Juice 1L front label", "Fresh Valley Sdn Bhd", "FV-MJ1L-F"], routine: "STD-3", spec: { labelWidthMm: 80, labelHeightMm: 120, shape: "Rounded rectangle", cornerRadiusMm: 3, across: 3, gapAcrossMm: 3, gapAroundMm: 3.175, labelsPerRoll: 2000, colours: "CMYK", varnish: "None" } },
      { key: "mangoBack", desc: "Mango Juice 1L – back label", art: ["MANGO JUICE", "1 Litre · Back", "#b45309"], lines: [["PPWG80-330", 12], ["INK-UV-K", 0.1], ["CORE-76-330", 1]], product: ["FG-10502", "Mango Juice 1L back label", "Fresh Valley Sdn Bhd", "FV-MJ1L-B"], routine: "STD-3", spec: { labelWidthMm: 80, labelHeightMm: 100, shape: "Rounded rectangle", cornerRadiusMm: 3, across: 3, gapAcrossMm: 3, gapAroundMm: 3, labelsPerRoll: 2000, colours: "Black" } },
      { key: "pharma", desc: "Paracetamol 500 mg – bottle label", art: ["PARACETAMOL", "500 mg · 100 tablets", "#0f766e"], lines: [["SGP80-330", 9], ["INK-UV-C", 0.08], ["INK-UV-K", 0.1], ["VAR-UV-M", 0.2], ["CORE-76-330", 1]], product: ["BP-PCM500", "Paracetamol 500mg bottle label", "Borneo Pharma Sdn Bhd", "BPH-PCM-500-L"], routine: "STD-3", spec: { labelWidthMm: 70, labelHeightMm: 40, shape: "Rounded rectangle", cornerRadiusMm: 2, across: 4, gapAcrossMm: 3, gapAroundMm: 3, labelsPerRoll: 5000, colours: "Cyan + black", varnish: "UV matt" } },
      { key: "aloe", desc: "Aloe Gel 200 ml – tube label (gold foil)", art: ["ALOE GEL", "200 ml · Soothing", "#15803d"], lines: [["PEW85-250", 11], ["BOPP-G-25", 11], ["FOIL-G-100", 0.02], ["INK-UV-C", 0.1], ["INK-UV-Y", 0.12], ["CORE-76-330", 1]], product: ["KLC-ALOE200", "Aloe gel 200ml tube label", "KL Cosmetics Sdn Bhd", "KLC-AG200"], routine: "FOIL-4", spec: { labelWidthMm: 200, labelHeightMm: 50, shape: "Rectangle", across: 1, gapAroundMm: 3.5, labelsPerRoll: 1500, colours: "CMY + gold foil", varnish: "Gloss laminate" } },
      { key: "ship", desc: "Shipping label 100 × 150 – direct thermal blank", art: ["SHIPPING LABEL", "100 × 150 · Direct thermal", "#334155"], lines: [["DT-ECO-110", 16], ["CORE-76-330", 1]], product: ["MLG-DT100150", "Shipping label 100x150 DT blank", "MyLogistics Sdn Bhd", "MLG-SL-100150"], routine: "STD-3", spec: { labelWidthMm: 100, labelHeightMm: 150, shape: "Rounded rectangle", cornerRadiusMm: 2, across: 1, gapAroundMm: 3, labelsPerRoll: 500, colours: "Blank" } },
    ];
    const bom: Record<string, string> = {};
    for (const f of fathers) {
      const fileId = await artwork(f.art[0]!, f.art[1]!, f.art[2]!);
      const created = await post<{ id: string }>("/boms", { fileId, labelDescription: f.desc });
      bom[f.key] = created.id;
      await post(`/boms/${created.id}/son-codes`, { lines: f.lines.map(([code, qty]) => ({ materialId: part[code as string], quantity: qty })) });
      const [productCode, name, customerName, customerPartNo] = f.product;
      // The finished label is a Part Master item; its Artwork No. (Father Code) gets the Master Card.
      const fgPart = await post<{ product: { id: string } }>("/materials", { code: productCode, description: name, uom: "PCS", partType: "FINISHED_GOOD", bomId: created.id, source: "Manufactured" });
      const p = { id: fgPart.product.id };
      const card = await post<{ id: string }>(`/products/${p.id}/cards`);
      await patch(`/products/${p.id}/cards/${card.id}`, { spec: { ...SPEC, ...f.spec, customerCode: customerName, customerPartCode: customerPartNo }, routineId: routine[f.routine], changeNote: "First issue" });
      // The aloe tube card stays a draft (waiting for customer approval).
      if (f.key !== "aloe") await post(`/products/${p.id}/cards/${card.id}/release`);
      console.log(`  ${productCode} · ${f.desc}${f.key === "aloe" ? " (Master Card draft)" : ""}`);
    }

    console.log("Production orders, shopfloor, material and QC…");
    const pjo = async (key: string, qty: number, customerRef: string, offset: number, priority = "NORMAL", release = true) => {
      const r = await post<{ id: string; pjoNo: string }>("/planning/production-job-orders", { bomId: bom[key], orderQty: qty, uom: "PCS", customerRef, requiredDate: day(offset), priority });
      if (release) await post(`/planning/production-job-orders/${r.id}/release`);
      return r;
    };
    const jo = async (pjoId: string, quantity: number, offset: number, release = true) => {
      const r = await post<{ id: string; woNo: string }>("/planning/work-orders", { pjoId, quantity, plannedDate: day(offset) });
      if (release) await post(`/planning/work-orders/${r.id}/release`);
      return r;
    };
    /** Run one route step on a machine: check in, check out. */
    const run = async (woId: string, machine: string, good: number, reject = 0, remarks = "Step done", type = "COMPLETED") => {
      const s = await post<{ sessionId: string }>("/shopfloor/check-in", { machineId: mach[machine], workOrderId: woId, clientTxnId: txn() });
      await post(`/shopfloor/sessions/${s.sessionId}/check-out`, { type, totalGood: good, totalReject: reject, remarks, clientTxnId: txn() });
    };
    const mrsFor = async (woId: string, factor: number) => {
      const tpl = await get<{ lines: { sonCodeId: string; bomQty: string | null }[] }>(`/material/work-orders/${woId}/mrs-template`);
      const m = await post<{ id: string; mrsNo: string }>("/material/requisitions", { workOrderId: woId, lines: tpl.lines.map((l) => ({ sonCodeId: l.sonCodeId, requestedQty: Math.max(1, Math.round(Number(l.bomQty ?? 1) * factor)) })) });
      const detail = await get<{ lines: { id: string; requested: string; materialCode: string }[] }>(`/material/requisitions/${m.id}`);
      return { ...m, lines: detail.lines };
    };
    const reason = async (category: string, code: string) => (await get<{ id: string; code: string }[]>(`/material/reasons?category=${category}`)).find((r) => r.code === code)!.id;
    const oqcPass = (n: number) => ({ results: Array.from({ length: n }, (_, index) => ({ index, pass: true, value: index === 1 ? 1.2 : index === 2 ? 0.1 : null })) });

    // 1) Mango front: 60,000 ordered. JO-a 30,000 done, OQC passed, labelled. JO-b 30,000 running at die cutting.
    const p1 = await pjo("mango", 60000, "FV-PO-4471", 10, "HIGH");
    const j1 = await jo(p1.id, 30000, -2);
    const m1 = await mrsFor(j1.id, 30);
    for (const l of m1.lines) await post(`/material/lines/${l.id}/issue`, { qty: Number(l.requested), lotRef: l.materialCode.startsWith("PP") ? "AD-24-1187" : null, clientTxnId: txn() });
    const face1 = m1.lines.find((l) => l.materialCode === "PPWG80-330")!;
    await post(`/material/lines/${face1.id}/additional-issue`, { qty: 25, reasonCodeId: await reason("ADDITIONAL_ISSUE", "SETUP"), lotRef: "AD-24-1187", clientTxnId: txn() });
    await run(j1.id, "FP-01", 30000, 250);
    await post(`/material/lines/${face1.id}/scrap`, { qty: 18, reasonCodeId: await reason("SCRAP", "MKR"), machineId: mach["FP-01"], clientTxnId: txn() });
    await run(j1.id, "DC-01", 29850, 150, "150 cut out at start-up");
    await run(j1.id, "SR-01", 29700, 150, "Splice rolls removed");
    await post(`/material/lines/${face1.id}/return`, { qty: 12, lotRef: "AD-24-1187", clientTxnId: txn() });
    await post(`/planning/work-orders/${j1.id}/complete`, { note: "29,700 good, within over / under allowance." });
    const o1 = await post<{ id: string }>("/qc/oqc", { workOrderId: j1.id, qty: 29700, sampleSize: 200 });
    await post(`/qc/inspections/${o1.id}/check-out`, { ...oqcPass(6), defects: [{ defectCodeId: defect["DC-02"], qty: 3, remark: "Matrix tags on 3 rolls, removed" }] });
    const lbl = await post<{ ids: string[] }>("/qc/labels", { inspectionId: o1.id, templateId: ctnLabel, totalQty: 24000, qtyPerCarton: 4000 });
    await post("/qc/labels/print", { ids: lbl.ids });
    const j2 = await jo(p1.id, 30000, 1);
    await mrsFor(j2.id, 30).then((m) => post(`/material/lines/${m.lines[0]!.id}/issue`, { qty: Number(m.lines[0]!.requested), lotRef: "AD-24-1192", clientTxnId: txn() }));
    await run(j2.id, "FP-02", 30000, 200);
    await post("/shopfloor/check-in", { machineId: mach["DC-02"], workOrderId: j2.id, clientTxnId: txn() }); // running now

    // 2) Mango back: 50,000 completed, OQC passed, PJO closed through the Complete Utility.
    const p2 = await pjo("mangoBack", 50000, "FV-PO-4472", -3);
    const j3 = await jo(p2.id, 50000, -6);
    const m3 = await mrsFor(j3.id, 50);
    for (const l of m3.lines) await post(`/material/lines/${l.id}/issue`, { qty: Number(l.requested), clientTxnId: txn() });
    await run(j3.id, "FP-02", 50000, 300);
    await run(j3.id, "DC-01", 49800, 200, "Die strike at a splice");
    await run(j3.id, "SR-02", 49650, 150, "Core ends");
    await post(`/planning/work-orders/${j3.id}/complete`, { note: "49,650 good." });
    const o3 = await post<{ id: string }>("/qc/oqc", { workOrderId: j3.id, qty: 49650, sampleSize: 315 });
    await post(`/qc/inspections/${o3.id}/check-out`, oqcPass(6));
    await post("/qc/labels", { inspectionId: o3.id, templateId: ctnLabel, totalQty: 49650, qtyPerCarton: 5000 }).then((r) => post("/qc/labels/print", { ids: (r as { ids: string[] }).ids }));
    await post(`/planning/completion/${p2.id}/complete`, { override: true, note: "Customer accepted 49,650 (within 1 % under-run)." });

    // 3) Paracetamol: 40,000 released, Job Order planned for tomorrow, MRS partly issued.
    const p3 = await pjo("pharma", 40000, "BPH-PO-2211", 7);
    const j4 = await jo(p3.id, 40000, 1);
    const m4 = await mrsFor(j4.id, 40);
    await post(`/material/lines/${m4.lines[0]!.id}/issue`, { qty: Math.round(Number(m4.lines[0]!.requested) / 2), lotRef: "UPM-55102", clientTxnId: txn() });

    // 4) Shipping labels: printed short; OQC found wrong winding -> waits for disposition.
    const p4 = await pjo("ship", 20000, "MLG-PO-0098", 3, "URGENT");
    const j5 = await jo(p4.id, 20000, -1);
    await mrsFor(j5.id, 20).then(async (m) => {
      for (const l of m.lines) await post(`/material/lines/${l.id}/issue`, { qty: Number(l.requested), clientTxnId: txn() });
      await post(`/material/lines/${m.lines[0]!.id}/reject`, { qty: 15, reasonCodeId: await reason("REJECT", "DMG"), lotRef: "RIC-8812", clientTxnId: txn() });
    });
    await run(j5.id, "FP-01", 19800, 200, "Short 200: make-ready");
    await run(j5.id, "DC-01", 19700, 100, "Short 100");
    await run(j5.id, "SR-01", 19500, 200, "Short 500: web break on the slitter");
    await post(`/planning/work-orders/${j5.id}/complete`, { note: "Short 500 after web break." });
    const o5 = await post<{ id: string }>("/qc/oqc", { workOrderId: j5.id, qty: 19500, sampleSize: 125 });
    await post(`/qc/inspections/${o5.id}/check-out`, { results: [{ index: 0, pass: true }, { index: 1, value: 0.5 }, { index: 2, value: 0.2 }, { index: 3, pass: false, note: "Wound out, card says in" }, { index: 4, pass: true }], defects: [{ defectCodeId: defect["WD-01"], qty: 39, remark: "39 rolls" }] });

    // 5) Aloe tube: no order yet – its Master Card is still a draft.
    // 6) A second paracetamol order, draft.
    await pjo("pharma", 20000, "BPH-PO-2240", 28, "LOW", false);

    // IQC lots: passed, failed (waiting), in inspection, returned.
    const i1 = await post<{ id: string }>("/qc/iqc", { materialId: part["PPWG80-330"], lotRef: "AD-24-1187", qty: 2000, deliveryRef: "DO-AD-55120", sampleSize: 3 });
    await post(`/qc/inspections/${i1.id}/check-out`, { results: [{ index: 0, pass: true }, { index: 1, value: 0.3 }, { index: 2, value: 1 }, { index: 3, pass: true }, { index: 4, pass: true }] });
    const i2 = await post<{ id: string }>("/qc/iqc", { materialId: part["SGP80-330"], lotRef: "UPM-55102", qty: 3000, deliveryRef: "DO-UPM-8841" });
    await post(`/qc/inspections/${i2.id}/check-out`, { results: [{ index: 0, pass: true }, { index: 1, value: 1.6 }, { index: 2, value: 2 }, { index: 3, pass: true }], defects: [{ defectCodeId: defect["MT-02"], qty: 2, remark: "2 rolls 1.6 mm narrow" }] });
    await post("/qc/iqc", { materialId: part["INK-UV-M"], lotRef: "FG-M-24117", qty: 20, deliveryRef: "DO-FG-0412" });
    const i4 = await post<{ id: string }>("/qc/iqc", { materialId: part["DT-ECO-110"], lotRef: "RIC-8812", qty: 1500, deliveryRef: "DO-RIC-2201" });
    await post(`/qc/inspections/${i4.id}/check-out`, { results: [{ index: 0, pass: false, note: "No CoA" }, { index: 1, value: 0.2 }, { index: 2, value: 0 }, { index: 3, pass: true }], rejectQty: 1500, defects: [{ defectCodeId: defect["AD-01"], qty: 1 }] });
    await post(`/qc/inspections/${i4.id}/disposition`, { disposition: "RETURN_TO_SUPPLIER", note: "No CoA and adhesive ooze; supplier collects" });
  }

  // ===== Top-up (safe to rerun): TBS Part Master data and full Master Card sections ===
  console.log("Part Master data and Master Card sections…");
  const dieList = await get<{ id: string; code: string }[]>("/die-cuts?pageSize=100");
  const dieId = (code: string) => dieList.find((d) => d.code === code)?.id;
  const ENRICH: Record<string, { nmi: string; die: string; endUser: string; afrf: Body; machines: [string, string][]; speed: number }> = {
    "FG-10501": { nmi: "NMI-24-0101", die: "D-1001", endUser: "Fresh Valley retail", afrf: { afrfMaterial: "PP white gloss 80 µm", afrfColor: "CMYK", afrfForm: "Roll", printingDirection: "Head first, wound out (3)", packingInstruction: "12 rolls per carton, cartons shrink-wrapped", specialInstruction: "Colour to approved proof FV-0425 ±ΔE 2" }, machines: [["PRESS", "FP-01"], ["DIESTN", "DC-01"], ["REWIND", "SR-01"]], speed: 60 },
    "FG-10502": { nmi: "NMI-24-0102", die: "D-1001", endUser: "Fresh Valley retail", afrf: { afrfMaterial: "PP white gloss 80 µm", afrfColor: "Black", afrfForm: "Roll", printingDirection: "Head first, wound out (3)", packingInstruction: "12 rolls per carton" }, machines: [["PRESS", "FP-02"], ["DIESTN", "DC-01"], ["REWIND", "SR-02"]], speed: 70 },
    "BP-PCM500": { nmi: "NMI-24-0217", die: "D-0907", endUser: "Hospitals and clinics", afrf: { afrfMaterial: "Semi-gloss paper 80 gsm", afrfColor: "Cyan + black, UV matt varnish", afrfForm: "Roll", printingDirection: "Foot first", specialInstruction: "Batch / expiry area left unvarnished for thermal overprint" }, machines: [["PRESS", "FP-01"], ["DIESTN", "DC-01"], ["REWIND", "SR-01"]], speed: 50 },
    "MLG-DT100150": { nmi: "NMI-24-0330", die: "D-1002", endUser: "E-commerce couriers", afrf: { afrfMaterial: "Direct thermal eco", afrfColor: "Blank", afrfForm: "Roll", printingDirection: "Wound out", packingInstruction: "500 labels per roll, 24 rolls per carton" }, machines: [["PRESS", "FP-02"], ["DIESTN", "DC-01"], ["REWIND", "SR-02"]], speed: 80 },
    "KLC-ALOE200": { nmi: "NMI-24-0412", die: "D-1004", endUser: "KL Cosmetics consumers", afrf: { afrfMaterial: "PE white 85 µm + BOPP gloss laminate", afrfColor: "CMY + gold foil", afrfForm: "Roll", printingDirection: "Wound in (4)", specialInstruction: "Squeeze test after lamination" }, machines: [["PRESS", "FP-01"], ["PRESS", "FP-01"], ["DIESTN", "DC-01"], ["REWIND", "SR-01"]], speed: 40 },
  };
  for (const [code, e] of Object.entries(ENRICH)) {
    const part = await db.material.findUnique({ where: { code }, include: { product: true } });
    if (!part?.product) continue;
    if (!part.nmiNo) await patch(`/materials/${part.id}`, { nmiNo: e.nmi, specification: `${part.description}. Customer artwork per Master Card.`, pcsPerRoll: 2000, packQty: 12, cartonsPerPallet: 40, materialType: "Self-adhesive label", tariffCode: "4821.10.1000", leadTimeDays: 10, overReceivePct: 5 });
    const detail = await get<{ released: { spec: Body; revisionNo: number } | null; draft: { id: string; spec: Body } | null }>(`/products/${part.product.id}`);
    const base = detail.draft?.spec ?? detail.released?.spec;
    if (!base || base.dieCutId) continue;
    const pr = await db.product.findUniqueOrThrow({ where: { id: part.product.id }, include: { cards: { where: { status: { in: ["RELEASED", "DRAFT"] } }, include: { routine: { include: { steps: { orderBy: { seq: "asc" } } } } } } } });
    const card = pr.cards.find((c) => c.status === "DRAFT") ?? pr.cards.find((c) => c.status === "RELEASED");
    const steps = card?.routine?.steps ?? [];
    const spec = {
      ...base,
      customerCode: base.customerCode ?? pr.customerName ?? undefined,
      customerPartCode: base.customerPartCode ?? pr.customerPartNo ?? undefined,
      endUser: e.endUser,
      ...e.afrf,
      supplierCode: "IN-HOUSE",
      dieCutId: dieId(e.die),
      sampleCount: 2,
      processDetail: steps.map((st, i) => {
        const [c, m] = e.machines[i] ?? e.machines[e.machines.length - 1]!;
        return { seq: st.seq, machineCategoryId: mcat[c], defaultMachineId: mach[m], setupMins: i === 0 ? 45 : 20, outputPerPress: i === 0 ? 6 : null, noOfPrint: i === 0 ? 4 : null, speed: e.speed, speedUom: "m/min" };
      }),
      printingMachines: [{ machineCategoryId: mcat.PRESS, machineId: mach["FP-01"], noOfPrint: 8, setupMins: 45, outputPerPress: 6, speed: 60 }, { machineCategoryId: mcat.PRESS, machineId: mach["FP-02"], noOfPrint: 6, setupMins: 40, outputPerPress: 6, speed: 55 }],
    };
    const draftId = detail.draft?.id ?? (await post<{ id: string }>(`/products/${part.product.id}/cards`)).id;
    await patch(`/products/${part.product.id}/cards/${draftId}`, { spec, changeNote: "TBS sections: header, AFRF-CS, die cut spec, process detail" });
    // The aloe card stays a draft (customer approval pending); the others go to production.
    if (code !== "KLC-ALOE200") await post(`/products/${part.product.id}/cards/${draftId}/release`);
    console.log(`  ${code}: Master Card sections ${code === "KLC-ALOE200" ? "added to the draft" : "released as a new revision"}`);
  }
  // A few raw parts with TBS shipping data and manual Location Qty.
  for (const [code, data, locs] of [
    ["PPWG80-330", { nmiNo: "NMI-RM-0001", pcsPerRoll: 1, reorderLevel: 4000, reorderQty: 10000, maxQty: 30000, leadTimeDays: 21, overReceivePct: 5, customCode: "3919.90.9000", controlPoint: "Store A" }, [["WH1", "A-01-01", "R1", "AD-24-1187", 6600, 0], ["WH1", "A-01-02", "R2", "AD-24-1192", 3300, 330]]],
    ["SGP80-330", { nmiNo: "NMI-RM-0002", reorderLevel: 3000, reorderQty: 8000, leadTimeDays: 14, overReceivePct: 3 }, [["WH1", "A-02-01", "R1", "UPM-55102", 4950, 0]]],
    ["PEW85-250", { nmiNo: "NMI-RM-0003", requireIqc: true, reorderLevel: 2000, leadTimeDays: 28 }, []],
    ["INK-UV-C", { nmiNo: "NMI-RM-0010", reorderLevel: 20, reorderQty: 50, leadTimeDays: 7 }, [["WH2", "INK-01", null, "FG-C-24101", 35, 0]]],
  ] as [string, Body, [string, string, string | null, string, number, number][]][]) {
    const part = await db.material.findUnique({ where: { code }, include: { locations: true } });
    if (!part || part.nmiNo) continue;
    await patch(`/materials/${part.id}`, data);
    if (!part.locations.length) for (const [warehouseCode, locationCode, shelfLocation, lotNo, qty, doHoldQty] of locs) await post(`/materials/${part.id}/locations`, { warehouseCode, locationCode, shelfLocation, lotNo, qty, doHoldQty });
    await call("put", `/materials/${part.id}/uom-conversions`, { items: code.startsWith("INK") ? [{ uom: "BOX", factor: 5, remark: "5 kg tin" }] : [{ uom: "ROLL", factor: Number(part.widthMm ?? 330) / 1000 * Number(part.lengthM ?? 1000), remark: "Full roll" }] });
  }

  const counts = {
    parts: await db.material.count(),
    fatherCodes: await db.bom.count(),
    products: await db.product.count(),
    pjos: await db.productionJobOrder.count(),
    jobOrders: await db.workOrder.count(),
    sessions: await db.productionSession.count(),
    mrs: await db.materialRequisition.count(),
    movements: await db.materialTransaction.count(),
    inspections: await db.qcInspection.count(),
    labels: await db.shippingLabel.count(),
    dies: await db.dieCut.count(),
  };
  console.log("Done.", counts);
} finally {
  await db.$disconnect();
}
