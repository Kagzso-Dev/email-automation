import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import jwt from "jsonwebtoken";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// HTTP-level gates of /api/ai-calls and the callback webhook. Every request
// here is rejected before any database access, so no MySQL is needed.

let server: Server;
let base = "";
const token = (role: "ADMIN" | "EDITOR") =>
  jwt.sign({ sub: `u-${role}`, email: `${role.toLowerCase()}@test`, role }, process.env.JWT_ACCESS_SECRET!);

beforeAll(async () => {
  process.env.ENABLE_AI_CALLS = "true";
  process.env.ENABLE_CALL_FLOW_EDITOR = "false";
  process.env.AI_CALL_WEBHOOK_SECRET = "webhook-secret-for-tests";
  process.env.VOICE_BACKEND_URL = "";
  process.env.VOICE_BACKEND_API_KEY = "";
  const { createApp } = await import("../src/http/app.js");
  server = createApp().listen(0);
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

const call = (path: string, init: RequestInit & { role?: "ADMIN" | "EDITOR" } = {}) =>
  fetch(base + path, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(init.role ? { Authorization: `Bearer ${token(init.role)}` } : {}),
    },
  });

describe("/api/ai-calls", () => {
  it("requires sign-in", async () => {
    expect((await call("/api/ai-calls/config")).status).toBe(401);
  });

  it("reports the flag and whether the user may start calls", async () => {
    const editor = await (await call("/api/ai-calls/config", { role: "EDITOR" })).json();
    expect(editor).toMatchObject({ enabled: true, configured: false, canStart: false, maxPerRun: 10 });
    const admin = (await (await call("/api/ai-calls/config", { role: "ADMIN" })).json()) as { canStart: boolean };
    expect(admin.canStart).toBe(true);
  });

  it("hides call flows while ENABLE_CALL_FLOW_EDITOR is off", async () => {
    const admin = (await (await call("/api/ai-calls/config", { role: "ADMIN" })).json()) as { flowEditor: boolean };
    expect(admin.flowEditor).toBe(false);
    expect((await call("/api/call-flows", { role: "ADMIN" })).status).toBe(404);
  });

  it("only admins can start calls", async () => {
    const res = await call("/api/ai-calls/start", { method: "POST", role: "EDITOR", body: "{}" });
    expect(res.status).toBe(403);
  });

  it("validates the body", async () => {
    const res = await call("/api/ai-calls/start", { method: "POST", role: "ADMIN", body: JSON.stringify({ rows: [], mode: "all" }) });
    expect(res.status).toBe(400);
  });

  it("refuses to start without a configured voice backend", async () => {
    const res = await call("/api/ai-calls/start", {
      method: "POST",
      role: "ADMIN",
      body: JSON.stringify({ rows: [{ phone: "9876543210" }], mode: "random" }),
    });
    expect(res.status).toBe(503);
    expect(((await res.json()) as { error: string }).error).toMatch(/VOICE_BACKEND_URL/);
  });
});

describe("POST /api/webhooks/ai-calls", () => {
  it("rejects unsigned and mis-signed callbacks", async () => {
    const body = JSON.stringify({ log_id: "x", status: "completed" });
    expect((await call("/api/webhooks/ai-calls", { method: "POST", body })).status).toBe(401);
    const res = await fetch(`${base}/api/webhooks/ai-calls`, {
      method: "POST",
      body,
      headers: {
        "Content-Type": "application/json",
        "X-Kagzso-Timestamp": String(Math.floor(Date.now() / 1000)),
        "X-Kagzso-Signature": "sha256=" + "0".repeat(64),
      },
    });
    expect(res.status).toBe(401);
  });
});
