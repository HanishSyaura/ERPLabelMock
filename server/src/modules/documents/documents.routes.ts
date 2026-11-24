import { Router } from "express";
import { z } from "zod";
import type { Deps } from "../../deps";
import type { Prisma } from "../../generated/prisma/client";
import { errors } from "../../lib/errors";
import { body, idParam, ok, params, query } from "../../lib/http";
import { requireAuth, requirePermission } from "../../middleware/auth";
import { requireUser } from "../../middleware/context";
import { recordAudit } from "../audit/audit.service";
import { code, statusSchema, text } from "../masterdata/fields";

/**
 * Document templates (mounted at /documents). End users design each printed
 * document: page, header (letterhead, title, document no. / date, barcode),
 * content sections (order, titles, table columns), notes, signature boxes and
 * footer (with {docNo} {printedBy} {printedAt} {page} {pages} {company}).
 * Rendering, print and PDF happen in the browser from live data; nothing
 * printed is stored. Every signed-in user can read templates (to print);
 * maintaining them needs system.documents.manage.
 */
export const DOCUMENT_TYPES = ["PJO", "JOB_ORDER", "MRS", "MASTER_CARD", "IQC_REPORT", "OQC_REPORT"] as const;
const MANAGE = requirePermission("system.documents.manage");
const str = (max: number) => z.string().trim().max(max);

export const layoutSchema = z
  .object({
    page: z.object({
      size: z.enum(["A4", "A5", "LETTER"]),
      orientation: z.enum(["portrait", "landscape"]),
      marginMm: z.number().min(5).max(30),
      fontSizePt: z.number().min(7).max(14),
      accent: z.enum(["primary", "neutral", "success", "warning", "danger", "info"]),
      density: z.enum(["compact", "comfortable"]),
    }),
    header: z.object({
      showLogo: z.boolean(),
      logoAlign: z.enum(["left", "right"]),
      showCompanyName: z.boolean(),
      showAddress: z.boolean(),
      showContact: z.boolean(),
      showRegistration: z.boolean(),
      title: str(80),
      subtitle: str(160),
      showDocNo: z.boolean(),
      showDocDate: z.boolean(),
      showBarcode: z.boolean(),
      repeat: z.enum(["all", "first"]),
      divider: z.boolean(),
      extraText: str(500),
    }),
    sections: z
      .array(z.object({ key: str(40).min(1), enabled: z.boolean(), title: str(80), columns: z.array(str(40)).max(30).optional() }))
      .max(30),
    notes: z.object({ title: str(80), text: str(2000) }),
    signatures: z.array(z.object({ label: str(60).min(1, "Name the signature box") })).max(4),
    footer: z.object({
      left: str(300),
      center: str(300),
      right: str(300),
      showPageNumbers: z.boolean(),
      divider: z.boolean(),
    }),
  })
  .strict();

const createSchema = z.object({
  code: code(20, "template code"),
  name: z.string().trim().min(1, "Enter the template name").max(80),
  docType: z.enum(DOCUMENT_TYPES, { message: "Choose the document" }),
  layout: layoutSchema,
});
const LOGO = /^data:image\/(png|jpeg);base64,[A-Za-z0-9+/=]+$/;
const settingsSchema = z.object({
  companyName: z.string().trim().min(1, "Enter the company name").max(160),
  registrationNo: text(60),
  address: text(500),
  phone: text(60),
  email: text(120),
  website: text(120),
  logo: z.string().max(400_000, "The logo must be smaller than 300 KB").regex(LOGO, "Upload a PNG or JPEG logo").nullable().optional(),
});

