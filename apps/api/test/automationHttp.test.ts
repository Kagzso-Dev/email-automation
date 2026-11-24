import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import jwt from "jsonwebtoken";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { automation } from "./fakePrismaAutomation.js";

// /api/automation (ENABLE_AUTOMATION, migration 0041): LinkedIn Automation + Instagram Automation.
//   - flag off: EVERY endpoint answers 404, signed in or not; nothing reaches LinkedIn / Meta or the database
//   - ADMIN and EDITOR only (no token 401, any other role 403)
//   - Instagram DMs: only inside the 24-hour window (HUMAN_AGENT tag: approved, one recipient, chosen); nothing is
//     sent without the preview's confirm token and count; every recipient is logged (sent / failed / blocked)
//   - LinkedIn DMs: never (409 dm_unavailable), LinkedIn is never called for them
//   - tokens are never in a response body or a log line, even when LinkedIn / Meta echo them back in an error
// LinkedIn and Meta are a fake behind fetch; Prisma is an in-memory fake.

vi.mock("../src/prisma.js", async () => ({ prisma: (await import("./fakePrismaAutomation.js")).db }));

const SECRETS = { li: "LI-SECRET-TOKEN-aaaa1111", meta: "META-ADS-SECRET-bbbb2222", ig: "IG-MSG-SECRET-cccc3333" };
const ENV: Record<string, string> = {
  LINKEDIN_ACCESS_TOKEN: SECRETS.li,
  LINKEDIN_AD_ACCOUNT_ID: "111",
  LINKEDIN_API_VERSION: "202606",
  META_ADS_ACCESS_TOKEN: SECRETS.meta,
  META_AD_ACCOUNT_ID: "222",
  INSTAGRAM_PAGE_ID: "333",
  INSTAGRAM_ACCOUNT_ID: "444",
  INSTAGRAM_MESSAGING_ACCESS_TOKEN: SECRETS.ig,
  INSTAGRAM_HUMAN_AGENT_ENABLED: "false",
  AUTOMATION_META_GRAPH_VERSION: "v24.0",
};
const saved: Record<string, string | undefined> = {};
for (const k of [...Object.keys(ENV), "ENABLE_AUTOMATION"]) saved[k] = process.env[k];
const flag = (on: boolean | undefined) => {
  if (on === undefined) delete process.env.ENABLE_AUTOMATION;
  else process.env.ENABLE_AUTOMATION = on ? "true" : "false";
};

/* ------------------------------------------------------------- fake LinkedIn + Meta */

type Call = { url: string; method: string; headers: Headers; body: string | undefined };
let calls: Call[] = [];
/** Answer a matching upstream request differently (an error, an echoed token, …). */
let override: ((c: Call) => Response | undefined) | null = null;
const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...headers } });
const H = 60 * 60_000;
const iso = (msAgo: number) => new Date(Date.now() - msAgo).toISOString();

