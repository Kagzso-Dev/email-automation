// Import filter step (ENABLE_IMPORT_FILTER_STEP): before "Import file" imports anything on WhatsApp Contacts
// or Voicecall Contact, the file's rows open in the Data Quality filter view. The rows are held here, in the
// browser, until "Import N selected"; nothing is saved before that. Read from GET /api/import-filter/config:
// loading, an error, or an API without the endpoint all count as OFF, so "Import file" works as before.

import { useQuery, type QueryClient } from "@tanstack/react-query";
import { api } from "./api";
import {
  EXTRA_FIELD_LABELS,
  type DqExtraField,
  type DqFacets,
  type DqFilters,
  type DqPhoneType,
  type DqRecord,
  type DqRecordStatus,
  type DqReview,
  type DqTier,
} from "./dataQuality";

export interface ImportFilterConfig {
  enabled: boolean;
  /** The most rows one import takes (the importers' own limit). */
  maxRows: number;
}

const CONFIG_KEY = ["import-filter-config"] as const;
const OFF: ImportFilterConfig = { enabled: false, maxRows: 1000 };
const loadConfig = () => api<ImportFilterConfig>("/api/import-filter/config").catch(() => OFF);

/** The flag for rendering (OFF until it is known). */
export function useImportFilterStep(): ImportFilterConfig {
  return useImportFilterStepState();
}

/** The flag plus whether it is still loading (a page that only exists with the flag on waits instead of flashing "off"). */
export function useImportFilterStepState(): ImportFilterConfig & { loading: boolean } {
  const q = useQuery({ queryKey: CONFIG_KEY, queryFn: loadConfig, staleTime: 60_000, retry: false });
  return { ...(q.data?.enabled === true ? q.data : OFF), loading: q.isLoading };
}

/** The flag at the moment a file is picked (waits for it when it isn't loaded yet; any failure = OFF). */
export async function importFilterStepOn(qc: QueryClient): Promise<boolean> {
  try {
    return (await qc.fetchQuery({ queryKey: CONFIG_KEY, queryFn: loadConfig, staleTime: 60_000 })).enabled === true;
  } catch {
    return false;
  }
}

/* ------------------------------------------------------------------ rows */

/** One row's Data Quality result, from the API (same meaning as on the Data Quality page; rules score only). */
export interface DraftCheck {
  rowIndex: number;
  name: string | null;
  phoneRaw: string | null;
  phone: string | null;
  businessName: string | null;
  email: string | null;
  status: DqRecordStatus;
  excludedReason: "do_not_call" | "not_interested" | "wrong_person" | null;
  issues: string[];
  flags: string[];
  ruleScore: number | null;
  score: number | null;
  phoneType: DqPhoneType;
  tier: DqTier | null;
  /** "Exclude already used data": which checks match (absent on an older API = none). */
  used?: UsedInfo;
}

/* ------------------------------------------------------------------ "Exclude already used data" */

export type UsedOption = "contacts" | "sent" | "called";
export const USED_OPTIONS: [UsedOption, string][] = [
  ["contacts", "Already in contacts (this channel)"],
  ["sent", "Already sent to (WhatsApp sends / email logs / Send Queue history)"],
  ["called", "Already called (call logs, do-not-call)"],
];
export const ALL_USED: UsedOption[] = USED_OPTIONS.map(([v]) => v);

/** From the API (apps/api/src/domain/importFilterUsed.ts). Dates are ISO strings; null = unknown. */
export interface UsedInfo {
  inContacts: { at: string | null } | null;
  sent: { at: string | null; via: ("whatsapp" | "email")[] } | null;
  called: { at: string | null; reason: "called" | "do_not_call" | "not_interested" | "wrong_person" } | null;
}
export const NOT_USED: UsedInfo = { inContacts: null, sent: null, called: null };

/** "12 Nov 2026" (the viewer's time zone). */
export const shortDate = (iso: string | null | undefined) =>
  iso ? new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" }) : null;

const CALLED_TEXT = { do_not_call: "Do not call", not_interested: "Not interested (call result)", wrong_person: "Wrong person (call result)" } as const;

