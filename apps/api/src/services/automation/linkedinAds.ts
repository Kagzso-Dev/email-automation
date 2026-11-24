// LinkedIn Marketing API (Advertising API product) — ads only (Automation, ENABLE_AUTOMATION).
// LinkedIn has no public messaging API, so nothing here sends messages, and nothing touches the LinkedIn website.
//
//   account      GET  /rest/adAccounts/{id}
//   campaigns    GET  /rest/adAccounts/{id}/adCampaigns?q=search
//   groups       GET  /rest/adAccounts/{id}/adCampaignGroups?q=search
//   metrics      GET  /rest/adAnalytics?q=analytics&pivot=CAMPAIGN  (last 30 days)
//   create       POST /rest/adAccounts/{id}/adCampaigns              always status DRAFT: nothing runs or spends
//   pause/resume POST /rest/adAccounts/{id}/adCampaigns/{cid}        X-RestLi-Method: PARTIAL_UPDATE

import { linkedinSettings } from "../../config/automation.js";
import { AppError } from "../../http/errors.js";
import { upstream } from "./upstream.js";
import type { AutomationCampaign, CampaignList, CampaignState, CreateCampaignInput } from "./types.js";

const BASE = "https://api.linkedin.com/rest";

export const LINKEDIN_OBJECTIVES = [
  "BRAND_AWARENESS",
  "WEBSITE_VISIT",
  "ENGAGEMENT",
  "VIDEO_VIEW",
  "LEAD_GENERATION",
  "WEBSITE_CONVERSION",
  "JOB_APPLICANT",
] as const;

function creds() {
  const s = linkedinSettings();
  if (!s.configured || !s.token || !s.adAccountId) {
    throw new AppError(409, "LinkedIn isn't connected: set LINKEDIN_ACCESS_TOKEN and LINKEDIN_AD_ACCOUNT_ID in .env and restart the API.", "not_connected");
  }
  return { token: s.token, account: s.adAccountId, version: s.apiVersion };
}

async function li(path: string, init: { method?: "GET" | "POST"; json?: unknown; headers?: Record<string, string> } = {}) {
  const c = creds();
  return upstream({
    platform: "linkedin",
    url: `${BASE}${path}`,
    token: c.token,
    method: init.method,
    json: init.json,
    tokenEnvVar: "LINKEDIN_ACCESS_TOKEN",
    headers: { "LinkedIn-Version": c.version, "X-Restli-Protocol-Version": "2.0.0", ...init.headers },
  });
}

const num = (v: unknown): number | null => {
  const n = typeof v === "number" ? v : typeof v === "string" ? Number.parseFloat(v) : NaN;
  return Number.isFinite(n) ? n : null;
};

function stateOf(status: string): CampaignState {
  switch (status) {
    case "ACTIVE":
      return "active";
    case "PAUSED":
      return "paused";
    case "DRAFT":
      return "draft";
    case "COMPLETED":
    case "ARCHIVED":
    case "CANCELED":
    case "REMOVED":
    case "PENDING_DELETION":
      return "ended";
    default:
      return "other";
  }
}

export interface LinkedInAccount {
  id: string;
  name: string | null;
  currency: string | null;
  status: string | null;
}

export async function getAccount(): Promise<LinkedInAccount> {
  const c = creds();
  const res = await li(`/adAccounts/${c.account}`);
  return {
    id: c.account,
    name: typeof res.body?.name === "string" ? res.body.name : null,
    currency: typeof res.body?.currency === "string" ? res.body.currency : null,
    status: typeof res.body?.status === "string" ? res.body.status : null,
  };
}

export async function listCampaignGroups(): Promise<{ id: string; name: string; status: string }[]> {
  const c = creds();
  const res = await li(`/adAccounts/${c.account}/adCampaignGroups?q=search&pageSize=100`);
  const elements: unknown[] = Array.isArray(res.body?.elements) ? res.body.elements : [];
  return elements
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    .map((g: any) => ({ id: String(g?.id ?? ""), name: String(g?.name ?? ""), status: String(g?.status ?? "") }))
    .filter((g) => /^\d+$/.test(g.id));
}

const dateParts = (d: Date) => `(year:${d.getUTCFullYear()},month:${d.getUTCMonth() + 1},day:${d.getUTCDate()})`;

