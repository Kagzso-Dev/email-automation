// Automation (ENABLE_AUTOMATION): LinkedIn Automation + Instagram Automation. Read from GET /api/automation/config:
// with the flag off that endpoint answers 404, and a 404, any other error, loading, or an API without the endpoint
// all count as OFF — the sidebar and routes are then exactly as before.
//
// Admins and editors only (the API enforces it too). Tokens never reach the browser: the API only says whether each
// platform is configured / connected.

import { useQuery } from "@tanstack/react-query";
import { api } from "./api";
import type { Brand } from "../components/automation/BrandIcons";
import type { IconName } from "../components/icons";

export type AutomationPlatform = Brand;

export interface AutomationConfig {
  enabled: boolean;
  linkedin: { adsConfigured: boolean; dmAvailable: false; dmReason: string };
  instagram: { adsConfigured: boolean; messagingConfigured: boolean; humanAgentEnabled: boolean };
}

export const AUTOMATION_CONFIG_KEY = ["automation", "config"] as const;
const loadConfig = () => api<AutomationConfig>("/api/automation/config").catch(() => null);

/** The flag (OFF until known) plus the config, and whether it's still loading (the pages wait instead of redirecting). */
export function useAutomationState(): { enabled: boolean; loading: boolean; config: AutomationConfig | null } {
  const q = useQuery({ queryKey: AUTOMATION_CONFIG_KEY, queryFn: loadConfig, staleTime: 60_000, retry: false });
  const config = q.data?.enabled === true ? q.data : null;
  return { enabled: !!config, loading: q.isLoading, config };
}

export const AUTOMATION_PATHS: Record<AutomationPlatform, string> = {
  linkedin: "/automation/linkedin",
  instagram: "/automation/instagram",
};

/** Who gets the Automation pages. */
export const canUseAutomation = (role: string | null | undefined) => role === "ADMIN" || role === "EDITOR";

/** The sidebar section: foldable like "Calls · English", right after Main (which ends with Data Quality's group). */
export const AUTOMATION_NAV_GROUP: {
  label: string;
  collapsible: true;
  items: { to: string; label: string; icon: IconName; brand: Brand }[];
} = {
  label: "Automation",
  collapsible: true,
  items: [
    { to: AUTOMATION_PATHS.linkedin, label: "LinkedIn Automation", icon: "campaigns", brand: "linkedin" },
    { to: AUTOMATION_PATHS.instagram, label: "Instagram Automation", icon: "campaigns", brand: "instagram" },
  ],
};

/**
 * Flag on: `group` goes in right after the "Main" section (first, if there is none). Flag off: `groups` itself is
 * returned, untouched, so the menu is exactly as before.
 */
export function withAutomationGroup<G extends { label: string }>(groups: G[], on: boolean, group: G): G[] {
  if (!on) return groups;
  const at = groups.findIndex((g) => g.label === "Main");
  return at < 0 ? [group, ...groups] : [...groups.slice(0, at + 1), group, ...groups.slice(at + 1)];
}

/* ------------------------------------------------------------------ API shapes */

export type ConnectionError = { code: string; message: string } | null;

export interface Connection<A> {
  configured: boolean;
  connected: boolean;
  account: A | null;
  error: ConnectionError;
}

export interface AdAccount {
  id: string;
  name: string | null;
  currency: string | null;
  status: string | null;
}

export interface AutomationStatus {
  platform: AutomationPlatform;
  ads: Connection<AdAccount>;
  messaging?: Connection<{ id: string; username: string | null }>;
  dm: { available: boolean; reason: string | null; humanAgentEnabled?: boolean };
}

export type CampaignState = "active" | "paused" | "draft" | "ended" | "other";

export interface AutomationCampaign {
  id: string;
  name: string;
  status: string;
  state: CampaignState;
  objective: string | null;
  dailyBudget: number | null;
  currency: string | null;
  spend: number | null;
  impressions: number | null;
  clicks: number | null;
  conversions: number | null;
  placement?: "instagram" | "automatic" | "other" | "none";
  canPause: boolean;
  canResume: boolean;
}

export interface CampaignList {
  campaigns: AutomationCampaign[];
  metricsError: string | null;
  currency: string | null;
}

export type WindowState = "open" | "human_agent" | "closed" | "no_inbound";

export interface DmRecipient {
  recipientId: string;
  username: string | null;
  lastInboundAt: string | null;
  window: WindowState;
  windowEndsAt: string | null;
}

export interface Conversations {
  now: string;
  humanAgentEnabled: boolean;
  recipients: DmRecipient[];
}

export interface DmPreview {
  recipients: Array<{ recipientId: string; username: string | null; allowed: boolean; tag: string | null; window: WindowState; reason: string | null; reasonText: string | null }>;
  sendable: number;
  blocked: number;
  confirmToken: string | null;
  expiresAt: string;
}

export interface DmSendResult {
  batchId: string;
  sent: number;
  failed: number;
  blocked: number;
  results: Array<{ recipientId: string; username: string | null; status: "sent" | "failed" | "blocked"; error: string | null }>;
}

export interface DmHistoryItem {
  id: string;
  recipientId: string;
  recipientName: string | null;
  message: string;
  messageTag: string | null;
  windowState: string;
  status: "sent" | "failed" | "blocked";
  errorMessage: string | null;
  sentByEmail: string;
  createdAt: string;
}

export interface DmHistoryPage {
  items: DmHistoryItem[];
  total: number;
  page: number;
  pageSize: number;
}

export const OBJECTIVES: Record<AutomationPlatform, Array<{ value: string; label: string }>> = {
  linkedin: [
    { value: "BRAND_AWARENESS", label: "Brand awareness" },
    { value: "WEBSITE_VISIT", label: "Website visits" },
    { value: "ENGAGEMENT", label: "Engagement" },
    { value: "VIDEO_VIEW", label: "Video views" },
    { value: "LEAD_GENERATION", label: "Lead generation" },
    { value: "WEBSITE_CONVERSION", label: "Website conversions" },
    { value: "JOB_APPLICANT", label: "Job applicants" },
  ],
  instagram: [
    { value: "OUTCOME_AWARENESS", label: "Awareness" },
    { value: "OUTCOME_TRAFFIC", label: "Traffic" },
    { value: "OUTCOME_ENGAGEMENT", label: "Engagement" },
    { value: "OUTCOME_LEADS", label: "Leads" },
    { value: "OUTCOME_SALES", label: "Sales" },
    { value: "OUTCOME_APP_PROMOTION", label: "App promotion" },
  ],
};

/** The most bytes Instagram takes in one text message. */
export const DM_MAX_BYTES = 1000;
export const DM_MAX_RECIPIENTS = 50;
export const utf8Bytes = (s: string) => new TextEncoder().encode(s).length;

/** "3 h ago", "2 d ago", "just now". */
export function ago(iso: string | null, now = Date.now()): string {
  if (!iso) return "—";
  const ms = now - new Date(iso).getTime();
  if (!Number.isFinite(ms)) return "—";
  if (ms < 60_000) return "just now";
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)} min ago`;
  if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)} h ago`;
  return `${Math.floor(ms / 86_400_000)} d ago`;
}

/** "21 h left", "45 min left", "5 d left". */
export function timeLeft(iso: string | null, now = Date.now()): string {
  if (!iso) return "";
  const ms = new Date(iso).getTime() - now;
  if (!Number.isFinite(ms) || ms <= 0) return "";
  if (ms < 3_600_000) return `${Math.max(1, Math.floor(ms / 60_000))} min left`;
  if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)} h left`;
  return `${Math.floor(ms / 86_400_000)} d left`;
}
