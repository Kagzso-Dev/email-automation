import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { hs } from "./fakePrismaHardStop.js";

// "One run at a time" with Hard stop (ENABLE_HARD_STOP only): a stopped or cancelled run whose call is still live
// counts as in progress, so no second call can start beside it. Flag off: only RUNNING counts, exactly as before.

vi.mock("../src/prisma.js", async () => ({ prisma: (await import("./fakePrismaHardStop.js")).hs.db }));

const { runInProgressReason, runningRun } = await import("../src/domain/aiCallLanguages.js");

const originalFlag = process.env.ENABLE_HARD_STOP;
afterAll(() => {
  if (originalFlag === undefined) delete process.env.ENABLE_HARD_STOP;
  else process.env.ENABLE_HARD_STOP = originalFlag;
});

beforeEach(() => {
  hs.reset();
  // A run that was stopped while one call was connected: the call is still live.
  hs.seed("aiCallRun", { id: "r1", status: "CANCELLED" });
  hs.seed("aiCallLog", { id: "l1", runId: "r1", status: "IN_PROGRESS", phone: "+919000000001", position: 0 });
  hs.seed("aiCallLog", { id: "l2", runId: "r1", status: "CANCELLED", phone: "+919000000002", position: 1 });
});

describe("a stopped run with a live call", () => {
  it("flag on: counts as in progress until that call ends", async () => {
    process.env.ENABLE_HARD_STOP = "true";
    expect(await runInProgressReason("en")).toMatch(/still in progress/);
    expect(await runningRun()).toEqual({ runId: "r1", language: "en" });
    hs.T("aiCallLog")[0]!.status = "COMPLETED"; // the call ended normally
    expect(await runInProgressReason("en")).toBeNull();
    expect(await runningRun()).toBeNull();
  });

  it("flag off: only a RUNNING run counts, exactly as before", async () => {
    process.env.ENABLE_HARD_STOP = "false";
    expect(await runInProgressReason("en")).toBeNull();
    expect(await runningRun()).toBeNull();
    expect(hs.model("aiCallRun").findFirst).toHaveBeenCalledWith({ where: { status: "RUNNING" }, orderBy: { createdAt: "asc" }, select: { id: true } });
  });
});
