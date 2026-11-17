import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import jwt from "jsonwebtoken";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { fake, history } from "./fakePrismaPlus.js";

// /api/upload-history (ENABLE_IMPORT_FILTER_STEP, migration 0037). Flag off: 404 everywhere, nothing read or
// written. Flag on: ADMIN and EDITOR; the record holds what the step sent after the importer answered; the
// excluded rows are kept 30 days. Before the migration: 503, never a 500. Prisma is an in-memory fake.

vi.mock("../src/prisma.js", async () => ({ prisma: (await import("./fakePrismaPlus.js")).db }));

const originalFlag = process.env.ENABLE_IMPORT_FILTER_STEP;
const flag = (on: boolean) => {
  process.env.ENABLE_IMPORT_FILTER_STEP = on ? "true" : "false";
};

let server: Server;
let base = "";
type Role = "ADMIN" | "EDITOR";
const token = (role: Role) => jwt.sign({ sub: `u-${role}`, email: `${role.toLowerCase()}@test`, role }, process.env.JWT_ACCESS_SECRET!);
const auth = (role: Role | null): Record<string, string> => (role ? { Authorization: `Bearer ${token(role)}` } : {});

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
  history.reset();
  flag(true);
});
afterEach(() => vi.useRealTimers());

const H = "/api/upload-history";
const get = (path: string, role: Role | null = "EDITOR") => fetch(base + path, { headers: auth(role) });
const SUMMARY = {
  fileName: "Chennai Leads.xlsx",
  channel: "whatsapp",
  language: null,
  totalRows: 10,
  imported: 4,
  excludedUsed: 3,
  filteredOut: 1,
  duplicates: 1,
  failed: 1,
  skippedOverLimit: 0,
  excludedRows: 3,
  filters: { filters: { phoneType: ["mobile"] }, languages: ["ta", "en", "indic", "unknown"], exclude: ["contacts", "sent", "called"] },
  result: { created: 3, updated: 1, duplicates: 1, failed: 0 },
};
const EXCLUDED_CSV = "phone,first name,Excluded because\r\n9876500004,Ravi,Already sent 12 Nov 2026\r\n";
function post(summary: Record<string, unknown> = SUMMARY, csv: string | null = EXCLUDED_CSV, role: Role | null = "EDITOR") {
  const fd = new FormData();
  fd.append("summary", JSON.stringify(summary));
  if (csv !== null) fd.append("excluded", new Blob([csv], { type: "text/csv" }), "excluded.csv");
  return fetch(base + H, { method: "POST", body: fd, headers: auth(role) });
}

describe("flag off (default)", () => {
  it("every endpoint answers 404; nothing is read or written", async () => {
    flag(false);
    expect((await get(H)).status).toBe(404);
    expect((await get(`${H}/uh-1`)).status).toBe(404);
    expect((await get(`${H}/uh-1/excluded`)).status).toBe(404);
    expect((await post()).status).toBe(404);
    expect(history.rows).toEqual([]);
  });
});

