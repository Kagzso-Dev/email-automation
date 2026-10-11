import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import ExcelJS from "exceljs";
import jwt from "jsonwebtoken";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  classifyRows,
  detectHistoryColumn,
  historyKey,
  readHistoryFile,
  uniqueKeys,
  writeHistoryFile,
  type HistoryMap,
} from "../src/domain/historyFilter.js";

// Send Queue "filter new data": parsing, normalising, de-duplicating and
// classifying against a given history, plus the HTTP gates (rejected before any
// database access, so no MySQL is needed).

const entry = (used: boolean, failed: boolean, ...statuses: string[]) => ({ used, failed, statuses: new Set(statuses) });

describe("historyKey", () => {
  it("normalises emails", () => {
    expect(historyKey("email", "  Ada@Example.COM ")).toBe("ada@example.com");
    expect(historyKey("email", "not-an-email")).toBeNull();
    expect(historyKey("email", "")).toBeNull();
  });

  it("matches every Indian phone format to one number", () => {
    for (const raw of ["98765 43210", "09876543210", "+919876543210", "+91 (98765)-43210", "919876543210", "0091 98765 43210"]) {
      expect(historyKey("whatsapp", raw)).toBe("+919876543210");
      expect(historyKey("ai-call", raw)).toBe("+919876543210");
    }
  });

  it("rejects unusable numbers", () => {
    expect(historyKey("whatsapp", "12345")).toBeNull();
    expect(historyKey("whatsapp", "+91 1234567890")).toBeNull(); // Indian non-mobile can't be on WhatsApp
    expect(historyKey("ai-call", "abc")).toBeNull();
  });
});

const CSV = [
  "Name,Mobile,City",
  "New One,98765 43210,Chennai",
  "Sent Before,+91 91234 56789,Madurai",
  "Failed Before,09988776655,Salem",
  "Dup Of New,+919876543210,Chennai",
  "Bad Number,12345,Erode",
  'Quoted "Name",8899001122,"Trichy, TN"',
].join("\r\n");

const HISTORY: HistoryMap = new Map([
  ["+919123456789", entry(true, false, "DELIVERED")],
  ["+919988776655", entry(false, true, "FAILED")],
]);

describe("csv flow", () => {
  it("detects the phone column, dedupes, and classifies against history", async () => {
    const grid = await readHistoryFile(Buffer.from(CSV), "csv");
    expect(grid.headers).toEqual(["Name", "Mobile", "City"]);
    const guess = detectHistoryColumn(grid, "whatsapp");
    expect(guess).toMatchObject({ column: 1, ambiguous: false });

    expect(uniqueKeys(grid, 1, "whatsapp").sort()).toEqual(["+918899001122", "+919123456789", "+919876543210", "+919988776655"]);
    const c = classifyRows(grid, 1, "whatsapp", HISTORY);
    expect(c.verdicts).toEqual(["new", "used", "new", "duplicate", "invalid", "new"]);
    expect(c.summary).toEqual({ total: 6, invalid: 1, duplicates: 1, alreadyUsed: 1, newCount: 3, failed: 1, truncated: false });
    expect(c.previous[1]).toBe("DELIVERED");
  });

  it("writes the new-only rows with the original columns and quoting", async () => {
    const grid = await readHistoryFile(Buffer.from(CSV), "csv");
    const c = classifyRows(grid, 1, "whatsapp", HISTORY);
    const out = await writeHistoryFile(grid, "csv", c.verdicts.flatMap((v, i) => (v === "new" ? [i] : [])));
    const text = out.toString("utf8").replace(/^﻿/, "");
    expect(text.split("\r\n")).toEqual([
      "Name,Mobile,City",
      "New One,98765 43210,Chennai",
      "Failed Before,09988776655,Salem",
      '"Quoted ""Name""",8899001122,"Trichy, TN"',
    ]);
  });

  it("adds a previous-status column to the already-used report", async () => {
    const grid = await readHistoryFile(Buffer.from(CSV), "csv");
    const c = classifyRows(grid, 1, "whatsapp", HISTORY);
    const out = await writeHistoryFile(grid, "csv", [1], { header: "Previous status", values: c.previous });
    expect(out.toString("utf8").replace(/^﻿/, "").split("\r\n")).toEqual([
      "Name,Mobile,City,Previous status",
      "Sent Before,+91 91234 56789,Madurai,DELIVERED",
    ]);
  });
});

