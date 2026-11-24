import { z } from "zod";
import type { MasterCardRevision, Prisma, Product } from "../../generated/prisma/client";
import { errors } from "../../lib/errors";
import type { DbOrTx, Tx } from "../../lib/prisma";
import { q } from "../../lib/qty";
import { recordAudit } from "../audit/audit.service";
import type { Actor } from "./bom.service";
import { fileView } from "./files.routes";
import { dieSpec, qpaLines } from "./qpa";

/**
 * Master Card (owner record "product" = the finished-good part's card holder).
 *
 * The finished-good part lives in Part Master; its Artwork No. is exactly one
 * Father Code (confirmed rule). This record is created with that part and
 * keeps the Master Card revisions; its code / name / unit follow the part. A Master Card revision is the approved bundle that
 * production runs from: one specification + one artwork revision + one BOM
 * (component) revision + routing + tooling references. Drafts are edited;
 * released revisions are frozen (DB triggers) and only ever superseded.
 * Production Job Orders freeze the released revision they were created on.
 */

const num = z.number().positive().max(100_000);
const int = z.number().int().positive().max(10_000_000);
const str = (max: number) => z.string().trim().max(max);

/** Winding positions 1–8 (industry winding chart). */
export const WINDINGS = ["1", "2", "3", "4", "5", "6", "7", "8"] as const;

export const specSchema = z
  .object({
    labelWidthMm: num,
    labelHeightMm: num,
    shape: str(60),
    cornerRadiusMm: z.number().min(0).max(1000),
    across: int,
    gapAcrossMm: z.number().min(0).max(1000),
    gapAroundMm: z.number().min(0).max(1000),
    coreMm: num,
    labelsPerRoll: int,
    winding: z.enum(WINDINGS),
    maxRollDiameterMm: num,
    rollsPerCarton: int,
    printMethod: str(80),
    colours: str(200),
    varnish: str(120),
    finishing: str(200),
    dieRef: str(60),
    plateRef: str(60),
    customerRequirements: str(1000),
    // Header (TBS): customer and end user. Prepared / Approved By come from the draft and the release.
    customerCode: str(60),
    customerPartCode: str(80),
    endUser: str(120),
    // AFRF-CS
    afrfMaterial: str(200),
    afrfColor: str(200),
    afrfDetail: str(500),
    packingInstruction: str(500),
    afrfForm: str(120),
    supplierCode: str(60),
    afrfRemark: str(500),
    printingDirection: str(120),
    specialInstruction: str(1000),
    // Die Cut Spec
    dieCutId: z.uuid(),
    feedLengthMm: num,
    sampleCount: z.number().int().min(0).max(100_000),
    feedUps: int,
    actualUps: int,
    // Material Spec: per Son Code dimensions and Manual QPA (BOM lines come from the Father Code revision).
    bomDetail: z
      .array(
        z.object({
          sonCode: str(30),
          widthMm: num.nullable().optional(),
          lengthMm: num.nullable().optional(),
          heightMm: num.nullable().optional(),
          manualQpa: z.number().positive().max(1_000_000).nullable().optional(),
        }),
      )
      .max(100),
    // Process Detail: per routine step.
    processDetail: z
      .array(
        z.object({
          seq: z.number().int().min(1).max(100),
          machineCategoryId: z.uuid().nullable().optional(),
          defaultMachineId: z.uuid().nullable().optional(),
          setupMins: z.number().min(0).max(100_000).nullable().optional(),
          outputPerPress: z.number().min(0).max(10_000_000).nullable().optional(),
          noOfPrint: z.number().int().min(0).max(100).nullable().optional(),
          speed: z.number().min(0).max(1_000_000).nullable().optional(),
          speedUom: str(20).nullable().optional(),
        }),
      )
      .max(30),
    printingMachines: z
      .array(
        z.object({
          machineCategoryId: z.uuid().nullable().optional(),
          machineId: z.uuid().nullable().optional(),
          noOfPrint: z.number().int().min(0).max(100).nullable().optional(),
          setupMins: z.number().min(0).max(100_000).nullable().optional(),
          outputPerPress: z.number().min(0).max(10_000_000).nullable().optional(),
          speed: z.number().min(0).max(1_000_000).nullable().optional(),
        }),
      )
      .max(20),
  })
  .partial()
  .strict();
