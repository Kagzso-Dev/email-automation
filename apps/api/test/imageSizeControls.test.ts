import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import jwt from "jsonwebtoken";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createTemplateInput, imageAltText, imageBox, imageFileName } from "@dispatch/shared";
import { render } from "../src/render/render.js";

// Image size controls (ENABLE_IMAGE_SIZE_CONTROLS): Small | Best fit | Original size + alt text per
// template image. Images without a size render exactly as before (see imageLegacyRender.test.ts for
// the byte-for-byte snapshots); flag off ignores every stored size and alt text.

vi.mock("../src/prisma.js", async () => ({ prisma: (await import("./fakePrismaPlus.js")).db }));

const originalFlag = process.env.ENABLE_IMAGE_SIZE_CONTROLS;
const flag = (on: boolean) => {
  process.env.ENABLE_IMAGE_SIZE_CONTROLS = on ? "true" : "false";
};
afterEach(() => {
  if (originalFlag === undefined) delete process.env.ENABLE_IMAGE_SIZE_CONTROLS;
  else process.env.ENABLE_IMAGE_SIZE_CONTROLS = originalFlag;
});

type Input = Parameters<typeof render>[0];
const base = {
  subject: "Hello",
  htmlBody: "<p>Hi {{first_name}}</p>",
  declaredVariables: [],
  vars: { first_name: "Ada" },
  includeComplianceFooter: false,
} satisfies Partial<Input>;

const LEGACY_IMG = (src: string) =>
  `<div style="margin:16px 0"><img src="${src}" alt="" style="max-width:100%;height:auto;border:0;border-radius:8px" /></div>`;
const imgTag = (html: string) => html.match(/<img\b[^>]*>/)?.[0] ?? "";
const one = (img: NonNullable<Input["images"]>[number], extra: Partial<Input> = {}) =>
  render({ ...base, images: [img], ...extra });