async function metrics(ids: string[]) {
  const end = new Date();
  const start = new Date(end.getTime() - 30 * 86_400_000);
  // Rest.li 2.0: the URNs inside List(...) are URL-encoded; the List syntax itself is not.
  const list = ids.map((id) => encodeURIComponent(`urn:li:sponsoredCampaign:${id}`)).join(",");
  const res = await li(
    `/adAnalytics?q=analytics&pivot=CAMPAIGN&timeGranularity=ALL&dateRange=(start:${dateParts(start)},end:${dateParts(end)})` +
      `&campaigns=List(${list})&fields=costInLocalCurrency,impressions,clicks,externalWebsiteConversions,oneClickLeads,pivotValues`,
  );
  const byId = new Map<string, { spend: number | null; impressions: number | null; clicks: number | null; conversions: number | null }>();
  for (const el of Array.isArray(res.body?.elements) ? res.body.elements : []) {
    const urn = String(el?.pivotValues?.[0] ?? "");
    const id = urn.split(":").pop() ?? "";
    byId.set(id, {
      spend: num(el?.costInLocalCurrency),
      impressions: num(el?.impressions),
      clicks: num(el?.clicks),
      conversions: (num(el?.externalWebsiteConversions) ?? 0) + (num(el?.oneClickLeads) ?? 0),
    });
  }
  return byId;
}

export async function listCampaigns(): Promise<CampaignList> {
  const c = creds();
  const res = await li(`/adAccounts/${c.account}/adCampaigns?q=search&pageSize=100`);
  const elements: unknown[] = Array.isArray(res.body?.elements) ? res.body.elements : [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const campaigns: AutomationCampaign[] = elements.map((el: any) => {
    const status = String(el?.status ?? "");
    return {
      id: String(el?.id ?? ""),
      name: String(el?.name ?? "(no name)"),
      status,
      state: stateOf(status),
      objective: typeof el?.objectiveType === "string" ? el.objectiveType : null,
      dailyBudget: num(el?.dailyBudget?.amount),
      currency: typeof el?.dailyBudget?.currencyCode === "string" ? el.dailyBudget.currencyCode : null,
      spend: null,
      impressions: null,
      clicks: null,
      conversions: null,
      canPause: status === "ACTIVE",
      canResume: status === "PAUSED" || status === "DRAFT",
    };
  });

  let metricsError: string | null = null;
  const ids = campaigns.map((x) => x.id).filter((id) => /^\d+$/.test(id));
  if (ids.length > 0) {
    try {
      const m = await metrics(ids);
      for (const camp of campaigns) {
        const hit = m.get(camp.id);
        camp.spend = hit?.spend ?? 0;
        camp.impressions = hit?.impressions ?? 0;
        camp.clicks = hit?.clicks ?? 0;
        camp.conversions = hit?.conversions ?? 0;
      }
    } catch (err) {
      if (err instanceof AppError && err.code === "rate_limited") throw err;
      metricsError = err instanceof AppError ? err.message : "Spend and results couldn't be loaded.";
    }
  }
  return { campaigns, metricsError, currency: campaigns.find((x) => x.currency)?.currency ?? null };
}

/** Creates the campaign as a DRAFT: it can't run or spend until someone resumes it. Targeting and ads are set in Campaign Manager. */
export async function createCampaign(input: CreateCampaignInput): Promise<{ id: string | null }> {
  const c = creds();
  if (!input.campaignGroupId) throw new AppError(400, "Pick a campaign group.", "bad_request");
  const account = await getAccount();
  const currency = account.currency ?? "USD";
  const res = await li(`/adAccounts/${c.account}/adCampaigns`, {
    method: "POST",
    json: {
      account: `urn:li:sponsoredAccount:${c.account}`,
      campaignGroup: `urn:li:sponsoredCampaignGroup:${input.campaignGroupId}`,
      name: input.name,
      objectiveType: input.objective,
      type: "SPONSORED_UPDATES",
      costType: "CPM",
      dailyBudget: { amount: input.dailyBudget.toFixed(2), currencyCode: currency },
      locale: { country: "US", language: "en" },
      offsiteDeliveryEnabled: false,
      politicalIntent: "NOT_POLITICAL",
      runSchedule: { start: Date.now() + 60 * 60_000 },
      status: "DRAFT",
    },
  });
  const id = res.headers.get("x-restli-id") ?? res.headers.get("x-linkedin-id");
  return { id: id ? id.split(":").pop() ?? id : null };
}

export async function setCampaignStatus(campaignId: string, status: "PAUSED" | "ACTIVE"): Promise<void> {
  const c = creds();
  await li(`/adAccounts/${c.account}/adCampaigns/${campaignId}`, {
    method: "POST",
    headers: { "X-RestLi-Method": "PARTIAL_UPDATE" },
    json: { patch: { $set: { status } } },
  });
}
