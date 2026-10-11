import { describe, expect, it } from "vitest";
import { createContactInput, updateContactInput } from "@dispatch/shared";

describe("contact phone validation", () => {
  it("accepts a 10-digit phone and stores it as digits only", () => {
    const parsed = createContactInput.parse({
      email: "ada@example.com",
      phone: "(555) 123-4567",
    });
    expect(parsed.phone).toBe("5551234567");
  });

  it("rejects a phone that is not exactly 10 digits", () => {
    const res = createContactInput.safeParse({ email: "ada@example.com", phone: "12345" });
    expect(res.success).toBe(false);
    if (!res.success) {
      expect(res.error.flatten().fieldErrors.phone?.[0]).toMatch(/10 digits/i);
    }
  });

  it("Indian numbers are stored as 10 digits in any input form; other countries keep +code", () => {
    const p = (phone: string) => createContactInput.parse({ email: "ada@example.com", phone }).phone;
    expect(p("+91 98765 43210")).toBe("9876543210");
    expect(p("919876543210")).toBe("9876543210");
    expect(p("09876543210")).toBe("9876543210");
    expect(p("+1 (415) 555-2671")).toBe("+14155552671");
    expect(p("+971 50 123 4567")).toBe("+971501234567");
    expect(createContactInput.safeParse({ email: "ada@example.com", phone: "+12" }).success).toBe(false);
  });

  it("still allows omitting the phone entirely", () => {
    const parsed = createContactInput.parse({ email: "ada@example.com" });
    expect(parsed.phone).toBeUndefined();
  });

  it("lets the editor clear the phone with null", () => {
    const parsed = updateContactInput.parse({ phone: null });
    expect(parsed.phone).toBeNull();
  });
});
