import { describe, expect, it } from "vitest";
import {
  createWhatsAppContactInput,
  createWhatsAppTemplateInput,
  sendWhatsAppBulkInput,
} from "@dispatch/shared";

describe("createWhatsAppContactInput", () => {
  it("normalises phone to digits and accepts optional names", () => {
    const out = createWhatsAppContactInput.parse({ phone: "+91 98765 43210", firstName: "Ada" });
    expect(out).toEqual({ phone: "919876543210", firstName: "Ada" });
  });

  it("rejects a too-short phone", () => {
    expect(createWhatsAppContactInput.safeParse({ phone: "12345" }).success).toBe(false);
  });

  it("rejects a non-Indian phone", () => {
    expect(createWhatsAppContactInput.safeParse({ phone: "+1 (415) 555-2671" }).success).toBe(false);
  });

  it("rejects an Indian number not starting with 6-9", () => {
    expect(createWhatsAppContactInput.safeParse({ phone: "+91 51234 56789" }).success).toBe(false);
  });
});

describe("createWhatsAppTemplateInput", () => {
  it("accepts a valid Twilio Content SID", () => {
    const res = createWhatsAppTemplateInput.safeParse({
      name: "Lead qualify",
      contentSid: "HX" + "a".repeat(32),
      body: "Hi {{first_name}}",
      variables: ["first_name"],
      buttonLabels: ["Interested", "Not Interested"],
    });
    expect(res.success).toBe(true);
  });

  it("rejects a malformed Content SID", () => {
    const res = createWhatsAppTemplateInput.safeParse({
      name: "x",
      contentSid: "not-a-sid",
      body: "hi",
    });
    expect(res.success).toBe(false);
  });

  it("rejects more than 3 button labels", () => {
    const res = createWhatsAppTemplateInput.safeParse({
      name: "x",
      contentSid: "HX" + "0".repeat(32),
      body: "hi",
      buttonLabels: ["a", "b", "c", "d"],
    });
    expect(res.success).toBe(false);
  });
});

describe("sendWhatsAppBulkInput", () => {
  it("requires a source and caps recipients at 500", () => {
    expect(
      sendWhatsAppBulkInput.safeParse({ templateId: "t", contactIds: ["a"], source: "whatsapp" })
        .success,
    ).toBe(true);
    expect(
      sendWhatsAppBulkInput.safeParse({
        templateId: "t",
        contactIds: Array.from({ length: 501 }, (_, i) => String(i)),
        source: "contacts",
      }).success,
    ).toBe(false);
    expect(
      sendWhatsAppBulkInput.safeParse({ templateId: "t", contactIds: ["a"], source: "sms" }).success,
    ).toBe(false);
  });
});
