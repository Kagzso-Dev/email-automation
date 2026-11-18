import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { render } from "../src/render/render.js";

// Existing templates must render byte-for-byte as before the image size controls
// (ENABLE_IMAGE_SIZE_CONTROLS). The snapshots in __snapshots__ were recorded from the
// renderer BEFORE that feature existed, once per flag value; every flag value must
// keep producing exactly that output for templates whose images are plain URL strings.

type Input = Parameters<typeof render>[0];

const base = {
  subject: "Hello {{first_name}}",
  htmlBody: "<p>Hi {{first_name}},</p>\n<p>Body text.</p>",
  declaredVariables: [],
  vars: { first_name: "Ada" },
} satisfies Partial<Input>;

const CASES: Array<[string, Input]> = [
  ["legacy imageUrl, no placeholder", { ...base, imageUrl: "https://cdn.example.com/hero.jpg" }],
  [
    "images list, no placeholders (stacked last, in order)",
    { ...base, images: ["https://cdn.example.com/a.jpg", "https://cdn.example.com/b.png"] },
  ],
  [
    "{{image}} / {{image_2}} / {{image_3}} placed, extras unplaced",
    {
      ...base,
      htmlBody: "<p>top {{image}}</p>\n<p>middle</p>\n<p>{{image_3}} bottom</p>",
      imageUrl: "https://cdn.example.com/one.jpg",
      images: [
        "https://cdn.example.com/two.jpg",
        "https://cdn.example.com/three.jpg",
        "https://cdn.example.com/four.jpg",
      ],
    },
  ],
  [
    "placeholders without images are dropped",
    { ...base, htmlBody: "<p>a{{image}}b{{image_2}}c</p>" },
  ],
  [
    "disallowed scheme skipped, valid one kept",
    { ...base, images: ["javascript:alert(1)", "https://cdn.example.com/ok.gif"] },
  ],
  [
    "image URL with a variable and characters that need encoding",
    {
      ...base,
      vars: { first_name: "Ada", img_id: "42" },
      images: ['https://cdn.example.com/u/{{img_id}}/pic "x".webp?a=1&b=2'],
    },
  ],
  [
    "uploaded image URL, real send with tracking and a text body using {{image}}",
    {
      ...base,
      htmlBody: '<p>{{image}}</p><p><a href="https://example.com/x">x</a></p>',
      textBody: "Plain {{first_name}} {{image}} end",
      images: ["http://localhost:4000/uploads/template-images/abc-123.png"],
      emailLogId: "log_9",
      tracking: true,
      unsubscribeUrl: "http://localhost:4000/u/z",
    },
  ],
  [
    "everything together: links, videos, images, meeting, footer",
    {
      ...base,
      htmlBody: "<p>{{video_link_2}}</p><p>{{image_2}}</p><p>end</p>",
      kind: "MEETING",
      links: [{ label: "Book", url: "https://example.com/book" }],
      meeting: { title: "Call", startAt: "2026-02-01T09:30", timezone: "UTC" },
      videoUrl: "https://youtu.be/one",
      videos: [{ url: "https://youtu.be/two", label: "Part two" }],
      imageUrl: "https://cdn.example.com/first.jpg",
      images: ["https://cdn.example.com/second.jpg", "https://cdn.example.com/third.jpg"],
      unsubscribeUrl: "http://localhost:4000/u/q",
      includeComplianceFooter: true,
    },
  ],
];

const originalFlag = process.env.ENABLE_IMAGE_SIZE_CONTROLS;
beforeAll(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-01-15T10:00:00Z"));
});
afterAll(() => vi.useRealTimers());
afterEach(() => {
  if (originalFlag === undefined) delete process.env.ENABLE_IMAGE_SIZE_CONTROLS;
  else process.env.ENABLE_IMAGE_SIZE_CONTROLS = originalFlag;
});

describe.each([
  ["flag unset", undefined],
  ["flag false", "false"],
  ["flag true", "true"],
])("existing templates render exactly as before (%s)", (_label, flag) => {
  it.each(CASES)("%s", (_name, input) => {
    if (flag === undefined) delete process.env.ENABLE_IMAGE_SIZE_CONTROLS;
    else process.env.ENABLE_IMAGE_SIZE_CONTROLS = flag;
    expect(render(input)).toMatchSnapshot();
  });
});
