import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import jwt from "jsonwebtoken";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { csvLine, EXPORT_HEADERS, followupResult } from "../src/domain/sendQueueExport.js";
import { historyResult } from "../src/domain/historyFilter.js";

// Send Queue "Download all history": CSV shape, status → result mapping (shared
// with "filter new data"), and the HTTP gates — rejected before any database
// access, so no MySQL is needed.

describe("export format", () => {
  it("keeps the per-batch column names inside the batch columns", () => {
    expect(EXPORT_HEADERS.email).toEqual([
      "Batch ID", "Template", "Name", "Email", "Status", "Result",
      "Sent at", "Received at", "Opened at", "Failed at", "Error", "Batch started", "Batch completed",
    ]);
    expect(EXPORT_HEADERS.whatsapp).toContain("Phone");
    expect(EXPORT_HEADERS.whatsapp).not.toContain("Email");
    expect(EXPORT_HEADERS.email).not.toContain("Phone");
  });

  it("quotes like the per-batch CSV", () => {
    expect(csvLine(["a", 'say "hi"', "x,y", null, undefined, "line\nbreak"])).toBe('a,"say ""hi""","x,y",,,"line\nbreak"');
  });
});

describe("result column", () => {
  it("maps each ledger's statuses to sent / failed / still sending", () => {
    expect(historyResult("email-batch", "SENT")).toBe("sent");
    expect(historyResult("email-batch", "PENDING")).toBe("still sending");
    expect(historyResult("email-batch", "FAILED")).toBe("failed");
    expect(historyResult("email-batch", "SKIPPED")).toBe("skipped");
    expect(historyResult("whatsapp", "READ")).toBe("sent");
    expect(historyResult("whatsapp", "QUEUED")).toBe("still sending");
    expect(historyResult("call", "NO_ANSWER")).toBe("done");
    expect(historyResult("call", "CANCELLED")).toBe("cancelled");
    expect(historyResult("call", "WHATEVER")).toBeNull();
  });

  it("reads a follow-up's result from where it was handed over", () => {
    expect(followupResult("PENDING_APPROVAL", "CALL", null)).toBe("waiting for approval");
    expect(followupResult("REJECTED", "WHATSAPP", null)).toBe("rejected");
    expect(followupResult("APPROVED", "WHATSAPP", null)).toBe("still sending");
    expect(followupResult("APPROVED", "WHATSAPP", "DELIVERED")).toBe("sent");
    expect(followupResult("APPROVED", "WHATSAPP", "FAILED")).toBe("failed");
    expect(followupResult("APPROVED", "CALL", "COMPLETED")).toBe("done");
    expect(followupResult("FAILED", "CALL", null)).toBe("failed");
  });
});

let server: Server;
let base = "";
const token = (role: "ADMIN" | "EDITOR") =>
  jwt.sign({ sub: `u-${role}`, email: `${role.toLowerCase()}@test`, role }, process.env.JWT_ACCESS_SECRET!);
const get = (path: string, role?: "ADMIN" | "EDITOR") =>
  fetch(base + path, { headers: role ? { Authorization: `Bearer ${token(role)}` } : {} });

beforeAll(async () => {
  process.env.ENABLE_AI_CALLS = "true";
  const { createApp } = await import("../src/http/app.js");
  server = createApp().listen(0);
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

describe("GET /api/send-queue/history/:channel/*", () => {
  it("requires sign-in", async () => {
    expect((await get("/api/send-queue/history/email/export")).status).toBe(401);
    expect((await get("/api/send-queue/history/whatsapp/count")).status).toBe(401);
  });

  it("only knows the three Send Queue tabs", async () => {
    expect((await get("/api/send-queue/history/sms/export", "ADMIN")).status).toBe(404);
    expect((await get("/api/send-queue/history/ai-call/count", "ADMIN")).status).toBe(404);
  });

  it("keeps AI call follow-ups admin-only", async () => {
    expect((await get("/api/send-queue/history/ai-followups/export", "EDITOR")).status).toBe(403);
    expect((await get("/api/send-queue/history/ai-followups/count", "EDITOR")).status).toBe(403);
  });

  it("returns 404 for follow-ups while AI calls are disabled", async () => {
    const { aiCallsConfig } = await import("../src/config/aiCalls.js");
    const cfg = aiCallsConfig as { enabled: boolean }; // read-only in app code; flipped here for the test only
    const was = cfg.enabled;
    cfg.enabled = false;
    try {
      expect((await get("/api/send-queue/history/ai-followups/export", "ADMIN")).status).toBe(404);
    } finally {
      cfg.enabled = was;
    }
  });

  it("is GET-only (read-only)", async () => {
    const res = await fetch(`${base}/api/send-queue/history/email/export`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token("ADMIN")}` },
    });
    expect(res.status).toBe(404);
  });
});
