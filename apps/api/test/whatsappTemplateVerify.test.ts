import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Display-only Meta verification of WhatsApp templates: matching rules, paging,
// error handling (unchecked, never failed) and the ~5 min cache. No real Meta calls.

const TOKEN = "EAAGtesttoken0123456789abcdef";
vi.mock("../src/domain/whatsappCredentials.js", () => ({
  getWhatsAppCredentials: async () => ({
    provider: "meta",
    graphApiBaseUrl: "https://graph.facebook.com",
    graphApiVersion: "v24.0",
    accessToken: TOKEN,
    phoneNumberId: "1392061480637682",
    wabaId: "1724385602172159",
    source: "environment",
  }),
  isSendConfigured: () => true,
}));
let rows: { id: string; providerTemplateName: string | null; languageCode: string }[] = [];
vi.mock("../src/prisma.js", () => ({ prisma: { whatsAppTemplate: { findMany: async () => rows } } }));

const { verifyTemplates, getTemplateVerification, resetTemplateVerifyCache } = await import(
  "../src/domain/whatsappTemplateVerify.js"
);
const { listMessageTemplates } = await import("../src/services/whatsapp.js");

const meta = [
  { name: "kagzso_greeting", status: "APPROVED", language: "en", category: "MARKETING" },
  { name: "kagzso_greeting", status: "PENDING", language: "en_US", category: "MARKETING" },
  { name: "kagzso_offer", status: "IN_APPEAL", language: "en" },
  { name: "kagzso_rejected", status: "REJECTED", language: "en" },
  { name: "kagzso_paused", status: "PAUSED", language: "en" },
  { name: "kagzso_disabled", status: "DISABLED", language: "en" },
  { name: "kagzso_hindi_only", status: "APPROVED", language: "hi" },
];
const row = (id: string, providerTemplateName: string | null, languageCode = "en") => ({ id, providerTemplateName, languageCode });
const statusOf = (r: ReturnType<typeof row>, list: typeof meta | Error = meta) => verifyTemplates([r], list)[0]!;

describe("verifyTemplates (matching)", () => {
  it("Verified: exists, APPROVED and same language", () => {
    expect(statusOf(row("a", "kagzso_greeting"))).toMatchObject({ status: "verified", metaStatus: "APPROVED" });
  });

  it("Not found: no template with that exact name", () => {
    const v = statusOf(row("b", "kagzso_does_not_exist"));
    expect(v).toMatchObject({ status: "not_found", metaStatus: null });
    expect(v.reason).toMatch(/No template named "kagzso_does_not_exist"/);
    expect(statusOf(row("b2", "Kagzso_Greeting")).status).toBe("not_found"); // exact, case-sensitive
  });

  it("empty Meta name is left to the existing 'Needs Meta name' badge", () => {
    expect(statusOf(row("c", null))).toMatchObject({ status: "unchecked", reason: "No Meta template name set" });
    expect(statusOf(row("c2", "   ")).status).toBe("unchecked");
  });

  it('"en" and "en_US" are different languages, as in Meta', () => {
    expect(statusOf(row("d", "kagzso_greeting", "en_US"))).toMatchObject({ status: "pending", metaStatus: "PENDING" });
    const wrongLang = statusOf(row("e", "kagzso_hindi_only", "en"));
    expect(wrongLang).toMatchObject({ status: "failed", metaStatus: null });
    expect(wrongLang.reason).toMatch(/only in hi/);
  });

  it("Pending for PENDING / IN_APPEAL, Failed for REJECTED / PAUSED / DISABLED", () => {
    expect(statusOf(row("f", "kagzso_offer")).status).toBe("pending");
    for (const n of ["kagzso_rejected", "kagzso_paused", "kagzso_disabled"]) {
      expect(statusOf(row(n, n))).toMatchObject({ status: "failed" });
    }
  });

  it("a Meta error makes every named row 'unchecked', never failed", () => {
    const v = statusOf(row("g", "kagzso_greeting"), new Error("Meta 403 (#200): no permission"));
    expect(v).toMatchObject({ status: "unchecked", metaStatus: null, reason: "Meta 403 (#200): no permission" });
  });
});