export function documentRoutes(deps: Deps) {
  const r = Router();
  const { db } = deps;

  r.get("/templates", requireAuth, async (req, res) => {
    const f = query(req, z.object({ docType: z.enum(DOCUMENT_TYPES).optional(), status: z.enum(["ACTIVE", "INACTIVE"]).optional() }));
    const rows = await db.documentTemplate.findMany({
      where: { ...(f.docType ? { docType: f.docType } : {}), ...(f.status ? { status: f.status } : {}) },
      orderBy: [{ docType: "asc" }, { isDefault: "desc" }, { code: "asc" }],
    });
    res.json(ok(rows));
  });

  r.post("/templates", MANAGE, async (req, res) => {
    const user = requireUser(req);
    const input = body(req, createSchema);
    const row = await db.$transaction(async (tx) => {
      if (await tx.documentTemplate.findUnique({ where: { code: input.code } })) throw errors.validation([{ path: "code", message: "This template code already exists" }]);
      // The first active template of a document becomes its default.
      const hasDefault = await tx.documentTemplate.count({ where: { docType: input.docType, isDefault: true, status: "ACTIVE" } });
      const t = await tx.documentTemplate.create({ data: { ...input, layout: input.layout as Prisma.InputJsonValue, isDefault: !hasDefault, createdById: user.id, updatedById: user.id } });
      await recordAudit(tx, req.ctx, { module: "system", action: "DOCUMENT_TEMPLATE_CREATED", entityType: "document_template", entityId: t.id, recordRef: t.code, next: { name: t.name, docType: t.docType, isDefault: t.isDefault } });
      return t;
    });
    res.status(201).json(ok(row));
  });

  r.patch("/templates/:id", MANAGE, async (req, res) => {
    const user = requireUser(req);
    const { id } = params(req, idParam);
    const input = body(req, z.object({ name: z.string().trim().min(1, "Enter the template name").max(80).optional(), layout: layoutSchema.optional() }));
    const row = await db.$transaction(async (tx) => {
      const before = await tx.documentTemplate.findUnique({ where: { id } });
      if (!before) throw errors.notFound("Document template");
      const t = await tx.documentTemplate.update({ where: { id }, data: { ...(input.name ? { name: input.name } : {}), ...(input.layout ? { layout: input.layout as Prisma.InputJsonValue } : {}), updatedById: user.id } });
      await recordAudit(tx, req.ctx, {
        module: "system", action: "DOCUMENT_TEMPLATE_UPDATED", entityType: "document_template", entityId: id, recordRef: t.code,
        previous: { name: before.name }, next: { name: t.name, layoutChanged: !!input.layout },
      });
      return t;
    });
    res.json(ok(row));
  });

  r.post("/templates/:id/default", MANAGE, async (req, res) => {
    const user = requireUser(req);
    const { id } = params(req, idParam);
    const row = await db.$transaction(async (tx) => {
      const t = await tx.documentTemplate.findUnique({ where: { id } });
      if (!t) throw errors.notFound("Document template");
      if (t.status !== "ACTIVE") throw errors.rule("TEMPLATE_INACTIVE", "Activate the template before making it the default.");
      if (t.isDefault) return t;
      const previous = await tx.documentTemplate.findFirst({ where: { docType: t.docType, isDefault: true } });
      await tx.documentTemplate.updateMany({ where: { docType: t.docType, isDefault: true }, data: { isDefault: false, updatedById: user.id } });
      const next = await tx.documentTemplate.update({ where: { id }, data: { isDefault: true, updatedById: user.id } });
      await recordAudit(tx, req.ctx, { module: "system", action: "DOCUMENT_TEMPLATE_DEFAULT_SET", entityType: "document_template", entityId: id, recordRef: t.code, previous: { default: previous?.code ?? null }, next: { default: t.code } });
      return next;
    });
    res.json(ok(row));
  });

  r.put("/templates/:id/status", MANAGE, async (req, res) => {
    const user = requireUser(req);
    const { id } = params(req, idParam);
    const { status } = body(req, statusSchema);
    const row = await db.$transaction(async (tx) => {
      const before = await tx.documentTemplate.findUnique({ where: { id } });
      if (!before) throw errors.notFound("Document template");
      if (before.status === status) return before;
      if (status === "INACTIVE" && before.isDefault) throw errors.rule("DEFAULT_TEMPLATE", "Make another template the default before deactivating this one.");
      const t = await tx.documentTemplate.update({ where: { id }, data: { status, updatedById: user.id } });
      await recordAudit(tx, req.ctx, { module: "system", action: status === "ACTIVE" ? "DOCUMENT_TEMPLATE_ACTIVATED" : "DOCUMENT_TEMPLATE_DEACTIVATED", entityType: "document_template", entityId: id, recordRef: t.code, previous: { status: before.status }, next: { status } });
      return t;
    });
    res.json(ok(row));
  });

  r.get("/settings", requireAuth, async (_req, res) => {
    res.json(ok(await db.documentSetting.findUnique({ where: { id: "company" } })));
  });

  r.put("/settings", MANAGE, async (req, res) => {
    const user = requireUser(req);
    const input = body(req, settingsSchema);
    const row = await db.$transaction(async (tx) => {
      const before = await tx.documentSetting.findUnique({ where: { id: "company" } });
      const data = { ...input, logo: input.logo === undefined ? (before?.logo ?? null) : input.logo, updatedById: user.id };
      const s = await tx.documentSetting.upsert({ where: { id: "company" }, create: { id: "company", ...data }, update: data });
      const { logo: _a, updatedAt: _b, updatedById: _c, ...prev } = before ?? ({} as Record<string, unknown>);
      const { logo: _d, updatedAt: _e, updatedById: _f, id: _g, ...next } = s;
      await recordAudit(tx, req.ctx, {
        module: "system", action: "DOCUMENT_LETTERHEAD_UPDATED", entityType: "document_setting", entityId: "company", recordRef: s.companyName,
        previous: prev, next: { ...next, logoChanged: (before?.logo ?? null) !== s.logo },
      });
      return s;
    });
    res.json(ok(row));
  });

  return r;
}
