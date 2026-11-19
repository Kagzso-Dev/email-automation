// Send Queue → one batch row's cells (Email and WhatsApp tabs): status badge, copyable short ID, delivery bar and
// the merged "Started → Completed" time. Presentational only: each tab keeps its own queries and data types and
// hands these the fields below.

import { useEffect, useState } from "react";
import { Ban, Check, CircleCheck, CircleX, Copy, LoaderCircle, TriangleAlert, type LucideIcon } from "lucide-react";
import { formatClock, formatDateTime, formatDuration, formatShortDateTime } from "../../lib/schedule";
import { useToast } from "../toast";
import { Tooltip } from "../Tooltip";

export type BatchStatus = "RUNNING" | "DONE" | "CANCELLED";

/** The row fields both batch tabs share (a visual contract; the tabs' own row types are wider). */
export interface BatchSummary {
  id: string;
  templateName: string;
  total: number;
  status: BatchStatus;
  sent: number;
  failed: number;
  purgeAfter: boolean;
  startedAt: string;
  completedAt: string | null;
}

/**
 * What the badge says. The API has three batch states; a finished batch is shown as PARTIAL when some recipients
 * failed and some were sent, and as FAILED when every attempt failed.
 */
export type BatchDisplayStatus = "SENDING" | "DONE" | "PARTIAL" | "FAILED" | "CANCELLED";

export function batchDisplayStatus(b: Pick<BatchSummary, "status" | "sent" | "failed">): BatchDisplayStatus {
  if (b.status === "RUNNING") return "SENDING";
  if (b.status === "CANCELLED") return "CANCELLED";
  if (b.failed > 0) return b.sent > 0 ? "PARTIAL" : "FAILED";
  return "DONE";
}

const BADGE: Record<BatchDisplayStatus, { label: string; icon: LucideIcon; look: string; spin?: boolean }> = {
  DONE: { label: "Done", icon: CircleCheck, look: "border-ok-bright/40 bg-ok-soft text-ok" },
  SENDING: { label: "Sending", icon: LoaderCircle, look: "border-accent/30 bg-accent-soft text-accent-ink", spin: true },
  PARTIAL: { label: "Partial", icon: TriangleAlert, look: "border-warn-bright/50 bg-warn-soft text-warn" },
  FAILED: { label: "Failed", icon: CircleX, look: "border-crit-line bg-crit-soft text-crit" },
  CANCELLED: { label: "Cancelled", icon: Ban, look: "border-line bg-surface-muted text-slate-600" },
};

/** Status pill: a coloured label with an icon, so the state never depends on colour alone. */
export function BatchStatusBadge({ status }: { status: BatchDisplayStatus }) {
  const b = BADGE[status];
  const Glyph = b.icon;
  return (
    <span className={`inline-flex items-center gap-1.5 whitespace-nowrap rounded-full border px-2.5 py-1 text-xs font-semibold ${b.look}`}>
      <Glyph size={14} aria-hidden="true" className={b.spin ? "animate-spin motion-reduce:animate-none" : undefined} />
      {b.label}
    </span>
  );
}

/** A thin bar down the row's left edge, so batches with failures stand out while scanning. */
export const ROW_ACCENT: Record<BatchDisplayStatus, string> = {
  DONE: "",
  SENDING: "",
  CANCELLED: "",
  PARTIAL: "shadow-[inset_3px_0_0_rgb(var(--c-warn-bright))]",
  FAILED: "shadow-[inset_3px_0_0_rgb(var(--c-crit-bright))]",
};

/** The batch's first 8 characters in monospace; click copies the full ID. */
export function BatchIdButton({ id }: { id: string }) {
  const short = id.slice(0, 8);
  const toast = useToast();
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const t = window.setTimeout(() => setCopied(false), 1600);
    return () => window.clearTimeout(t);
  }, [copied]);

  return (
    <>
      <Tooltip label={copied ? "Copied" : "Copy full batch ID"}>
        <button
          type="button"
          aria-label={`Copy batch ID ${short}`}
          className="group/id -ml-1.5 inline-flex items-center gap-1.5 rounded-md px-1.5 py-0.5 font-mono text-[13px] text-ink transition-colors hover:bg-surface-muted"
          onClick={async (e) => {
            e.stopPropagation(); // don't also open / close the row
            try {
              await navigator.clipboard.writeText(id);
              setCopied(true);
            } catch {
              toast.error("Couldn't copy the batch ID", [id]); // shown in full so it can still be copied by hand
            }
          }}
        >
          {short}
          {copied ? (
            <Check size={14} aria-hidden="true" className="text-ok" />
          ) : (
            <Copy size={14} aria-hidden="true" className="text-slate-500 transition-colors group-hover/id:text-ink" />
          )}
        </button>
      </Tooltip>
      <span className="sr-only" role="status">
        {copied ? "Batch ID copied" : ""}
      </span>
    </>
  );
}

/** "1 / 25 sent · 24 failed" over a thin bar: green for sent, red for failed, grey for the rest. */
export function DeliveryProgress({ total, sent, failed }: { total: number; sent: number; failed: number }) {
  const pct = (n: number) => (total > 0 ? Math.min(100, (n / total) * 100) : 0);
  return (
    <div className="w-40 sm:w-44">
      <div className="flex items-baseline justify-between gap-2 text-xs">
        <span className="whitespace-nowrap tabular-nums text-slate-600">
          <span className="font-semibold text-ink">{sent}</span> / {total} sent
        </span>
        {failed > 0 && (
          <span className="inline-flex items-center gap-1 whitespace-nowrap font-semibold tabular-nums text-crit">
            <TriangleAlert size={12} aria-hidden="true" />
            {failed} failed
          </span>
        )}
      </div>
      {/* The numbers above carry the meaning; the bar is decoration for scanning. */}
      <div className="mt-1.5 flex h-1.5 overflow-hidden rounded-full bg-surface-muted" aria-hidden="true">
        <span className="h-full bg-ok-bright transition-[width] duration-500 motion-reduce:transition-none" style={{ width: `${pct(sent)}%` }} />
        <span className="h-full bg-crit-bright transition-[width] duration-500 motion-reduce:transition-none" style={{ width: `${pct(failed)}%` }} />
      </div>
    </div>
  );
}

const sameDay = (a: Date, b: Date) => a.toDateString() === b.toDateString();

/** "18 Nov, 3:32 pm" with "→ 3:38 pm · 6 min" under it (or "Sending · 4 min so far"); full dates on hover. */
export function TimeRange({ startedAt, completedAt }: { startedAt: string; completedAt: string | null }) {
  const start = new Date(startedAt);
  const end = completedAt ? new Date(completedAt) : null;
  const took = formatDuration((end ?? new Date()).getTime() - start.getTime());
  const full = `Started ${formatDateTime(startedAt)}${completedAt ? ` · Completed ${formatDateTime(completedAt)}` : " · still sending"}`;
  return (
    <div className="whitespace-nowrap" title={full}>
      <time dateTime={startedAt} className="text-sm text-ink">
        {formatShortDateTime(start)}
      </time>
      <div className="mt-0.5 text-xs text-slate-550">
        {end && completedAt ? (
          <>
            <span aria-hidden="true">→ </span>
            <span className="sr-only">completed </span>
            <time dateTime={completedAt}>{sameDay(start, end) ? formatClock(end) : formatShortDateTime(end)}</time> · {took}
          </>
        ) : (
          <>Sending · {took} so far</>
        )}
      </div>
    </div>
  );
}
