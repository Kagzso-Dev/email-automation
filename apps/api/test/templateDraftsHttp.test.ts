import { readdirSync, readFileSync, statSync } from "node:fs";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import jwt from "jsonwebtoken";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { drafts, fake, templateDraft } from "./fakePrismaDrafts.js";

// /api/template-drafts (ENABLE_TEMPLATE_DRAFTS, migration 0039). Flag off: 404 everywhere except GET /config, and the
// table is never touched. Flag on: ADMIN only (like creating a template); create-or-update with last write wins, the
// owner kept and the editor from the session; drafts not edited for 30 days are deleted. Before the migration: 503.
// A draft is never a template: the template lists don't show it and no other module reads the table.
// Prisma is an in-memory fake.

vi.mock("../src/prisma.js", async () => ({ prisma: (await import("./fakePrismaDrafts.js")).db }));

const originalFlag = process.env.ENABLE_TEMPLATE_DRAFTS;
const flag = (on: boolean | undefined) => {
  if (on === undefined) delete process.env.ENABLE_TEMPLATE_DRAFTS;
  else process.env.ENABLE_TEMPLATE_DRAFTS = on ? "true" : "false";
};

let server: Server;
let base = "";
type Who = "ADMIN" | "ADMIN2" | "EDITOR";
const USERS: Record<Who, { sub: string; email: string; role: "ADMIN" | "EDITOR" }> = {
  ADMIN: { sub: "u-admin", email: "admin@test", role: "ADMIN" },
  ADMIN2: { sub: "u-admin2", email: "admin2@test", role: "ADMIN" },
  EDITOR: { sub: "u-editor", email: "editor@test", role: "EDITOR" },
};
const auth = (who: Who | null): Record<string, string> =>
  who ? { Authorization: `Bearer ${jwt.sign(USERS[who], process.env.JWT_ACCESS_SECRET!)}` } : {};

beforeAll(async () => {
  const { createApp } = await import("../src/http/app.js");
  server = createApp().listen(0);
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  if (originalFlag === undefined) delete process.env.ENABLE_TEMPLATE_DRAFTS;
  else process.env.ENABLE_TEMPLATE_DRAFTS = originalFlag;
});
beforeEach(() => {
  fake.reset();
  drafts.reset();
  for (const fn of Object.values(templateDraft)) fn.mockClear();
  flag(true);
});
afterEach(() => vi.useRealTimers());

const D = "/api/template-drafts";
const ID = "0f8fad5b-d9cb-469f-a165-70867728950e";
const ID2 = "7c9e6679-7425-40de-944b-e07fc1f90ae7";
const get = (path: string, who: Who | null = "ADMIN") => fetch(base + path, { headers: auth(who) });
const del = (id: string, who: Who | null = "ADMIN") => fetch(`${base}${D}/${id}`, { method: "DELETE", headers: auth(who) });
const put = (id: string, body: unknown, who: Who | null = "ADMIN") =>
  fetch(`${base}${D}/${id}`, { method: "PUT", headers: { ...auth(who), "Content-Type": "application/json" }, body: JSON.stringify(body) });

const EMAIL_STATE = { name: "Welcome", kind: "LETTER", subject: "", bodyText: "Hi {{first_name}},", signature: "", textBody: "", links: [], meeting: {}, images: [], videos: [], variables: [] };
const WA_STATE = { displayName: "Company intro", name: "company_intro", nameTouched: false, language: "en", category: "MARKETING", headerType: "NONE", headerText: "", headerFileName: null, body: "Hi {{1}}, ", vars: [], footer: "", buttons: [] };
const DAY = 24 * 60 * 60 * 1000;
const row = (over: Record<string, unknown>) => ({
  id: ID,
  channel: "email",
  name: "Old",
  state: {},
  ownerId: "u-admin",
  ownerEmail: "admin@test",
  lastEditedById: "u-admin",
  lastEditedByEmail: "admin@test",
  createdAt: new Date(),
  updatedAt: new Date(),
  ...over,
});
const tableCalls = () => Object.values(templateDraft).reduce((n, fn) => n + fn.mock.calls.length, 0);

