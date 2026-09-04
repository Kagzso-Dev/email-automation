import { describe, expect, it } from "vitest";
import { normalizeWhatsAppPhone, phoneDigitsValid } from "../src/domain/whatsappPhone.js";

describe("phoneDigitsValid", () => {
  it("accepts 8–15 digit strings", () => {
    expect(phoneDigitsValid("15551234567")).toBe(true);
    expect(phoneDigitsValid("12345678")).toBe(true);
    expect(phoneDigitsValid("1234567")).toBe(false);
    expect(phoneDigitsValid("1234567890123456")).toBe(false);
    expect(phoneDigitsValid("155a1234567")).toBe(false);
  });
});

describe("normalizeWhatsAppPhone", () => {
  it("strips punctuation and keeps an explicit country code", () => {
    expect(normalizeWhatsAppPhone("+91 98765 43210")).toBe("919876543210");
    expect(normalizeWhatsAppPhone("+1 (415) 555-2671")).toBe("14155552671");
  });

  it("prepends the default country code to a bare 10-digit local number", () => {
    expect(normalizeWhatsAppPhone("(415) 555-2671", "1")).toBe("14155552671");
    expect(normalizeWhatsAppPhone("9876543210", "91")).toBe("919876543210");
  });

  it("does not prepend the default code when the input already had a +", () => {
    expect(normalizeWhatsAppPhone("+14155552671", "1")).toBe("14155552671");
  });

  it("leaves non-10-digit locals untouched by the default code", () => {
    expect(normalizeWhatsAppPhone("155552671", "1")).toBe("155552671");
  });

  it("returns null for implausible numbers", () => {
    expect(normalizeWhatsAppPhone("")).toBe(null);
    expect(normalizeWhatsAppPhone("12")).toBe(null);
    expect(normalizeWhatsAppPhone("abc")).toBe(null);
  });
});
