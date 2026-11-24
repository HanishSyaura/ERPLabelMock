import { randomUUID } from "node:crypto";
import sharp from "sharp";
import { beforeEach, describe, expect, it } from "vitest";
import { setupDb } from "./db-helpers";

/**
 * Handheld shopfloor workflow - the 15 required scenarios from the brief.
 * Check In = START WORK, Check Out = END WORK, Work Order = Job Order.
 */
const t = setupDb();
type Api = Awaited<ReturnType<typeof t.login>>;

const txn = () => randomUUID();
const HOUR = 3_600_000;

interface World {
  admin: Api;
  op: Api;
  op2: Api;
  sup: Api;
  machines: { fx1: string; fx2: string; sl1: string };
  processes: { print: string; slit: string };
  wo: { id: string; woNo: string };
  printStep: string;
  slitStep: string;
}

let w: World;

async function setup(): Promise<World> {
  await t.createAdmin();
  const admin = await t.login("admin");
  const opUser = await t.createUser("op1", ["PRODUCTION_OPERATOR"]);
  const op2User = await t.createUser("op2", ["PRODUCTION_OPERATOR"]);
  await t.createUser("sup1", ["PRODUCTION_SUPERVISOR"]);

  const print = (await admin.post("/planning/processes", { code: "PRINT", name: "Printing", sequence: 10 }).expect(201)).body.data.id;
  const slit = (await admin.post("/planning/processes", { code: "SLIT", name: "Slitting", sequence: 20 }).expect(201)).body.data.id;
  const flexo = (await admin.post("/planning/machine-categories", { code: "FLEXO", name: "Flexo press", processIds: [print] }).expect(201)).body.data.id;
  const slitter = (await admin.post("/planning/machine-categories", { code: "SLITTER", name: "Slitter rewinder", processIds: [slit] }).expect(201)).body.data.id;
  const fx1 = (await admin.post("/planning/machines", { code: "fx-01", name: "Flexo 1", categoryId: flexo }).expect(201)).body.data.id;
  const fx2 = (await admin.post("/planning/machines", { code: "FX-02", name: "Flexo 2", categoryId: flexo }).expect(201)).body.data.id;
  const sl1 = (await admin.post("/planning/machines", { code: "SL-01", name: "Slitter 1", categoryId: slitter }).expect(201)).body.data.id;
  for (const cat of [flexo, slitter]) await admin.put(`/planning/machine-categories/${cat}/operators`, { userIds: [opUser.id] }).expect(200);
  await admin.put(`/planning/machine-categories/${flexo}/operators`, { userIds: [opUser.id, op2User.id] }).expect(200);

  // Father Code -> Production Job Order -> Job Order (Work Order) with route PRINT -> SLIT
  const png = await sharp({ create: { width: 10, height: 10, channels: 3, background: "#f00" } }).png().toBuffer();
  const up = (await admin.upload("label.png", png).expect(201)).body.data.file.id;
  const bomId = (await admin.post("/boms", { fileId: up, labelDescription: "Test Label" }).expect(201)).body.data.id;
  const pjo = (await admin.post("/planning/production-job-orders", { bomId, orderQty: 5000, uom: "PCS", customerRef: "PO-77" }).expect(201)).body.data;
  await admin.post(`/planning/production-job-orders/${pjo.id}/release`).expect(200);
  const wo = (await admin.post("/planning/work-orders", { pjoId: pjo.id, quantity: 1000, processIds: [print, slit] }).expect(201)).body.data;
  await admin.post(`/planning/work-orders/${wo.id}/release`).expect(200);
  const view = (await admin.get(`/planning/work-orders/${wo.id}`).expect(200)).body.data;

  return {
    admin,
    op: await t.login("op1"),
    op2: await t.login("op2"),
    sup: await t.login("sup1"),
    machines: { fx1, fx2, sl1 },
    processes: { print, slit },
    wo,
    printStep: view.processes[0].id,
    slitStep: view.processes[1].id,
  };
}

