import { Router } from "express";
import { z } from "zod";
import type { Prisma } from "../../generated/prisma/client";
import type { Deps } from "../../deps";
import { errors } from "../../lib/errors";
import { body, idParam, ok, pageMeta, params, query } from "../../lib/http";
import { q } from "../../lib/qty";
import { requirePermission } from "../../middleware/auth";
import { requireUser } from "../../middleware/context";
import { diff, recordAudit } from "../audit/audit.service";
import { code, dec, measure, requiredMeasure, statusSchema, text, wholeNumber } from "./fields";

/**
 * Die Cut Master (mounted at /die-cuts): cutting tools by die no. Sizes are the
 * finished label (width across the web x height around), the layout (labels
 * across / around, gaps) and, for rotary dies, gear teeth and repeat length.
 * Codes are immutable; dies are deactivated (retired), never deleted.
 */
/** 1/8" circular pitch gears: one tooth = 3.175 mm of repeat. */
export const TOOTH_PITCH_MM = 3.175;
const repeatFromTeeth = (teeth: number) => q((teeth * TOOTH_PITCH_MM).toFixed(3));

const shape = {
  description: z.string().trim().min(1, "Enter the description").max(255),
  dieType: z.enum(["ROTARY_SOLID", "FLEXIBLE", "FLATBED"], { message: "Choose the die type" }),
  cutType: z.enum(["KISS_CUT", "THROUGH_CUT", "PERFORATION"]).optional(),
  shape: z.enum(["RECTANGLE", "ROUNDED_RECTANGLE", "CIRCLE", "OVAL", "SPECIAL"]).optional(),
  labelWidthMm: requiredMeasure(6, 2, "the label width in mm"),
  labelHeightMm: requiredMeasure(6, 2, "the label height in mm"),
  cornerRadiusMm: measure(4, 2, "the corner radius in mm"),
  across: z.coerce.number({ message: "Enter labels across" }).int("Whole number").min(1, "At least 1").max(50),
  around: z.coerce.number().int("Whole number").min(1, "At least 1").max(200).optional(),
  gapAcrossMm: measure(4, 3, "the gap across in mm", true),
  gapAroundMm: measure(4, 3, "the gap around in mm", true),
  gearTeeth: wholeNumber(20, 400, "the gear teeth"),
  repeatMm: measure(5, 3, "the repeat in mm"),
  condition: z.enum(["GOOD", "WORN", "DAMAGED"]).optional(),
  location: text(60),
  supplierName: text(120),
  remarks: text(500),
};
const createSchema = z.object({ code: code(30, "die no."), ...shape });
const updateSchema = z.object(shape).partial();
const listSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
  q: z.string().trim().max(60).optional(),
  status: z.enum(["ACTIVE", "INACTIVE"]).optional(),
  dieType: z.enum(["ROTARY_SOLID", "FLEXIBLE", "FLATBED"]).optional(),
  /** Find dies for a label size (± 0.5 mm). */
  width: z.coerce.number().positive().optional(),
  height: z.coerce.number().positive().optional(),
});

type Dec = { toString(): string } | null;
const view = <T extends { labelWidthMm: Dec; labelHeightMm: Dec; cornerRadiusMm: Dec; gapAcrossMm: Dec; gapAroundMm: Dec; repeatMm: Dec }>(d: T) => ({
  ...d,
  labelWidthMm: dec(d.labelWidthMm),
  labelHeightMm: dec(d.labelHeightMm),
  cornerRadiusMm: dec(d.cornerRadiusMm),
  gapAcrossMm: dec(d.gapAcrossMm),
  gapAroundMm: dec(d.gapAroundMm),
  repeatMm: dec(d.repeatMm),
});

/** Rules that span fields, checked on the merged record. */
function checkDie(d: { dieType: string; shape: string; labelWidthMm: string | null; labelHeightMm: string | null; cornerRadiusMm: string | null; around: number; gearTeeth: number | null; repeatMm: string | null }) {
  const issues: { path: string; message: string }[] = [];
  if (d.shape === "CIRCLE" && d.labelWidthMm && d.labelHeightMm && Number(d.labelWidthMm) !== Number(d.labelHeightMm)) {
    issues.push({ path: "labelHeightMm", message: "A circle has the same width and height" });
  }
  if (d.cornerRadiusMm && d.labelWidthMm && d.labelHeightMm && Number(d.cornerRadiusMm) * 2 > Math.min(Number(d.labelWidthMm), Number(d.labelHeightMm))) {
    issues.push({ path: "cornerRadiusMm", message: "The corner radius can't exceed half the label's shorter side" });
  }
  if (d.dieType === "ROTARY_SOLID" && !d.gearTeeth && !d.repeatMm) {
    issues.push({ path: "gearTeeth", message: "A rotary die needs its gear teeth or repeat length" });
  }
  if (d.repeatMm && d.labelHeightMm && Number(d.labelHeightMm) * d.around > Number(d.repeatMm) + 0.001) {
    issues.push({ path: "around", message: `${d.around} labels of ${d.labelHeightMm} mm don't fit in a ${d.repeatMm} mm repeat` });
  }
  if (issues.length) throw errors.validation(issues);
}

