import IORedis from "ioredis";
import { env } from "./env.js";

/**
 * BullMQ requires `maxRetriesPerRequest: null` on the connection it uses for
 * blocking commands. We share one connection factory for queues, workers and
 * the scheduler lock.
 */
export function createRedis(): IORedis {
  return new IORedis(env.REDIS_URL, { maxRetriesPerRequest: null });
}

// A plain connection for one-off commands (counters, locks).
export const redis = createRedis();
