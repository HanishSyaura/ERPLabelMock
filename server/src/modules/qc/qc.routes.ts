import { Router, type Request } from "express";
import { z } from "zod";
import type { Prisma } from "../../generated/prisma/client";
import type { Deps } from "../../deps";
import { errors } from "../../lib/errors";
import { body, idParam, ok, pageMeta, params, query } from "../../lib/http";
import { nextNumber } from "../../lib/numbering";
import { D, isQtyInput, q } from "../../lib/qty";
import { requireAnyPermission, requirePermission } from "../../middleware/auth";
import { hasPermission, requireUser } from "../../middleware/context";
import { recordAudit } from "../audit/audit.service";
import { text } from "../masterdata/fields";
import type { Actor } from "../planning/orders.service";
import * as svc from "./inspection.service";
import { LABEL_FIELDS, type LabelField } from "./masters.routes";

/**
 * IQC / OQC Check In / Check Out and Shipping Labels (mounted at /qc).
 * Labels come only from OQC lots that passed or were accepted, up to the
 * released quantity; printed values are frozen per label. A reprint needs
 * qc.label.reprint and a reason; voiding needs a reason.
 */
const qty = z.union([z.number(), z.string()]).refine((v) => isQtyInput(v) && Number(v) > 0, "Enter a quantity greater than 0 (max 4 decimals)");
const optQty = z.union([z.number(), z.string(), z.null()]).optional().transform((v) => (v === null || v === undefined || String(v).trim() === "" ? null : v)).refine((v) => v === null || isQtyInput(v), "Enter a quantity (max 4 decimals)");
const listSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
  q: z.string().trim().max(60).optional(),
  status: z.string().max(30).optional(),
  /** open = in inspection or waiting for a disposition. */
  view: z.enum(["open", "closed", "all"]).default("open"),
});

const OPEN: Prisma.QcInspectionWhereInput = { status: { in: ["IN_INSPECTION", "PENDING_DISPOSITION"] } };
const CLOSED: Prisma.QcInspectionWhereInput = { status: { notIn: ["IN_INSPECTION", "PENDING_DISPOSITION"] } };

