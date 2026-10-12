// "Filter new data" for the Send Queue page: compare an uploaded csv / xlsx file
// against ONE channel's send history and hand back only the entries that were
// never used. Strictly read-only — it reads email / WhatsApp / AI-call history
// and writes nothing. Channels never mix: email rows are only compared with
// email history, WhatsApp with WhatsApp, AI calls with AI calls.

import { parse as parseCsv } from "csv-parse/sync";
import ExcelJS from "exceljs";
import { normalizePhoneE164, toWhatsAppDigits } from "@dispatch/shared";
import { prisma } from "../prisma.js";
import { csvCell } from "./csv.js";

export type HistoryChannel = "email" | "whatsapp" | "ai-call";
export const HISTORY_CHANNELS: HistoryChannel[] = ["email", "whatsapp", "ai-call"];

export type HistoryFileFormat = "csv" | "xlsx";

/** Hard ceiling so a huge upload can't exhaust memory; the summary says when it was hit. */
export const HISTORY_FILTER_MAX_ROWS = 100_000;

export function historyFormatFromFilename(filename: string): HistoryFileFormat | null {
  const ext = filename.toLowerCase().split(".").pop();
  if (ext === "csv") return "csv";
  if (ext === "xlsx") return "xlsx";
  return null;
}

/* ------------------------------------------------------------------ reading the file */

/**
 * The file as a grid, column order preserved. `text` is what we compare;
 * `values` (xlsx only) are the original cell values, written back unchanged.
 */
export interface Grid {
  headers: string[];
  rows: { text: string[]; values?: ExcelJS.CellValue[] }[];
  truncated: boolean;
  sheetName?: string;
  columnWidths?: (number | undefined)[];
}

/** ExcelJS cell values can be strings, numbers, dates, or rich objects. */
function cellText(v: ExcelJS.CellValue): string {
  if (v == null) return "";
  if (typeof v === "string" || typeof v === "boolean") return String(v);
  // Long numbers (phones) must not turn into 9.87654321E9.
  if (typeof v === "number") return Number.isInteger(v) ? v.toFixed(0) : String(v);
  if (v instanceof Date) return v.toISOString();
  if (typeof v === "object") {
    if ("text" in v && v.text != null) return String(v.text);
    if ("result" in v && v.result != null) return String(v.result);
    if ("richText" in v && Array.isArray(v.richText)) return v.richText.map((r) => r.text).join("");
  }
  return "";
}

async function readXlsx(buf: Buffer): Promise<Grid> {
  const wb = new ExcelJS.Workbook();
  await (wb.xlsx.load as unknown as (data: Uint8Array) => Promise<unknown>)(buf);
  const ws = wb.worksheets[0];
  if (!ws) return { headers: [], rows: [], truncated: false };

  const headerRow = ws.getRow(1);
  const width = headerRow.cellCount;
  const headers = Array.from({ length: width }, (_, i) => cellText(headerRow.getCell(i + 1).value).trim());
  const rows: Grid["rows"] = [];
  let truncated = false;
  for (let r = 2; r <= ws.rowCount; r++) {
    const row = ws.getRow(r);
    const values = Array.from({ length: width }, (_, i) => row.getCell(i + 1).value);
    const text = values.map((v) => cellText(v).trim());
    if (text.every((t) => t === "")) continue;
    if (rows.length >= HISTORY_FILTER_MAX_ROWS) {
      truncated = true;
      break;
    }
    rows.push({ text, values });
  }
  return {
    headers,
    rows,
    truncated,
    sheetName: ws.name,
    columnWidths: Array.from({ length: width }, (_, i) => ws.getColumn(i + 1).width),
  };
}

function readCsv(buf: Buffer): Grid {
  const records = parseCsv(buf.toString("utf8").replace(/^﻿/, ""), {
    columns: false,
    skip_empty_lines: true,
    relax_column_count: true,
    relax_quotes: true,
  }) as string[][];
  const headers = (records[0] ?? []).map((h) => String(h).trim());
  const rows: Grid["rows"] = [];
  let truncated = false;
  for (const rec of records.slice(1)) {
    // Keep the original cell text (written back as-is); pad short rows to the header width.
    const text = headers.map((_, i) => String(rec[i] ?? ""));
    if (text.every((t) => t.trim() === "")) continue;
    if (rows.length >= HISTORY_FILTER_MAX_ROWS) {
      truncated = true;
      break;
    }
    rows.push({ text });
  }
  return { headers, rows, truncated };
}

