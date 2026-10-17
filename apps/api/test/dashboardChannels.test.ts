import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import jwt from "jsonwebtoken";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  parseSpan,
  pctChange,
  rangeFor,
  summarizeCalls,
  summarizeEmail,
  summarizeWhatsAppSends,
  type CallRow,
  type WhatsAppSendRow,
} from "../src/domain/dashboardChannels.js";

// Dashboard channel numbers: pure counting helpers, plus the HTTP gates of the
// new read-only endpoints (every request here is rejected before any database
// access, so no MySQL is needed).

const NOW = new Date("2026-10-11T12:00:00Z");
const r7 = rangeFor(7, NOW); // 2026-10-05 … 2026-10-11, previous period 2026-09-28 … 2026-10-04
const at = (iso: string) => new Date(`${iso}T10:00:00Z`);

describe("range helpers", () => {
  it("accepts only the dashboard toggle values", () => {
    expect(parseSpan("7")).toBe(7);
    expect(parseSpan(undefined)).toBe(14);
    expect(parseSpan("30")).toBe(30);
    expect(parseSpan("90")).toBeNull();
    expect(parseSpan("abc")).toBeNull();
  });

  it("uses UTC day windows like the email chart", () => {
    expect(r7.start.toISOString()).toBe("2026-10-05T00:00:00.000Z");
    expect(r7.prevStart.toISOString()).toBe("2026-09-28T00:00:00.000Z");
  });

  it("reports a trend only when there is a previous value", () => {
    expect(pctChange(15, 10)).toBe(50);
    expect(pctChange(5, 10)).toBe(-50);
    expect(pctChange(0, 0)).toBe(0);
    expect(pctChange(3, 0)).toBeNull();
  });
});

describe("summarizeWhatsAppSends", () => {
  const row = (p: Partial<WhatsAppSendRow>): WhatsAppSendRow => ({
    status: "SENT",
    batchId: "b1",
    templateId: "t1",
    sentAt: null,
    deliveredAt: null,
    readAt: null,
    failedAt: null,
    ...p,
  });

  it("counts each event on its own day and follows the Send Queue sent/failed rule", () => {
    const s = summarizeWhatsAppSends(
      [
        row({ status: "READ", sentAt: at("2026-10-06"), deliveredAt: at("2026-10-06"), readAt: at("2026-10-07") }),
        row({ status: "DELIVERED", sentAt: at("2026-10-06"), deliveredAt: at("2026-10-08"), batchId: null, templateId: null }),
        row({ status: "FAILED", sentAt: at("2026-10-09"), failedAt: at("2026-10-09") }), // sent then failed → failed only
        row({ status: "SENT", sentAt: at("2026-09-30") }), // previous period
        row({ status: "QUEUED" }),
      ],
      r7,
    );
    expect(s.totals).toMatchObject({ sent: 2, delivered: 2, read: 1, failed: 1, sentFromBatches: 1, failedFromBatches: 1 });
    expect(s.totals.successRate).toBeCloseTo(66.7);
    expect(s.trend).toEqual({ prevSent: 1, delta: 100 });
    expect(s.series).toHaveLength(7);
    expect(s.series.find((p) => p.date === "2026-10-06")).toEqual({ date: "2026-10-06", sent: 2, delivered: 1, read: 0, failed: 0 });
    expect(s.series.find((p) => p.date === "2026-10-07")?.read).toBe(1);
    expect(s.byTemplate.get("t1")).toBe(1);
  });

  it("returns zeros, not gaps, when there is no data", () => {
    const s = summarizeWhatsAppSends([], r7);
    expect(s.totals).toMatchObject({ sent: 0, failed: 0, successRate: 0 });
    expect(s.series.every((p) => p.sent === 0 && p.failed === 0)).toBe(true);
    expect(s.trend.delta).toBe(0);
  });
});

