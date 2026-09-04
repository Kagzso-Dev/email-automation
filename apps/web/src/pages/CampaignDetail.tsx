import { Link, useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../lib/api";
import { Badge, campaignTone, ErrorNote, Spinner } from "../components/ui";
import { describeCron, formatDateTime } from "../lib/schedule";
import { AreaChart, ChartCard, Donut, Funnel, Legend, SERIES } from "../components/charts";

interface Campaign {
  id: string;
  name: string;
  status: string;
  scheduleType: string;
  sendAt?: string | null;
  cronExpression?: string | null;
  lastRunAt?: string | null;
  template: { id: string; name: string; subject: string };
  list: { name: string; _count: { members: number } };
}
interface Stats {
  counts: Record<string, number>;
  series: { date: string; sent: number; opened: number; clicked: number }[];
  sent: number;
  openRate: number;
  clickRate: number;
  bounceRate: number;
  complaintRate: number;
}

export function CampaignDetailPage() {
  const { id } = useParams<{ id: string }>();
  const qc = useQueryClient();

  const campaign = useQuery({
    queryKey: ["campaign", id],
    queryFn: () => api<Campaign>(`/api/campaigns/${id}`),
  });
  const stats = useQuery({
    queryKey: ["campaign-stats", id],
    queryFn: () => api<Stats>(`/api/campaigns/${id}/stats`),
    refetchInterval: 5000,
  });

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ["campaign", id] });
    qc.invalidateQueries({ queryKey: ["campaigns"] });
  };
  const pause = useMutation({
    mutationFn: () => api(`/api/campaigns/${id}/pause`, { method: "POST" }),
    onSuccess: invalidate,
  });
  const resume = useMutation({
    mutationFn: () => api(`/api/campaigns/${id}/schedule`, { method: "POST" }),
    onSuccess: invalidate,
  });
  const sendNow = useMutation({
    mutationFn: () => api(`/api/campaigns/${id}/send-now`, { method: "POST" }),
    onSuccess: invalidate,
  });

  if (campaign.isLoading) return <Spinner />;
  if (campaign.error) return <ErrorNote error={campaign.error} />;
  const c = campaign.data!;

  return (
    <div>
      <Link to="/campaigns" className="text-sm text-accent-ink hover:underline">
        ← Campaigns
      </Link>
      <div className="mb-6 mt-2 flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-xl font-semibold">{c.name}</h1>
          <div className="mt-1 flex flex-wrap items-center gap-2 text-sm text-slate-550">
            <Badge tone={campaignTone[c.status] ?? "neutral"}>{c.status}</Badge>
            <span>
              {c.scheduleType === "ONCE"
                ? c.sendAt && formatDateTime(c.sendAt)
                : describeCron(c.cronExpression)}
            </span>
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          {["SCHEDULED", "SENDING"].includes(c.status) && (
            <button className="btn-ghost" onClick={() => pause.mutate()} disabled={pause.isPending}>
              Pause
            </button>
          )}
          {["PAUSED", "DRAFT"].includes(c.status) && (
            <button className="btn-ghost" onClick={() => resume.mutate()} disabled={resume.isPending}>
              Schedule
            </button>
          )}
          <button className="btn-primary" onClick={() => sendNow.mutate()} disabled={sendNow.isPending}>
            Send now
          </button>
        </div>
      </div>

      {sendNow.error ? <div className="mb-4"><ErrorNote error={sendNow.error} /></div> : null}

      <div className="mb-6 grid gap-4 sm:grid-cols-3">
        <div className="card">
          <div className="label">Template</div>
          <div className="font-medium">{c.template.name}</div>
          <div className="text-xs text-slate-550">{c.template.subject}</div>
        </div>
        <div className="card">
          <div className="label">List</div>
          <div className="font-medium">{c.list.name}</div>
          <div className="text-xs text-slate-550">{c.list._count.members} members</div>
        </div>
        <div className="card">
          <div className="label">Last run</div>
          <div className="font-medium">
            {c.lastRunAt ? formatDateTime(c.lastRunAt) : "—"}
          </div>
        </div>
      </div>

      <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-slate-550">Stats</h2>
      {stats.isLoading ? (
        <Spinner />
      ) : stats.data ? (
        <CampaignStats stats={stats.data} />
      ) : null}
    </div>
  );
}

const SERIES_ITEMS = [
  { key: "sent", label: "Sent", color: SERIES.sent },
  { key: "opened", label: "Opened", color: SERIES.opened },
  { key: "clicked", label: "Clicked", color: SERIES.clicked },
];

function CampaignStats({ stats }: { stats: Stats }) {
  const c = stats.counts;
  const reached =
    (c.SENT ?? 0) + (c.DELIVERED ?? 0) + (c.OPENED ?? 0) + (c.CLICKED ?? 0) + (c.BOUNCED ?? 0) + (c.COMPLAINED ?? 0);
  const delivered = (c.DELIVERED ?? 0) + (c.OPENED ?? 0) + (c.CLICKED ?? 0);
  const opened = (c.OPENED ?? 0) + (c.CLICKED ?? 0);
  const hasActivity = stats.series.some((p) => p.sent + p.opened + p.clicked > 0);

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
        {[
          ["Sent", stats.sent.toLocaleString()],
          ["Open rate", `${stats.openRate}%`],
          ["Click rate", `${stats.clickRate}%`],
          ["Bounce rate", `${stats.bounceRate}%`],
        ].map(([k, v]) => (
          <div key={k} className="card">
            <div className="label">{k}</div>
            <div className="metric-value mt-1">{v}</div>
          </div>
        ))}
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <ChartCard title="Last 14 days" subtitle="Daily send, open and click events">
          {hasActivity ? (
            <>
              <AreaChart data={stats.series} series={SERIES_ITEMS} height={200} />
              <div className="mt-3">
                <Legend items={SERIES_ITEMS} />
              </div>
            </>
          ) : (
            <div className="grid h-[200px] place-items-center text-sm text-slate-550">
              No activity in the last 14 days.
            </div>
          )}
        </ChartCard>

        <ChartCard title="Conversion funnel" subtitle="How far this campaign's messages got">
          <Funnel
            stages={[
              { label: "Reached provider", value: reached, color: "#9ec5f4" },
              { label: "Delivered", value: delivered, color: SERIES.sent },
              { label: "Opened", value: opened, color: SERIES.opened },
              { label: "Clicked", value: c.CLICKED ?? 0, color: SERIES.clicked },
            ]}
          />
        </ChartCard>
      </div>

      <ChartCard title="Status breakdown" subtitle="Every message in this campaign">
        <Donut
          centerLabel="messages"
          centerValue={Object.values(c).reduce((a, b) => a + b, 0).toLocaleString()}
          segments={[
            { label: "Delivered", value: c.DELIVERED ?? 0, color: SERIES.clicked },
            { label: "Opened", value: c.OPENED ?? 0, color: SERIES.opened },
            { label: "Clicked", value: c.CLICKED ?? 0, color: SERIES.sent },
            { label: "Sent", value: c.SENT ?? 0, color: "#9ec5f4" },
            { label: "Queued", value: c.QUEUED ?? 0, color: "#c9ccd6" },
            { label: "Bounced", value: c.BOUNCED ?? 0, color: "#d03b3b" },
            { label: "Failed", value: c.FAILED ?? 0, color: "#8b93a3" },
          ].filter((s) => s.value > 0)}
        />
      </ChartCard>
    </div>
  );
}
