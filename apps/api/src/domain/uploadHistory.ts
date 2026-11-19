// Upload History (ENABLE_IMPORT_FILTER_STEP, migration 0037): one row per confirmed "Import N selected" from the
// import filter step. Reads and writes only the upload_history table. Each row (counts, filters and the excluded-rows
// CSV) is deleted 30 days after the upload: on every history read / write and by an hourly sweep in the API process
// (scheduler.ts is not involved).

import { Prisma } from "@prisma/client";
import { logger } from "../logger.js";
import { prisma } from "../prisma.js";

export const HISTORY_RETENTION_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;

/** Prisma's "table does not exist" (P2021) or MySQL's 1146: migration 0037 isn't applied yet. */
export const isMissingTable = (err: unknown) => {
  const raw = err as { code?: string; meta?: { code?: string } } | null;
  return raw?.code === "P2021" || raw?.meta?.code === "1146";
};

export type UploadChannel = "whatsapp" | "voicecall";

export interface UploadHistoryInput {
  fileName: string;
  channel: UploadChannel;
  language: string | null;
  uploadedById: string;
  uploadedByEmail: string;
  totalRows: number;
  imported: number;
  excludedUsed: number;
  filteredOut: number;
  duplicates: number;
  failed: number;
  skippedOverLimit: number;
  filters: Record<string, unknown>;
  result: unknown;
  excludedRows: number;
  /** The excluded rows as CSV text (null when there are none). */
  excludedCsv: string | null;
}

/** Every column except the excluded-rows file itself. */
const SUMMARY_SELECT = {
  id: true,
  fileName: true,
  channel: true,
  language: true,
  uploadedById: true,
  uploadedByEmail: true,
  totalRows: true,
  imported: true,
  excludedUsed: true,
  filteredOut: true,
  duplicates: true,
  failed: true,
  skippedOverLimit: true,
  filters: true,
  result: true,
  excludedRows: true,
  excludedExpiresAt: true,
  excludedPurgedAt: true,
  createdAt: true,
} as const;

type SummaryRow = Prisma.UploadHistoryGetPayload<{ select: typeof SUMMARY_SELECT }>;

/** The row as the API returns it: plus whether the excluded rows can still be downloaded. */
const view = (r: SummaryRow, now = new Date()) => ({
  ...r,
  excludedAvailable: r.excludedRows > 0 && !r.excludedPurgedAt && r.excludedExpiresAt > now,
});

export async function createUploadHistory(input: UploadHistoryInput, now = new Date()) {
  const row = await prisma.uploadHistory.create({
    data: {
      ...input,
      filters: input.filters as Prisma.InputJsonValue,
      result: (input.result ?? {}) as Prisma.InputJsonValue,
      excludedCsv: input.excludedRows > 0 && input.excludedCsv ? input.excludedCsv : null,
      excludedExpiresAt: new Date(now.getTime() + HISTORY_RETENTION_DAYS * DAY_MS), // the whole row goes then
      createdAt: now,
    },
    select: SUMMARY_SELECT,
  });
  return view(row, now);
}

/** Delete the uploads made more than 30 days ago (the whole row, its excluded rows included). Returns how many. */
export async function purgeExpiredHistory(now = new Date()): Promise<number> {
  const { count } = await prisma.uploadHistory.deleteMany({
    where: { createdAt: { lte: new Date(now.getTime() - HISTORY_RETENTION_DAYS * DAY_MS) } },
  });
  if (count) logger.info({ count }, "upload history: uploads older than 30 days deleted");
  return count;
}

export async function listUploadHistory(q: { page: number; pageSize: number; search?: string }) {
  const where: Prisma.UploadHistoryWhereInput = q.search ? { fileName: { contains: q.search } } : {};
  const [items, total] = await Promise.all([
    prisma.uploadHistory.findMany({
      where,
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      skip: (q.page - 1) * q.pageSize,
      take: q.pageSize,
      select: SUMMARY_SELECT,
    }),
    prisma.uploadHistory.count({ where }),
  ]);
  const now = new Date();
  return { items: items.map((r) => view(r, now)), total, page: q.page, pageSize: q.pageSize };
}

export async function getUploadHistory(id: string) {
  const row = await prisma.uploadHistory.findUnique({ where: { id }, select: SUMMARY_SELECT });
  return row ? view(row) : null;
}

/** The excluded rows: the CSV, or why it isn't there. */
export async function getExcludedCsv(
  id: string,
  now = new Date(),
): Promise<{ status: "ok"; fileName: string; csv: string } | { status: "missing" } | { status: "gone" } | { status: "none" }> {
  const row = await prisma.uploadHistory.findUnique({
    where: { id },
    select: { fileName: true, excludedRows: true, excludedCsv: true, excludedPurgedAt: true, excludedExpiresAt: true },
  });
  if (!row) return { status: "missing" };
  if (row.excludedRows === 0) return { status: "none" };
  if (row.excludedPurgedAt || row.excludedExpiresAt <= now || !row.excludedCsv) return { status: "gone" };
  return { status: "ok", fileName: row.fileName, csv: row.excludedCsv };
}

/** The hourly sweep (API process). Never throws; a missing table (migration not applied) is ignored. */
export function startUploadHistorySweep(intervalMs = 60 * 60 * 1000): () => void {
  const run = () =>
    void purgeExpiredHistory().catch((err) => {
      if (!isMissingTable(err)) logger.warn({ err }, "upload history sweep failed");
    });
  const timer = setInterval(run, intervalMs);
  timer.unref?.(); // never keeps the process alive
  return () => clearInterval(timer);
}
