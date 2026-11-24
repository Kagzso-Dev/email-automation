// Shapes the Automation endpoints return (ENABLE_AUTOMATION). LinkedIn and Meta answers are mapped into these, so
// the web page renders both platforms the same way. Nothing here ever holds a token.

export type AutomationPlatform = "linkedin" | "instagram";

/** active | paused | draft (never run) | ended (completed / archived / deleted) | other */
export type CampaignState = "active" | "paused" | "draft" | "ended" | "other";

/** Meta only: where the campaign's ad sets show ads. "automatic" = Advantage+ placements (Instagram included). */
export type CampaignPlacement = "instagram" | "automatic" | "other" | "none";

export interface AutomationCampaign {
  id: string;
  name: string;
  /** The platform's own status word (ACTIVE, PAUSED, DRAFT, CAMPAIGN_PAUSED, …). */
  status: string;
  state: CampaignState;
  objective: string | null;
  dailyBudget: number | null;
  currency: string | null;
  /** Last 30 days; null when the numbers couldn't be read (see metricsError). */
  spend: number | null;
  impressions: number | null;
  clicks: number | null;
  /** Leads + conversions (+ purchases / conversations started on Meta). */
  conversions: number | null;
  placement?: CampaignPlacement;
  canPause: boolean;
  canResume: boolean;
}

export interface CampaignList {
  campaigns: AutomationCampaign[];
  /** The campaigns loaded but spend/results didn't (e.g. a token without the reporting permission). */
  metricsError: string | null;
  currency: string | null;
}

export interface CreateCampaignInput {
  name: string;
  objective: string;
  dailyBudget: number;
  /** LinkedIn only: the campaign group the new campaign goes in. */
  campaignGroupId?: string;
}