export function dieCutRoutes(deps: Deps) {
  const r = Router();
  const { db } = deps;
  const VIEW = requirePermission("planning.master.view");
  const MANAGE = requirePermission("planning.master.manage");

  r.get("/", VIEW, async (req, res) => {
    const f = query(req, listSchema);
    const near = (v: number) => ({ gte: v - 0.5, lte: v + 0.5 });
    const where: Prisma.DieCutWhereInput = {
      ...(f.status ? { status: f.status } : {}),
      ...(f.dieType ? { dieType: f.dieType } : {}),
      ...(f.width ? { labelWidthMm: near(f.width) } : {}),
      ...(f.height ? { labelHeightMm: near(f.height) } : {}),
      ...(f.q ? { OR: [{ code: { contains: f.q } }, { description: { contains: f.q } }, { location: { contains: f.q } }] } : {}),
    };
    const [total, rows] = await Promise.all([
      db.dieCut.count({ where }),
      db.dieCut.findMany({ where, orderBy: { code: "asc" }, skip: (f.page - 1) * f.pageSize, take: f.pageSize }),
    ]);
    res.json(ok(rows.map(view), pageMeta(f.page, f.pageSize, total)));
  });

  r.get("/:id", VIEW, async (req, res) => {
    const { id } = params(req, idParam);
    const d = await db.dieCut.findUnique({ where: { id } });
    if (!d) throw errors.notFound("Die");
    res.json(ok(view(d)));
  });

  r.post("/", MANAGE, async (req, res) => {
    const user = requireUser(req);
    const input = body(req, createSchema);
    // Rotary repeat from the gear teeth when only the teeth are given.
    const repeatMm = input.repeatMm ?? (input.gearTeeth ? repeatFromTeeth(input.gearTeeth) : null);
    checkDie({ dieType: input.dieType, shape: input.shape ?? "RECTANGLE", labelWidthMm: input.labelWidthMm, labelHeightMm: input.labelHeightMm, cornerRadiusMm: input.cornerRadiusMm ?? null, around: input.around ?? 1, gearTeeth: input.gearTeeth ?? null, repeatMm });
    const row = await db.$transaction(async (tx) => {
      if (await tx.dieCut.findUnique({ where: { code: input.code } })) throw errors.validation([{ path: "code", message: "This die no. already exists" }]);
      const d = await tx.dieCut.create({ data: { ...input, repeatMm, createdById: user.id, updatedById: user.id } });
      await recordAudit(tx, req.ctx, { module: "masterdata", action: "DIE_CUT_CREATED", entityType: "die_cut", entityId: d.id, recordRef: d.code, next: { ...input, repeatMm } });
      return view(d);
    });
    res.status(201).json(ok(row));
  });

  r.patch("/:id", MANAGE, async (req, res) => {
    const user = requireUser(req);
    const { id } = params(req, idParam);
    const input = body(req, updateSchema);
    const row = await db.$transaction(async (tx) => {
      const found = await tx.dieCut.findUnique({ where: { id } });
      if (!found) throw errors.notFound("Die");
      const before = view(found);
      if (input.gearTeeth && input.repeatMm === undefined && input.gearTeeth !== before.gearTeeth) input.repeatMm = repeatFromTeeth(input.gearTeeth);
      const merged = { ...before, ...Object.fromEntries(Object.entries(input).filter(([, v]) => v !== undefined)) } as typeof before;
      checkDie(merged);
      const change = diff(before as Record<string, unknown>, input);
      if (!change.changed) return before;
      const d = await tx.dieCut.update({ where: { id }, data: { ...input, updatedById: user.id } });
      await recordAudit(tx, req.ctx, { module: "masterdata", action: "DIE_CUT_UPDATED", entityType: "die_cut", entityId: id, recordRef: d.code, previous: change.previous, next: change.next });
      return view(d);
    });
    res.json(ok(row));
  });

  r.put("/:id/status", MANAGE, async (req, res) => {
    const user = requireUser(req);
    const { id } = params(req, idParam);
    const { status, reason } = body(req, statusSchema.extend({ reason: text(255) }));
    if (status === "INACTIVE" && !reason) throw errors.validation([{ path: "reason", message: "Say why the die is retired" }]);
    const row = await db.$transaction(async (tx) => {
      const before = await tx.dieCut.findUnique({ where: { id } });
      if (!before) throw errors.notFound("Die");
      if (before.status === status) return view(before);
      const d = await tx.dieCut.update({ where: { id }, data: { status, updatedById: user.id } });
      await recordAudit(tx, req.ctx, {
        module: "masterdata", action: status === "ACTIVE" ? "DIE_CUT_ACTIVATED" : "DIE_CUT_RETIRED", entityType: "die_cut", entityId: id, recordRef: d.code,
        previous: { status: before.status }, next: { status }, remarks: reason,
      });
      return view(d);
    });
    res.json(ok(row));
  });

  return r;
}