export type CardSpec = z.infer<typeof specSchema>;

const REQUIRED: { key: keyof CardSpec; label: string }[] = [
  { key: "labelWidthMm", label: "Label width" },
  { key: "labelHeightMm", label: "Label height" },
  { key: "across", label: "Across" },
  { key: "coreMm", label: "Core" },
  { key: "labelsPerRoll", label: "Labels per roll" },
  { key: "winding", label: "Winding" },
];

/** Drop empty strings so "cleared" fields are absent, not "". */
function cleanSpec(spec: CardSpec): CardSpec {
  return Object.fromEntries(Object.entries(spec).filter(([, v]) => v !== "" && v !== null && v !== undefined && !(Array.isArray(v) && v.length === 0))) as CardSpec;
}

/** Die, machine categories and machines named in the spec must exist (dies and machines active). */
async function checkSpecRefs(tx: Tx, spec: CardSpec) {
  const issues: { path: string; message: string }[] = [];
  if (spec.dieCutId) {
    const d = await tx.dieCut.findUnique({ where: { id: spec.dieCutId } });
    if (!d || d.status !== "ACTIVE") issues.push({ path: "spec.dieCutId", message: "Choose a die that is in use" });
  }
  const catIds = [...(spec.processDetail ?? []).map((p) => p.machineCategoryId), ...(spec.printingMachines ?? []).map((p) => p.machineCategoryId)].filter((x): x is string => !!x);
  const machIds = [...(spec.processDetail ?? []).map((p) => p.defaultMachineId), ...(spec.printingMachines ?? []).map((p) => p.machineId)].filter((x): x is string => !!x);
  const [cats, machines] = await Promise.all([
    catIds.length ? tx.machineCategory.findMany({ where: { id: { in: catIds } }, select: { id: true } }) : [],
    machIds.length ? tx.machine.findMany({ where: { id: { in: machIds } }, select: { id: true, categoryId: true, isActive: true } }) : [],
  ]);
  const catSet = new Set(cats.map((c) => c.id));
  const machOf = new Map(machines.map((m) => [m.id, m]));
  (spec.processDetail ?? []).forEach((p, i) => {
    if (p.machineCategoryId && !catSet.has(p.machineCategoryId)) issues.push({ path: `spec.processDetail.${i}.machineCategoryId`, message: "Machine category not found" });
    const m = p.defaultMachineId ? machOf.get(p.defaultMachineId) : null;
    if (p.defaultMachineId && (!m || !m.isActive)) issues.push({ path: `spec.processDetail.${i}.defaultMachineId`, message: "Choose an active machine" });
    else if (m && p.machineCategoryId && m.categoryId !== p.machineCategoryId) issues.push({ path: `spec.processDetail.${i}.defaultMachineId`, message: "The machine isn't in that machine category" });
  });
  (spec.printingMachines ?? []).forEach((p, i) => {
    if (p.machineCategoryId && !catSet.has(p.machineCategoryId)) issues.push({ path: `spec.printingMachines.${i}.machineCategoryId`, message: "Machine category not found" });
    const m = p.machineId ? machOf.get(p.machineId) : null;
    if (p.machineId && (!m || !m.isActive)) issues.push({ path: `spec.printingMachines.${i}.machineId`, message: "Choose an active machine" });
    else if (m && p.machineCategoryId && m.categoryId !== p.machineCategoryId) issues.push({ path: `spec.printingMachines.${i}.machineId`, message: "The machine isn't in that machine category" });
  });
  if (issues.length) throw errors.validation(issues);
}