export async function readHistoryFile(buf: Buffer, format: HistoryFileFormat): Promise<Grid> {
  return format === "csv" ? readCsv(buf) : readXlsx(buf);
}

/* ------------------------------------------------------------------ normalising */

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * The comparison key for one cell, or null when the value can't be used.
 * Email: trimmed + lowercased. WhatsApp / AI call: E.164 with the channel's
 * default country code (91 unless configured), so "98765 43210", "09876543210"
 * and "+919876543210" are the same number.
 */
export function historyKey(channel: HistoryChannel, raw: string, defaultCountryCode = "91"): string | null {
  const s = String(raw ?? "").trim();
  if (!s) return null;
  if (channel === "email") {
    const e = s.toLowerCase();
    return EMAIL_RE.test(e) ? e : null;
  }
  if (channel === "whatsapp") {
    const digits = toWhatsAppDigits(s, defaultCountryCode);
    return digits ? `+${digits}` : null;
  }
  return normalizePhoneE164(s, defaultCountryCode);
}

/* ------------------------------------------------------------------ column detection */

const HEADER_HINTS: Record<HistoryChannel, RegExp> = {
  email: /e-?mail/i,
  whatsapp: /phone|mobile|whats ?app|number|contact|cell|msisdn|\bwa\b/i,
  "ai-call": /phone|mobile|number|contact|cell|msisdn/i,
};

export interface ColumnGuess {
  /** Index into `headers`, or null when nothing looks usable. */
  column: number | null;
  /** True when the user should confirm (several candidates, or picked by content only). */
  ambiguous: boolean;
  /** Columns worth offering first in the picker (header match or mostly-valid content). */
  candidates: number[];
}

export function detectHistoryColumn(grid: Grid, channel: HistoryChannel, defaultCountryCode = "91"): ColumnGuess {
  const sample = grid.rows.slice(0, 200);
  const validRatio = (col: number) => {
    const filled = sample.filter((r) => (r.text[col] ?? "").trim() !== "");
    if (filled.length === 0) return 0;
    return filled.filter((r) => historyKey(channel, r.text[col] ?? "", defaultCountryCode)).length / filled.length;
  };
  const cols = grid.headers.map((_, i) => i);
  const ratios = new Map(cols.map((i) => [i, validRatio(i)]));
  const byHeader = cols.filter((i) => HEADER_HINTS[channel].test(grid.headers[i] ?? ""));
  const byContent = cols.filter((i) => (ratios.get(i) ?? 0) >= 0.5);
  const candidates = [...new Set([...byHeader, ...byContent])].sort((a, b) => (ratios.get(b) ?? 0) - (ratios.get(a) ?? 0));

  // A header hit whose content is mostly valid wins outright when it's the only one.
  const strong = byHeader.filter((i) => (ratios.get(i) ?? 0) >= 0.5);
  if (strong.length === 1) return { column: strong[0]!, ambiguous: false, candidates };
  if (strong.length > 1) return { column: strong.sort((a, b) => (ratios.get(b) ?? 0) - (ratios.get(a) ?? 0))[0]!, ambiguous: true, candidates };
  if (byHeader.length === 1 && sample.length === 0) return { column: byHeader[0]!, ambiguous: false, candidates };
  return { column: candidates[0] ?? null, ambiguous: true, candidates };
}

/* ------------------------------------------------------------------ history (read-only) */

export interface HistoryEntry {
  /** Sent, done or still sending at least once → "already used". */
  used: boolean;
  /** Had a failed send. Failed-only entries stay in the new-only file so they can be retried. */
  failed: boolean;
  statuses: Set<string>;
}
export type HistoryMap = Map<string, HistoryEntry>;

function add(map: HistoryMap, key: string | null, status: string, used: Set<string>, failed: Set<string>) {
  if (!key) return;
  const isUsed = used.has(status);
  const isFailed = failed.has(status);
  if (!isUsed && !isFailed) return; // e.g. SKIPPED / CANCELLED: never went out
  const e = map.get(key) ?? { used: false, failed: false, statuses: new Set<string>() };
  e.used ||= isUsed;
  e.failed ||= isFailed;
  e.statuses.add(status);
  map.set(key, e);
}

const CHUNK = 1000;
const chunks = <T>(arr: T[]) => Array.from({ length: Math.ceil(arr.length / CHUNK) }, (_, i) => arr.slice(i * CHUNK, (i + 1) * CHUNK));

