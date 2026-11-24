import { randomUUID } from "node:crypto";
import sharp from "sharp";
import { beforeEach, describe, expect, it } from "vitest";
import { addDays, dayKey } from "../src/lib/day";
import { setupDb } from "./db-helpers";

/**
 * Daily Job Information, PJO stages, MRS (issue / additional / return / reject /
 * scrap) and the Production Order Complete Utility.
 */
const t = setupDb();
type Api = Awaited<ReturnType<typeof t.login>>;
const txn = () => randomUUID();

interface World {
  admin: Api;
  planner: Api;
  sup: Api;
  material: Api;
  operator: Api;
  pjoId: string;
  wo: { id: string; woNo: string };
  printStep: string;
  slitStep: string;
  machines: { fx1: string; sl1: string };
  sons: { face: string; ink: string };
}
let w: World;
const today = () => dayKey(t.clock.now());

async function setup(): Promise<World> {
  await t.createAdmin();
  const admin = await t.login("admin");
  await t.createUser("planner", ["PRODUCTION_PLANNER"]);
  await t.createUser("sup", ["PRODUCTION_SUPERVISOR"]);
  await t.createUser("mat", ["MATERIAL_CONTROLLER"]);
  await t.createUser("op", ["PRODUCTION_OPERATOR"]);

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

  const pjo = (await admin.post("/planning/production-job-orders", { bomId, orderQty: 1000, uom: "PCS" }).expect(201)).body.data;
  await admin.post(`/planning/production-job-orders/${pjo.id}/release`).expect(200);
  const wo = (await admin.post("/planning/work-orders", { pjoId: pjo.id, quantity: 1000, processIds: [print, slit] }).expect(201)).body.data;
  await admin.post(`/planning/work-orders/${wo.id}/release`).expect(200);
  const view = (await admin.get(`/planning/work-orders/${wo.id}`).expect(200)).body.data;

  return {
    admin,
    planner: await t.login("planner"),
    sup: await t.login("sup"),
    material: await t.login("mat"),
    operator: await t.login("op"),
    pjoId: pjo.id,
    wo,
    printStep: view.processes[0].id,
    slitStep: view.processes[1].id,
    machines: { fx1, sl1 },
    sons: { face: comps[0].sonCodeId, ink: comps[1].sonCodeId },
  };
}

beforeEach(async () => {
  w = await setup();
});

async function newMrs(face = 100, ink = 5) {
  const res = await w.planner.post("/material/requisitions", { workOrderId: w.wo.id, lines: [{ sonCodeId: w.sons.face, requestedQty: face }, { sonCodeId: w.sons.ink, requestedQty: ink }] }).expect(201);
  const detail = (await w.planner.get(`/material/requisitions/${res.body.data.id}`).expect(200)).body.data;
  return { id: res.body.data.id as string, mrsNo: res.body.data.mrsNo as string, face: detail.lines[0].id as string, ink: detail.lines[1].id as string };
}
const reason = async (category: string, code: string) => (await w.planner.post("/material/reasons", { category, code, description: `${code} reason` }).expect(201)).body.data.id as string;