const checkIn = (api: Api, machineId: string, workOrderId = w.wo.id, clientTxnId = txn()) => api.post("/shopfloor/check-in", { machineId, workOrderId, clientTxnId });
const checkOut = (api: Api, sessionId: string, body: Record<string, unknown>, clientTxnId = txn()) => api.post(`/shopfloor/sessions/${sessionId}/check-out`, { totalReject: 0, ...body, clientTxnId });
const machine = async (id: string) => t.db.machine.findUniqueOrThrow({ where: { id } });
const step = async (id: string) => t.db.workOrderProcess.findUniqueOrThrow({ where: { id } });
const workOrder = async () => t.db.workOrder.findUniqueOrThrow({ where: { id: w.wo.id } });

beforeEach(async () => {
  w = await setup();
});

describe("1. normal Check In and Check Out", () => {
  it("starts and ends a session; statuses stay separate; Work Order is not auto-completed", async () => {
    const start = await checkIn(w.op, w.machines.fx1).expect(201);
    expect(start.body.data).toMatchObject({ process: "Printing", available: "1000" });
    expect((await machine(w.machines.fx1)).status).toBe("RUNNING");
    expect((await workOrder()).status).toBe("IN_PROGRESS");
    expect((await step(w.printStep)).status).toBe("RUNNING");

    await w.op.post(`/shopfloor/sessions/${start.body.data.sessionId}/outputs`, { goodQty: 400, rejectQty: 5, clientTxnId: txn() }).expect(201);
    const end = await checkOut(w.op, start.body.data.sessionId, { type: "COMPLETED", totalGood: 1000, totalReject: 12 }).expect(200);
    expect(end.body.data).toMatchObject({ status: "COMPLETED", sessionGood: "1000", sessionReject: "12", processGood: "1000", outstanding: "0" });

    expect((await step(w.printStep)).status).toBe("COMPLETED");
    expect((await machine(w.machines.fx1)).status).toBe("AVAILABLE");
    expect((await workOrder()).status).toBe("PARTIALLY_COMPLETED");
    const audit = await t.db.auditLog.findMany({ where: { module: "shopfloor" }, orderBy: { id: "asc" } });
    expect(audit.map((a) => a.action)).toEqual(["CHECK_IN", "OUTPUT_RECORDED", "CHECK_OUT"]);
  });
});

describe("2 & 3. partial production, shift end and resume", () => {
  it("pauses, closes at shift end and resumes without double counting", async () => {
    const s1 = (await checkIn(w.op, w.machines.fx1).expect(201)).body.data.sessionId;
    await checkOut(w.op, s1, { type: "PARTIAL", totalGood: 300 }).expect(200);
    expect((await t.db.productionSession.findUniqueOrThrow({ where: { id: s1 } })).status).toBe("PAUSED");
    expect((await step(w.printStep)).status).toBe("PAUSED");
    expect((await machine(w.machines.fx1)).status).toBe("IDLE");

    const s2 = (await checkIn(w.op, w.machines.fx1).expect(201)).body.data;
    expect(s2.available).toBe("700");
    const end2 = await checkOut(w.op, s2.sessionId, { type: "SHIFT_END", totalGood: 250, remarks: "Shift A end" }).expect(200);
    expect(end2.body.data).toMatchObject({ status: "CLOSED", processGood: "550", outstanding: "450" });

    const dash = (await w.op.get(`/shopfloor/machines/${w.machines.fx1}/dashboard`).expect(200)).body.data;
    expect(dash.current).toBeNull();
    expect(dash.pausedWork[0]).toMatchObject({ woNo: w.wo.woNo, process: "Printing", good: "550" });
    expect(dash.today.good).toBe("550");
  });
});

describe("4. Work Order completion", () => {
  it("requires every process completed and an explicit confirmation", async () => {
    const s1 = (await checkIn(w.op, w.machines.fx1).expect(201)).body.data.sessionId;
    await checkOut(w.op, s1, { type: "COMPLETED", totalGood: 1000 }).expect(200);
    const early = await w.sup.post(`/planning/work-orders/${w.wo.id}/complete`, {});
    expect(early.body.code).toBe("PROCESSES_OPEN");

    const s2 = (await checkIn(w.op, w.machines.sl1).expect(201)).body.data;
    expect(s2.process).toBe("Slitting");
    // Completing short of target needs a reason
    const noReason = await checkOut(w.op, s2.sessionId, { type: "COMPLETED", totalGood: 980, totalReject: 20 });
    expect(noReason.body.issues[0].path).toBe("remarks");
    await checkOut(w.op, s2.sessionId, { type: "COMPLETED", totalGood: 980, totalReject: 20, remarks: "Edge trim waste" }).expect(200);
    expect((await workOrder()).status).toBe("PARTIALLY_COMPLETED");

    const short = await w.sup.post(`/planning/work-orders/${w.wo.id}/complete`, {});
    expect(short.body.issues[0].path).toBe("note");
    await w.sup.post(`/planning/work-orders/${w.wo.id}/complete`, { note: "Customer accepts 980" }).expect(200);
    expect((await workOrder()).status).toBe("COMPLETED");
    const after = await checkIn(w.op, w.machines.sl1);
    expect(after.body.code).toBe("WO_CLOSED");
  });
});

