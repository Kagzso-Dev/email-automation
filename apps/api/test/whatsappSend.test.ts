import { describe, expect, it } from "vitest";
import {
  buildContentVariables,
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

  it("blanks missing fields", () => {
    expect(buildWhatsAppVars({})).toEqual({
      first_name: "",
      last_name: "",
      full_name: "",
      business_name: "",
      phone: "",
    });
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
  it("maps declared names to Twilio positional keys, in order", () => {
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