describe("flag off (default)", () => {
  it("GET /config says off; every other endpoint answers 404 and the table is never touched", async () => {
    for (const off of [false, undefined]) {
      flag(off);
      expect(await (await get(`${D}/config`)).json()).toEqual({ enabled: false });
      expect((await get(D)).status).toBe(404);
      expect((await get(`${D}?channel=email`)).status).toBe(404);
      expect((await get(`${D}/${ID}`)).status).toBe(404);
      expect((await put(ID, { channel: "email", name: "x", state: EMAIL_STATE })).status).toBe(404);
      expect((await del(ID)).status).toBe(404);
    }
    expect(tableCalls()).toBe(0);
    expect(drafts.rows).toEqual([]);
  });

  it("the hourly sweep deletes nothing while the flag is off", async () => {
    flag(false);
    drafts.rows.push(row({ updatedAt: new Date(Date.now() - 90 * DAY) }));
    vi.useFakeTimers();
    const { startTemplateDraftSweep } = await import("../src/domain/templateDrafts.js");
    const stop = startTemplateDraftSweep(1000);
    await vi.advanceTimersByTimeAsync(3000);
    stop();
    expect(drafts.rows).toHaveLength(1);
    expect(tableCalls()).toBe(0);
  });
});

describe("flag on: access", () => {
  it("GET /config says on, for any signed-in user", async () => {
    expect(await (await get(`${D}/config`, "EDITOR")).json()).toEqual({ enabled: true });
    expect((await get(`${D}/config`, null)).status).toBe(401);
  });

  it("needs sign-in; admins only (editors can't create templates, so no drafts)", async () => {
    expect((await get(D, null)).status).toBe(401);
    expect((await put(ID, { channel: "email", state: EMAIL_STATE }, null)).status).toBe(401);
    expect((await get(D, "EDITOR")).status).toBe(403);
    expect((await get(`${D}/${ID}`, "EDITOR")).status).toBe(403);
    expect((await put(ID, { channel: "email", state: EMAIL_STATE }, "EDITOR")).status).toBe(403);
    expect((await del(ID, "EDITOR")).status).toBe(403);
    expect(drafts.rows).toEqual([]);
    expect((await put(ID, { channel: "email", state: EMAIL_STATE }, "ADMIN")).status).toBe(200);
    expect((await get(D, "ADMIN2")).status).toBe(200);
  });
});

describe("flag on: saving", () => {
  it("PUT creates the draft; owner and editor come from the session, not the request", async () => {
    const res = await put(ID, { channel: "email", name: "  Welcome  ", state: EMAIL_STATE });
    expect(res.status).toBe(200);
    const saved = (await res.json()) as any;
    expect(saved).toMatchObject({ id: ID, channel: "email", name: "Welcome", ownerId: "u-admin", ownerEmail: "admin@test", lastEditedByEmail: "admin@test" });
    expect(saved.state).toBeUndefined();
    const full = (await (await get(`${D}/${ID}`)).json()) as any;
    expect(full.state).toEqual(EMAIL_STATE);
  });

  it("PUT again updates it (last write wins); the owner stays, the last editor changes", async () => {
    await put(ID, { channel: "email", name: "First", state: EMAIL_STATE });
    const before = drafts.rows[0].updatedAt as Date;
    await new Promise((r) => setTimeout(r, 5));
    const next = { ...EMAIL_STATE, name: "Second", subject: "Hello" };
    const res = await put(ID, { channel: "email", name: "Second", state: next }, "ADMIN2");
    expect(res.status).toBe(200);
    expect(drafts.rows).toHaveLength(1);
    expect(drafts.rows[0]).toMatchObject({ name: "Second", state: next, ownerEmail: "admin@test", lastEditedById: "u-admin2", lastEditedByEmail: "admin2@test" });
    expect((drafts.rows[0].updatedAt as Date).getTime()).toBeGreaterThan(before.getTime());
  });

  it("an incomplete form is fine (no template validation); a blank name is stored as untitled", async () => {
    const res = await put(ID, { channel: "whatsapp", name: "   ", state: { body: "", buttons: [{ type: "URL", text: "", url: "" }] } });
    expect(res.status).toBe(200);
    expect(drafts.rows[0].name).toBeNull();
  });

  it("rejects a bad id, an unknown channel, extra fields, a huge state, and moving a draft to the other page", async () => {
    expect((await put("bad id!", { channel: "email", state: EMAIL_STATE })).status).toBe(400);
    expect((await put("short", { channel: "email", state: EMAIL_STATE })).status).toBe(400);
    expect((await put(ID, { channel: "sms", state: EMAIL_STATE })).status).toBe(400);
    expect((await put(ID, { channel: "email", state: EMAIL_STATE, ownerEmail: "someone@else" })).status).toBe(400);
    expect((await put(ID, { channel: "email", state: "not an object" })).status).toBe(400);
    expect((await put(ID, { channel: "email", state: { bodyText: "x".repeat(300 * 1024) } })).status).toBe(400);
    expect(drafts.rows).toEqual([]);
    await put(ID, { channel: "email", state: EMAIL_STATE });
    expect((await put(ID, { channel: "whatsapp", state: WA_STATE })).status).toBe(409);
    expect(drafts.rows[0].channel).toBe("email");
  });
});

