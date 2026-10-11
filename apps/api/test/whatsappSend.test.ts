import { describe, expect, it } from "vitest";
import {
  buildContentVariables,
  missingTemplateVariables,
  buildWhatsAppVars,
  pickDelayMs,
  renderWhatsAppBody,
} from "../src/domain/whatsappSend.js";

describe("buildWhatsAppVars", () => {
  it("flattens a recipient into template variables", () => {
    expect(
      buildWhatsAppVars({ firstName: "Ada", lastName: "Lovelace", businessName: "Acme", phone: "1555" }),
    ).toEqual({
      first_name: "Ada",
      last_name: "Lovelace",
      full_name: "Ada Lovelace",
      business_name: "Acme",
      phone: "1555",
    });
  });

  it("blanks missing fields (first name falls back to \"there\")", () => {
    expect(buildWhatsAppVars({})).toEqual({
      first_name: "there",
      last_name: "",
      full_name: "",
      business_name: "",
      phone: "",
    });
  });
});

describe('first_name fallback ("there")', () => {
  it.each([
    ["empty", ""],
    ["whitespace only", "   "],
    ["tabs / newlines", "\t\n "],
    ["null", null],
    ["undefined", undefined],
  ])("%s first name → there", (_label, firstName) => {
    const vars = buildWhatsAppVars({ firstName, businessName: "Acme" });
    expect(vars.first_name).toBe("there");
    expect(renderWhatsAppBody("Hi {{first_name}},", vars)).toBe("Hi there,");
    expect(buildContentVariables({ variables: ["first_name"] }, vars)).toEqual({ "1": "there" });
    // No longer a reason to skip the recipient.
    expect(missingTemplateVariables({ variables: ["first_name"] }, vars)).toEqual([]);
  });

  it("keeps a real first name as is", () => {
    expect(buildWhatsAppVars({ firstName: "Ada" }).first_name).toBe("Ada");
  });

  it("an empty business_name still skips the recipient", () => {
    for (const businessName of ["", "   ", null]) {
      const vars = buildWhatsAppVars({ firstName: "", businessName });
      expect(missingTemplateVariables({ variables: ["first_name", "business_name"] }, vars)).toEqual(["business_name"]);
    }
  });
});

describe("renderWhatsAppBody", () => {
  it("substitutes declared vars and blanks unknown ones", () => {
    const vars = buildWhatsAppVars({ firstName: "Ada", businessName: "Acme" });
    expect(renderWhatsAppBody("Hi {{first_name}} from {{business_name}} — {{mystery}}", vars)).toBe(
      "Hi Ada from Acme — ",
    );
  });
});

describe("buildContentVariables", () => {
  it("maps declared names to positional template params, in order", () => {
    const vars = buildWhatsAppVars({ firstName: "Ada", businessName: "Acme" });
    expect(buildContentVariables({ variables: ["first_name", "business_name"] }, vars)).toEqual({
      "1": "Ada",
      "2": "Acme",
    });
  });

  it("emits empty strings for declared vars with no value", () => {
    expect(buildContentVariables({ variables: ["first_name", "city"] }, { first_name: "Ada" })).toEqual(
      { "1": "Ada", "2": "" },
    );
  });
});

describe("pickDelayMs", () => {
  it("stays within [min, max] seconds", () => {
    for (const r of [0, 0.25, 0.5, 0.75, 1]) {
      const ms = pickDelayMs(8, 25, () => r);
      expect(ms).toBeGreaterThanOrEqual(8000);
      expect(ms).toBeLessThanOrEqual(25000);
    }
  });
});

describe("missingTemplateVariables", () => {
  it("lists declared variables that are empty or blank for the recipient", () => {
    expect(
      missingTemplateVariables({ variables: ["first_name", "business_name", "city"] }, { first_name: "Ada", business_name: "  " }),
    ).toEqual(["business_name", "city"]);
  });

  it("is empty when every declared variable has a value", () => {
    expect(missingTemplateVariables({ variables: ["first_name"] }, { first_name: "Ada" })).toEqual([]);
    expect(missingTemplateVariables({ variables: [] }, {})).toEqual([]);
  });
});
