import { beforeEach, describe, expect, it, vi } from "vitest";
import { voiceTuningPreset } from "@dispatch/shared";

// Characterization tests for one iteration of the AI-call run orchestrator
// (queue/aiCallRun.ts): stop/finish, the gap between calls, do-not-call skips,
// dialling, start failures and in-flight polling/timeout. Prisma, the voice
// backend and the customer/flow helpers are mocked; DeferJobError is real.

const db = vi.hoisted(() => ({
  aiCallRun: { findUnique: vi.fn(), update: vi.fn() },
  aiCallLog: { findFirst: vi.fn(), findUnique: vi.fn(), update: vi.fn(), groupBy: vi.fn(), findMany: vi.fn(), updateMany: vi.fn() },
  // Settings → AI call languages (read only for runs of another language than English).
  setting: { findUnique: vi.fn() },
  aiAgent: { findUnique: vi.fn() }, // the agent behind a tuned call's flow (its own reply speed)
  $transaction: vi.fn(async (ops: unknown[]) => Promise.all(ops)),
}));
const voice = vi.hoisted(() => ({ getVoiceCall: vi.fn(), placeVoiceCall: vi.fn() }));
const helpers = vi.hoisted(() => ({
  applyVoiceUpdate: vi.fn(),
  loadDoNotCallPhones: vi.fn(),
  pinnedFlowForRun: vi.fn(),
  markCustomerCalling: vi.fn(),
  syncCustomerFromLog: vi.fn(),
  businessForCall: vi.fn(),
}));

vi.mock("../src/prisma.js", () => ({ prisma: db }));
vi.mock("../src/services/voiceBackend.js", async (orig) => ({
  ...(await orig<typeof import("../src/services/voiceBackend.js")>()),
  ...voice,
}));
vi.mock("../src/domain/aiCalls.js", async (orig) => ({
  ...(await orig<typeof import("../src/domain/aiCalls.js")>()),
  applyVoiceUpdate: helpers.applyVoiceUpdate,
  loadDoNotCallPhones: helpers.loadDoNotCallPhones,
}));
vi.mock("../src/domain/callFlows.js", () => ({ pinnedFlowForRun: helpers.pinnedFlowForRun }));
vi.mock("../src/domain/aiCallCustomerSync.js", () => ({
  markCustomerCalling: helpers.markCustomerCalling,
  syncCustomerFromLog: helpers.syncCustomerFromLog,
  businessForCall: helpers.businessForCall,
}));

const { processAiCallRun } = await import("../src/queue/aiCallRun.js");
const { DeferJobError } = await import("../src/queue/engine.js");
const { aiCallsConfig } = await import("../src/config/aiCalls.js");

const run = { id: "r1", status: "RUNNING", gapSeconds: 30 };
const next = { id: "l2", phone: "919876543210", customerName: "Asha", gender: "female", followUpDetail: "demo", position: 1 };

/** findFirst is called for: in-flight log, a completed call still without its result, next QUEUED log, last ended log — in that order. */
function logs({
  inFlight = null,
  queued = next,
  lastEnded = null,
  settling = null,
}: { inFlight?: unknown; queued?: unknown; lastEnded?: unknown; settling?: unknown }) {
  db.aiCallLog.findFirst.mockImplementation(async (args: { where: { status?: unknown; endedAt?: unknown; outcome?: unknown } }) => {
    if (args.where.status === "COMPLETED" && args.where.outcome === null) return settling;
    if (args.where.endedAt) return lastEnded;
    if (args.where.status === "QUEUED") return queued;
    return inFlight;
  });
}
const deferredMs = async (p: Promise<unknown>) => {
  const before = Date.now();
  const err = await p.then(
    () => null,
    (e) => e,
  );
  expect(err).toBeInstanceOf(DeferJobError);
  return (err as InstanceType<typeof DeferJobError>).runAt.getTime() - before;
};

