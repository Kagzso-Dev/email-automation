import { describe, expect, it } from "vitest";
import {
  createWhatsAppContactInput,
  createWhatsAppTemplateInput,
  sendWhatsAppBulkInput,
  updateWhatsAppTemplateInput,
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
  it("accepts a Meta template name and defaults the language to en", () => {
    const res = createWhatsAppTemplateInput.safeParse({
      name: "Lead qualify",
      providerTemplateName: "kagzso_greeting_new_contact",
      body: "Hi {{first_name}}",
      variables: ["first_name"],
      buttonLabels: ["Interested", "Not Interested"],
    });
    expect(res.success).toBe(true);
    expect(res.success && res.data.languageCode).toBe("en");
  });

  it("accepts a region-qualified language code", () => {
    const res = createWhatsAppTemplateInput.safeParse({
      name: "x",
      providerTemplateName: "hello_world",
      languageCode: "en_US",
      body: "hi",
    });
    expect(res.success).toBe(true);
  });

  it("rejects a template name Meta wouldn't allow (uppercase, spaces)", () => {
    const res = createWhatsAppTemplateInput.safeParse({
      name: "x",
      providerTemplateName: "Hello World",
      body: "hi",
    });
    expect(res.success).toBe(false);
  });

  it("rejects a malformed language code", () => {
    const res = createWhatsAppTemplateInput.safeParse({
      name: "x",
      providerTemplateName: "hello_world",
      languageCode: "English",
      body: "hi",
    });
    expect(res.success).toBe(false);
  });

  it("rejects more than 3 button labels", () => {
    const res = createWhatsAppTemplateInput.safeParse({
      name: "x",
      providerTemplateName: "hello_world",
      body: "hi",
      buttonLabels: ["a", "b", "c", "d"],
    });
    expect(res.success).toBe(false);
  });
});

describe("updateWhatsAppTemplateInput", () => {
  it("does not inject a default language on a partial update", () => {
    const res = updateWhatsAppTemplateInput.parse({ name: "renamed" });
    expect(res.languageCode).toBeUndefined();
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
