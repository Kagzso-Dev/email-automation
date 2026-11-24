// Automation (LinkedIn + Instagram) configuration — deliberately separate from src/env.ts.
//
// Like config/templateDrafts.ts this reads only its own variables, at call time, and NEVER throws.
//
//   ENABLE_AUTOMATION=true           the sidebar gets an "Automation" section (LinkedIn Automation, Instagram
//                                    Automation) and /api/automation answers
//   unset, empty or anything else    off (default): the sidebar and routes are exactly as before, and EVERY
//                                    /api/automation endpoint (including GET /config) answers 404
//
// Credentials live in .env only. They are read here and used by services/automation/* in the Authorization
// header of outgoing requests; they are never returned by an endpoint and never logged. What leaves this file
// for the browser is only "configured: true/false".
//
//   LinkedIn (Marketing API, ads only — LinkedIn has no public messaging API):
//     LINKEDIN_ACCESS_TOKEN          OAuth token with r_ads, rw_ads (+ r_ads_reporting for spend/results)
//     LINKEDIN_AD_ACCOUNT_ID         sponsored ad account id (digits, or urn:li:sponsoredAccount:…)
//     LINKEDIN_API_VERSION           LinkedIn-Version header, YYYYMM (must be a version LinkedIn still supports)
//   Instagram ads (Meta Marketing API):
//     META_ADS_ACCESS_TOKEN          system-user token with ads_read, ads_management
//     META_AD_ACCOUNT_ID             ad account id (digits, or act_…)
//   Instagram DMs (Instagram Messaging API, via the Facebook Page linked to the Instagram account):
//     INSTAGRAM_PAGE_ID              the linked Facebook Page id
//     INSTAGRAM_ACCOUNT_ID           the Instagram professional account id
//     INSTAGRAM_MESSAGING_ACCESS_TOKEN  Page token with instagram_basic, instagram_manage_messages, pages_messaging
//     INSTAGRAM_HUMAN_AGENT_ENABLED  true only once Meta has approved the Human Agent feature for the app: then a
//                                    single-recipient reply 24 h – 7 days after the customer's last message may be
//                                    sent with the HUMAN_AGENT tag. Off (default): outside 24 h nothing is sent.
//   AUTOMATION_META_GRAPH_VERSION    Graph API version for both Meta parts (default: META_GRAPH_API_VERSION, else v24.0)

import { fileURLToPath } from "node:url";
import { config as loadEnv } from "dotenv";

loadEnv();
// src/config/automation.ts → repo root is four levels up.
loadEnv({ path: fileURLToPath(new URL("../../../../.env", import.meta.url)) });

const ON_VALUES = ["true", "1", "yes", "on"];
const on = (v: string | undefined) => ON_VALUES.includes((v ?? "").trim().toLowerCase());
const str = (v: string | undefined): string | undefined => {
  const t = (v ?? "").trim();
  return t.length > 0 ? t : undefined;
};

/** True only when ENABLE_AUTOMATION says on. */
export function isAutomationEnabled(): boolean {
  return on(process.env.ENABLE_AUTOMATION);
}

/** Why the LinkedIn DM button is disabled (shown as its tooltip). */
export const LINKEDIN_DM_UNAVAILABLE_REASON =
  "LinkedIn has no public messaging API: its Messages API is limited to approved LinkedIn partners, and this account " +
  "isn't one. Automating the LinkedIn website instead breaks LinkedIn's terms and can get the account banned, so " +
  "messages can't be sent from here.";

const DEFAULT_LINKEDIN_VERSION = "202606";

export interface LinkedInSettings {
  configured: boolean;
  token?: string;
  adAccountId?: string;
  apiVersion: string;
}

export function linkedinSettings(): LinkedInSettings {
  const token = str(process.env.LINKEDIN_ACCESS_TOKEN);
  const rawAccount = str(process.env.LINKEDIN_AD_ACCOUNT_ID)?.replace(/^urn:li:sponsoredAccount:/, "");
  const adAccountId = rawAccount && /^\d{1,30}$/.test(rawAccount) ? rawAccount : undefined;
  const version = str(process.env.LINKEDIN_API_VERSION);
  return {
    configured: !!token && !!adAccountId,
    token,
    adAccountId,
    apiVersion: version && /^\d{6}(\.\d{2})?$/.test(version) ? version : DEFAULT_LINKEDIN_VERSION,
  };
}

function graphVersion(): string {
  const v = str(process.env.AUTOMATION_META_GRAPH_VERSION) ?? str(process.env.META_GRAPH_API_VERSION) ?? "v24.0";
  return v.startsWith("v") ? v : `v${v}`;
}

export interface MetaAdsSettings {
  configured: boolean;
  token?: string;
  /** Always "act_<digits>". */
  adAccountId?: string;
  graphVersion: string;
}

export function metaAdsSettings(): MetaAdsSettings {
  const token = str(process.env.META_ADS_ACCESS_TOKEN);
  const raw = str(process.env.META_AD_ACCOUNT_ID)?.replace(/^act_/, "");
  const adAccountId = raw && /^\d{1,30}$/.test(raw) ? `act_${raw}` : undefined;
  return { configured: !!token && !!adAccountId, token, adAccountId, graphVersion: graphVersion() };
}

export interface InstagramMessagingSettings {
  configured: boolean;
  token?: string;
  pageId?: string;
  igAccountId?: string;
  humanAgentEnabled: boolean;
  graphVersion: string;
}

export function instagramMessagingSettings(): InstagramMessagingSettings {
  const token = str(process.env.INSTAGRAM_MESSAGING_ACCESS_TOKEN);
  const pageId = str(process.env.INSTAGRAM_PAGE_ID);
  const igAccountId = str(process.env.INSTAGRAM_ACCOUNT_ID);
  const digits = (v?: string) => (v && /^\d{1,30}$/.test(v) ? v : undefined);
  return {
    configured: !!token && !!digits(pageId) && !!digits(igAccountId),
    token,
    pageId: digits(pageId),
    igAccountId: digits(igAccountId),
    humanAgentEnabled: on(process.env.INSTAGRAM_HUMAN_AGENT_ENABLED),
    graphVersion: graphVersion(),
  };
}

/** Every configured secret, so error text from LinkedIn / Meta can be scrubbed before it goes anywhere. */
export function automationSecrets(): string[] {
  return [linkedinSettings().token, metaAdsSettings().token, instagramMessagingSettings().token].filter(
    (s): s is string => !!s && s.length >= 6,
  );
}
