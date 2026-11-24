import { useState } from "react";
import { Navigate } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../../lib/api";
import { useAuth } from "../../lib/auth";
import {
  canUseAutomation,
  OBJECTIVES,
  useAutomationState,
  type AutomationCampaign,
  type AutomationConfig,
  type AutomationPlatform,
  type AutomationStatus,
  type CampaignList,
  type CampaignState,
  type Connection,
} from "../../lib/automation";
import { fullNumber } from "../../lib/numberFormat";
import { useConfirm } from "../confirm";
import { PageHeader, ROW_ACTIONS_CELL, TABLE_ROW } from "../PageHeader";
import { Tooltip } from "../Tooltip";
import { Badge, EmptyState, ErrorNote, Modal, SkeletonCards, Spinner, Table, type BadgeTone } from "../ui";
import { BRAND_COLOR, BRAND_NAME, BrandIcon } from "./BrandIcons";
import { DmComposer } from "./DmComposer";

// LinkedIn Automation / Instagram Automation (ENABLE_AUTOMATION). One page for both platforms:
//   connection card (configured / connected / token problem) with the DM button,
//   campaigns (status, daily budget, last-30-day spend, results), Create campaign, Pause / Resume.
// Flag off, or a role other than admin / editor: the address goes to the Dashboard, as it does today.
// LinkedIn's DM button is always disabled (no public messaging API), with the reason as its tooltip.

/** The route element: waits for the flag, then the page — or the Dashboard (flag off / not admin or editor). */
export function AutomationGate({ platform }: { platform: AutomationPlatform }) {
  const { user } = useAuth();
  const flag = useAutomationState();
  if (flag.loading) return <Spinner />;
  if (!flag.config || !canUseAutomation(user?.role)) return <Navigate to="/" replace />;
  return <AutomationPage platform={platform} config={flag.config} />;
}

const STATE_TONE: Record<CampaignState, BadgeTone> = { active: "ok", paused: "warn", draft: "neutral", ended: "neutral", other: "accent" };

const SUBTITLE: Record<AutomationPlatform, string> = {
  linkedin: "LinkedIn Ads campaigns through LinkedIn's Marketing API. New campaigns start as drafts — finish targeting and ads in Campaign Manager, then Resume here.",
  instagram:
    "Instagram Ads campaigns through Meta's Marketing API, and direct messages through the Instagram Messaging API. New campaigns start paused — add ad sets and ads in Ads Manager, then Resume here.",
};

const money = (v: number | null, currency: string | null) => {
  if (v === null) return "—";
  try {
    return new Intl.NumberFormat("en", { style: "currency", currency: currency ?? "USD", maximumFractionDigits: 2 }).format(v);
  } catch {
    return `${v.toFixed(2)} ${currency ?? ""}`.trim();
  }
};
const count = (v: number | null) => (v === null ? "—" : fullNumber.format(v));

export function AutomationPage({ platform, config }: { platform: AutomationPlatform; config: AutomationConfig }) {
  const qc = useQueryClient();
  const [createOpen, setCreateOpen] = useState(false);
  const [dmOpen, setDmOpen] = useState(false);
  const name = BRAND_NAME[platform];

  const status = useQuery({
    queryKey: ["automation", platform, "status"],
    queryFn: () => api<AutomationStatus>(`/api/automation/${platform}/status`),
    staleTime: 60_000,
  });
  const adsConnected = !!status.data?.ads.connected;
  const adsConfigured = platform === "linkedin" ? config.linkedin.adsConfigured : config.instagram.adsConfigured;

  const refresh = () => void qc.invalidateQueries({ queryKey: ["automation", platform] });

  // DM: LinkedIn never (no public API); Instagram while messaging is connected.
  const dmReason =
    platform === "linkedin"
      ? config.linkedin.dmReason
      : status.isLoading
        ? "Checking the Instagram connection…"
        : status.data?.dm.available
          ? null
          : status.data?.dm.reason ?? "Instagram messaging isn't connected.";

  return (
    <div>
      <PageHeader
        title={`${name} Automation`}
        subtitle={SUBTITLE[platform]}
        primaryAction={{
          label: "Create campaign",
          onClick: () => setCreateOpen(true),
          disabled: !adsConnected,
          title: adsConnected ? "Create a campaign (it starts without spending)" : `Connect ${name} ads first`,
        }}
        secondaryActions={[{ label: "Refresh", onClick: refresh, title: "Load status and campaigns again" }]}
      />

      <ConnectionCard platform={platform} status={status.data} loading={status.isLoading} error={status.error} dmReason={dmReason} onDm={() => setDmOpen(true)} />

      <section className="mt-6" aria-labelledby="automation-campaigns">
        <h2 id="automation-campaigns" className="mb-3 text-base font-semibold text-ink">
          Campaigns <span className="text-sm font-normal text-slate-550">· spend and results for the last 30 days</span>
        </h2>
        {status.isLoading ? (
          <SkeletonCards count={4} />
        ) : !adsConfigured ? (
          <NotConnected platform={platform} />
        ) : !adsConnected ? (
          <EmptyState icon="campaigns" title={`${name} ads aren't reachable`}>
            {status.data?.ads.error?.message ?? (status.error instanceof Error ? status.error.message : "Check the connection above.")}
          </EmptyState>
        ) : (
          <Campaigns platform={platform} />
        )}
      </section>

      {createOpen && <CreateCampaign platform={platform} currency={status.data?.ads.account?.currency ?? null} onClose={() => setCreateOpen(false)} />}
      {platform === "instagram" && <DmComposer open={dmOpen} onClose={() => setDmOpen(false)} />}
    </div>
  );
}

