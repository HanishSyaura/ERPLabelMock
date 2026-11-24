import type { Prisma, QcDisposition, QcStatus } from "../../generated/prisma/client";
import { errors } from "../../lib/errors";
import { nextNumber } from "../../lib/numbering";
import type { DbOrTx, Tx } from "../../lib/prisma";
import { D, q, ZERO } from "../../lib/qty";
import { recordAudit } from "../audit/audit.service";
import type { Actor } from "../planning/orders.service";
import type { TemplateItem } from "./masters.routes";

/**
 * IQC / OQC inspections.
 *
 * Check In  = the lot (IQC: a part lot received; OQC: finished output of a Job
 *             Order) goes on QC hold. The template's checks are copied.
 * Check Out = results recorded. Every required check answered; a measured
 *             check passes when it is within min / max. Result is FAIL when
 *             a check fails, a CRITICAL defect is found or reject qty > 0;
 *             PASS releases the lot, FAIL waits for a disposition.
 * Disposition (supervisor): IQC use as is / reject / return to supplier;
 *             OQC use as is / reject / rework (then one reinspection).
 * OQC quantity: all first inspections of a Job Order together can't exceed
 *             the good output of its last process.
 */

export interface CheckResult extends TemplateItem {
  pass: boolean | null;
  value: number | null;
  note: string | null;
}

const audit = (tx: Tx, a: Actor, action: string, id: string, ref: string, extra: { previous?: unknown; next?: unknown; remarks?: string | null } = {}) =>
  recordAudit(tx, a.ctx, { module: "qc", action, entityType: "qc_inspection", entityId: id, recordRef: ref, ...extra } as never);

const toChecks = (items: unknown): CheckResult[] => ((items as TemplateItem[]) ?? []).map((it) => ({ ...it, pass: null, value: null, note: null }));

async function lockInspection(tx: Tx, id: string) {
  await tx.$queryRaw`SELECT id FROM qc_inspections WHERE id = ${id} FOR UPDATE`;
  const insp = await tx.qcInspection.findUnique({ where: { id } });
  if (!insp) throw errors.notFound("Inspection");
  return insp;
}

async function templateFor(tx: Tx, type: "IQC" | "OQC", templateId: string | null | undefined, partCategoryId: string | null) {
  if (templateId) {
    const t = await tx.inspectionTemplate.findUnique({ where: { id: templateId } });
    if (!t || t.status !== "ACTIVE" || t.type !== type) throw errors.validation([{ path: "templateId", message: `Choose an active ${type} template` }]);
    return t;
  }
  // Default: IQC by part category, OQC the first active OQC template.
  return tx.inspectionTemplate.findFirst({
    where: { type, status: "ACTIVE", ...(type === "IQC" ? { partCategoryId: partCategoryId ?? "__none__" } : {}) },
    orderBy: { code: "asc" },
  });
}

/** Good output of the Job Order's last process and what first inspections already took. */
export async function oqcAvailability(db: DbOrTx, workOrderId: string) {
  const wo = await db.workOrder.findUnique({ where: { id: workOrderId }, include: { processes: { orderBy: { seq: "desc" }, take: 1 } } });
  if (!wo) throw errors.notFound("Job Order");
  const finalGood = D(wo.processes[0]?.goodQty ?? 0);
  const agg = await db.qcInspection.aggregate({ where: { type: "OQC", workOrderId, reinspectionOfId: null }, _sum: { qty: true } });
  const offered = D(agg._sum.qty);
  return { wo, finalGood, offered, available: finalGood.minus(offered).greaterThan(0) ? finalGood.minus(offered) : ZERO };
}

export interface IqcCheckIn {
  materialId: string;
  lotRef: string;
  supplierName?: string | null;
  deliveryRef?: string | null;
  qty: string | number;
  uom?: string | null;
  sampleSize?: string | number | null;
  templateId?: string | null;
  remarks?: string | null;
}

export async function checkInIqc(tx: Tx, a: Actor, input: IqcCheckIn, now: Date) {
  const part = await tx.material.findUnique({ where: { id: input.materialId } });
  if (!part || part.status !== "ACTIVE") throw errors.validation([{ path: "materialId", message: "Choose an active part" }]);
  if (input.sampleSize != null && D(input.sampleSize).greaterThan(D(input.qty))) throw errors.validation([{ path: "sampleSize", message: "The sample can't be larger than the lot" }]);
  const dup = await tx.qcInspection.findFirst({ where: { type: "IQC", materialId: part.id, lotRef: input.lotRef, status: "IN_INSPECTION" } });
  if (dup) throw errors.validation([{ path: "lotRef", message: `Lot ${input.lotRef} of ${part.code} is already in inspection (${dup.inspNo})` }]);
  const template = await templateFor(tx, "IQC", input.templateId, part.categoryId);
  const inspNo = await nextNumber(tx, "IQC", now);
  const insp = await tx.qcInspection.create({
    data: {
      inspNo,
      type: "IQC",
      templateId: template?.id ?? null,
      checks: toChecks(template?.items) as unknown as Prisma.InputJsonValue,
      materialId: part.id,
      lotRef: input.lotRef,
      supplierName: input.supplierName ?? part.supplierName,
      deliveryRef: input.deliveryRef ?? null,
      qty: D(input.qty),
      uom: input.uom || part.uom,
      sampleSize: input.sampleSize != null ? D(input.sampleSize) : null,
      remarks: input.remarks ?? null,
      checkedInAt: now,
      checkedInById: a.user.id,
    },
  });
  await audit(tx, a, "IQC_CHECKED_IN", insp.id, inspNo, { next: { part: part.code, lotRef: input.lotRef, qty: q(input.qty), uom: insp.uom, template: template?.code ?? null } });
  return insp;
}