describe("flag on: list, get, delete", () => {
  it("lists newest first, by channel, without the form state, with the 30-day retention", async () => {
    drafts.rows.push(
      row({ id: "draft-email-old", channel: "email", name: "Older", updatedAt: new Date(Date.now() - 2 * DAY) }),
      row({ id: "draft-email-new", channel: "email", name: "Newer", updatedAt: new Date(Date.now() - 60_000), lastEditedByEmail: "admin2@test" }),
      row({ id: "draft-whatsapp", channel: "whatsapp", name: "Intro" }),
    );
    const email = (await (await get(`${D}?channel=email`)).json()) as any;
    expect(email.retentionDays).toBe(30);
    expect(email.items.map((d: any) => d.id)).toEqual(["draft-email-new", "draft-email-old"]);
    expect(email.items[0]).toMatchObject({ ownerEmail: "admin@test", lastEditedByEmail: "admin2@test" });
    expect(email.items[0].state).toBeUndefined();
    const wa = (await (await get(`${D}?channel=whatsapp`)).json()) as any;
    expect(wa.items.map((d: any) => d.id)).toEqual(["draft-whatsapp"]);
    expect(((await (await get(D)).json()) as any).items).toHaveLength(3);
    expect((await get(`${D}?channel=sms`)).status).toBe(400);
  });

  it("every admin sees the team's drafts and can delete one; a deleted draft is gone", async () => {
    await put(ID, { channel: "email", name: "Mine", state: EMAIL_STATE }, "ADMIN");
    const seen = (await (await get(`${D}?channel=email`, "ADMIN2")).json()) as any;
    expect(seen.items.map((d: any) => [d.name, d.ownerEmail])).toEqual([["Mine", "admin@test"]]);
    expect((await del(ID, "ADMIN2")).status).toBe(204);
    expect((await get(`${D}/${ID}`)).status).toBe(404);
    expect((await del(ID)).status).toBe(404);
  });

  it("before migration 0039: 503 saying what to run, never a 500", async () => {
    drafts.missing = true;
    for (const res of [await get(D), await get(`${D}/${ID}`), await put(ID, { channel: "email", state: EMAIL_STATE }), await del(ID)]) {
      expect(res.status).toBe(503);
      const body = (await res.json()) as any;
      expect(body.code).toBe("needs_migration");
      expect(body.error).toContain("0039");
    }
    expect(await (await get(`${D}/config`)).json()).toEqual({ enabled: true });
  });
});