/** Why the row is excluded: one reason per TICKED option it matches (none = it is not excluded). */
export function usedReasons(r: { used: UsedInfo }, exclude: readonly UsedOption[], page: ImportFilterPage): string[] {
  const out: string[] = [];
  const on = (o: UsedOption) => exclude.includes(o);
  const { inContacts, sent, called } = r.used;
  if (on("contacts") && inContacts) {
    const where = page === "whatsapp" ? "WhatsApp Contacts" : "this Voicecall list";
    out.push(`Already in ${where}${inContacts.at ? ` (added ${shortDate(inContacts.at)})` : ""}`);
  }
  if (on("sent") && sent) {
    const how = sent.via.length > 1 ? "WhatsApp, email" : sent.via[0] === "email" ? "email" : "WhatsApp";
    out.push(`Already sent${sent.at ? ` ${shortDate(sent.at)}` : ""} (${how})`);
  }
  if (on("called") && called) {
    out.push(called.reason === "called" ? `Already called${called.at ? ` ${shortDate(called.at)}` : ""}` : CALLED_TEXT[called.reason]);
  }
  return out;
}

/** The row matches a ticked "already used" option: it is not imported. */
export const isExcluded = (r: { used: UsedInfo }, exclude: readonly UsedOption[]) =>
  (exclude.includes("contacts") && !!r.used.inContacts) || (exclude.includes("sent") && !!r.used.sent) || (exclude.includes("called") && !!r.used.called);

export type DraftLanguage = "ta" | "en" | "indic" | "unknown";
export const LANGUAGE_OPTIONS: [DraftLanguage, string][] = [
  ["ta", "Tamil"],
  ["en", "English"],
  ["indic", "Other Indian"],
  ["unknown", "Not detected"],
];
export const ALL_LANGUAGES: DraftLanguage[] = LANGUAGE_OPTIONS.map(([v]) => v);
export const LANGUAGE_LABELS = Object.fromEntries(LANGUAGE_OPTIONS) as Record<DraftLanguage, string>;

const TAMIL = /[஀-௿]/;
// Devanagari, Bengali, Gurmukhi, Gujarati, Odia, Telugu, Kannada, Malayalam (Tamil is checked first).
const OTHER_INDIAN = /[ऀ-୿ఀ-ൿ]/;
const LATIN = /[A-Za-z]/;

/** From the script of the name and business: Tamil, other Indian, English (Latin letters), or not detected. */
export function detectLanguage(...texts: (string | null | undefined)[]): DraftLanguage {
  const s = texts.filter(Boolean).join(" ");
  if (TAMIL.test(s)) return "ta";
  if (OTHER_INDIAN.test(s)) return "indic";
  if (LATIN.test(s)) return "en";
  return "unknown";
}

/** A row in the filter view: its check, its language, whether the page's importer takes it, and the review here. */
export interface DraftRow extends DraftCheck {
  language: DraftLanguage;
  /** The page's own importer would take this row. */
  importable: boolean;
  /** Why it would not (shown in the Notes column). */
  importProblem: string | null;
  /** WhatsApp: the number is already saved; the importer updates that contact. */
  alreadySaved: boolean;
  /** Approve / Reject here: held in memory only. Rejected rows are not imported. */
  review: DqReview;
  used: UsedInfo;
  /** The file's city, state, category, source, date… for this row (the dropdown filters). */
  extra?: Partial<Record<DqExtraField, string>>;
  /** Data Quality's AI score (lib/importFilterAi.ts): PENDING on valid rows until scored; never saved. */
  aiState: DqRecord["aiState"];
  aiScore: number | null;
  aiNotes: string | null;
}

/* ------------------------------------------------------------------ city / category / source / date (Data Quality's dropdowns) */

/** Which of the file's columns holds each field (from the API: Data Quality's own header detection). */
export type ExtraColumns = Record<DqExtraField, string | null>;
const EXTRA_FIELDS = Object.keys(EXTRA_FIELD_LABELS) as DqExtraField[];
/** The most values one dropdown lists (the Data Quality page's limit). */
const FACET_LIMIT = 500;
const rawValue = (raw: Record<string, string> | undefined, header: string | null) => (header && raw ? String(raw[header] ?? "").trim() : "");

