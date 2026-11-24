import { describe, expect, it } from "vitest";
import { decideSend, HUMAN_AGENT_WINDOW_MS, STANDARD_WINDOW_MS, windowState } from "../src/domain/automation/dmWindow.js";
import { signConfirm, verifyConfirm } from "../src/domain/automation/sendLog.js";

// Instagram's messaging window (Automation): free-form under 24 h; 24 h – 7 days only with the HUMAN_AGENT tag
// (approved, one recipient, chosen by the sender); 7 days or more, or no message from them: never.

const now = new Date("2026-11-23T12:00:00Z");
const ago = (ms: number) => new Date(now.getTime() - ms);
const base = { now, humanAgentEnabled: false, useHumanAgentTag: false, recipientCount: 1 };

describe("windowState", () => {
  it("open just inside 24 h, human_agent at exactly 24 h, closed at exactly 7 days", () => {
    expect(windowState(ago(STANDARD_WINDOW_MS - 1), now).state).toBe("open");
    expect(windowState(ago(STANDARD_WINDOW_MS), now).state).toBe("human_agent");
    expect(windowState(ago(HUMAN_AGENT_WINDOW_MS - 1), now).state).toBe("human_agent");
    expect(windowState(ago(HUMAN_AGENT_WINDOW_MS), now).state).toBe("closed");
  });
  it("no message from them (or a bad date) is no_inbound", () => {
    expect(windowState(null, now).state).toBe("no_inbound");
    expect(windowState(new Date("nope"), now).state).toBe("no_inbound");
  });
  it("says when the open window ends", () => {
    const last = ago(60 * 60_000);
    expect(windowState(last, now).endsAt?.toISOString()).toBe(new Date(last.getTime() + STANDARD_WINDOW_MS).toISOString());
  });
});

describe("decideSend", () => {
  it("inside 24 h: allowed, no tag (also in bulk)", () => {
    expect(decideSend({ ...base, lastInboundAt: ago(1000), recipientCount: 50 })).toEqual({ allowed: true, tag: null, state: "open", reason: null });
  });
  it("outside 24 h with the human agent feature off: blocked", () => {
    expect(decideSend({ ...base, lastInboundAt: ago(STANDARD_WINDOW_MS + 1), useHumanAgentTag: true })).toMatchObject({ allowed: false, reason: "human_agent_disabled" });
  });
  it("outside 24 h, feature on, but more than one recipient: blocked", () => {
    expect(
      decideSend({ ...base, lastInboundAt: ago(2 * STANDARD_WINDOW_MS), humanAgentEnabled: true, useHumanAgentTag: true, recipientCount: 2 }),
    ).toMatchObject({ allowed: false, reason: "human_agent_bulk" });
  });
  it("outside 24 h, feature on, one recipient, tag not chosen: blocked", () => {
    expect(decideSend({ ...base, lastInboundAt: ago(2 * STANDARD_WINDOW_MS), humanAgentEnabled: true })).toMatchObject({ allowed: false, reason: "human_agent_not_chosen" });
  });
  it("outside 24 h, feature on, one recipient, tag chosen: allowed with HUMAN_AGENT", () => {
    expect(
      decideSend({ ...base, lastInboundAt: ago(2 * STANDARD_WINDOW_MS), humanAgentEnabled: true, useHumanAgentTag: true }),
    ).toEqual({ allowed: true, tag: "HUMAN_AGENT", state: "human_agent", reason: null });
  });
  it("7 days or more: blocked even with everything on", () => {
    expect(
      decideSend({ ...base, lastInboundAt: ago(HUMAN_AGENT_WINDOW_MS), humanAgentEnabled: true, useHumanAgentTag: true }),
    ).toMatchObject({ allowed: false, reason: "closed" });
  });
  it("never messaged: blocked", () => {
    expect(decideSend({ ...base, lastInboundAt: null, humanAgentEnabled: true, useHumanAgentTag: true })).toMatchObject({ allowed: false, reason: "no_inbound" });
  });
});

describe("confirm token", () => {
  const p = { userId: "u1", recipientIds: ["2", "1"], message: "Hi", useHumanAgentTag: false, count: 2 };
  it("matches the same send (recipient order doesn't matter)", () => {
    expect(verifyConfirm(signConfirm(p), { ...p, recipientIds: ["1", "2"] })).toBe(true);
  });
  it("refuses another user, message, recipient list, tag choice or count", () => {
    const t = signConfirm(p);
    expect(verifyConfirm(t, { ...p, userId: "u2" })).toBe(false);
    expect(verifyConfirm(t, { ...p, message: "Hi!" })).toBe(false);
    expect(verifyConfirm(t, { ...p, recipientIds: ["1", "2", "3"] })).toBe(false);
    expect(verifyConfirm(t, { ...p, useHumanAgentTag: true })).toBe(false);
    expect(verifyConfirm(t, { ...p, count: 3 })).toBe(false);
    expect(verifyConfirm("123.abc", p)).toBe(false);
  });
  it("expires after 10 minutes", () => {
    const t = signConfirm(p, 0);
    expect(verifyConfirm(t, p, 10 * 60_000 - 1)).toBe(true);
    expect(verifyConfirm(t, p, 10 * 60_000 + 1)).toBe(false);
  });
});
