import { describe, expect, it } from "vitest";
import {
  BRANDING_DEFAULTS,
  brandingInput,
  brandingResetQuery,
  resolveBranding,
  sanitizeBrandingValue,
} from "@dispatch/shared";

// Settings → Branding: the shared rules for the app name.

describe("branding defaults", () => {
  it("default app name is today's hardcoded text", () => {
    expect(BRANDING_DEFAULTS).toEqual({ appName: "Dispatch" });
  });

  it("nothing saved, or garbage saved, resolves to the default", () => {
    expect(resolveBranding(undefined)).toEqual(BRANDING_DEFAULTS);
    expect(resolveBranding(null)).toEqual(BRANDING_DEFAULTS);
    expect(resolveBranding("Acme")).toEqual(BRANDING_DEFAULTS);
    expect(resolveBranding({ appName: "<b>x</b>" })).toEqual(BRANDING_DEFAULTS);
    expect(resolveBranding({ appName: 42, bogus: "Hi" })).toEqual(BRANDING_DEFAULTS);
  });

  it("a valid saved name is used", () => {
    expect(resolveBranding({ appName: "Acme CRM" })).toEqual({ appName: "Acme CRM" });
  });
});

describe("branding validation", () => {
  const parse = (labels: Record<string, unknown>) => brandingInput.safeParse({ labels });

  it("accepts letters (any language), numbers, spaces and basic punctuation; trims", () => {
    const r = parse({ appName: "  Acme & Co. (India)!  " });
    expect(r.success && r.data.labels.appName).toBe("Acme & Co. (India)!");
    expect(parse({ appName: "கக்சோ 2" }).success).toBe(true);
    expect(parse({ appName: "Queue-2_b, ok?" }).success).toBe(true);
  });

  it("rejects HTML and script characters", () => {
    for (const v of ["<b>Acme</b>", "<script>alert(1)</script>", "a\"b", "x/y", "{x}", "a;b", "`x`", "a\\b"]) {
      expect(parse({ appName: v }).success, v).toBe(false);
    }
  });

  it("rejects empty and over-length names (max 24)", () => {
    expect(parse({ appName: "   " }).success).toBe(false);
    expect(parse({ appName: "a".repeat(24) }).success).toBe(true);
    expect(parse({ appName: "a".repeat(25) }).success).toBe(false);
  });

  it("rejects unknown keys, non-string values and an empty save", () => {
    expect(parse({ appName: "Acme", "nav.contacts": "X" }).success).toBe(false);
    expect(parse({ emailFrom: "X" }).success).toBe(false);
    expect(parse({ appName: 5 }).success).toBe(false);
    expect(parse({}).success).toBe(false);
    expect(brandingInput.safeParse({}).success).toBe(false);
  });

  it("reset accepts the known key or none", () => {
    expect(brandingResetQuery.parse({})).toEqual({});
    expect(brandingResetQuery.parse({ key: "appName" })).toEqual({ key: "appName" });
    expect(brandingResetQuery.safeParse({ key: "nope" }).success).toBe(false);
  });

  it("the form strips tags and disallowed characters as you type", () => {
    expect(sanitizeBrandingValue("<b>Acme</b>")).toBe("Acme");
    expect(sanitizeBrandingValue("<script>alert(1)</script>Hi")).toBe("alert(1)Hi");
    expect(sanitizeBrandingValue("A  \"B\"; {C}")).toBe("A B C");
  });
});