describe("Daily Job Information and PJO stages", () => {
  it("pulls Job Orders straight from production orders into Planned, In Progress and Completed", async () => {
    let daily = (await w.planner.get(`/planning/daily?date=${today()}`).expect(200)).body.data;
    expect(daily.planned.map((r: { woNo: string }) => r.woNo)).toEqual([w.wo.woNo]);
    expect(daily.planned[0]).toMatchObject({ stage: "PLANNED", steps: { done: 0, total: 2 }, current: { name: "Printing" }, material: "NONE" });
    expect(daily.inProgress).toHaveLength(0);
    let stages = (await w.planner.get("/planning/production-job-orders?stage=planned").expect(200)).body;
    expect(stages.data.map((p: { id: string }) => p.id)).toEqual([w.pjoId]);
    expect(stages.meta.stages).toEqual({ planned: 1, in_progress: 0, completed: 0 });

    // Starting production moves it to In Progress (still there while paused between sessions).
    const s = (await w.admin.post("/shopfloor/check-in", { machineId: w.machines.fx1, workOrderId: w.wo.id, clientTxnId: txn() }).expect(201)).body.data.sessionId;
    daily = (await w.planner.get(`/planning/daily?date=${today()}`).expect(200)).body.data;
    expect(daily.planned).toHaveLength(0);
    expect(daily.inProgress[0]).toMatchObject({ stage: "IN_PROGRESS", running: true, machine: { code: "FX-01" }, current: { name: "Printing" } });
    await w.admin.post(`/shopfloor/sessions/${s}/check-out`, { type: "COMPLETED", totalGood: 1000, totalReject: 4, clientTxnId: txn() }).expect(200);
    daily = (await w.planner.get(`/planning/daily?date=${today()}`).expect(200)).body.data;
    expect(daily.inProgress[0]).toMatchObject({ running: false, steps: { done: 1, total: 2 }, current: { name: "Slitting" }, outputToday: { good: "1000", reject: "4" } });
    stages = (await w.planner.get("/planning/production-job-orders?stage=in_progress").expect(200)).body;
    expect(stages.data).toHaveLength(1);
    expect(stages.data[0].stage).toBe("in_progress");
    expect(stages.meta.stages).toEqual({ planned: 0, in_progress: 1, completed: 0 });

    const s2 = (await w.admin.post("/shopfloor/check-in", { machineId: w.machines.sl1, workOrderId: w.wo.id, clientTxnId: txn() }).expect(201)).body.data.sessionId;
    await w.admin.post(`/shopfloor/sessions/${s2}/check-out`, { type: "COMPLETED", totalGood: 990, totalReject: 0, remarks: "short 10", clientTxnId: txn() }).expect(200);
    await w.admin.post(`/planning/work-orders/${w.wo.id}/complete`, { note: "Short by 10" }).expect(200);
    daily = (await w.planner.get(`/planning/daily?date=${today()}`).expect(200)).body.data;
    expect(daily.inProgress).toHaveLength(0);
    expect(daily.completed[0]).toMatchObject({ stage: "COMPLETED", finishedQty: "990", steps: { done: 2, total: 2 } });
    expect(daily.summary).toMatchObject({ planned: 0, inProgress: 0, completed: 1 });
    // Completed is per day: nothing was completed yesterday.
    const other = (await w.planner.get(`/planning/daily?date=${addDays(today(), -1)}`).expect(200)).body.data;
    expect(other.completed).toHaveLength(0);

    await w.admin.post(`/planning/completion/${w.pjoId}/complete`, { override: true, note: "Customer accepted 990" }).expect(200);
    stages = (await w.planner.get("/planning/production-job-orders?stage=completed").expect(200)).body;
    expect(stages.data.map((p: { id: string; stage: string }) => [p.id, p.stage])).toEqual([[w.pjoId, "completed"]]);
  });
});

