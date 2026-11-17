// Who changed the sending-domain rules, and when (sending_domain_audit, migration 0036). Not written when the
// kill switch ENABLE_DOMAIN_BLOCKLIST=false is set: the mode switch and the Blocked list (routes/sendingDomains — in the same
// transaction as the change) and the Approved list (routes/settings — best effort, so a logging problem can
// never stop the existing Approved-list feature from working).

import { isDomainBlocklistEnabled } from "../config/domainBlocklist.js";
import { logger } from "../logger.js";
import { prisma } from "../prisma.js";

export const DOMAIN_AUDIT_ACTIONS = [
  "MODE_CHANGED",
  "BLOCKED_ADDED",
  "BLOCKED_REMOVED",
  "APPROVED_ADDED",
  "APPROVED_REMOVED",
] as const;
export type DomainAuditAction = (typeof DOMAIN_AUDIT_ACTIONS)[number];

export interface AuditUser {
  id: string;
  email: string;
}

/** The audit row as a Prisma operation, for a $transaction with the change itself. */
export function domainAuditCreate(user: AuditUser, action: DomainAuditAction, detail: string) {
  return prisma.sendingDomainAudit.create({
    data: { action, detail, userId: user.id, userEmail: user.email },
  });
}

/** Approved-list changes: logged only while the flag is on, and never fails the request. */
export async function recordApprovedListChange(
  user: AuditUser,
  action: "APPROVED_ADDED" | "APPROVED_REMOVED",
  domain: string,
): Promise<void> {
  if (!isDomainBlocklistEnabled()) return;
  logger.info({ by: user.email, action, domain }, "approved sending domain changed");
  try {
    await domainAuditCreate(user, action, domain);
  } catch (err) {
    logger.warn({ err: err instanceof Error ? err.message : String(err), action, domain }, "domain audit not written");
  }
}

/** Newest first. */
export function listDomainAudit(take: number) {
  return prisma.sendingDomainAudit.findMany({ orderBy: { createdAt: "desc" }, take });
}

/** The latest mode switch, or null when the mode was never changed. */
export function lastModeChange() {
  return prisma.sendingDomainAudit.findFirst({
    where: { action: "MODE_CHANGED" },
    orderBy: { createdAt: "desc" },
  });
}
