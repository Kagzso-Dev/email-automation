import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import jwt from "jsonwebtoken";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { fake } from "./fakePrisma.js";

// HTTP gates and behaviour of Settings → Domain mode (/api/settings/sending-domains), the audit of the
// Approved list (/api/settings/allowed-domains) and manual add/edit (/api/contacts) in both modes.
// Prisma is an in-memory fake.

vi.mock("../src/prisma.js", async () => ({ prisma: (await import("./fakePrisma.js")).fake.db }));

const originalFlag = process.env.ENABLE_DOMAIN_BLOCKLIST;
const flag = (on: boolean) => {
  process.env.ENABLE_DOMAIN_BLOCKLIST = on ? "true" : "false";
};

let server: Server;
let base = "";
type Role = "ADMIN" | "EDITOR";
const token = (role: Role) =>
  jwt.sign({ sub: `u-${role}`, email: `${role.toLowerCase()}@test`, role }, process.env.JWT_ACCESS_SECRET!);

beforeAll(async () => {
  const { createApp } = await import("../src/http/app.js");
  server = createApp().listen(0);
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  if (originalFlag === undefined) delete process.env.ENABLE_DOMAIN_BLOCKLIST;
  else process.env.ENABLE_DOMAIN_BLOCKLIST = originalFlag;
});
beforeEach(() => {
  fake.reset();
  flag(false);
});

const call = (path: string, init: RequestInit & { role?: Role; json?: unknown } = {}) =>
  fetch(base + path, {
    ...init,
    body: init.json === undefined ? undefined : JSON.stringify(init.json),
    headers: {
      "Content-Type": "application/json",
      ...(init.role ? { Authorization: `Bearer ${token(init.role)}` } : {}),
    },
  });
const json = async (path: string, role: Role = "EDITOR") => (await call(path, { role })).json() as Promise<any>;
const SD = "/api/settings/sending-domains";
const audit = () => fake.T("sendingDomainAudit").map((r) => [r.action, r.detail, r.userEmail]);

describe("kill switch ENABLE_DOMAIN_BLOCKLIST=false: exactly as before", () => {
  it("GET says disabled; every change answers 404; nothing new is read or written", async () => {
    expect(await json(SD)).toEqual({ enabled: false });
    expect((await call(`${SD}/mode`, { method: "PUT", role: "ADMIN", json: { mode: "BLOCKLIST" } })).status).toBe(404);
    expect((await call(`${SD}/blocked`, { method: "POST", role: "ADMIN", json: { domain: "mailinator.com" } })).status).toBe(404);
    expect((await call(`${SD}/blocked/x`, { method: "DELETE", role: "ADMIN" })).status).toBe(404);
    expect(fake.T("setting")).toEqual([]);
    expect(fake.T("blockedSendingDomain")).toEqual([]);
    expect(fake.model("setting").findUnique).not.toHaveBeenCalled();
  });

  it("Approved-list changes work as before and are not audited", async () => {
    const res = await call("/api/settings/allowed-domains", { method: "POST", role: "ADMIN", json: { domain: "ok.com" } });
    expect(res.status).toBe(201);
    const { id } = (await res.json()) as { id: string };
    expect((await call(`/api/settings/allowed-domains/${id}`, { method: "DELETE", role: "ADMIN" })).status).toBe(204);
    expect(fake.T("sendingDomainAudit")).toEqual([]);
    expect(fake.model("sendingDomainAudit").create).not.toHaveBeenCalled();
  });

  it("manual add keeps the old message", async () => {
    fake.T("allowedDomain").push({ id: "a1", domain: "ok.com" });
    const res = await call("/api/contacts", { method: "POST", role: "EDITOR", json: { email: "a@other.com" } });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe("Email domain is not on the approved sending list: a@other.com");
  });
});