beforeEach(() => {
  vi.clearAllMocks();
  db.aiCallRun.findUnique.mockResolvedValue(run);
  db.aiCallRun.update.mockResolvedValue({});
  db.aiCallLog.update.mockResolvedValue({});
  db.aiCallLog.groupBy.mockResolvedValue([
    { status: "COMPLETED", _count: { _all: 2 } },
    { status: "FAILED", _count: { _all: 1 } },
  ]);
  helpers.loadDoNotCallPhones.mockResolvedValue(new Set());
  helpers.pinnedFlowForRun.mockResolvedValue({ flowId: "f1", version: 3 });
  voice.placeVoiceCall.mockResolvedValue({ callId: "v1", providerCallId: "p1" });
  logs({});
});

describe("processAiCallRun (characterization)", () => {
  it("run gone", async () => {
    db.aiCallRun.findUnique.mockResolvedValueOnce(null);
    await expect(processAiCallRun({ runId: "r1" })).resolves.toEqual({ skipped: "run gone" });
  });

  it("stopped run (not RUNNING) returns its status once nothing is in flight", async () => {
    db.aiCallRun.findUnique.mockResolvedValueOnce({ ...run, status: "STOPPED" });
    await expect(processAiCallRun({ runId: "r1" })).resolves.toEqual({ stopped: "STOPPED" });
    expect(voice.placeVoiceCall).not.toHaveBeenCalled();
  });

  it("no QUEUED logs left: run DONE with status counts", async () => {
    logs({ queued: null });
    await expect(processAiCallRun({ runId: "r1" })).resolves.toEqual({ done: true, COMPLETED: 2, FAILED: 1 });
    expect(db.aiCallRun.update).toHaveBeenCalledWith({ where: { id: "r1" }, data: { status: "DONE", nextCallAt: null } });
  });

  it("gap not yet passed: stores nextCallAt and defers until lastEnded + gapSeconds", async () => {
    const endedAt = new Date(Date.now() - 10_000);
    logs({ lastEnded: { endedAt } });
    const err = (await processAiCallRun({ runId: "r1" }).catch((e) => e)) as InstanceType<typeof DeferJobError>;
    expect(err).toBeInstanceOf(DeferJobError);
    expect(err.runAt.getTime()).toBe(endedAt.getTime() + 30_000);
    expect(db.aiCallRun.update).toHaveBeenCalledWith({ where: { id: "r1" }, data: { nextCallAt: new Date(endedAt.getTime() + 30_000) } });
    expect(voice.placeVoiceCall).not.toHaveBeenCalled();
  });

  it("do-not-call number: log FAILED with the skip reason, customer synced, defer 1s", async () => {
    helpers.loadDoNotCallPhones.mockResolvedValueOnce(new Set([next.phone]));
    const wait = await deferredMs(processAiCallRun({ runId: "r1" }));
    expect(wait).toBeGreaterThanOrEqual(1000);
    expect(wait).toBeLessThan(2000);
    expect(db.aiCallLog.update).toHaveBeenCalledWith({
      where: { id: "l2" },
      data: { status: "FAILED", error: "Skipped — number is on the do-not-call list" },
    });
    expect(helpers.syncCustomerFromLog).toHaveBeenCalledWith("l2");
    expect(voice.placeVoiceCall).not.toHaveBeenCalled();
  });

  it("a Kannada autonomous flow (paused): log FAILED with the reason, nothing dialled, run continues", async () => {
    helpers.pinnedFlowForRun.mockResolvedValue({
      flowId: "f_kn", version: 1, draft: false, language: "kn", definition: { language: "kn", autonomous: { target_duration_sec: 60 } },
    });
    db.setting.findUnique.mockResolvedValue(null);
    const wait = await deferredMs(processAiCallRun({ runId: "r1" }));
    expect(wait).toBeGreaterThanOrEqual(1000);
    expect(wait).toBeLessThan(2000);
    expect(voice.placeVoiceCall).not.toHaveBeenCalled();
    expect(db.aiCallLog.update).toHaveBeenCalledWith({
      where: { id: "l2" },
      data: { status: "FAILED", error: expect.stringMatching(/^Skipped — Kannada Autonomous AI calls are paused/) },
    });
    expect(helpers.syncCustomerFromLog).toHaveBeenCalledWith("l2");
  });

  it("a Kannada flow that is not autonomous dials as before", async () => {
    helpers.pinnedFlowForRun.mockResolvedValue({ flowId: "f_kn", version: 1, draft: false, language: "kn", definition: { language: "kn" } });
    db.setting.findUnique.mockResolvedValue(null);
    await deferredMs(processAiCallRun({ runId: "r1" }));
    expect(voice.placeVoiceCall).toHaveBeenCalledTimes(1);
  });

  it("dials the next customer with the pinned flow, stores ids, defers 5s to poll", async () => {
    const wait = await deferredMs(processAiCallRun({ runId: "r1" }));
    expect(wait).toBeGreaterThanOrEqual(5000);
    expect(wait).toBeLessThan(6000);
    expect(db.aiCallLog.update).toHaveBeenNthCalledWith(1, { where: { id: "l2" }, data: { status: "DIALING", startedAt: expect.any(Date) } });
    expect(db.aiCallRun.update).toHaveBeenCalledWith({ where: { id: "r1" }, data: { nextCallAt: null } });
    expect(helpers.markCustomerCalling).toHaveBeenCalledWith("l2");
    expect(voice.placeVoiceCall).toHaveBeenCalledWith({
      customerName: "Asha",
      gender: "female",
      followUpDetail: "demo",
      phone: "919876543210",
      runId: "r1",
      logId: "l2",
      flow: { flowId: "f1", version: 3 },
    });
    expect(db.aiCallLog.update).toHaveBeenLastCalledWith({ where: { id: "l2" }, data: { voiceCallId: "v1", providerCallId: "p1" } });
  });

  it("passes the run's AI greeting delay to each call; the gap between calls is unchanged", async () => {
    db.aiCallRun.findUnique.mockResolvedValue({ ...run, skipped: { invalid: 0, greetingDelaySec: 2 } });
    await deferredMs(processAiCallRun({ runId: "r1" }));
    expect(voice.placeVoiceCall).toHaveBeenCalledWith(expect.objectContaining({ greetingDelaySec: 2, logId: "l2" }));

    // The gap still counts from when the previous call ended, as before.
    vi.clearAllMocks();
    db.aiCallRun.findUnique.mockResolvedValue({ ...run, skipped: { greetingDelaySec: 10 } });
    db.aiCallRun.update.mockResolvedValue({});
    const endedAt = new Date(Date.now() - 10_000);
    logs({ lastEnded: { endedAt } });
    const err = (await processAiCallRun({ runId: "r1" }).catch((e) => e)) as InstanceType<typeof DeferJobError>;
    expect(err.runAt.getTime()).toBe(endedAt.getTime() + 30_000);
    expect(voice.placeVoiceCall).not.toHaveBeenCalled();
  });

  it("a run without the setting (older runs, test calls) sends no greeting delay", async () => {
    await deferredMs(processAiCallRun({ runId: "r1" }));
    expect(voice.placeVoiceCall.mock.calls[0]![0]).not.toHaveProperty("greetingDelaySec");
  });

  it("an agent's flow: the contact's business is read at dial time and sent", async () => {
    const definition = { autonomous: { target_duration_sec: 60, natural_lines: true, contact_business: true } };
    helpers.pinnedFlowForRun.mockResolvedValue({ flowId: "f1", version: 3, language: "ta", definition });
    helpers.businessForCall.mockResolvedValue("Sri Lakshmi Textiles");
    logs({});
    await deferredMs(processAiCallRun({ runId: "r1" }));
    expect(helpers.businessForCall).toHaveBeenCalledWith("l2", next.phone, "ta");
    expect(voice.placeVoiceCall).toHaveBeenCalledWith(expect.objectContaining({ logId: "l2", customerBusiness: "Sri Lakshmi Textiles" }));
  });

  it("an agent's flow, nothing on file: the call goes out without a business, and the AI asks", async () => {
    helpers.pinnedFlowForRun.mockResolvedValue({ flowId: "f1", version: 3, language: "en", definition: { autonomous: { contact_business: true } } });
    helpers.businessForCall.mockResolvedValue(null);
    logs({});
    await deferredMs(processAiCallRun({ runId: "r1" }));
    expect(voice.placeVoiceCall.mock.calls[0]![0]).not.toHaveProperty("customerBusiness");
  });

  it.each([
    ["a Guided or ordinary Call Flow", { flowId: "f1", version: 3, language: "en", definition: { language: "en" } }],
    ["an agent published before contact businesses", { flowId: "f1", version: 3, language: "en", definition: { autonomous: { natural_lines: true } } }],
    ["the default flow", null],
  ])("%s: the contact's details all go with the call (the voice backend decides how they are used)", async (_name, flow) => {
    helpers.pinnedFlowForRun.mockResolvedValue(flow);
    helpers.businessForCall.mockResolvedValue("hospital");
    logs({});
    await deferredMs(processAiCallRun({ runId: "r1" }));
    expect(helpers.businessForCall).toHaveBeenCalledWith("l2", next.phone, "en");
    expect(voice.placeVoiceCall).toHaveBeenCalledWith(
      expect.objectContaining({
        logId: "l2",
        phone: next.phone,
        customerName: next.customerName,
        gender: next.gender,
        followUpDetail: next.followUpDetail,
        customerBusiness: "hospital",
      }),
    );
  });

  it("voice response tuning: a Tamil call carries it, read at dial time", async () => {
    helpers.pinnedFlowForRun.mockResolvedValue({ flowId: "f1", version: 3, language: "ta" });
    logs({});
    await deferredMs(processAiCallRun({ runId: "r1" }));
    expect(voice.placeVoiceCall.mock.calls[0]![0].voiceTuning).toMatchObject({ preset: "balanced", end_of_speech_silence_ms: 900 });
  });

  it("voice response tuning: a Tamil call uses the reply speed of the agent behind its flow", async () => {
    helpers.pinnedFlowForRun.mockResolvedValue({ flowId: "f1", version: 3, language: "ta" });
    logs({});
    db.aiAgent.findUnique.mockResolvedValueOnce({ id: "ag1" });
    const earlier = db.setting.findUnique.getMockImplementation();
    db.setting.findUnique.mockImplementation(async ({ where }: { where: { key: string } }) =>
      where.key === "aiAgentReplySpeed:ag1" ? { key: where.key, value: { ...voiceTuningPreset("balanced"), preset: "custom", endOfSpeechSilenceMs: 1000 } } : null,
    );
    await deferredMs(processAiCallRun({ runId: "r1" }));
    db.setting.findUnique.mockImplementation(earlier as never);
    expect(db.aiAgent.findUnique).toHaveBeenCalledWith(expect.objectContaining({ where: { callFlowId: "f1" } }));
    expect(voice.placeVoiceCall.mock.calls[0]![0].voiceTuning).toMatchObject({ preset: "custom", end_of_speech_silence_ms: 1000 });
  });

  it.each([undefined, "hi", "te", "kn"])("voice response tuning: a call in %s is sent nothing new", async (language) => {
    helpers.pinnedFlowForRun.mockResolvedValue({ flowId: "f1", version: 3, language });
    logs({});
    await deferredMs(processAiCallRun({ runId: "r1" }));
    expect(voice.placeVoiceCall.mock.calls[0]![0]).not.toHaveProperty("voiceTuning");
  });

  it("no providerCallId: only voiceCallId stored", async () => {
    voice.placeVoiceCall.mockResolvedValueOnce({ callId: "v1" });
    await deferredMs(processAiCallRun({ runId: "r1" }));
    expect(db.aiCallLog.update).toHaveBeenLastCalledWith({ where: { id: "l2" }, data: { voiceCallId: "v1" } });
  });

  it("call fails to start: log FAILED with the message, customer synced, run continues (defer 5s)", async () => {
    voice.placeVoiceCall.mockRejectedValueOnce(new Error("backend down"));
    const wait = await deferredMs(processAiCallRun({ runId: "r1" }));
    expect(wait).toBeGreaterThanOrEqual(5000);
    expect(db.aiCallLog.update).toHaveBeenLastCalledWith({
      where: { id: "l2" },
      data: { status: "FAILED", endedAt: expect.any(Date), error: "backend down" },
    });
    expect(helpers.syncCustomerFromLog).toHaveBeenCalledWith("l2");
  });

  it("call in flight: polls the voice backend, applies the update, defers 5s", async () => {
    const inFlight = { id: "l1", phone: "919800000000", voiceCallId: "v0", status: "IN_PROGRESS", startedAt: new Date() };
    logs({ inFlight });
    db.aiCallLog.findUnique.mockResolvedValue(inFlight);
    voice.getVoiceCall.mockResolvedValue({
      status: "in_progress",
      provider_call_id: "p0",
      outcome: null,
      summary: null,
      transcripts: null,
      duration_seconds: null,
      ended_at: null,
      hangup_cause: null,
    });
    const wait = await deferredMs(processAiCallRun({ runId: "r1" }));
    expect(wait).toBeGreaterThanOrEqual(5000);
    expect(helpers.applyVoiceUpdate).toHaveBeenCalledWith("l1", expect.objectContaining({ status: "in_progress", providerCallId: "p0" }));
    expect(voice.placeVoiceCall).not.toHaveBeenCalled();
  });

  it("a Tamil run (its pinned flow is Tamil) dials through the Tamil voice backend", async () => {
    helpers.pinnedFlowForRun.mockResolvedValue({ flowId: "f1", version: 3, language: "ta" });
    db.setting.findUnique.mockResolvedValue(null); // nothing switched off
    await deferredMs(processAiCallRun({ runId: "r1" }));
    expect(voice.placeVoiceCall).toHaveBeenCalledWith(expect.objectContaining({ logId: "l2", language: "ta" }));
  });

  it("a language switched off in Settings: the queued calls are cancelled, nothing is dialled", async () => {
    helpers.pinnedFlowForRun.mockResolvedValue({ flowId: "f1", version: 3, language: "ta" });
    db.setting.findUnique.mockResolvedValue({ key: "aiCallLanguagesDisabled", value: ["ta"] });
    db.aiCallLog.findMany.mockResolvedValue([{ id: "l2" }, { id: "l3" }]);
    db.aiCallLog.updateMany.mockResolvedValue({ count: 2 });
    await expect(processAiCallRun({ runId: "r1" })).resolves.toEqual({ stopped: "language_disabled", cancelled: 2 });
    expect(db.aiCallRun.update).toHaveBeenCalledWith({ where: { id: "r1" }, data: { status: "CANCELLED", nextCallAt: null } });
    expect(db.aiCallLog.updateMany).toHaveBeenCalledWith({
      where: { runId: "r1", status: "QUEUED" },
      data: { status: "CANCELLED", error: "Not called — Tamil AI calls were switched off in Settings" },
    });
    expect(helpers.syncCustomerFromLog).toHaveBeenCalledWith("l3");
    expect(voice.placeVoiceCall).not.toHaveBeenCalled();
  });

  describe("a completed call whose result hasn't arrived (the hangup came before the outcome; a callback missed or refused)", () => {
    const ended = { id: "l1", phone: "919800000000", voiceCallId: "v0", status: "COMPLETED", outcome: null, endedAt: new Date(Date.now() - 5000) };
    const voiceCall = (outcome: string | null) => ({
      status: "completed",
      provider_call_id: "p0",
      outcome,
      summary: outcome ? "The customer hung up before the AI spoke." : null,
      transcripts: [],
      duration_seconds: 16,
      ended_at: "2026-11-19T09:15:00",
      hangup_cause: "Normal Hangup",
    });

    it("asks the voice backend again and holds the run (nothing dialled, not finished) while the result is missing", async () => {
      logs({ settling: ended, queued: null });
      db.aiCallLog.findUnique.mockResolvedValue({ outcome: null });
      voice.getVoiceCall.mockResolvedValue(voiceCall(null));
      const wait = await deferredMs(processAiCallRun({ runId: "r1" }));
      expect(wait).toBeGreaterThanOrEqual(5000);
      expect(voice.getVoiceCall).toHaveBeenCalledWith("v0", "en");
      expect(helpers.applyVoiceUpdate).toHaveBeenCalledWith("l1", expect.objectContaining({ status: "completed", durationSec: 16 }));
      expect(voice.placeVoiceCall).not.toHaveBeenCalled();
      expect(db.aiCallRun.update).not.toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: "DONE" }) }));
      // Only calls that ended within the settle window are asked again.
      const where = db.aiCallLog.findFirst.mock.calls.map((c) => c[0].where).find((w) => w.outcome === null)!;
      expect(where).toMatchObject({ runId: "r1", status: "COMPLETED", outcome: null, voiceCallId: { not: null } });
      expect(Date.now() - where.endedAt.gte.getTime()).toBeGreaterThanOrEqual(60_000 - 50);
      expect(Date.now() - where.endedAt.gte.getTime()).toBeLessThan(61_000);
    });

    it("the run's last call: once its result arrives (hung up early), the run finishes", async () => {
      logs({ settling: ended, queued: null });
      db.aiCallLog.findUnique.mockResolvedValue({ outcome: "hung_up_early" });
      voice.getVoiceCall.mockResolvedValue(voiceCall("hung_up_early"));
      await expect(processAiCallRun({ runId: "r1" })).resolves.toEqual({ done: true, COMPLETED: 2, FAILED: 1 });
      expect(helpers.applyVoiceUpdate).toHaveBeenCalledWith("l1", expect.objectContaining({ outcome: "hung_up_early" }));
    });

    it("a stopped run still collects its last call's result before it stops", async () => {
      db.aiCallRun.findUnique.mockResolvedValueOnce({ ...run, status: "CANCELLED" });
      logs({ settling: ended });
      db.aiCallLog.findUnique.mockResolvedValue({ outcome: null });
      voice.getVoiceCall.mockResolvedValue(voiceCall(null));
      await deferredMs(processAiCallRun({ runId: "r1" }));
      expect(voice.getVoiceCall).toHaveBeenCalledTimes(1);
      expect(voice.placeVoiceCall).not.toHaveBeenCalled();
    });
  });

  it("in-flight call past callTimeoutSec: FAILED with the timeout message, then the next call is dialled", async () => {
    const startedAt = new Date(Date.now() - (aiCallsConfig.callTimeoutSec + 5) * 1000);
    const inFlight = { id: "l1", phone: "919800000000", voiceCallId: null, status: "DIALING", startedAt };
    logs({ inFlight });
    db.aiCallLog.findUnique.mockResolvedValue(inFlight);
    await deferredMs(processAiCallRun({ runId: "r1" }));
    expect(db.aiCallLog.update).toHaveBeenCalledWith({
      where: { id: "l1" },
      data: { status: "FAILED", endedAt: expect.any(Date), error: `No final status from the voice backend within ${aiCallsConfig.callTimeoutSec}s` },
    });
    expect(helpers.syncCustomerFromLog).toHaveBeenCalledWith("l1");
    expect(voice.placeVoiceCall).toHaveBeenCalledTimes(1);
  });
});
