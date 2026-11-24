import { Router } from "express";
import { z } from "zod";
import type { Deps } from "../../deps";
import { errors } from "../../lib/errors";
import { body, idParam, ok, params, query } from "../../lib/http";
import { requireAnyPermission, requirePermission } from "../../middleware/auth";
import { requireUser } from "../../middleware/context";
import { diff, recordAudit } from "../audit/audit.service";
import { code, statusSchema, text } from "../masterdata/fields";

/**
 * QC masters (mounted at /qc): Defect Master, Inspection Templates and
 * Shipping Label templates. Codes are immutable; records are deactivated,
 * never deleted. Inspections copy template items at Check In and labels freeze
 * their printed values, so editing a template never changes history.
 */
export const DEFECT_CATEGORIES = ["PRINT", "COLOUR", "REGISTRATION", "DIE_CUT", "MATERIAL", "ADHESIVE", "LAMINATION", "SLITTING", "WINDING", "CONTAMINATION", "PACKAGING", "OTHER"] as const;

/** Fields a shipping label can print, in the order a template lists them. */
export const LABEL_FIELDS = [
  "labelNo",
  "customerName",
  "productCode",
  "productName",
  "customerPartNo",
  "customerRef",
  "fatherCode",
  "labelDescription",
  "pjoNo",
  "woNo",
  "lotNo",
  "qty",
  "cartonNo",
  "packedDate",
  "inspector",
] as const;
export type LabelField = (typeof LABEL_FIELDS)[number];

const templateItem = z
  .object({
    label: z.string().trim().min(1, "Enter the check").max(120),
    kind: z.enum(["PASS_FAIL", "MEASURE"]),
    target: text(60),
    min: z.number().nullable().optional(),
    max: z.number().nullable().optional(),
    unit: text(20),
    required: z.boolean().default(true),
  })
  .superRefine((it, ctx) => {
    if (it.kind === "MEASURE" && it.min == null && it.max == null) ctx.addIssue({ code: "custom", path: ["min"], message: "A measurement needs a minimum or maximum" });
    if (it.min != null && it.max != null && it.min > it.max) ctx.addIssue({ code: "custom", path: ["max"], message: "Maximum must be at least the minimum" });
  });
export type TemplateItem = z.infer<typeof templateItem>;

const defectSchema = z.object({
  code: code(20, "defect code"),
  name: z.string().trim().min(1, "Enter the name").max(80),
  category: z.enum(DEFECT_CATEGORIES, { message: "Choose a category" }),
  severity: z.enum(["MINOR", "MAJOR", "CRITICAL"]).default("MAJOR"),
  appliesIqc: z.boolean().default(true),
  appliesOqc: z.boolean().default(true),
  description: text(255),
});
const inspTemplateSchema = z.object({
  code: code(20, "template code"),
  name: z.string().trim().min(1, "Enter the name").max(80),
  type: z.enum(["IQC", "OQC"]),
  partCategoryId: z.uuid().nullable().optional(),
  items: z.array(templateItem).min(1, "Add at least one check").max(40),
});
const labelTemplateSchema = z.object({
  code: code(20, "template code"),
  name: z.string().trim().min(1, "Enter the name").max(80),
  widthMm: z.coerce.number().int().min(20, "At least 20 mm").max(300),
  heightMm: z.coerce.number().int().min(15, "At least 15 mm").max(300),
  fields: z.array(z.enum(LABEL_FIELDS)).min(1, "Choose at least one field").max(LABEL_FIELDS.length),
  barcode: z.enum(["CODE128", "QR"]).default("CODE128"),
  barcodeField: z.enum(LABEL_FIELDS).default("labelNo"),
});

