import { existsSync } from "node:fs";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import jwt from "jsonwebtoken";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { fake } from "./fakePrisma.js";

// /api/import-filter (ENABLE_IMPORT_FILTER_STEP). Flag off: only GET /config answers ({ enabled: false }),
// everything else 404, and the existing importers work as before. Flag on: the checks read only — nothing
// is saved before the page's own importer is called with the chosen rows. Prisma is an in-memory fake.

vi.mock("../src/prisma.js", async () => ({ prisma: (await import("./fakePrisma.js")).fake.db }));
const removed = vi.hoisted(() => [] as string[]);
vi.mock("../src/http/importUpload.js", async (orig) => {
  const real = await orig<typeof import("../src/http/importUpload.js")>();
  return {
    ...real,
    removeUpload: async (file: Express.Multer.File | undefined) => {
      await real.removeUpload(file);
      if (file?.path) removed.push(file.path);
    },
  };
});

process.env.ENABLE_AI_CALLS = "true"; // read once when config/aiCalls.ts loads (the Voicecall check needs it)
const originalFlag = process.env.ENABLE_IMPORT_FILTER_STEP;
const flag = (on: boolean) => {
  process.env.ENABLE_IMPORT_FILTER_STEP = on ? "true" : "false";
};

let server: Server;
let base = "";
type Role = "ADMIN" | "EDITOR";
const token = (role: Role) => jwt.sign({ sub: `u-${role}`, email: `${role.toLowerCase()}@test`, role }, process.env.JWT_ACCESS_SECRET!);

beforeAll(async () => {
  const { createApp } = await import("../src/http/app.js");
  server = createApp().listen(0);
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  if (originalFlag === undefined) delete process.env.ENABLE_IMPORT_FILTER_STEP;
  else process.env.ENABLE_IMPORT_FILTER_STEP = originalFlag;
});
beforeEach(() => {
  fake.reset();
  removed.length = 0;
  flag(false);
});

const auth = (role?: Role): Record<string, string> => (role ? { Authorization: `Bearer ${token(role)}` } : {});
// role null = not signed in.
const upload = (path: string, csv: string, filename = "contacts.csv", role: Role | null = "EDITOR") => {
  const fd = new FormData();
  fd.append("file", new Blob([csv], { type: "text/csv" }), filename);
  return fetch(base + path, { method: "POST", body: fd, headers: auth(role ?? undefined) });
};
const post = (path: string, json: unknown, role: Role | null = "EDITOR") =>
  fetch(base + path, { method: "POST", body: JSON.stringify(json), headers: { "Content-Type": "application/json", ...auth(role ?? undefined) } });

const MODELS = ["contact", "whatsAppContact", "aiCallLog", "aiCallCustomer", "dataQualityJob", "dataQualityRecord"];
const WRITES = ["create", "upsert", "update", "delete", "deleteMany"] as const;
const writes = () => MODELS.flatMap((m) => WRITES.filter((w) => fake.model(m)[w].mock.calls.length > 0).map((w) => `${m}.${w}`));

const CSV = [
  "phone,first name,last name,business name,city",
  "9876500101,Ravi,Kumar,Ravi Traders,Chennai", //       mobile
  "9876500102,Priya,,\"Priya Boutique, T Nagar\",Chennai", // mobile, a comma in the business name
  "044 2345 6789,Chennai,Office,Acme,Chennai", //        landline: WhatsApp can't use it
  "9876500104,Anitha,,Anitha Beauty Parlour,Madurai", // already saved
].join("\n");

describe("flag off (default): exactly as before", () => {
  it("GET /config says off; the other endpoints answer 404 and touch nothing", async () => {
    expect(await (await fetch(`${base}/api/import-filter/config`, { headers: auth("EDITOR") })).json()).toEqual({ enabled: false, maxRows: 1000 });
    expect((await upload("/api/import-filter/whatsapp/preview", CSV)).status).toBe(404);
    expect((await post("/api/import-filter/voicecall/check", { rows: [{ phone: "9876500101" }] })).status).toBe(404);
    expect(writes()).toEqual([]);
    expect(fake.model("whatsAppContact").findMany).not.toHaveBeenCalled();
  });

  it("WhatsApp Contacts → Import file still imports the whole file at once", async () => {
    const res = await upload("/api/whatsapp/contacts/import", CSV);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ created: 3, updated: 0, duplicates: 0, failed: 1 });
  });
});

