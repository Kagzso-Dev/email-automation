import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import jwt from "jsonwebtoken";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { fake } from "./fakePrismaPlus.js";

// The import filter step's AI score (GET /api/import-filter/ai, POST /api/import-filter/ai-score): Data Quality's
// own scoring on rows that are not saved. Same prompt (only the name and business name), same answer parsing,
// same overall score and tier, same wait / stop rules as queue/dataQuality.ts. Nothing is written.
// The AI service is mocked (no network); Prisma is the in-memory fake.

vi.mock("../src/prisma.js", async () => ({ prisma: (await import("./fakePrismaPlus.js")).db }));
const ai = vi.hoisted(() => ({ prompts: [] as string[], answers: [] as (unknown | Error)[], health: { available: true, reason: null as string | null } }));
vi.mock("../src/services/dataQualityAi.js", async (orig) => {
  const real = await orig<typeof import("../src/services/dataQualityAi.js")>();
  return {
    ...real,
    checkAi: vi.fn(async (s: { provider: string; model: string | null }) => ({ provider: s.provider, configured: true, model: s.model, ...ai.health })),
    generateJson: vi.fn(async (prompt: string) => {
      ai.prompts.push(prompt);
      const next = ai.answers.shift() ?? { score: 50, issues: [] };
      if (next instanceof Error) throw next;
      return next;
    }),
  };
});

process.env.ENABLE_AI_CALLS = "true";
const originalFlag = process.env.ENABLE_IMPORT_FILTER_STEP;

let server: Server;
let base = "";
const token = (role: "ADMIN" | "EDITOR") => jwt.sign({ sub: `u-${role}`, email: `${role.toLowerCase()}@test`, role }, process.env.JWT_ACCESS_SECRET!);
const headers = { "Content-Type": "application/json", Authorization: `Bearer ${token("EDITOR")}` };
const score = (rows: unknown[]) => fetch(`${base}/api/import-filter/ai-score`, { method: "POST", headers, body: JSON.stringify({ rows }) });
const MODELS = ["contact", "whatsAppContact", "aiCallLog", "aiCallCustomer", "dataQualityJob", "dataQualityRecord", "aiCallRun"];
const WRITES = ["create", "upsert", "update", "updateMany", "delete", "deleteMany"] as const;
const writes = () =>
  MODELS.flatMap((m) => {
    const model = fake.model(m) as unknown as Record<string, { mock?: { calls: unknown[] } } | undefined>;
    return WRITES.filter((w) => (model[w]?.mock?.calls.length ?? 0) > 0).map((w) => `${m}.${w}`);
  });

beforeAll(async () => {
  const { createApp } = await import("../src/http/app.js");
  server = createApp().listen(0);
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  if (originalFlag === undefined) delete process.env.ENABLE_IMPORT_FILTER_STEP;
  else process.env.ENABLE_IMPORT_FILTER_STEP = originalFlag;
});
beforeEach(async () => {
  fake.reset();
  ai.prompts.length = 0;
  ai.answers.length = 0;
  ai.health = { available: true, reason: null };
  process.env.ENABLE_IMPORT_FILTER_STEP = "true";
  // A cloud service with no pause between rows (the real gap comes from DATA_QUALITY_AI_MIN_GAP_MS).
  const { dataQualityConfig } = await import("../src/config/dataQuality.js");
  (dataQualityConfig as { ai: unknown }).ai = { provider: "groq", origin: "https://api.groq.com", model: "llama-3.1-8b-instant", apiKey: "k", problem: null, timeoutMs: 60_000, minGapMs: 0 };
});

const RAVI = { name: "Ravi Kumar", business: "Ravi Traders", ruleScore: 80 };

describe("flag off", () => {
  it("both endpoints answer 404", async () => {
    process.env.ENABLE_IMPORT_FILTER_STEP = "false";
    expect((await fetch(`${base}/api/import-filter/ai`, { headers })).status).toBe(404);
    expect((await score([RAVI])).status).toBe(404);
    expect(ai.prompts).toEqual([]);
  });
});

