import crypto from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { NextFunction, Request, Response } from "express";

// twilioSignatureRequired talks to two collaborators we don't want touched by
// a unit test: the DB-backed credential lookup and the WhatsApp config
// module's resolved callback URL.
const getWhatsAppCredentials = vi.fn();
const whatsappStatusCallbackUrl = vi.fn();

vi.mock("../src/domain/whatsappCredentials.js", () => ({
  getWhatsAppCredentials: (...args: unknown[]) => getWhatsAppCredentials(...args),
}));

vi.mock("../src/config/whatsapp.js", () => ({
  whatsappStatusCallbackUrl: (...args: unknown[]) => whatsappStatusCallbackUrl(...args),
}));

const { twilioSignatureRequired } = await import("../src/http/middleware/twilioSignature.js");
const { AppError } = await import("../src/http/errors.js");

const AUTH_TOKEN = "test-auth-token";
const CALLBACK_URL = "https://example.ngrok-free.dev/api/webhooks/whatsapp/status";

// Independent re-implementation of Twilio's request-validation algorithm
// (HMAC-SHA1 over the exact callback URL + sorted "key+value" form params,
// base64-encoded) — see https://www.twilio.com/docs/usage/security#validating-requests.
// Written separately from src/http/middleware/twilioSignature.ts so a real
// bug in that file's implementation wouldn't be masked by reusing it here.
function computeTwilioSignature(authToken: string, url: string, params: Record<string, string>): string {
  const data =
    url +
    Object.keys(params)
      .sort()
      .map((k) => `${k}${params[k]}`)
      .join("");
  return crypto.createHmac("sha1", authToken).update(Buffer.from(data, "utf-8")).digest("base64");
}

function makeReq(headers: Record<string, string>, body: Record<string, string>): Request {
  return { headers, body } as unknown as Request;
}

const res = {} as Response;

beforeEach(() => {
  getWhatsAppCredentials.mockReset().mockResolvedValue({ authToken: AUTH_TOKEN });
  whatsappStatusCallbackUrl.mockReset().mockReturnValue(CALLBACK_URL);
});

describe("twilioSignatureRequired", () => {
  it("allows the request through when the signature is valid", async () => {
    const body = { MessageSid: "SM123", MessageStatus: "delivered" };
    const signature = computeTwilioSignature(AUTH_TOKEN, CALLBACK_URL, body);
    const req = makeReq({ "x-twilio-signature": signature }, body);
    const next = vi.fn() as unknown as NextFunction;

    await twilioSignatureRequired(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(next).toHaveBeenCalledWith(); // called with no error
  });

  it("rejects a request with an invalid signature", async () => {
    const body = { MessageSid: "SM123", MessageStatus: "delivered" };
    // Same length as a real base64 SHA1 signature but the wrong value.
    const badSignature = Buffer.alloc(20, 1).toString("base64");
    const req = makeReq({ "x-twilio-signature": badSignature }, body);
    const next = vi.fn() as unknown as NextFunction;

    await twilioSignatureRequired(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    const err = (next as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(err).toBeInstanceOf(AppError);
    expect(err.status).toBe(401);
    expect(err.message).toBe("Invalid Twilio signature");
  });

  it("rejects a request with no signature header at all", async () => {
    const req = makeReq({}, { MessageSid: "SM123", MessageStatus: "delivered" });
    const next = vi.fn() as unknown as NextFunction;

    await twilioSignatureRequired(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    const err = (next as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(err).toBeInstanceOf(AppError);
    expect(err.status).toBe(401);
    expect(err.message).toBe("Missing Twilio signature");
  });

  it("rejects when WhatsApp has no auth token configured, without inspecting the signature", async () => {
    getWhatsAppCredentials.mockResolvedValue({ authToken: undefined });
    const req = makeReq({ "x-twilio-signature": "irrelevant" }, { MessageSid: "SM123" });
    const next = vi.fn() as unknown as NextFunction;

    await twilioSignatureRequired(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    const err = (next as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(err).toBeInstanceOf(AppError);
    expect(err.status).toBe(401);
    expect(err.message).toBe("WhatsApp is not configured");
  });

  it("validates against the exact resolved callback URL and body — a signature computed for a different URL is rejected", async () => {
    const body = { MessageSid: "SM123", MessageStatus: "delivered" };
    // Signed for a different (e.g. stale) callback URL than the one
    // whatsappStatusCallbackUrl() currently resolves to.
    const signature = computeTwilioSignature(AUTH_TOKEN, "https://stale.ngrok-free.dev/api/webhooks/whatsapp/status", body);
    const req = makeReq({ "x-twilio-signature": signature }, body);
    const next = vi.fn() as unknown as NextFunction;

    await twilioSignatureRequired(req, res, next);

    const err = (next as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(err).toBeInstanceOf(AppError);
    expect(err.status).toBe(401);
    expect(err.message).toBe("Invalid Twilio signature");
  });

  it("validates against the exact request body — a signature computed for different params is rejected", async () => {
    const signedBody = { MessageSid: "SM123", MessageStatus: "delivered" };
    const signature = computeTwilioSignature(AUTH_TOKEN, CALLBACK_URL, signedBody);
    // Same signature, but the actual request body was tampered with afterward.
    const tamperedBody = { MessageSid: "SM123", MessageStatus: "failed" };
    const req = makeReq({ "x-twilio-signature": signature }, tamperedBody);
    const next = vi.fn() as unknown as NextFunction;

    await twilioSignatureRequired(req, res, next);

    const err = (next as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(err).toBeInstanceOf(AppError);
    expect(err.status).toBe(401);
    expect(err.message).toBe("Invalid Twilio signature");
  });
});
