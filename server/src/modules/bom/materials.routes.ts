import { Router } from "express";
import { z } from "zod";
import type { Prisma } from "../../generated/prisma/client";
import type { Deps } from "../../deps";
import { errors } from "../../lib/errors";
import { body, idParam, ok, pageMeta, params, query } from "../../lib/http";
import type { Tx } from "../../lib/prisma";
import { D, isQtyInput, q } from "../../lib/qty";
import { requirePermission } from "../../middleware/auth";
import { requireUser } from "../../middleware/context";
import { diff, recordAudit } from "../audit/audit.service";
import { code, dec, measure, statusSchema, text, wholeNumber } from "../masterdata/fields";
import { fileView } from "./files.routes";
import { createProduct, syncProductFromPart } from "./product.service";
import { UOM_CODES, UOMS } from "./uom";

/**
 * Part Master (table "materials", mounted at /materials): every item code –
 * raw materials, packaging, and finished labels. A finished-good part's
 * Artwork No. is its Father Code (one each); giving it one creates the record
 * that holds its Master Card revisions. Sections follow TBS: General,
 * Engineering, Shipping, UOM Conversion, Others, Location Qty.
 *
 * - Revision No. rises (with Date Revised) when the description,
 *   specification, unit or engineering / technical data change.
 * - Obsolete = deactivated: it can't be used for new Son Codes or IQC.
 * - Stock (Location Qty, reorder, DO hold) is keyed in by hand until the WMS
 *   integration; nothing in this system moves it.
 * - Require IQC: an issue of this part needs a lot that passed IQC.
 */
const amount = z
  .union([z.number(), z.string(), z.null()])
  .optional()
  .transform((v) => (v === undefined ? undefined : v === null || String(v).trim() === "" ? null : String(v).trim()))
  .refine((v) => v == null || isQtyInput(v), "Enter a number (max 4 decimals)");
const pct = z
  .union([z.number(), z.string(), z.null()])
  .optional()
  .transform((v) => (v === undefined ? undefined : v === null || String(v).trim() === "" ? null : Number(v)))
  .refine((v) => v == null || (Number.isFinite(v) && v >= 0 && v <= 100), "Enter 0 to 100");

const specShape = {
  stockForm: z.enum(["ROLL", "SHEET", "FANFOLD", "UNIT"]).nullable().optional(),
  widthMm: measure(8, 2, "the width in mm"),
  lengthM: measure(10, 2, "the length in m"),
  thicknessMicron: measure(7, 1, "the thickness in µm"),
  gsm: measure(7, 1, "the gsm"),
  faceFinish: text(80),
  adhesive: text(80),
  liner: text(80),
  coreIdMm: measure(5, 1, "the core inner diameter in mm"),
  colour: text(60),
  system: text(40),
  supplierName: text(120),
  supplierPartNo: text(60),
  shelfLifeDays: wholeNumber(1, 3650, "the shelf life in days"),
  certifications: text(120),
};
const engineeringShape = {
  pcsPerRoll: amount,
  packQty: amount,
  cartonsPerPallet: wholeNumber(1, 100_000, "cartons per pallet"),
  materialType: text(60),
  measureHMm: measure(8, 2, "the height in mm"),
  measureWMm: measure(8, 2, "the width in mm"),
  measureLMm: measure(8, 2, "the length in mm"),
  decisionCost: amount,
  tariffCode: text(30),
};
const shippingShape = {
  reorderLevel: amount,
  reorderQty: amount,
  maxQty: amount,
  leadTimeDays: wholeNumber(0, 3650, "the lead time in days"),
  overReceivePct: pct,
  customCode: text(30),
  obsolete: z.boolean().optional(),
  requireIqc: z.boolean().optional(),
  controlPoint: text(60),
};
const PART_TYPES = ["RAW_MATERIAL", "FINISHED_GOOD", "SEMI_FINISHED", "PACKAGING", "CONSUMABLE"] as const;
const baseShape = {
  description: z.string().trim().min(1, "Enter the description").max(255),
  uom: z.enum(UOM_CODES, { message: "Choose a unit" }),
  partType: z.enum(PART_TYPES).optional(),
  bomId: z.uuid({ message: "Choose the Artwork No. (Father Code)" }).nullable().optional(),
  nmiNo: text(40),
  specification: text(1000),
  source: text(40),
  categoryId: z.uuid({ message: "Choose a category" }).nullable().optional(),
  groupId: z.uuid({ message: "Choose a group" }).nullable().optional(),
  imageFileId: z.uuid().nullable().optional(),
  remarks: text(500),
  ...specShape,
  ...engineeringShape,
  ...shippingShape,
};
const createSchema = z.object({ code: code(40, "part code"), ...baseShape });
const updateSchema = z.object(baseShape).partial();
const listSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
  q: z.string().trim().max(100).optional(),
  status: z.enum(["ACTIVE", "INACTIVE"]).optional(),
  partType: z.enum(PART_TYPES).optional(),
  categoryId: z.uuid().optional(),
  groupId: z.uuid().optional(),
  sort: z.enum(["code:asc", "code:desc", "description:asc", "description:desc", "updatedAt:desc"]).default("code:asc"),
});