describe("flag on", () => {
  beforeEach(() => flag(true));

  it("needs sign-in", async () => {
    expect((await fetch(`${base}/api/import-filter/config`)).status).toBe(401);
    expect((await upload("/api/import-filter/whatsapp/preview", CSV, "contacts.csv", null)).status).toBe(401);
    expect((await post("/api/import-filter/voicecall/check", { rows: [{ phone: "9876500101" }] }, null)).status).toBe(401);
  });

  it("WhatsApp preview: the rows and their checks; nothing saved, the uploaded file removed", async () => {
    fake.T("whatsAppContact").push({ id: "w1", phone: "919876500104", firstName: "Old", status: "ACTIVE" });
    const res = await upload("/api/import-filter/whatsapp/preview", CSV);
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body).toMatchObject({ filename: "contacts.csv", headers: ["phone", "first name", "last name", "business name", "city"], totalRows: 4, maxRows: 1000 });
    expect(body.rows[1]).toEqual({ phone: "9876500102", "first name": "Priya", "last name": "", "business name": "Priya Boutique, T Nagar", city: "Chennai" });
    expect(body.checks.map((c: any) => [c.phoneType, c.importable, c.alreadySaved])).toEqual([
      ["mobile", true, false],
      ["mobile", true, false],
      ["landline", false, false],
      ["mobile", true, true],
    ]);
    expect(writes()).toEqual([]);
    expect(fake.T("whatsAppContact")).toEqual([{ id: "w1", phone: "919876500104", firstName: "Old", status: "ACTIVE" }]);
    expect(removed).toHaveLength(1);
    expect(existsSync(removed[0]!)).toBe(false);
  });

  it("editors can use it, like the importers", async () => {
    expect((await upload("/api/import-filter/whatsapp/preview", CSV, "c.csv", "EDITOR")).status).toBe(200);
    expect((await upload("/api/import-filter/whatsapp/preview", CSV, "c.csv", "ADMIN")).status).toBe(200);
  });

  it("refuses an unsupported file, as the importer does", async () => {
    const res = await upload("/api/import-filter/whatsapp/preview", "x", "contacts.pdf");
    expect(res.status).toBe(400);
    expect(removed).toHaveLength(1);
  });

  it("only the chosen rows reach the unchanged WhatsApp importer; it still updates a saved number", async () => {
    fake.T("whatsAppContact").push({ id: "w1", phone: "919876500104", firstName: "Old", status: "ACTIVE" });
    const preview = (await (await upload("/api/import-filter/whatsapp/preview", CSV)).json()) as any;
    // The browser keeps rows 0 and 3 (row 1 filtered out, row 2 not importable) and sends them as a CSV.
    const cell = (v: string) => (/[",\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
    const chosen = [preview.rows[0], preview.rows[3]];
    const csv = [preview.headers.map(cell).join(","), ...chosen.map((r: any) => preview.headers.map((h: string) => cell(r[h])).join(","))].join("\r\n") + "\r\n";
    expect(writes()).toEqual([]); // nothing before the final confirm

    const res = await upload("/api/whatsapp/contacts/import", csv, "contacts-selected.csv");
    expect(await res.json()).toMatchObject({ totalRows: 2, created: 1, updated: 1, duplicates: 0, failed: 0 });
    expect(fake.T("whatsAppContact").map((c) => [c.phone, c.firstName])).toEqual([
      ["919876500104", "Anitha"],
      ["919876500101", "Ravi"],
    ]);
  });

  it("Voicecall check: the rows' checks, nothing saved; long cells are cut, not refused", async () => {
    fake.T("aiCallCustomer").push({ phone: "+919876500105", activePhone: "+919876500105", doNotCall: true, stage: "NOT_CALLED" });
    const res = await post("/api/import-filter/voicecall/check", {
      rows: [
        { name: "Ravi Kumar", phone: "9876500101", business: "Ravi Traders", email: null },
        { name: "Chennai Office", phone: "044 2345 6789", business: "x".repeat(900), email: "" },
        { name: "Dinesh", phone: "9876500105", business: "Dinesh Hardware" },
      ],
    });
    expect(res.status).toBe(200);
    const { checks } = (await res.json()) as any;
    expect(checks.map((c: any) => [c.status, c.phoneType])).toEqual([
      ["VALID", "mobile"],
      ["VALID", "landline"],
      ["EXCLUDED", "mobile"],
    ]);
    expect(checks[2].excludedReason).toBe("do_not_call");
    expect(writes()).toEqual([]);
  });

  it("Voicecall check refuses more rows than one import takes", async () => {
    const rows = Array.from({ length: 1001 }, (_, i) => ({ phone: `98765${String(i).padStart(5, "0")}` }));
    expect((await post("/api/import-filter/voicecall/check", { rows })).status).toBe(400);
  });
});