describe("5. invalid machine / process combination", () => {
  it("refuses a machine that can't do the current process, and the next process before the previous", async () => {
    const res = await checkIn(w.op, w.machines.sl1);
    expect(res.body.code).toBe("PREVIOUS_NOT_DONE");
    const scan = (await w.op.get(`/shopfloor/work-orders/by-number/${w.wo.woNo}?machineId=${w.machines.sl1}`).expect(200)).body.data;
    expect(scan.eligibility.canStart).toBe(false);
    expect(scan.eligibility.blockers[0].message).toContain("Printing must be completed before Slitting");

    // A machine whose category supports none of the open processes
    const cat = (await w.admin.post("/planning/machine-categories", { code: "LAM", name: "Laminator", processIds: [] }).expect(201)).body.data.id;
    const lam = (await w.admin.post("/planning/machines", { code: "LM-01", name: "Laminator 1", categoryId: cat }).expect(201)).body.data.id;
    const bad = await checkIn(w.admin, lam);
    expect(bad.body.code).toBe("PROCESS_NOT_SUPPORTED");
    expect(bad.body.title).toContain("needs Printing");
  });
});

describe("6, 7 & 8. breakdown, machine change and resume on another machine", () => {
  it("records the breakdown, blocks the machine, transfers only the remaining quantity", async () => {
    const s1 = (await checkIn(w.op, w.machines.fx1).expect(201)).body.data.sessionId;
    const bd = await w.op.post(`/shopfloor/machines/${w.machines.fx1}/breakdowns`, { reason: "MECHANICAL", remarks: "Anilox bearing noise", totalGood: 600, totalReject: 10, clientTxnId: txn() }).expect(201);
    expect(bd.body.data.breakdownNo).toMatch(/^BD-\d{4}-\d{5}$/);
    const session = await t.db.productionSession.findUniqueOrThrow({ where: { id: s1 } });
    expect(session).toMatchObject({ status: "BREAKDOWN", checkOutType: "MACHINE_BREAKDOWN" });
    expect((await machine(w.machines.fx1)).status).toBe("BREAKDOWN");
    const record = await t.db.machineBreakdown.findFirstOrThrow({ where: { machineId: w.machines.fx1 } });
    expect(record.lastConfirmedGood?.toString()).toBe("600");

    // 6: no new session on the broken machine
    expect((await checkIn(w.op, w.machines.fx1)).body.code).toBe("MACHINE_BLOCKED");
    // 8: the process stays assigned to FX-01 until a machine change
    expect((await checkIn(w.op, w.machines.fx2)).body.code).toBe("ASSIGNED_ELSEWHERE");

    // 7: operator requests change -> pending until a supervisor approves
    const alts = (await w.op.get(`/shopfloor/work-order-processes/${w.printStep}/alternative-machines`).expect(200)).body.data;
    expect(alts.map((m: { code: string }) => m.code)).toEqual(["FX-02"]);
    const req = await w.op.post("/shopfloor/machine-changes", { woProcessId: w.printStep, toMachineId: w.machines.fx2, reason: "FX-01 breakdown", clientTxnId: txn() }).expect(201);
    expect(req.body.data.status).toBe("PENDING");
    expect((await checkIn(w.op, w.machines.fx2)).body.code).toBe("CHANGE_PENDING");
    await w.op.post(`/shopfloor/machine-changes/${req.body.data.id}/decision`, { approve: true }).expect(403);
    await w.sup.post(`/shopfloor/machine-changes/${req.body.data.id}/decision`, { approve: true, note: "OK" }).expect(200);

    const change = await t.db.machineChange.findUniqueOrThrow({ where: { id: req.body.data.id } });
    expect({ good: change.prevMachineGood.toString(), reject: change.prevMachineReject.toString(), outstanding: change.outstandingQty.toString() }).toEqual({ good: "600", reject: "10", outstanding: "400" });

    const s2 = (await checkIn(w.op, w.machines.fx2).expect(201)).body.data;
    expect(s2.available).toBe("400");
    const over = await checkOut(w.op, s2.sessionId, { type: "COMPLETED", totalGood: 401 });
    expect(over.body.code).toBe("QTY_EXCEEDS_AUTHORIZED");
    await checkOut(w.op, s2.sessionId, { type: "COMPLETED", totalGood: 400 }).expect(200);

    // Historical output stays on FX-01; new output on FX-02
    const byMachine = (await w.sup.get("/shopfloor/output-summary?groupBy=machine").expect(200)).body.data;
    expect(byMachine.map((r: { label: string; good: string }) => [r.label, r.good])).toEqual([
      ["FX-01", "600"],
      ["FX-02", "400"],
    ]);
    expect((await step(w.printStep)).goodQty.toString()).toBe("1000");

    // Maintenance release needs the safety confirmation
    await w.sup.post(`/shopfloor/breakdowns/${record.id}/maintenance`, { note: "Replacing bearing" }).expect(200);
    expect((await machine(w.machines.fx1)).status).toBe("MAINTENANCE");
    const unsafe = await w.sup.post(`/shopfloor/breakdowns/${record.id}/release`, { resolutionNote: "Bearing replaced", safetyConfirmed: false });
    expect(unsafe.body.issues[0].path).toBe("safetyConfirmed");
    await w.op.post(`/shopfloor/breakdowns/${record.id}/release`, { resolutionNote: "x", safetyConfirmed: true }).expect(403);
    const released = await w.sup.post(`/shopfloor/breakdowns/${record.id}/release`, { resolutionNote: "Bearing replaced, guard refitted", safetyConfirmed: true }).expect(200);
    expect(released.body.data.machineStatus).toBe("AVAILABLE");

    const journey = (await w.sup.get(`/planning/work-orders/${w.wo.id}/journey`).expect(200)).body.data;
    expect(journey.sessions.map((s: { machine: { code: string }; status: string }) => [s.machine.code, s.status])).toEqual([
      ["FX-01", "BREAKDOWN"],
      ["FX-02", "COMPLETED"],
    ]);
    expect(journey.machineChanges[0]).toMatchObject({ from: { code: "FX-01" }, to: { code: "FX-02" }, status: "APPROVED" });
    expect(journey.breakdowns[0]).toMatchObject({ reason: "MECHANICAL", status: "RESOLVED" });
  });

  it("Check Out with type Machine Change by a supervisor applies immediately", async () => {
    const s1 = (await checkIn(w.sup, w.machines.fx1).expect(201)).body.data.sessionId;
    const res = await checkOut(w.sup, s1, { type: "MACHINE_CHANGE", totalGood: 200, toMachineId: w.machines.fx2, changeReason: "Rescheduled" }).expect(200);
    expect(res.body.data.machineChange.status).toBe("APPROVED");
    expect((await step(w.printStep)).assignedMachineId).toBe(w.machines.fx2);
    expect((await machine(w.machines.fx1)).status).toBe("AVAILABLE");
    expect((await machine(w.machines.fx2)).status).toBe("IDLE");
    expect((await checkIn(w.op, w.machines.fx2).expect(201)).body.data.available).toBe("800");
  });
});

