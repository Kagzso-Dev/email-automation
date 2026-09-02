import { Link, useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../lib/api";
import { Badge, campaignTone, ErrorNote, Spinner } from "../components/ui";

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
      <div className="mb-6 mt-2 flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold">{c.name}</h1>
          <div className="mt-1 flex items-center gap-2 text-sm text-slate-550">
            <Badge tone={campaignTone[c.status] ?? "neutral"}>{c.status}</Badge>
            <span>
              {c.scheduleType === "ONCE"
                ? c.sendAt && new Date(c.sendAt).toLocaleString()
                : c.cronExpression}
            </span>
          </div>
        </div>
        <div className="flex gap-2">
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
            {c.lastRunAt ? new Date(c.lastRunAt).toLocaleString() : "—"}
          </div>
        </div>
      </div>

      <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-slate-550">Stats</h2>
      {stats.isLoading ? (
        <Spinner />
      ) : stats.data ? (
        <>
          <div className="mb-4 grid grid-cols-2 gap-4 sm:grid-cols-4">
            {[
              ["Sent", stats.data.sent],
              ["Open rate", `${stats.data.openRate}%`],
              ["Click rate", `${stats.data.clickRate}%`],
              ["Bounce rate", `${stats.data.bounceRate}%`],
            ].map(([k, v]) => (
              <div key={k as string} className="card">
                <div className="label">{k}</div>
                <div className="font-mono text-xl font-semibold tabular-nums">{v}</div>
              </div>
            ))}
          </div>
          <div className="card">
            <div className="flex flex-wrap gap-x-8 gap-y-2 font-mono text-sm">
              {Object.entries(stats.data.counts).map(([k, v]) => (
                <div key={k}>
                  <span className="text-slate-550">{k}</span>{" "}
                  <span className="tabular-nums">{v}</span>
                </div>
              ))}
            </div>
          </div>
        </>
      ) : null}
    </div>
  );
}