describe("flag on", () => {
  it("GET /ai: the Data Quality service, its pace, and the batch size", async () => {
    const body = (await (await fetch(`${base}/api/import-filter/ai`, { headers })).json()) as any;
    expect(body).toMatchObject({ available: true, provider: "groq", label: "Groq", model: "llama-3.1-8b-instant", minGapMs: 0, maxFailures: 5, batchSize: 5, liveCalls: false });
    ai.health = { available: false, reason: "model gone" };
    expect(await (await fetch(`${base}/api/import-filter/ai`, { headers })).json()).toMatchObject({ available: false, reason: "model gone" });
  });

  it("scores with Data Quality's prompt, parsing, overall score and tier; only the name and business are sent; nothing saved", async () => {
    ai.answers.push({ score: 90, issues: [] }, { score: 20, issues: ["name looks like a placeholder"] });
    const res = await score([RAVI, { name: "test", business: null, ruleScore: 60 }]);
    expect(res.status).toBe(200);
    expect(((await res.json()) as any).results).toEqual([
      { aiState: "DONE", aiScore: 90, aiNotes: null, score: 85, tier: "HIGH_PRIORITY" }, // (80 + 90) / 2
      { aiState: "DONE", aiScore: 20, aiNotes: "name looks like a placeholder", score: 40, tier: "REJECT" },
    ]);
    const { aiPrompt } = await import("../src/domain/dataQuality.js");
    expect(ai.prompts[0]).toBe(aiPrompt({ name: "Ravi Kumar", businessName: "Ravi Traders" }));
    expect(writes()).toEqual([]);
  });

  it("refuses anything but name, business and rules score (no phone, no email), and more than 5 rows", async () => {
    expect((await score([{ ...RAVI, phone: "9876500101" }])).status).toBe(400);
    expect((await score([{ ...RAVI, email: "r@x.in" }])).status).toBe(400);
    expect((await score(Array.from({ length: 6 }, () => RAVI))).status).toBe(400);
    expect(ai.prompts).toEqual([]);
  });

  it("a failed row keeps its rules score and says why (as on Data Quality)", async () => {
    ai.answers.push(new Error("Groq 500: upstream"));
    const { results } = (await (await score([RAVI])).json()) as any;
    expect(results).toEqual([{ aiState: "ERROR", aiScore: null, aiNotes: "Groq 500: upstream", score: 80, tier: "GOOD" }]);
  });

  it("rate limited: the rows done so far, then wait and send the rest again", async () => {
    const { AiError } = await import("../src/services/dataQualityAi.js");
    ai.answers.push({ score: 70, issues: [] }, new AiError("Groq 429", 4000));
    const body = (await (await score([RAVI, RAVI, RAVI])).json()) as any;
    expect(body.results).toHaveLength(1);
    expect(body.wait).toEqual({ ms: 4000, reason: "Waiting: Groq rate limit, trying again shortly" });
  });

  it("key refused: stop scoring this file", async () => {
    const { AiError } = await import("../src/services/dataQualityAi.js");
    ai.answers.push(new AiError("Groq 401: invalid key", null, true));
    const body = (await (await score([RAVI, RAVI])).json()) as any;
    expect(body).toEqual({ results: [], stop: "Groq refused the key: Groq 401: invalid key" });
  });

  it("live AI calls running: nothing is scored, ask again in 30 s (the voice server stays fast)", async () => {
    fake.T("aiCallRun").push({ id: "run1", status: "RUNNING" });
    const body = (await (await score([RAVI])).json()) as any;
    expect(body).toEqual({ results: [], wait: { ms: 30_000, reason: "Paused automatically: live AI calls are running" } });
    expect(ai.prompts).toEqual([]);
  });

  it("a local Ollama is checked before each row; down = stop", async () => {
    const { dataQualityConfig } = await import("../src/config/dataQuality.js");
    (dataQualityConfig as { ai: unknown }).ai = { provider: "ollama", origin: "http://127.0.0.1:11434", model: "qwen2.5:3b", apiKey: null, problem: null, timeoutMs: 60_000, minGapMs: 0 };
    ai.health = { available: false, reason: "connection refused" };
    expect(await (await score([RAVI])).json()).toEqual({ results: [], stop: "Ollama not available: connection refused" });
  });
});

describe("one request stays short (nginx cuts long requests)", () => {
  it("no new row after 15 s: the rest is handed back", async () => {
    const { scoreDraftBatch } = await import("../src/domain/importFilterAi.js");
    let t = 0;
    const answer = await scoreDraftBatch([RAVI, RAVI, RAVI], {
      now: () => t,
      sleep: async () => undefined,
    });
    expect(answer.results).toHaveLength(3); // fast rows: all done
    ai.answers.push({ score: 90, issues: [] });
    const slow = await scoreDraftBatch([RAVI, RAVI, RAVI], {
      now: () => (t += 16_000), // every row "takes" 16 s
      sleep: async () => undefined,
    });
    expect(slow.results).toHaveLength(1);
    expect(slow.wait).toBeUndefined();
  });

  it("one row waits at most 45 s for the AI service in this step", async () => {
    const { dataQualityConfig } = await import("../src/config/dataQuality.js");
    (dataQualityConfig as { ai: { timeoutMs: number } }).ai.timeoutMs = 120_000;
    const { generateJson } = await import("../src/services/dataQualityAi.js");
    await score([RAVI]);
    expect((vi.mocked(generateJson).mock.calls.at(-1)![1] as { timeoutMs: number }).timeoutMs).toBe(45_000);
  });
});
