import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import jwt from "jsonwebtoken";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// POST /api/voices/preview ("Listen") with both call-flow flags on. A tiny fake voice
// backend answers /api/voices/preview; nothing is dialled and nothing reaches the database.

let server: Server;
let voice: Server;
let base = "";
const voiceRequests: { path: string; body: { voice_id: string; text: string; pauses?: unknown; pace?: number }; key: string | undefined }[] = [];
const WAV = Buffer.from("RIFF....WAVEfmt fake-audio");
// A cloned voice the fake backend offers (SARVAM_TTS_VOICE_TA_FEMALE on a real one); any other svc- id is not offered.
const CLONE = "svc-4423e42f-2517-40a5-979c-15bc1d502017";
const OFFERED = ["roopa", "ritu", "simran", "ishita", CLONE];
const token = (role: "ADMIN" | "EDITOR") =>
  jwt.sign({ sub: `u-${role}`, email: `${role.toLowerCase()}@test`, role }, process.env.JWT_ACCESS_SECRET!);

beforeAll(async () => {
  voice = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const body = raw ? JSON.parse(raw) : null;
      voiceRequests.push({ path: req.url!, body, key: req.headers["x-api-key"] as string });
      if (req.url === "/api/voices/preview" && OFFERED.includes(body?.voice_id)) {
        res.setHeader("Content-Type", "audio/wav");
        res.end(WAV);
      } else {
        res.statusCode = 422;
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ detail: `Unknown voice - choose one of: ${OFFERED.join(", ")}` }));
      }
    });
  }).listen(0);
  process.env.ENABLE_AI_CALLS = "true";
  process.env.ENABLE_CALL_FLOW_EDITOR = "true";
  process.env.VOICE_BACKEND_URL = `http://127.0.0.1:${(voice.address() as AddressInfo).port}`;
  process.env.VOICE_BACKEND_URL_TA = process.env.VOICE_BACKEND_URL; // the Tamil backend (/ta/ai-agents Listen): the same fake
  process.env.VOICE_BACKEND_API_KEY = "voice-key-0123456789";
  const { createApp } = await import("../src/http/app.js");
  server = createApp().listen(0);
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  await new Promise<void>((r) => voice.close(() => r()));
});

const preview = (body: unknown, role?: "ADMIN" | "EDITOR") =>
  fetch(`${base}/api/voices/preview`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(role ? { Authorization: `Bearer ${token(role)}` } : {}) },
    body: JSON.stringify(body),
  });