describe("email", () => {
  it("compares case-insensitively and flags an ambiguous pick", async () => {
    const csv = "Email,Backup email\nA@x.com,b@x.com\na@x.com ,c@x.com\nnew@x.com,d@x.com\n";
    const grid = await readHistoryFile(Buffer.from(csv), "csv");
    const guess = detectHistoryColumn(grid, "email");
    expect(guess.column).not.toBeNull();
    expect(guess.ambiguous).toBe(true); // two email-looking columns → ask
    const c = classifyRows(grid, 0, "email", new Map([["a@x.com", entry(true, false, "SENT")]]));
    expect(c.verdicts).toEqual(["used", "duplicate", "new"]);
  });

  it("falls back to content when no header looks right", async () => {
    const grid = await readHistoryFile(Buffer.from("Col A,Col B\nfoo,ada@x.com\nbar,bob@x.com\n"), "csv");
    expect(detectHistoryColumn(grid, "email")).toMatchObject({ column: 1, ambiguous: true });
  });
});

describe("xlsx flow", () => {
  async function xlsx(rows: unknown[][]) {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet("Leads");
    rows.forEach((r) => ws.addRow(r));
    ws.getColumn(2).width = 22;
    return Buffer.from(await wb.xlsx.writeBuffer());
  }

  it("reads numeric phones without scientific notation and writes an xlsx back", async () => {
    const buf = await xlsx([
      ["Customer", "Phone", "Amount"],
      ["Asha", 9876543210, 1200],
      ["Ravi", "+91 91234 56789", 300],
      ["Asha again", "098765-43210", 50],
    ]);
    const grid = await readHistoryFile(buf, "xlsx");
    expect(grid.rows[0]!.text).toEqual(["Asha", "9876543210", "1200"]);
    const c = classifyRows(grid, 1, "ai-call", HISTORY);
    expect(c.verdicts).toEqual(["new", "used", "duplicate"]);

    const out = await writeHistoryFile(grid, "xlsx", [0]);
    const back = new ExcelJS.Workbook();
    await (back.xlsx.load as unknown as (d: Uint8Array) => Promise<unknown>)(out);
    const ws = back.worksheets[0]!;
    expect(ws.name).toBe("Leads");
    expect(ws.getRow(1).values).toEqual([undefined, "Customer", "Phone", "Amount"]);
    expect(ws.getRow(2).values).toEqual([undefined, "Asha", 9876543210, 1200]); // original cell types kept
    expect(ws.rowCount).toBe(2);
    expect(ws.getColumn(2).width).toBe(22);
  });
});

/* -------------------------------------------------------------------- HTTP gates */

let server: Server;
let base = "";
const token = (role: "ADMIN" | "EDITOR") =>
  jwt.sign({ sub: `u-${role}`, email: `${role.toLowerCase()}@test`, role }, process.env.JWT_ACCESS_SECRET!);
const post = (path: string, role?: "ADMIN" | "EDITOR", body?: FormData) =>
  fetch(base + path, { method: "POST", body, headers: role ? { Authorization: `Bearer ${token(role)}` } : {} });

beforeAll(async () => {
  process.env.ENABLE_AI_CALLS = "true";
  const { createApp } = await import("../src/http/app.js");
  server = createApp().listen(0);
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

describe("POST /api/send-queue/filter/:channel/*", () => {
  it("requires sign-in", async () => {
    expect((await post("/api/send-queue/filter/email/analyze")).status).toBe(401);
  });

  it("rejects unknown channels", async () => {
    expect((await post("/api/send-queue/filter/sms/analyze", "ADMIN")).status).toBe(404);
  });

  it("keeps AI-call history admin-only", async () => {
    expect((await post("/api/send-queue/filter/ai-call/analyze", "EDITOR")).status).toBe(403);
  });

  it("returns 404 for AI calls while they are disabled", async () => {
    const { aiCallsConfig } = await import("../src/config/aiCalls.js");
    const cfg = aiCallsConfig as { enabled: boolean }; // read-only in app code; flipped here for the test only
    const was = cfg.enabled;
    cfg.enabled = false;
    try {
      expect((await post("/api/send-queue/filter/ai-call/analyze", "ADMIN")).status).toBe(404);
    } finally {
      cfg.enabled = was;
    }
  });

  it("needs a csv or xlsx file", async () => {
    expect((await post("/api/send-queue/filter/email/analyze", "EDITOR", new FormData())).status).toBe(400);
    const fd = new FormData();
    fd.append("file", new Blob(["hello"]), "notes.txt");
    expect((await post("/api/send-queue/filter/whatsapp/analyze", "EDITOR", fd)).status).toBe(400);
  });

  it("validates the download part before touching history", async () => {
    const fd = new FormData();
    fd.append("file", new Blob([CSV]), "leads.csv");
    fd.append("column", "1");
    fd.append("part", "everything");
    expect((await post("/api/send-queue/filter/whatsapp/download", "EDITOR", fd)).status).toBe(400);
  });

  it("rejects a column outside the file", async () => {
    const fd = new FormData();
    fd.append("file", new Blob([CSV]), "leads.csv");
    fd.append("column", "9");
    expect((await post("/api/send-queue/filter/email/analyze", "EDITOR", fd)).status).toBe(400);
  });
});
