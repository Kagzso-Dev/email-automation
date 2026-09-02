import { describe, expect, it } from "vitest";
import { campaignKey, triggerKey } from "../src/domain/idempotency.js";

describe("idempotency keys", () => {
  it("campaign key is stable per contact per day", () => {
    const d1 = new Date("2026-09-02T06:00:00Z");
    const d2 = new Date("2026-09-02T23:30:00Z");
    const d3 = new Date("2026-09-03T00:30:00Z");
    expect(campaignKey("c1", "u1", d1)).toBe(campaignKey("c1", "u1", d2));
    expect(campaignKey("c1", "u1", d1)).not.toBe(campaignKey("c1", "u1", d3));
    expect(campaignKey("c1", "u1", d1)).not.toBe(campaignKey("c1", "u2", d1));
  });

  it("trigger key is stable for an identical payload", () => {
    const a = triggerKey("t1", "u1", { payload: { orderId: 5, x: "y" } });
    const b = triggerKey("t1", "u1", { payload: { orderId: 5, x: "y" } });
    const c = triggerKey("t1", "u1", { payload: { orderId: 6, x: "y" } });
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });

  it("explicit dedupeKey overrides the payload hash", () => {
    const a = triggerKey("t1", "u1", { dedupeKey: "evt-1", payload: { n: 1 } });
    const b = triggerKey("t1", "u1", { dedupeKey: "evt-1", payload: { n: 2 } });
    expect(a).toBe(b);
  });
});
