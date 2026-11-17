// Upload History (ENABLE_IMPORT_FILTER_STEP, migration 0037): /api/upload-history. A record is written by the
// import filter step only after the page's importer answered "Import N selected"; a failed write is reported as a
// warning and never undoes or blocks the import.

import { AI_CALL_LANGUAGE_NAMES, type AiCallLanguage } from "@dispatch/shared";
import { apiResponse, api, ApiError } from "./api";
import { CHECK_STATUS_OPTIONS, PHONE_TYPE_OPTIONS, TIER_OPTIONS } from "./dataQuality";
import { ALL_LANGUAGES, ALL_USED, LANGUAGE_LABELS, USED_OPTIONS, type FiltersUsed } from "./importFilter";

export type UploadChannel = "whatsapp" | "voicecall";

export interface UploadHistoryItem {
  id: string;
  fileName: string;
  channel: UploadChannel;
  language: string | null;
  uploadedByEmail: string;
  totalRows: number;
  imported: number;
  excludedUsed: number;
  filteredOut: number;
  duplicates: number;
  failed: number;
  skippedOverLimit: number;
  filters: Partial<FiltersUsed>;
  result: unknown;
  excludedRows: number;
  excludedExpiresAt: string;
  excludedPurgedAt: string | null;
  excludedAvailable: boolean;
  createdAt: string;
}

export interface UploadHistoryPage {
  items: UploadHistoryItem[];
  total: number;
  page: number;
  pageSize: number;
}

export interface UploadHistorySummary {
  fileName: string;
  channel: UploadChannel;
  language: AiCallLanguage | null;
  totalRows: number;
  imported: number;
  excludedUsed: number;
  filteredOut: number;
  duplicates: number;
  failed: number;
  skippedOverLimit: number;
  excludedRows: number;
  filters: FiltersUsed;
  result: unknown;
}

/** Write the record (after the import). Returns null when saved, otherwise a short warning. Never throws. */
export async function saveUploadHistory(summary: UploadHistorySummary, excludedCsv: string): Promise<string | null> {
  try {
    const fd = new FormData();
    fd.append("summary", JSON.stringify(summary));
    if (summary.excludedRows > 0 && excludedCsv) fd.append("excluded", new File([excludedCsv], "excluded.csv", { type: "text/csv" }));
    await api("/api/upload-history", { method: "POST", body: fd, notify: false });
    return null;
  } catch (err) {
    const why = err instanceof ApiError && err.status === 503 ? "the database update (migration 0037) isn't applied yet" : err instanceof Error ? err.message : "unknown error";
    return `Imported, but this upload couldn't be added to Upload History: ${why}.`;
  }
}

export const channelLabel = (channel: UploadChannel, language: string | null) =>
  channel === "whatsapp"
    ? "WhatsApp Contacts"
    : `Voicecall Contact${language && language !== "en" ? ` · ${AI_CALL_LANGUAGE_NAMES[language as AiCallLanguage] ?? language}` : ""}`;

const labelsOf = <T extends string>(options: readonly (readonly [T, string])[], values: readonly string[] | undefined) =>
  (values ?? []).map((v) => options.find(([k]) => k === v)?.[1] ?? v).join(", ");

/** The filters and exclusion options used, one readable line each. */
export function describeFilters(f: Partial<FiltersUsed>): string[] {
  const out: string[] = [];
  const x = f.filters ?? {};
  const exclude = f.exclude ?? [];
  out.push(
    `Exclude already used: ${
      exclude.length === 0 ? "none" : exclude.length === ALL_USED.length ? "all three" : labelsOf(USED_OPTIONS, exclude)
    }`,
  );
  if (x.phoneType?.length) out.push(`Phone type: ${labelsOf(PHONE_TYPE_OPTIONS, x.phoneType)}`);
  const langs = f.languages ?? [];
  if (langs.length && langs.length < ALL_LANGUAGES.length) out.push(`Language: ${langs.map((l) => LANGUAGE_LABELS[l] ?? l).join(", ")}`);
  if (x.status?.length) out.push(`Check status: ${labelsOf(CHECK_STATUS_OPTIONS, x.status)}`);
  if (x.tier?.length) out.push(`Tier: ${labelsOf(TIER_OPTIONS, x.tier)}`);
  if (x.review?.length) out.push(`Review: ${x.review.map((r) => r.toLowerCase()).join(", ")}`);
  if (x.scoreMin !== undefined || x.scoreMax !== undefined) out.push(`Score ${x.scoreMin ?? 0}–${x.scoreMax ?? 100}`);
  if (f.minScore != null) out.push(`Only rows scoring ${f.minScore}+`);
  if (x.hasEmail !== undefined) out.push(x.hasEmail ? "Has email" : "No email");
  if (x.hasPhone !== undefined) out.push(x.hasPhone ? "Has phone" : "No phone");
  for (const [k, label] of [["business", "Business"], ["name", "Name"], ["email", "Email"], ["phone", "Phone"]] as const) {
    if (x[k]) out.push(`${label} contains “${x[k]}”`);
  }
  if (f.tab && f.tab !== "ALL") out.push(`Tab: ${f.tab.toLowerCase()}`);
  if (f.approved || f.rejected) out.push(`Approved ${f.approved ?? 0}, rejected ${f.rejected ?? 0}`);
  if (f.unticked) out.push(`${f.unticked} row${f.unticked === 1 ? "" : "s"} unticked by hand`);
  return out;
}

/** Save the excluded rows of an upload (an authenticated download). */
export async function downloadExcludedRows(id: string): Promise<void> {
  const res = await apiResponse(`/api/upload-history/${encodeURIComponent(id)}/excluded`);
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `Download failed (${res.status})`);
  }
  const blob = await res.blob();
  const name = /filename="([^"]+)"/.exec(res.headers.get("content-disposition") ?? "")?.[1] ?? "excluded.csv";
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