const LINE_INCLUDE = { orderBy: { lineNo: "asc" as const }, include: { sonCode: { select: { sonCode: true } }, material: { select: { uom: true, widthMm: true, category: { select: { kind: true } } } } } } as const;
type QpaSourceLine = { sonCode: { sonCode: string }; materialCode: string; materialDescription: string; quantity: Prisma.Decimal | null; uom: string | null; material: { uom: string; widthMm: Prisma.Decimal | null; category: { kind: string } | null } };

/** Material Spec + Die Cut Spec of a card: QPA per Son Code with the formulas. */
export function materialSpec(spec: CardSpec, lines: QpaSourceLine[], die: { across: number; around: number; repeatMm: Prisma.Decimal | null } | null) {
  const d = dieSpec({ feedLengthMm: spec.feedLengthMm ?? null, feedUps: spec.feedUps ?? null, actualUps: spec.actualUps ?? null, die: die ? { across: die.across, around: die.around, repeatMm: die.repeatMm ? Number(die.repeatMm) : null } : null });
  const detail = new Map((spec.bomDetail ?? []).map((b) => [b.sonCode, b]));
  const qpa = qpaLines(
    lines.map((l) => {
      const b = detail.get(l.sonCode.sonCode);
      return {
        sonCode: l.sonCode.sonCode,
        materialCode: l.materialCode,
        materialDescription: l.materialDescription,
        uom: l.uom ?? l.material.uom,
        kind: l.material.category?.kind ?? null,
        bomQty: l.quantity ? Number(l.quantity) : null,
        partWidthMm: l.material.widthMm ? Number(l.material.widthMm) : null,
        widthMm: b?.widthMm ?? null,
        lengthMm: b?.lengthMm ?? null,
        heightMm: b?.heightMm ?? null,
        manualQpa: b?.manualQpa ?? null,
      };
    }),
    { feedLengthMm: d.feedLengthMm, actualUps: d.actualUps },
    { labelsPerRoll: spec.labelsPerRoll ?? null, rollsPerCarton: spec.rollsPerCarton ?? null },
  );
  return { die: d, lines: qpa };
}

/** Why a card can't be released (empty = releasable). */
export function releaseProblems(spec: CardSpec, card: Pick<MasterCardRevision, "componentRevisionId">) {
  const problems = REQUIRED.filter((r) => spec[r.key] === undefined).map((r) => `${r.label} is required`);
  if (!card.componentRevisionId) problems.push("The Father Code has no component list (Son Codes) yet");
  return problems;
}
const qpaProblems = (lines: { sonCode: string; source: string }[]) => lines.filter((l) => l.source === "MISSING").map((l) => `QPA missing for ${l.sonCode} (enter a Manual QPA)`);

const audit = (tx: Tx, a: Actor, p: { id: string; productCode: string }, action: string, extra: { previous?: unknown; next?: unknown; remarks?: string | null } = {}) =>
  recordAudit(tx, a.ctx, { module: "bom", action, entityType: "product", entityId: p.id, recordRef: p.productCode, ...extra });

async function lockProduct(tx: Tx, id: string): Promise<Product> {
  await tx.$queryRaw`SELECT id FROM products WHERE id = ${id} FOR UPDATE`;
  const p = await tx.product.findUnique({ where: { id } });
  if (!p) throw errors.notFound("Product");
  return p;
}

async function draftOf(tx: Tx, product: Product, cardId: string) {
  const card = await tx.masterCardRevision.findUnique({ where: { id: cardId } });
  if (!card || card.productId !== product.id) throw errors.notFound("Master Card revision");
  if (card.status !== "DRAFT") throw errors.rule("CARD_NOT_DRAFT", `Master Card Rev ${card.revisionNo} is ${card.status.toLowerCase()} and can't change. Start a new draft instead.`);
  return card;
}

