import { useMemo, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { AreaChart, ChartCard, Donut, Legend } from "../charts";
import { ErrorNote } from "../ui";
import { formatDuration, humanizeOutcome, type CallsDashboard } from "../../lib/dashboard";
import { ChartEmpty, SectionHeading, SectionSkeleton, StatTile } from "./parts";
import { RankedBars } from "./WhatsAppSection";

const CALL_SERIES = [
  { key: "total", label: "Calls", color: "#0091d5" },
  { key: "completed", label: "Answered", color: "#009a80" },
  { key: "unanswered", label: "No answer / failed", color: "#eb6834" },
] as const;

// Outcome slices: accent hues first, then neutrals; identity also carried by the legend text.
const OUTCOME_COLORS = ["#0091d5", "#009a80", "#eb6834", "#7a5af5", "#d4870a", "#ef4444", "#8a94a6", "#c7d2e6"];

const full = new Intl.NumberFormat("en");

export function CallsSection({
  data,
  isLoading,
  error,
  showCustomersLink,
  showFlowsLink,
  costTile,
}: {
  data: CallsDashboard | undefined;
  isLoading: boolean;
  error: unknown;
  showCustomersLink: boolean;
  showFlowsLink: boolean;
  /** Optional "Call bills" card, shown after the stat cards. */
  costTile?: ReactNode;
}) {
  const [active, setActive] = useState<Record<string, boolean>>({ total: true, completed: true, unanswered: true });
  const series = useMemo(() => CALL_SERIES.filter((s) => active[s.key]).map((s) => ({ ...s })), [active]);

  const customersAction = showCustomersLink ? (
    <Link to="/ai-call-customers" className="btn-ghost py-1.5 text-xs">
      {data ? `${full.format(data.totals.activeCustomers)} customers` : "AI Call Customers"} →
    </Link>
  ) : null;

  return (
    <section aria-label="Calls">
      <SectionHeading icon="phone" title="AI Calls" action={customersAction} />
      {error && !data ? (
        <ErrorNote error={error} />
      ) : isLoading || !data ? (
        <SectionSkeleton tiles={4} />
      ) : (
        <div className="space-y-4">
          <div className={`stagger grid gap-4 sm:grid-cols-2 ${costTile ? "lg:grid-cols-3 xl:grid-cols-5" : "lg:grid-cols-4"}`}>
            <StatTile
              label="Total calls"
              value={data.totals.total}
              sub={`${full.format(data.totals.completed)} answered · ${full.format(data.totals.noAnswer + data.totals.busy)} no answer · ${full.format(data.totals.failed)} failed`}
            />
            <StatTile
              label="Answered rate"
              value={data.totals.answeredRate}
              format="pct"
              sub={data.totals.inProgress > 0 ? `${data.totals.inProgress} still in progress` : "of finished calls"}
            />
            <StatTile
              label="Avg duration"
              value={data.totals.avgDurationSec}
              display={formatDuration(data.totals.avgDurationSec)}
              sub={`${formatDuration(data.totals.totalDurationSec)} in total`}
            />
            <StatTile
              label="Pending follow-ups"
              value={data.totals.pendingFollowups}
              sub="Waiting for approval in Send Queue"
              to="/send-queue"
            />
            {costTile}
          </div>

          <div className={`grid gap-4 ${data.outcomes.length > 0 ? "lg:grid-cols-[1.6fr_1fr]" : ""}`}>
            <ChartCard
              title="Calls over time"
              subtitle={`Daily calls placed · last ${data.span} days`}
              right={
                <Legend
                  items={CALL_SERIES.map((s) => ({ ...s }))}
                  active={active}
                  onToggle={(k) => setActive((a) => ({ ...a, [k]: !a[k] }))}
                />
              }
            >
              {data.totals.total === 0 ? (
                <ChartEmpty>No calls in this period.</ChartEmpty>
              ) : series.length === 0 ? (
                <ChartEmpty>Select a series from the legend.</ChartEmpty>
              ) : (
                <AreaChart data={data.series} series={series} height={220} />
              )}
            </ChartCard>

            {data.outcomes.length > 0 && (
              <ChartCard title="Outcomes" subtitle="As classified after each call">
                <Donut
                  size={140}
                  thickness={18}
                  centerLabel="with an outcome"
                  centerValue={full.format(data.outcomes.reduce((s, o) => s + o.count, 0))}
                  segments={data.outcomes.map((o, i) => ({
                    label: humanizeOutcome(o.outcome),
                    value: o.count,
                    color: OUTCOME_COLORS[i % OUTCOME_COLORS.length]!,
                  }))}
                />
              </ChartCard>
            )}
          </div>

          <div className="card">
            <div className="mb-3 flex items-center justify-between gap-2">
              <h3 className="text-sm font-bold tracking-[-0.01em] text-ink">Calls by flow</h3>
              {showFlowsLink && (
                <Link to="/call-flows" className="text-xs font-medium text-accent-ink hover:underline">
                  Call Flows →
                </Link>
              )}
            </div>
            {data.topFlows.length === 0 ? (
              <p className="py-6 text-center text-sm text-slate-550">No calls in this period.</p>
            ) : (
              <RankedBars items={data.topFlows.map((f) => ({ key: f.id ?? "default", label: f.name, value: f.calls }))} unit="calls" />
            )}
          </div>
        </div>
      )}
    </section>
  );
}