/** Changes to these raise the part's Revision No. */
const REVISION_KEYS = ["description", "specification", "uom", ...Object.keys(specShape), ...Object.keys(engineeringShape)];
const DECIMALS = ["widthMm", "lengthM", "thicknessMicron", "gsm", "coreIdMm", "pcsPerRoll", "packQty", "measureHMm", "measureWMm", "measureLMm", "decisionCost", "reorderLevel", "reorderQty", "maxQty", "overReceivePct"] as const;

const PART_INCLUDE = {
  category: { select: { id: true, code: true, name: true, kind: true, status: true } },
  group: { select: { id: true, code: true, name: true, status: true } },
  bom: { select: { id: true, fatherCode: true, labelDescription: true } },
  product: { select: { id: true, currentCardRevNo: true } },
  image: true,
} as const;
type PartRow = Prisma.MaterialGetPayload<{ include: typeof PART_INCLUDE }>;

type Dec = { toString(): string } | null;
/** Decimals as canonical strings ("80.00" -> "80") so audit diffs compare cleanly. */
function plain<T extends Record<string, unknown>>(m: T) {
  const out: Record<string, unknown> = { ...m };
  for (const k of DECIMALS) if (k in out) out[k] = k === "overReceivePct" ? (out[k] == null ? null : Number((out[k] as Dec)!.toString())) : dec(out[k] as Dec);
  return out;
}
const partView = (m: PartRow, names: Map<string, string> = new Map()) => {
  const { image, ...rest } = m;
  return {
    ...plain(rest),
    image: image ? fileView(image) : null,
    updatedBy: m.updatedById ? (names.get(m.updatedById) ?? null) : null,
    obsoleteBy: m.obsoleteById ? (names.get(m.obsoleteById) ?? null) : null,
  };
};

/** The group must sit in the category; a newly chosen category or group must be active. */
async function checkClassification(tx: Tx, next: { categoryId: string | null; groupId: string | null }, current?: { categoryId: string | null; groupId: string | null }) {
  if (next.groupId && !next.categoryId) throw errors.validation([{ path: "categoryId", message: "Choose the category of this group" }]);
  if (next.categoryId && next.categoryId !== current?.categoryId) {
    const c = await tx.partCategory.findUnique({ where: { id: next.categoryId } });
    if (!c || c.status !== "ACTIVE") throw errors.validation([{ path: "categoryId", message: "Choose an active category" }]);
  }
  if (next.groupId) {
    const g = await tx.partGroup.findUnique({ where: { id: next.groupId } });
    if (!g || g.categoryId !== next.categoryId) throw errors.validation([{ path: "groupId", message: "This group belongs to another category" }]);
    if (g.status !== "ACTIVE" && next.groupId !== current?.groupId) throw errors.validation([{ path: "groupId", message: "Choose an active group" }]);
  }
}

