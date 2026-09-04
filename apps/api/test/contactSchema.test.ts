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

  it("still allows omitting the phone entirely", () => {
    const parsed = createContactInput.parse({ email: "ada@example.com" });
    expect(parsed.phone).toBeUndefined();
  });

  it("lets the editor clear the phone with null", () => {
    const parsed = updateContactInput.parse({ phone: null });
    expect(parsed.phone).toBeNull();
  });
});
