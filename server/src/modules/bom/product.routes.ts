import { Router, type Request } from "express";
import { z } from "zod";
import type { Prisma } from "../../generated/prisma/client";
import type { Deps } from "../../deps";
import { body, idParam, ok, pageMeta, params, query } from "../../lib/http";
import { requireAnyPermission, requirePermission } from "../../middleware/auth";
import { requireUser } from "../../middleware/context";
import type { Actor } from "./bom.service";
import { fileView } from "./files.routes";
import * as svc from "./product.service";
import { UOM_CODES } from "./uom";

const text = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .optional()
    .nullable()
    .transform((v) => (v ? v : null));
/** Optional on PATCH: absent stays absent (undefined), empty clears (null). */
const patchText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .nullable()
    .optional()
    .transform((v) => (v === undefined ? undefined : v || null));
const cardParams = z.object({ id: z.uuid(), cardId: z.uuid() });

/** Product Master and Master Card revisions (mounted at /products). */
export function productRoutes(deps: Deps) {
  const r = Router();
  const { db } = deps;
  const actor = (req: Request): Actor => ({ user: requireUser(req), ctx: req.ctx });

  r.get("/", requirePermission("bom.view"), async (req, res) => {
    const f = query(
      req,
      z.object({
        page: z.coerce.number().int().min(1).default(1),
        pageSize: z.coerce.number().int().min(1).max(100).default(25),
        q: z.string().trim().max(60).optional(),
        status: z.enum(["ACTIVE", "INACTIVE"]).optional(),
        /** released = in production; draft = a draft waiting; none = no Master Card yet. */
        card: z.enum(["released", "draft", "none"]).optional(),
      }),
    );
    const where: Prisma.ProductWhereInput = {
      ...(f.status ? { status: f.status } : {}),
      ...(f.card === "released" ? { currentCardRevNo: { gt: 0 } } : f.card === "draft" ? { cards: { some: { status: "DRAFT" } } } : f.card === "none" ? { cards: { none: {} } } : {}),
      ...(f.q
        ? {
            OR: [
              { productCode: { contains: f.q } },
              { name: { contains: f.q } },
              { customerName: { contains: f.q } },
              { customerPartNo: { contains: f.q } },
              { bom: { fatherCode: { contains: f.q } } },
              { part: { nmiNo: { contains: f.q } } },
            ],
          }
        : {}),
    };
    const [total, rows] = await Promise.all([
      db.product.count({ where }),
      db.product.findMany({
        where,
        orderBy: { productCode: "asc" },
        skip: (f.page - 1) * f.pageSize,
        take: f.pageSize,
        include: {
          bom: { select: { fatherCode: true, labelDescription: true, currentArtworkRevNo: true, artworkRevisions: { orderBy: { revisionNo: "desc" }, take: 1, select: { file: true } } } },
          cards: { where: { status: { in: ["DRAFT", "RELEASED"] } }, select: { status: true, revisionNo: true, artworkRevisionId: true, releasedAt: true } },
          part: { select: { id: true, nmiNo: true } },
        },
      }),
    ]);
    res.json(
      ok(
        rows.map((p) => ({
          id: p.id,
          productCode: p.productCode,
          name: p.name,
          customerName: p.customerName,
          customerPartNo: p.customerPartNo,
          uom: p.uom,
          status: p.status,
          bomId: p.bomId,
          partId: p.part.id,
          nmiNo: p.part.nmiNo,
          fatherCode: p.bom.fatherCode,
          labelDescription: p.bom.labelDescription,
          releasedAt: p.cards.find((c) => c.status === "RELEASED")?.releasedAt ?? null,
          artworkFile: p.bom.artworkRevisions[0] ? fileView(p.bom.artworkRevisions[0].file) : null,
          currentCardRevNo: p.currentCardRevNo,
          draftRevNo: p.cards.find((c) => c.status === "DRAFT")?.revisionNo ?? null,
        })),
        pageMeta(f.page, f.pageSize, total),
      ),
    );
  });

  /** Active Father Codes not yet the Artwork No. of a finished-good part (Part Master picker). */
  r.get("/available-father-codes", requireAnyPermission("bom.product.manage", "bom.material.manage"), async (req, res) => {
    const f = query(req, z.object({ q: z.string().trim().max(60).optional() }));
    const rows = await db.bom.findMany({
      where: { status: "ACTIVE", product: null, ...(f.q ? { OR: [{ fatherCode: { contains: f.q } }, { labelDescription: { contains: f.q } }] } : {}) },
      orderBy: { fatherCode: "desc" },
      take: 10,
      include: { artworkRevisions: { orderBy: { revisionNo: "desc" }, take: 1, select: { file: true } } },
    });
    res.json(ok(rows.map((b) => ({ id: b.id, fatherCode: b.fatherCode, labelDescription: b.labelDescription, artworkRevision: b.currentArtworkRevNo, componentRevision: b.currentComponentRevNo, artworkFile: b.artworkRevisions[0] ? fileView(b.artworkRevisions[0].file) : null }))));
  });

  r.get("/:id", requirePermission("bom.view"), async (req, res) => {
    const { id } = params(req, idParam);
    res.json(ok(await svc.productDetail(db, id)));
  });

  r.get("/:id/history", requirePermission("bom.view"), async (req, res) => {
    const { id } = params(req, idParam);
    const rows = await db.auditLog.findMany({ where: { entityType: "product", entityId: id }, orderBy: { id: "desc" }, take: 200 });
    res.json(ok(rows.map((x) => ({ id: x.id.toString(), occurredAt: x.occurredAt, userName: x.userName, action: x.action, previous: x.previous, next: x.next, remarks: x.remarks }))));
  });

  // Create / edit / status of the finished-good part: Part Master (/materials).

  r.post("/:id/cards", requirePermission("bom.product.manage"), async (req, res) => {
    const { id } = params(req, idParam);
    const card = await db.$transaction((tx) => svc.createDraft(tx, actor(req), id));
    res.status(201).json(ok({ id: card.id, revisionNo: card.revisionNo }));
  });
  r.patch("/:id/cards/:cardId", requirePermission("bom.product.manage"), async (req, res) => {
    const { id, cardId } = params(req, cardParams);
    const input = body(req, z.object({ spec: svc.specSchema.optional(), routineId: z.uuid().nullable().optional(), changeNote: patchText(500), refreshRevisions: z.boolean().optional() }));
    await db.$transaction((tx) => svc.updateDraft(tx, actor(req), id, cardId, input));
    res.json(ok({ saved: true }));
  });
  r.post("/:id/cards/:cardId/release", requirePermission("bom.mastercard.release"), async (req, res) => {
    const { id, cardId } = params(req, cardParams);
    const result = await db.$transaction((tx) => svc.releaseCard(tx, actor(req), id, cardId, deps.now()));
    res.json(ok(result));
  });
  r.delete("/:id/cards/:cardId", requirePermission("bom.product.manage"), async (req, res) => {
    const { id, cardId } = params(req, cardParams);
    await db.$transaction((tx) => svc.discardDraft(tx, actor(req), id, cardId));
    res.json(ok({ discarded: true }));
  });

  return r;
}