describe("Material Requisition Sheet and movements", () => {
  it("creates an MRS only from the frozen BOM and limits normal issue to the request", async () => {
    const bad = await w.planner.post("/material/requisitions", { workOrderId: w.wo.id, lines: [{ sonCodeId: randomUUID(), requestedQty: 1 }] }).expect(422);
    expect(bad.body.issues[0].path).toBe("lines.0.sonCodeId");
    const m = await newMrs();
    const tpl = (await w.planner.get(`/material/work-orders/${w.wo.id}/mrs-template`).expect(200)).body.data;
    expect(tpl.lines[0]).toMatchObject({ materialCode: "PP-WHITE-80", alreadyRequested: "100", uom: "M2" });

    const first = await w.material.post(`/material/lines/${m.face}/issue`, { qty: 60, lotRef: "LOT-A1", clientTxnId: txn() }).expect(201);
    expect(first.body.data.line).toMatchObject({ issued: "60", remainingToIssue: "40", onHand: "60" });
    expect((await t.db.materialRequisition.findUniqueOrThrow({ where: { id: m.id } })).status).toBe("PARTIALLY_ISSUED");
    const over = await w.material.post(`/material/lines/${m.face}/issue`, { qty: 50, clientTxnId: txn() }).expect(422);
    expect(over.body.issues[0].message).toContain("Only 40 M2 remains");
    await w.material.post(`/material/lines/${m.face}/issue`, { qty: 40, clientTxnId: txn() }).expect(201);
    await w.material.post(`/material/lines/${m.ink}/issue`, { qty: 5, clientTxnId: txn() }).expect(201);
    expect((await t.db.materialRequisition.findUniqueOrThrow({ where: { id: m.id } })).status).toBe("ISSUED");
    const full = await w.material.post(`/material/lines/${m.face}/issue`, { qty: 1, clientTxnId: txn() }).expect(422);
    expect(full.body.code).toBe("FULLY_ISSUED");
  });

  it("additional issue needs the request fully issued and a reason; a retried scan is not counted twice", async () => {
    const m = await newMrs();
    const extra = await reason("ADDITIONAL_ISSUE", "SETUP-WASTE");
    const early = await w.material.post(`/material/lines/${m.face}/additional-issue`, { qty: 10, reasonCodeId: extra, clientTxnId: txn() }).expect(422);
    expect(early.body.code).toBe("ISSUE_FIRST");
    await w.material.post(`/material/lines/${m.face}/issue`, { qty: 100, clientTxnId: txn() }).expect(201);
    await w.material.post(`/material/lines/${m.face}/additional-issue`, { qty: 10, clientTxnId: txn() }).expect(422);
    const id = txn();
    const a1 = await w.material.post(`/material/lines/${m.face}/additional-issue`, { qty: 10, reasonCodeId: extra, clientTxnId: id }).expect(201);
    const a2 = await w.material.post(`/material/lines/${m.face}/additional-issue`, { qty: 10, reasonCodeId: extra, clientTxnId: id }).expect(200);
    expect(a2.body.data).toMatchObject({ replayed: true, txnNo: a1.body.data.txnNo });
    const line = await t.db.mrsLine.findUniqueOrThrow({ where: { id: m.face } });
    expect(line.additionalQty.toString()).toBe("10");
    expect(await t.db.materialTransaction.count({ where: { type: "ADDITIONAL_ISSUE" } })).toBe(1);
    // Operators can't issue.
    await w.operator.post(`/material/lines/${m.face}/issue`, { qty: 1, clientTxnId: txn() }).expect(403);
  });

  it("return, reject and scrap never exceed what is out on the line; transactions are append-only", async () => {
    const m = await newMrs();
    const rej = await reason("REJECT", "DAMAGED");
    const scr = await reason("SCRAP", "MISPRINT");
    await w.material.post(`/material/lines/${m.face}/return`, { qty: 1, clientTxnId: txn() }).expect(422);
    await w.material.post(`/material/lines/${m.face}/issue`, { qty: 100, clientTxnId: txn() }).expect(201);
    await w.material.post(`/material/lines/${m.face}/return`, { qty: 30, lotRef: "LOT-A1", clientTxnId: txn() }).expect(201);
    await w.material.post(`/material/lines/${m.face}/reject`, { qty: 20, reasonCodeId: rej, clientTxnId: txn() }).expect(201);
    await w.material.post(`/material/lines/${m.face}/reject`, { qty: 5, reasonCodeId: scr, clientTxnId: txn() }).expect(422);
    const scrap = await w.operator.post(`/material/lines/${m.face}/scrap`, { qty: 15, reasonCodeId: scr, machineId: w.machines.fx1, woProcessId: w.printStep, clientTxnId: txn() }).expect(201);
    expect(scrap.body.data.line).toMatchObject({ issued: "100", returned: "30", rejected: "20", scrapped: "15", onHand: "35" });
    const too = await w.material.post(`/material/lines/${m.face}/return`, { qty: 36, clientTxnId: txn() }).expect(422);
    expect(too.body.issues[0].message).toContain("Only 35 M2 is out");
    const wrongStep = await w.operator.post(`/material/lines/${m.face}/scrap`, { qty: 1, reasonCodeId: scr, woProcessId: randomUUID(), clientTxnId: txn() }).expect(422);
    expect(wrongStep.body.issues[0].path).toBe("woProcessId");

    // "All movements" tab: every type, newest first.
    const everything = (await w.sup.get("/material/transactions").expect(200)).body.data;
    expect(everything.map((t: { type: string }) => t.type)).toEqual(["SCRAP", "REJECT", "RETURN", "ISSUE"]);
    const reg = (await w.sup.get("/material/transactions?type=SCRAP").expect(200)).body.data;
    expect(reg[0]).toMatchObject({ qty: "15", machine: "FX-01", process: "Printing", reason: "MISPRINT – MISPRINT reason", materialCode: "PP-WHITE-80" });
    await expect(t.db.$executeRawUnsafe("UPDATE material_transactions SET qty = 1")).rejects.toThrow(/append-only/);
    await expect(t.db.$executeRawUnsafe("DELETE FROM material_transactions")).rejects.toThrow(/append-only/);
  });

  it("refuses issue to a Job Order on hold and cancels only untouched MRS", async () => {
    const m = await newMrs();
    await w.admin.post(`/planning/work-orders/${w.wo.id}/hold`, { reason: "Artwork query" }).expect(200);
    const held = await w.material.post(`/material/lines/${m.face}/issue`, { qty: 1, clientTxnId: txn() }).expect(422);
    expect(held.body.code).toBe("WO_ON_HOLD");
    await w.admin.post(`/planning/work-orders/${w.wo.id}/unhold`, { reason: "Resolved" }).expect(200);
    await w.material.post(`/material/lines/${m.face}/issue`, { qty: 1, clientTxnId: txn() }).expect(201);
    const c = await w.planner.post(`/material/requisitions/${m.id}/cancel`, { reason: "Duplicate" }).expect(422);
    expect(c.body.code).toBe("MRS_HAS_MOVEMENTS");
    const m2 = await newMrs(1, 1);
    await w.planner.post(`/material/requisitions/${m2.id}/cancel`, {}).expect(422);
    await w.planner.post(`/material/requisitions/${m2.id}/cancel`, { reason: "Raised twice" }).expect(200);
  });
});

