import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import jwt from "jsonwebtoken";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// Send Queue → per-row Delete (Email batch, WhatsApp batch, AI Call follow-up). Finished entries are
// removed; anything still in progress is refused with a reason instead. Prisma is mocked.

const db = vi.hoisted(() => ({
  manualSendBatch: { findUnique: vi.fn(), deleteMany: vi.fn() },
  whatsAppSendBatch: { findUnique: vi.fn(), deleteMany: vi.fn() },
  whatsAppSend: { findMany: vi.fn() },
  whatsAppSendMedia: { deleteMany: vi.fn() },
  aiCallFollowup: { findUnique: vi.fn(), deleteMany: vi.fn() },
  aiCallCustomerEvent: { create: vi.fn() },
  $transaction: vi.fn((ops: Promise<unknown>[]) => Promise.all(ops)),
}));
vi.mock("../src/prisma.js", () => ({ prisma: db }));

const { deleteEmailBatch, deleteWhatsAppBatch, deleteFollowup } = await import("../src/domain/sendHistoryDelete.js");

const followup = (over: Record<string, unknown> = {}) => ({
  status: "REJECTED",
  channel: "WHATSAPP",
  aiCallRunId: null,
  customerId: "c1",
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  db.manualSendBatch.findUnique.mockResolvedValue({ status: "DONE", total: 3 });
  db.manualSendBatch.deleteMany.mockResolvedValue({ count: 1 });
  db.whatsAppSendBatch.findUnique.mockResolvedValue({ status: "CANCELLED", total: 2 });
  db.whatsAppSendBatch.deleteMany.mockResolvedValue({ count: 1 });
  db.whatsAppSend.findMany.mockResolvedValue([{ id: "s1" }, { id: "s2" }]);
  db.whatsAppSendMedia.deleteMany.mockResolvedValue({ count: 1 });
  db.aiCallFollowup.findUnique.mockResolvedValue(followup());
  db.aiCallFollowup.deleteMany.mockResolvedValue({ count: 1 });
  db.aiCallCustomerEvent.create.mockResolvedValue({});
});

describe("deleteEmailBatch", () => {
  it("deletes a finished batch (its recipient rows go with it), never a running one", async () => {
    await expect(deleteEmailBatch("b1", "a@test")).resolves.toEqual({ ok: true });
    expect(db.manualSendBatch.deleteMany).toHaveBeenCalledWith({ where: { id: "b1", status: { not: "RUNNING" } } });
  });

  it("refuses while still sending", async () => {
    db.manualSendBatch.findUnique.mockResolvedValue({ status: "RUNNING", total: 3 });
    expect(await deleteEmailBatch("b1", "a@test")).toMatchObject({ ok: false, status: 409, message: expect.stringMatching(/still running/) });
    expect(db.manualSendBatch.deleteMany).not.toHaveBeenCalled();
  });

  it("404 when unknown; 409 when it changed between the check and the delete", async () => {
    db.manualSendBatch.findUnique.mockResolvedValueOnce(null);
    expect(await deleteEmailBatch("nope", "a@test")).toMatchObject({ ok: false, status: 404 });
    db.manualSendBatch.deleteMany.mockResolvedValueOnce({ count: 0 });
    expect(await deleteEmailBatch("b1", "a@test")).toMatchObject({ ok: false, status: 409 });
  });
});

describe("deleteWhatsAppBatch", () => {
  it("deletes the batch and its messages' media links in one transaction", async () => {
    await expect(deleteWhatsAppBatch("w1", "a@test")).resolves.toEqual({ ok: true });
    expect(db.whatsAppSend.findMany).toHaveBeenCalledWith({ where: { batchId: "w1" }, select: { id: true } });
    expect(db.whatsAppSendMedia.deleteMany).toHaveBeenCalledWith({ where: { sendId: { in: ["s1", "s2"] } } });
    expect(db.whatsAppSendBatch.deleteMany).toHaveBeenCalledWith({ where: { id: "w1", status: { not: "RUNNING" } } });
    expect(db.$transaction).toHaveBeenCalledTimes(1);
  });

  it("clears media links in chunks for a large batch", async () => {
    db.whatsAppSend.findMany.mockResolvedValue(Array.from({ length: 1201 }, (_, i) => ({ id: `s${i}` })));
    await deleteWhatsAppBatch("w1", "a@test");
    expect(db.whatsAppSendMedia.deleteMany).toHaveBeenCalledTimes(3);
  });

  it("refuses while still sending; 404 when unknown", async () => {
    db.whatsAppSendBatch.findUnique.mockResolvedValueOnce({ status: "RUNNING", total: 2 });
    expect(await deleteWhatsAppBatch("w1", "a@test")).toMatchObject({ ok: false, status: 409 });
    db.whatsAppSendBatch.findUnique.mockResolvedValueOnce(null);
    expect(await deleteWhatsAppBatch("w1", "a@test")).toMatchObject({ ok: false, status: 404 });
    expect(db.$transaction).not.toHaveBeenCalled();
  });
});

