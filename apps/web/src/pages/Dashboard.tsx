import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { api } from "../lib/api";
import { PageHeader } from "../components/Layout";
import { ErrorNote, SkeletonCards } from "../components/ui";
import {
  AreaChart,
  CapMeter,
  ChartCard,
  Legend,
  RangeTabs,
  SERIES,
  useCountUp,
} from "../components/charts";

interface Overview {
  sentToday: number;
  activeContacts: number;
  activeCampaigns: number;
  dailyCap: { used: number; limit: number };
}
interface Timeseries {
  span: number;
  points: { date: string; sent: number; opened: number; clicked: number }[];
}

const RANGES = [
  { value: 7, label: "7d" },
  { value: 14, label: "14d" },
  { value: 30, label: "30d" },
];

type TsPoint = Timeseries["points"][number];
/** Sum one numeric field over the series points. */
const sum = (arr: TsPoint[], k: "sent" | "opened" | "clicked") =>
  arr.reduce((s, x) => s + x[k], 0);

export function DashboardPage() {
  const [range, setRange] = useState(14);
  const [active, setActive] = useState<Record<string, boolean>>({
    sent: true,
    opened: true,
    clicked: true,
  });

  const overview = useQuery({
    queryKey: ["overview"],
    queryFn: () => api<Overview>("/api/dashboard/overview"),
    refetchInterval: 15_000,
  });
  const ts = useQuery({
    queryKey: ["dashboard-timeseries", range],
    queryFn: () => api<Timeseries>(`/api/dashboard/timeseries?days=${range}`),
    refetchInterval: 30_000,
  });

  const points = ts.data?.points ?? [];

  const series = useMemo(
    () =>
      (["sent", "opened", "clicked"] as const)
        .filter((k) => active[k])
        .map((k) => ({ key: k, label: k.charAt(0).toUpperCase() + k.slice(1), color: SERIES[k] })),
    [active],
  );

  const legendItems = [
    { key: "sent", label: "Sent", color: SERIES.sent },
    { key: "opened", label: "Opened", color: SERIES.opened },
    { key: "clicked", label: "Clicked", color: SERIES.clicked },
  ];

  if (overview.error) return <ErrorNote error={overview.error} />;

  const d = overview.data;

  return (
    <div>
      <PageHeader
        title="Dashboard"
        subtitle="Live delivery and engagement across every campaign and trigger."
        action={
          <Link to="/insights" className="btn-ghost">
            View insights →
          </Link>
        }
      />

      {!d ? (
        <SkeletonCards count={4} />
      ) : (
        <>
          <div className="grid gap-4 lg:grid-cols-3">
            <div className="card fade-rise lg:col-span-1">
              <div className="label">Daily send cap</div>
              <div className="mt-3">
                <CapMeter used={d.dailyCap.used} limit={d.dailyCap.limit} />
              </div>
              <p className="mt-3 text-xs text-slate-550">
                {Math.max(0, d.dailyCap.limit - d.dailyCap.used)} sends left in the rolling 24h window.
              </p>
            </div>
            <MiniStat label="Active contacts" value={d.activeContacts} to="/contacts" />
            <MiniStat label="Active campaigns" value={d.activeCampaigns} to="/campaigns" />
          </div>

          <div className="mt-4">
            <ChartCard
              title="Engagement over time"
              subtitle={`Daily send, open and click events · last ${range} days`}
              right={
                <div className="flex flex-col items-end gap-2">
                  <RangeTabs options={RANGES} value={range} onChange={setRange} />
                  <Legend
                    items={legendItems}
                    active={active}
                    onToggle={(k) => setActive((a) => ({ ...a, [k]: !a[k] }))}
                  />
                </div>
              }
            >
              {ts.isLoading ? (
                <div className="h-[240px] animate-pulse rounded-lg bg-surface-muted" />
              ) : points.length === 0 ? (
                <div className="grid h-[240px] place-items-center text-sm text-slate-550">
                  No activity in this window yet.
                </div>
              ) : series.length === 0 ? (
                <div className="grid h-[240px] place-items-center text-sm text-slate-550">
                  Select a series from the legend.
                </div>
              ) : (
                <AreaChart data={points} series={series} />
              )}
              {points.length > 0 && (
                <div className="mt-3 flex flex-wrap gap-x-6 gap-y-1 border-t border-line-subtle pt-3 text-xs text-slate-550">
                  <span>
                    Sent <b className="text-ink">{sum(points, "sent").toLocaleString()}</b>
                  </span>
                  <span>
                    Opened <b className="text-ink">{sum(points, "opened").toLocaleString()}</b>
                  </span>
                  <span>
                    Clicked <b className="text-ink">{sum(points, "clicked").toLocaleString()}</b>
                  </span>
                </div>
              )}
            </ChartCard>
          </div>
        </>
      )}
    </div>
  );
}

function MiniStat({ label, value, to }: { label: string; value: number; to: string }) {
  const n = useCountUp(value);
  return (
    <Link to={to} className="card card-hover fade-rise flex flex-col justify-between">
      <div className="label">{label}</div>
      <div className="metric-value mt-2">{Math.round(n).toLocaleString()}</div>
      <div className="mt-1 text-xs text-accent-ink">View →</div>
    </Link>
  );
}
