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
    expect(body.labels).toEqual({ appName: "Dispatch" });
    expect(body.customized).toEqual([]);
  });

  it("public /api/branding: no sign-in needed (login page), app name only, follows saves", async () => {
    const before = await call("/api/branding");
    expect(before.status).toBe(200);
    expect(await before.json()).toEqual({ labels: { appName: "Dispatch" }, customized: [] });
    await call("/api/settings/branding", { method: "PUT", role: "ADMIN", json: { labels: { appName: "Kagzso" } } });
    expect(await (await call("/api/branding")).json()).toEqual({ labels: { appName: "Kagzso" }, customized: ["appName"] });
    // read-only: writing through the public path is refused and changes nothing
    expect((await call("/api/branding", { method: "PUT", json: { labels: { appName: "X" } } })).ok).toBe(false);
    expect(rows.get("appName")?.value).toBe("Kagzso");
  });

  it("non-admins get 403 on save and reset, and nothing changes", async () => {
    expect((await call("/api/settings/branding", { method: "PUT", role: "EDITOR", json: { labels: { appName: "Acme" } } })).status).toBe(403);
    expect((await call("/api/settings/branding", { method: "DELETE", role: "EDITOR" })).status).toBe(403);
    expect((await call("/api/settings/branding?key=appName", { method: "DELETE", role: "EDITOR" })).status).toBe(403);
    expect(rows.size).toBe(0);
  });

  it("admin saves; every user (the sidebar) then gets the new name; the user id is recorded", async () => {
    const res = await call("/api/settings/branding", {
      method: "PUT",
      role: "ADMIN",
      json: { labels: { appName: "  Acme CRM " } },
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { labels: { appName: string } }).labels.appName).toBe("Acme CRM");
    const body = await read("EDITOR");
    expect(body.labels.appName).toBe("Acme CRM");
    expect(body.customized).toEqual(["appName"]);
    expect(rows.get("appName")).toEqual({ key: "appName", value: "Acme CRM", updatedBy: "u-ADMIN" });
  });

  it("saving a default value removes the row", async () => {
    await call("/api/settings/branding", { method: "PUT", role: "ADMIN", json: { labels: { appName: "Acme" } } });
    await call("/api/settings/branding", { method: "PUT", role: "ADMIN", json: { labels: { appName: "Dispatch" } } });
    expect(rows.size).toBe(0);
  });

  it("admin resets by key, and resets all", async () => {
    await call("/api/settings/branding", { method: "PUT", role: "ADMIN", json: { labels: { appName: "Acme" } } });
    expect((await call("/api/settings/branding?key=appName", { method: "DELETE", role: "ADMIN" })).status).toBe(200);
    expect((await read()).labels.appName).toBe("Dispatch");
    await call("/api/settings/branding", { method: "PUT", role: "ADMIN", json: { labels: { appName: "Acme" } } });
    expect((await call("/api/settings/branding", { method: "DELETE", role: "ADMIN" })).status).toBe(200);
    expect(await read()).toEqual({ labels: { appName: "Dispatch" }, customized: [] });
  });

  it("rejects HTML, over-length values and unknown keys with 400", async () => {
    for (const labels of [
      { appName: "<script>alert(1)</script>" },
      { appName: "<b>Acme</b>" },
      { appName: "a".repeat(25) },
      { appName: "Acme", "nav.contacts": "People" },
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
    expect((await call("/api/branding")).status).toBe(200);
    const put = await call("/api/settings/branding", { method: "PUT", role: "ADMIN", json: { labels: { appName: "Acme" } } });
    expect(put.status).toBe(503);
    expect(((await put.json()) as { error: string }).error).toMatch(/prisma:deploy/);
    expect((await call("/api/settings/branding", { method: "DELETE", role: "ADMIN" })).status).toBe(503);
  });
});