export interface OqcCheckIn {
  workOrderId: string;
  qty: string | number;
  sampleSize?: string | number | null;
  templateId?: string | null;
  remarks?: string | null;
}

export async function checkInOqc(tx: Tx, a: Actor, input: OqcCheckIn, now: Date) {
  await tx.$queryRaw`SELECT id FROM work_orders WHERE id = ${input.workOrderId} FOR UPDATE`;
  const { wo, available } = await oqcAvailability(tx, input.workOrderId);
  if (wo.status === "CANCELLED" || wo.status === "PLANNED") throw errors.rule("WO_NOT_PRODUCED", `${wo.woNo} has no production to inspect.`);
  if (D(input.qty).greaterThan(available)) {
    throw errors.validation([{ path: "qty", message: available.isZero() ? `${wo.woNo} has no finished output waiting for OQC.` : `Only ${q(available)} ${wo.uom} of ${wo.woNo} is finished and not yet offered to OQC.` }]);
  }
  if (input.sampleSize != null && D(input.sampleSize).greaterThan(D(input.qty))) throw errors.validation([{ path: "sampleSize", message: "The sample can't be larger than the lot" }]);
  const template = await templateFor(tx, "OQC", input.templateId, null);
  const inspNo = await nextNumber(tx, "OQC", now);
  const insp = await tx.qcInspection.create({
    data: {
      inspNo,
      type: "OQC",
      templateId: template?.id ?? null,
      checks: toChecks(template?.items) as unknown as Prisma.InputJsonValue,
      workOrderId: wo.id,
      qty: D(input.qty),
      uom: wo.uom,
      sampleSize: input.sampleSize != null ? D(input.sampleSize) : null,
      remarks: input.remarks ?? null,
      checkedInAt: now,
      checkedInById: a.user.id,
    },
  });
  await audit(tx, a, "OQC_CHECKED_IN", insp.id, inspNo, { next: { woNo: wo.woNo, qty: q(input.qty), uom: wo.uom, template: template?.code ?? null } });
  return insp;
}

export interface CheckOutInput {
  results: { index: number; pass?: boolean | null; value?: number | null; note?: string | null }[];
  rejectQty?: string | number | null;
  sampleSize?: string | number | null;
  defects: { defectCodeId: string; qty: string | number; remark?: string | null }[];
  remarks?: string | null;
}

export async function checkOut(tx: Tx, a: Actor, id: string, input: CheckOutInput, now: Date) {
  const insp = await lockInspection(tx, id);
  if (insp.status !== "IN_INSPECTION") throw errors.rule("NOT_IN_INSPECTION", `${insp.inspNo} is already checked out.`);
  const checks = insp.checks as unknown as CheckResult[];
  const issues: { path: string; message: string }[] = [];
  const byIndex = new Map(input.results.map((r) => [r.index, r]));
  const recorded = checks.map((c, i) => {
    const r = byIndex.get(i);
    let pass: boolean | null = null;
    let value: number | null = null;
    if (c.kind === "MEASURE") {
      value = r?.value ?? null;
      if (value != null) pass = (c.min == null || value >= c.min) && (c.max == null || value <= c.max);
    } else pass = r?.pass ?? null;
    if (c.required && pass === null) issues.push({ path: `results.${i}`, message: `Record "${c.label}"` });
    return { ...c, pass, value, note: r?.note ?? null };
  });
  const sample = input.sampleSize != null ? D(input.sampleSize) : insp.sampleSize;
  if (sample && sample.greaterThan(insp.qty)) issues.push({ path: "sampleSize", message: "The sample can't be larger than the lot" });
  const reject = input.rejectQty != null ? D(input.rejectQty) : ZERO;
  if (reject.greaterThan(insp.qty)) issues.push({ path: "rejectQty", message: `Reject can't exceed the ${q(insp.qty)} ${insp.uom} inspected` });
  const codes = input.defects.length ? await tx.defectCode.findMany({ where: { id: { in: input.defects.map((d) => d.defectCodeId) } } }) : [];
  const codeOf = new Map(codes.map((c) => [c.id, c]));
  input.defects.forEach((d, i) => {
    const c = codeOf.get(d.defectCodeId);
    if (!c || c.status !== "ACTIVE" || (insp.type === "IQC" ? !c.appliesIqc : !c.appliesOqc)) issues.push({ path: `defects.${i}.defectCodeId`, message: `Choose an active ${insp.type} defect` });
  });
  if (issues.length) throw errors.validation(issues);

  const failed = recorded.some((c) => c.pass === false) || reject.greaterThan(0) || input.defects.some((d) => codeOf.get(d.defectCodeId)?.severity === "CRITICAL");
  const status: QcStatus = failed ? "PENDING_DISPOSITION" : "PASSED";
  await tx.qcInspection.update({
    where: { id },
    data: {
      checks: recorded as unknown as Prisma.InputJsonValue,
      sampleSize: sample,
      rejectQty: reject,
      goodQty: insp.qty.minus(reject),
      result: failed ? "FAIL" : "PASS",
      status,
      remarks: input.remarks ?? insp.remarks,
      checkedOutAt: now,
      checkedOutById: a.user.id,
    },
  });
  if (input.defects.length) {
    await tx.qcDefect.createMany({ data: input.defects.map((d) => ({ inspectionId: id, defectCodeId: d.defectCodeId, qty: D(d.qty), remark: d.remark ?? null })) });
  }
  await audit(tx, a, `${insp.type}_CHECKED_OUT`, id, insp.inspNo, {
    next: { result: failed ? "FAIL" : "PASS", good: q(insp.qty.minus(reject)), reject: q(reject), defects: input.defects.length, failedChecks: recorded.filter((c) => c.pass === false).length },
  });
  return { status, result: failed ? "FAIL" : "PASS" };
}