describe("listMessageTemplates + cache", () => {
  const calls: { url: string; auth: string | null }[] = [];
  let respond: (url: string) => Response;
  beforeEach(() => {
    calls.length = 0;
    resetTemplateVerifyCache();
    vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
      calls.push({ url, auth: new Headers(init.headers).get("Authorization") });
      return respond(url);
    });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("follows paging cursors and sends the token only in the Authorization header", async () => {
    respond = (url) =>
      new Response(
        JSON.stringify(
          url.includes("after=CUR1")
            ? { data: [meta[2]], paging: { cursors: { after: "CUR2" } } }
            : { data: [meta[0], meta[1]], paging: { cursors: { after: "CUR1" }, next: "https://graph.facebook.com/next" } },
        ),
        { status: 200 },
      );
    const list = await listMessageTemplates();
    expect(list.map((t) => `${t.name}/${t.language}`)).toEqual(["kagzso_greeting/en", "kagzso_greeting/en_US", "kagzso_offer/en"]);
    expect(calls).toHaveLength(2);
    expect(calls[0]!.url).toContain("/v24.0/1724385602172159/message_templates?");
    expect(calls[0]!.url).toContain("fields=id%2Cname%2Cstatus%2Clanguage%2Ccategory%2Cparameter_format%2Ccomponents");
    expect(calls[0]!.url).toContain("limit=250");
    expect(calls.every((c) => c.auth === `Bearer ${TOKEN}` && !c.url.includes(TOKEN))).toBe(true);
  });

  it("error 190 / 200 → 'Couldn't check' with Meta's message, and no token in the result", async () => {
    respond = () =>
      new Response(
        JSON.stringify({ error: { message: `Invalid OAuth access token ${TOKEN}`, code: 190, fbtrace_id: "AbC" } }),
        { status: 401 },
      );
    rows = [row("a", "kagzso_greeting"), row("n", null)];
    const res = await getTemplateVerification();
    expect(res.error).toMatch(/#190/);
    expect(res.error).toMatch(/fbtrace_id AbC/);
    expect(JSON.stringify(res)).not.toContain(TOKEN);
    expect(res.items.map((i) => i.status)).toEqual(["unchecked", "unchecked"]);
  });

  it("caches Meta's list for ~5 minutes; refresh re-reads it (but not more than every 10 s)", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-10T10:00:00Z"));
    respond = () => new Response(JSON.stringify({ data: meta }), { status: 200 });
    rows = [row("a", "kagzso_greeting"), row("b", "missing_one"), row("c", null)];

    const first = await getTemplateVerification();
    expect(first.items.map((i) => i.status)).toEqual(["verified", "not_found", "unchecked"]);
    await getTemplateVerification();
    expect(calls).toHaveLength(1); // cached

    await getTemplateVerification(true);
    expect(calls).toHaveLength(1); // refresh within 10 s is ignored
    vi.setSystemTime(new Date("2026-10-10T10:00:30Z"));
    await getTemplateVerification(true);
    expect(calls).toHaveLength(2); // forced refresh

    vi.setSystemTime(new Date("2026-10-10T10:06:00Z"));
    await getTemplateVerification();
    expect(calls).toHaveLength(3); // cache expired
  });
});

describe("headerNeedingParameter (header a send must fill in)", () => {
  it("media headers and header variables need a parameter; none / static text don't", async () => {
    const { headerNeedingParameter } = await import("../src/domain/whatsappTemplateVerify.js");
    expect(headerNeedingParameter({ components: [{ type: "HEADER", format: "IMAGE" }, { type: "BODY", text: "Hi {{1}}" }] })).toBe("IMAGE");
    expect(headerNeedingParameter({ components: [{ type: "HEADER", format: "VIDEO" }] })).toBe("VIDEO");
    expect(headerNeedingParameter({ components: [{ type: "HEADER", format: "TEXT", text: "Hello {{1}}" }] })).toBe("TEXT");
    expect(headerNeedingParameter({ components: [{ type: "HEADER", format: "TEXT", text: "Kagzso" }] })).toBeNull();
    expect(headerNeedingParameter({ components: [{ type: "BODY", text: "Hi {{1}}" }] })).toBeNull();
    expect(headerNeedingParameter({})).toBeNull();
  });
});