describe("sizes (flag on)", () => {
  it("Small: a 200px width attribute and inline width, scaled down on phones", () => {
    flag(true);
    const out = one({ url: "https://cdn.example.com/photo.jpg", size: "small", naturalWidth: 1200, alt: "Team photo" });
    expect(out.html).toBe(
      '<p>Hi Ada</p>\n<div style="margin:16px 0"><img src="https://cdn.example.com/photo.jpg" width="200" alt="Team photo" style="display:block;border:0;height:auto;width:200px;max-width:100%;border-radius:8px" /></div>',
    );
  });

  it("Small never enlarges an image narrower than 200px, and is 200px when the width is unknown", () => {
    flag(true);
    expect(imgTag(one({ url: "https://x/qr.png", size: "small", naturalWidth: 120 }).html)).toContain(
      'width="120" alt="qr.png" style="display:block;border:0;height:auto;width:120px;max-width:100%;',
    );
    expect(imgTag(one({ url: "https://x/a.png", size: "small" }).html)).toContain('width="200"');
  });

  it("Best fit: width 100% up to the 600px email column for a wide image", () => {
    flag(true);
    const tag = imgTag(one({ url: "https://x/wide.jpg", size: "fit", naturalWidth: 2400 }).html);
    expect(tag).toContain('width="600"');
    expect(tag).toContain('style="display:block;border:0;height:auto;width:100%;max-width:600px;border-radius:8px"');
  });

  it("Best fit never enlarges a small QR code or logo beyond its own width", () => {
    flag(true);
    const tag = imgTag(one({ url: "https://x/qr.png", size: "fit", naturalWidth: 150 }).html);
    expect(tag).toContain('width="150"');
    expect(tag).toContain("width:100%;max-width:150px;");
  });

  it("Best fit with an unknown width: no stretch and no width attribute, only max-width:100%", () => {
    flag(true);
    const tag = imgTag(one({ url: "https://x/{{id}}.png", size: "fit" }, { vars: { first_name: "Ada", id: "7" } }).html);
    expect(tag).not.toContain("width=");
    expect(tag).not.toMatch(/[;"]width:100%/); // max-width:100% only
    expect(tag).toContain('style="display:block;border:0;height:auto;max-width:100%;border-radius:8px"');
    expect(tag).toContain('src="https://x/7.png"');
  });

  it("Original size: the image's own width, max-width 100% (also for a small QR code)", () => {
    flag(true);
    const tag = imgTag(one({ url: "https://x/chart.png", size: "original", naturalWidth: 900 }).html);
    expect(tag).toContain('width="900"');
    expect(tag).toContain("width:900px;max-width:100%;");
    expect(imgTag(one({ url: "https://x/qr.png", size: "original", naturalWidth: 150 }).html)).toContain(
      'width="150"',
    );
  });

  it("Original size with an unknown width falls back to Best fit", () => {
    flag(true);
    const original = imgTag(one({ url: "https://x/a.png", size: "original" }).html);
    const fit = imgTag(one({ url: "https://x/a.png", size: "fit" }).html);
    expect(original).toBe(fit);
    expect(imageBox("original").fellBack).toBe(true);
  });

  it("an image without a size renders exactly as before, even next to sized ones", () => {
    flag(true);
    const out = render({
      ...base,
      images: ["https://x/old.jpg", { url: "https://x/obj.jpg" }, { url: "https://x/new.jpg", size: "fit", naturalWidth: 800 }],
    });
    expect(out.html).toContain(LEGACY_IMG("https://x/old.jpg"));
    expect(out.html).toContain(LEGACY_IMG("https://x/obj.jpg"));
    expect(out.html).toContain('width="600"');
  });

  it("a disallowed scheme renders nothing, sized or not", () => {
    flag(true);
    const out = render({ ...base, images: [{ url: "javascript:alert(1)", size: "fit", naturalWidth: 100 }] });
    expect(out.html).not.toContain("<img");
    expect(out.html).not.toContain("javascript:");
  });

  it("skips entries that are not images instead of failing the send", () => {
    flag(true);
    const junk = [null, 5, { url: 5 }, { size: "fit" }] as unknown as NonNullable<Input["images"]>;
    const out = render({ ...base, images: [...junk, "https://x/ok.png"] });
    expect(out.html.match(/<img/g)).toHaveLength(1);
    expect(out.html).toContain(LEGACY_IMG("https://x/ok.png"));
  });
});

describe("alt text (flag on)", () => {
  it("is HTML-escaped in the img tag", () => {
    flag(true);
    const tag = imgTag(one({ url: "https://x/a.png", size: "fit", alt: `Ada's "best" <b>deal</b> & more` }).html);
    expect(tag).toContain(`alt="Ada's &quot;best&quot; &lt;b&gt;deal&lt;/b&gt; &amp; more"`);
    expect(tag).not.toContain("<b>");
  });

  it("can use {{variables}}, substituted per recipient and then escaped", () => {
    flag(true);
    const tag = imgTag(one({ url: "https://x/a.png", size: "small", alt: "Offer for {{first_name}}" }, { vars: { first_name: "<Ada>" } }).html);
    expect(tag).toContain('alt="Offer for &lt;Ada&gt;"');
  });

  it("falls back to the upload's file name, then the URL's file name, then 'Image'", () => {
    flag(true);
    const generated = "http://localhost:4000/uploads/template-images/mabc12-0b5c8f7e-1a2b-4c3d-8e9f-0123456789ab.png";
    expect(imgTag(one({ url: generated, size: "fit", name: "Diwali offer.png" }).html)).toContain('alt="Diwali offer.png"');
    expect(imgTag(one({ url: generated, size: "fit" }).html)).toContain('alt="Image"');
    expect(imgTag(one({ url: "https://cdn.example.com/img/team%20photo.jpg?w=600", size: "fit" }).html)).toContain(
      'alt="team photo.jpg"',
    );
    expect(imgTag(one({ url: "https://cdn.example.com/render/12345", size: "fit" }).html)).toContain('alt="Image"');
    expect(imgTag(one({ url: "https://x/a.png", size: "fit", alt: "   " }).html)).toContain('alt="a.png"');
  });

  it("is at most 125 characters, also for a long fallback name", () => {
    expect(imageAltText({ url: "https://x/a.png", name: "n".repeat(300) })).toHaveLength(125);
    expect(imageFileName("https://x/dir/")).toBeNull();
  });

  it("an image without a size keeps alt=\"\" unless the user typed one", () => {
    flag(true);
    expect(one({ url: "https://x/a.png", name: "Logo.png" }).html).toContain(LEGACY_IMG("https://x/a.png"));
    expect(one({ url: "https://x/a.png", alt: "Our logo" }).html).toContain(
      '<div style="margin:16px 0"><img src="https://x/a.png" alt="Our logo" style="max-width:100%;height:auto;border:0;border-radius:8px" /></div>',
    );
  });
});

describe("placeholders (flag on)", () => {
  it("{{image}}, {{image_2}}, {{image_3}} still place sized images; unplaced ones still come last", () => {
    flag(true);
    const out = render({
      ...base,
      htmlBody: "<p>top {{image_3}}</p><p>middle {{image}}</p><p>end</p>",
      links: [{ label: "Visit", url: "https://example.com" }],
      images: [
        { url: "https://x/one.png", size: "small", naturalWidth: 500 },
        "https://x/two.png",
        { url: "https://x/three.png", size: "original", naturalWidth: 300 },
        { url: "https://x/four.png", size: "fit", naturalWidth: 1000 },
      ],
    });
    const at = (s: string) => out.html.indexOf(s);
    expect(at("three.png")).toBeLessThan(at("middle"));
    expect(at("middle")).toBeLessThan(at("one.png"));
    expect(at("one.png")).toBeLessThan(at("end"));
    // unplaced: after the content and the URL buttons, in order
    expect(at("Visit")).toBeLessThan(at("two.png"));
    expect(at("two.png")).toBeLessThan(at("four.png"));
    for (const n of ["one", "two", "three", "four"]) {
      expect(out.html.split(`src="https://x/${n}.png"`)).toHaveLength(2); // placed exactly once
    }
    expect(out.html).toContain(LEGACY_IMG("https://x/two.png"));
  });

  it("the plain-text version is unchanged by sizes and alt texts", () => {
    const urls = ["https://x/one.png", "https://x/two.png"];
    flag(false);
    const plain = render({ ...base, textBody: "Text {{image}} here", images: urls });
    flag(true);
    const sized = render({
      ...base,
      textBody: "Text {{image}} here",
      images: [
        { url: urls[0], size: "small", alt: "One", naturalWidth: 400 },
        { url: urls[1], size: "original", naturalWidth: 900 },
      ],
    });
    expect(sized.text).toBe(plain.text);
  });
});

describe("flag off", () => {
  it("ignores stored sizes and alt texts: the email is exactly as before", () => {
    flag(false);
    const withSettings = render({
      ...base,
      htmlBody: "<p>{{image_2}}</p><p>body</p>",
      images: [
        { url: "https://x/one.png", size: "small", alt: "One", naturalWidth: 400, name: "one.png" },
        { url: "https://x/two.png", size: "fit", naturalWidth: 900 },
      ],
    });
    const plain = render({ ...base, htmlBody: "<p>{{image_2}}</p><p>body</p>", images: ["https://x/one.png", "https://x/two.png"] });
    expect(withSettings).toEqual(plain);
    expect(withSettings.html).not.toContain('width="');
  });

  it("anything but true / 1 / yes / on counts as off", () => {
    for (const v of ["", "false", "0", "no", "off", "maybe"]) {
      process.env.ENABLE_IMAGE_SIZE_CONTROLS = v;
      expect(imgTag(one({ url: "https://x/a.png", size: "small", naturalWidth: 900 }).html)).not.toContain("width=");
    }
    for (const v of ["true", "TRUE", "1", "yes", " on "]) {
      process.env.ENABLE_IMAGE_SIZE_CONTROLS = v;
      expect(imgTag(one({ url: "https://x/a.png", size: "small", naturalWidth: 900 }).html)).toContain('width="200"');
    }
  });
});

describe("template schema", () => {
  const tpl = { name: "T", subject: "S", bodyText: "Hi" };

  it("accepts plain URLs, objects and a mix (max 10)", () => {
    const parsed = createTemplateInput.parse({
      ...tpl,
      images: ["https://x/a.png", { url: "https://x/b.png", size: "fit", alt: "B", naturalWidth: 640, name: "b.png" }],
    });
    expect(parsed.images).toEqual([
      "https://x/a.png",
      { url: "https://x/b.png", size: "fit", alt: "B", naturalWidth: 640, name: "b.png" },
    ]);
    expect(() => createTemplateInput.parse({ ...tpl, images: Array(11).fill("https://x/a.png") })).toThrow();
  });

  it("rejects an alt text over 125 characters, an unknown size and a bad width", () => {
    const bad = (img: unknown) => createTemplateInput.safeParse({ ...tpl, images: [img] }).success;
    expect(bad({ url: "https://x/a.png", alt: "a".repeat(125) })).toBe(true);
    expect(bad({ url: "https://x/a.png", alt: "a".repeat(126) })).toBe(false);
    expect(bad({ url: "https://x/a.png", size: "huge" })).toBe(false);
    expect(bad({ url: "https://x/a.png", naturalWidth: 0 })).toBe(false);
    expect(bad({ url: "https://x/a.png", naturalWidth: 10.5 })).toBe(false);
  });
});

describe("GET /api/image-size-controls/config", () => {
  let server: Server;
  let baseUrl = "";
  const token = jwt.sign({ sub: "u-EDITOR", email: "editor@test", role: "EDITOR" }, process.env.JWT_ACCESS_SECRET!);
  beforeAll(async () => {
    const { createApp } = await import("../src/http/app.js");
    server = createApp().listen(0);
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(async () => {
    await new Promise<void>((r) => server.close(() => r()));
  });
  const get = (auth = true) =>
    fetch(`${baseUrl}/api/image-size-controls/config`, { headers: auth ? { Authorization: `Bearer ${token}` } : {} });

  it("answers { enabled } for any signed-in user, read at request time", async () => {
    flag(false);
    expect(await (await get()).json()).toEqual({ enabled: false });
    flag(true);
    expect(await (await get()).json()).toEqual({ enabled: true });
  });

  it("needs a sign-in", async () => {
    expect((await get(false)).status).toBe(401);
  });
});
