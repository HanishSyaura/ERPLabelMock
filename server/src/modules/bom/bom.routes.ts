import { Router, type Request } from "express";
import { z } from "zod";
import type { Prisma } from "../../generated/prisma/client";
import type { Deps } from "../../deps";
import { errors } from "../../lib/errors";
import { body, ok, pageMeta, params, query } from "../../lib/http";
import { requireAnyPermission, requirePermission } from "../../middleware/auth";
import { requireUser } from "../../middleware/context";
import { normQty } from "./bom.rules";
import * as svc from "./bom.service";
import { duplicateWarnings } from "./duplicates";
import { fileView } from "./files.routes";
import { UOM_CODES } from "./uom";

const bomParam = z.object({ id: z.uuid() });
const sonParam = z.object({ id: z.uuid(), sonId: z.uuid() });
const revParam = z.object({ id: z.uuid(), revisionNo: z.coerce.number().int().min(1) });

const note = z.string().trim().max(500).optional().nullable();
const description = z.string().trim().min(1, "Enter the label description").max(500, "At most 500 characters");
const quantity = z
  .union([z.number(), z.string().trim()])
  .optional()
  .nullable()
  .transform((v) => (v === "" || v === undefined ? null : v))
  .refine((v) => v === null || (Number.isFinite(Number(v)) && Number(v) > 0 && Number(v) < 1e14), "Enter a quantity greater than 0");
const uom = z.enum(UOM_CODES, { message: "Choose a unit" }).optional().nullable();
const remarks = z.string().trim().max(500).optional().nullable();

const createSchema = z.object({ fileId: z.uuid({ message: "Upload the artwork file first" }), labelDescription: description, changeNote: note });
const artworkSchema = z
  .object({ fileId: z.uuid().optional(), labelDescription: description.optional(), changeNote: note, expectedArtworkRevNo: z.number().int().min(1).optional() })
  .refine((v) => v.fileId || v.labelDescription !== undefined, "Nothing to change");
const restoreSchema = z.object({ revisionNo: z.number().int().min(1), changeNote: note, expectedRevNo: z.number().int().min(0).optional() });
const statusSchema = z.object({ status: z.enum(["ACTIVE", "INACTIVE"]), reason: note });
const lineSchema = z.object({ materialId: z.uuid({ message: "Choose a material" }), quantity, uom, remarks });
const addSchema = z.object({
  lines: z.array(lineSchema).min(1, "Add at least one component").max(100),
  allowDuplicate: z.boolean().optional(),
  changeNote: note,
  expectedComponentRevNo: z.number().int().min(0).optional(),
});
const editSchema = z.object({
  materialId: z.uuid().optional(),
  quantity,
  uom,
  remarks,
  allowDuplicate: z.boolean().optional(),
  changeNote: note,
  expectedComponentRevNo: z.number().int().min(0).optional(),
});
const removeSchema = z.object({ changeNote: note, expectedComponentRevNo: z.number().int().min(0).optional() });
const duplicateSchema = z.object({ fileId: z.uuid().optional(), labelDescription: z.string().max(500).optional(), excludeBomId: z.uuid().optional() });

const listSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
  q: z.string().trim().max(100).optional(),
  status: z.enum(["ACTIVE", "INACTIVE"]).optional(),
  /** with = linked to a product, without = no product yet. */
  product: z.enum(["with", "without"]).optional(),
  sort: z
    .enum(["fatherCode:asc", "fatherCode:desc", "labelDescription:asc", "labelDescription:desc", "updatedAt:asc", "updatedAt:desc"])
    .default("updatedAt:desc"),
});

