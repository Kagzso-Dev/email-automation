import { api, getAccessToken } from "./api";

/**
 * Send Queue → "Upload new file": compare a csv / xlsx with one channel's send
 * history (read-only, POST /api/send-queue/filter/:channel/*). The file is sent
 * again for each download, so nothing is stored on the server.
 */

export type HistoryChannel = "email" | "whatsapp" | "ai-call";

export interface HistorySummary {
  total: number;
  invalid: number;
  duplicates: number;
  alreadyUsed: number;
  newCount: number;
  failed: number;
  truncated: boolean;
}

export interface HistoryAnalysis {
  channel: HistoryChannel;
  fileName: string;
  format: "csv" | "xlsx";
  headers: string[];
  /** Column compared (index into headers), or null when none could be found. */
  column: number | null;
  detected: number | null;
  ambiguous: boolean;
  candidates: number[];
  /** Null until a column is chosen. */
  summary: HistorySummary | null;
}

function form(file: File, fields: Record<string, string | number | null | undefined>) {
  const fd = new FormData();
  fd.append("file", file);
  for (const [k, v] of Object.entries(fields)) if (v !== null && v !== undefined) fd.append(k, String(v));
  return fd;
}

export function analyzeAgainstHistory(channel: HistoryChannel, file: File, column?: number | null) {
  return api<HistoryAnalysis>(`/api/send-queue/filter/${channel}/analyze`, {
    method: "POST",
    body: form(file, { column }),
    notify: false, // read-only check — no "saved" toast
  });
}

/** Save the new-only file or the already-used report (binary, so a plain authenticated fetch). */
export async function downloadFiltered(channel: HistoryChannel, file: File, column: number, part: "new" | "used") {
  const token = getAccessToken();
  const res = await fetch(`/api/send-queue/filter/${channel}/download`, {
    method: "POST",
    credentials: "include",
    headers: token ? { Authorization: `Bearer ${token}` } : {},
    body: form(file, { column, part }),
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `Download failed (${res.status})`);
  }
  const name = /filename="([^"]+)"/.exec(res.headers.get("content-disposition") ?? "")?.[1] ?? `filtered-${part}`;
  const url = URL.createObjectURL(await res.blob());
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
