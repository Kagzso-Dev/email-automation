// Hard stop (ENABLE_HARD_STOP): the shapes the API returns and the web app shows. Work already in progress (an email
// being sent, a WhatsApp message being sent, a call dialing / ringing / connected) always finishes; everything not
// started is cancelled. See apps/api/src/domain/hardStop.ts.

/** The confirmation every Hard stop button asks, word for word. */
export const HARD_STOP_CONFIRM_TEXT =
  "Items already in progress (calls, messages, emails) will finish. Everything not started will be cancelled, including retries and follow-ups. This cannot be undone.";

/** ALL = Stop all; *_BATCH / AI_CALL_RUN / CAMPAIGN = one send; EMAIL / WHATSAPP / CALLS (one language) = a section's button. */
export const HARD_STOP_SCOPES = ["ALL", "EMAIL_BATCH", "WHATSAPP_BATCH", "AI_CALL_RUN", "CAMPAIGN", "EMAIL", "WHATSAPP", "CALLS"] as const;
export type HardStopScope = (typeof HARD_STOP_SCOPES)[number];
export type HardStopSection = "EMAIL" | "WHATSAPP" | "CALLS";

/** One file per channel in the cancelled-rows download, with the columns that channel's import accepts. */
export const HARD_STOP_CSV_CHANNELS = ["email", "whatsapp", "calls"] as const;
export type HardStopCsvChannel = (typeof HARD_STOP_CSV_CHANNELS)[number];

export interface HardStopView {
  id: string;
  scope: HardStopScope;
  targetId: string | null;
  status: "STOPPING" | "STOPPED";
  /** "Hard stop by <email> at <time>", the reason written on every cancelled row. */
  reason: string;
  byEmail: string;
  createdAt: string;
  finishedAt: string | null;
  /** Items in progress at the stop that are still finishing now ("Stopping... (N in progress)"). */
  inProgress: number;
  /** Items in progress when the stop was pressed (audit). */
  inProgressAtStop: number;
  /** Items that finished, including the ones in progress at the stop. Final once STOPPED. */
  completed: number;
  /** Items cancelled before they started. */
  cancelled: number;
  /** Approved follow-ups waiting for their time, and email retries, that were cancelled. */
  followupsCancelled: number;
  /** Stop all only: what it paused so nothing new starts by itself (turned back on with the existing controls). */
  paused: { campaigns: { id: string; name: string }[]; triggers: { id: string; name: string }[] };
  /** Rows in each cancelled-rows CSV (0 = nothing to download for that channel). */
  csvRows: Record<HardStopCsvChannel, number>;
}

/** POST answer: the stop, and whether this press created it (false = a stop for this target was already open). */
export interface HardStopResult {
  stop: HardStopView;
  created: boolean;
}

/** The status line under a Hard stop button. */
export function hardStopStatusText(v: Pick<HardStopView, "status" | "inProgress" | "completed" | "cancelled" | "followupsCancelled">): string {
  if (v.status === "STOPPING") return `Stopping... (${v.inProgress} in progress)`;
  return `Stopped: ${v.completed} completed (including those in progress), ${v.cancelled} cancelled, and ${v.followupsCancelled} follow-ups/retries cancelled`;
}