export function bomRoutes(deps: Deps) {
  const r = Router();
  const { db } = deps;
  const actor = (req: Request): svc.Actor => ({ user: requireUser(req), ctx: req.ctx });

  /** Names for created_by / updated_by ids. */
  async function userNames(ids: (string | null | undefined)[]) {
    const unique = [...new Set(ids.filter((x): x is string => !!x))];
    const users = await db.user.findMany({ where: { id: { in: unique } }, select: { id: true, fullName: true } });
    return new Map(users.map((u) => [u.id, u.fullName]));
  }

  // ----- list ---------------------------------------------------------------
  r.get("/", requirePermission("bom.view"), async (req, res) => {
    const q = query(req, listSchema);
    const [field, dir] = q.sort.split(":") as ["fatherCode" | "labelDescription" | "updatedAt", "asc" | "desc"];
    const where: Prisma.BomWhereInput = {
      ...(q.status ? { status: q.status } : {}),
      ...(q.product === "with" ? { product: { isNot: null } } : q.product === "without" ? { product: { is: null } } : {}),
      ...(q.q
        ? {
            OR: [
              { fatherCode: { contains: q.q } },
              { labelDescription: { contains: q.q } },
              { product: { is: { OR: [{ productCode: { contains: q.q } }, { name: { contains: q.q } }, { customerName: { contains: q.q } }, { customerPartNo: { contains: q.q } }] } } },
              { sonCodes: { some: { status: "ACTIVE", OR: [{ sonCode: { contains: q.q } }, { material: { code: { contains: q.q } } }] } } },
            ],
          }
        : {}),
    };
    const [total, rows] = await Promise.all([
      db.bom.count({ where }),
      db.bom.findMany({
        where,
        orderBy: { [field]: dir },
        skip: (q.page - 1) * q.pageSize,
        take: q.pageSize,
        include: { product: { select: { id: true, productCode: true, name: true, customerName: true, status: true, currentCardRevNo: true, cards: { where: { status: "DRAFT" }, select: { revisionNo: true } } } } },
      }),
    ]);
    const ids = rows.map((b) => b.id);
    const [artworks, sonCounts, names] = await Promise.all([
      rows.length
        ? db.bomArtworkRevision.findMany({
            where: { OR: rows.map((b) => ({ bomId: b.id, revisionNo: b.currentArtworkRevNo })) },
            include: { file: true },
          })
        : [],
      db.bomSonCode.groupBy({ by: ["bomId"], where: { bomId: { in: ids }, status: "ACTIVE" }, _count: { _all: true } }),
      userNames(rows.map((b) => b.updatedById)),
    ]);
    const artworkOf = new Map(artworks.map((a) => [a.bomId, a]));
    const countOf = new Map(sonCounts.map((c) => [c.bomId, c._count._all]));
    res.json(
      ok(
        rows.map((b) => {
          const art = artworkOf.get(b.id);
          return {
            id: b.id,
            fatherCode: b.fatherCode,
            labelDescription: b.labelDescription,
            status: b.status,
            artworkRevision: b.currentArtworkRevNo,
            componentRevision: b.currentComponentRevNo,
            sonCount: countOf.get(b.id) ?? 0,
            artworkFile: art ? fileView(art.file) : null,
            updatedAt: b.updatedAt,
            updatedBy: names.get(b.updatedById) ?? null,
            product: b.product
              ? {
                  id: b.product.id,
                  productCode: b.product.productCode,
                  name: b.product.name,
                  customerName: b.product.customerName,
                  status: b.product.status,
                  currentCardRevNo: b.product.currentCardRevNo,
                  draftRevNo: b.product.cards[0]?.revisionNo ?? null,
                }
              : null,
          };
        }),
        pageMeta(q.page, q.pageSize, total),
      ),
    );
  });

  r.post("/duplicate-check", requireAnyPermission("bom.create", "bom.edit", "bom.artwork.upload"), async (req, res) => {
    const input = body(req, duplicateSchema);
    res.json(ok(await duplicateWarnings(db, input)));
  });

  // ----- detail ---------------------------------------------------------------
  r.get("/:id", requirePermission("bom.view"), async (req, res) => {
    const { id } = params(req, bomParam);
    const bom = await db.bom.findUnique({ where: { id }, include: { product: { select: { id: true, productCode: true, partId: true, currentCardRevNo: true } } } });
    if (!bom) throw errors.notFound("Father Code");
    const [artwork, lines, sonCodes, componentRev] = await Promise.all([
      db.bomArtworkRevision.findUniqueOrThrow({ where: { bomId_revisionNo: { bomId: id, revisionNo: bom.currentArtworkRevNo } }, include: { file: true } }),
      svc.currentLines(db, bom),
      db.bomSonCode.findMany({ where: { bomId: id }, include: { material: { select: { status: true, uom: true } } } }),
      bom.currentComponentRevNo
        ? db.bomComponentRevision.findUnique({ where: { bomId_revisionNo: { bomId: id, revisionNo: bom.currentComponentRevNo } } })
        : null,
    ]);
    const names = await userNames([bom.createdById, bom.updatedById, artwork.createdById, componentRev?.createdById]);
    const sonById = new Map(sonCodes.map((s) => [s.id, s]));
    res.json(
      ok({
        id: bom.id,
        fatherCode: bom.fatherCode,
        status: bom.status,
        labelDescription: bom.labelDescription,
        createdAt: bom.createdAt,
        createdBy: names.get(bom.createdById) ?? null,
        updatedAt: bom.updatedAt,
        updatedBy: names.get(bom.updatedById) ?? null,
        artwork: {
          revisionNo: artwork.revisionNo,
          changeType: artwork.changeType,
          createdAt: artwork.createdAt,
          createdBy: names.get(artwork.createdById) ?? null,
          file: fileView(artwork.file),
        },
        componentRevision: componentRev
          ? { revisionNo: componentRev.revisionNo, createdAt: componentRev.createdAt, createdBy: names.get(componentRev.createdById) ?? null }
          : null,
        components: lines.map((l) => {
          const son = sonById.get(l.sonCodeId);
          return { ...l, status: son?.status ?? "ACTIVE", materialActive: son?.material.status === "ACTIVE" };
        }),
        removedSonCount: sonCodes.filter((s) => s.status === "REMOVED").length,
        /** The finished-good part whose Master Card this Father Code carries. */
        finishedPart: bom.product ? { productId: bom.product.id, partId: bom.product.partId, code: bom.product.productCode, currentCardRevNo: bom.product.currentCardRevNo } : null,
      }),
    );
  });

  r.get("/:id/artwork-revisions", requirePermission("bom.view"), async (req, res) => {
    const { id } = params(req, bomParam);
    const revs = await db.bomArtworkRevision.findMany({ where: { bomId: id }, orderBy: { revisionNo: "desc" }, include: { file: true } });
    const names = await userNames(revs.map((r) => r.createdById));
    res.json(
      ok(
        revs.map((r) => ({
          revisionNo: r.revisionNo,
          labelDescription: r.labelDescription,
          changeType: r.changeType,
          changeNote: r.changeNote,
          restoredFromRevisionNo: r.restoredFromRevisionNo,
          createdAt: r.createdAt,
          createdBy: names.get(r.createdById) ?? null,
          file: fileView(r.file),
        })),
      ),
    );
  });

  r.get("/:id/component-revisions", requirePermission("bom.view"), async (req, res) => {
    const { id } = params(req, bomParam);
    const revs = await db.bomComponentRevision.findMany({
      where: { bomId: id },
      orderBy: { revisionNo: "desc" },
      include: { _count: { select: { lines: true } } },
    });
    const names = await userNames(revs.map((r) => r.createdById));
    res.json(
      ok(
        revs.map((r) => ({
          revisionNo: r.revisionNo,
          changeType: r.changeType,
          changes: r.changes,
          changeNote: r.changeNote,
          restoredFromRevisionNo: r.restoredFromRevisionNo,
          lineCount: r._count.lines,
          createdAt: r.createdAt,
          createdBy: names.get(r.createdById) ?? null,
        })),
      ),
    );
  });

  /** Full component list of one revision (as it was). */
  r.get("/:id/component-revisions/:revisionNo", requirePermission("bom.view"), async (req, res) => {
    const { id, revisionNo } = params(req, revParam);
    const rev = await db.bomComponentRevision.findUnique({
      where: { bomId_revisionNo: { bomId: id, revisionNo } },
      include: { lines: { include: { sonCode: { select: { sonCode: true } } }, orderBy: { lineNo: "asc" } } },
    });
    if (!rev) throw errors.notFound(`Component revision ${revisionNo}`);
    res.json(
      ok({
        revisionNo: rev.revisionNo,
        lines: rev.lines.map((l) => ({
          sonCode: l.sonCode.sonCode,
          materialCode: l.materialCode,
          materialDescription: l.materialDescription,
          quantity: normQty(l.quantity),
          uom: l.uom,
          remarks: l.remarks,
        })),
      }),
    );
  });

  /** BOM audit history (artwork, Son Codes, status). */
  r.get("/:id/history", requirePermission("bom.view"), async (req, res) => {
    const { id } = params(req, bomParam);
    const rows = await db.auditLog.findMany({ where: { entityType: "bom", entityId: id }, orderBy: { id: "desc" }, take: 200 });
    res.json(
      ok(rows.map((r) => ({ id: r.id.toString(), occurredAt: r.occurredAt, userName: r.userName, action: r.action, previous: r.previous, next: r.next, remarks: r.remarks }))),
    );
  });

  /** What a Production Job Order freezes at release (used from Phase 3). */
  r.get("/:id/production-snapshot", requirePermission("bom.view"), async (req, res) => {
    const { id } = params(req, bomParam);
    res.json(ok(await svc.productionSnapshot(db, id)));
  });

  // ----- writes ---------------------------------------------------------------
  r.post("/", requirePermission("bom.create"), async (req, res) => {
    const input = body(req, createSchema);
    const bom = await db.$transaction((tx) => svc.createFatherCode(tx, actor(req), input, deps.now()));
    res.status(201).json(ok({ id: bom.id, fatherCode: bom.fatherCode }));
  });

  r.patch("/:id/artwork", requireAnyPermission("bom.edit", "bom.artwork.upload"), async (req, res) => {
    const { id } = params(req, bomParam);
    const input = body(req, artworkSchema);
    const result = await db.$transaction((tx) => svc.reviseArtwork(tx, actor(req), id, input, deps.now()));
    res.json(ok({ changed: result.changed, artworkRevision: result.bom.currentArtworkRevNo }));
  });

  r.post("/:id/artwork-revisions/restore", requirePermission("bom.artwork.revise"), async (req, res) => {
    const { id } = params(req, bomParam);
    const input = body(req, restoreSchema);
    const bom = await db.$transaction((tx) =>
      svc.restoreArtwork(tx, actor(req), id, { revisionNo: input.revisionNo, changeNote: input.changeNote, expectedArtworkRevNo: input.expectedRevNo }),
    );
    res.json(ok({ artworkRevision: bom.currentArtworkRevNo }));
  });

  r.put("/:id/status", requirePermission("bom.status"), async (req, res) => {
    const { id } = params(req, bomParam);
    const input = body(req, statusSchema);
    const bom = await db.$transaction((tx) => svc.setStatus(tx, actor(req), id, input.status, input.reason));
    res.json(ok({ status: bom.status }));
  });

  r.post("/:id/son-codes", requirePermission("bom.son.add"), async (req, res) => {
    const { id } = params(req, bomParam);
    const input = body(req, addSchema);
    const result = await db.$transaction((tx) => svc.addSonCodes(tx, actor(req), id, input));
    res.status(201).json(ok(result));
  });

  r.patch("/:id/son-codes/:sonId", requirePermission("bom.son.edit"), async (req, res) => {
    const { id, sonId } = params(req, sonParam);
    const input = body(req, editSchema);
    const result = await db.$transaction((tx) => svc.editSonCode(tx, actor(req), id, sonId, input));
    res.json(ok(result));
  });

  r.post("/:id/son-codes/:sonId/remove", requirePermission("bom.son.remove"), async (req, res) => {
    const { id, sonId } = params(req, sonParam);
    const input = body(req, removeSchema);
    const result = await db.$transaction((tx) => svc.removeSonCode(tx, actor(req), id, sonId, input, deps.now()));
    res.json(ok(result));
  });

  r.post("/:id/component-revisions/restore", requirePermission("bom.revision.manage"), async (req, res) => {
    const { id } = params(req, bomParam);
    const input = body(req, restoreSchema);
    const result = await db.$transaction((tx) =>
      svc.restoreComponentRevision(tx, actor(req), id, { revisionNo: input.revisionNo, changeNote: input.changeNote, expectedComponentRevNo: input.expectedRevNo }, deps.now()),
    );
    res.json(ok(result));
  });

  return r;
}