/** Each row's city, category, … read from its own file row (as the Data Quality page reads them). */
export function withExtraValues(rows: DraftRow[], rawRows: Record<string, string>[], columns: ExtraColumns | null | undefined): DraftRow[] {
  if (!columns || !EXTRA_FIELDS.some((f) => columns[f])) return rows;
  return rows.map((r) => {
    const extra: Partial<Record<DqExtraField, string>> = {};
    for (const f of EXTRA_FIELDS) if (columns[f]) extra[f] = rawValue(rawRows[r.rowIndex], columns[f]);
    return { ...r, extra };
  });
}

/** The dropdown values with their counts, for the shared Data Quality filter panel (most frequent first). */
export function draftFacets(headers: string[], rawRows: Record<string, string>[], columns: ExtraColumns | null | undefined): DqFacets {
  const cols = Object.fromEntries(EXTRA_FIELDS.map((f) => [f, columns?.[f] ?? null])) as ExtraColumns;
  const values: DqFacets["values"] = {};
  for (const f of EXTRA_FIELDS) {
    if (!cols[f]) continue;
    const counts = new Map<string, number>();
    for (const raw of rawRows) {
      const v = rawValue(raw, cols[f]);
      if (v) counts.set(v, (counts.get(v) ?? 0) + 1);
    }
    values[f] = [...counts.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, FACET_LIMIT)
      .map(([value, count]) => ({ value, count }));
  }
  return { headers, columns: cols, values };
}

export function toDraftRows(
  checks: (DraftCheck & { importable?: boolean; importProblem?: string | null; alreadySaved?: boolean })[],
  importable?: (rowIndex: number) => string | null,
): DraftRow[] {
  return checks.map((c) => {
    const problem = importable ? importable(c.rowIndex) : (c.importProblem ?? null);
    return {
      ...c,
      language: detectLanguage(c.name, c.businessName),
      importable: importable ? problem === null : c.importable !== false,
      importProblem: problem,
      alreadySaved: c.alreadySaved === true,
      review: "PENDING",
      used: c.used ?? NOT_USED,
      // As on Data Quality: only valid rows get an AI score.
      aiState: c.status === "VALID" ? "PENDING" : "NONE",
      aiScore: null,
      aiNotes: null,
    };
  });
}

/* ------------------------------------------------------------------ per-page defaults */

export type ImportFilterPage = "whatsapp" | "voicecall";

/** The filters ticked when the view opens; the user can change any of them. Every "already used" option is ticked. */
export function pageDefaults(page: ImportFilterPage): { filters: DqFilters; languages: DraftLanguage[]; exclude: UsedOption[] } {
  return page === "whatsapp"
    ? { filters: { phoneType: ["mobile"] }, languages: [...ALL_LANGUAGES], exclude: [...ALL_USED] }
    : { filters: { phoneType: ["mobile", "landline"] }, languages: [...ALL_LANGUAGES], exclude: [...ALL_USED] };
}

/* ------------------------------------------------------------------ filtering (same rules as the Data Quality page) */

export interface DraftView {
  status?: DqRecordStatus;
  minScore?: number;
}

const norm = (v: string | null | undefined) => (v ?? "").toLowerCase().replace(/\s+/g, " ").trim();
const digitsOf = (v: string | null | undefined) => (v ?? "").replace(/\D/g, "");

/**
 * Every filter must match (AND); inside one group any one will do; an empty group is no filter.
 * Mirrors rowMatches in apps/api/src/domain/dataQualityExport.ts (city, category, … must equal the picked value).
 */