/** Current artwork and component revisions of a Father Code. */
async function currentRevisions(tx: DbOrTx, bomId: string) {
  const bom = await tx.bom.findUniqueOrThrow({ where: { id: bomId } });
  const artwork = await tx.bomArtworkRevision.findUniqueOrThrow({ where: { bomId_revisionNo: { bomId, revisionNo: bom.currentArtworkRevNo } } });
  const component = bom.currentComponentRevNo
    ? await tx.bomComponentRevision.findUniqueOrThrow({ where: { bomId_revisionNo: { bomId, revisionNo: bom.currentComponentRevNo } } })
    : null;
  return { bom, artworkRevisionId: artwork.id, componentRevisionId: component?.id ?? null };
}

// ---------------------------------------------------------------------------
// Product
// ---------------------------------------------------------------------------

export interface ProductInput {
  productCode: string;
  name: string;
  uom: string;
  bomId: string;
  partId: string;
}

/** Called when a finished-good part gets its Artwork No. (Father Code). */
export async function createProduct(tx: Tx, a: Actor, input: ProductInput) {
  const productCode = input.productCode.trim().toUpperCase();
  if (await tx.product.findUnique({ where: { productCode } })) throw errors.validation([{ path: "code", message: `${productCode} already has a Master Card record` }]);
  await tx.$queryRaw`SELECT id FROM boms WHERE id = ${input.bomId} FOR UPDATE`;
  const bom = await tx.bom.findUnique({ where: { id: input.bomId }, include: { product: true } });
  if (!bom) throw errors.validation([{ path: "bomId", message: "Choose a Father Code" }]);
  if (bom.status !== "ACTIVE") throw errors.validation([{ path: "bomId", message: `${bom.fatherCode} is inactive` }]);
  if (bom.product) throw errors.validation([{ path: "bomId", message: `${bom.fatherCode} already belongs to part ${bom.product.productCode}. One Father Code belongs to one finished-good part.` }]);
  const product = await tx.product.create({
    data: {
      productCode,
      name: input.name,
      uom: input.uom,
      bomId: bom.id,
      partId: input.partId,
      createdById: a.user.id,
      updatedById: a.user.id,
    },
  });
  await audit(tx, a, product, "PRODUCT_CREATED", { next: { productCode, name: input.name, fatherCode: bom.fatherCode, uom: input.uom } });
  return product;
}

/** Keep the card holder in step with its part (name, unit, status). */
export async function syncProductFromPart(tx: Tx, partId: string, part: { description: string; uom: string; status: "ACTIVE" | "INACTIVE" }, userId: string) {
  const p = await tx.product.findUnique({ where: { partId } });
  if (!p || (p.name === part.description && p.uom === part.uom && p.status === part.status)) return;
  await tx.product.update({ where: { id: p.id }, data: { name: part.description, uom: part.uom, status: part.status, updatedById: userId } });
}

// ---------------------------------------------------------------------------
// Master Card revisions
// ---------------------------------------------------------------------------

/** New draft: spec and routine from the latest released card, current Father Code revisions. */
export async function createDraft(tx: Tx, a: Actor, productId: string) {
  const p = await lockProduct(tx, productId);
  if (p.status !== "ACTIVE") throw errors.rule("PRODUCT_INACTIVE", `${p.productCode} is inactive.`);
  const existing = await tx.masterCardRevision.findFirst({ where: { productId, status: "DRAFT" } });
  if (existing) throw errors.rule("DRAFT_EXISTS", `Master Card Rev ${existing.revisionNo} is already a draft. Edit or discard it first.`);
  const [released, max, revs] = await Promise.all([
    tx.masterCardRevision.findFirst({ where: { productId, status: "RELEASED" } }),
    tx.masterCardRevision.aggregate({ where: { productId }, _max: { revisionNo: true } }),
    currentRevisions(tx, p.bomId),
  ]);
  if (revs.bom.status !== "ACTIVE") throw errors.rule("BOM_INACTIVE", `Father Code ${revs.bom.fatherCode} is inactive.`);
  const revisionNo = (max._max.revisionNo ?? 0) + 1;
  const card = await tx.masterCardRevision.create({
    data: {
      productId,
      revisionNo,
      artworkRevisionId: revs.artworkRevisionId,
      componentRevisionId: revs.componentRevisionId,
      routineId: released?.routineId ?? null,
      spec: (released?.spec ?? {}) as Prisma.InputJsonValue,
      createdById: a.user.id,
    },
  });
  await audit(tx, a, p, "MASTER_CARD_DRAFTED", { next: { revisionNo, basedOn: released ? `Rev ${released.revisionNo}` : null } });
  return card;
}

