import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import jwt from "jsonwebtoken";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// HTTP gates of the WhatsApp media / Inbox routes: sign-in required, Inbox is
// ADMIN-only, bad input is rejected before any database access (no MySQL needed).

let server: Server;
let base = "";
const token = (role: "ADMIN" | "EDITOR") =>
  jwt.sign({ sub: `u-${role}`, email: `${role.toLowerCase()}@test`, role }, process.env.JWT_ACCESS_SECRET!);

beforeAll(async () => {
  const { createApp } = await import("../src/http/app.js");
  server = createApp().listen(0);
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

const call = (path: string, init: RequestInit & { role?: "ADMIN" | "EDITOR" } = {}) =>
  fetch(base + path, {
    ...init,
    headers: { ...(init.role ? { Authorization: `Bearer ${token(init.role)}` } : {}), ...(init.headers ?? {}) },
  });

const ROUTES: [string, string][] = [
  ["PUT", "/api/whatsapp/templates/abc/header-media"],
  ["DELETE", "/api/whatsapp/templates/abc/header-media"],
  ["GET", "/api/whatsapp/media/abc/file"],
  ["GET", "/api/whatsapp/inbox"],
  ["GET", "/api/whatsapp/inbox/918838931463"],
  ["POST", "/api/whatsapp/inbox/918838931463/reply"],
];

describe("WhatsApp media routes", () => {
  it.each(ROUTES)("%s %s requires sign-in", async (method, path) => {
    expect((await call(path, { method })).status).toBe(401);
  });

  it.each(ROUTES.filter(([, p]) => p.includes("/inbox")))("%s %s is ADMIN-only", async (method, path) => {
    expect((await call(path, { method, role: "EDITOR" })).status).toBe(403);
  });

  it("header upload without a file is a 400", async () => {
    const res = await call("/api/whatsapp/templates/abc/header-media", { method: "PUT", role: "ADMIN" });
    expect(res.status).toBe(400);
  });

  it.each([
    ["GET", "/api/whatsapp/templates/meta-sync"],
    ["POST", "/api/whatsapp/templates/meta-sync"],
    ["POST", "/api/whatsapp/templates/meta-create"],
  ])("template sync %s %s: sign-in and ADMIN required", async (method, path) => {
    expect((await call(path, { method })).status).toBe(401);
    expect((await call(path, { method, role: "EDITOR" })).status).toBe(403);
  });

  it("create-in-Meta with invalid details is a 400 before anything reaches Meta", async () => {
    const form = new FormData();
    form.append("template", JSON.stringify({ displayName: "X", name: "Bad Name", language: "en", category: "MARKETING", body: "Hi" }));
    const res = await call("/api/whatsapp/templates/meta-create", { method: "POST", role: "ADMIN", body: form });
    expect(res.status).toBe(400);
  });

  it("a reply to an invalid number is a 400", async () => {
    const res = await call("/api/whatsapp/inbox/12/reply", { method: "POST", role: "ADMIN" });
    expect(res.status).toBe(400);
  });
});