describe("9. same Work Order on multiple machines", () => {
  it("is refused until a supervisor authorises split production", async () => {
    const s1 = (await checkIn(w.op, w.machines.fx1).expect(201)).body.data.sessionId;
    expect((await checkIn(w.op2, w.machines.fx2)).body.code).toBe("ALREADY_RUNNING");
    await w.op.put(`/planning/work-order-processes/${w.printStep}/authorization`, { allowSplit: true, note: "Rush" }).expect(403);
    await w.sup.put(`/planning/work-order-processes/${w.printStep}/authorization`, { allowSplit: true, note: "Rush order" }).expect(200);
    const s2 = (await checkIn(w.op2, w.machines.fx2).expect(201)).body.data.sessionId;

    expect((await checkOut(w.op, s1, { type: "COMPLETED", totalGood: 500 })).body.code).toBe("OTHERS_RUNNING");
    await checkOut(w.op, s1, { type: "PARTIAL", totalGood: 500 }).expect(200);
    // Combined good output across both machines can't exceed the target
    expect((await checkOut(w.op2, s2, { type: "COMPLETED", totalGood: 600 })).body.code).toBe("QTY_EXCEEDS_AUTHORIZED");
    await checkOut(w.op2, s2, { type: "COMPLETED", totalGood: 500 }).expect(200);
    expect((await step(w.printStep)).goodQty.toString()).toBe("1000");
  });
});

