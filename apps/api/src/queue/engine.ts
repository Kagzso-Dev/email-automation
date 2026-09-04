import { randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";
import { prisma } from "../prisma.js";
import { logger } from "../logger.js";

/**
 * A small MySQL-backed job queue. Sized for this workload (a few hundred to a
 * few thousand emails a day, ~1/sec) — no Redis, no external broker. One row
 * per job; workers poll, claim with a conditional UPDATE, and process.
 */

export interface EnqueueOptions {
  runAt?: Date;
  maxAttempts?: number;
  /** Repeat enqueues with the same key collapse to one job. */
  dedupeKey?: string;
}

export class PermanentJobError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PermanentJobError";
  }
}

/** Processor asks to run again later without consuming a retry attempt. */
export class DeferJobError extends Error {
  constructor(public readonly runAt: Date) {
    super("deferred");
    this.name = "DeferJobError";
  }
}

export async function enqueue(
  queue: string,
  payload: unknown,
  opts: EnqueueOptions = {},
): Promise<string> {
  const data = {
    queue,
    payload: payload as Prisma.InputJsonValue,
    runAt: opts.runAt ?? new Date(),
    maxAttempts: opts.maxAttempts ?? 1,
    dedupeKey: opts.dedupeKey ?? null,
  };
  if (opts.dedupeKey) {
    const job = await prisma.job.upsert({
      where: { dedupeKey: opts.dedupeKey },
      create: data,
      update: {}, // already queued (or done) — leave it
    });
    return job.id;
  }
  const job = await prisma.job.create({ data });
  return job.id;
}

export type Processor = (payload: Record<string, unknown>, job: JobContext) => Promise<unknown>;
export interface JobContext {
  id: string;
  attempts: number;
  maxAttempts: number;
}

interface WorkerConfig {
  queue: string;
  processor: Processor;
  /** Max jobs claimed per poll. */
  batch?: number;
  /** Minimum gap between finishing one job and starting the next (rate limit). */
  minIntervalMs?: number;
  backoffMs?: number;
  pollMs?: number;
}

const STUCK_AFTER_MS = 5 * 60 * 1000;

export class QueueWorker {
  private timer: NodeJS.Timeout | undefined;
  private running = false;
  private stopped = false;
  private readonly id = `${process.pid}-${randomUUID().slice(0, 8)}`;

  constructor(private cfg: WorkerConfig) {}

  start(): this {
    const poll = this.cfg.pollMs ?? 2000;
    this.timer = setInterval(() => void this.tick(), poll);
    void this.tick();
    return this;
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    // let an in-flight tick finish
    for (let i = 0; i < 50 && this.running; i++) await sleep(100);
  }

  private async tick(): Promise<void> {
    if (this.running || this.stopped) return;
    this.running = true;
    try {
      await this.recoverStuck();
      const batch = this.cfg.batch ?? 10;
      const candidates = await prisma.job.findMany({
        where: { queue: this.cfg.queue, status: "PENDING", runAt: { lte: new Date() } },
        orderBy: { runAt: "asc" },
        take: batch,
        select: { id: true },
      });
      for (const { id } of candidates) {
        if (this.stopped) break;
        const claimed = await this.claim(id);
        if (!claimed) continue;
        await this.run(claimed);
        if (this.cfg.minIntervalMs) await sleep(this.cfg.minIntervalMs);
      }
    } catch (err) {
      logger.error({ err, queue: this.cfg.queue }, "queue tick failed");
    } finally {
      this.running = false;
    }
  }

  private async claim(id: string) {
    const res = await prisma.job.updateMany({
      where: { id, status: "PENDING" },
      data: { status: "ACTIVE", lockedAt: new Date(), lockedBy: this.id, attempts: { increment: 1 } },
    });
    if (res.count !== 1) return null; // lost the race
    return prisma.job.findUnique({ where: { id } });
  }

  private async run(job: NonNullable<Awaited<ReturnType<QueueWorker["claim"]>>>): Promise<void> {
    const payload = (job.payload ?? {}) as Record<string, unknown>;
    try {
      const result = await this.cfg.processor(payload, {
        id: job.id,
        attempts: job.attempts,
        maxAttempts: job.maxAttempts,
      });
      await prisma.job.update({
        where: { id: job.id },
        data: {
          status: "COMPLETED",
          lockedAt: null,
          lockedBy: null,
          lastError: null,
          result:
            result === undefined || result === null
              ? Prisma.DbNull
              : (result as Prisma.InputJsonValue),
        },
      });
    } catch (err) {
      if (err instanceof DeferJobError) {
        await prisma.job.update({
          where: { id: job.id },
          data: {
            status: "PENDING",
            runAt: err.runAt,
            attempts: { decrement: 1 }, // deferral is not a retry
            lockedAt: null,
            lockedBy: null,
          },
        });
        return;
      }
      const message = err instanceof Error ? err.message : String(err);
      const permanent = err instanceof PermanentJobError;
      const exhausted = job.attempts >= job.maxAttempts;
      if (permanent || exhausted) {
        logger.error({ jobId: job.id, queue: this.cfg.queue, err: message, permanent }, "job dead");
        await prisma.job.update({
          where: { id: job.id },
          data: { status: "DEAD", lastError: message, lockedAt: null, lockedBy: null },
        });
      } else {
        const delay = (this.cfg.backoffMs ?? 30_000) * 2 ** (job.attempts - 1);
        logger.warn(
          { jobId: job.id, queue: this.cfg.queue, attempt: job.attempts, retryInMs: delay, err: message },
          "job failed — will retry",
        );
        await prisma.job.update({
          where: { id: job.id },
          data: {
            status: "PENDING",
            runAt: new Date(Date.now() + delay),
            lastError: message,
            lockedAt: null,
            lockedBy: null,
          },
        });
      }
    }
  }

  private async recoverStuck(): Promise<void> {
    await prisma.job.updateMany({
      where: {
        queue: this.cfg.queue,
        status: "ACTIVE",
        lockedAt: { lt: new Date(Date.now() - STUCK_AFTER_MS) },
      },
      data: { status: "PENDING", lockedAt: null, lockedBy: null },
    });
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Housekeeping: drop old finished rows so the table stays small. */
export async function pruneJobs(olderThanDays = 7): Promise<number> {
  const cutoff = new Date(Date.now() - olderThanDays * 24 * 60 * 60 * 1000);
  const res = await prisma.job.deleteMany({
    where: { status: "COMPLETED", updatedAt: { lt: cutoff } },
  });
  return res.count;
}
