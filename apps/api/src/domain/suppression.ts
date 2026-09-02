import { prisma } from "../prisma.js";

/**
 * The ONLY code path allowed to decide whether an address may be sent to.
 * A contact is suppressed if their status is not ACTIVE, or an Unsubscribe
 * row exists. Suppression is derived, never a separate list to keep in sync.
 */
export async function isSuppressed(contactId: string): Promise<boolean> {
  const contact = await prisma.contact.findUnique({
    where: { id: contactId },
    select: { status: true, unsubscribe: { select: { id: true } } },
  });
  if (!contact) return true;
  if (contact.status !== "ACTIVE") return true;
  if (contact.unsubscribe) return true;
  return false;
}

export async function suppressForBounce(contactId: string, hard: boolean): Promise<void> {
  if (!hard) return; // soft bounces do not suppress
  await prisma.contact.update({ where: { id: contactId }, data: { status: "BOUNCED" } });
}

export async function suppressForComplaint(contactId: string): Promise<void> {
  await prisma.contact.update({ where: { id: contactId }, data: { status: "COMPLAINED" } });
}