function NotConnected({ platform }: { platform: AutomationPlatform }) {
  const vars =
    platform === "linkedin"
      ? "LINKEDIN_ACCESS_TOKEN and LINKEDIN_AD_ACCOUNT_ID"
      : "META_ADS_ACCESS_TOKEN and META_AD_ACCOUNT_ID (and INSTAGRAM_PAGE_ID, INSTAGRAM_ACCOUNT_ID, INSTAGRAM_MESSAGING_ACCESS_TOKEN for messages)";
  return (
    <EmptyState icon="lock" title="Not connected">
      An admin adds {vars} to the server's .env and restarts the API. Tokens stay on the server — they are never shown here.
    </EmptyState>
  );
}

function connectionBadge(c: Connection<unknown> | undefined): { tone: BadgeTone; label: string } {
  if (!c || !c.configured) return { tone: "neutral", label: "Not connected" };
  if (c.connected) return { tone: "ok", label: "Connected" };
  if (c.error?.code === "token_invalid") return { tone: "crit", label: "Token expired" };
  if (c.error?.code === "rate_limited") return { tone: "warn", label: "Rate limited" };
  return { tone: "crit", label: "Error" };
}

function ConnectionRow({ label, conn, detail }: { label: string; conn: Connection<unknown> | undefined; detail: string | null }) {
  const b = connectionBadge(conn);
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
      <span className="w-20 shrink-0 text-xs font-semibold uppercase tracking-[0.06em] text-slate-500">{label}</span>
      <Badge tone={b.tone}>{b.label}</Badge>
      {detail ? <span className="text-sm text-ink">{detail}</span> : null}
      {conn?.error ? <span className="basis-full pl-[5.75rem] text-xs text-crit max-sm:pl-0">{conn.error.message}</span> : null}
    </div>
  );
}

function ConnectionCard({
  platform,
  status,
  loading,
  error,
  dmReason,
  onDm,
}: {
  platform: AutomationPlatform;
  status: AutomationStatus | undefined;
  loading: boolean;
  error: unknown;
  dmReason: string | null;
  onDm: () => void;
}) {
  const color = BRAND_COLOR[platform];
  const ads = status?.ads;
  const adsDetail = ads?.account ? [ads.account.name ?? ads.account.id, ads.account.currency, ads.account.status].filter(Boolean).join(" · ") : null;
  const msg = status?.messaging;
  const dmButton = (
    <button
      type="button"
      className="btn text-white"
      style={{ backgroundColor: color }}
      disabled={!!dmReason}
      onClick={onDm}
      aria-label={platform === "linkedin" ? "DM (LinkedIn message)" : "DM (Instagram direct message)"}
    >
      <BrandIcon brand={platform} size={16} className="rounded-[4px] bg-white" />
      DM
    </button>
  );
  return (
    <div className="card border-t-4" style={{ borderTopColor: color }}>
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex min-w-0 items-start gap-3">
          <span className="grid h-11 w-11 shrink-0 place-items-center rounded-xl border border-line bg-surface">
            <BrandIcon brand={platform} size={26} />
          </span>
          <div className="min-w-0 space-y-2">
            <div className="font-semibold text-ink">{BRAND_NAME[platform]} account</div>
            {loading ? (
              <span className="text-sm text-slate-550">Checking the connection…</span>
            ) : error ? (
              <ErrorNote error={error} />
            ) : (
              <>
                <ConnectionRow label="Ads" conn={ads} detail={adsDetail} />
                {platform === "instagram" && (
                  <ConnectionRow label="Messages" conn={msg} detail={msg?.account ? `@${msg.account.username ?? msg.account.id}` : null} />
                )}
                {platform === "linkedin" && (
                  <div className="flex flex-wrap items-center gap-3">
                    <span className="w-20 shrink-0 text-xs font-semibold uppercase tracking-[0.06em] text-slate-500">Messages</span>
                    <Badge tone="neutral">Not available</Badge>
                  </div>
                )}
              </>
            )}
          </div>
        </div>
        <div className="shrink-0">
          {dmReason ? (
            <Tooltip label={dmReason} describe>
              {dmButton}
            </Tooltip>
          ) : (
            dmButton
          )}
        </div>
      </div>
    </div>
  );
}

