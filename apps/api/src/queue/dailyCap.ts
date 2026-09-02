import { prisma } from "../prisma.js";
import { env } from "../env.js";

function startOfUtcDay(): Date {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

/** Emails actually sent since 00:00 UTC — the SES 24h sandbox window. */
export async function todaysCount(): Promise<number> {
  return prisma.emailLog.count({ where: { sentAt: { gte: startOfUtcDay() } } });
}

export async function dailyCapReached(): Promise<boolean> {
  return (await todaysCount()) >= env.SEND_DAILY_CAP;
}

/** Milliseconds until the next UTC midnight — how long to defer a capped job. */
export function msUntilNextWindow(): number {
  const now = new Date();
  const next = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1));
  return next.getTime() - now.getTime();
}