describe("POST /api/voices/preview", () => {
  it("requires sign-in", async () => {
    expect((await preview({ voice_id: "roopa", text: "Hi" })).status).toBe(401);
  });

  it("returns the voice backend's WAV, sending the API key server-side only", async () => {
    const res = await preview({ voice_id: "Ritu", text: "  Hi,   is this Ragul?  " }, "EDITOR");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/audio\/wav/);
    expect(Buffer.from(await res.arrayBuffer())).toEqual(WAV);
    const sent = voiceRequests.at(-1)!;
    expect(sent).toEqual({ path: "/api/voices/preview", body: { voice_id: "ritu", text: "Hi, is this Ragul?" }, key: "voice-key-0123456789" });
  });

  it("caches per voice + text: a repeat click doesn't reach the provider again", async () => {
    const before = voiceRequests.length;
    expect((await preview({ voice_id: "simran", text: "Hello there" }, "ADMIN")).status).toBe(200);
    expect((await preview({ voice_id: "simran", text: "Hello there" }, "ADMIN")).status).toBe(200);
    expect(voiceRequests.length).toBe(before + 1);
    expect((await preview({ voice_id: "simran", text: "Hello again" }, "ADMIN")).status).toBe(200);
    expect(voiceRequests.length).toBe(before + 2);
  });

  it("refuses removed voices (the voice backend's list) and bad text", async () => {
    const gone = await preview({ voice_id: "tanya", text: "Hi" }, "ADMIN");
    expect(gone.status).toBe(400);
    expect(((await gone.json()) as { error: string }).error).toMatch(/roopa, ritu, simran, ishita/);
    expect((await preview({ voice_id: "roopa", text: "x".repeat(201) }, "ADMIN")).status).toBe(400);
    expect((await preview({ voice_id: "roopa", text: "   " }, "ADMIN")).status).toBe(400);
  });

  it("plays a cloned voice (svc-...) the voice backend offers, in its language, at the agent's speed", async () => {
    // Was "Validation failed": the id's form allowed only stock names (no "-"), so a clone never reached the backend.
    const text = "வணக்கம் சார், நான் ராகுல் சார் கிட்ட பேசுறேனா?";
    const res = await preview({ voice_id: ` ${CLONE.toUpperCase()} `, text, language: "ta", pace: 0.9 }, "EDITOR");
    expect(res.status).toBe(200);
    expect(Buffer.from(await res.arrayBuffer())).toEqual(WAV);
    expect(voiceRequests.at(-1)!.body).toEqual({ voice_id: CLONE, text, pace: 0.9 });
  });

  it("only the backend's configured voices play: another svc- id is refused by its list, a malformed id never leaves Dispatch", async () => {
    const unknown = await preview({ voice_id: "svc-f7040b2c-0000-0000-0000-000000000000", text: "Hi" }, "EDITOR");
    expect(unknown.status).toBe(400);
    expect(((await unknown.json()) as { error: string }).error).toMatch(/choose one of: roopa, ritu, simran, ishita, svc-4423e42f/);
    const before = voiceRequests.length;
    for (const bad of ["svc-", "svc-4423e42f 2517", "svc-../../etc", "svc-4423e42f_2517", "-svc-4423", `svc-${"a".repeat(61)}`, "4423e42f-2517"]) {
      const res = await preview({ voice_id: bad, text: "Hi" }, "EDITOR"); // EDITOR: ADMIN has the other tests' previews (20 a minute)
      expect([bad, res.status]).toEqual([bad, 400]);
      expect(((await res.json()) as { details: { fieldErrors: Record<string, string[]> } }).details.fieldErrors.voice_id).toEqual(["Choose a voice"]);
    }
    expect(voiceRequests.length).toBe(before); // none reached the voice backend
  });

  it("forwards an AI Agent's voice speed, keys the cache on it and validates it", async () => {
    const text = "Hello, this is a sample of the speed.";
    const before = voiceRequests.length;
    expect((await preview({ voice_id: "roopa", text, pace: 1.37 }, "ADMIN")).status).toBe(200); // a typed speed
    expect(voiceRequests.at(-1)!.body).toEqual({ voice_id: "roopa", text, pace: 1.37 });
    expect((await preview({ voice_id: "roopa", text, pace: 1.37 }, "ADMIN")).status).toBe(200); // cached
    expect((await preview({ voice_id: "roopa", text, pace: 0.5 }, "ADMIN")).status).toBe(200); // the slowest
    expect(voiceRequests.at(-1)!.body).toEqual({ voice_id: "roopa", text, pace: 0.5 });
    expect((await preview({ voice_id: "roopa", text }, "ADMIN")).status).toBe(200);
    expect(voiceRequests.length - before).toBe(3); // another speed = other audio
    expect(voiceRequests.at(-1)!.body).toEqual({ voice_id: "roopa", text }); // no speed: sent exactly as before
    for (const bad of [0.4, 2.1, "fast"]) {
      expect((await preview({ voice_id: "roopa", text, pace: bad }, "ADMIN")).status).toBe(400);
    }
  });

  it("forwards the flow's pause lengths, keys the cache on them and validates them", async () => {
    const text = "Hi sir, {{short_delay}} Good afternoon.";
    const pauses = { short_ms: 500, medium_ms: 700, long_ms: 1200 };
    const before = voiceRequests.length;
    expect((await preview({ voice_id: "roopa", text, pauses }, "ADMIN")).status).toBe(200);
    expect(voiceRequests.at(-1)!.body).toEqual({ voice_id: "roopa", text, pauses });
    expect((await preview({ voice_id: "roopa", text, pauses }, "ADMIN")).status).toBe(200); // cached
    expect((await preview({ voice_id: "roopa", text, pauses: { ...pauses, short_ms: 900 } }, "ADMIN")).status).toBe(200);
    expect(voiceRequests.length - before).toBe(2); // other lengths = other audio
    for (const bad of [{ ...pauses, short_ms: 3001 }, { ...pauses, long_ms: -1 }, { ...pauses, medium_ms: 1.5 }]) {
      expect((await preview({ voice_id: "roopa", text, pauses: bad }, "ADMIN")).status).toBe(400);
    }
  });
});