export function qcRoutes(deps: Deps) {
  const r = Router();
  const { db } = deps;
  const actor = (req: Request): Actor => ({ user: requireUser(req), ctx: req.ctx });

  async function names(ids: (string | null | undefined)[]) {
    const unique = [...new Set(ids.filter((x): x is string => !!x))];
    const users = unique.length ? await db.user.findMany({ where: { id: { in: unique } }, select: { id: true, fullName: true } }) : [];
    return new Map(users.map((u) => [u.id, u.fullName]));
  }

  const INCLUDE = {
    material: { select: { id: true, code: true, description: true, category: { select: { name: true } } } },
    workOrder: { select: { id: true, woNo: true, quantity: true, pjo: { select: { id: true, pjoNo: true, customerRef: true, bom: { select: { fatherCode: true } }, artworkRevision: { select: { labelDescription: true } } } } } },
    template: { select: { id: true, code: true, name: true } },
    reinspection: { select: { id: true, inspNo: true, status: true } },
    reinspectionOf: { select: { id: true, inspNo: true } },
  } satisfies Prisma.QcInspectionInclude;
  type Row = Prisma.QcInspectionGetPayload<{ include: typeof INCLUDE }>;
  const rowView = (i: Row, who: Map<string, string>) => ({
    id: i.id,
    inspNo: i.inspNo,
    type: i.type,
    status: i.status,
    result: i.result,
    disposition: i.disposition,
    qty: q(i.qty),
    uom: i.uom,
    sampleSize: i.sampleSize ? q(i.sampleSize) : null,
    goodQty: i.goodQty ? q(i.goodQty) : null,
    rejectQty: i.rejectQty ? q(i.rejectQty) : null,
    part: i.material ? { id: i.material.id, code: i.material.code, description: i.material.description, category: i.material.category?.name ?? null } : null,
    lotRef: i.lotRef,
    supplierName: i.supplierName,
    deliveryRef: i.deliveryRef,
    workOrder: i.workOrder
      ? { id: i.workOrder.id, woNo: i.workOrder.woNo, pjoId: i.workOrder.pjo.id, pjoNo: i.workOrder.pjo.pjoNo, customerRef: i.workOrder.pjo.customerRef, fatherCode: i.workOrder.pjo.bom.fatherCode, labelDescription: i.workOrder.pjo.artworkRevision.labelDescription }
      : null,
    template: i.template,
    reinspection: i.reinspection,
    reinspectionOf: i.reinspectionOf,
    checkedInAt: i.checkedInAt,
    checkedInBy: who.get(i.checkedInById) ?? null,
    checkedOutAt: i.checkedOutAt,
    checkedOutBy: i.checkedOutById ? (who.get(i.checkedOutById) ?? null) : null,
  });

  // ----- Inspections -----------------------------------------------------------
  for (const type of ["IQC", "OQC"] as const) {
    const lower = type.toLowerCase();
    const VIEW = requirePermission(`qc.${lower}.view`);
    r.get(`/${lower}`, VIEW, async (req, res) => {
      const f = query(req, listSchema);
      const where: Prisma.QcInspectionWhereInput = {
        type,
        ...(f.view === "open" ? OPEN : f.view === "closed" ? CLOSED : {}),
        ...(f.status ? { status: f.status as never } : {}),
        ...(f.q
          ? {
              OR: [
                { inspNo: { contains: f.q } },
                { lotRef: { contains: f.q } },
                { deliveryRef: { contains: f.q } },
                { supplierName: { contains: f.q } },
                { material: { code: { contains: f.q } } },
                { workOrder: { woNo: { contains: f.q } } },
                { workOrder: { pjo: { pjoNo: { contains: f.q } } } },
              ],
            }
          : {}),
      };
      const [total, rows, open, pending] = await Promise.all([
        db.qcInspection.count({ where }),
        db.qcInspection.findMany({ where, orderBy: { checkedInAt: "desc" }, skip: (f.page - 1) * f.pageSize, take: f.pageSize, include: INCLUDE }),
        db.qcInspection.count({ where: { type, status: "IN_INSPECTION" } }),
        db.qcInspection.count({ where: { type, status: "PENDING_DISPOSITION" } }),
      ]);
      const who = await names(rows.flatMap((i) => [i.checkedInById, i.checkedOutById]));
      res.json(ok(rows.map((i) => rowView(i, who)), { ...pageMeta(f.page, f.pageSize, total), counts: { inInspection: open, pendingDisposition: pending } }));
    });
  }

  r.get("/inspections/:id", requireAnyPermission("qc.iqc.view", "qc.oqc.view"), async (req, res) => {
    const { id } = params(req, idParam);
    const i = await db.qcInspection.findUnique({
      where: { id },
      include: { ...INCLUDE, defects: { include: { defectCode: { select: { code: true, name: true, category: true, severity: true } } } }, labels: { orderBy: { cartonNo: "asc" } } },
    });
    if (!i) throw errors.notFound("Inspection");
    if (!hasPermission(requireUser(req), `qc.${i.type.toLowerCase()}.view`)) throw errors.forbidden();
    const who = await names([i.checkedInById, i.checkedOutById, i.dispositionById, ...i.labels.map((l) => l.createdById)]);
    const labelled = i.labels.filter((l) => l.status === "ACTIVE").reduce((s, l) => s.plus(D(l.qty)), D(0));
    const released = svc.releasedQty(i);
    res.json(
      ok({
        ...rowView(i, who),
        checks: i.checks,
        remarks: i.remarks,
        dispositionNote: i.dispositionNote,
        dispositionAt: i.dispositionAt,
        dispositionBy: i.dispositionById ? (who.get(i.dispositionById) ?? null) : null,
        defects: i.defects.map((d) => ({ id: d.id, qty: q(d.qty), remark: d.remark, ...d.defectCode })),
        releasedQty: q(released),
        labelledQty: q(labelled),
        labels: i.labels.map((l) => ({ id: l.id, labelNo: l.labelNo, cartonNo: l.cartonNo, cartonCount: l.cartonCount, qty: q(l.qty), uom: l.uom, status: l.status, printCount: l.printCount, lastPrintedAt: l.lastPrintedAt, voidReason: l.voidReason, createdBy: who.get(l.createdById) ?? null })),
      }),
    );
  });

  r.post("/iqc", requirePermission("qc.iqc.inspect"), async (req, res) => {
    const input = body(
      req,
      z.object({
        materialId: z.uuid({ message: "Choose the part" }),
        lotRef: z.string().trim().min(1, "Enter the lot / roll no.").max(60),
        supplierName: text(120),
        deliveryRef: text(60),
        qty,
        uom: text(10),
        sampleSize: optQty,
        templateId: z.uuid().nullable().optional(),
        remarks: text(500),
      }),
    );
    const insp = await db.$transaction((tx) => svc.checkInIqc(tx, actor(req), input, deps.now()));
    res.status(201).json(ok({ id: insp.id, inspNo: insp.inspNo }));
  });

  r.get("/oqc-candidates", requirePermission("qc.oqc.inspect"), async (req, res) => {
    const f = query(req, z.object({ q: z.string().trim().max(60).optional() }));
    const wos = await db.workOrder.findMany({
      where: { status: { in: ["IN_PROGRESS", "PARTIALLY_COMPLETED", "COMPLETED"] }, ...(f.q ? { OR: [{ woNo: { contains: f.q } }, { pjo: { pjoNo: { contains: f.q } } }] } : {}) },
      orderBy: { woNo: "desc" },
      take: 30,
      include: { pjo: { select: { pjoNo: true, bom: { select: { fatherCode: true } } } } },
    });
    const rows = await Promise.all(
      wos.map(async (w) => {
        const a = await svc.oqcAvailability(db, w.id);
        return { id: w.id, woNo: w.woNo, status: w.status, pjoNo: w.pjo.pjoNo, fatherCode: w.pjo.bom.fatherCode, uom: w.uom, finishedQty: q(a.finalGood), offeredQty: q(a.offered), availableQty: q(a.available) };
      }),
    );
    res.json(ok(rows.filter((x) => Number(x.availableQty) > 0)));
  });

  r.post("/oqc", requirePermission("qc.oqc.inspect"), async (req, res) => {
    const input = body(req, z.object({ workOrderId: z.uuid({ message: "Choose the Job Order" }), qty, sampleSize: optQty, templateId: z.uuid().nullable().optional(), remarks: text(500) }));
    const insp = await db.$transaction((tx) => svc.checkInOqc(tx, actor(req), input, deps.now()));
    res.status(201).json(ok({ id: insp.id, inspNo: insp.inspNo }));
  });

  r.post("/inspections/:id/check-out", requireAnyPermission("qc.iqc.inspect", "qc.oqc.inspect"), async (req, res) => {
    const { id } = params(req, idParam);
    const input = body(
      req,
      z.object({
        results: z.array(z.object({ index: z.number().int().min(0), pass: z.boolean().nullable().optional(), value: z.number().nullable().optional(), note: text(255) })).max(40),
        rejectQty: optQty,
        sampleSize: optQty,
        defects: z.array(z.object({ defectCodeId: z.uuid({ message: "Choose the defect" }), qty, remark: text(255) })).max(40).default([]),
        remarks: text(500),
      }),
    );
    const found = await db.qcInspection.findUnique({ where: { id }, select: { type: true } });
    if (!found) throw errors.notFound("Inspection");
    if (!hasPermission(requireUser(req), `qc.${found.type.toLowerCase()}.inspect`)) throw errors.forbidden();
    res.json(ok(await db.$transaction((tx) => svc.checkOut(tx, actor(req), id, input, deps.now()))));
  });

  r.post("/inspections/:id/disposition", requireAnyPermission("qc.iqc.disposition", "qc.oqc.disposition"), async (req, res) => {
    const { id } = params(req, idParam);
    const input = body(req, z.object({ disposition: z.enum(["USE_AS_IS", "REJECT", "REWORK", "RETURN_TO_SUPPLIER"]), note: z.string().trim().min(1, "Give the reason for this disposition").max(500) }));
    const found = await db.qcInspection.findUnique({ where: { id }, select: { type: true } });
    if (!found) throw errors.notFound("Inspection");
    if (!hasPermission(requireUser(req), `qc.${found.type.toLowerCase()}.disposition`)) throw errors.forbidden();
    res.json(ok(await db.$transaction((tx) => svc.dispose(tx, actor(req), id, input.disposition, input.note, deps.now()))));
  });

  r.post("/inspections/:id/reinspect", requirePermission("qc.oqc.inspect"), async (req, res) => {
    const { id } = params(req, idParam);
    const input = body(req, z.object({ qty: optQty, remarks: text(500) }));
    const next = await db.$transaction((tx) => svc.reinspect(tx, actor(req), id, input, deps.now()));
    res.status(201).json(ok({ id: next.id, inspNo: next.inspNo }));
  });

  // ----- Shipping labels ---------------------------------------------------------
  r.get("/labels", requireAnyPermission("qc.label.view", "qc.label.generate"), async (req, res) => {
    const f = query(req, z.object({ page: z.coerce.number().int().min(1).default(1), pageSize: z.coerce.number().int().min(1).max(500).default(25), q: z.string().trim().max(60).optional(), status: z.enum(["ACTIVE", "VOID"]).optional(), ids: z.string().max(20000).optional() }));
    const ids = f.ids ? f.ids.split(",").filter(Boolean).slice(0, 500) : null;
    const where: Prisma.ShippingLabelWhereInput = {
      ...(ids ? { id: { in: ids } } : {}),
      ...(f.status ? { status: f.status } : {}),
      ...(f.q ? { OR: [{ labelNo: { contains: f.q } }, { inspection: { inspNo: { contains: f.q } } }, { inspection: { workOrder: { woNo: { contains: f.q } } } }] } : {}),
    };
    const [total, rows] = await Promise.all([
      db.shippingLabel.count({ where }),
      db.shippingLabel.findMany({ where, orderBy: [{ createdAt: "desc" }, { cartonNo: "asc" }], skip: (f.page - 1) * f.pageSize, take: f.pageSize, include: { inspection: { select: { id: true, inspNo: true } }, template: { select: { code: true, name: true } } } }),
    ]);
    res.json(
      ok(
        rows.map((l) => ({ id: l.id, labelNo: l.labelNo, cartonNo: l.cartonNo, cartonCount: l.cartonCount, qty: q(l.qty), uom: l.uom, status: l.status, printCount: l.printCount, lastPrintedAt: l.lastPrintedAt, voidReason: l.voidReason, data: l.data, inspection: l.inspection, template: l.template, createdAt: l.createdAt })),
        pageMeta(f.page, f.pageSize, total),
      ),
    );
  });

  /** OQC lots that can still be labelled. */
  r.get("/labels/ready", requirePermission("qc.label.generate"), async (_req, res) => {
    const lots = await db.qcInspection.findMany({
      where: { type: "OQC", status: { in: ["PASSED", "ACCEPTED"] } },
      orderBy: { checkedOutAt: "desc" },
      take: 50,
      include: { workOrder: { select: { woNo: true, pjo: { select: { pjoNo: true, bom: { select: { fatherCode: true } } } } } }, labels: { where: { status: "ACTIVE" }, select: { qty: true } } },
    });
    res.json(
      ok(
        lots
          .map((i) => {
            const labelled = i.labels.reduce((s, l) => s.plus(D(l.qty)), D(0));
            const remaining = svc.releasedQty(i).minus(labelled);
            return { id: i.id, inspNo: i.inspNo, status: i.status, woNo: i.workOrder?.woNo ?? null, pjoNo: i.workOrder?.pjo.pjoNo ?? null, fatherCode: i.workOrder?.pjo.bom.fatherCode ?? null, uom: i.uom, releasedQty: q(svc.releasedQty(i)), labelledQty: q(labelled), remainingQty: q(remaining) };
          })
          .filter((x) => Number(x.remainingQty) > 0),
      ),
    );
  });

  r.post("/labels", requirePermission("qc.label.generate"), async (req, res) => {
    const user = requireUser(req);
    const input = body(req, z.object({ inspectionId: z.uuid({ message: "Choose the OQC lot" }), templateId: z.uuid({ message: "Choose a label template" }), totalQty: qty, qtyPerCarton: qty }));
    const now = deps.now();
    const out = await db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM qc_inspections WHERE id = ${input.inspectionId} FOR UPDATE`;
      const insp = await tx.qcInspection.findUnique({
        where: { id: input.inspectionId },
        include: {
          labels: { where: { status: "ACTIVE" }, select: { qty: true } },
          workOrder: { include: { pjo: { include: { bom: { select: { fatherCode: true } }, artworkRevision: { select: { labelDescription: true } }, product: { select: { productCode: true, name: true, customerName: true, customerPartNo: true } } } } } },
        },
      });
      if (!insp || insp.type !== "OQC") throw errors.validation([{ path: "inspectionId", message: "Choose an OQC lot" }]);
      if (insp.status !== "PASSED" && insp.status !== "ACCEPTED") throw errors.rule("NOT_RELEASED", `${insp.inspNo} isn't released by QC.`);
      const template = await tx.labelTemplate.findUnique({ where: { id: input.templateId } });
      if (!template || template.status !== "ACTIVE") throw errors.validation([{ path: "templateId", message: "Choose an active label template" }]);
      const labelled = insp.labels.reduce((s, l) => s.plus(D(l.qty)), D(0));
      const remaining = svc.releasedQty(insp).minus(labelled);
      const total = D(input.totalQty);
      const per = D(input.qtyPerCarton);
      if (total.greaterThan(remaining)) throw errors.validation([{ path: "totalQty", message: `Only ${q(remaining)} ${insp.uom} of ${insp.inspNo} is released and not yet labelled` }]);
      if (per.greaterThan(total)) throw errors.validation([{ path: "qtyPerCarton", message: "Qty per carton can't exceed the total" }]);
      const cartons = Math.ceil(total.dividedBy(per).toNumber());
      if (cartons > 500) throw errors.validation([{ path: "qtyPerCarton", message: `That makes ${cartons} labels; at most 500 at a time` }]);
      const wo = insp.workOrder!;
      const pjo = wo.pjo;
      const base: Partial<Record<LabelField, string | null>> = {
        customerName: pjo.product?.customerName ?? null,
        productCode: pjo.product?.productCode ?? pjo.productRef ?? null,
        productName: pjo.product?.name ?? null,
        customerPartNo: pjo.product?.customerPartNo ?? null,
        customerRef: pjo.customerRef,
        fatherCode: pjo.bom.fatherCode,
        labelDescription: pjo.artworkRevision.labelDescription,
        pjoNo: pjo.pjoNo,
        woNo: wo.woNo,
        lotNo: insp.inspNo,
        packedDate: now.toISOString().slice(0, 10),
        inspector: user.fullName,
      };
      const ids: string[] = [];
      for (let c = 1; c <= cartons; c++) {
        const cartonQty = c < cartons ? per : total.minus(per.times(cartons - 1));
        const labelNo = await nextNumber(tx, "LBL", now);
        const data: Record<string, string | null> = { ...base, labelNo, qty: `${q(cartonQty)} ${insp.uom}`, cartonNo: `${c} / ${cartons}` };
        const fields = (template.fields as string[]).filter((k) => (LABEL_FIELDS as readonly string[]).includes(k));
        const l = await tx.shippingLabel.create({
          data: { labelNo, inspectionId: insp.id, templateId: template.id, cartonNo: c, cartonCount: cartons, qty: cartonQty, uom: insp.uom, data: { ...data, fields, barcode: template.barcode, barcodeValue: data[template.barcodeField] ?? labelNo, widthMm: template.widthMm, heightMm: template.heightMm } as Prisma.InputJsonValue, createdById: user.id },
        });
        ids.push(l.id);
      }
      await recordAudit(tx, req.ctx, { module: "qc", action: "LABELS_GENERATED", entityType: "qc_inspection", entityId: insp.id, recordRef: insp.inspNo, next: { labels: cartons, total: q(total), perCarton: q(per), template: template.code } });
      return { ids, cartons };
    });
    res.status(201).json(ok(out));
  });

  /** Mark labels printed. A label printed before needs qc.label.reprint and a reason. */
  r.post("/labels/print", requireAnyPermission("qc.label.generate", "qc.label.reprint"), async (req, res) => {
    const user = requireUser(req);
    const input = body(req, z.object({ ids: z.array(z.uuid()).min(1).max(500), reason: text(255) }));
    const out = await db.$transaction(async (tx) => {
      const labels = await tx.shippingLabel.findMany({ where: { id: { in: input.ids } } });
      if (labels.length !== input.ids.length) throw errors.notFound("Label");
      if (labels.some((l) => l.status === "VOID")) throw errors.rule("LABEL_VOID", "Void labels can't be printed.");
      const reprints = labels.filter((l) => l.printCount > 0);
      if (reprints.length) {
        if (!hasPermission(user, "qc.label.reprint")) throw errors.forbidden("Reprinting needs the reprint permission.");
        if (!input.reason) throw errors.validation([{ path: "reason", message: "Give the reason for the reprint" }]);
      } else if (!hasPermission(user, "qc.label.generate")) throw errors.forbidden();
      const now = deps.now();
      await tx.shippingLabel.updateMany({ where: { id: { in: input.ids } }, data: { printCount: { increment: 1 }, lastPrintedAt: now } });
      for (const l of reprints) {
        await recordAudit(tx, req.ctx, { module: "qc", action: "LABEL_REPRINTED", entityType: "shipping_label", entityId: l.id, recordRef: l.labelNo, previous: { printCount: l.printCount }, next: { printCount: l.printCount + 1 }, remarks: input.reason });
      }
      return { printed: labels.length, reprinted: reprints.length };
    });
    res.json(ok(out));
  });

  r.post("/labels/:id/void", requirePermission("qc.label.generate"), async (req, res) => {
    const { id } = params(req, idParam);
    const { reason } = body(req, z.object({ reason: z.string().trim().min(1, "Give the reason").max(255) }));
    await db.$transaction(async (tx) => {
      const l = await tx.shippingLabel.findUnique({ where: { id } });
      if (!l) throw errors.notFound("Label");
      if (l.status === "VOID") throw errors.rule("LABEL_VOID", `${l.labelNo} is already void.`);
      await tx.shippingLabel.update({ where: { id }, data: { status: "VOID", voidReason: reason } });
      await recordAudit(tx, req.ctx, { module: "qc", action: "LABEL_VOIDED", entityType: "shipping_label", entityId: id, recordRef: l.labelNo, previous: { status: "ACTIVE" }, next: { status: "VOID" }, remarks: reason });
    });
    res.json(ok({ voided: true }));
  });

  return r;
}
