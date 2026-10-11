import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { api } from "./api";

/** Per-channel Dashboard numbers — read-only GET /api/dashboard/{email,whatsapp,calls}?days=7|14|30. */

export interface EmailDashboard {
  span: number;
  totals: { sent: number; opened: number; clicked: number; bounced: number; failed: number; openRate: number; clickRate: number };
  trend: { prevSent: number; delta: number | null };
}

export interface WhatsAppDashboard {
  span: number;
  totals: {
    sent: number;
    delivered: number;
    read: number;
    failed: number;
    successRate: number;
    /** The part of `sent` / `failed` that came from Send Queue batches (the rest are Inbox replies). */
    sentFromBatches: number;
    failedFromBatches: number;
    incoming: number;
    replies: number;
    activeContacts: number;
  };
  /** Null for non-admins — the Inbox is admin-only. */
  unread: { messages: number; conversations: number } | null;
  trend: { prevSent: number; delta: number | null };
  series: { date: string; sent: number; delivered: number; read: number; failed: number }[];
  recentBatches: {
    id: string;
    templateName: string;
    status: "RUNNING" | "DONE" | "CANCELLED";
    total: number;
    sent: number;
    failed: number;
    startedAt: string;
  }[];
  topTemplates: { id: string; name: string; sent: number }[];
}

export interface CallsDashboard {
  span: number;
  totals: {
    total: number;
    completed: number;
    noAnswer: number;
    busy: number;
    failed: number;
    inProgress: number;
    answeredRate: number;
    totalDurationSec: number;
    avgDurationSec: number;
    pendingFollowups: number;
    activeCustomers: number;
  };
  trend: { prevTotal: number; delta: number | null };
  series: { date: string; total: number; completed: number; unanswered: number }[];
  outcomes: { outcome: string; count: number }[];
  topFlows: { id: string | null; name: string; calls: number }[];
}

/** Auto-refresh cadence; react-query pauses it while the browser tab is hidden. */
const REFRESH_MS = 45_000;

const opts = {
  refetchInterval: REFRESH_MS,
  refetchIntervalInBackground: false,
  // Keep the previous range on screen while the next one loads — no flicker on range change or refresh.
  placeholderData: keepPreviousData,
} as const;

export function useEmailDashboard(days: number, enabled = true) {
  return useQuery({
    queryKey: ["dashboard-email", days],
    queryFn: () => api<EmailDashboard>(`/api/dashboard/email?days=${days}`),
    enabled,
    ...opts,
  });
}

export function useWhatsAppDashboard(days: number, enabled = true) {
  return useQuery({
    queryKey: ["dashboard-whatsapp", days],
    queryFn: () => api<WhatsAppDashboard>(`/api/dashboard/whatsapp?days=${days}`),
    enabled,
    ...opts,
  });
}

export function useCallsDashboard(days: number, enabled: boolean) {
  return useQuery({
    queryKey: ["dashboard-calls", days],
    queryFn: () => api<CallsDashboard>(`/api/dashboard/calls?days=${days}`),
    enabled,
    ...opts,
  });
}

/** "1m 05s" / "2h 03m" — for call durations. */
export function formatDuration(sec: number): string {
  if (sec <= 0) return "0s";
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  if (h > 0) return `${h}h ${String(m).padStart(2, "0")}m`;
  if (m > 0) return `${m}m ${String(s).padStart(2, "0")}s`;
  return `${s}s`;
}

/** "callback_requested" → "Callback requested". */
export function humanizeOutcome(o: string): string {
  const t = o.replace(/[_-]+/g, " ").trim();
  return t ? t.charAt(0).toUpperCase() + t.slice(1) : o;
}
