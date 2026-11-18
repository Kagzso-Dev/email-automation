// Hard stop (ENABLE_HARD_STOP): the "Hard stop" button, its status line ("Stopping... (N in progress)" → "Stopped"
// with the summary) and the cancelled-rows CSV downloads. Only rendered while the flag is on (useHardStopEnabled).
// Work already in progress (calls, messages, emails) always finishes: there is no hang-up or end-call option.

import { useState } from "react";
import { useMutation, useQueryClient, type QueryKey } from "@tanstack/react-query";
import {
  HARD_STOP_CONFIRM_TEXT,
  HARD_STOP_CSV_CHANNELS,
  hardStopStatusText,
  type HardStopCsvChannel,
  type HardStopResult,
  type HardStopScope,
  type HardStopView,
} from "@dispatch/shared";
import { api } from "../lib/api";
import { downloadCancelledCsv, hardStopPath, useLatestHardStop, useLatestStopAll, type HardStopTargetScope } from "../lib/hardStop";
import { formatDateTime } from "../lib/schedule";
import { useConfirm } from "./confirm";
import { ErrorNote } from "./ui";

const CSV_LABEL: Record<HardStopCsvChannel, string> = { email: "emails", whatsapp: "WhatsApp", calls: "calls" };

/** "Hard stop" with the confirmation, word for word. Shows the stop's status once pressed. */
export function HardStopButton({
  scope,
  targetId,
  label = "Hard stop",
  invalidate = [],
  className = "btn-danger",
}: {
  scope: HardStopScope;
  targetId: string | null;
  label?: string;
  /** Queries to refresh once the stop is applied (the list the button sits in). */
  invalidate?: QueryKey[];
  className?: string;
}) {
  const qc = useQueryClient();
  const confirm = useConfirm();
  const [stop, setStop] = useState<HardStopView | null>(null);
  const press = useMutation({
    mutationFn: () => api<HardStopResult>(hardStopPath(scope, targetId), { method: "POST", notify: "Hard stop applied" }),
    onSuccess: (r) => {
      setStop(r.stop);
      for (const key of invalidate) void qc.invalidateQueries({ queryKey: key });
      void qc.invalidateQueries({ queryKey: scope === "ALL" ? ["hard-stop-latest-all"] : ["hard-stop-latest", scope, targetId] });
    },
  });

  async function ask() {
    const ok = await confirm({
      title: scope === "ALL" ? "Stop all running sends?" : "Hard stop this send?",
      body: HARD_STOP_CONFIRM_TEXT,
      confirmText: label,
      tone: "danger",
    });
    if (ok) press.mutate();
  }

  return (
    <span className="inline-flex flex-col items-end gap-1">
      <button type="button" className={className} disabled={press.isPending || (!!stop && scope !== "ALL")} onClick={() => void ask()}>
        {press.isPending ? "Stopping…" : label}
      </button>
      {press.error && <ErrorNote error={press.error} />}
      {stop && scope !== "ALL" && targetId && <HardStopTargetStatus scope={scope} targetId={targetId} />}
    </span>
  );
}

/** The status of the newest stop that covered this send, if any (nothing at all when none). */
export function HardStopTargetStatus({ scope, targetId, compact = false }: { scope: HardStopTargetScope; targetId: string; compact?: boolean }) {
  const q = useLatestHardStop(scope, targetId, true);
  if (!q.data?.stop) return null;
  return <HardStopStatus stop={q.data.stop} compact={compact} />;
}

/** "Stopping... (N in progress)" until the last in-progress item ends, then "Stopped" with the summary. */
export function HardStopStatus({ stop, compact = false }: { stop: HardStopView; compact?: boolean }) {
  const [error, setError] = useState<unknown>(null);
  const channels = HARD_STOP_CSV_CHANNELS.filter((c) => stop.csvRows[c] > 0);
  const paused = [
    ...stop.paused.campaigns.map((c) => `campaign "${c.name}"`),
    ...stop.paused.triggers.map((t) => `trigger "${t.name}"`),
  ];
  return (
    <div className={`text-xs ${compact ? "" : "rounded-lg border border-line bg-surface-sunken px-3 py-2"}`} role="status">
      <div className={stop.status === "STOPPING" ? "font-medium text-warn" : "font-medium text-ink"}>{hardStopStatusText(stop)}</div>
      {!compact && <div className="mt-0.5 text-slate-550">{stop.reason}</div>}
      {!compact && stop.finishedAt && <div className="text-slate-550">Finished {formatDateTime(stop.finishedAt)}</div>}
      {!compact && paused.length > 0 && (
        <div className="mt-1 text-slate-550">
          Paused so nothing new starts by itself (turn back on with Schedule / the trigger switch): {paused.join(", ")}
        </div>
      )}
      {channels.length > 0 && (
        <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1">
          {channels.map((c) => (
            <button
              key={c}
              type="button"
              className="text-accent-ink hover:underline"
              onClick={() => {
                setError(null);
                downloadCancelledCsv(stop.id, c).catch(setError);
              }}
            >
              Download cancelled {CSV_LABEL[c]} (CSV, {stop.csvRows[c]})
            </button>
          ))}
        </div>
      )}
      {error ? <ErrorNote error={error} /> : null}
    </div>
  );
}

/** Admins: "Stop all running sends" (Email, WhatsApp, Calls in every language, Send Queue) and its latest status. */
export function StopAllRunningSends() {
  const latest = useLatestStopAll(true);
  const stop = latest.data?.stop;
  return (
    <div className="mb-4 flex flex-wrap items-start justify-end gap-3">
      {stop && <HardStopStatus stop={stop} />}
      <HardStopButton scope="ALL" targetId={null} label="Stop all running sends" invalidate={[["email-batches"], ["whatsapp-batches"], ["ai-call-followups"]]} />
    </div>
  );
}