describe("Production Order Complete Utility", () => {
  async function runWorkOrder(good: number) {
    for (const machineId of [w.machines.fx1, w.machines.sl1]) {
      const s = (await w.admin.post("/shopfloor/check-in", { machineId, workOrderId: w.wo.id, clientTxnId: txn() }).expect(201)).body.data.sessionId;
      await w.admin.post(`/shopfloor/sessions/${s}/check-out`, { type: "COMPLETED", totalGood: good, totalReject: 0, remarks: "done", clientTxnId: txn() }).expect(200);
    }
  }

  it("blocks while Job Orders are open, then needs an override for warnings and closes the MRS", async () => {
    const m = await newMrs();
    await w.material.post(`/material/lines/${m.face}/issue`, { qty: 100, clientTxnId: txn() }).expect(201);

    const blocked = (await w.sup.get(`/planning/completion/${w.pjoId}`).expect(200)).body.data;
    expect(blocked.blockers[0]).toContain(`${w.wo.woNo} is released`);
    const refused = await w.sup.post(`/planning/completion/${w.pjoId}/complete`, {}).expect(422);
    expect(refused.body.code).toBe("COMPLETION_BLOCKED");

    await runWorkOrder(950);
    await w.admin.post(`/planning/work-orders/${w.wo.id}/complete`, { note: "Short by 50 after slitting" }).expect(200);
    const check = (await w.sup.get(`/planning/completion/${w.pjoId}`).expect(200)).body.data;
    expect(check.blockers).toEqual([]);
    expect(check.warnings).toHaveLength(2); // short output + ink line not issued
    expect(check.materials[0].lines[0]).toMatchObject({ issued: "100", onHand: "100" });

    const noOverride = await w.sup.post(`/planning/completion/${w.pjoId}/complete`, {}).expect(422);
    expect(noOverride.body.code).toBe("COMPLETION_WARNINGS");
    // Planner may complete, but not override.
    await w.planner.post(`/planning/completion/${w.pjoId}/complete`, { override: true, note: "ok" }).expect(403);
    await w.sup.post(`/planning/completion/${w.pjoId}/complete`, { override: true }).expect(422);
    const done = await w.sup.post(`/planning/completion/${w.pjoId}/complete`, { override: true, note: "Customer accepted 950" }).expect(200);
    expect(done.body.data).toEqual({ status: "CLOSED", mrsClosed: 1 });

    expect((await t.db.productionJobOrder.findUniqueOrThrow({ where: { id: w.pjoId } })).closureOverride).toBe(true);
    expect((await t.db.materialRequisition.findUniqueOrThrow({ where: { id: m.id } })).status).toBe("CLOSED");
    const after = await w.material.post(`/material/lines/${m.face}/return`, { qty: 1, clientTxnId: txn() }).expect(422);
    expect(after.body.code).toBe("MRS_CLOSED");
    const list = (await w.sup.get("/planning/completion?view=closed").expect(200)).body.data;
    expect(list[0]).toMatchObject({ pjoNo: check.pjo.pjoNo, closureOverride: true });
    const actions = (await t.db.auditLog.findMany({ where: { module: "planning" }, orderBy: { id: "asc" } })).map((a) => a.action);
    expect(actions).toEqual(expect.arrayContaining(["MRS_CLOSED", "PJO_COMPLETED_WITH_OVERRIDE"]));
  });

  it("completes without override when everything is clean", async () => {
    const m = await newMrs(100, 5);
    await w.material.post(`/material/lines/${m.face}/issue`, { qty: 100, clientTxnId: txn() }).expect(201);
    await w.material.post(`/material/lines/${m.ink}/issue`, { qty: 5, clientTxnId: txn() }).expect(201);
    await runWorkOrder(1000);
    await w.admin.post(`/planning/work-orders/${w.wo.id}/complete`, {}).expect(200);
    await w.planner.post(`/planning/completion/${w.pjoId}/complete`, {}).expect(200);
    expect((await t.db.productionJobOrder.findUniqueOrThrow({ where: { id: w.pjoId } })).status).toBe("CLOSED");
  });
});

describe("Require IQC", () => {
  it("issues a Require-IQC part only from a lot that passed IQC", async () => {
    const m = await newMrs();
    const face = await t.db.mrsLine.findUniqueOrThrow({ where: { id: m.face } });
    await w.admin.patch(`/materials/${face.materialId}`, { requireIqc: true }).expect(200);
    const noLot = await w.material.post(`/material/lines/${m.face}/issue`, { qty: 10, clientTxnId: txn() }).expect(422);
    expect(noLot.body.issues[0].path).toBe("lotRef");
    const held = await w.material.post(`/material/lines/${m.face}/issue`, { qty: 10, lotRef: "R-9", clientTxnId: txn() }).expect(422);
    expect(held.body.code).toBe("LOT_NOT_RELEASED");
    const lot = (await w.admin.post("/qc/iqc", { materialId: face.materialId, lotRef: "R-9", qty: 100 }).expect(201)).body.data.id;
    await w.admin.post(`/qc/inspections/${lot}/check-out`, { results: [] }).expect(200);
    await w.material.post(`/material/lines/${m.face}/issue`, { qty: 10, lotRef: "R-9", clientTxnId: txn() }).expect(201);
  });
});