describe("10 & 11. duplicate prevention", () => {
  it("prevents duplicate Check In (sequential and concurrent)", async () => {
    await checkIn(w.op, w.machines.fx1).expect(201);
    expect((await checkIn(w.op, w.machines.fx1)).body.code).toBe("MACHINE_BUSY");
    expect((await checkIn(w.op2, w.machines.fx2)).body.code).toBe("ALREADY_RUNNING");
  });

  it("lets only one of two simultaneous Check Ins win", async () => {
    const [a, b] = await Promise.all([checkIn(w.op, w.machines.fx1), checkIn(w.op2, w.machines.fx2)]);
    expect([a.status, b.status].sort()).toEqual([201, 422]);
    expect(await t.db.productionSession.count({ where: { status: "RUNNING" } })).toBe(1);
  });

  it("counts a duplicated output submission once", async () => {
    const s = (await checkIn(w.op, w.machines.fx1).expect(201)).body.data.sessionId;
    const id = txn();
    const first = await w.op.post(`/shopfloor/sessions/${s}/outputs`, { goodQty: 100, rejectQty: 0, clientTxnId: id }).expect(201);
    const again = await w.op.post(`/shopfloor/sessions/${s}/outputs`, { goodQty: 100, rejectQty: 0, clientTxnId: id }).expect(200);
    expect(first.body.data.replayed).toBe(false);
    expect(again.body.data).toMatchObject({ replayed: true, sessionGood: "100" });
    expect(await t.db.productionOutput.count()).toBe(1);
    // The same id can't be reused for a different kind of request
    expect((await checkOut(w.op, s, { type: "PARTIAL", totalGood: 100 }, id)).status).toBe(409);
  });
});

describe("12 & 13. authorisation and machine availability", () => {
  it("refuses unqualified operators and other operators' sessions", async () => {
    // op2 is not qualified for the slitter category
    const s = (await checkIn(w.op, w.machines.fx1).expect(201)).body.data.sessionId;
    await checkOut(w.op, s, { type: "COMPLETED", totalGood: 1000 }).expect(200);
    expect((await checkIn(w.op2, w.machines.sl1)).body.code).toBe("NOT_QUALIFIED");

    const s2 = (await checkIn(w.op, w.machines.sl1).expect(201)).body.data.sessionId;
    await w.op2.post(`/shopfloor/sessions/${s2}/outputs`, { goodQty: 1, rejectQty: 0, clientTxnId: txn() }).expect(403);
    await w.sup.post(`/shopfloor/sessions/${s2}/outputs`, { goodQty: 1, rejectQty: 0, clientTxnId: txn() }).expect(201);
    await t.createUser("viewer", ["MANAGEMENT"]);
    const viewer = await t.login("viewer");
    await viewer.post("/shopfloor/check-in", { machineId: w.machines.fx1, workOrderId: w.wo.id, clientTxnId: txn() }).expect(403);
  });

  it("blocks machines under maintenance or offline; release needs safety confirmation", async () => {
    await w.sup.put(`/shopfloor/machines/${w.machines.fx1}/status`, { status: "MAINTENANCE", note: "Planned PM" }).expect(200);
    expect((await checkIn(w.op, w.machines.fx1)).body.code).toBe("MACHINE_BLOCKED");
    const unsafe = await w.sup.put(`/shopfloor/machines/${w.machines.fx1}/status`, { status: "AVAILABLE", note: "Done" });
    expect(unsafe.body.issues[0].path).toBe("safetyConfirmed");
    await w.sup.put(`/shopfloor/machines/${w.machines.fx1}/status`, { status: "AVAILABLE", note: "PM done", safetyConfirmed: true }).expect(200);
    await checkIn(w.op, w.machines.fx1).expect(201);
    expect((await w.sup.put(`/shopfloor/machines/${w.machines.fx1}/status`, { status: "OFFLINE", note: "x" })).body.code).toBe("MACHINE_BUSY");
  });

  it("refuses Job Orders on hold or not released", async () => {
    await w.sup.post(`/planning/work-orders/${w.wo.id}/hold`, { reason: "Artwork query" }).expect(200);
    expect((await checkIn(w.op, w.machines.fx1)).body.code).toBe("WO_ON_HOLD");
    await w.sup.post(`/planning/work-orders/${w.wo.id}/unhold`, {}).expect(200);
    await checkIn(w.op, w.machines.fx1).expect(201);
  });
});

