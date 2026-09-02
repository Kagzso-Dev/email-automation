import { redis } from "../redis.js";
import { env } from "../env.js";

const key = () => `dispatch:sent:${new Date().toISOString().slice(0, 10)}`;

export async function dailyCapReached(): Promise<boolean> {
  const n = Number((await redis.get(key())) ?? 0);
  return n >= env.SEND_DAILY_CAP;
}

export async function incrementDailyCount(): Promise<void> {
  const k = key();
  const n = await redis.incr(k);
  if (n === 1) await redis.expire(k, 60 * 60 * 48);
}

export async function todaysCount(): Promise<number> {
  return Number((await redis.get(key())) ?? 0);
}

/** Milliseconds until the next UTC midnight — how long to defer a capped job. */
export function msUntilNextWindow(): number {
  const now = new Date();
  const next = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1));
  return next.getTime() - now.getTime();
}
