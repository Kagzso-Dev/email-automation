import { describe, expect, it } from "vitest";
import { normalizeWhatsAppPhone, phoneDigitsValid } from "../src/domain/whatsappPhone.js";

describe("phoneDigitsValid", () => {
  it("accepts 91 + a 10-digit number starting with 6-9", () => {
    expect(phoneDigitsValid("919876543210")).toBe(true);
    expect(phoneDigitsValid("916123456789")).toBe(true);
    expect(phoneDigitsValid("915123456789")).toBe(false); // leading digit not 6-9
    expect(phoneDigitsValid("9198765432")).toBe(false); // too short
    expect(phoneDigitsValid("9198765432100")).toBe(false); // too long
    expect(phoneDigitsValid("14155552671")).toBe(false); // non-Indian number
  });
});

describe("normalizeWhatsAppPhone", () => {
  it("strips punctuation and keeps an explicit country code", () => {
    expect(normalizeWhatsAppPhone("+91 98765 43210")).toBe("919876543210");
  });

  it("prepends the default country code to a bare 10-digit local number", () => {
    expect(normalizeWhatsAppPhone("9876543210", "91")).toBe("919876543210");
  });

  it("does not prepend the default code when the input already had a +", () => {
    expect(normalizeWhatsAppPhone("+919876543210", "91")).toBe("919876543210");
  });

  it("rejects non-Indian and malformed numbers", () => {
    expect(normalizeWhatsAppPhone("+1 (415) 555-2671")).toBe(null);
    expect(normalizeWhatsAppPhone("(415) 555-2671", "1")).toBe(null);
    expect(normalizeWhatsAppPhone("915123456789")).toBe(null); // leading digit not 6-9
  });

  it("returns null for implausible numbers", () => {
    expect(normalizeWhatsAppPhone("")).toBe(null);
    expect(normalizeWhatsAppPhone("12")).toBe(null);
    expect(normalizeWhatsAppPhone("abc")).toBe(null);
  });
});
