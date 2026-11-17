// Import filter step (ENABLE_IMPORT_FILTER_STEP): before "Import file" imports anything on WhatsApp Contacts
// or Voicecall Contact, the file's rows open in the Data Quality filter view. The rows are held here, in the
// browser, until "Import N selected"; nothing is saved before that. Read from GET /api/import-filter/config:
// loading, an error, or an API without the endpoint all count as OFF, so "Import file" works as before.

import { useQuery, type QueryClient } from "@tanstack/react-query";
import { api } from "./api";
import type { DqFilters, DqPhoneType, DqRecordStatus, DqReview, DqTier } from "./dataQuality";

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
  const q = useQuery({ queryKey: CONFIG_KEY, queryFn: loadConfig, staleTime: 60_000, retry: false });
  return q.data?.enabled === true ? q.data : OFF;
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
}

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
    };
  });
}

/* ------------------------------------------------------------------ per-page defaults */

export type ImportFilterPage = "whatsapp" | "voicecall";

/** The filters ticked when the view opens; the user can change any of them. */
export function pageDefaults(page: ImportFilterPage): { filters: DqFilters; languages: DraftLanguage[] } {
  return page === "whatsapp"
    ? { filters: { phoneType: ["mobile"] }, languages: [...ALL_LANGUAGES] }
    : { filters: { phoneType: ["mobile", "landline"] }, languages: [...ALL_LANGUAGES] };
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
 * Mirrors rowMatches in apps/api/src/domain/dataQualityExport.ts (the file's extra columns aren't used here).
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

/** Can go to the importer: the importer takes it and it wasn't rejected here. */
export const isSelectable = (r: DraftRow) => r.importable && r.review !== "REJECTED";

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