export interface DraftInput {
  spec?: CardSpec;
  routineId?: string | null;
  changeNote?: string | null;
  refreshRevisions?: boolean;
}

export async function updateDraft(tx: Tx, a: Actor, productId: string, cardId: string, input: DraftInput) {
  const p = await lockProduct(tx, productId);
  const card = await draftOf(tx, p, cardId);
  const data: Prisma.MasterCardRevisionUncheckedUpdateInput = {};
  const changed: Record<string, unknown> = {};
  if (input.spec) {
    const spec = cleanSpec(input.spec);
    await checkSpecRefs(tx, spec);
    data.spec = spec as Prisma.InputJsonValue;
    changed.spec = data.spec;
  }
  if (input.routineId !== undefined) {
    if (input.routineId) {
      const rt = await tx.routine.findUnique({ where: { id: input.routineId } });
      if (!rt || rt.status !== "ACTIVE") throw errors.validation([{ path: "routineId", message: "Choose an active routine" }]);
    }
    data.routineId = input.routineId;
    changed.routineId = input.routineId;
  }
  if (input.changeNote !== undefined) data.changeNote = input.changeNote;
  if (input.refreshRevisions) {
    const revs = await currentRevisions(tx, p.bomId);
    data.artworkRevisionId = revs.artworkRevisionId;
    data.componentRevisionId = revs.componentRevisionId;
    changed.refreshedRevisions = true;
  }
  const updated = await tx.masterCardRevision.update({ where: { id: card.id }, data });
  if (Object.keys(changed).length) await audit(tx, a, p, "MASTER_CARD_DRAFT_UPDATED", { next: { revisionNo: card.revisionNo, ...changed } });
  return updated;
}

export async function releaseCard(tx: Tx, a: Actor, productId: string, cardId: string, now: Date) {
  const p = await lockProduct(tx, productId);
  const card = await draftOf(tx, p, cardId);
  if (p.status !== "ACTIVE") throw errors.rule("PRODUCT_INACTIVE", `${p.productCode} is inactive.`);
  const spec = (card.spec ?? {}) as CardSpec;
  const comp = card.componentRevisionId ? await tx.bomComponentRevision.findUnique({ where: { id: card.componentRevisionId }, include: { lines: LINE_INCLUDE } }) : null;
  const die = spec.dieCutId ? await tx.dieCut.findUnique({ where: { id: spec.dieCutId } }) : null;
  const problems = [...releaseProblems(spec, card), ...qpaProblems(materialSpec(spec, comp?.lines ?? [], die).lines)];
  if (problems.length) throw errors.rule("CARD_INCOMPLETE", `Master Card Rev ${card.revisionNo} can't be released: ${problems.join("; ")}.`, { problems });
  const previous = await tx.masterCardRevision.findFirst({ where: { productId, status: "RELEASED" } });
  if (previous) await tx.masterCardRevision.update({ where: { id: previous.id }, data: { status: "SUPERSEDED", supersededAt: now } });
  await tx.masterCardRevision.update({ where: { id: card.id }, data: { status: "RELEASED", releasedAt: now, releasedById: a.user.id } });
  // The released card's header is the customer reference the shop floor and labels use.
  await tx.product.update({
    where: { id: productId },
    data: {
      currentCardRevNo: card.revisionNo,
      ...(spec.customerCode !== undefined ? { customerName: spec.customerCode } : {}),
      ...(spec.customerPartCode !== undefined ? { customerPartNo: spec.customerPartCode } : {}),
      updatedById: a.user.id,
    },
  });
  const art = await tx.bomArtworkRevision.findUniqueOrThrow({ where: { id: card.artworkRevisionId } });
  await audit(tx, a, p, "MASTER_CARD_RELEASED", {
    previous: previous ? { revisionNo: previous.revisionNo } : undefined,
    next: { revisionNo: card.revisionNo, artworkRevision: art.revisionNo, componentRevision: comp?.revisionNo ?? null },
    remarks: card.changeNote,
  });
  return { revisionNo: card.revisionNo, superseded: previous?.revisionNo ?? null };
}

