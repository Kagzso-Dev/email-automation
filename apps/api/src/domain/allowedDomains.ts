import { prisma } from "../prisma.js";
import { checkEmailDomainNow } from "./sendingDomainPolicy.js";

/** Bare, lowercased domain of an address ("" when it has no `@`). */
export function domainOf(email: string): string {
  const at = email.lastIndexOf("@");
  return at === -1 ? "" : email.slice(at + 1).toLowerCase().trim();
}

/**
 * Pure allowlist test. An empty (or absent) list means "no restriction" — every
 * address passes. Otherwise the address domain must be one of `allowed`.
 */
export function domainAllowed(
  email: string,
  allowed: readonly string[] | null | undefined,
): boolean {
  if (!allowed || allowed.length === 0) return true;
  const d = domainOf(email);
  return d !== "" && allowed.includes(d);
}

/** Current approved domains, lowercased, sorted for display. */
export async function loadAllowedDomains(): Promise<string[]> {
  const rows = await prisma.allowedDomain.findMany({
    select: { domain: true },
    orderBy: { domain: "asc" },
  });
  return rows.map((r) => r.domain);
}

/**
 * DB-backed single-address check, for the send path (and manual add/edit, manual and Send Queue sends).
 * Follows the active domain mode (domain/sendingDomainPolicy): with ENABLE_DOMAIN_BLOCKLIST off, or in
 * ALLOWLIST mode, it is exactly `domainAllowed(email, await loadAllowedDomains())`, as it always was.
 */
export async function isEmailDomainAllowed(email: string): Promise<boolean> {
  return (await checkEmailDomainNow(email)).ok;
}
