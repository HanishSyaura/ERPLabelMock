import { randomUUID } from "node:crypto";
import sharp from "sharp";
import { beforeEach, describe, expect, it } from "vitest";
import { setupDb } from "./db-helpers";

/**
 * Workflow gaps closed in the MES audit (2026-11-24):
 * - Cancelling a Job Order / order cancels its requisitions that never moved
 *   material (they could never be issued again); an MRS with material out stays
 *   open so the unused material can be returned, and the dashboard flags it.
 * - Cancelling an order cancels and audits each Job Order individually.
 * - An order can't be completed while its finished output is still in OQC
 *   (being inspected or on hold); rework not yet reinspected needs an override.
 */
const t = setupDb();
type Api = Awaited<ReturnType<typeof t.login>>;
const txn = () => randomUUID();

interface World {
  admin: Api;
  pjoId: string;
  bomId: string;
  print: string;
  slit: string;
  fx1: string;
  sl1: string;
  sons: { face: string; ink: string };
}
let w: World;

async function setup(): Promise<World> {
  await t.createAdmin();
  const admin = await t.login("admin");
  const print = (await admin.post("/planning/processes", { code: "PRINT", name: "Printing", sequence: 10 }).expect(201)).body.data.id;
  const slit = (await admin.post("/planning/processes", { code: "SLIT", name: "Slitting", sequence: 20 }).expect(201)).body.data.id;
  const flexo = (await admin.post("/planning/machine-categories", { code: "FLEXO", name: "Flexo press", processIds: [print] }).expect(201)).body.data.id;
  const slitter = (await admin.post("/planning/machine-categories", { code: "SLITTER", name: "Slitter", processIds: [slit] }).expect(201)).body.data.id;
  const fx1 = (await admin.post("/planning/machines", { code: "FX-01", name: "Flexo 1", categoryId: flexo }).expect(201)).body.data.id;
  const sl1 = (await admin.post("/planning/machines", { code: "SL-01", name: "Slitter 1", categoryId: slitter }).expect(201)).body.data.id;
  const face = (await admin.post("/materials", { code: "PP-WHITE-80", description: "PP white 80mic", uom: "M2" }).expect(201)).body.data.id;
  const ink = (await admin.post("/materials", { code: "INK-CYAN", description: "UV ink cyan", uom: "KG" }).expect(201)).body.data.id;
  const png = await sharp({ create: { width: 10, height: 10, channels: 3, background: "#0a0" } }).png().toBuffer();
  const file = (await admin.upload("label.png", png).expect(201)).body.data.file.id;
  const bomId = (await admin.post("/boms", { fileId: file, labelDescription: "Mango juice front" }).expect(201)).body.data.id;
  await admin.post(`/boms/${bomId}/son-codes`, { lines: [{ materialId: face, quantity: 12 }, { materialId: ink, quantity: 0.5 }] }).expect(201);
  const comps = (await admin.get(`/boms/${bomId}`).expect(200)).body.data.components;
  const pjo = (await admin.post("/planning/production-job-orders", { bomId, orderQty: 2000, uom: "PCS" }).expect(201)).body.data;
  await admin.post(`/planning/production-job-orders/${pjo.id}/release`).expect(200);
  return { admin, pjoId: pjo.id, bomId, print, slit, fx1, sl1, sons: { face: comps[0].sonCodeId, ink: comps[1].sonCodeId } };
}

const jobOrder = async (qty = 1000) => {
  const wo = (await w.admin.post("/planning/work-orders", { pjoId: w.pjoId, quantity: qty, processIds: [w.print, w.slit] }).expect(201)).body.data;
  await w.admin.post(`/planning/work-orders/${wo.id}/release`).expect(200);
  return wo as { id: string; woNo: string };
};
const mrs = async (woId: string) => {
  const r = (await w.admin.post("/material/requisitions", { workOrderId: woId, lines: [{ sonCodeId: w.sons.face, requestedQty: 100 }, { sonCodeId: w.sons.ink, requestedQty: 5 }] }).expect(201)).body.data;
  const d = (await w.admin.get(`/material/requisitions/${r.id}`).expect(200)).body.data;
  return { id: r.id as string, mrsNo: r.mrsNo as string, face: d.lines[0].id as string };
};
const mrsStatus = async (id: string) => (await t.db.materialRequisition.findUniqueOrThrow({ where: { id } })).status;

beforeEach(async () => {
  w = await setup();
});

