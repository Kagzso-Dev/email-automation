import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import jwt from "jsonwebtoken";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { HARD_STOP_CONFIRM_TEXT, type HardStopResult } from "@dispatch/shared";
import { hs } from "./fakePrismaHardStop.js";

// /api/hard-stop (ENABLE_HARD_STOP). Flag off: only GET /config answers ({ enabled: false }), everything else 404 and
// nothing is touched. Flag on: permissions (a send's own stop: Admin and Editor; campaigns and Stop all: Admin),
// idempotency (a second press returns the same open stop), the audit record, and the cancelled-rows CSV.

vi.mock("../src/prisma.js", async () => ({ prisma: (await import("./fakePrismaHardStop.js")).hs.db }));
vi.mock("../src/domain/aiCallCustomerSync.js", async (orig) => ({
  ...(await orig<typeof import("../src/domain/aiCallCustomerSync.js")>()),
  syncCustomerFromLog: vi.fn(async () => undefined),
}));

const originalFlag = process.env.ENABLE_HARD_STOP;
const flag = (on: boolean) => {
  process.env.ENABLE_HARD_STOP = on ? "true" : "false";
};

let server: Server;
let base = "";
type Role = "ADMIN" | "EDITOR";
const token = (role: Role) => jwt.sign({ sub: `u-${role}`, email: `${role.toLowerCase()}@test`, role }, process.env.JWT_ACCESS_SECRET!);
const auth = (role?: Role): Record<string, string> => (role ? { Authorization: `Bearer ${token(role)}` } : {});
const post = (path: string, role: Role | null = "EDITOR") => fetch(base + path, { method: "POST", headers: auth(role ?? undefined) });
const get = (path: string, role: Role | null = "EDITOR") => fetch(base + path, { headers: auth(role ?? undefined) });

beforeAll(async () => {
  const { createApp } = await import("../src/http/app.js");
  server = createApp().listen(0);
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  if (originalFlag === undefined) delete process.env.ENABLE_HARD_STOP;
  else process.env.ENABLE_HARD_STOP = originalFlag;
});
beforeEach(() => {
  hs.reset();
  flag(false);
});

function emailBatch() {
  hs.seed("template", { id: "t1", name: "Welcome" });
  const b = hs.seed("manualSendBatch", { id: "b1", status: "RUNNING", templateId: "t1", minDelaySec: 0, maxDelaySec: 0, purgeAfter: false, total: 3 });
  for (const [i, status] of [[1, "SENDING"], [2, "PENDING"], [3, "PENDING"]] as const) {
    hs.seed("contact", { id: `c${i}`, email: `c${i}@x.test`, firstName: `F${i}`, lastName: null, phone: `98765000${i}`, businessName: null });
    hs.seed("manualSendBatchItem", { id: `i${i}`, batchId: b.id, contactId: `c${i}`, email: `c${i}@x.test`, name: `F${i}`, status });
  }
  return b;
}

describe("flag off (default): exactly as before", () => {
  it("GET /config says off; every other endpoint answers 404 and touches nothing", async () => {
    emailBatch();
    expect(await (await get("/api/hard-stop/config")).json()).toEqual({ enabled: false });
    expect((await post("/api/hard-stop/email-batches/b1")).status).toBe(404);
    expect((await post("/api/hard-stop/all", "ADMIN")).status).toBe(404);
    expect((await get("/api/hard-stop/anything")).status).toBe(404);
    expect((await get("/api/hard-stop/latest?scope=EMAIL_BATCH&targetId=b1")).status).toBe(404);
    expect(hs.T("hardStop")).toEqual([]);
    expect(hs.T("manualSendBatchItem").map((i) => i.status)).toEqual(["SENDING", "PENDING", "PENDING"]);
  });
});