const DISPOSITIONS: Record<"IQC" | "OQC", QcDisposition[]> = { IQC: ["USE_AS_IS", "REJECT", "RETURN_TO_SUPPLIER"], OQC: ["USE_AS_IS", "REJECT", "REWORK"] };
const DISPOSITION_STATUS: Record<QcDisposition, QcStatus> = { USE_AS_IS: "ACCEPTED", REJECT: "REJECTED", REWORK: "REWORK", RETURN_TO_SUPPLIER: "RETURNED" };

export async function dispose(tx: Tx, a: Actor, id: string, disposition: QcDisposition, note: string, now: Date) {
  const insp = await lockInspection(tx, id);
  if (insp.status !== "PENDING_DISPOSITION") throw errors.rule("NO_DISPOSITION_NEEDED", `${insp.inspNo} isn't waiting for a disposition.`);
  if (!DISPOSITIONS[insp.type].includes(disposition)) throw errors.validation([{ path: "disposition", message: `Not a ${insp.type} disposition` }]);
  const status = DISPOSITION_STATUS[disposition];
  await tx.qcInspection.update({ where: { id }, data: { disposition, dispositionNote: note, dispositionAt: now, dispositionById: a.user.id, status } });
  await audit(tx, a, `${insp.type}_DISPOSITION`, id, insp.inspNo, { previous: { status: insp.status }, next: { status, disposition }, remarks: note });
  return { status };
}

/** OQC after rework: one new inspection of the same lot, with fresh checks. */
export async function reinspect(tx: Tx, a: Actor, id: string, input: { qty?: string | number | null; remarks?: string | null }, now: Date) {
  const insp = await lockInspection(tx, id);
  if (insp.type !== "OQC" || insp.status !== "REWORK") throw errors.rule("NOT_REWORK", "Only OQC lots sent to rework can be reinspected.");
  if (await tx.qcInspection.findUnique({ where: { reinspectionOfId: id } })) throw errors.rule("ALREADY_REINSPECTED", `${insp.inspNo} already has a reinspection.`);
  const qty = input.qty != null ? D(input.qty) : insp.qty;
  if (qty.greaterThan(insp.qty)) throw errors.validation([{ path: "qty", message: `At most the ${q(insp.qty)} ${insp.uom} sent to rework` }]);
  const template = insp.templateId ? await tx.inspectionTemplate.findUnique({ where: { id: insp.templateId } }) : null;
  const inspNo = await nextNumber(tx, "OQC", now);
  const next = await tx.qcInspection.create({
    data: {
      inspNo,
      type: "OQC",
      templateId: insp.templateId,
      checks: toChecks(template?.items ?? (insp.checks as unknown[])) as unknown as Prisma.InputJsonValue,
      workOrderId: insp.workOrderId,
      reinspectionOfId: id,
      qty,
      uom: insp.uom,
      sampleSize: insp.sampleSize,
      remarks: input.remarks ?? null,
      checkedInAt: now,
      checkedInById: a.user.id,
    },
  });
  await audit(tx, a, "OQC_REINSPECTION", next.id, inspNo, { next: { of: insp.inspNo, qty: q(qty) } });
  return next;
}

/** Quantity an OQC lot releases for shipping labels. */
export const releasedQty = (i: { status: QcStatus; qty: Prisma.Decimal; goodQty: Prisma.Decimal | null }) =>
  i.status === "PASSED" ? D(i.goodQty ?? i.qty) : i.status === "ACCEPTED" ? D(i.qty) : ZERO;
