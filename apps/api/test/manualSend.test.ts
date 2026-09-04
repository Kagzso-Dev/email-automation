import { describe, expect, it } from "vitest";
import { bulkSendSettingsInput } from "@dispatch/shared";
import { pickDelayMs } from "../src/domain/manualSend.js";
import { clampDelayRange, getBulkSendDelays } from "../src/domain/settings.js";

describe("pickDelayMs", () => {
  it("returns a value inside [min, max] seconds (in ms)", () => {
    for (const r of [0, 0.001, 0.25, 0.5, 0.75, 0.999, 1]) {
      const ms = pickDelayMs(5, 15, () => r);
      expect(ms).toBeGreaterThanOrEqual(5000);
      expect(ms).toBeLessThanOrEqual(15000);
    }
  });

  it("returns exactly min*1000 when min === max", () => {
    expect(pickDelayMs(8, 8, () => 0.42)).toBe(8000);
  });

  it("scales linearly with the rng draw", () => {
    expect(pickDelayMs(0, 10, () => 0)).toBe(0);
    expect(pickDelayMs(0, 10, () => 0.5)).toBe(5000);
    expect(pickDelayMs(0, 10, () => 1)).toBe(10000);
  });

  it("tolerates a swapped range without going negative", () => {
    const ms = pickDelayMs(20, 5, () => 0.5);
    expect(ms).toBeGreaterThanOrEqual(0);
  });
});

describe("clampDelayRange", () => {
  it("floors at 1 second", () => {
    expect(clampDelayRange(0, 0)).toEqual({ minDelaySec: 1, maxDelaySec: 1 });
  });

  it("caps at 3600 seconds", () => {
    expect(clampDelayRange(10, 99999)).toEqual({ minDelaySec: 10, maxDelaySec: 3600 });
  });

  it("swaps so min <= max", () => {
    expect(clampDelayRange(30, 5)).toEqual({ minDelaySec: 5, maxDelaySec: 30 });
  });

  it("rounds fractional input", () => {
    expect(clampDelayRange(2.4, 7.6)).toEqual({ minDelaySec: 2, maxDelaySec: 8 });
  });
});

describe("bulkSendSettingsInput", () => {
  it("accepts a normal range", () => {
    expect(bulkSendSettingsInput.parse({ minDelaySec: 5, maxDelaySec: 15 })).toEqual({
      minDelaySec: 5,
      maxDelaySec: 15,
    });
  });

  it("accepts min === max", () => {
    expect(bulkSendSettingsInput.safeParse({ minDelaySec: 10, maxDelaySec: 10 }).success).toBe(true);
  });

  it("rejects min > max", () => {
    const res = bulkSendSettingsInput.safeParse({ minDelaySec: 20, maxDelaySec: 5 });
    expect(res.success).toBe(false);
    if (!res.success) expect(res.error.flatten().fieldErrors.maxDelaySec).toBeTruthy();
  });

  it("rejects zero / negative", () => {
    expect(bulkSendSettingsInput.safeParse({ minDelaySec: 0, maxDelaySec: 15 }).success).toBe(false);
    expect(bulkSendSettingsInput.safeParse({ minDelaySec: -1, maxDelaySec: 15 }).success).toBe(false);
  });

  it("rejects non-integers and out-of-range", () => {
    expect(bulkSendSettingsInput.safeParse({ minDelaySec: 1.5, maxDelaySec: 15 }).success).toBe(false);
    expect(bulkSendSettingsInput.safeParse({ minDelaySec: 5, maxDelaySec: 3601 }).success).toBe(false);
  });
});

describe("getBulkSendDelays", () => {
  it("is exported for the settings route and orchestrator", () => {
    expect(typeof getBulkSendDelays).toBe("function");
  });
});