function upstreamAnswer(c: Call): Response {
  const u = new URL(c.url);
  const p = u.pathname;
  if (u.host === "api.linkedin.com") {
    if (p === "/rest/adAccounts/111") return json({ name: "Kagzso LinkedIn", currency: "INR", status: "ACTIVE" });
    if (p === "/rest/adAccounts/111/adCampaigns" && c.method === "GET")
      return json({
        elements: [
          { id: 501, name: "LI Webinar", status: "ACTIVE", objectiveType: "WEBSITE_VISIT", dailyBudget: { amount: "50.00", currencyCode: "INR" } },
          { id: 502, name: "LI Draft", status: "DRAFT", objectiveType: "LEAD_GENERATION" },
        ],
      });
    if (p === "/rest/adAccounts/111/adCampaigns" && c.method === "POST") return new Response(null, { status: 201, headers: { "x-restli-id": "777" } });
    if (p === "/rest/adAccounts/111/adCampaigns/501") return new Response(null, { status: 204 });
    if (p === "/rest/adAccounts/111/adCampaignGroups") return json({ elements: [{ id: 9, name: "Default group", status: "ACTIVE" }] });
    if (p === "/rest/adAnalytics")
      return json({ elements: [{ pivotValues: ["urn:li:sponsoredCampaign:501"], costInLocalCurrency: "123.45", impressions: 1000, clicks: 40, externalWebsiteConversions: 3, oneClickLeads: 2 }] });
  }
  if (u.host === "graph.facebook.com") {
    if (p === "/v24.0/act_222") return json({ name: "Kagzso Ads", currency: "USD", account_status: 1 });
    if (p === "/v24.0/act_222/campaigns" && c.method === "GET")
      return json({
        data: [
          { id: "601", name: "IG Reels", status: "ACTIVE", effective_status: "ACTIVE", objective: "OUTCOME_TRAFFIC", daily_budget: "2500" },
          { id: "602", name: "FB only", status: "PAUSED", effective_status: "PAUSED", objective: "OUTCOME_LEADS" },
        ],
      });
    if (p === "/v24.0/act_222/campaigns" && c.method === "POST") return json({ id: "888" });
    if (p === "/v24.0/act_222/adsets")
      return json({ data: [{ campaign_id: "601", targeting: { publisher_platforms: ["instagram", "facebook"] } }, { campaign_id: "602", targeting: { publisher_platforms: ["facebook"] } }] });
    if (p === "/v24.0/act_222/insights")
      return json({ data: [{ campaign_id: "601", spend: "12.50", impressions: "900", clicks: "30", actions: [{ action_type: "lead", value: "4" }, { action_type: "link_click", value: "30" }] }] });
    if (p === "/v24.0/601" || p === "/v24.0/602") return json({ success: true });
    if (p === "/v24.0/444") return json({ id: "444", username: "kagzso" });
    if (p === "/v24.0/333/conversations")
      return json({
        data: [
          convo("9001", "recent_fan", [["9001", iso(1 * H)], ["444", iso(0.5 * H)]]),
          convo("9002", "two_days", [["9002", iso(48 * H)]]),
          convo("9003", "ten_days", [["9003", iso(240 * H)]]),
          convo("9004", "never_wrote", [["444", iso(2 * H)]]),
        ],
        paging: { cursors: { after: "x" } }, // no "next": the last page
      });
    if (p === "/v24.0/333/messages") return json({ recipient_id: JSON.parse(c.body ?? "{}").recipient?.id, message_id: `mid.${calls.length}` });
  }
  return json({ error: "unexpected upstream call in test", url: c.url }, 500);
}

function convo(id: string, username: string, msgs: Array<[string, string]>) {
  return {
    participants: { data: [{ id: "444", username: "kagzso" }, { id, username }] },
    updated_time: msgs[0]![1],
    messages: { data: msgs.map(([from, created_time]) => ({ from: { id: from }, created_time })) },
  };
}

const realFetch = globalThis.fetch;
const upstreamCalls = () => calls.filter((c) => !c.url.startsWith("http://127.0.0.1"));
const sentMessages = () => upstreamCalls().filter((c) => c.url.endsWith("/333/messages")).map((c) => JSON.parse(c.body ?? "{}"));

/* ------------------------------------------------------------- server + auth */

let server: Server;
let base = "";
let userSeq = 0;
type Who = "ADMIN" | "EDITOR" | "VIEWER";
// A fresh user per test: the per-user rate limits never carry over between tests.
const auth = (who: Who | null): Record<string, string> =>
  who ? { Authorization: `Bearer ${jwt.sign({ sub: `u-${who}-${userSeq}`, email: `${who.toLowerCase()}@test`, role: who }, process.env.JWT_ACCESS_SECRET!)}` } : {};

async function call(method: string, path: string, who: Who | null = "ADMIN", body?: unknown) {
  const res = await realFetch(`${base}${path}`, {
    method,
    headers: { ...auth(who), ...(body !== undefined ? { "Content-Type": "application/json" } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  bodies.push(text);
  let data: any = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  return { status: res.status, data };
}

/** Every response body of the whole file: checked for tokens at the end. */
const bodies: string[] = [];
/** Every log line of the whole file: checked for tokens at the end. */
const logLines: string[] = [];

beforeAll(async () => {
  Object.assign(process.env, ENV);
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url.startsWith("http://127.0.0.1")) return realFetch(input, init);
      const c: Call = { url, method: init?.method ?? "GET", headers: new Headers(init?.headers), body: typeof init?.body === "string" ? init.body : undefined };
      calls.push(c);
      return override?.(c) ?? upstreamAnswer(c);
    }),
  );
  const { logger } = await import("../src/logger.js");
  const capture = (...args: unknown[]) => {
    logLines.push(JSON.stringify(args, (_k, v) => (v instanceof Error ? { message: v.message, stack: v.stack, ...(v as object) } : v)));
  };
  for (const level of ["info", "warn", "error", "debug"] as const) vi.spyOn(logger, level).mockImplementation(capture as never);
  const { createApp } = await import("../src/http/app.js");
  server = createApp().listen(0);
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});
beforeEach(() => {
  userSeq++;
  flag(true);
  automation.reset();
  calls = [];
  override = null;
  process.env.INSTAGRAM_HUMAN_AGENT_ENABLED = "false";
});
afterEach(() => {
  override = null;
});