describe("cancelling Job Orders and orders", () => {
  it("cancels an untouched MRS with its Job Order and keeps one with material out open for returns", async () => {
    const a = await jobOrder();
    const b = await jobOrder();
    const untouched = await mrs(a.id);
    const issued = await mrs(b.id);
    await w.admin.post(`/material/lines/${issued.face}/issue`, { qty: 60, lotRef: "LOT-A1", clientTxnId: txn() }).expect(201);

    const ra = (await w.admin.post(`/planning/work-orders/${a.id}/cancel`, { reason: "Customer reduced the order" }).expect(200)).body.data;
    expect(ra.material).toEqual({ cancelled: [untouched.mrsNo], keptOpen: [] });
    expect(await mrsStatus(untouched.id)).toBe("CANCELLED");
    const audit = await t.db.auditLog.findFirstOrThrow({ where: { action: "MRS_CANCELLED", entityId: untouched.id } });
    expect(audit.remarks).toContain(a.woNo);

    const rb = (await w.admin.post(`/planning/work-orders/${b.id}/cancel`, { reason: "Wrong job" }).expect(200)).body.data;
    expect(rb.material).toEqual({ cancelled: [], keptOpen: [issued.mrsNo] });
    expect(await mrsStatus(issued.id)).toBe("PARTIALLY_ISSUED");
    // Nothing more can be issued to a cancelled job, but the 60 out can come back.
    await w.admin.post(`/material/lines/${issued.face}/issue`, { qty: 10, lotRef: "LOT-A1", clientTxnId: txn() }).expect(422);

    let d = (await w.admin.get("/dashboard").expect(200)).body.data;
    expect(d.kpis.pendingMrs).toBe(0); // no live Job Order is waiting for material
    expect(d.alerts.find((x: { record: string }) => x.record === issued.mrsNo)).toMatchObject({ type: "Material out on a cancelled job", action: "Return the unused material" });
    expect((await w.admin.get("/material/requisitions?status=OPEN,PARTIALLY_ISSUED&activeJob=1").expect(200)).body.meta.total).toBe(0);
    expect((await w.admin.get("/material/requisitions?status=OPEN,PARTIALLY_ISSUED").expect(200)).body.meta.total).toBe(1);

    await w.admin.post(`/material/lines/${issued.face}/return`, { qty: 60, lotRef: "LOT-A1", clientTxnId: txn() }).expect(201);
    d = (await w.admin.get("/dashboard").expect(200)).body.data;
    expect(d.alerts.some((x: { record: string }) => x.record === issued.mrsNo)).toBe(false);
  });

  it("cancels and audits every Job Order of a cancelled order, with their untouched MRS", async () => {
    const a = await jobOrder(500);
    const b = await jobOrder(500);
    const m = await mrs(a.id);
    const r = (await w.admin.post(`/planning/production-job-orders/${w.pjoId}/cancel`, { reason: "Order withdrawn" }).expect(200)).body.data;
    expect(r.material.cancelled).toEqual([m.mrsNo]);
    const cancelled = await t.db.auditLog.findMany({ where: { action: "JOB_ORDER_CANCELLED" }, orderBy: { recordRef: "asc" } });
    expect(cancelled.map((x) => x.recordRef)).toEqual([a.woNo, b.woNo].sort());
    expect(cancelled.every((x) => x.remarks?.includes("Order withdrawn"))).toBe(true);
    expect((await t.db.workOrder.findMany({ where: { pjoId: w.pjoId } })).every((x) => x.status === "CANCELLED")).toBe(true);
  });
});

describe("completing an order", () => {
  it("is blocked while finished output is still in OQC and allowed once the lot is released", async () => {
    const wo = await jobOrder(2000);
    for (const machineId of [w.fx1, w.sl1]) {
      const s = (await w.admin.post("/shopfloor/check-in", { machineId, workOrderId: wo.id, clientTxnId: txn() }).expect(201)).body.data.sessionId;
      await w.admin.post(`/shopfloor/sessions/${s}/check-out`, { type: "COMPLETED", totalGood: 2000, totalReject: 0, clientTxnId: txn() }).expect(200);
    }
    await w.admin.post(`/planning/work-orders/${wo.id}/complete`, {}).expect(200);
    const lot = (await w.admin.post("/qc/oqc", { workOrderId: wo.id, qty: 2000 }).expect(201)).body.data;

    const check = (await w.admin.get(`/planning/completion/${w.pjoId}`).expect(200)).body.data;
    expect(check.blockers).toEqual([`OQC ${lot.inspNo} is still being inspected. Finish it first.`]);
    await w.admin.post(`/planning/completion/${w.pjoId}/complete`, { override: true, note: "try" }).expect(422);

    await w.admin.post(`/qc/inspections/${lot.id}/check-out`, { results: [], defects: [] }).expect(200);
    const ok = (await w.admin.get(`/planning/completion/${w.pjoId}`).expect(200)).body.data;
    expect(ok.blockers).toEqual([]);
    await w.admin.post(`/planning/completion/${w.pjoId}/complete`, { note: "Done" }).expect(200);
    expect((await t.db.productionJobOrder.findUniqueOrThrow({ where: { id: w.pjoId } })).status).toBe("CLOSED");
  });
});