describe("14. network interruption", () => {
  it("a retried Check In / Check Out with the same transaction id is applied once", async () => {
    const inId = txn();
    const a = await checkIn(w.op, w.machines.fx1, w.wo.id, inId).expect(201);
    const b = await checkIn(w.op, w.machines.fx1, w.wo.id, inId).expect(200); // response was "lost"; app retries
    expect(b.body.data).toMatchObject({ sessionId: a.body.data.sessionId, replayed: true });
    expect(await t.db.productionSession.count()).toBe(1);

    const outId = txn();
    await checkOut(w.op, a.body.data.sessionId, { type: "PARTIAL", totalGood: 300 }, outId).expect(200);
    const retry = await checkOut(w.op, a.body.data.sessionId, { type: "PARTIAL", totalGood: 300 }, outId).expect(200);
    expect(retry.body.data).toMatchObject({ replayed: true, processGood: "300" });
    expect((await step(w.printStep)).goodQty.toString()).toBe("300");
  });
});

describe("15. machine-level vs Work Order-level aggregation", () => {
  it("keeps machine output separate and totals consistent; downstream can't exceed upstream", async () => {
    const s1 = (await checkIn(w.op, w.machines.fx1).expect(201)).body.data.sessionId;
    await w.op.post(`/shopfloor/sessions/${s1}/outputs`, { goodQty: 250, rejectQty: 3, clientTxnId: txn() }).expect(201);
    await checkOut(w.op, s1, { type: "MACHINE_CHANGE", totalGood: 400, totalReject: 5, toMachineId: w.machines.fx2, changeReason: "Swap" }).expect(200);
    await w.sup.post(`/shopfloor/machine-changes/${(await t.db.machineChange.findFirstOrThrow()).id}/decision`, { approve: true }).expect(200);
    const s2 = (await checkIn(w.op, w.machines.fx2).expect(201)).body.data.sessionId;
    // Over target without authorisation is refused; a supervisor authorises 50 extra
    expect((await checkOut(w.op, s2, { type: "COMPLETED", totalGood: 650 })).body.code).toBe("QTY_EXCEEDS_AUTHORIZED");
    await w.sup.put(`/planning/work-order-processes/${w.printStep}/authorization`, { extraAllowedQty: 50, note: "Customer accepts overs" }).expect(200);
    await checkOut(w.op, s2, { type: "COMPLETED", totalGood: 650, totalReject: 2 }).expect(200);

    // Totals: sessions == outputs == process
    const outputs = await t.db.productionOutput.groupBy({ by: ["machineId"], _sum: { goodQty: true, rejectQty: true } });
    const sessions = await t.db.productionSession.groupBy({ by: ["machineId"], _sum: { goodQty: true, rejectQty: true } });
    for (const o of outputs) {
      const s = sessions.find((x) => x.machineId === o.machineId)!;
      expect(o._sum.goodQty?.toString()).toBe(s._sum.goodQty?.toString());
      expect(o._sum.rejectQty?.toString()).toBe(s._sum.rejectQty?.toString());
    }
    const print = await step(w.printStep);
    expect([print.goodQty.toString(), print.rejectQty.toString()]).toEqual(["1050", "7"]);

    // Slitting can take at most what printing passed on (1050 good)
    const s3 = (await checkIn(w.op, w.machines.sl1).expect(201)).body.data;
    expect(s3.available).toBe("1050");
    expect((await checkOut(w.op, s3.sessionId, { type: "PARTIAL", totalGood: 1000, totalReject: 51 })).body.code).toBe("QTY_EXCEEDS_AUTHORIZED");
    await checkOut(w.op, s3.sessionId, { type: "PARTIAL", totalGood: 1000, totalReject: 50 }).expect(200);

    const view = (await w.sup.get(`/planning/work-orders/${w.wo.id}`).expect(200)).body.data;
    expect(view.processes[0].quantities).toMatchObject({ target: "1000", good: "1050", reject: "7", outstanding: "0", acceptedByNext: "1050" });
    expect(view.processes[1].quantities).toMatchObject({ authorized: "1050", good: "1000", reject: "50", available: "0", outstanding: "0" });
    const byWo = (await w.sup.get("/shopfloor/output-summary?groupBy=workOrder").expect(200)).body.data;
    expect(byWo[0]).toMatchObject({ label: w.wo.woNo, good: "2050", reject: "57" });
    // Production outputs are append-only
    const row = await t.db.productionOutput.findFirstOrThrow();
    await expect(t.db.productionOutput.update({ where: { id: row.id }, data: { goodQty: 1 } })).rejects.toThrow(/append-only/);
  });
});