/* ------------------------------------------------------------- the endpoints */

const ENDPOINTS: Array<[string, string, unknown?]> = [
  ["GET", "/api/automation/config"],
  ["GET", "/api/automation/linkedin/status"],
  ["GET", "/api/automation/instagram/status"],
  ["GET", "/api/automation/linkedin/campaigns"],
  ["GET", "/api/automation/instagram/campaigns"],
  ["GET", "/api/automation/linkedin/campaign-groups"],
  ["POST", "/api/automation/linkedin/campaigns", { name: "X", objective: "WEBSITE_VISIT", dailyBudget: 10, campaignGroupId: "9" }],
  ["POST", "/api/automation/instagram/campaigns", { name: "X", objective: "OUTCOME_TRAFFIC", dailyBudget: 10 }],
  ["POST", "/api/automation/linkedin/campaigns/501/pause", {}],
  ["POST", "/api/automation/instagram/campaigns/601/resume", {}],
  ["GET", "/api/automation/instagram/conversations"],
  ["POST", "/api/automation/instagram/dm/preview", { recipientIds: ["9001"], message: "Hi" }],
  ["POST", "/api/automation/instagram/dm", { recipientIds: ["9001"], message: "Hi", confirmToken: "1.abcdefghijk", confirmCount: 1 }],
  ["POST", "/api/automation/linkedin/dm", { recipientIds: ["1"], message: "Hi", confirmToken: "1.abcdefghijk", confirmCount: 1 }],
  ["GET", "/api/automation/instagram/dm/history"],
  ["GET", "/api/automation/linkedin/dm/history"],
];

describe("flag off", () => {
  for (const setting of [undefined, false] as const) {
    it(`ENABLE_AUTOMATION=${setting ?? "(unset)"}: every endpoint is 404 for admins, editors and signed-out callers; nothing upstream or in the DB`, async () => {
      flag(setting);
      for (const [method, path, body] of ENDPOINTS) {
        for (const who of ["ADMIN", "EDITOR", null] as const) {
          const r = await call(method, path, who, body);
          expect(r.status, `${method} ${path} as ${who}`).toBe(404);
        }
      }
      expect(upstreamCalls()).toEqual([]);
      expect(automation.touched).toEqual([]);
    });
  }
  it("an unknown path under /api/automation is 404 as well", async () => {
    flag(false);
    expect((await call("GET", "/api/automation/whatever")).status).toBe(404);
  });
});

describe("roles", () => {
  it("signed out: 401 on every endpoint", async () => {
    for (const [method, path, body] of ENDPOINTS) expect((await call(method, path, null, body)).status, `${method} ${path}`).toBe(401);
  });
  it("a role other than ADMIN / EDITOR: 403 on every endpoint", async () => {
    for (const [method, path, body] of ENDPOINTS) expect((await call(method, path, "VIEWER", body)).status, `${method} ${path}`).toBe(403);
    expect(upstreamCalls()).toEqual([]);
  });
  it("ADMIN and EDITOR both get in", async () => {
    for (const who of ["ADMIN", "EDITOR"] as const) {
      expect((await call("GET", "/api/automation/config", who)).status).toBe(200);
      expect((await call("GET", "/api/automation/instagram/campaigns", who)).status).toBe(200);
    }
  });
});