function Campaigns({ platform }: { platform: AutomationPlatform }) {
  const qc = useQueryClient();
  const confirm = useConfirm();
  const [showAll, setShowAll] = useState(false);
  const list = useQuery({
    queryKey: ["automation", platform, "campaigns"],
    queryFn: () => api<CampaignList>(`/api/automation/${platform}/campaigns`),
    staleTime: 60_000,
  });
  const act = useMutation({
    mutationFn: ({ c, action }: { c: AutomationCampaign; action: "pause" | "resume" }) =>
      api(`/api/automation/${platform}/campaigns/${encodeURIComponent(c.id)}/${action}`, {
        method: "POST",
        json: { name: c.name },
        notify: action === "pause" ? "Campaign paused" : "Campaign resumed",
      }),
    onSettled: () => void qc.invalidateQueries({ queryKey: ["automation", platform, "campaigns"] }),
  });

  const run = async (c: AutomationCampaign, action: "pause" | "resume") => {
    const ok = await confirm(
      action === "pause"
        ? { title: `Pause “${c.name}”?`, body: "Its ads stop showing until you resume it.", confirmText: "Pause" }
        : {
            title: `Resume “${c.name}”?`,
            body: "It can start showing ads and spending its budget right away.",
            confirmText: "Resume",
            tone: "danger",
          },
    );
    if (ok) act.mutate({ c, action });
  };

  if (list.isLoading) return <Spinner />;
  if (list.error) return <ErrorNote error={list.error} />;
  const all = list.data?.campaigns ?? [];
  // Instagram page: campaigns that can show on Instagram (or have no ad sets yet), unless "show all".
  const hidden = platform === "instagram" && !showAll ? all.filter((c) => c.placement === "other") : [];
  const rows = all.filter((c) => !hidden.includes(c));

  return (
    <>
      {list.data?.metricsError ? (
        <div className="mb-3 rounded-lg border border-warn/40 bg-warn-soft px-3 py-2 text-sm text-ink">Spend and results unavailable: {list.data.metricsError}</div>
      ) : null}
      {act.error ? (
        <div className="mb-3">
          <ErrorNote error={act.error} />
        </div>
      ) : null}
      {platform === "instagram" && (
        <label className="mb-3 flex items-center gap-2 text-sm text-slate-550">
          <input type="checkbox" checked={showAll} onChange={(e) => setShowAll(e.target.checked)} />
          Also show campaigns without Instagram placements{hidden.length ? ` (${hidden.length})` : ""}
        </label>
      )}
      {rows.length === 0 ? (
        <EmptyState icon="campaigns" title="No campaigns yet">
          Use “Create campaign” to start one. It is created without spending anything.
        </EmptyState>
      ) : (
        <Table
          head={[
            "Campaign",
            "Status",
            "Objective",
            ...(platform === "instagram" ? ["Placement"] : []),
            "Daily budget",
            "Spend",
            "Impressions",
            "Clicks",
            "Results",
            "",
          ]}
        >
          {rows.map((c) => (
            <tr key={c.id} className={TABLE_ROW}>
              <td className="px-4 py-2.5">
                <div className="font-medium text-ink">{c.name}</div>
                <div className="font-mono text-xs text-slate-500">{c.id}</div>
              </td>
              <td className="px-4 py-2.5">
                <Badge tone={STATE_TONE[c.state]}>{c.status || c.state}</Badge>
              </td>
              <td className="px-4 py-2.5 text-xs">{c.objective ?? "—"}</td>
              {platform === "instagram" && (
                <td className="px-4 py-2.5 text-xs">
                  {c.placement === "instagram" ? "Instagram" : c.placement === "automatic" ? "Automatic (incl. Instagram)" : c.placement === "other" ? "Not Instagram" : "No ad sets yet"}
                </td>
              )}
              <td className="px-4 py-2.5 font-mono text-xs">{money(c.dailyBudget, c.currency ?? list.data?.currency ?? null)}</td>
              <td className="px-4 py-2.5 font-mono text-xs">{money(c.spend, c.currency ?? list.data?.currency ?? null)}</td>
              <td className="px-4 py-2.5 font-mono text-xs">{count(c.impressions)}</td>
              <td className="px-4 py-2.5 font-mono text-xs">{count(c.clicks)}</td>
              <td className="px-4 py-2.5 font-mono text-xs" title="Leads and conversions">
                {count(c.conversions)}
              </td>
              <td className={ROW_ACTIONS_CELL}>
                {c.canPause ? (
                  <button type="button" className="btn-ghost h-8 px-3 text-xs" disabled={act.isPending} onClick={() => void run(c, "pause")}>
                    Pause
                  </button>
                ) : c.canResume ? (
                  <button type="button" className="btn-ghost h-8 px-3 text-xs" disabled={act.isPending} onClick={() => void run(c, "resume")}>
                    Resume
                  </button>
                ) : null}
              </td>
            </tr>
          ))}
        </Table>
      )}
    </>
  );
}

