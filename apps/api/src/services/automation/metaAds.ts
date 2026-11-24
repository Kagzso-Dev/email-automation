// Meta Marketing API — the Instagram Automation page's campaigns (Automation, ENABLE_AUTOMATION).
//
// Meta campaigns aren't Instagram-only: placements are set per ad set. Each campaign is marked with where its ad
// sets show ads ("instagram", "automatic" = Advantage+ placements, which include Instagram, "other", or "none" for a
// campaign with no ad sets yet); the page shows the Instagram-capable ones by default.
//
//   account      GET  /{act}?fields=name,currency,account_status
//   campaigns    GET  /{act}/campaigns
//   placements   GET  /{act}/adsets?fields=campaign_id,targeting{publisher_platforms}
//   metrics      GET  /{act}/insights?level=campaign&date_preset=last_30d
//   create       POST /{act}/campaigns                 always status PAUSED: nothing runs or spends
//   pause/resume POST /{campaign_id} status=PAUSED|ACTIVE

import { metaAdsSettings } from "../../config/automation.js";
import { AppError } from "../../http/errors.js";
import { upstream } from "./upstream.js";
import type { AutomationCampaign, CampaignList, CampaignPlacement, CampaignState, CreateCampaignInput } from "./types.js";

export const META_OBJECTIVES = [
  "OUTCOME_AWARENESS",
  "OUTCOME_TRAFFIC",
  "OUTCOME_ENGAGEMENT",
  "OUTCOME_LEADS",
  "OUTCOME_SALES",
  "OUTCOME_APP_PROMOTION",
] as const;

// Meta keeps budgets in the currency's smallest unit; these currencies have no minor unit there (offset 1).
const OFFSET_1 = new Set(["CLP", "COP", "CRC", "HUF", "ISK", "IDR", "JPY", "KRW", "PYG", "TWD", "VND"]);
const offset = (currency: string | null) => (currency && OFFSET_1.has(currency) ? 1 : 100);

const CONVERSION_ACTIONS = new Set([
  "lead",
  "onsite_conversion.lead_grouped",
  "offsite_conversion.fb_pixel_lead",
  "purchase",
  "omni_purchase",
  "onsite_conversion.messaging_conversation_started_7d",
]);

function creds() {
  const s = metaAdsSettings();
  if (!s.configured || !s.token || !s.adAccountId) {
    throw new AppError(409, "Instagram ads aren't connected: set META_ADS_ACCESS_TOKEN and META_AD_ACCOUNT_ID in .env and restart the API.", "not_connected");
  }
  return { token: s.token, account: s.adAccountId, base: `https://graph.facebook.com/${s.graphVersion}` };
}

async function graph(path: string, init: { method?: "GET" | "POST"; form?: Record<string, string> } = {}) {
  const c = creds();
  return upstream({ platform: "meta", url: `${c.base}/${path}`, token: c.token, method: init.method, form: init.form, tokenEnvVar: "META_ADS_ACCESS_TOKEN" });
}

const num = (v: unknown): number | null => {
  const n = typeof v === "number" ? v : typeof v === "string" ? Number.parseFloat(v) : NaN;
  return Number.isFinite(n) ? n : null;
};

function stateOf(status: string): CampaignState {
  if (status === "ACTIVE") return "active";
  if (status === "PAUSED") return "paused";
  if (status === "DELETED" || status === "ARCHIVED") return "ended";
  return "other";
}

export interface MetaAdAccount {
  id: string;
  name: string | null;
  currency: string | null;
  status: string | null;
}

const ACCOUNT_STATUS: Record<number, string> = { 1: "ACTIVE", 2: "DISABLED", 3: "UNSETTLED", 7: "PENDING_RISK_REVIEW", 9: "IN_GRACE_PERIOD", 101: "CLOSED" };

export async function getAccount(): Promise<MetaAdAccount> {
  const c = creds();
  const res = await graph(`${c.account}?fields=name,currency,account_status`);
  return {
    id: c.account,
    name: typeof res.body?.name === "string" ? res.body.name : null,
    currency: typeof res.body?.currency === "string" ? res.body.currency : null,
    status: typeof res.body?.account_status === "number" ? (ACCOUNT_STATUS[res.body.account_status] ?? String(res.body.account_status)) : null,
  };
}