export async function discardDraft(tx: Tx, a: Actor, productId: string, cardId: string) {
  const p = await lockProduct(tx, productId);
  const card = await draftOf(tx, p, cardId);
  await tx.masterCardRevision.delete({ where: { id: card.id } });
  await audit(tx, a, p, "MASTER_CARD_DRAFT_DISCARDED", { previous: { revisionNo: card.revisionNo } });
}

// ---------------------------------------------------------------------------
// What a Production Job Order freezes
// ---------------------------------------------------------------------------

/**
 * For a Father Code that belongs to a product: the product's released Master
 * Card (refuses when there is none). For a Father Code without a product:
 * null, and the caller uses the Father Code's current revisions.
 */
export async function cardSnapshot(db: DbOrTx, bomId: string) {
  const product = await db.product.findUnique({ where: { bomId } });
  if (!product) return null;
  if (product.status !== "ACTIVE") throw errors.rule("PRODUCT_INACTIVE", `Product ${product.productCode} is inactive and can't be used for new production.`);
  const card = await db.masterCardRevision.findFirst({ where: { productId: product.id, status: "RELEASED" } });
  if (!card) throw errors.rule("NO_RELEASED_CARD", `Release the Master Card of product ${product.productCode} first: production runs from the released Master Card.`);
  return { product, card };
}

// ---------------------------------------------------------------------------
// Read models
// ---------------------------------------------------------------------------

const CARD_INCLUDE = {
  artworkRevision: { select: { revisionNo: true, labelDescription: true, file: true } },
  componentRevision: { select: { revisionNo: true, lines: LINE_INCLUDE } },
  routine: { select: { id: true, code: true, name: true, steps: { orderBy: { seq: "asc" as const }, include: { process: { select: { id: true, name: true } } } } } },
} as const;

type CardRow = Prisma.MasterCardRevisionGetPayload<{ include: typeof CARD_INCLUDE }>;

type DieRow = { id: string; code: string; description: string; across: number; around: number; repeatMm: Prisma.Decimal | null; labelWidthMm: Prisma.Decimal; labelHeightMm: Prisma.Decimal };

function cardView(c: CardRow, names: Map<string, string>, current: { artworkRevNo: number; componentRevNo: number }, dies: Map<string, DieRow>) {
  const spec = (c.spec ?? {}) as CardSpec;
  const die = spec.dieCutId ? (dies.get(spec.dieCutId) ?? null) : null;
  const material = materialSpec(spec, c.componentRevision?.lines ?? [], die);
  return {
    id: c.id,
    revisionNo: c.revisionNo,
    status: c.status,
    spec,
    changeNote: c.changeNote,
    artwork: { revisionNo: c.artworkRevision.revisionNo, labelDescription: c.artworkRevision.labelDescription, file: fileView(c.artworkRevision.file), current: c.artworkRevision.revisionNo === current.artworkRevNo },
    component: c.componentRevision
      ? {
          revisionNo: c.componentRevision.revisionNo,
          current: c.componentRevision.revisionNo === current.componentRevNo,
          lines: c.componentRevision.lines.map((l) => ({ sonCode: l.sonCode.sonCode, materialCode: l.materialCode, materialDescription: l.materialDescription, quantity: l.quantity ? q(l.quantity) : null, uom: l.uom })),
        }
      : null,
    routine: c.routine
      ? { id: c.routine.id, code: c.routine.code, name: c.routine.name, steps: c.routine.steps.map((s) => s.process.name), stepDetail: c.routine.steps.map((s) => ({ seq: s.seq, processId: s.process.id, process: s.process.name })) }
      : null,
    die: die ? { id: die.id, code: die.code, description: die.description, across: die.across, around: die.around, repeatMm: die.repeatMm ? q(die.repeatMm) : null, labelWidthMm: q(die.labelWidthMm), labelHeightMm: q(die.labelHeightMm) } : null,
    dieSpec: material.die,
    qpa: material.lines,
    releaseProblems: c.status === "DRAFT" ? [...releaseProblems(spec, c), ...qpaProblems(material.lines)] : [],
    createdBy: names.get(c.createdById) ?? null,
    createdAt: c.createdAt,
    releasedBy: c.releasedById ? (names.get(c.releasedById) ?? null) : null,
    releasedAt: c.releasedAt,
    supersededAt: c.supersededAt,
  };
}

