import { describe, expect, it } from "vitest";
import { normalizeWhatsAppPhone, phoneDigitsValid } from "../src/domain/whatsappPhone.js";

describe("phoneDigitsValid", () => {
  it("Indian numbers: 91 + a 10-digit mobile starting with 6-9; other countries: valid international length", () => {
    expect(phoneDigitsValid("919876543210")).toBe(true);
    expect(phoneDigitsValid("916123456789")).toBe(true);
    expect(phoneDigitsValid("915123456789")).toBe(false); // leading digit not 6-9
    expect(phoneDigitsValid("9198765432")).toBe(false); // too short
    expect(phoneDigitsValid("9198765432100")).toBe(false); // too long
    expect(phoneDigitsValid("14155552671")).toBe(true); // US number (other countries allowed)
    expect(phoneDigitsValid("971501234567")).toBe(true); // UAE
    expect(phoneDigitsValid("1234")).toBe(false); // too short for any country
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

  it("keeps other countries' codes; rejects non-mobile Indian numbers", () => {
    expect(normalizeWhatsAppPhone("+1 (415) 555-2671")).toBe("14155552671");
    expect(normalizeWhatsAppPhone("(415) 555-2671", "1")).toBe("14155552671");
    expect(normalizeWhatsAppPhone("+971 50 123 4567")).toBe("971501234567");
    expect(normalizeWhatsAppPhone("00971501234567")).toBe("971501234567");
    expect(normalizeWhatsAppPhone("915123456789")).toBe(null); // Indian, leading digit not 6-9
  });

  it("no country code = +91, also when the default-code setting is missing or not a real code", () => {
    expect(normalizeWhatsAppPhone("9876543210")).toBe("919876543210");
    expect(normalizeWhatsAppPhone("09876543210")).toBe("919876543210");
    expect(normalizeWhatsAppPhone("9876543210", "+919092490661")).toBe("919876543210"); // a phone number in the setting
  });

  it("returns null for implausible numbers", () => {
    expect(normalizeWhatsAppPhone("")).toBe(null);
    expect(normalizeWhatsAppPhone("12")).toBe(null);
    expect(normalizeWhatsAppPhone("abc")).toBe(null);
  });
});