/**
 * What each ledger status means, per history source — shared by this filter
 * ("already used" = sent / done / still sending, "failed" = failed) and the
 * Send Queue "Download all history" export (its Result column). Skipped and
 * cancelled never reached the recipient and count as not used.
 */
export type HistoryResult = "sent" | "done" | "still sending" | "failed" | "skipped" | "cancelled";
export type HistorySource = "email-batch" | "email-log" | "whatsapp" | "call";
const RESULTS: Record<HistorySource, Record<string, HistoryResult>> = {
  "email-batch": { PENDING: "still sending", SENDING: "still sending", SENT: "sent", FAILED: "failed", SKIPPED: "skipped" },
  "email-log": {
    QUEUED: "still sending",
    SENT: "sent",
    DELIVERED: "sent",
    OPENED: "sent",
    CLICKED: "sent",
    BOUNCED: "sent",
    COMPLAINED: "sent",
    FAILED: "failed",
  },
  whatsapp: { QUEUED: "still sending", SENDING: "still sending", SENT: "sent", DELIVERED: "sent", READ: "sent", FAILED: "failed", SKIPPED: "skipped" },
  call: {
    QUEUED: "still sending",
    DIALING: "still sending",
    RINGING: "still sending",
    IN_PROGRESS: "still sending",
    COMPLETED: "done",
    NO_ANSWER: "done",
    BUSY: "done",
    FAILED: "failed",
    CANCELLED: "cancelled",
  },
};

export function historyResult(source: HistorySource, status: string): HistoryResult | null {
  return RESULTS[source][status] ?? null;
}

const statusesWhere = (source: HistorySource, pick: (r: HistoryResult) => boolean) =>
  new Set(Object.entries(RESULTS[source]).flatMap(([s, r]) => (pick(r) ? [s] : [])));
const isUsedResult = (r: HistoryResult) => r === "sent" || r === "done" || r === "still sending";
const EMAIL_BATCH_USED = statusesWhere("email-batch", isUsedResult);
const EMAIL_LOG_USED = statusesWhere("email-log", isUsedResult);
const WA_USED = statusesWhere("whatsapp", isUsedResult);
const CALL_USED = statusesWhere("call", isUsedResult);
const FAILED = new Set(["FAILED"]);

/**
 * History entries for the given keys, from this channel's tables only. One
 * grouped query per table (or chunked IN lookups on an indexed column) — never
 * one query per row.
 */
export async function loadHistory(channel: HistoryChannel, keys: string[], defaultCountryCode = "91"): Promise<HistoryMap> {
  const map: HistoryMap = new Map();
  if (keys.length === 0) return map;

  if (channel === "email") {
    // Send Queue email batches (email snapshot per item) — one grouped scan.
    const items = await prisma.manualSendBatchItem.groupBy({ by: ["email", "status"] });
    for (const i of items) add(map, historyKey("email", i.email), i.status, EMAIL_BATCH_USED, FAILED);
    // Campaign / trigger / manual sends in the email ledger — via the unique contact email index.
    for (const part of chunks(keys)) {
      const contacts = await prisma.contact.findMany({
        where: { email: { in: part } },
        select: { email: true, emailLogs: { select: { status: true }, distinct: ["status"] } },
      });
      for (const c of contacts) for (const l of c.emailLogs) add(map, historyKey("email", c.email), l.status, EMAIL_LOG_USED, FAILED);
    }
    return map;
  }

  if (channel === "whatsapp") {
    // Every WhatsApp message (bulk batches and Inbox replies) — one grouped scan.
    const sends = await prisma.whatsAppSend.groupBy({ by: ["phone", "status"] });
    for (const s of sends) add(map, historyKey("whatsapp", `+${s.phone.replace(/^\+/, "")}`, defaultCountryCode), s.status, WA_USED, FAILED);
    return map;
  }

  // AI calls: ai_call_logs.phone is E.164 and indexed — chunked IN lookups.
  for (const part of chunks(keys)) {
    const logs = await prisma.aiCallLog.groupBy({ by: ["phone", "status"], where: { phone: { in: part } } });
    for (const l of logs) add(map, historyKey("ai-call", l.phone, defaultCountryCode), l.status, CALL_USED, FAILED);
  }
  return map;
}

/* ------------------------------------------------------------------ classifying */

export type RowVerdict = "new" | "used" | "invalid" | "duplicate";