describe("deleteFollowup", () => {
  it("deletes a decided follow-up and notes it on the customer's timeline", async () => {
    await expect(deleteFollowup("f1", "a@test")).resolves.toEqual({ ok: true });
    expect(db.aiCallFollowup.deleteMany).toHaveBeenCalledWith({ where: { id: "f1", status: "REJECTED", aiCallRunId: null } });
    expect(db.aiCallCustomerEvent.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ customerId: "c1", type: "followup_deleted", refId: "f1", actorEmail: "a@test" }),
    });
  });

  it("refuses one still waiting for approval", async () => {
    db.aiCallFollowup.findUnique.mockResolvedValue(followup({ status: "PENDING_APPROVAL" }));
    expect(await deleteFollowup("f1", "a@test")).toMatchObject({ status: 409, message: expect.stringMatching(/Reject it first/) });
    expect(db.aiCallFollowup.deleteMany).not.toHaveBeenCalled();
  });

  it("refuses an approved call that has not been made yet (deleting it would cancel the call)", async () => {
    db.aiCallFollowup.findUnique.mockResolvedValue(followup({ status: "APPROVED", channel: "CALL", aiCallRunId: null }));
    expect(await deleteFollowup("f1", "a@test")).toMatchObject({ status: 409, message: expect.stringMatching(/still scheduled/) });
    db.aiCallFollowup.findUnique.mockResolvedValue(followup({ status: "APPROVED", channel: "CALL", aiCallRunId: "run1" }));
    expect(await deleteFollowup("f1", "a@test")).toEqual({ ok: true });
  });

  it("still reports the delete when the timeline note fails", async () => {
    db.aiCallCustomerEvent.create.mockRejectedValueOnce(new Error("db down"));
    await expect(deleteFollowup("f1", "a@test")).resolves.toEqual({ ok: true });
  });
});

describe("DELETE routes", () => {
  let server: Server;
  let base = "";
  const token = (role: "ADMIN" | "EDITOR") =>
    jwt.sign({ sub: `u-${role}`, email: `${role.toLowerCase()}@test`, role }, process.env.JWT_ACCESS_SECRET!);
  const del = (path: string, role?: "ADMIN" | "EDITOR") =>
    fetch(base + path, { method: "DELETE", headers: role ? { Authorization: `Bearer ${token(role)}` } : {} });

  beforeAll(async () => {
    process.env.ENABLE_AI_CALLS = "true";
    const { createApp } = await import("../src/http/app.js");
    server = createApp().listen(0);
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => new Promise<void>((r) => server.close(() => r())));

  it("require sign-in", async () => {
    expect((await del("/api/contacts/send/batches/b1")).status).toBe(401);
    expect((await del("/api/whatsapp/send/batches/w1")).status).toBe(401);
    expect((await del("/api/ai-call-followups/f1")).status).toBe(401);
  });

  it("204 when deleted, for admins and editors", async () => {
    expect((await del("/api/contacts/send/batches/b1", "EDITOR")).status).toBe(204);
    expect((await del("/api/whatsapp/send/batches/w1", "EDITOR")).status).toBe(204);
    expect((await del("/api/ai-call-followups/f1", "ADMIN")).status).toBe(204);
  });

  it("409 with the reason while still sending, 404 when unknown", async () => {
    db.manualSendBatch.findUnique.mockResolvedValueOnce({ status: "RUNNING", total: 1 });
    const res = await del("/api/contacts/send/batches/b1", "ADMIN");
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toMatch(/still running/);
    db.whatsAppSendBatch.findUnique.mockResolvedValueOnce(null);
    expect((await del("/api/whatsapp/send/batches/w1", "ADMIN")).status).toBe(404);
  });

  it("the contacts route still deletes contacts, not batches", async () => {
    // "/send/batches/:id" must not be read as DELETE /api/contacts/:id.
    await del("/api/contacts/send/batches/b1", "ADMIN");
    expect(db.manualSendBatch.deleteMany).toHaveBeenCalledTimes(1);
  });
});