async function checkUnique(tx: Tx, id: string | null, nmiNo: string | null | undefined) {
  if (!nmiNo) return;
  const other = await tx.material.findUnique({ where: { nmiNo } });
  if (other && other.id !== id) throw errors.validation([{ path: "nmiNo", message: `NMI No. ${nmiNo} is already used by ${other.code}` }]);
}

/** One Father Code is the Artwork No. of one finished-good part. */
async function checkArtwork(tx: Tx, id: string | null, bomId: string | null | undefined) {
  if (!bomId) return;
  const bom = await tx.bom.findUnique({ where: { id: bomId }, include: { finishedPart: { select: { id: true, code: true } } } });
  if (!bom) throw errors.validation([{ path: "bomId", message: "Choose a Father Code" }]);
  if (bom.status !== "ACTIVE") throw errors.validation([{ path: "bomId", message: `${bom.fatherCode} is inactive` }]);
  if (bom.finishedPart && bom.finishedPart.id !== id) throw errors.validation([{ path: "bomId", message: `${bom.fatherCode} already belongs to part ${bom.finishedPart.code}. One Father Code belongs to one finished-good part.` }]);
}

async function attachImage(tx: Tx, fileId: string | null | undefined, now: Date) {
  if (!fileId) return;
  const f = await tx.storedFile.findUnique({ where: { id: fileId } });
  if (!f || f.previewKind !== "image") throw errors.validation([{ path: "imageFileId", message: "Upload an image (PNG / JPG)" }]);
  if (!f.attachedAt) await tx.storedFile.update({ where: { id: fileId }, data: { attachedAt: now } });
}

