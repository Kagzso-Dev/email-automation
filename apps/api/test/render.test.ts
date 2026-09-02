import { describe, expect, it } from "vitest";
import { render, RenderError, substitute } from "../src/render/render.js";

describe("substitute", () => {
  it("replaces known variables", () => {
    expect(
      substitute("Hi {{name}}", { name: "Ada" }, { htmlContext: false, declared: [] }),
    ).toBe("Hi Ada");
  });

  it("html-escapes in html context", () => {
    expect(
      substitute("{{x}}", { x: "<script>" }, { htmlContext: true, declared: [] }),
    ).toBe("&lt;script&gt;");
  });

  it("does not escape in text context", () => {
    expect(substitute("{{x}}", { x: "a & b" }, { htmlContext: false, declared: [] })).toBe("a & b");
  });

  it("throws for a missing declared variable", () => {
    expect(() =>
      substitute("{{first_name}}", {}, { htmlContext: false, declared: ["first_name"] }),
    ).toThrow(RenderError);
  });

  it("blanks an undeclared missing variable", () => {
    expect(substitute("x{{y}}z", {}, { htmlContext: false, declared: [] })).toBe("xz");
  });
});

describe("render", () => {
  const base = {
    subject: "Hello {{first_name}}",
    htmlBody: '<p>Hi {{first_name}}</p><a href="https://example.com/a">link</a>',
    declaredVariables: ["first_name"],
    vars: { first_name: "Ada" },
  };

  it("strips script tags via sanitiser", () => {
    const out = render({
      ...base,
      htmlBody: '<p>ok</p><script>alert(1)</script>',
    });
    expect(out.html).not.toContain("<script>");
  });

  it("rewrites links and injects a pixel only for real sends", () => {
    const preview = render(base);
    expect(preview.html).toContain("https://example.com/a");
    expect(preview.html).not.toContain("/api/track/open/");

    const real = render({ ...base, emailLogId: "log_1" });
    expect(real.html).toContain("/api/track/click/log_1");
    expect(real.html).toContain("/api/track/open/log_1.png");
  });

  it("appends an unsubscribe footer when a url is supplied", () => {
    const out = render({ ...base, unsubscribeUrl: "https://x/u/abc" });
    expect(out.html).toContain("https://x/u/abc");
    expect(out.text).toContain("Unsubscribe: https://x/u/abc");
  });
});