async function placements(): Promise<Map<string, CampaignPlacement>> {
  const c = creds();
  const res = await graph(`${c.account}/adsets?fields=campaign_id,targeting{publisher_platforms}&limit=500`);
  const out = new Map<string, CampaignPlacement>();
  for (const set of Array.isArray(res.body?.data) ? res.body.data : []) {
    const id = String(set?.campaign_id ?? "");
    const platforms: unknown = set?.targeting?.publisher_platforms;
    const mine: CampaignPlacement = !Array.isArray(platforms) || platforms.length === 0 ? "automatic" : platforms.includes("instagram") ? "instagram" : "other";
    const prev = out.get(id);
    // Any ad set that can show on Instagram makes the campaign Instagram-capable.
    if (!prev || prev === "other" || (prev === "automatic" && mine === "instagram")) out.set(id, mine);
  }
  return out;
}

async function metrics() {
  const c = creds();
  const res = await graph(`${c.account}/insights?level=campaign&date_preset=last_30d&fields=campaign_id,spend,impressions,clicks,actions&limit=500`);
  const out = new Map<string, { spend: number | null; impressions: number | null; clicks: number | null; conversions: number }>();
  for (const row of Array.isArray(res.body?.data) ? res.body.data : []) {
    let conversions = 0;
    for (const a of Array.isArray(row?.actions) ? row.actions : []) {
      if (CONVERSION_ACTIONS.has(String(a?.action_type))) conversions += num(a?.value) ?? 0;
    }
    out.set(String(row?.campaign_id ?? ""), { spend: num(row?.spend), impressions: num(row?.impressions), clicks: num(row?.clicks), conversions });
  }
  return out;
}

export async function listCampaigns(): Promise<CampaignList> {
  const c = creds();
  const [account, res] = await Promise.all([
    getAccount(),
    graph(`${c.account}/campaigns?fields=id,name,status,effective_status,objective,daily_budget&limit=200`),
  ]);
  const currency = account.currency;
  const data: unknown[] = Array.isArray(res.body?.data) ? res.body.data : [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const campaigns: AutomationCampaign[] = data.map((el: any) => {
    const status = String(el?.status ?? "");
    const budget = num(el?.daily_budget);
    return {
      id: String(el?.id ?? ""),
      name: String(el?.name ?? "(no name)"),
      status: String(el?.effective_status ?? status),
      state: stateOf(status),
      objective: typeof el?.objective === "string" ? el.objective : null,
      dailyBudget: budget === null ? null : budget / offset(currency),
      currency,
      spend: null,
      impressions: null,
      clicks: null,
      conversions: null,
      placement: "none",
      canPause: status === "ACTIVE",
      canResume: status === "PAUSED",
    };
  });

  let metricsError: string | null = null;
  try {
    const [p, m] = await Promise.all([placements(), metrics()]);
    for (const camp of campaigns) {
      camp.placement = p.get(camp.id) ?? "none";
      const hit = m.get(camp.id);
      camp.spend = hit?.spend ?? 0;
      camp.impressions = hit?.impressions ?? 0;
      camp.clicks = hit?.clicks ?? 0;
      camp.conversions = hit?.conversions ?? 0;
    }
  } catch (err) {
    if (err instanceof AppError && err.code === "rate_limited") throw err;
    metricsError = err instanceof AppError ? err.message : "Spend, results and placements couldn't be loaded.";
  }
  return { campaigns, metricsError, currency };
}

/** Creates the campaign PAUSED: it can't run or spend until someone resumes it. Ad sets and ads are made in Ads Manager. */
export async function createCampaign(input: CreateCampaignInput): Promise<{ id: string | null }> {
  const c = creds();
  const account = await getAccount();
  const res = await graph(`${c.account}/campaigns`, {
    method: "POST",
    form: {
      name: input.name,
      objective: input.objective,
      status: "PAUSED",
      special_ad_categories: "[]",
      daily_budget: String(Math.round(input.dailyBudget * offset(account.currency))),
      bid_strategy: "LOWEST_COST_WITHOUT_CAP",
    },
  });
  return { id: typeof res.body?.id === "string" ? res.body.id : null };
}

export async function setCampaignStatus(campaignId: string, status: "PAUSED" | "ACTIVE"): Promise<void> {
  await graph(campaignId, { method: "POST", form: { status } });
}
