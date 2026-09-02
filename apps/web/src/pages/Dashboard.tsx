import { useQuery } from "@tanstack/react-query";
import { api } from "../lib/api";
import { PageHeader } from "../components/Layout";
import { Spinner, ErrorNote } from "../components/ui";

interface Overview {
  sentToday: number;
  activeContacts: number;
  activeCampaigns: number;
  dailyCap: { used: number; limit: number };
  allTime: {
    counts: Record<string, number>;
    sent: number;
    openRate: number;
    clickRate: number;
    bounceRate: number;
  };
}

function Stat({ label, value, sub }: { label: string; value: string | number; sub?: string }) {
  return (
    <div className="card">
      <div className="label">{label}</div>
      <div className="font-mono text-2xl font-semibold tabular-nums">{value}</div>
      {sub && <div className="mt-1 text-xs text-slate-550">{sub}</div>}
    </div>
  );
}

export function DashboardPage() {
  const { data, isLoading, error } = useQuery({
    queryKey: ["overview"],
    queryFn: () => api<Overview>("/api/dashboard/overview"),
    refetchInterval: 15_000,
  });

  if (isLoading) return <Spinner />;
  if (error) return <ErrorNote error={error} />;
  if (!data) return null;

  const capPct = Math.round((data.dailyCap.used / Math.max(1, data.dailyCap.limit)) * 100);

  return (
    <div>
      <PageHeader title="Dashboard" />
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Stat label="Sent (24h)" value={data.sentToday} />
        <Stat
          label="Daily cap"
          value={`${data.dailyCap.used} / ${data.dailyCap.limit}`}
          sub={`${capPct}% used — SES sandbox`}
        />
        <Stat label="Open rate" value={`${data.allTime.openRate}%`} sub="all time" />
        <Stat label="Bounce rate" value={`${data.allTime.bounceRate}%`} sub="all time" />
        <Stat label="Active contacts" value={data.activeContacts} />
        <Stat label="Active campaigns" value={data.activeCampaigns} />
        <Stat label="Click rate" value={`${data.allTime.clickRate}%`} sub="all time" />
        <Stat label="Total delivered" value={data.allTime.counts.DELIVERED ?? 0} />
      </div>

      <h2 className="mb-3 mt-8 text-sm font-semibold uppercase tracking-wide text-slate-550">
        Lifetime status breakdown
      </h2>
      <div className="card">
        <div className="flex flex-wrap gap-x-8 gap-y-2 font-mono text-sm">
          {Object.entries(data.allTime.counts).map(([k, v]) => (
            <div key={k}>
              <span className="text-slate-550">{k}</span> <span className="tabular-nums">{v}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