describe("flag on", () => {
  it("needs sign-in; admins and editors both can use it", async () => {
    expect((await get(H, null)).status).toBe(401);
    expect((await post(SUMMARY, EXCLUDED_CSV, null)).status).toBe(401);
    expect((await post(SUMMARY, EXCLUDED_CSV, "EDITOR")).status).toBe(201);
    expect((await post(SUMMARY, EXCLUDED_CSV, "ADMIN")).status).toBe(201);
    expect((await get(H, "EDITOR")).status).toBe(200);
  });

  it("stores the counts and filters; who and when come from the session, not the request", async () => {
    const res = await post();
    expect(res.status).toBe(201);
    const row = (await res.json()) as any;
    expect(row).toMatchObject({ ...SUMMARY, uploadedByEmail: "editor@test", uploadedById: "u-EDITOR", excludedAvailable: true });
    expect(row.excludedCsv).toBeUndefined(); // never sent back in the summary
    const stored = history.rows[0]!;
    expect(stored.excludedCsv).toBe(EXCLUDED_CSV);
    expect(stored.excludedExpiresAt.getTime() - stored.createdAt.getTime()).toBe(30 * 24 * 60 * 60 * 1000);

    // A forged uploader is refused, not stored.
    expect((await post({ ...SUMMARY, uploadedByEmail: "someone@else" })).status).toBe(400);
    expect(history.rows).toHaveLength(1);
  });

  it("refuses a summary that isn't JSON or has wrong counts", async () => {
    const fd = new FormData();
    fd.append("summary", "not json");
    expect((await fetch(base + H, { method: "POST", body: fd, headers: auth("EDITOR") })).status).toBe(400);
    expect((await post({ ...SUMMARY, imported: -1 })).status).toBe(400);
    expect((await post({ ...SUMMARY, channel: "email" })).status).toBe(400);
    expect(history.rows).toEqual([]);
  });

  it("list: newest first, paginated, searchable by file name", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    for (const [i, name] of ["Chennai Leads.xlsx", "Madurai.csv", "chennai-2.csv"].entries()) {
      vi.setSystemTime(new Date(Date.UTC(2026, 10, 10 + i, 9)));
      expect((await post({ ...SUMMARY, fileName: name })).status).toBe(201);
    }
    const all = (await (await get(`${H}?pageSize=2`)).json()) as any;
    expect(all.total).toBe(3);
    expect(all.items.map((r: any) => r.fileName)).toEqual(["chennai-2.csv", "Madurai.csv"]);
    expect(all.items[0].excludedCsv).toBeUndefined();
    const page2 = (await (await get(`${H}?pageSize=2&page=2`)).json()) as any;
    expect(page2.items.map((r: any) => r.fileName)).toEqual(["Chennai Leads.xlsx"]);
    const found = (await (await get(`${H}?search=CHENNAI`)).json()) as any;
    expect(found.items.map((r: any) => r.fileName)).toEqual(["chennai-2.csv", "Chennai Leads.xlsx"]);
  });

  it("detail and the excluded rows download", async () => {
    const { id } = (await (await post()).json()) as any;
    expect(await (await get(`${H}/${id}`)).json()).toMatchObject({ id, filters: SUMMARY.filters, excludedAvailable: true });
    const csv = await get(`${H}/${id}/excluded`);
    expect(csv.status).toBe(200);
    expect(csv.headers.get("content-disposition")).toBe('attachment; filename="Chennai Leads-excluded.csv"');
    // Raw bytes: a UTF-8 BOM (so Excel opens Tamil text correctly), then the stored CSV.
    const bytes = Buffer.from(await csv.arrayBuffer());
    expect([...bytes.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    expect(bytes.subarray(3).toString("utf8")).toBe(EXCLUDED_CSV);
    expect((await get(`${H}/nope`)).status).toBe(404);
  });

  it("nothing excluded: no file is kept", async () => {
    const { id } = (await (await post({ ...SUMMARY, excludedUsed: 0, excludedRows: 0 }, null)).json()) as any;
    expect(history.rows[0]!.excludedCsv).toBeNull();
    expect((await get(`${H}/${id}`)).status).toBe(200);
    expect((await get(`${H}/${id}/excluded`)).status).toBe(404);
  });

  it("after 30 days the excluded rows are deleted (on read); the counts and filters stay", async () => {
    const { id } = (await (await post()).json()) as any;
    history.rows[0]!.excludedExpiresAt = new Date(Date.now() - 1000);
    const res = await get(`${H}/${id}/excluded`);
    expect(res.status).toBe(410);
    expect(((await res.json()) as any).error).toBe("The excluded rows were deleted after 30 days.");
    expect(history.rows[0]).toMatchObject({ excludedCsv: null, imported: 4, excludedUsed: 3 });
    expect(history.rows[0]!.excludedPurgedAt).toBeInstanceOf(Date);
    expect(await (await get(`${H}/${id}`)).json()).toMatchObject({ excludedAvailable: false, imported: 4, filters: SUMMARY.filters });
  });

  it("the hourly sweep deletes expired files without any request", async () => {
    const { purgeExpiredExcluded, startUploadHistorySweep } = await import("../src/domain/uploadHistory.js");
    await post();
    await post();
    history.rows[0]!.excludedExpiresAt = new Date(Date.now() - 1000); // only the first has expired
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const stop = startUploadHistorySweep(60 * 60 * 1000);
    await vi.advanceTimersByTimeAsync(60 * 60 * 1000);
    stop();
    expect(history.rows.map((r) => r.excludedCsv === null)).toEqual([true, false]);
    expect(await purgeExpiredExcluded(new Date(Date.now() + 31 * 24 * 60 * 60 * 1000))).toBe(1); // the second, a month on
  });

  it("before migration 0037: 503 saying what to run (never a 500); the sweep stays quiet", async () => {
    history.missing = true;
    const list = await get(H);
    expect(list.status).toBe(503);
    expect(((await list.json()) as any).error).toContain("migration 0037");
    expect((await post()).status).toBe(503);
    const { startUploadHistorySweep } = await import("../src/domain/uploadHistory.js");
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const stop = startUploadHistorySweep(1000);
    await vi.advanceTimersByTimeAsync(1000); // no throw
    stop();
  });

  it("an import does not depend on it: WhatsApp import works with history unavailable", async () => {
    history.missing = true;
    const fd = new FormData();
    fd.append("file", new Blob(["phone,first name\n9876500101,Ravi\n"], { type: "text/csv" }), "c.csv");
    const res = await fetch(`${base}/api/whatsapp/contacts/import`, { method: "POST", body: fd, headers: auth("EDITOR") });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ created: 1 });
  });
});