describe("config + status", () => {
  it("config: configured flags only; LinkedIn DM unavailable with the reason", async () => {
    const r = await call("GET", "/api/automation/config");
    expect(r.data).toEqual({
      enabled: true,
      linkedin: { adsConfigured: true, dmAvailable: false, dmReason: expect.stringContaining("no public messaging API") },
      instagram: { adsConfigured: true, messagingConfigured: true, humanAgentEnabled: false },
    });
  });
  it("status: connected with the account; not configured → not connected, LinkedIn/Meta never asked", async () => {
    const li = await call("GET", "/api/automation/linkedin/status");
    expect(li.data.ads).toMatchObject({ configured: true, connected: true, account: { id: "111", name: "Kagzso LinkedIn", currency: "INR" } });
    expect(li.data.dm.available).toBe(false);
    const ig = await call("GET", "/api/automation/instagram/status");
    expect(ig.data.ads.account).toMatchObject({ id: "act_222", currency: "USD", status: "ACTIVE" });
    expect(ig.data.messaging.account).toEqual({ id: "444", username: "kagzso" });
    expect(ig.data.dm.available).toBe(true);

    delete process.env.LINKEDIN_ACCESS_TOKEN;
    calls = [];
    try {
      const off = await call("GET", "/api/automation/linkedin/status");
      expect(off.data.ads).toEqual({ configured: false, connected: false, account: null, error: null });
      expect(upstreamCalls()).toEqual([]);
      expect((await call("GET", "/api/automation/linkedin/campaigns")).data.code).toBe("not_connected");
    } finally {
      process.env.LINKEDIN_ACCESS_TOKEN = SECRETS.li;
    }
  });
  it("an expired token shows as not connected with token_invalid (never a 401 that would sign the user out)", async () => {
    override = (c) => (c.url.includes("api.linkedin.com") ? json({ message: "Expired", serviceErrorCode: 65601 }, 401) : undefined);
    const r = await call("GET", "/api/automation/linkedin/status");
    expect(r.status).toBe(200);
    expect(r.data.ads).toMatchObject({ configured: true, connected: false, error: { code: "token_invalid" } });
    const camp = await call("GET", "/api/automation/linkedin/campaigns");
    expect(camp.status).toBe(502);
    expect(camp.data.code).toBe("token_invalid");
  });
  it("tokens go in the Authorization header, never in a URL", async () => {
    await call("GET", "/api/automation/linkedin/campaigns");
    await call("GET", "/api/automation/instagram/campaigns");
    await call("GET", "/api/automation/instagram/conversations");
    for (const c of upstreamCalls()) {
      for (const s of Object.values(SECRETS)) expect(c.url).not.toContain(s);
      expect(c.headers.get("authorization")).toMatch(/^Bearer /);
    }
    const li = upstreamCalls().find((c) => c.url.includes("linkedin"))!;
    expect(li.headers.get("linkedin-version")).toBe("202606");
    expect(li.headers.get("x-restli-protocol-version")).toBe("2.0.0");
  });
});