describe("flag on", () => {
  beforeEach(() => flag(true));

  it("requires sign-in", async () => {
    expect((await call(SD)).status).toBe(401);
  });

  it("starts in ALLOWLIST for existing installs; the change log is for admins only", async () => {
    expect(await json(SD, "ADMIN")).toEqual({ enabled: true, ready: true, mode: "ALLOWLIST", blocked: [], lastModeChange: null, history: [] });
    expect(await json(SD, "EDITOR")).toEqual({ enabled: true, ready: true, mode: "ALLOWLIST", blocked: [], lastModeChange: null });
  });

  it("is available with ENABLE_DOMAIN_BLOCKLIST unset: the toggle lives in the UI", async () => {
    delete process.env.ENABLE_DOMAIN_BLOCKLIST;
    expect(await json(SD, "ADMIN")).toMatchObject({ enabled: true, ready: true, mode: "ALLOWLIST" });
    expect((await call(`${SD}/mode`, { method: "PUT", role: "ADMIN", json: { mode: "BLOCKLIST" } })).status).toBe(200);
    expect((await json(SD)).mode).toBe("BLOCKLIST");
  });

  it("migration 0036 not applied: GET says not ready (no 500); a change answers 503 with what to run", async () => {
    const missing = () => Object.assign(new Error("The table `blocked_sending_domains` does not exist"), { code: "P2021" });
    fake.model("blockedSendingDomain").findMany.mockRejectedValueOnce(missing());
    const res = await call(SD, { role: "ADMIN" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ enabled: true, ready: false, mode: "ALLOWLIST", blocked: [], lastModeChange: null });

    fake.model("sendingDomainAudit").create.mockRejectedValueOnce(missing());
    const put = await call(`${SD}/mode`, { method: "PUT", role: "ADMIN", json: { mode: "BLOCKLIST" } });
    expect(put.status).toBe(503);
    expect(((await put.json()) as { error: string }).error).toContain("npm run prisma:deploy");
  });

  it("non-admins get 403 on every change, and nothing changes", async () => {
    fake.T("blockedSendingDomain").push({ id: "b1", domain: "mailinator.com" });
    expect((await call(`${SD}/mode`, { method: "PUT", role: "EDITOR", json: { mode: "BLOCKLIST" } })).status).toBe(403);
    expect((await call(`${SD}/blocked`, { method: "POST", role: "EDITOR", json: { domain: "tempmail.com" } })).status).toBe(403);
    expect((await call(`${SD}/blocked/b1`, { method: "DELETE", role: "EDITOR" })).status).toBe(403);
    expect(fake.T("setting")).toEqual([]);
    expect(fake.T("blockedSendingDomain").map((r) => r.domain)).toEqual(["mailinator.com"]);
    expect(fake.T("sendingDomainAudit")).toEqual([]);
  });

  it("admin switches the mode; who and when are logged; switching to the same mode logs nothing", async () => {
    const res = await call(`${SD}/mode`, { method: "PUT", role: "ADMIN", json: { mode: "BLOCKLIST" } });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ mode: "BLOCKLIST" });
    expect(fake.T("setting")).toEqual([expect.objectContaining({ key: "sendingDomainMode", value: "BLOCKLIST" })]);
    expect(fake.T("sendingDomainAudit")).toEqual([
      expect.objectContaining({ action: "MODE_CHANGED", detail: "BLOCKLIST", userId: "u-ADMIN", userEmail: "admin@test", createdAt: expect.any(Date) }),
    ]);

    const view = await json(SD, "EDITOR");
    expect(view.mode).toBe("BLOCKLIST");
    expect(view.lastModeChange).toMatchObject({ action: "MODE_CHANGED", detail: "BLOCKLIST", userEmail: "admin@test" });

    await call(`${SD}/mode`, { method: "PUT", role: "ADMIN", json: { mode: "BLOCKLIST" } });
    expect(fake.T("sendingDomainAudit")).toHaveLength(1);
    await call(`${SD}/mode`, { method: "PUT", role: "ADMIN", json: { mode: "ALLOWLIST" } });
    expect(audit()).toEqual([
      ["MODE_CHANGED", "BLOCKLIST", "admin@test"],
      ["MODE_CHANGED", "ALLOWLIST", "admin@test"],
    ]);
    expect((await json(SD)).lastModeChange.detail).toBe("ALLOWLIST");
  });

  it("rejects an unknown mode", async () => {
    expect((await call(`${SD}/mode`, { method: "PUT", role: "ADMIN", json: { mode: "OPEN" } })).status).toBe(400);
    expect(fake.T("setting")).toEqual([]);
  });

  it("admin blocks and unblocks domains: normalised, no duplicates, validated, logged", async () => {
    const res = await call(`${SD}/blocked`, { method: "POST", role: "ADMIN", json: { domain: " @MailInator.COM " } });
    expect(res.status).toBe(201);
    const item = (await res.json()) as { id: string; domain: string; createdBy: string };
    expect(item).toMatchObject({ domain: "mailinator.com", createdBy: "u-ADMIN" });

    expect((await call(`${SD}/blocked`, { method: "POST", role: "ADMIN", json: { domain: "mailinator.com" } })).status).toBe(409);
    expect((await call(`${SD}/blocked`, { method: "POST", role: "ADMIN", json: { domain: "not a domain" } })).status).toBe(400);
    expect((await json(SD)).blocked.map((d: { domain: string }) => d.domain)).toEqual(["mailinator.com"]);

    expect((await call(`${SD}/blocked/${item.id}`, { method: "DELETE", role: "ADMIN" })).status).toBe(204);
    expect((await call(`${SD}/blocked/${item.id}`, { method: "DELETE", role: "ADMIN" })).status).toBe(404);
    expect(audit()).toEqual([
      ["BLOCKED_ADDED", "mailinator.com", "admin@test"],
      ["BLOCKED_REMOVED", "mailinator.com", "admin@test"],
    ]);
  });

  it("Approved-list changes are logged while the flag is on, and the history is newest first", async () => {
    const res = await call("/api/settings/allowed-domains", { method: "POST", role: "ADMIN", json: { domain: "ok.com" } });
    const { id } = (await res.json()) as { id: string };
    await call(`/api/settings/allowed-domains/${id}`, { method: "DELETE", role: "ADMIN" });
    expect(audit()).toEqual([
      ["APPROVED_ADDED", "ok.com", "admin@test"],
      ["APPROVED_REMOVED", "ok.com", "admin@test"],
    ]);
    const history = (await json(SD, "ADMIN")).history as { action: string }[];
    expect(history.map((h) => h.action)).toEqual(["APPROVED_REMOVED", "APPROVED_ADDED"]);
  });

  it("an Approved-list change still succeeds if its log entry can't be written", async () => {
    fake.model("sendingDomainAudit").create.mockRejectedValueOnce(new Error("table missing"));
    const res = await call("/api/settings/allowed-domains", { method: "POST", role: "ADMIN", json: { domain: "ok.com" } });
    expect(res.status).toBe(201);
    expect(fake.T("allowedDomain").map((r) => r.domain)).toEqual(["ok.com"]);
  });

  it("manual add and edit follow the mode", async () => {
    fake.T("allowedDomain").push({ id: "a1", domain: "ok.com" });
    fake.T("blockedSendingDomain").push({ id: "b1", domain: "mailinator.com" });

    // ALLOWLIST (default): the old rule and message.
    const before = await call("/api/contacts", { method: "POST", role: "EDITOR", json: { email: "a@other.com" } });
    expect(before.status).toBe(400);
    expect(((await before.json()) as { error: string }).error).toBe("Email domain is not on the approved sending list: a@other.com");

    fake.T("setting").push({ key: "sendingDomainMode", value: "BLOCKLIST" });
    const ok = await call("/api/contacts", { method: "POST", role: "EDITOR", json: { email: "A@Other.com" } });
    expect(ok.status).toBe(201);
    const { id } = (await ok.json()) as { id: string };

    const blocked = await call("/api/contacts", { method: "POST", role: "EDITOR", json: { email: "x@eu.mailinator.com" } });
    expect(blocked.status).toBe(400);
    expect(((await blocked.json()) as { error: string }).error).toBe(
      "Email domain is on the blocked sending list: x@eu.mailinator.com",
    );
    const edit = await call(`/api/contacts/${id}`, { method: "PUT", role: "EDITOR", json: { email: "a@MAILINATOR.com" } });
    expect(edit.status).toBe(400);
    expect(fake.T("contact").map((c) => c.email)).toEqual(["a@other.com"]);
  });
});
