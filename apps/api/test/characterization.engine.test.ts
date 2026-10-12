import { beforeEach, describe, expect, it, vi } from "vitest";

// Characterization tests for the MySQL job queue (queue/engine.ts): enqueue
// defaults and dedupe, and how one claimed job is finished — completed,
// deferred, retried with exponential backoff, or dead-lettered. Prisma is mocked.

const job = vi.hoisted(() => ({
  upsert: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  updateMany: vi.fn(),
  findMany: vi.fn(),
  findUnique: vi.fn(),
  deleteMany: vi.fn(),
}));
vi.mock("../src/prisma.js", () => ({ prisma: { job } }));

const { enqueue, QueueWorker, PermanentJobError, DeferJobError, pruneJobs } = await import("../src/queue/engine.js");
const { Prisma } = await import("@prisma/client");

beforeEach(() => {
  vi.clearAllMocks();
  job.upsert.mockResolvedValue({ id: "j-up" });
  job.create.mockResolvedValue({ id: "j-new" });
  job.update.mockResolvedValue({});
});

describe("enqueue (characterization)", () => {
  it("without a dedupe key: creates a job, 1 attempt, runs now", async () => {
    const before = Date.now();
    await expect(enqueue("q", { a: 1 })).resolves.toBe("j-new");
    const data = job.create.mock.calls[0]![0].data;
    expect(data).toMatchObject({ queue: "q", payload: { a: 1 }, maxAttempts: 1, dedupeKey: null });
    expect(data.runAt.getTime()).toBeGreaterThanOrEqual(before);
    expect(job.upsert).not.toHaveBeenCalled();
  });

  it("with a dedupe key: upserts and leaves an existing job untouched", async () => {
    const runAt = new Date("2030-01-01T00:00:00Z");
    await expect(enqueue("q", { a: 1 }, { dedupeKey: "d1", maxAttempts: 5, runAt })).resolves.toBe("j-up");
    expect(job.upsert).toHaveBeenCalledWith({
      where: { dedupeKey: "d1" },
      create: { queue: "q", payload: { a: 1 }, runAt, maxAttempts: 5, dedupeKey: "d1" },
      update: {},
    });
    expect(job.create).not.toHaveBeenCalled();
  });
});

describe("QueueWorker job outcome (characterization)", () => {
  // `run` is private; tests drive it directly to pin the state transitions.
  const runOne = (processor: () => Promise<unknown>, attempts = 1, maxAttempts = 3, backoffMs?: number) => {
    const w = new QueueWorker({ queue: "q", processor, backoffMs }) as unknown as {
      run: (j: { id: string; payload: unknown; attempts: number; maxAttempts: number }) => Promise<void>;
    };
    return w.run({ id: "j1", payload: { x: 1 }, attempts, maxAttempts });
  };
  const lastData = () => job.update.mock.calls.at(-1)![0].data;

  it("success: COMPLETED, result stored, lock cleared", async () => {
    await runOne(async () => ({ ok: true }));
    expect(job.update).toHaveBeenCalledWith({
      where: { id: "j1" },
      data: { status: "COMPLETED", lockedAt: null, lockedBy: null, lastError: null, result: { ok: true } },
    });
  });

  it("success with no result stores DbNull", async () => {
    await runOne(async () => undefined);
    expect(lastData().result).toBe(Prisma.DbNull);
  });

  it("DeferJobError: back to PENDING at runAt without consuming an attempt", async () => {
    const runAt = new Date("2030-01-01T00:00:00Z");
    await runOne(async () => {
      throw new DeferJobError(runAt);
    });
    expect(lastData()).toEqual({ status: "PENDING", runAt, attempts: { decrement: 1 }, lockedAt: null, lockedBy: null });
  });

  it("PermanentJobError: DEAD immediately with the message", async () => {
    await runOne(async () => {
      throw new PermanentJobError("nope");
    });
    expect(lastData()).toEqual({ status: "DEAD", lastError: "nope", lockedAt: null, lockedBy: null });
  });

  it("attempts exhausted: DEAD", async () => {
    await runOne(async () => {
      throw new Error("flaky");
    }, 3, 3);
    expect(lastData()).toMatchObject({ status: "DEAD", lastError: "flaky" });
  });

  it("transient failure: PENDING with backoff 30s × 2^(attempt-1) by default", async () => {
    for (const [attempt, delay] of [[1, 30_000], [2, 60_000], [3, 120_000]] as const) {
      const before = Date.now();
      await runOne(async () => {
        throw new Error("flaky");
      }, attempt, 10);
      const d = lastData();
      expect(d).toMatchObject({ status: "PENDING", lastError: "flaky", lockedAt: null, lockedBy: null });
      const wait = d.runAt.getTime() - before;
      expect(wait).toBeGreaterThanOrEqual(delay);
      expect(wait).toBeLessThan(delay + 1000);
    }
  });

  it("custom backoffMs is the base of the exponential delay", async () => {
    const before = Date.now();
    await runOne(async () => {
      throw new Error("x");
    }, 2, 5, 1000);
    const wait = lastData().runAt.getTime() - before;
    expect(wait).toBeGreaterThanOrEqual(2000);
    expect(wait).toBeLessThan(3000);
  });

  it("non-Error throw is stringified", async () => {
    await runOne(async () => {
      throw "plain"; // eslint-disable-line no-throw-literal
    }, 1, 1);
    expect(lastData()).toMatchObject({ status: "DEAD", lastError: "plain" });
  });
});

describe("pruneJobs (characterization)", () => {
  it("deletes COMPLETED jobs older than 7 days by default", async () => {
    job.deleteMany.mockResolvedValue({ count: 4 });
    const before = Date.now();
    await expect(pruneJobs()).resolves.toBe(4);
    const where = job.deleteMany.mock.calls[0]![0].where;
    expect(where.status).toBe("COMPLETED");
    expect(Math.abs(before - 7 * 86_400_000 - where.updatedAt.lt.getTime())).toBeLessThan(1000);
  });
});