export interface HistorySummary {
  total: number;
  invalid: number;
  duplicates: number;
  alreadyUsed: number;
  /** Rows that go into the new-only file (includes previously failed ones). */
  newCount: number;
  /** Of `newCount`, entries whose only history is a failed send (kept so they can be retried). */
  failed: number;
  truncated: boolean;
}

export interface Classified {
  verdicts: RowVerdict[];
  /** Per row: previous statuses for "used" rows, for the reference report. */
  previous: (string | null)[];
  summary: HistorySummary;
}

/** Pure: classify every row given the column and the channel history. */
export function classifyRows(grid: Grid, column: number, channel: HistoryChannel, history: HistoryMap, defaultCountryCode = "91"): Classified {
  const seen = new Set<string>();
  const verdicts: RowVerdict[] = [];
  const previous: (string | null)[] = [];
  const s: HistorySummary = { total: grid.rows.length, invalid: 0, duplicates: 0, alreadyUsed: 0, newCount: 0, failed: 0, truncated: grid.truncated };
  for (const row of grid.rows) {
    const key = historyKey(channel, row.text[column] ?? "", defaultCountryCode);
    let v: RowVerdict;
    let prev: string | null = null;
    if (!key) {
      v = "invalid";
      s.invalid++;
    } else if (seen.has(key)) {
      v = "duplicate";
      s.duplicates++;
    } else {
      seen.add(key);
      const h = history.get(key);
      if (h?.used) {
        v = "used";
        s.alreadyUsed++;
        prev = [...h.statuses].join(", ");
      } else {
        v = "new";
        s.newCount++;
        if (h?.failed) s.failed++;
      }
    }
    verdicts.push(v);
    previous.push(prev);
  }
  return { verdicts, previous, summary: s };
}

/** Keys of the valid, first-occurrence rows — what the history lookup needs. */
export function uniqueKeys(grid: Grid, column: number, channel: HistoryChannel, defaultCountryCode = "91"): string[] {
  const out = new Set<string>();
  for (const r of grid.rows) {
    const k = historyKey(channel, r.text[column] ?? "", defaultCountryCode);
    if (k) out.add(k);
  }
  return [...out];
}

/* ------------------------------------------------------------------ writing the result */

/** Formulas would point at the wrong rows once rows are dropped — keep their computed value instead. */
function plainValue(v: ExcelJS.CellValue): ExcelJS.CellValue {
  if (v && typeof v === "object" && ("formula" in v || "sharedFormula" in v)) {
    return ((v as { result?: ExcelJS.CellValue }).result ?? null) as ExcelJS.CellValue;
  }
  return v;
}

/**
 * The chosen rows in the uploaded file's format, original columns in order.
 * `extra` appends one reference column (the "already used" report's previous status).
 */
export async function writeHistoryFile(
  grid: Grid,
  format: HistoryFileFormat,
  rowIndexes: number[],
  extra?: { header: string; values: (string | null)[] },
): Promise<Buffer> {
  if (format === "csv") {
    const lines = [[...grid.headers, ...(extra ? [extra.header] : [])].map(csvCell).join(",")];
    for (const i of rowIndexes) {
      const cells = [...grid.rows[i]!.text, ...(extra ? [extra.values[i] ?? ""] : [])];
      lines.push(cells.map(csvCell).join(","));
    }
    // BOM so Excel opens it as UTF-8 (same as the app's other CSV downloads).
    return Buffer.from("﻿" + lines.join("\r\n"), "utf8");
  }
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet(grid.sheetName || "Sheet1");
  ws.addRow([...grid.headers, ...(extra ? [extra.header] : [])]);
  ws.getRow(1).font = { bold: true };
  for (const i of rowIndexes) {
    const r = grid.rows[i]!;
    ws.addRow([...(r.values ? r.values.map(plainValue) : r.text), ...(extra ? [extra.values[i] ?? ""] : [])]);
  }
  grid.columnWidths?.forEach((w, c) => {
    if (w) ws.getColumn(c + 1).width = w;
  });
  return Buffer.from(await wb.xlsx.writeBuffer());
}

/* ------------------------------------------------------------------ one call for the route */

export async function filterAgainstHistory(
  grid: Grid,
  channel: HistoryChannel,
  column: number,
  defaultCountryCode = "91",
): Promise<Classified> {
  const history = await loadHistory(channel, uniqueKeys(grid, column, channel, defaultCountryCode), defaultCountryCode);
  return classifyRows(grid, column, channel, history, defaultCountryCode);
}
