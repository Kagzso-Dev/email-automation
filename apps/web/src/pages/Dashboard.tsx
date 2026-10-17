import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { api } from "../lib/api";
import { PageHeader } from "../components/Layout";
import { Icon, type IconName } from "../components/icons";
import { ErrorNote, SkeletonCards } from "../components/ui";
import { useAuth } from "../lib/auth";
import { useAiCallsConfig } from "../lib/aiCalls";
import { useSidebarHiddenItems } from "../lib/sidebar";
import { useCallsDashboard, useEmailDashboard, useWhatsAppDashboard } from "../lib/dashboard";
import { SectionHeading, StatTile } from "../components/dashboard/parts";
import { ChannelSummary, type ChannelSummaryItem } from "../components/dashboard/ChannelSummary";
import { WhatsAppSection } from "../components/dashboard/WhatsAppSection";
import { CallsSection } from "../components/dashboard/CallsSection";
import { CallBillsTile, TotalCostLine, WhatsAppCostTile } from "../components/dashboard/CostCards";
import { useDashboardCosts } from "../lib/costs";
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

type Channel = "all" | "email" | "whatsapp" | "calls";
const CHANNEL_KEY = "dispatch:dashboard-channel";
const CHANNELS: { value: Channel; label: string }[] = [
  { value: "all", label: "All" },
  { value: "email", label: "Email" },
  { value: "whatsapp", label: "WhatsApp" },
  { value: "calls", label: "Calls" },
];

/** Last channel picked in this browser session (falls back to "All"). */
function readChannel(): Channel {
  try {
    const v = sessionStorage.getItem(CHANNEL_KEY);
    return CHANNELS.some((c) => c.value === v) ? (v as Channel) : "all";
  } catch {
    return "all";
  }
}

export function DashboardPage() {
  const [range, setRange] = useState(14);
  const { user } = useAuth();
  const isAdmin = user?.role === "ADMIN";
  // Same rules as the sidebar: calls and Call Flows (admins + editors) behind ENABLE_AI_CALLS; Call Flows also
  // needs the flow editor; a page hidden in Settings → Sidebar menu loses its links here (numbers stay).
  const aiCalls = useAiCallsConfig();
  const callsAllowed = !!aiCalls.data?.enabled && !!aiCalls.data.canStart;
  const hidden = new Set<string>(useSidebarHiddenItems());
  const showInboxLink = isAdmin && !hidden.has("whatsapp-inbox");
  const showFlowsLink = !!aiCalls.data?.flowEditor && !!aiCalls.data.canStart;

  const [picked, setPicked] = useState<Channel>(readChannel);
  const channel: Channel = picked === "calls" && !callsAllowed ? "all" : picked;
  useEffect(() => {
    try {
      sessionStorage.setItem(CHANNEL_KEY, picked);
    } catch {
      /* storage unavailable — non-fatal */
    }
  }, [picked]);
  const showEmail = channel === "all" || channel === "email";
  const showWhatsApp = channel === "all" || channel === "whatsapp";
  const showCalls = callsAllowed && (channel === "all" || channel === "calls");

  const emailDash = useEmailDashboard(range, showEmail);
  const waDash = useWhatsAppDashboard(range, showWhatsApp);
  const callsDash = useCallsDashboard(range, showCalls);
  // Cost cards (estimates from Settings → Cost rates); same range and refresh as the sections.
  const costs = useDashboardCosts(range, showWhatsApp || showCalls);
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

  const d = overview.data;

  const summary: ChannelSummaryItem[] = [
    {
      key: "email",
      label: "Emails sent",
      icon: "mail",
      value: emailDash.data?.totals.sent,
      delta: emailDash.data?.trend.delta,
      failed: !!emailDash.error && !emailDash.data,
    },
    {
      key: "whatsapp",
      label: "WhatsApp sent",
      icon: "whatsapp",
      value: waDash.data?.totals.sent,
      delta: waDash.data?.trend.delta,
      failed: !!waDash.error && !waDash.data,
    },
    ...(callsAllowed
      ? [
          {
            key: "calls" as const,
            label: "Calls made",
            icon: "phone" as const,
            value: callsDash.data?.totals.total,
            delta: callsDash.data?.trend.delta,
            failed: !!callsDash.error && !callsDash.data,
          },
        ]
      : []),
  ];

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

      {/* Channel switch + the shared range toggle (also kept on the engagement chart). */}
      <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
        <div role="group" aria-label="Channel">
          <RangeTabs
            options={CHANNELS.filter((c) => c.value !== "calls" || callsAllowed)}
            value={channel}
            onChange={setPicked}
          />
        </div>
        <div role="group" aria-label="Date range">
          <RangeTabs options={RANGES} value={range} onChange={setRange} />
        </div>
      </div>

      <div className="space-y-8">
        {channel === "all" && (
          <>
            <ChannelSummary items={summary} span={range} onPick={(k) => setPicked(k)} />
            <TotalCostLine costs={costs.data} />
          </>
        )}

        {showEmail && (
          <section aria-label="Email">
            <SectionHeading icon="mail" title="Email" />
            {overview.error ? (
              <ErrorNote error={overview.error} />
            ) : !d ? (
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
                  <MiniStat label="Active contacts" value={d.activeContacts} to="/contacts" icon="contacts" />
                  <MiniStat label="Active campaigns" value={d.activeCampaigns} to="/campaigns" icon="campaigns" />
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
                      <div className="skeleton h-[240px] rounded-lg" />
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
            {emailDash.data && (
              <div className="stagger mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
                <StatTile label="Open rate" value={emailDash.data.totals.openRate} format="pct" sub={`of ${emailDash.data.totals.sent.toLocaleString()} sent · last ${range} days`} />
                <StatTile label="Click rate" value={emailDash.data.totals.clickRate} format="pct" sub={`${emailDash.data.totals.clicked.toLocaleString()} clicked`} />
                <StatTile label="Bounced" value={emailDash.data.totals.bounced} />
                <StatTile label="Failed" value={emailDash.data.totals.failed} />
              </div>
            )}
          </section>
        )}

        {showWhatsApp && (
          <WhatsAppSection
            data={waDash.data}
            isLoading={waDash.isLoading}
            error={waDash.error}
            showInboxLink={showInboxLink}
            costTile={<WhatsAppCostTile costs={costs.data} isLoading={costs.isLoading} error={costs.error} isAdmin={isAdmin} />}
          />
        )}

        {showCalls && (
          <CallsSection
            data={callsDash.data}
            isLoading={callsDash.isLoading}
            error={callsDash.error}
            showCustomersLink={!hidden.has("ai-call-customers")}
            showFlowsLink={showFlowsLink}
            costTile={<CallBillsTile costs={costs.data} isLoading={costs.isLoading} error={costs.error} isAdmin={isAdmin} />}
          />
        )}
      </div>
    </div>
  );
}

function MiniStat({ label, value, to, icon }: { label: string; value: number; to: string; icon: IconName }) {
  const n = useCountUp(value);
  return (
    <Link to={to} className="card card-hover fade-rise flex flex-col justify-between">
      <div className="flex items-start justify-between gap-3">
        <div className="label">{label}</div>
        <span className="icon-chip h-9 w-9 shrink-0" aria-hidden="true">
          <Icon name={icon} size={18} />
        </span>
      </div>
      <div className="metric-value mt-2">{Math.round(n).toLocaleString()}</div>
      <div className="mt-1 text-xs text-accent-ink">View →</div>
    </Link>
  );
}
