import { randomUUID } from "node:crypto";
import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { setupDb } from "./db-helpers";

/**
 * Manufacturing dashboard: figures reconcile with the source records, the
 * process filter narrows machines / WIP, KPI drill-down filters on the Job
 * Order list return the same records, and sections follow permissions.
 * Clock: 2026-11-10 (createClock); the order was required on 2026-11-05.
 */
const t = setupDb();
const txn = () => randomUUID();

describe("dashboard", () => {
  it("counts a part-run, overdue Job Order from transactions and links to matching lists", async () => {
    await t.createAdmin();
    const admin = await t.login("admin");
    const opUser = await t.createUser("op1", ["PRODUCTION_OPERATOR"]);
    await t.createUser("insp", ["QC_INSPECTOR"]);
    const print = (await admin.post("/planning/processes", { code: "PRINT", name: "Printing", sequence: 10 }).expect(201)).body.data.id;
    const slit = (await admin.post("/planning/processes", { code: "SLIT", name: "Slitting", sequence: 20 }).expect(201)).body.data.id;
    const flexo = (await admin.post("/planning/machine-categories", { code: "FLEXO", name: "Flexo press", processIds: [print] }).expect(201)).body.data.id;
    const slitter = (await admin.post("/planning/machine-categories", { code: "SLITTER", name: "Slitter rewinder", processIds: [slit] }).expect(201)).body.data.id;
    const fx1 = (await admin.post("/planning/machines", { code: "FX-01", name: "Flexo 1", categoryId: flexo }).expect(201)).body.data.id;
    const sl1 = (await admin.post("/planning/machines", { code: "SL-01", name: "Slitter 1", categoryId: slitter }).expect(201)).body.data.id;
    for (const cat of [flexo, slitter]) await admin.put(`/planning/machine-categories/${cat}/operators`, { userIds: [opUser.id] }).expect(200);

    const png = await sharp({ create: { width: 10, height: 10, channels: 3, background: "#f00" } }).png().toBuffer();
    const file = (await admin.upload("label.png", png).expect(201)).body.data.file.id;
    const bomId = (await admin.post("/boms", { fileId: file, labelDescription: "Mango juice 1L front" }).expect(201)).body.data.id;
    const pjo = (await admin.post("/planning/production-job-orders", { bomId, orderQty: 1000, uom: "PCS", customerRef: "PO-88", requiredDate: "2026-11-05" }).expect(201)).body.data;
    await admin.post(`/planning/production-job-orders/${pjo.id}/release`).expect(200);
    const wo = (await admin.post("/planning/work-orders", { pjoId: pjo.id, quantity: 1000, processIds: [print, slit] }).expect(201)).body.data;
    await admin.post(`/planning/work-orders/${wo.id}/release`).expect(200);

    const op = await t.login("op1");
    // Print a part-run of 300 good, 10 reject, then end the session (paused, not completed).
    const s1 = (await op.post("/shopfloor/check-in", { machineId: fx1, workOrderId: wo.id, clientTxnId: txn() }).expect(201)).body.data.sessionId;
    await op.post(`/shopfloor/sessions/${s1}/check-out`, { type: "PARTIAL", totalGood: 300, totalReject: 10, clientTxnId: txn() }).expect(200);

    let d = (await admin.get("/dashboard").expect(200)).body.data;
    expect(d.kpis).toMatchObject({ activeOrders: 1, releasedWorkOrders: 0, inProgress: 1, completed: 0, overdue: 1 });
    // WIP: printing paused (700 still to print). Slitting may not start until printing is
    // completed (Check In rule), so the 300 printed are not "waiting" yet.
    expect(d.wip).toMatchObject({ running: 0, waiting: 0, paused: 1 });
    expect(d.wip.rows.find((r: { kind: string }) => r.kind === "paused")).toMatchObject({ process: "1. Printing", qty: "700", machine: "FX-01" });
    // Finished output = last step (slitting) good: nothing finished yet.
    expect(d.jobs.progress).toEqual([{ uom: "PCS", planned: 1000, output: 0, remaining: 1000, workOrders: 1 }]);
    expect(d.jobs.schedule[0]).toMatchObject({ woNo: wo.woNo, due: "overdue", requiredDate: "2026-11-05", customerRef: "PO-88", remaining: "1000" });
    expect(d.floor.counts).toMatchObject({ IDLE: 1, AVAILABLE: 1 });
    expect(d.floor.output.at(-1)).toMatchObject({ good: 300, reject: 10 });
    expect(d.alerts.map((a: { type: string; record: string }) => `${a.type}:${a.record}`)).toContain(`Overdue Job Order:${wo.woNo}`);
    expect(d.activity.some((a: { text: string }) => a.text.startsWith("Check Out (Partial) on FX-01"))).toBe(true);

    // A supervisor approves partial transfer: the 300 printed now wait for slitting.
    const view = (await admin.get(`/planning/work-orders/${wo.id}`).expect(200)).body.data;
    await admin.put(`/planning/work-order-processes/${view.processes[1].id}/authorization`, { allowPartialTransfer: true, note: "Customer needs a first delivery" }).expect(200);
    d = (await admin.get("/dashboard").expect(200)).body.data;
    expect(d.wip).toMatchObject({ running: 0, waiting: 1, paused: 1 });
    expect(d.wip.rows.find((r: { kind: string }) => r.kind === "waiting")).toMatchObject({ woNo: wo.woNo, process: "2. Slitting", previous: "Printing", qty: "300" });

    // Slitting starts: one running step, the slitter shows the session.
    await op.post("/shopfloor/check-in", { machineId: sl1, workOrderId: wo.id, clientTxnId: txn() }).expect(201);
    d = (await admin.get("/dashboard").expect(200)).body.data;
    expect(d.wip).toMatchObject({ running: 1, waiting: 0, paused: 1 });
    const slRow = d.floor.machines.find((m: { code: string }) => m.code === "SL-01");
    expect(slRow).toMatchObject({ status: "RUNNING", session: { woNo: wo.woNo, process: "2. Slitting", operator: expect.any(String) } });

    // Process filter: only slitting WIP and slitting-capable machines.
    const f = (await admin.get(`/dashboard?processId=${slit}&period=7d`).expect(200)).body.data;
    expect(f.period).toMatchObject({ key: "7d", days: 7 });
    expect(f.wip.rows.map((r: { process: string }) => r.process)).toEqual(["2. Slitting"]);
    expect(f.floor.machines.map((m: { code: string }) => m.code)).toEqual(["SL-01"]);

    // The operator sees their own running session.
    const mine = (await op.get("/dashboard").expect(200)).body.data.mine;
    expect(mine).toEqual([expect.objectContaining({ woNo: wo.woNo, machine: "SL-01", process: "Slitting" })]);

    // KPI drill-down filters return the same records the dashboard counted.
    const overdue = (await admin.get("/planning/work-orders?due=overdue").expect(200)).body;
    expect(overdue.meta.total).toBe(1);
    expect(overdue.data[0]).toMatchObject({ woNo: wo.woNo, customerRef: "PO-88" });
    expect((await admin.get("/planning/work-orders?status=IN_PROGRESS,PARTIALLY_COMPLETED").expect(200)).body.meta.total).toBe(1);
    expect((await admin.get("/planning/work-orders?due=today").expect(200)).body.meta.total).toBe(0);
    await admin.get("/planning/work-orders?status=NOT_A_STATUS").expect(422);
    await admin.get("/planning/production-job-orders?status=nope").expect(422);
    await admin.get("/material/requisitions?status=OPEN,BAD").expect(422);
    await admin.get("/material/requisitions?status=OPEN,PARTIALLY_ISSUED").expect(200);
    await admin.get("/dashboard?period=1y").expect(422);

    // A QC inspector gets no planning / shopfloor sections.
    const qc = (await (await t.login("insp")).get("/dashboard").expect(200)).body.data;
    expect(qc.floor).toBeUndefined();
    expect(qc.material).toBeUndefined();
    expect(qc.quality.lots.map((l: { type: string }) => l.type)).toEqual(["IQC", "OQC"]);
  });
});
