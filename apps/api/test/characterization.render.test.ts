import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { render } from "../src/render/render.js";

// Characterization snapshot of the full email render (plain-letter body, escaped
// variables, links panel, video button, meeting card + invite, compliance
// footer). Any change to the produced HTML, text or attachments fails here.

beforeAll(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-01-15T10:00:00Z"));
});
afterAll(() => vi.useRealTimers());

describe("render output (characterization)", () => {
  it("meeting template with links, video and escaped variables", () => {
    const out = render({
      subject: "Hi {{first_name}} & team",
      htmlBody: "Hello {{first_name}},\n\nSee <you> \"soon\" & bring {{company}}.\nThanks",
      declaredVariables: ["first_name"],
      vars: { first_name: "Ada <A&B>", company: 'Acme "Co"' },
      emailLogId: "log_1",
      unsubscribeUrl: "http://localhost:4000/u/x",
      includeComplianceFooter: true,
      kind: "MEETING",
      links: [
        { label: "Book <now> & save", url: "https://example.com/book?a=1&b=2" },
        { label: "Docs", url: "https://example.com/docs" },
      ],
      meeting: {
        title: 'Demo "call" <1>',
        location: "Room <A> & B",
        joinUrl: "https://meet.example.com/abc",
        startAt: "2026-02-01T09:30",
        endAt: "2026-02-01T10:00",
        timezone: "Asia/Kolkata",
        description: "Line 1 <b>\nLine 2 & more",
      },
      videoUrl: "https://video.example.com/v",
    } as Parameters<typeof render>[0]);
    expect(out).toMatchSnapshot();
  });

  it("standard template, preview mode (no tracking)", () => {
    const out = render({
      subject: "Plain",
      htmlBody: '<p>Hi {{first_name}}</p><a href="https://example.com/a?x=1&y=2">link</a>',
      declaredVariables: [],
      vars: { first_name: "<script>x</script>" },
    });
    expect(out).toMatchSnapshot();
  });
});
