import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { AreaChart, ChartCard, Legend } from "../charts";
import { Badge, ErrorNote, type BadgeTone } from "../ui";
import type { WhatsAppDashboard } from "../../lib/dashboard";
import { ChartEmpty, SectionHeading, SectionSkeleton, StatTile } from "./parts";

const WA_SERIES = [
  { key: "sent", label: "Sent", color: "#0091d5" },
  { key: "delivered", label: "Delivered", color: "#009a80" },
  { key: "read", label: "Read", color: "#7a5af5" },
  { key: "failed", label: "Failed", color: "#ef4444" },
] as const;

const BATCH_TONE: Record<string, BadgeTone> = { RUNNING: "warn", DONE: "ok", CANCELLED: "neutral" };

const full = new Intl.NumberFormat("en");

export function WhatsAppSection({
  data,
  isLoading,
  error,
  showInboxLink,
}: {
  data: WhatsAppDashboard | undefined;
  isLoading: boolean;
  error: unknown;
  /** Admin, and "WhatsApp Inbox" isn't hidden in Settings → Sidebar menu. */
  showInboxLink: boolean;
}) {
  const [active, setActive] = useState<Record<string, boolean>>({ sent: true, delivered: true, read: true, failed: true });
  const series = useMemo(() => WA_SERIES.filter((s) => active[s.key]).map((s) => ({ ...s })), [active]);

  const unread = data?.unread ?? null;
  const inboxAction =
    showInboxLink && unread && unread.messages > 0 ? (
      <Link to="/whatsapp-inbox" className="btn-ghost py-1.5 text-xs">
        {unread.messages} unread in Inbox →
      </Link>
    ) : null;

  return (
    <section aria-label="WhatsApp">
      <SectionHeading icon="whatsapp" title="WhatsApp" action={inboxAction} />
      {error && !data ? (
        <ErrorNote error={error} />
      ) : isLoading || !data ? (
        <SectionSkeleton tiles={6} />
      ) : (
        <div className="space-y-4">
          <div className={`grid gap-4 sm:grid-cols-2 ${unread ? "lg:grid-cols-3 xl:grid-cols-6" : "lg:grid-cols-5"}`}>
            <StatTile label="Sent" value={data.totals.sent} sub={`${data.totals.successRate.toFixed(1)}% success`} />
            <StatTile label="Delivered" value={data.totals.delivered} />
            <StatTile label="Read" value={data.totals.read} />
            <StatTile label="Failed" value={data.totals.failed} />
            <StatTile label="Incoming" value={data.totals.incoming} sub={`${full.format(data.totals.replies)} replies to your messages`} />
            {unread && (
              <StatTile
                label="Unread"
                value={unread.messages}
                sub={`${full.format(unread.conversations)} conversation${unread.conversations === 1 ? "" : "s"}`}
                to={showInboxLink ? "/whatsapp-inbox" : undefined}
              />
            )}
          </div>

          <ChartCard
            title="WhatsApp messages over time"
            subtitle={`Daily sent, delivered, read and failed · last ${data.span} days`}
            right={
              <Legend
                items={WA_SERIES.map((s) => ({ ...s }))}
                active={active}
                onToggle={(k) => setActive((a) => ({ ...a, [k]: !a[k] }))}
              />
            }
          >
            {data.series.every((p) => p.sent + p.delivered + p.read + p.failed === 0) ? (
              <ChartEmpty>No WhatsApp activity in this period.</ChartEmpty>
            ) : series.length === 0 ? (
              <ChartEmpty>Select a series from the legend.</ChartEmpty>
            ) : (
              <AreaChart data={data.series} series={series} height={220} />
            )}
            <div className="mt-3 flex flex-wrap gap-x-6 gap-y-1 border-t border-line-subtle pt-3 text-xs text-slate-550">
              <span>
                From Send Queue batches <b className="text-ink">{full.format(data.totals.sentFromBatches)}</b> sent ·{" "}
                <b className="text-ink">{full.format(data.totals.failedFromBatches)}</b> failed
              </span>
              <span>
                Active contacts <b className="text-ink">{full.format(data.totals.activeContacts)}</b>
              </span>
            </div>
          </ChartCard>

          <div className="grid gap-4 lg:grid-cols-2">
            <div className="card">
              <div className="mb-3 flex items-center justify-between gap-2">
                <h3 className="text-sm font-bold tracking-[-0.01em] text-ink">Recent batches</h3>
                <Link to="/send-queue" className="text-xs font-medium text-accent-ink hover:underline">
                  Send Queue →
                </Link>
              </div>
              {data.recentBatches.length === 0 ? (
                <p className="py-6 text-center text-sm text-slate-550">No WhatsApp batches yet.</p>
              ) : (
                <div className="-mx-5 overflow-x-auto">
                  <table className="table-soft w-full min-w-[28rem] text-sm">
                    <thead>
                      <tr className="text-left">
                        <th className="px-5 py-2 font-semibold uppercase">Template</th>
                        <th className="px-2 py-2 text-right font-semibold uppercase">Recipients</th>
                        <th className="px-2 py-2 text-right font-semibold uppercase">Sent</th>
                        <th className="px-2 py-2 text-right font-semibold uppercase">Failed</th>
                        <th className="px-5 py-2 font-semibold uppercase">Status</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.recentBatches.map((b) => (
                        <tr key={b.id} className="border-t border-line-subtle">
                          <td className="max-w-[12rem] truncate px-5 py-2.5 font-medium text-ink" title={b.templateName}>
                            {b.templateName}
                          </td>
                          <td className="px-2 py-2.5 text-right tabular-nums">{full.format(b.total)}</td>
                          <td className="px-2 py-2.5 text-right tabular-nums">{full.format(b.sent)}</td>
                          <td className={`px-2 py-2.5 text-right tabular-nums ${b.failed > 0 ? "text-crit" : ""}`}>{full.format(b.failed)}</td>
                          <td className="px-5 py-2.5">
                            <Badge tone={BATCH_TONE[b.status] ?? "neutral"}>{b.status.toLowerCase()}</Badge>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>

            <div className="card">
              <h3 className="mb-3 text-sm font-bold tracking-[-0.01em] text-ink">Top templates</h3>
              {data.topTemplates.length === 0 ? (
                <p className="py-6 text-center text-sm text-slate-550">No template messages sent in this period.</p>
              ) : (
                <RankedBars items={data.topTemplates.map((t) => ({ key: t.id, label: t.name, value: t.sent }))} unit="sent" />
              )}
            </div>
          </div>
        </div>
      )}
    </section>
  );
}

/** Small horizontal bars for a top-N list (templates, flows). */
export function RankedBars({ items, unit }: { items: { key: string; label: string; value: number }[]; unit: string }) {
  const max = Math.max(1, ...items.map((i) => i.value));
  return (
    <ul className="space-y-2.5">
      {items.map((i) => (
        <li key={i.key}>
          <div className="mb-1 flex items-baseline justify-between gap-3 text-xs">
            <span className="truncate font-medium text-ink" title={i.label}>
              {i.label}
            </span>
            <span className="shrink-0 tabular-nums text-slate-550">
              {full.format(i.value)} {unit}
            </span>
          </div>
          <div className="h-2 overflow-hidden rounded-full bg-surface-muted">
            <div className="h-full rounded-full bg-gradient-accent" style={{ width: `${Math.max(3, (i.value / max) * 100)}%` }} />
          </div>
        </li>
      ))}
    </ul>
  );
}
