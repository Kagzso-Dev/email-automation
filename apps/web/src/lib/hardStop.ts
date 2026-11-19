// Hard stop (ENABLE_HARD_STOP): a "Hard stop" button on each running send and "Stop all running sends" (admins).
// Work already in progress (calls, messages, emails) always finishes; everything not started is cancelled. Read from
// GET /api/hard-stop/config: loading, an error, or an API without the endpoint all count as OFF, so every page works
// exactly as before.

import { useQuery } from "@tanstack/react-query";
import type { HardStopCsvChannel, HardStopScope, HardStopSection, HardStopView } from "@dispatch/shared";
import { api, apiResponse } from "./api";

/** A stop of one send (its row, its call run, its campaign). */
export type HardStopTargetScope = "EMAIL_BATCH" | "WHATSAPP_BATCH" | "AI_CALL_RUN" | "CAMPAIGN";

const CONFIG_KEY = ["hard-stop-config"] as const;

/** The flag for rendering (OFF until it is known, and on any error). */
export function useHardStopEnabled(): boolean {
  const q = useQuery({
    queryKey: CONFIG_KEY,
    queryFn: () => api<{ enabled: boolean }>("/api/hard-stop/config").catch(() => ({ enabled: false })),
    staleTime: 60_000,
    retry: false,
  });
  return q.data?.enabled === true;
}

const PRESS_PATH: Record<HardStopScope, (id: string | null) => string> = {
  EMAIL_BATCH: (id) => `/api/hard-stop/email-batches/${id}`,
  WHATSAPP_BATCH: (id) => `/api/hard-stop/whatsapp-batches/${id}`,
  AI_CALL_RUN: (id) => `/api/hard-stop/ai-call-runs/${id}`,
  CAMPAIGN: (id) => `/api/hard-stop/campaigns/${id}`,
  ALL: () => "/api/hard-stop/all",
  // A section's button; for CALLS the id is the language (en, ta, …).
  EMAIL: () => "/api/hard-stop/sections/email",
  WHATSAPP: () => "/api/hard-stop/sections/whatsapp",
  CALLS: (lang) => `/api/hard-stop/sections/calls/${lang}`,
};

export function hardStopPath(scope: HardStopScope, targetId: string | null): string {
  return PRESS_PATH[scope](targetId);
}

/** Poll every 3 s while "Stopping... (N in progress)". */
const pollWhileStopping = (q: { state: { data?: { stop?: HardStopView | null } | HardStopView | null } }) => {
  const d = q.state.data;
  const stop = d && "stop" in d ? d.stop : (d as HardStopView | null | undefined);
  return stop?.status === "STOPPING" ? 3000 : false;
};

/** The newest stop that covered this send (its own Hard stop, or a Stop all), or null. */
export function useLatestHardStop(scope: HardStopTargetScope, targetId: string, enabled: boolean) {
  return useQuery({
    queryKey: ["hard-stop-latest", scope, targetId],
    queryFn: () => api<{ stop: HardStopView | null }>(`/api/hard-stop/latest?scope=${scope}&targetId=${encodeURIComponent(targetId)}`),
    enabled,
    refetchInterval: pollWhileStopping,
  });
}

/** The newest stop of one section's button (CALLS: of that language), or null. */
export function useLatestSectionStop(section: HardStopSection, language: string | null, enabled = true) {
  return useQuery({
    queryKey: ["hard-stop-latest-section", section, language],
    queryFn: () =>
      api<{ stop: HardStopView | null }>(`/api/hard-stop/latest-section?scope=${section}${section === "CALLS" && language ? `&language=${language}` : ""}`),
    enabled,
    refetchInterval: pollWhileStopping,
  });
}

/** The newest Stop all (admins), or null. */
export function useLatestStopAll(enabled: boolean) {
  return useQuery({
    queryKey: ["hard-stop-latest-all"],
    queryFn: () => api<{ stop: HardStopView | null }>("/api/hard-stop/latest-all"),
    enabled,
    refetchInterval: pollWhileStopping,
  });
}

/** Save one channel's cancelled rows as a CSV file (for a later send). */
export async function downloadCancelledCsv(stopId: string, channel: HardStopCsvChannel): Promise<void> {
  const res = await apiResponse(`/api/hard-stop/${stopId}/cancelled.csv?channel=${channel}`);
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? res.statusText);
  }
  const name = /filename="([^"]+)"/.exec(res.headers.get("content-disposition") ?? "")?.[1] ?? `hard-stop-cancelled-${channel}.csv`;
  const url = URL.createObjectURL(await res.blob());
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