describe("campaigns", () => {
  it("LinkedIn: status, daily budget, last-30-day spend / results; pause only when active, resume when paused or draft", async () => {
    const r = await call("GET", "/api/automation/linkedin/campaigns");
    expect(r.status).toBe(200);
    expect(r.data.metricsError).toBeNull();
    expect(r.data.campaigns).toEqual([
      expect.objectContaining({ id: "501", state: "active", dailyBudget: 50, currency: "INR", spend: 123.45, impressions: 1000, clicks: 40, conversions: 5, canPause: true, canResume: false }),
      expect.objectContaining({ id: "502", state: "draft", spend: 0, canPause: false, canResume: true }),
    ]);
  });
  it("LinkedIn: campaigns still load when the reporting call is refused", async () => {
    override = (c) => (c.url.includes("/rest/adAnalytics") ? json({ message: "Not enough permissions" }, 403) : undefined);
    const r = await call("GET", "/api/automation/linkedin/campaigns");
    expect(r.status).toBe(200);
    expect(r.data.campaigns).toHaveLength(2);
    expect(r.data.metricsError).toMatch(/permission/);
    expect(r.data.campaigns[0].spend).toBeNull();
  });
  it("Instagram (Meta): budget from minor units, placement per campaign, conversions from actions", async () => {
    const r = await call("GET", "/api/automation/instagram/campaigns");
    expect(r.data.campaigns).toEqual([
      expect.objectContaining({ id: "601", placement: "instagram", dailyBudget: 25, currency: "USD", spend: 12.5, clicks: 30, conversions: 4, canPause: true }),
      expect.objectContaining({ id: "602", placement: "other", state: "paused", canResume: true }),
    ]);
  });
  it("create: LinkedIn as DRAFT, Meta as PAUSED — nothing can spend; both logged", async () => {
    const li = await call("POST", "/api/automation/linkedin/campaigns", "EDITOR", { name: "New LI", objective: "WEBSITE_VISIT", dailyBudget: 20, campaignGroupId: "9" });
    expect(li.status).toBe(201);
    expect(li.data).toEqual({ id: "777", status: "DRAFT" });
    const liBody = JSON.parse(upstreamCalls().find((c) => c.method === "POST" && c.url.endsWith("/adCampaigns"))!.body!);
    expect(liBody).toMatchObject({ status: "DRAFT", name: "New LI", campaignGroup: "urn:li:sponsoredCampaignGroup:9", dailyBudget: { amount: "20.00", currencyCode: "INR" } });

    const meta = await call("POST", "/api/automation/instagram/campaigns", "ADMIN", { name: "New IG", objective: "OUTCOME_TRAFFIC", dailyBudget: 15 });
    expect(meta.data).toEqual({ id: "888", status: "PAUSED" });
    const form = new URLSearchParams(upstreamCalls().find((c) => c.method === "POST" && c.url.endsWith("/act_222/campaigns"))!.body!);
    expect(form.get("status")).toBe("PAUSED");
    expect(form.get("daily_budget")).toBe("1500");

    expect(automation.actions.map((a) => [a.platform, a.action, a.status, a.campaignId, a.actorEmail])).toEqual([
      ["linkedin", "create", "ok", "777", "editor@test"],
      ["instagram", "create", "ok", "888", "admin@test"],
    ]);
  });
  it("create: an unknown objective or a bad budget is refused before LinkedIn / Meta is called", async () => {
    expect((await call("POST", "/api/automation/instagram/campaigns", "ADMIN", { name: "x", objective: "BRAND_AWARENESS", dailyBudget: 5 })).status).toBe(400);
    expect((await call("POST", "/api/automation/instagram/campaigns", "ADMIN", { name: "x", objective: "OUTCOME_TRAFFIC", dailyBudget: 0 })).status).toBe(400);
    expect(upstreamCalls()).toEqual([]);
  });
  it("pause / resume: LinkedIn PARTIAL_UPDATE, Meta status; logged, failures too", async () => {
    expect((await call("POST", "/api/automation/linkedin/campaigns/501/pause", "ADMIN", { name: "LI Webinar" })).data).toEqual({ id: "501", status: "PAUSED" });
    const li = upstreamCalls().at(-1)!;
    expect(li.headers.get("x-restli-method")).toBe("PARTIAL_UPDATE");
    expect(JSON.parse(li.body!)).toEqual({ patch: { $set: { status: "PAUSED" } } });

    expect((await call("POST", "/api/automation/instagram/campaigns/601/resume")).data).toEqual({ id: "601", status: "ACTIVE" });
    expect(new URLSearchParams(upstreamCalls().at(-1)!.body!).get("status")).toBe("ACTIVE");

    override = (c) => (c.url.endsWith("/v24.0/602") ? json({ error: { message: "nope", code: 100 } }, 400) : undefined);
    expect((await call("POST", "/api/automation/instagram/campaigns/602/resume")).status).toBe(400);
    expect(automation.actions.map((a) => [a.campaignId, a.action, a.status])).toEqual([
      ["501", "pause", "ok"],
      ["601", "resume", "ok"],
      ["602", "resume", "failed"],
    ]);
  });
  it("a campaign id that isn't a number is refused", async () => {
    expect((await call("POST", "/api/automation/instagram/campaigns/..%2F222/pause")).status).toBe(400);
    expect((await call("POST", "/api/automation/instagram/campaigns/601/delete")).status).toBe(400);
    expect(upstreamCalls()).toEqual([]);
  });
});