function CreateCampaign({ platform, currency, onClose }: { platform: AutomationPlatform; currency: string | null; onClose: () => void }) {
  const qc = useQueryClient();
  const objectives = OBJECTIVES[platform];
  const [name, setName] = useState("");
  const [objective, setObjective] = useState(objectives[0]!.value);
  const [budget, setBudget] = useState("");
  const [groupId, setGroupId] = useState("");
  const groups = useQuery({
    queryKey: ["automation", "linkedin", "campaign-groups"],
    queryFn: () => api<{ groups: Array<{ id: string; name: string; status: string }> }>("/api/automation/linkedin/campaign-groups"),
    enabled: platform === "linkedin",
  });
  const create = useMutation({
    mutationFn: () =>
      api<{ id: string | null; status: string }>(`/api/automation/${platform}/campaigns`, {
        method: "POST",
        json: { name: name.trim(), objective, dailyBudget: Number(budget), ...(platform === "linkedin" ? { campaignGroupId: groupId } : {}) },
        notify: platform === "linkedin" ? "Campaign created as a draft" : "Campaign created (paused)",
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["automation", platform, "campaigns"] });
      onClose();
    },
  });
  const budgetOk = Number(budget) > 0;
  const ready = name.trim().length > 0 && budgetOk && (platform !== "linkedin" || !!groupId);

  return (
    <Modal open onClose={onClose} title="Create campaign">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (ready) create.mutate();
        }}
      >
        <label className="label" htmlFor="automation-campaign-name">
          Name
        </label>
        <input id="automation-campaign-name" className="input mb-3" value={name} maxLength={200} onChange={(e) => setName(e.target.value)} required />
        <label className="label" htmlFor="automation-campaign-objective">
          Objective
        </label>
        <select id="automation-campaign-objective" className="input mb-3" value={objective} onChange={(e) => setObjective(e.target.value)}>
          {objectives.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
        {platform === "linkedin" && (
          <>
            <label className="label" htmlFor="automation-campaign-group">
              Campaign group
            </label>
            {groups.isLoading ? (
              <Spinner />
            ) : groups.error ? (
              <div className="mb-3">
                <ErrorNote error={groups.error} />
              </div>
            ) : (
              <select id="automation-campaign-group" className="input mb-3" value={groupId} onChange={(e) => setGroupId(e.target.value)} required>
                <option value="">Choose a group…</option>
                {(groups.data?.groups ?? []).map((g) => (
                  <option key={g.id} value={g.id}>
                    {g.name} ({g.status})
                  </option>
                ))}
              </select>
            )}
          </>
        )}
        <label className="label" htmlFor="automation-campaign-budget">
          Daily budget{currency ? ` (${currency})` : ""}
        </label>
        <input
          id="automation-campaign-budget"
          className="input mb-3"
          type="number"
          min="0.01"
          step="0.01"
          inputMode="decimal"
          value={budget}
          onChange={(e) => setBudget(e.target.value)}
          required
        />
        <p className="mb-4 rounded-lg border border-line bg-surface-muted px-3 py-2 text-[13px] leading-[1.5] text-slate-550">
          {platform === "linkedin"
            ? "The campaign is created as a draft: it can't run or spend. Set targeting and ads in LinkedIn Campaign Manager, then Resume it here."
            : "The campaign is created paused: it can't run or spend. Add ad sets (with Instagram placements) and ads in Meta Ads Manager, then Resume it here."}
        </p>
        {create.error ? (
          <div className="mb-3">
            <ErrorNote error={create.error} />
          </div>
        ) : null}
        <div className="flex justify-end gap-2">
          <button type="button" className="btn-ghost" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="btn-primary" disabled={!ready || create.isPending}>
            {create.isPending ? "Creating…" : "Create"}
          </button>
        </div>
      </form>
    </Modal>
  );
}