export function draftRowMatches(r: DraftRow, f: DqFilters, languages: DraftLanguage[], view: DraftView = {}): boolean {
  if (view.status && r.status !== view.status) return false;
  if (view.minScore != null && (r.score == null || r.score < view.minScore)) return false;
  const contains = (q: string | undefined, v: string | null) => !q || norm(v).includes(norm(q));
  if (!contains(f.business, r.businessName) || !contains(f.name, r.name) || !contains(f.email, r.email)) return false;
  if (f.phone) {
    const q = digitsOf(f.phone);
    if (!q || !(digitsOf(r.phone).includes(q) || digitsOf(r.phoneRaw).includes(q))) return false;
  }
  for (const field of EXTRA_FIELDS) {
    const want = f[field];
    if (want && (r.extra?.[field] ?? "") !== want) return false;
  }
  if (f.status?.length && !f.status.some((s) => (s === "LANDLINE" ? r.phoneType === "landline" : r.status === s))) return false;
  if (f.phoneType?.length && !f.phoneType.includes(r.phoneType)) return false;
  if (f.hasEmail !== undefined && !!r.email !== f.hasEmail) return false;
  if (f.hasPhone !== undefined && !!r.phoneRaw !== f.hasPhone) return false;
  if (f.scoreMin !== undefined && (r.score == null || r.score < f.scoreMin)) return false;
  if (f.scoreMax !== undefined && (r.score == null || r.score > f.scoreMax)) return false;
  if (f.tier?.length && (!r.tier || !f.tier.includes(r.tier))) return false;
  if (f.review?.length && !f.review.includes(r.review)) return false;
  if (languages.length && !languages.includes(r.language)) return false;
  return true;
}

/** Can go to the importer: the importer takes it, it wasn't rejected here, and it isn't excluded as already used. */
export const isSelectable = (r: DraftRow, exclude: readonly UsedOption[] = []) => r.importable && r.review !== "REJECTED" && !isExcluded(r, exclude);

/* ------------------------------------------------------------------ WhatsApp: the chosen rows as a file */

const csvCell = (v: string) => (/[",\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);

/**
 * The chosen rows, with every original column, as a CSV for the WhatsApp importer (which then reads it with
 * its own rules). No BOM: the importer would read it as part of the first header.
 */
export function rowsToCsv(headers: string[], rows: Record<string, string>[]): string {
  const line = (cells: string[]) => cells.map(csvCell).join(",");
  return [line(headers), ...rows.map((r) => line(headers.map((h) => r[h] ?? "")))].join("\r\n") + "\r\n";
}

/** "contacts.xlsx" → "contacts-selected.csv". */
export const selectedFileName = (filename: string) => `${filename.replace(/\.[^.]+$/, "") || "import"}-selected.csv`;

export const EXCLUDED_HEADER = "Excluded because";

/** The excluded rows with every original column, plus why each was excluded. */
export function excludedRowsCsv(
  headers: string[],
  rawRows: Record<string, string>[],
  excluded: DraftRow[],
  exclude: readonly UsedOption[],
  page: ImportFilterPage,
): string {
  return rowsToCsv(
    [...headers, EXCLUDED_HEADER],
    excluded.map((r) => ({ ...(rawRows[r.rowIndex] ?? {}), [EXCLUDED_HEADER]: usedReasons(r, exclude, page).join("; ") })),
  );
}

/** Save text as a file in the browser (UTF-8 with BOM, so Excel opens Tamil text correctly). Nothing is uploaded. */
export function downloadText(filename: string, text: string) {
  const url = URL.createObjectURL(new Blob([`﻿${text}`], { type: "text/csv;charset=utf-8" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

/* ------------------------------------------------------------------ what "Import N selected" hands over */

/** The settings used for an import (stored in Upload History). */
export interface FiltersUsed {
  filters: DqFilters;
  languages: DraftLanguage[];
  exclude: UsedOption[];
  /** The status tab ("ALL" = every status). */
  tab: string;
  /** "Only show rows scoring N+" (null = off). */
  minScore: number | null;
  approved: number;
  rejected: number;
  /** Rows the user unticked by hand. */
  unticked: number;
}

export interface ImportSelection {
  /** Sent to the importer, in file order. */
  rowIndexes: number[];
  /** Excluded as already used (the whole file, with the options ticked). */
  excluded: DraftRow[];
  /** The excluded rows as CSV (original columns + why). */
  excludedCsv: string;
  settings: FiltersUsed;
}