export async function productDetail(db: DbOrTx, id: string) {
  const p = await db.product.findUnique({
    where: { id },
    include: {
      part: { select: { id: true, code: true, nmiNo: true, description: true } },
      bom: { select: { id: true, fatherCode: true, status: true, labelDescription: true, currentArtworkRevNo: true, currentComponentRevNo: true } },
      cards: { orderBy: { revisionNo: "desc" }, include: CARD_INCLUDE },
      productionJobOrders: { orderBy: { createdAt: "desc" }, take: 100, select: { id: true, pjoNo: true, status: true, orderQty: true, uom: true, requiredDate: true, masterCardRevision: { select: { revisionNo: true } } } },
    },
  });
  if (!p) throw errors.notFound("Product");
  const userIds = [...new Set(p.cards.flatMap((c) => [c.createdById, c.releasedById]).filter((x): x is string => !!x))];
  const names = new Map((await db.user.findMany({ where: { id: { in: userIds } }, select: { id: true, fullName: true } })).map((u) => [u.id, u.fullName]));
  const current = { artworkRevNo: p.bom.currentArtworkRevNo, componentRevNo: p.bom.currentComponentRevNo };
  const dieIds = [...new Set(p.cards.map((c) => (c.spec as CardSpec | null)?.dieCutId).filter((x): x is string => !!x))];
  const dies = new Map((dieIds.length ? await db.dieCut.findMany({ where: { id: { in: dieIds } } }) : []).map((d) => [d.id, d]));
  const cards = p.cards.map((c) => cardView(c, names, current, dies));
  const released = cards.find((c) => c.status === "RELEASED") ?? null;
  const draft = cards.find((c) => c.status === "DRAFT") ?? null;
  const thumb = released?.artwork.file ?? draft?.artwork.file ?? cards[0]?.artwork.file ?? null;
  return {
    id: p.id,
    productCode: p.productCode,
    name: p.name,
    part: p.part,
    customerName: p.customerName,
    customerPartNo: p.customerPartNo,
    uom: p.uom,
    status: p.status,
    remarks: p.remarks,
    currentCardRevNo: p.currentCardRevNo,
    createdAt: p.createdAt,
    fatherCode: { ...p.bom, newerThanReleased: !!released && (!released.artwork.current || (released.component ? !released.component.current : p.bom.currentComponentRevNo > 0)) },
    artworkFile: thumb,
    released,
    draft,
    cards: cards.map((c) => ({ id: c.id, revisionNo: c.revisionNo, status: c.status, artworkRevision: c.artwork.revisionNo, componentRevision: c.component?.revisionNo ?? null, changeNote: c.changeNote, releasedAt: c.releasedAt, releasedBy: c.releasedBy, supersededAt: c.supersededAt, createdAt: c.createdAt })),
    orders: p.productionJobOrders.map((o) => ({ id: o.id, pjoNo: o.pjoNo, status: o.status, orderQty: q(o.orderQty), uom: o.uom, requiredDate: o.requiredDate, cardRevisionNo: o.masterCardRevision?.revisionNo ?? null })),
  };
}