export function qcMasterRoutes(deps: Deps) {
  const r = Router();
  const { db } = deps;

  // ----- Defect Master -------------------------------------------------------
  r.get("/defects", requireAnyPermission("qc.defect.view", "qc.iqc.inspect", "qc.oqc.inspect"), async (req, res) => {
    const f = query(req, z.object({ status: z.enum(["ACTIVE", "INACTIVE"]).optional(), type: z.enum(["IQC", "OQC"]).optional() }));
    const rows = await db.defectCode.findMany({
      where: { ...(f.status ? { status: f.status } : {}), ...(f.type === "IQC" ? { appliesIqc: true } : f.type === "OQC" ? { appliesOqc: true } : {}) },
      orderBy: [{ category: "asc" }, { code: "asc" }],
      include: { _count: { select: { findings: true } } },
    });
    res.json(ok(rows.map(({ _count, ...d }) => ({ ...d, findingCount: _count.findings }))));
  });
  r.post("/defects", requirePermission("qc.defect.manage"), async (req, res) => {
    const user = requireUser(req);
    const input = body(req, defectSchema);
    if (!input.appliesIqc && !input.appliesOqc) throw errors.validation([{ path: "appliesIqc", message: "Choose IQC, OQC or both" }]);
    const row = await db.$transaction(async (tx) => {
      if (await tx.defectCode.findUnique({ where: { code: input.code } })) throw errors.validation([{ path: "code", message: "This defect code already exists" }]);
      const d = await tx.defectCode.create({ data: { ...input, createdById: user.id, updatedById: user.id } });
      await recordAudit(tx, req.ctx, { module: "qc", action: "DEFECT_CREATED", entityType: "defect_code", entityId: d.id, recordRef: d.code, next: input });
      return d;
    });
    res.status(201).json(ok(row));
  });
  r.patch("/defects/:id", requirePermission("qc.defect.manage"), async (req, res) => {
    const user = requireUser(req);
    const { id } = params(req, idParam);
    const input = body(req, defectSchema.omit({ code: true }).partial());
    const row = await db.$transaction(async (tx) => {
      const before = await tx.defectCode.findUnique({ where: { id } });
      if (!before) throw errors.notFound("Defect");
      if ((input.appliesIqc ?? before.appliesIqc) === false && (input.appliesOqc ?? before.appliesOqc) === false) throw errors.validation([{ path: "appliesIqc", message: "Choose IQC, OQC or both" }]);
      const change = diff(before, input);
      if (!change.changed) return before;
      const d = await tx.defectCode.update({ where: { id }, data: { ...input, updatedById: user.id } });
      await recordAudit(tx, req.ctx, { module: "qc", action: "DEFECT_UPDATED", entityType: "defect_code", entityId: id, recordRef: d.code, previous: change.previous, next: change.next });
      return d;
    });
    res.json(ok(row));
  });
  r.put("/defects/:id/status", requirePermission("qc.defect.manage"), async (req, res) => {
    const user = requireUser(req);
    const { id } = params(req, idParam);
    const { status } = body(req, statusSchema);
    const row = await db.$transaction(async (tx) => {
      const before = await tx.defectCode.findUnique({ where: { id } });
      if (!before) throw errors.notFound("Defect");
      if (before.status === status) return before;
      const d = await tx.defectCode.update({ where: { id }, data: { status, updatedById: user.id } });
      await recordAudit(tx, req.ctx, { module: "qc", action: status === "ACTIVE" ? "DEFECT_ACTIVATED" : "DEFECT_DEACTIVATED", entityType: "defect_code", entityId: id, recordRef: d.code, previous: { status: before.status }, next: { status } });
      return d;
    });
    res.json(ok(row));
  });

  // ----- Inspection templates -----------------------------------------------
  r.get("/inspection-templates", requireAnyPermission("qc.iqc.view", "qc.oqc.view", "qc.template.manage"), async (req, res) => {
    const f = query(req, z.object({ type: z.enum(["IQC", "OQC"]).optional(), status: z.enum(["ACTIVE", "INACTIVE"]).optional() }));
    const rows = await db.inspectionTemplate.findMany({
      where: { ...(f.type ? { type: f.type } : {}), ...(f.status ? { status: f.status } : {}) },
      orderBy: [{ type: "asc" }, { code: "asc" }],
      include: { partCategory: { select: { id: true, code: true, name: true } }, _count: { select: { inspections: true } } },
    });
    res.json(ok(rows.map(({ _count, ...t }) => ({ ...t, inspectionCount: _count.inspections }))));
  });
  r.post("/inspection-templates", requirePermission("qc.template.manage"), async (req, res) => {
    const user = requireUser(req);
    const input = body(req, inspTemplateSchema);
    if (input.type === "OQC" && input.partCategoryId) throw errors.validation([{ path: "partCategoryId", message: "Only IQC templates are tied to a part category" }]);
    const row = await db.$transaction(async (tx) => {
      if (await tx.inspectionTemplate.findUnique({ where: { code: input.code } })) throw errors.validation([{ path: "code", message: "This template code already exists" }]);
      const t = await tx.inspectionTemplate.create({ data: { ...input, partCategoryId: input.partCategoryId ?? null, createdById: user.id, updatedById: user.id } });
      await recordAudit(tx, req.ctx, { module: "qc", action: "INSPECTION_TEMPLATE_CREATED", entityType: "inspection_template", entityId: t.id, recordRef: t.code, next: { ...input, items: input.items.length } });
      return t;
    });
    res.status(201).json(ok(row));
  });
  r.patch("/inspection-templates/:id", requirePermission("qc.template.manage"), async (req, res) => {
    const user = requireUser(req);
    const { id } = params(req, idParam);
    const input = body(req, inspTemplateSchema.omit({ code: true, type: true }).partial());
    const row = await db.$transaction(async (tx) => {
      const before = await tx.inspectionTemplate.findUnique({ where: { id } });
      if (!before) throw errors.notFound("Inspection template");
      if (before.type === "OQC" && input.partCategoryId) throw errors.validation([{ path: "partCategoryId", message: "Only IQC templates are tied to a part category" }]);
      const change = diff(before, input);
      if (!change.changed) return before;
      const t = await tx.inspectionTemplate.update({ where: { id }, data: { ...input, updatedById: user.id } });
      await recordAudit(tx, req.ctx, {
        module: "qc", action: "INSPECTION_TEMPLATE_UPDATED", entityType: "inspection_template", entityId: id, recordRef: t.code,
        previous: change.previous, next: change.next, remarks: "Inspections already checked in keep the checks they were created with.",
      });
      return t;
    });
    res.json(ok(row));
  });
  r.put("/inspection-templates/:id/status", requirePermission("qc.template.manage"), async (req, res) => {
    const user = requireUser(req);
    const { id } = params(req, idParam);
    const { status } = body(req, statusSchema);
    const row = await db.$transaction(async (tx) => {
      const before = await tx.inspectionTemplate.findUnique({ where: { id } });
      if (!before) throw errors.notFound("Inspection template");
      if (before.status === status) return before;
      const t = await tx.inspectionTemplate.update({ where: { id }, data: { status, updatedById: user.id } });
      await recordAudit(tx, req.ctx, { module: "qc", action: status === "ACTIVE" ? "INSPECTION_TEMPLATE_ACTIVATED" : "INSPECTION_TEMPLATE_DEACTIVATED", entityType: "inspection_template", entityId: id, recordRef: t.code, previous: { status: before.status }, next: { status } });
      return t;
    });
    res.json(ok(row));
  });

  // ----- Label templates ------------------------------------------------------
  r.get("/label-templates", requireAnyPermission("qc.label.view", "qc.label.template.manage"), async (req, res) => {
    const f = query(req, z.object({ status: z.enum(["ACTIVE", "INACTIVE"]).optional() }));
    res.json(ok(await db.labelTemplate.findMany({ where: f.status ? { status: f.status } : {}, orderBy: { code: "asc" } })));
  });
  r.post("/label-templates", requirePermission("qc.label.template.manage"), async (req, res) => {
    const user = requireUser(req);
    const input = body(req, labelTemplateSchema);
    const row = await db.$transaction(async (tx) => {
      if (await tx.labelTemplate.findUnique({ where: { code: input.code } })) throw errors.validation([{ path: "code", message: "This template code already exists" }]);
      const t = await tx.labelTemplate.create({ data: { ...input, createdById: user.id, updatedById: user.id } });
      await recordAudit(tx, req.ctx, { module: "qc", action: "LABEL_TEMPLATE_CREATED", entityType: "label_template", entityId: t.id, recordRef: t.code, next: input });
      return t;
    });
    res.status(201).json(ok(row));
  });
  r.patch("/label-templates/:id", requirePermission("qc.label.template.manage"), async (req, res) => {
    const user = requireUser(req);
    const { id } = params(req, idParam);
    const input = body(req, labelTemplateSchema.omit({ code: true }).partial());
    const row = await db.$transaction(async (tx) => {
      const before = await tx.labelTemplate.findUnique({ where: { id } });
      if (!before) throw errors.notFound("Label template");
      const change = diff(before, input);
      if (!change.changed) return before;
      const t = await tx.labelTemplate.update({ where: { id }, data: { ...input, updatedById: user.id } });
      await recordAudit(tx, req.ctx, {
        module: "qc", action: "LABEL_TEMPLATE_UPDATED", entityType: "label_template", entityId: id, recordRef: t.code,
        previous: change.previous, next: change.next, remarks: "Labels already generated keep their printed values.",
      });
      return t;
    });
    res.json(ok(row));
  });
  r.put("/label-templates/:id/status", requirePermission("qc.label.template.manage"), async (req, res) => {
    const user = requireUser(req);
    const { id } = params(req, idParam);
    const { status } = body(req, statusSchema);
    const row = await db.$transaction(async (tx) => {
      const before = await tx.labelTemplate.findUnique({ where: { id } });
      if (!before) throw errors.notFound("Label template");
      if (before.status === status) return before;
      const t = await tx.labelTemplate.update({ where: { id }, data: { status, updatedById: user.id } });
      await recordAudit(tx, req.ctx, { module: "qc", action: status === "ACTIVE" ? "LABEL_TEMPLATE_ACTIVATED" : "LABEL_TEMPLATE_DEACTIVATED", entityType: "label_template", entityId: id, recordRef: t.code, previous: { status: before.status }, next: { status } });
      return t;
    });
    res.json(ok(row));
  });

  return r;
}