describe("summarizeCalls", () => {
  const call = (p: Partial<CallRow>): CallRow => ({
    runId: "r1",
    status: "COMPLETED",
    outcome: null,
    durationSec: null,
    startedAt: null,
    createdAt: at("2026-10-06"),
    ...p,
  });

  it("splits placed calls by result and averages timed calls", () => {
    const s = summarizeCalls(
      [
        call({ status: "COMPLETED", durationSec: 60, outcome: "interested", startedAt: at("2026-10-07") }),
        call({ status: "COMPLETED", durationSec: 120, outcome: "interested", runId: "r2" }),
        call({ status: "NO_ANSWER" }),
        call({ status: "BUSY" }),
        call({ status: "IN_PROGRESS" }),
        call({ status: "QUEUED" }), // never dialled
        call({ status: "CANCELLED" }),
        call({ status: "FAILED", createdAt: at("2026-10-01") }), // previous period
      ],
      r7,
    );
    expect(s.totals).toMatchObject({ total: 5, completed: 2, noAnswer: 1, busy: 1, failed: 0, inProgress: 1, avgDurationSec: 90, totalDurationSec: 180 });
    expect(s.totals.answeredRate).toBe(50); // 2 of 4 finished calls
    expect(s.trend).toEqual({ prevTotal: 1, delta: 400 });
    expect(s.outcomes).toEqual([{ outcome: "interested", count: 2 }]);
    expect(s.series.find((p) => p.date === "2026-10-07")).toEqual({ date: "2026-10-07", total: 1, completed: 1, unanswered: 0 });
    expect(s.callsByRun.get("r1")).toBe(4);
  });
});

describe("summarizeEmail", () => {
  it("computes open / click rates for mail sent in the range", () => {
    const s = summarizeEmail(
      [
        { status: "OPENED", sentAt: at("2026-10-06"), openedAt: at("2026-10-07"), clickedAt: null },
        { status: "CLICKED", sentAt: at("2026-10-06"), openedAt: null, clickedAt: at("2026-10-06") },
        { status: "BOUNCED", sentAt: at("2026-10-08"), openedAt: null, clickedAt: null },
        { status: "SENT", sentAt: at("2026-10-08"), openedAt: null, clickedAt: null },
        { status: "SENT", sentAt: at("2026-09-29"), openedAt: null, clickedAt: null },
      ],
      r7,
    );
    expect(s.totals).toEqual({ sent: 4, opened: 2, clicked: 1, bounced: 1, openRate: 50, clickRate: 25 });
    expect(s.trend).toEqual({ prevSent: 1, delta: 300 });
  });
});

/* -------------------------------------------------------------------- HTTP gates */

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

describe("GET /api/dashboard/{email,whatsapp,calls}", () => {
  it("requires sign-in", async () => {
    for (const p of ["email", "whatsapp", "calls"]) expect((await get(`/api/dashboard/${p}?days=7`)).status).toBe(401);
  });

  it("rejects a range other than 7, 14 or 30 days", async () => {
    expect((await get("/api/dashboard/email?days=90", "EDITOR")).status).toBe(400);
    expect((await get("/api/dashboard/whatsapp?days=3", "EDITOR")).status).toBe(400);
    expect((await get("/api/dashboard/calls?days=x", "ADMIN")).status).toBe(400);
  });

  it("lets editors see call numbers, like the AI call pages", async () => {
    expect((await get("/api/dashboard/calls?days=x", "EDITOR")).status).toBe(400); // past the role gate
  });

  it("returns 404 for calls while AI calls are disabled", async () => {
    const { aiCallsConfig } = await import("../src/config/aiCalls.js");
    const cfg = aiCallsConfig as { enabled: boolean }; // read-only in app code; flipped here for the test only
    const was = cfg.enabled;
    cfg.enabled = false;
    try {
      expect((await get("/api/dashboard/calls?days=7", "ADMIN")).status).toBe(404);
    } finally {
      cfg.enabled = was;
    }
  });

  it("only accepts GET (read-only)", async () => {
    const res = await fetch(`${base}/api/dashboard/whatsapp?days=7`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token("ADMIN")}` },
    });
    expect(res.status).toBe(404);
  });
});