describe("rate limits and errors from LinkedIn / Meta", () => {
  it("LinkedIn 429 → 429 rate_limited with the retry time", async () => {
    override = (c) => (c.url.includes("api.linkedin.com") ? json({ message: "Throttled" }, 429, { "Retry-After": "42" }) : undefined);
    const r = await call("GET", "/api/automation/linkedin/campaigns");
    expect(r.status).toBe(429);
    expect(r.data).toMatchObject({ code: "rate_limited", details: { retryAfterSec: 42 } });
  });
  it("Meta throttling codes (17, 80004) → 429 rate_limited", async () => {
    for (const code of [17, 80004]) {
      override = (c) => (c.url.includes("act_222") ? json({ error: { message: "User request limit reached", code } }, 400) : undefined);
      const r = await call("GET", "/api/automation/instagram/campaigns");
      expect(r.status, `code ${code}`).toBe(429);
      expect(r.data.code).toBe("rate_limited");
    }
  });
  it("Meta token error (190) → 502 token_invalid, saying which variable to update", async () => {
    override = (c) => (c.url.includes("act_222") ? json({ error: { message: "Error validating access token", code: 190 } }, 400) : undefined);
    const r = await call("GET", "/api/automation/instagram/campaigns");
    expect(r.status).toBe(502);
    expect(r.data).toMatchObject({ code: "token_invalid", error: expect.stringContaining("META_ADS_ACCESS_TOKEN") });
  });
  it("LinkedIn / Meta unreachable → 502, no crash", async () => {
    override = (c) => {
      if (c.url.includes("api.linkedin.com")) throw new TypeError("fetch failed");
      return undefined;
    };
    const r = await call("GET", "/api/automation/linkedin/campaigns");
    expect(r.status).toBe(502);
    expect(r.data.code).toBe("upstream_unreachable");
  });
});

