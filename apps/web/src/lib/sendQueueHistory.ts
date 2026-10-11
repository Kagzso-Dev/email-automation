import { useQuery } from "@tanstack/react-query";
import { api, getAccessToken } from "./api";

/** Send Queue → "Download all history": the full history of one tab's channel (GET /api/send-queue/history/:channel/*). */
export type HistoryExportChannel = "email" | "whatsapp" | "ai-followups";

/** How many rows the export would contain (0 → the button is disabled). */
export function useHistoryExportCount(channel: HistoryExportChannel) {
  return useQuery({
    queryKey: ["send-queue-history-count", channel],
    queryFn: () => api<{ rows: number }>(`/api/send-queue/history/${channel}/count`),
    staleTime: 30_000,
  });
}

/** Stream the CSV and save it (binary-safe, so a plain authenticated fetch rather than api()). */
export async function downloadHistoryExport(channel: HistoryExportChannel) {
  const token = getAccessToken();
  const res = await fetch(`/api/send-queue/history/${channel}/export`, {
    credentials: "include",
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `Export failed (${res.status})`);
  }
  // A failure part-way through aborts the stream, so this rejects instead of saving a cut-off file.
  const blob = await res.blob();
  const name =
    /filename="([^"]+)"/.exec(res.headers.get("content-disposition") ?? "")?.[1] ??
    `send-history-${channel}-${new Date().toISOString().slice(0, 10)}.csv`;
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
