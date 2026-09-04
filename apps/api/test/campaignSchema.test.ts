import { describe, expect, it } from "vitest";
import { createCampaignInput } from "@dispatch/shared";

const future = () => new Date(Date.now() + 60 * 60 * 1000).toISOString();

describe("createCampaignInput", () => {
  it("accepts a one-time campaign with cronExpression sent as null", () => {
    const parsed = createCampaignInput.parse({
      name: "Welcome",
      templateId: "t1",
      listId: "l1",
      scheduleType: "ONCE",
      sendAt: future(),
      cronExpression: null,
    });
    expect(parsed.scheduleType).toBe("ONCE");
    expect(parsed.cronExpression).toBeNull();
  });

  it("accepts a recurring campaign with sendAt sent as null", () => {
    const parsed = createCampaignInput.parse({
      name: "Weekly digest",
      templateId: "t1",
      listId: "l1",
      scheduleType: "RECURRING",
      cronExpression: "0 9 * * 1",
      sendAt: null,
    });
    expect(parsed.scheduleType).toBe("RECURRING");
    expect(parsed.sendAt).toBeNull();
  });

  it("rejects a one-time campaign whose send time is in the past", () => {
    const res = createCampaignInput.safeParse({
      name: "Late",
      templateId: "t1",
      listId: "l1",
      scheduleType: "ONCE",
      sendAt: new Date(Date.now() - 1000).toISOString(),
      cronExpression: null,
    });
    expect(res.success).toBe(false);
    if (!res.success) {
      expect(res.error.flatten().fieldErrors.sendAt?.[0]).toMatch(/future/i);
    }
  });

  it("rejects a recurring campaign with no cron expression", () => {
    const res = createCampaignInput.safeParse({
      name: "No schedule",
      templateId: "t1",
      listId: "l1",
      scheduleType: "RECURRING",
      cronExpression: null,
      sendAt: null,
    });
    expect(res.success).toBe(false);
    if (!res.success) {
      expect(res.error.flatten().fieldErrors.cronExpression).toBeTruthy();
    }
  });
});