describe("Instagram DMs", () => {
  async function preview(recipientIds: string[], message = "Hello there", useHumanAgentTag = false) {
    return call("POST", "/api/automation/instagram/dm/preview", "ADMIN", { recipientIds, message, useHumanAgentTag });
  }

  it("conversations: each recipient with their window state", async () => {
    const r = await call("GET", "/api/automation/instagram/conversations");
    expect(r.data.recipients.map((x: any) => [x.recipientId, x.username, x.window])).toEqual([
      ["9001", "recent_fan", "open"],
      ["9002", "two_days", "human_agent"],
      ["9003", "ten_days", "closed"],
      ["9004", "never_wrote", "no_inbound"],
    ]);
    expect(r.data.humanAgentEnabled).toBe(false);
  });

  it("preview: the count of who can be sent to, with the reason for each blocked one; sends nothing", async () => {
    const r = await preview(["9001", "9002", "9003", "9004", "9999"]);
    expect(r.status).toBe(200);
    expect(r.data.sendable).toBe(1);
    expect(r.data.blocked).toBe(4);
    expect(r.data.confirmToken).toEqual(expect.any(String));
    expect(r.data.recipients.map((x: any) => [x.recipientId, x.allowed, x.reason])).toEqual([
      ["9001", true, null],
      ["9002", false, "human_agent_disabled"],
      ["9003", false, "closed"],
      ["9004", false, "no_inbound"],
      ["9999", false, "no_conversation"],
    ]);
    expect(sentMessages()).toEqual([]);
    expect(automation.sends).toEqual([]);
  });

  it("nobody sendable: no confirm token, so nothing can be sent", async () => {
    const r = await preview(["9003"]);
    expect(r.data).toMatchObject({ sendable: 0, confirmToken: null });
  });

  it("send without the confirm step (or a wrong count, a changed message, another user's token): refused, nothing sent or logged", async () => {
    const p = await preview(["9001"]);
    const body = { recipientIds: ["9001"], message: "Hello there", useHumanAgentTag: false, confirmToken: p.data.confirmToken, confirmCount: 1 };
    const tries = [
      { ...body, confirmToken: "123456.forgedforged" },
      { ...body, confirmCount: 2 },
      { ...body, message: "Something else" },
      { ...body, recipientIds: ["9001", "9002"] },
    ];
    for (const t of tries) {
      const r = await call("POST", "/api/automation/instagram/dm", "ADMIN", t);
      expect(r.status).toBe(409);
      expect(r.data.code).toBe("confirm_required");
    }
    userSeq++; // another user with the first user's token
    expect((await call("POST", "/api/automation/instagram/dm", "ADMIN", body)).status).toBe(409);
    expect(sentMessages()).toEqual([]);
    expect(automation.sends).toEqual([]);
  });

  it("send after confirm: only recipients inside the 24-hour window get it; every recipient is logged", async () => {
    const ids = ["9001", "9002", "9003"];
    const p = await preview(ids);
    const r = await call("POST", "/api/automation/instagram/dm", "ADMIN", { recipientIds: ids, message: "Hello there", useHumanAgentTag: false, confirmToken: p.data.confirmToken, confirmCount: p.data.sendable });
    expect(r.status).toBe(200);
    expect(r.data).toMatchObject({ sent: 1, failed: 0, blocked: 2 });
    expect(sentMessages()).toEqual([{ recipient: { id: "9001" }, message: { text: "Hello there" }, messaging_type: "RESPONSE" }]);
    expect(automation.sends.map((s) => [s.recipientId, s.status, s.windowState, s.messageTag, s.sentByEmail])).toEqual([
      ["9001", "sent", "open", null, "admin@test"],
      ["9002", "blocked", "human_agent", null, "admin@test"],
      ["9003", "blocked", "closed", null, "admin@test"],
    ]);
    expect(new Set(automation.sends.map((s) => s.batchId)).size).toBe(1);

    const h = await call("GET", "/api/automation/instagram/dm/history");
    expect(h.data.total).toBe(3);
    expect(h.data.items[0]).not.toHaveProperty("sentById");
  });

  it("the window is checked again at send time: a recipient whose window closed after the preview is blocked", async () => {
    const p = await preview(["9001"]);
    override = (c) =>
      c.url.includes("/333/conversations") ? json({ data: [convo("9001", "recent_fan", [["9001", iso(25 * H)]])] }) : undefined;
    const r = await call("POST", "/api/automation/instagram/dm", "ADMIN", { recipientIds: ["9001"], message: "Hello there", confirmToken: p.data.confirmToken, confirmCount: 1 });
    expect(r.data).toMatchObject({ sent: 0, blocked: 1 });
    expect(sentMessages()).toEqual([]);
  });

  it("outside 24 h with the human agent feature on: one recipient, tag chosen → sent with HUMAN_AGENT; in bulk → blocked", async () => {
    process.env.INSTAGRAM_HUMAN_AGENT_ENABLED = "true";
    const one = await preview(["9002"], "Following up", true);
    expect(one.data.sendable).toBe(1);
    const r = await call("POST", "/api/automation/instagram/dm", "ADMIN", { recipientIds: ["9002"], message: "Following up", useHumanAgentTag: true, confirmToken: one.data.confirmToken, confirmCount: 1 });
    expect(r.data.sent).toBe(1);
    expect(sentMessages().at(-1)).toEqual({ recipient: { id: "9002" }, message: { text: "Following up" }, messaging_type: "MESSAGE_TAG", tag: "HUMAN_AGENT" });
    expect(automation.sends.at(-1)).toMatchObject({ messageTag: "HUMAN_AGENT", status: "sent" });

    const bulk = await preview(["9001", "9002"], "Following up", true);
    expect(bulk.data.recipients.map((x: any) => [x.recipientId, x.allowed, x.tag, x.reason])).toEqual([
      ["9001", true, null, null],
      ["9002", false, null, "human_agent_bulk"],
    ]);
    // 7 days or more: never, even with everything on.
    expect((await preview(["9003"], "x", true)).data.sendable).toBe(0);
  });

  it("Instagram's own outside-window refusal is logged as failed with outside_window", async () => {
    const p = await preview(["9001"]);
    override = (c) => (c.url.endsWith("/333/messages") ? json({ error: { message: "This message is sent outside of allowed window.", code: 10, error_subcode: 2534022 } }, 400) : undefined);
    const r = await call("POST", "/api/automation/instagram/dm", "ADMIN", { recipientIds: ["9001"], message: "Hello there", confirmToken: p.data.confirmToken, confirmCount: 1 });
    expect(r.data).toMatchObject({ sent: 0, failed: 1 });
    expect(automation.sends[0]).toMatchObject({ status: "failed", errorCode: "outside_window" });
  });

  it("a rate limit mid-batch stops the rest (logged as not sent) instead of hammering Instagram", async () => {
    process.env.INSTAGRAM_HUMAN_AGENT_ENABLED = "false";
    override = (c) =>
      c.url.includes("/333/conversations")
        ? json({ data: ["9101", "9102", "9103"].map((id) => convo(id, `u${id}`, [[id, iso(H)]])) })
        : c.url.endsWith("/333/messages") && sentMessages().length >= 2
          ? json({ error: { message: "Calls to this api have exceeded the rate limit.", code: 613 } }, 400)
          : undefined;
    const ids = ["9101", "9102", "9103"];
    const p = await preview(ids, "Hi");
    expect(p.data.sendable).toBe(3);
    const r = await call("POST", "/api/automation/instagram/dm", "ADMIN", { recipientIds: ids, message: "Hi", confirmToken: p.data.confirmToken, confirmCount: 3 });
    expect(r.data).toMatchObject({ sent: 1, failed: 2 });
    expect(sentMessages()).toHaveLength(2); // the third is never attempted
    expect(automation.sends.map((s) => [s.recipientId, s.status, s.errorCode])).toEqual([
      ["9101", "sent", null],
      ["9102", "failed", "rate_limited"],
      ["9103", "failed", "rate_limited"],
    ]);
  });

  it("before migration 0041: 503 saying what to run, and nothing is sent", async () => {
    const p = await preview(["9001"]);
    automation.missing = true;
    const r = await call("POST", "/api/automation/instagram/dm", "ADMIN", { recipientIds: ["9001"], message: "Hello there", confirmToken: p.data.confirmToken, confirmCount: 1 });
    expect(r.status).toBe(503);
    expect(r.data).toMatchObject({ code: "needs_migration", error: expect.stringContaining("0041") });
    expect(sentMessages()).toEqual([]);
    expect((await call("GET", "/api/automation/instagram/dm/history")).status).toBe(503);
  });

  it("validation: no recipients, too many, a duplicate, an empty or too-long message", async () => {
    expect((await preview([])).status).toBe(400);
    expect((await preview(Array.from({ length: 51 }, (_, i) => String(9000 + i)))).status).toBe(400);
    expect((await preview(["9001", "9001"])).status).toBe(400);
    expect((await preview(["9001"], "   ")).status).toBe(400);
    expect((await preview(["9001"], "é".repeat(501))).status).toBe(400); // 1002 bytes
    expect((await preview(["abc"])).status).toBe(400);
  });

  it("the DM endpoints are rate limited per user", async () => {
    let last = 0;
    for (let i = 0; i < 11; i++) last = (await preview(["9001"])).status;
    expect(last).toBe(429);
  });
});