describe("planning rules", () => {
  it("freezes BOM revisions at PJO release and limits Job Order quantity to the PJO", async () => {
    const pjo = await t.db.productionJobOrder.findFirstOrThrow();
    const bomId = pjo.bomId;
    await w.admin.patch(`/boms/${bomId}/artwork`, { labelDescription: "Test Label v2" }).expect(200);
    const view = (await w.admin.get(`/planning/work-orders/${w.wo.id}`).expect(200)).body.data;
    expect(view.pjo).toMatchObject({ artworkRevision: 1, labelDescription: "Test Label" });
    const tooMuch = await w.admin.post("/planning/work-orders", { pjoId: pjo.id, quantity: 4001, processIds: [w.processes.print] });
    expect(tooMuch.body.issues[0].message).toContain("Only 4000 PCS");
    await w.admin.post("/planning/work-orders", { pjoId: pjo.id, quantity: 4000, processIds: [w.processes.print] }).expect(201);
  });

  it("needs a route when the order has no Master Card routine, and can take a routine instead of processes", async () => {
    const routine = (await w.admin.post("/shopfloor/routines", { code: "STD", name: "Standard", processIds: [w.processes.print, w.processes.slit] }).expect(201)).body.data.id;
    const pjo = await t.db.productionJobOrder.findFirstOrThrow();
    const none = await w.admin.post("/planning/work-orders", { pjoId: pjo.id, quantity: 10 }).expect(422);
    expect(none.body.issues[0].message).toContain("Master Card has no routine");
    await w.admin.get("/shopfloor/production-routines").expect(404);
    const wo = (await w.admin.post("/planning/work-orders", { pjoId: pjo.id, quantity: 10, routineId: routine }).expect(201)).body.data;
    const view = (await w.admin.get(`/planning/work-orders/${wo.id}`).expect(200)).body.data;
    expect(view.processes.map((p: { process: { code: string } }) => p.process.code)).toEqual(["PRINT", "SLIT"]);
    expect((await checkIn(w.op, w.machines.fx1, wo.id)).body.code).toBe("WO_NOT_RELEASED");
  });

  it("registers the handheld device and lets a supervisor pin it to a machine", async () => {
    const dev = await w.op.get("/shopfloor/device").set("X-Device-Id", "dev-handheld-0001").expect(200);
    expect(dev.body.data).toMatchObject({ id: "dev-handheld-0001", assignedMachine: null, canReassign: false });
    await w.sup.patch("/planning/handheld-devices/dev-handheld-0001", { assignedMachineId: w.machines.fx1, name: "FX-01 handheld" }).expect(200);
    const pinned = await w.op.get("/shopfloor/device").set("X-Device-Id", "dev-handheld-0001").expect(200);
    expect(pinned.body.data.assignedMachine).toMatchObject({ code: "FX-01" });
    const scan = await w.op.get("/shopfloor/machines/by-code/fx-01").expect(200);
    expect(scan.body.data).toMatchObject({ code: "FX-01", blockers: [] });
  });
});
