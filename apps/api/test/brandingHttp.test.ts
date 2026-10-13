import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import jwt from "jsonwebtoken";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// HTTP gates and behaviour of /api/settings/branding. The branding table is an
// in-memory fake; `missing` makes it behave as if migration 0024 isn't applied.

type Row = { key: string; value: string; updatedBy: string };
const { rows, state } = vi.hoisted(() => ({ rows: new Map<string, Row>(), state: { missing: false } }));
const tableMissing = () => Object.assign(new Error("The table `branding_settings` does not exist"), { code: "P2021" });

vi.mock("../src/prisma.js", () => {
  const guard = <T>(fn: () => T) => (state.missing ? Promise.reject(tableMissing()) : Promise.resolve(fn()));
  const brandingSetting = {
    findMany: () => guard(() => [...rows.values()]),
    upsert: ({ where, create, update }: { where: { key: string }; create: Row; update: Partial<Row> }) =>
      guard(() => {
        const next = rows.has(where.key) ? { ...rows.get(where.key)!, ...update } : create;
        rows.set(where.key, next);
        return next;
      }),
    deleteMany: ({ where }: { where: { key?: string } }) =>
      guard(() => {
        if (where.key) rows.delete(where.key);
        else rows.clear();
        return { count: 1 };
      }),
  };
  return { prisma: { brandingSetting, $transaction: (ops: Promise<unknown>[]) => Promise.all(ops) } };
});

let server: Server;
let base = "";
const token = (role: "ADMIN" | "EDITOR") =>
  jwt.sign({ sub: `u-${role}`, email: `${role.toLowerCase()}@test`, role }, process.env.JWT_ACCESS_SECRET!);

beforeAll(async () => {
  const { createApp } = await import("../src/http/app.js");
  server = createApp().listen(0);
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
});
beforeEach(() => {
  rows.clear();
  state.missing = false;
});

const call = (path: string, init: RequestInit & { role?: "ADMIN" | "EDITOR"; json?: unknown } = {}) =>
  fetch(base + path, {
    ...init,
    body: init.json === undefined ? undefined : JSON.stringify(init.json),
    headers: {
      "Content-Type": "application/json",
      ...(init.role ? { Authorization: `Bearer ${token(init.role)}` } : {}),
    },
  });
const read = async (role: "ADMIN" | "EDITOR" = "EDITOR") =>
  (await (await call("/api/settings/branding", { role })).json()) as { labels: Record<string, string>; customized: string[] };

describe("/api/settings/branding", () => {
  it("requires sign-in; any signed-in user can read; defaults when nothing is saved", async () => {
    expect((await call("/api/settings/branding")).status).toBe(401);
    const body = await read("EDITOR");
    expect(body.labels).toMatchObject({ appName: "Dispatch", "section.main": "Main", "nav.sendQueue": "Send Queue" });
    expect(body.customized).toEqual([]);
  });

  it("non-admins get 403 on save and reset, and nothing changes", async () => {
    expect((await call("/api/settings/branding", { method: "PUT", role: "EDITOR", json: { labels: { appName: "Acme" } } })).status).toBe(403);
    expect((await call("/api/settings/branding", { method: "DELETE", role: "EDITOR" })).status).toBe(403);
    expect((await call("/api/settings/branding?key=appName", { method: "DELETE", role: "EDITOR" })).status).toBe(403);
    expect(rows.size).toBe(0);
  });

  it("admin saves; every user then sees the new name; the user id is recorded", async () => {
    const res = await call("/api/settings/branding", {
      method: "PUT",
      role: "ADMIN",
      json: { labels: { appName: "  Acme CRM ", "nav.contacts": "People" } },
    });
    expect(res.status).toBe(200);
    const body = await read("EDITOR");
    expect(body.labels.appName).toBe("Acme CRM");
    expect(body.labels["nav.contacts"]).toBe("People");
    expect(body.labels["nav.dashboard"]).toBe("Dashboard");
    expect(body.customized.sort()).toEqual(["appName", "nav.contacts"]);
    expect(rows.get("appName")).toEqual({ key: "appName", value: "Acme CRM", updatedBy: "u-ADMIN" });
  });

  it("saving a default value removes the row", async () => {
    await call("/api/settings/branding", { method: "PUT", role: "ADMIN", json: { labels: { appName: "Acme" } } });
    await call("/api/settings/branding", { method: "PUT", role: "ADMIN", json: { labels: { appName: "Dispatch" } } });
    expect(rows.size).toBe(0);
  });

  it("admin resets one key, then all", async () => {
    await call("/api/settings/branding", { method: "PUT", role: "ADMIN", json: { labels: { appName: "Acme", "nav.settings": "Admin" } } });
    const one = await call("/api/settings/branding?key=appName", { method: "DELETE", role: "ADMIN" });
    expect(one.status).toBe(200);
    expect((await read()).labels).toMatchObject({ appName: "Dispatch", "nav.settings": "Admin" });
    expect((await call("/api/settings/branding", { method: "DELETE", role: "ADMIN" })).status).toBe(200);
    expect((await read()).customized).toEqual([]);
  });

  it("rejects HTML, over-length values and unknown keys with 400", async () => {
    for (const labels of [
      { appName: "<script>alert(1)</script>" },
      { appName: "<b>Acme</b>" },
      { appName: "a".repeat(25) },
      { "nav.contacts": "a".repeat(31) },
      { appName: "" },
      { madeUp: "x" },
    ]) {
      const res = await call("/api/settings/branding", { method: "PUT", role: "ADMIN", json: { labels } });
      expect(res.status, JSON.stringify(labels)).toBe(400);
    }
    expect((await call("/api/settings/branding?key=madeUp", { method: "DELETE", role: "ADMIN" })).status).toBe(400);
    expect(rows.size).toBe(0);
  });

  it("table missing: reads still return the defaults (no 500); writes get a clear 503", async () => {
    state.missing = true;
    const res = await call("/api/settings/branding", { role: "EDITOR" });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { labels: Record<string, string> }).labels.appName).toBe("Dispatch");
    const put = await call("/api/settings/branding", { method: "PUT", role: "ADMIN", json: { labels: { appName: "Acme" } } });
    expect(put.status).toBe(503);
    expect(((await put.json()) as { error: string }).error).toMatch(/prisma:deploy/);
    expect((await call("/api/settings/branding", { method: "DELETE", role: "ADMIN" })).status).toBe(503);
  });
});