export function materialRoutes(deps: Deps) {
  const r = Router();
  const { db } = deps;

  async function names(ids: (string | null | undefined)[]) {
    const unique = [...new Set(ids.filter((x): x is string => !!x))];
    const users = unique.length ? await db.user.findMany({ where: { id: { in: unique } }, select: { id: true, fullName: true } }) : [];
    return new Map(users.map((u) => [u.id, u.fullName]));
  }

  r.get("/uoms", requirePermission("bom.view"), (_req, res) => {
    res.json(ok(UOMS));
  });

  r.get("/", requirePermission("bom.view"), async (req, res) => {
    const q0 = query(req, listSchema);
    const [field, dir] = q0.sort.split(":") as [string, "asc" | "desc"];
    const where: Prisma.MaterialWhereInput = {
      ...(q0.status ? { status: q0.status } : {}),
      ...(q0.partType ? { partType: q0.partType } : {}),
      ...(q0.categoryId ? { categoryId: q0.categoryId } : {}),
      ...(q0.groupId ? { groupId: q0.groupId } : {}),
      ...(q0.q
        ? { OR: [{ code: { contains: q0.q } }, { description: { contains: q0.q } }, { nmiNo: { contains: q0.q } }, { supplierPartNo: { contains: q0.q } }, { supplierName: { contains: q0.q } }, { bom: { fatherCode: { contains: q0.q } } }] }
        : {}),
    };
    const [total, rows] = await Promise.all([
      db.material.count({ where }),
      db.material.findMany({ where, orderBy: { [field]: dir }, skip: (q0.page - 1) * q0.pageSize, take: q0.pageSize, include: { ...PART_INCLUDE, locations: { select: { qty: true, doHoldQty: true } } } }),
    ]);
    const usage = await db.bomSonCode.groupBy({ by: ["materialId"], where: { materialId: { in: rows.map((m) => m.id) }, status: "ACTIVE" }, _count: { _all: true } });
    const usedBy = new Map(usage.map((u) => [u.materialId, u._count._all]));
    const who = await names(rows.flatMap((m) => [m.updatedById, m.obsoleteById]));
    res.json(
      ok(
        rows.map(({ locations, ...m }) => ({
          ...partView(m, who),
          activeSonCodes: usedBy.get(m.id) ?? 0,
          stockQty: q(locations.reduce((s, l) => s.plus(D(l.qty)), D(0))),
          holdQty: q(locations.reduce((s, l) => s.plus(D(l.doHoldQty)), D(0))),
        })),
        pageMeta(q0.page, q0.pageSize, total),
      ),
    );
  });

  /** Picker: active parts (not finished goods) matching code or description, codes first. */
  r.get("/lookup", requirePermission("bom.view"), async (req, res) => {
    const { q: term } = query(req, z.object({ q: z.string().trim().max(60).default("") }));
    const rows = await db.material.findMany({
      where: { status: "ACTIVE", partType: { not: "FINISHED_GOOD" }, ...(term ? { OR: [{ code: { startsWith: term } }, { code: { contains: term } }, { description: { contains: term } }] } : {}) },
      orderBy: { code: "asc" },
      take: 20,
      select: { id: true, code: true, description: true, uom: true, category: { select: { name: true } } },
    });
    const up = term.toUpperCase();
    rows.sort((a, b) => Number(!a.code.startsWith(up)) - Number(!b.code.startsWith(up)));
    res.json(ok(rows.map((m) => ({ ...m, category: m.category?.name ?? null }))));
  });

  r.get("/:id", requirePermission("bom.view"), async (req, res) => {
    const { id } = params(req, idParam);
    const m = await db.material.findUnique({
      where: { id },
      include: { ...PART_INCLUDE, uomConversions: { orderBy: { uom: "asc" } }, locations: { orderBy: [{ warehouseCode: "asc" }, { locationCode: "asc" }] } },
    });
    if (!m) throw errors.notFound("Part");
    const { uomConversions, locations, ...rest } = m;
    const who = await names([m.updatedById, m.obsoleteById, ...locations.map((l) => l.updatedById)]);
    const sonCodes = await db.bomSonCode.count({ where: { materialId: id, status: "ACTIVE" } });
    res.json(
      ok({
        ...partView(rest, who),
        activeSonCodes: sonCodes,
        uomConversions: uomConversions.map((c) => ({ id: c.id, uom: c.uom, factor: D(c.factor).toString(), remark: c.remark })),
        locations: locations.map((l) => ({ id: l.id, warehouseCode: l.warehouseCode, locationCode: l.locationCode, shelfLocation: l.shelfLocation, lotNo: l.lotNo, doHoldQty: q(l.doHoldQty), qty: q(l.qty), updatedAt: l.updatedAt, updatedBy: who.get(l.updatedById) ?? null })),
      }),
    );
  });

  r.post("/", requirePermission("bom.material.manage"), async (req, res) => {
    const user = requireUser(req);
    const input = body(req, createSchema);
    const now = deps.now();
    const part = await db.$transaction(async (tx) => {
      if (await tx.material.findUnique({ where: { code: input.code } })) throw errors.validation([{ path: "code", message: "This part code already exists" }]);
      const partType = input.partType ?? "RAW_MATERIAL";
      if (input.bomId && partType !== "FINISHED_GOOD") throw errors.validation([{ path: "bomId", message: "Only finished-good parts have an Artwork No." }]);
      await checkClassification(tx, { categoryId: input.categoryId ?? null, groupId: input.groupId ?? null });
      await checkUnique(tx, null, input.nmiNo);
      await checkArtwork(tx, null, input.bomId);
      await attachImage(tx, input.imageFileId, now);
      const { obsolete, ...data } = input;
      const m = await tx.material.create({
        data: { ...data, partType, obsolete: obsolete ?? false, ...(obsolete ? { obsoleteAt: now, obsoleteById: user.id, status: "INACTIVE" as const } : {}), createdById: user.id, updatedById: user.id },
      });
      if (m.bomId) await createProduct(tx, { user, ctx: req.ctx }, { productCode: m.code, name: m.description, uom: m.uom, bomId: m.bomId, partId: m.id });
      await recordAudit(tx, req.ctx, { module: "masterdata", action: "PART_CREATED", entityType: "material", entityId: m.id, recordRef: m.code, next: input });
      return partView(await tx.material.findUniqueOrThrow({ where: { id: m.id }, include: PART_INCLUDE }));
    });
    res.status(201).json(ok(part));
  });

  r.patch("/:id", requirePermission("bom.material.manage"), async (req, res) => {
    const user = requireUser(req);
    const { id } = params(req, idParam);
    const input = body(req, updateSchema);
    const now = deps.now();
    const part = await db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM materials WHERE id = ${id} FOR UPDATE`;
      const row = await tx.material.findUnique({ where: { id }, include: { product: true } });
      if (!row) throw errors.notFound("Part");
      const { product, ...rest } = row;
      const before = plain(rest);
      const partType = input.partType ?? row.partType;
      if (product && input.partType && input.partType !== "FINISHED_GOOD") throw errors.validation([{ path: "partType", message: "This part has a Master Card; it stays a finished good" }]);
      if (input.bomId !== undefined && input.bomId !== row.bomId) {
        if (product) throw errors.validation([{ path: "bomId", message: "The Artwork No. can't change once the Master Card exists" }]);
        if (input.bomId && partType !== "FINISHED_GOOD") throw errors.validation([{ path: "bomId", message: "Only finished-good parts have an Artwork No." }]);
        await checkArtwork(tx, id, input.bomId);
      }
      const categoryId = input.categoryId !== undefined ? input.categoryId : row.categoryId;
      if (input.categoryId !== undefined && input.groupId === undefined && categoryId !== row.categoryId && row.groupId) input.groupId = null;
      const groupId = input.groupId !== undefined ? input.groupId : row.groupId;
      await checkClassification(tx, { categoryId, groupId }, row);
      await checkUnique(tx, id, input.nmiNo);
      if (input.imageFileId !== undefined && input.imageFileId !== row.imageFileId) await attachImage(tx, input.imageFileId, now);
      const change = diff(before, input as Record<string, unknown>);
      if (change.changed) {
        const revised = Object.keys(change.next).some((k) => REVISION_KEYS.includes(k));
        const data: Prisma.MaterialUncheckedUpdateInput = { ...(input as Prisma.MaterialUncheckedUpdateInput), updatedById: user.id };
        if (revised) Object.assign(data, { revisionNo: row.revisionNo + 1, revisedAt: now });
        if (input.obsolete === true && !row.obsolete) Object.assign(data, { obsoleteAt: now, obsoleteById: user.id, status: "INACTIVE" });
        if (input.obsolete === false && row.obsolete) Object.assign(data, { obsoleteAt: null, obsoleteById: null, status: "ACTIVE" });
        const m = await tx.material.update({ where: { id }, data });
        if (!product && m.bomId) await createProduct(tx, { user, ctx: req.ctx }, { productCode: m.code, name: m.description, uom: m.uom, bomId: m.bomId, partId: m.id });
        else await syncProductFromPart(tx, id, m, user.id);
        await recordAudit(tx, req.ctx, {
          module: "masterdata", action: "PART_UPDATED", entityType: "material", entityId: id, recordRef: row.code, previous: change.previous, next: change.next,
          remarks: revised ? `Part revision ${row.revisionNo + 1}. Existing BOM revisions keep the description they were saved with.` : null,
        });
      }
      return partView(await tx.material.findUniqueOrThrow({ where: { id }, include: PART_INCLUDE }));
    });
    res.json(ok(part));
  });

  r.put("/:id/status", requirePermission("bom.material.manage"), async (req, res) => {
    const user = requireUser(req);
    const { id } = params(req, idParam);
    const { status } = body(req, statusSchema);
    const part = await db.$transaction(async (tx) => {
      const before = await tx.material.findUnique({ where: { id } });
      if (!before) throw errors.notFound("Part");
      if (before.status !== status) {
        const m = await tx.material.update({ where: { id }, data: { status, updatedById: user.id, ...(status === "ACTIVE" ? { obsolete: false, obsoleteAt: null, obsoleteById: null } : {}) } });
        await syncProductFromPart(tx, id, m, user.id);
        await recordAudit(tx, req.ctx, {
          module: "masterdata", action: status === "ACTIVE" ? "PART_ACTIVATED" : "PART_DEACTIVATED", entityType: "material", entityId: id, recordRef: before.code,
          previous: { status: before.status }, next: { status },
        });
      }
      return partView(await tx.material.findUniqueOrThrow({ where: { id }, include: PART_INCLUDE }));
    });
    res.json(ok(part));
  });

  // ----- UOM Conversion (replace the set) -----------------------------------------
  r.put("/:id/uom-conversions", requirePermission("bom.material.manage"), async (req, res) => {
    const { id } = params(req, idParam);
    const { items } = body(
      req,
      z.object({
        items: z
          .array(
            z.object({
              uom: z.enum(UOM_CODES, { message: "Choose a unit" }),
              factor: z.union([z.number(), z.string()]).refine((v) => /^\d{1,12}(\.\d{1,6})?$/.test(String(v).trim()) && Number(v) > 0, "Enter a factor greater than 0 (max 6 decimals)"),
              remark: text(120),
            }),
          )
          .max(20),
      }),
    );
    await db.$transaction(async (tx) => {
      const part = await tx.material.findUnique({ where: { id }, include: { uomConversions: true } });
      if (!part) throw errors.notFound("Part");
      const seen = new Set<string>();
      items.forEach((it, i) => {
        if (it.uom === part.uom) throw errors.validation([{ path: `items.${i}.uom`, message: `${part.uom} is the part's own unit` }]);
        if (seen.has(it.uom)) throw errors.validation([{ path: `items.${i}.uom`, message: `${it.uom} is listed twice` }]);
        seen.add(it.uom);
      });
      const prev = part.uomConversions.map((c) => `1 ${c.uom} = ${D(c.factor).toString()} ${part.uom}`);
      await tx.partUomConversion.deleteMany({ where: { partId: id } });
      if (items.length) await tx.partUomConversion.createMany({ data: items.map((it) => ({ partId: id, uom: it.uom, factor: D(it.factor), remark: it.remark ?? null })) });
      await recordAudit(tx, req.ctx, { module: "masterdata", action: "PART_UOM_CONVERSIONS_SET", entityType: "material", entityId: id, recordRef: part.code, previous: { conversions: prev }, next: { conversions: items.map((it) => `1 ${it.uom} = ${D(it.factor).toString()} ${part.uom}`) } });
    });
    res.json(ok({ saved: true }));
  });

  // ----- Location Qty (manual until the WMS integration) -------------------------------
  const locationSchema = z.object({
    warehouseCode: code(20, "warehouse code"),
    locationCode: code(30, "location code"),
    shelfLocation: text(30),
    lotNo: text(60),
    doHoldQty: amount,
    qty: amount,
  });
  const lockPart = async (tx: Tx, id: string) => {
    const p = await tx.material.findUnique({ where: { id } });
    if (!p) throw errors.notFound("Part");
    return p;
  };
  const duplicate = async (tx: Tx, partId: string, l: { warehouseCode: string; locationCode: string; shelfLocation: string | null; lotNo: string | null }, except?: string) => {
    const same = await tx.partLocation.findFirst({ where: { partId, warehouseCode: l.warehouseCode, locationCode: l.locationCode, shelfLocation: l.shelfLocation, lotNo: l.lotNo, ...(except ? { id: { not: except } } : {}) } });
    if (same) throw errors.validation([{ path: "locationCode", message: "This warehouse / location / shelf / lot is already listed; edit that row" }]);
  };
  r.post("/:id/locations", requirePermission("bom.material.manage"), async (req, res) => {
    const user = requireUser(req);
    const { id } = params(req, idParam);
    const input = body(req, locationSchema);
    const row = await db.$transaction(async (tx) => {
      const p = await lockPart(tx, id);
      const l = { ...input, shelfLocation: input.shelfLocation ?? null, lotNo: input.lotNo ?? null };
      await duplicate(tx, id, l);
      const created = await tx.partLocation.create({ data: { ...l, partId: id, qty: D(input.qty ?? 0), doHoldQty: D(input.doHoldQty ?? 0), updatedById: user.id } });
      await recordAudit(tx, req.ctx, { module: "masterdata", action: "PART_LOCATION_ADDED", entityType: "material", entityId: id, recordRef: p.code, next: { ...l, qty: q(input.qty ?? 0), doHoldQty: q(input.doHoldQty ?? 0) }, remarks: "Manual stock entry" });
      return created;
    });
    res.status(201).json(ok({ id: row.id }));
  });
  r.patch("/:id/locations/:locId", requirePermission("bom.material.manage"), async (req, res) => {
    const user = requireUser(req);
    const { id, locId } = params(req, z.object({ id: z.uuid(), locId: z.uuid() }));
    const input = body(req, locationSchema.partial());
    await db.$transaction(async (tx) => {
      const p = await lockPart(tx, id);
      const before = await tx.partLocation.findUnique({ where: { id: locId } });
      if (!before || before.partId !== id) throw errors.notFound("Location");
      const next = { warehouseCode: input.warehouseCode ?? before.warehouseCode, locationCode: input.locationCode ?? before.locationCode, shelfLocation: input.shelfLocation !== undefined ? input.shelfLocation : before.shelfLocation, lotNo: input.lotNo !== undefined ? input.lotNo : before.lotNo };
      await duplicate(tx, id, next, locId);
      const view = { ...before, qty: q(before.qty), doHoldQty: q(before.doHoldQty) };
      const change = diff(view as Record<string, unknown>, input as Record<string, unknown>);
      if (!change.changed) return;
      await tx.partLocation.update({
        where: { id: locId },
        data: { ...next, ...(input.qty !== undefined ? { qty: D(input.qty ?? 0) } : {}), ...(input.doHoldQty !== undefined ? { doHoldQty: D(input.doHoldQty ?? 0) } : {}), updatedById: user.id },
      });
      await recordAudit(tx, req.ctx, { module: "masterdata", action: "PART_LOCATION_UPDATED", entityType: "material", entityId: id, recordRef: p.code, previous: change.previous, next: change.next, remarks: "Manual stock entry" });
    });
    res.json(ok({ saved: true }));
  });
  r.delete("/:id/locations/:locId", requirePermission("bom.material.manage"), async (req, res) => {
    const { id, locId } = params(req, z.object({ id: z.uuid(), locId: z.uuid() }));
    await db.$transaction(async (tx) => {
      const p = await lockPart(tx, id);
      const before = await tx.partLocation.findUnique({ where: { id: locId } });
      if (!before || before.partId !== id) throw errors.notFound("Location");
      await tx.partLocation.delete({ where: { id: locId } });
      await recordAudit(tx, req.ctx, {
        module: "masterdata", action: "PART_LOCATION_REMOVED", entityType: "material", entityId: id, recordRef: p.code,
        previous: { warehouseCode: before.warehouseCode, locationCode: before.locationCode, shelfLocation: before.shelfLocation, lotNo: before.lotNo, qty: q(before.qty), doHoldQty: q(before.doHoldQty) },
      });
    });
    res.json(ok({ removed: true }));
  });

  return r;
}