describe("30-day purge", () => {
  it("deletes drafts not edited for 30 days; newer ones stay", async () => {
    const now = new Date("2026-11-18T10:00:00Z");
    drafts.rows.push(
      row({ id: "draft-31-days", updatedAt: new Date(now.getTime() - 31 * DAY) }),
      row({ id: "draft-29-days", updatedAt: new Date(now.getTime() - 29 * DAY) }),
      row({ id: "draft-today", updatedAt: now }),
    );
    const { purgeOldDrafts } = await import("../src/domain/templateDrafts.js");
    expect(await purgeOldDrafts(now)).toBe(1);
    expect(drafts.rows.map((r) => r.id)).toEqual(["draft-29-days", "draft-today"]);
  });

  it("the list purges before answering", async () => {
    drafts.rows.push(row({ id: "draft-stale", updatedAt: new Date(Date.now() - 45 * DAY) }), row({ id: "draft-fresh" }));
    const list = (await (await get(D)).json()) as any;
    expect(list.items.map((d: any) => d.id)).toEqual(["draft-fresh"]);
    expect(drafts.rows.map((r) => r.id)).toEqual(["draft-fresh"]);
  });

  it("the hourly sweep purges while the flag is on, and ignores a missing table", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-18T10:00:00Z"));
    drafts.rows.push(row({ id: "draft-stale", updatedAt: new Date(Date.now() - 31 * DAY) }), row({ id: "draft-fresh", updatedAt: new Date() }));
    const { startTemplateDraftSweep } = await import("../src/domain/templateDrafts.js");
    const stop = startTemplateDraftSweep(60 * 60 * 1000);
    await vi.advanceTimersByTimeAsync(59 * 60 * 1000);
    expect(drafts.rows).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(60 * 1000);
    expect(drafts.rows.map((r) => r.id)).toEqual(["draft-fresh"]);
    drafts.missing = true;
    await vi.advanceTimersByTimeAsync(60 * 60 * 1000); // no throw
    stop();
  });
});

describe("a draft is never a template", () => {
  it("saving drafts creates no template, and neither template list shows them", async () => {
    await put(ID, { channel: "email", name: "Draft email", state: EMAIL_STATE });
    await put(ID2, { channel: "whatsapp", name: "Draft intro", state: WA_STATE });
    expect(fake.T("template")).toEqual([]);
    expect(fake.T("whatsAppTemplate")).toEqual([]);
    expect(fake.model("template").create).not.toHaveBeenCalled();
    expect(fake.model("whatsAppTemplate").create).not.toHaveBeenCalled();

    fake.T("template").push({ id: "t1", name: "Real email", subject: "Hi", htmlBody: "<p>x</p>", variables: [], updatedAt: new Date() });
    fake.T("whatsAppTemplate").push({ id: "w1", name: "Real intro", providerTemplateName: "real_intro", languageCode: "en", body: "Hi", variables: [], buttonLabels: [], updatedAt: new Date() });
    const email = (await (await get("/api/templates")).json()) as any;
    expect(email.items.map((t: any) => t.id)).toEqual(["t1"]);
    const wa = await get("/api/whatsapp/templates");
    expect(wa.status).toBe(200);
    expect(((await wa.json()) as any).items.map((t: any) => t.id)).toEqual(["w1"]);
  });

  it("only the drafts modules read the template_drafts table: no send, queue, template or Meta code can", () => {
    const src = fileURLToPath(new URL("../src", import.meta.url));
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const p = join(dir, name);
        if (statSync(p).isDirectory()) walk(p);
        else if (/\.ts$/.test(name)) files.push(p);
      }
    };
    walk(src);
    const rel = (p: string) => relative(src, p).replace(/\\/g, "/");
    // Prisma access, or raw SQL against the table (comments naming it don't count).
    const usesTable = files
      .filter((f) => /prisma\.templateDraft\b|(FROM|INTO|UPDATE|JOIN)\s+`?template_drafts/i.test(readFileSync(f, "utf8")))
      .map(rel);
    expect(usesTable).toEqual(["domain/templateDrafts.ts"]);
    const importsDrafts = files.filter((f) => /from\s+["'][^"']*\/templateDrafts\.js["']/.test(readFileSync(f, "utf8"))).map(rel).sort();
    expect(importsDrafts).toEqual(["domain/templateDrafts.ts", "http/app.ts", "http/routes/templateDrafts.ts"]);
  });
});