describe("flag on", () => {
  beforeEach(() => flag(true));

  it("signed out: 401", async () => {
    expect((await get("/api/hard-stop/config", null)).status).toBe(401);
    expect((await post("/api/hard-stop/email-batches/b1", null)).status).toBe(401);
  });

  it("permissions: an Editor may stop a send, but not a campaign or everything", async () => {
    emailBatch();
    hs.seed("campaign", { id: "k1", name: "K", status: "SENDING", scheduleType: "ONCE", listId: "L", templateId: "t1" });
    expect((await post("/api/hard-stop/all", "EDITOR")).status).toBe(403);
    expect((await post("/api/hard-stop/campaigns/k1", "EDITOR")).status).toBe(403);
    expect((await get("/api/hard-stop/latest-all", "EDITOR")).status).toBe(403);
    expect(hs.T("campaign")[0]!.status).toBe("SENDING");
    expect((await post("/api/hard-stop/email-batches/b1", "EDITOR")).status).toBe(200);
    expect((await post("/api/hard-stop/campaigns/k1", "ADMIN")).status).toBe(200);
  });

  it("idempotent and audited: a second press returns the same open stop; the record says who, when and how many were in progress", async () => {
    emailBatch();
    const first = (await (await post("/api/hard-stop/email-batches/b1")).json()) as HardStopResult;
    expect(first.created).toBe(true);
    expect(first.stop).toMatchObject({ scope: "EMAIL_BATCH", targetId: "b1", status: "STOPPING", inProgress: 1, inProgressAtStop: 1, cancelled: 2, byEmail: "editor@test" });
    expect(first.stop.reason).toMatch(/^Hard stop by editor@test at \d{4}-\d\d-\d\d \d\d:\d\d UTC$/);
    const again = (await (await post("/api/hard-stop/email-batches/b1", "ADMIN")).json()) as HardStopResult;
    expect(again).toMatchObject({ created: false, stop: { id: first.stop.id } });
    expect(hs.T("hardStop")).toHaveLength(1);
    expect(hs.T("hardStop")[0]).toMatchObject({ byUserId: "u-EDITOR", byEmail: "editor@test", inProgressAtStop: 1, cancelledItems: 2 });
    // The in-progress email finishes: the next read says Stopped.
    hs.T("manualSendBatchItem")[0]!.status = "SENT";
    const view = await (await get(`/api/hard-stop/${first.stop.id}`)).json();
    expect(view).toMatchObject({ status: "STOPPED", inProgress: 0, completed: 1, cancelled: 2 });
    // Finished and not running any more: a new press is refused.
    expect((await post("/api/hard-stop/email-batches/b1")).status).toBe(409);
    expect((await post("/api/hard-stop/email-batches/nope")).status).toBe(404);
  });

  it("latest: the newest stop that covered a send, including a Stop all", async () => {
    emailBatch();
    expect(await (await get("/api/hard-stop/latest?scope=EMAIL_BATCH&targetId=b1")).json()).toEqual({ stop: null });
    const all = (await (await post("/api/hard-stop/all", "ADMIN")).json()) as HardStopResult;
    const latest = (await (await get("/api/hard-stop/latest?scope=EMAIL_BATCH&targetId=b1")).json()) as { stop: { id: string } };
    expect(latest.stop.id).toBe(all.stop.id);
    const latestAll = (await (await get("/api/hard-stop/latest-all", "ADMIN")).json()) as { stop: { id: string } };
    expect(latestAll.stop.id).toBe(all.stop.id);
  });

  it("CSV: the cancelled rows of one channel, BOM + the email import's columns; an unknown channel is a 400", async () => {
    emailBatch();
    const { stop } = (await (await post("/api/hard-stop/email-batches/b1")).json()) as HardStopResult;
    const res = await get(`/api/hard-stop/${stop.id}/cancelled.csv?channel=email`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/text\/csv/);
    expect(res.headers.get("content-disposition")).toMatch(/hard-stop-cancelled-email-\d{4}-\d\d-\d\d-/);
    const bytes = new Uint8Array(await res.arrayBuffer()); // .text() would drop the BOM while decoding
    expect([...bytes.slice(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    const lines = new TextDecoder().decode(bytes).trim().split("\r\n");
    expect(lines[0]).toBe("email,first_name,last_name,phone,business,cancelled_from,reason");
    expect(lines.slice(1).map((l) => l.split(",")[0])).toEqual(["c2@x.test", "c3@x.test"]); // never the one in progress
    expect((await get(`/api/hard-stop/${stop.id}/cancelled.csv?channel=fax`)).status).toBe(400);
  });

  it("the confirmation text is the one agreed, word for word", () => {
    expect(HARD_STOP_CONFIRM_TEXT).toBe(
      "Items already in progress (calls, messages, emails) will finish. Everything not started will be cancelled, including retries and follow-ups. This cannot be undone.",
    );
  });
});
