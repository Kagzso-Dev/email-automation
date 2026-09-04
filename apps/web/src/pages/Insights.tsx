import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { api } from "../lib/api";
import { PageHeader } from "../components/Layout";
import { ErrorNote, SkeletonCards } from "../components/ui";
import { Icon, type IconName } from "../components/icons";
import { ChartCard, GaugeRing, TrendPill } from "../components/charts";

interface Insights {
  deliverability: {
    score: number;
    bounceRate: number;
    complaintRate: number;
    deliveredRate: number;
    verdict: "healthy" | "watch" | "at-risk";
  };
  engagement: { openRateNow: number; openRatePrev: number; delta: number | null };
  volume: { sentNow: number; sentPrev: number; delta: number | null };
  audience: { addedNow: number; addedPrev: number; delta: number | null };
  topCampaign: { id: string; name: string; openRate: number; sent: number } | null;
}

function InsightCard({
  icon,
  tone = "accent",
  kicker,
  headline,
  children,
}: {
  icon: IconName;
  tone?: "accent" | "ok" | "warn" | "crit";
  kicker: string;
  headline: ReactNode;
  children?: ReactNode;
}) {
  const tones = {
    accent: "bg-accent-soft text-accent-ink",
    ok: "bg-[#e7f1ec] text-ok",
    warn: "bg-[#f8f0e1] text-warn",
    crit: "bg-[#f9ebe9] text-crit",
  };
  return (
    <div className="card card-hover fade-rise">
      <div className="flex items-center gap-2">
        <span className={`grid h-8 w-8 place-items-center rounded-lg ${tones[tone]}`}>
          <Icon name={icon} size={16} />
        </span>
        <span className="label mb-0">{kicker}</span>
      </div>
      <p className="mt-3 text-sm leading-relaxed text-ink">{headline}</p>
      {children && <div className="mt-3 border-t border-line-subtle pt-3">{children}</div>}
    </div>
  );
}

export function InsightsPage() {
  const { data, isLoading, error } = useQuery({
    queryKey: ["dashboard-insights"],
    queryFn: () => api<Insights>("/api/dashboard/insights"),
    refetchInterval: 60_000,
  });

  if (error) return <ErrorNote error={error} />;

  return (
    <div>
      <PageHeader
        title="Insights"
        subtitle="Automatic reads on deliverability, engagement and audience — refreshed every minute."
        action={
          <Link to="/" className="btn-ghost">
            ← Dashboard
          </Link>
        }
      />

      {isLoading || !data ? (
        <SkeletonCards count={5} />
      ) : (
        <div className="grid gap-4 lg:grid-cols-3">
          <ChartCard
            title="Deliverability health"
            subtitle="Weighted score from bounces and complaints"
            className="lg:col-span-1"
          >
            <div className="flex flex-col items-center gap-3">
              <GaugeRing
                value={data.deliverability.score}
                label="out of 100"
                sub={
                  data.deliverability.verdict === "healthy"
                    ? "Healthy — sender reputation looks solid"
                    : data.deliverability.verdict === "watch"
                      ? "Watch — trim inactive or invalid addresses"
                      : "At risk — pause and clean your lists"
                }
              />
              <div className="flex w-full justify-around border-t border-line-subtle pt-3 text-center text-xs">
                <div>
                  <div className="metric-value text-base">{data.deliverability.deliveredRate}%</div>
                  <div className="label mb-0 mt-0.5">delivered</div>
                </div>
                <div>
                  <div className="metric-value text-base">{data.deliverability.bounceRate}%</div>
                  <div className="label mb-0 mt-0.5">bounced</div>
                </div>
                <div>
                  <div className="metric-value text-base">{data.deliverability.complaintRate}%</div>
                  <div className="label mb-0 mt-0.5">complaints</div>
                </div>
              </div>
            </div>
          </ChartCard>

          <div className="grid gap-4 sm:grid-cols-2 lg:col-span-2">
            <InsightCard
              icon="insights"
              tone={engagementTone(data.engagement.delta)}
              kicker="Engagement trend"
              headline={
                <>
                  Open rate is <b>{data.engagement.openRateNow}%</b> this week
                  {data.engagement.delta === null
                    ? " — no comparable prior week yet."
                    : data.engagement.delta === 0
                      ? ", flat versus last week."
                      : data.engagement.delta > 0
                        ? `, up from ${data.engagement.openRatePrev}% last week.`
                        : `, down from ${data.engagement.openRatePrev}% last week.`}
                </>
              }
            >
              <TrendPill delta={data.engagement.delta} goodDirection="up" />
            </InsightCard>

            <InsightCard
              icon="campaigns"
              tone={data.volume.delta && data.volume.delta < 0 ? "warn" : "accent"}
              kicker="Send volume"
              headline={
                <>
                  <b>{data.volume.sentNow.toLocaleString()}</b> messages sent in the last 7 days
                  {data.volume.delta === null
                    ? "."
                    : ` versus ${data.volume.sentPrev.toLocaleString()} the week before.`}
                </>
              }
            >
              <TrendPill delta={data.volume.delta} goodDirection="up" />
            </InsightCard>

            <InsightCard
              icon="contacts"
              tone={data.audience.delta && data.audience.delta < 0 ? "warn" : "ok"}
              kicker="Audience growth"
              headline={
                <>
                  <b>{data.audience.addedNow.toLocaleString()}</b> new contacts this week
                  {data.audience.delta === null
                    ? "."
                    : `, ${data.audience.addedPrev.toLocaleString()} the week before.`}
                </>
              }
            >
              <TrendPill delta={data.audience.delta} goodDirection="up" />
            </InsightCard>

            <InsightCard
              icon="templates"
              kicker="Top campaign"
              headline={
                data.topCampaign ? (
                  <>
                    <b>{data.topCampaign.name}</b> leads on engagement at{" "}
                    <b>{data.topCampaign.openRate}%</b> open rate across{" "}
                    {data.topCampaign.sent.toLocaleString()} sends.
                  </>
                ) : (
                  "Not enough campaign data yet — send to at least 10 recipients to rank campaigns."
                )
              }
            >
              {data.topCampaign && (
                <Link
                  to={`/campaigns/${data.topCampaign.id}`}
                  className="text-xs font-medium text-accent-ink hover:underline"
                >
                  Open campaign →
                </Link>
              )}
            </InsightCard>
          </div>
        </div>
      )}
    </div>
  );
}

function engagementTone(delta: number | null): "accent" | "ok" | "crit" {
  if (delta === null) return "accent";
  if (delta > 0) return "ok";
  if (delta < 0) return "crit";
  return "accent";
}
