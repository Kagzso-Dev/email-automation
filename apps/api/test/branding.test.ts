import { describe, expect, it } from "vitest";
import {
  BRANDING_DEFAULTS,
  BRANDING_KEYS,
  brandingInput,
  brandingResetQuery,
  resolveBranding,
  sanitizeBrandingValue,
} from "@dispatch/shared";
import { brandNavGroups, NAV_GROUPS } from "../../web/src/lib/nav.js";

// Settings → Branding & Labels: the shared rules and the sidebar mapping. Pure,
// so the web menu helper runs here too (the web app has no test runner).

describe("branding defaults", () => {
  it("are exactly today's hardcoded text", () => {
    expect(BRANDING_DEFAULTS.appName).toBe("Dispatch");
    const sidebar = brandNavGroups(NAV_GROUPS, { ...BRANDING_DEFAULTS });
    expect(sidebar).toEqual(NAV_GROUPS); // nothing saved → identical menu
    expect(sidebar.map((g) => g.label)).toEqual(["Main", "Email", "WhatsApp", "Calls", "System"]);
  });

  it("nothing saved, or garbage saved, resolves to the defaults", () => {
    expect(resolveBranding(undefined)).toEqual(BRANDING_DEFAULTS);
    expect(resolveBranding(null)).toEqual(BRANDING_DEFAULTS);
    expect(resolveBranding("Acme")).toEqual(BRANDING_DEFAULTS);
    expect(resolveBranding({ appName: "<b>x</b>", "nav.contacts": 42, bogus: "Hi" })).toEqual(BRANDING_DEFAULTS);
  });

  it("every nav/section key is used by exactly one place in the menu", () => {
    const used = NAV_GROUPS.flatMap((g) => [g.labelKey, ...g.items.flatMap((n) => (n.labelKey ? [n.labelKey] : []))]);
    expect(new Set(used).size).toBe(used.length);
    expect([...used, "appName"].sort()).toEqual([...BRANDING_KEYS].sort());
  });
});

describe("sidebar after a rename", () => {
  it("shows the new names; routes, icons and unrenamable items stay the same", () => {
    const labels = resolveBranding({ appName: "Acme CRM", "section.main": "Home", "nav.contacts": "People" });
    expect(labels.appName).toBe("Acme CRM");
    const before = NAV_GROUPS;
    const after = brandNavGroups(NAV_GROUPS, labels);
    expect(after[0].label).toBe("Home");
    const contacts = after[0].items.find((n) => n.to === "/contacts")!;
    expect(contacts).toMatchObject({ label: "People", icon: "contacts", to: "/contacts" });
    expect(after[0].items.find((n) => n.to === "/insights")!.label).toBe("Insights");
    expect(after.flatMap((g) => g.items.map((n) => n.to))).toEqual(before.flatMap((g) => g.items.map((n) => n.to)));
  });
});

describe("branding validation", () => {
  const parse = (labels: Record<string, unknown>) => brandingInput.safeParse({ labels });

  it("accepts letters (any language), numbers, spaces and basic punctuation; trims", () => {
    const r = parse({ appName: "  Acme & Co. (India)!  ", "nav.contacts": "வாடிக்கையாளர்கள்", "nav.sendQueue": "Queue-2_b, ok?" });
    expect(r.success).toBe(true);
    expect(r.success && r.data.labels.appName).toBe("Acme & Co. (India)!");
  });

  it("rejects HTML and script characters", () => {
    for (const v of ["<b>Acme</b>", "<script>alert(1)</script>", "a\"b", "x/y", "{x}", "a;b", "`x`", "a\\b"]) {
      expect(parse({ appName: v }).success, v).toBe(false);
    }
  });

  it("rejects empty and over-length values (app name 24, labels 30)", () => {
    expect(parse({ appName: "   " }).success).toBe(false);
    expect(parse({ appName: "a".repeat(24) }).success).toBe(true);
    expect(parse({ appName: "a".repeat(25) }).success).toBe(false);
    expect(parse({ "nav.dashboard": "a".repeat(30) }).success).toBe(true);
    expect(parse({ "nav.dashboard": "a".repeat(31) }).success).toBe(false);
  });

  it("rejects unknown keys, non-string values and an empty save", () => {
    expect(parse({ "nav.insights": "X" }).success).toBe(false);
    expect(parse({ emailFrom: "X" }).success).toBe(false);
    expect(parse({ appName: 5 }).success).toBe(false);
    expect(parse({}).success).toBe(false);
    expect(brandingInput.safeParse({}).success).toBe(false);
  });

  it("reset accepts one known key or none", () => {
    expect(brandingResetQuery.parse({})).toEqual({});
    expect(brandingResetQuery.parse({ key: "nav.contacts" })).toEqual({ key: "nav.contacts" });
    expect(brandingResetQuery.safeParse({ key: "nope" }).success).toBe(false);
  });

  it("the form strips tags and disallowed characters as you type", () => {
    expect(sanitizeBrandingValue("<b>Acme</b>")).toBe("Acme");
    expect(sanitizeBrandingValue("<script>alert(1)</script>Hi")).toBe("alert(1)Hi");
    expect(sanitizeBrandingValue("A  \"B\"; {C}")).toBe("A B C");
  });
});
