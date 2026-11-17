// Which recipient domains may be emailed. Two modes (Settings → Domain mode, behind ENABLE_DOMAIN_BLOCKLIST):
//
//   ALLOWLIST  the default, and always the mode while the flag is off. Only domains on the Approved list
//              (AllowedDomain) are emailed; an empty Approved list means no restriction. Exact match — the
//              rule as it was before this feature, unchanged.
//   BLOCKLIST  every domain except those on the Blocked list (blocked_sending_domains). A blocked entry also
//              blocks its subdomains: "mailinator.com" blocks "x.mailinator.com" but not "notmailinator.com".
//              An address that isn't a usable email is refused as invalid.
//
// Matching is case-insensitive and the same everywhere: at import (queue/contactImport), on manual add/edit
// (routes/contacts) and again at send time (domain/delivery, via isEmailDomainAllowed) — so switching the mode
// applies to contacts already saved. Suppression (unsubscribed, bounced, complained — domain/suppression) is a
// separate check that always runs first; no mode can bypass it.

import type { DomainMode } from "@dispatch/shared";
import { isDomainBlocklistEnabled } from "../config/domainBlocklist.js";
import { logger } from "../logger.js";
import { prisma } from "../prisma.js";
import { domainAllowed, domainOf, loadAllowedDomains } from "./allowedDomains.js";

/** Setting row holding the mode. No row (every existing install) = ALLOWLIST. */
export const DOMAIN_MODE_KEY = "sendingDomainMode";

export type DomainPolicy =
  | { mode: "ALLOWLIST"; allowed: readonly string[] }
  | { mode: "BLOCKLIST"; blocked: readonly string[] };

/** not_approved: ALLOWLIST refused it. blocked / invalid: BLOCKLIST refused it. */
export type DomainRejection = "not_approved" | "blocked" | "invalid";
export type DomainVerdict = { ok: true } | { ok: false; reason: DomainRejection };

// One "@", something on both sides, a dot in the domain, no spaces.
const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function usableEmail(email: string): boolean {
  return EMAIL_SHAPE.test(email.trim().toLowerCase());
}

/** True when the address's domain is a blocked entry or a subdomain of one. Case-insensitive. */
export function domainBlocked(email: string, blocked: readonly string[]): boolean {
  const d = domainOf(email).replace(/\.$/, "");
  if (!d) return false;
  return blocked.some((entry) => {
    const b = entry.trim().toLowerCase();
    return b !== "" && (d === b || d.endsWith(`.${b}`));
  });
}

/** Pure check of one address against a loaded policy. */
export function checkEmailDomain(email: string, policy: DomainPolicy): DomainVerdict {
  if (policy.mode === "ALLOWLIST") {
    return domainAllowed(email, policy.allowed) ? { ok: true } : { ok: false, reason: "not_approved" };
  }
  if (!usableEmail(email)) return { ok: false, reason: "invalid" };
  return domainBlocked(email, policy.blocked) ? { ok: false, reason: "blocked" } : { ok: true };
}

/** The active mode. Always ALLOWLIST while the flag is off — and then nothing is read. */
export async function getDomainMode(): Promise<DomainMode> {
  if (!isDomainBlocklistEnabled()) return "ALLOWLIST";
  const row = await prisma.setting.findUnique({ where: { key: DOMAIN_MODE_KEY } });
  return row?.value === "BLOCKLIST" ? "BLOCKLIST" : "ALLOWLIST";
}

/** Current blocked domains, lowercased, sorted for display. */
export async function loadBlockedDomains(): Promise<string[]> {
  const rows = await prisma.blockedSendingDomain.findMany({
    select: { domain: true },
    orderBy: { domain: "asc" },
  });
  return rows.map((r) => r.domain);
}

/**
 * The active policy, read fresh on every call (no cache, so a change in Settings applies to the next
 * import or send). Flag off or ALLOWLIST: the same single Approved-list query the app always ran.
 */
export async function loadDomainPolicy(): Promise<DomainPolicy> {
  if ((await getDomainMode()) === "BLOCKLIST") return { mode: "BLOCKLIST", blocked: await loadBlockedDomains() };
  return { mode: "ALLOWLIST", allowed: await loadAllowedDomains() };
}

/** DB-backed single-address check against the active policy. */
export async function checkEmailDomainNow(email: string): Promise<DomainVerdict> {
  return checkEmailDomain(email, await loadDomainPolicy());
}

/* ------------------------------------------------------------------ wording */

// The decision is always made by isEmailDomainAllowed (domain/allowedDomains); these only word it. In
// ALLOWLIST mode (and always with the flag off) every text is exactly what the app said before.
const SEND_LOG_TEXT: Record<DomainRejection, string> = {
  not_approved: "domain not approved",
  blocked: "domain blocked",
  invalid: "invalid email address",
};
const SKIP_TEXT: Record<DomainRejection, string> = {
  not_approved: "email domain is not on the approved sending list",
  blocked: "email domain is on the blocked sending list",
  invalid: "email address is not valid",
};

/**
 * Why the active mode refuses `email` — for messages only. Reading the mode fails → "not_approved", i.e.
 * today's wording (the send itself was already refused; only the text is at stake here).
 */
export async function domainRejection(email: string): Promise<DomainRejection> {
  try {
    if ((await getDomainMode()) === "ALLOWLIST") return "not_approved";
  } catch (err) {
    logger.warn({ err: err instanceof Error ? err.message : String(err) }, "domain mode unreadable — approved-list wording used");
    return "not_approved";
  }
  return usableEmail(email) ? "blocked" : "invalid";
}

/** Email ledger / send log reason: "domain not approved" (ALLOWLIST), "domain blocked" (BLOCKLIST), … */
export async function domainSkipReason(email: string): Promise<string> {
  return SEND_LOG_TEXT[await domainRejection(email)];
}

/** Manual send / Send Queue skip reason: "email domain is not on the approved sending list", … */
export async function domainSkipText(email: string): Promise<string> {
  return SKIP_TEXT[await domainRejection(email)];
}

/** Manual add / edit (400): "Email domain is not on the approved sending list: a@b.com", … */
export async function domainRefusedMessage(email: string): Promise<string> {
  const text = await domainSkipText(email);
  return `${text.charAt(0).toUpperCase()}${text.slice(1)}: ${email}`;
}