describe("LinkedIn DMs", () => {
  it("preview and send: 409 dm_unavailable with the reason; LinkedIn is never called, nothing logged", async () => {
    for (const path of ["/api/automation/linkedin/dm/preview", "/api/automation/linkedin/dm"]) {
      const r = await call("POST", path, "ADMIN", { recipientIds: ["1"], message: "Hi", confirmToken: "1.abcdefghijk", confirmCount: 1 });
      expect(r.status).toBe(409);
      expect(r.data).toMatchObject({ code: "dm_unavailable", error: expect.stringContaining("no public messaging API") });
    }
    expect(upstreamCalls()).toEqual([]);
    expect(automation.sends).toEqual([]);
  });
});

describe("secrets", () => {
  it("errors that echo a token back are scrubbed before they reach a response", async () => {
    override = (c) =>
      c.url.includes("act_222")
        ? json({ error: { message: `Invalid parameter for token ${SECRETS.meta} (access_token=${SECRETS.meta})`, code: 100 } }, 400)
        : c.url.includes("api.linkedin.com")
          ? json({ message: `Bad request with Bearer ${SECRETS.li}` }, 400)
          : c.url.includes("/333/")
            ? json({ error: { message: `token ${SECRETS.ig} not allowed`, code: 100 } }, 400)
            : undefined;
    for (const [method, path, body] of ENDPOINTS) await call(method, path, "ADMIN", body);
    const r = await call("GET", "/api/automation/instagram/campaigns");
    expect(r.data.error).toContain("[redacted]");
  });

  it("no response body of this whole file, and no log line, ever contained a token", async () => {
    // Run every endpoint once more on the happy path, so success bodies are in the list too.
    for (const [method, path, body] of ENDPOINTS) await call(method, path, "ADMIN", body);
    expect(bodies.length).toBeGreaterThan(100);
    for (const s of Object.values(SECRETS)) {
      for (const b of bodies) expect(b).not.toContain(s);
      for (const l of logLines) expect(l).not.toContain(s);
    }
  });
});
