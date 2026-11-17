// Settings → Domain mode: the "Email all domains except blocked ones" switch, toggled here in the UI (the
// API hides it only when ENABLE_DOMAIN_BLOCKLIST=false). Read from GET /api/settings/sending-domains.
// Loading, an error, or an API without the endpoint all count as off: only the Approved list is shown and
// used, exactly as before.

import { useQuery } from "@tanstack/react-query";
import type { DomainMode } from "@dispatch/shared";
import { api } from "./api";

export interface BlockedDomain {
  id: string;
  domain: string;
  createdAt: string;
}

export type DomainAuditAction = "MODE_CHANGED" | "BLOCKED_ADDED" | "BLOCKED_REMOVED" | "APPROVED_ADDED" | "APPROVED_REMOVED";

export interface DomainAuditEntry {
  id: string;
  action: DomainAuditAction;
  detail: string;
  userEmail: string;
  createdAt: string;
}

export interface SendingDomainsView {
  enabled: boolean;
  /** false = the database update (migration 0036) isn't applied yet: the switch shows, disabled. */
  ready?: boolean;
  mode?: DomainMode;
  blocked?: BlockedDomain[];
  lastModeChange?: DomainAuditEntry | null;
  /** Admins only. */
  history?: DomainAuditEntry[];
}

export const SENDING_DOMAINS_QUERY = ["sending-domains"] as const;

/** Shown when an admin turns the switch on. */
export const BLOCKLIST_WARNING = "All domains will be emailed except blocked ones. This may affect deliverability.";

/** Offered as one-click fills for the Add box — never added on their own. */
export const THROWAWAY_DOMAIN_SUGGESTIONS = ["mailinator.com", "tempmail.com"] as const;

export function useSendingDomains() {
  const query = useQuery({
    queryKey: SENDING_DOMAINS_QUERY,
    queryFn: () => api<SendingDomainsView>("/api/settings/sending-domains"),
    retry: false,
  });
  const enabled = query.data?.enabled === true;
  return { ...query, enabled, blocklistOn: enabled && query.data?.mode === "BLOCKLIST" };
}

/** One line of the change log, e.g. "Blocked @mailinator.com". */
export function describeDomainChange(e: Pick<DomainAuditEntry, "action" | "detail">): string {
  switch (e.action) {
    case "MODE_CHANGED":
      return e.detail === "BLOCKLIST"
        ? "Turned on “Email all domains except blocked ones”"
        : "Turned off “Email all domains except blocked ones” (approved domains only)";
    case "BLOCKED_ADDED":
      return `Blocked @${e.detail}`;
    case "BLOCKED_REMOVED":
      return `Unblocked @${e.detail}`;
    case "APPROVED_ADDED":
      return `Approved @${e.detail}`;
    case "APPROVED_REMOVED":
      return `Removed @${e.detail} from the approved list`;
    default:
      return `${e.action} ${e.detail}`;
  }
}
