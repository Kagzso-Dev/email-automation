import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// services/whatsapp.ts talks to two collaborators we don't want touched by a
// unit test: the DB-backed credential lookup and the WhatsApp config module.
// Both are mocked so no real network/DB call is ever made here.
const getWhatsAppCredentials = vi.fn();
const whatsappStatusCallbackUrl = vi.fn();

vi.mock("../src/domain/whatsappCredentials.js", () => ({
  getWhatsAppCredentials: (...args: unknown[]) => getWhatsAppCredentials(...args),
}));

vi.mock("../src/config/whatsapp.js", () => ({
  whatsappStatusCallbackUrl: (...args: unknown[]) => whatsappStatusCallbackUrl(...args),
}));

const { sendWhatsAppTemplate, WhatsAppSendError, WhatsAppNotConfiguredError } = await import(
  "../src/services/whatsapp.js"
);

const DEFAULT_CREDS = {
  apiUrl: "https://api.twilio.com/2010-04-01",
  accountSid: "AC0000000000000000000000000000000",
  authToken: "test-auth-token",
  from: "whatsapp:+15550001111",
  source: "environment" as const,
};

const STATUS_CALLBACK_URL = "https://example.ngrok-free.dev/api/webhooks/whatsapp/status";

function fakeResponse(
  body: unknown,
  init: { ok: boolean; status: number; statusText?: string },
): Response {
  return {
    ok: init.ok,
    status: init.status,
    statusText: init.statusText ?? "",
    json: async () => body,
  } as Response;
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  getWhatsAppCredentials.mockReset().mockResolvedValue(DEFAULT_CREDS);
  whatsappStatusCallbackUrl.mockReset().mockReturnValue(STATUS_CALLBACK_URL);
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("sendWhatsAppTemplate", () => {
  it("returns the Twilio message SID on a successful send", async () => {
    fetchMock.mockResolvedValue(fakeResponse({ sid: "SM123", status: "queued" }, { ok: true, status: 201 }));

    const result = await sendWhatsAppTemplate({
      to: "+19995551234",
      contentSid: "HXabc",
      contentVariables: { "1": "Ada" },
    });

    expect(result).toEqual({ providerMessageId: "SM123" });
  });

  it("POSTs to the correct Twilio Messages endpoint for the configured account", async () => {
    fetchMock.mockResolvedValue(fakeResponse({ sid: "SM123" }, { ok: true, status: 201 }));

    await sendWhatsAppTemplate({ to: "+19995551234", contentSid: "HXabc", contentVariables: {} });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, options] = fetchMock.mock.calls[0];
    expect(url).toBe(
      "https://api.twilio.com/2010-04-01/Accounts/AC0000000000000000000000000000000/Messages.json",
    );
    expect(options.method).toBe("POST");
  });

  it("authenticates with HTTP Basic auth built from the account SID and auth token", async () => {
    fetchMock.mockResolvedValue(fakeResponse({ sid: "SM123" }, { ok: true, status: 201 }));

    await sendWhatsAppTemplate({ to: "+19995551234", contentSid: "HXabc", contentVariables: {} });

    const [, options] = fetchMock.mock.calls[0];
    const expectedAuth = `Basic ${Buffer.from(
      `${DEFAULT_CREDS.accountSid}:${DEFAULT_CREDS.authToken}`,
    ).toString("base64")}`;
    expect(options.headers.Authorization).toBe(expectedAuth);
    expect(options.headers["Content-Type"]).toBe("application/x-www-form-urlencoded");
  });

  it("sends whatsapp: From/To addresses, the template payload, and the resolved StatusCallback", async () => {
    fetchMock.mockResolvedValue(fakeResponse({ sid: "SM123" }, { ok: true, status: 201 }));

    await sendWhatsAppTemplate({
      to: "+19995551234",
      contentSid: "HXabc",
      contentVariables: { "1": "Ada", "2": "Acme" },
    });

    const [, options] = fetchMock.mock.calls[0];
    const body = options.body as URLSearchParams;
    expect(body.get("From")).toBe("whatsapp:+15550001111");
    expect(body.get("To")).toBe("whatsapp:+19995551234");
    expect(body.get("ContentSid")).toBe("HXabc");
    expect(body.get("ContentVariables")).toBe(JSON.stringify({ "1": "Ada", "2": "Acme" }));
    expect(body.get("StatusCallback")).toBe(STATUS_CALLBACK_URL);
  });

  it("accepts an already whatsapp:-prefixed `to` address unchanged", async () => {
    fetchMock.mockResolvedValue(fakeResponse({ sid: "SM123" }, { ok: true, status: 201 }));

    await sendWhatsAppTemplate({
      to: "whatsapp:+19995551234",
      contentSid: "HXabc",
      contentVariables: {},
    });

    const [, options] = fetchMock.mock.calls[0];
    const body = options.body as URLSearchParams;
    expect(body.get("To")).toBe("whatsapp:+19995551234");
  });

  it("omits StatusCallback entirely when no public base URL is configured", async () => {
    whatsappStatusCallbackUrl.mockReturnValue(undefined);
    fetchMock.mockResolvedValue(fakeResponse({ sid: "SM123" }, { ok: true, status: 201 }));

    await sendWhatsAppTemplate({ to: "+19995551234", contentSid: "HXabc", contentVariables: {} });

    const [, options] = fetchMock.mock.calls[0];
    const body = options.body as URLSearchParams;
    expect(body.has("StatusCallback")).toBe(false);
  });

  it("throws a non-retryable WhatsAppSendError on a Twilio 4xx response (e.g. the 21609 regression)", async () => {
    fetchMock.mockResolvedValue(
      fakeResponse(
        { code: 21609, message: "The StatusCallback URL ... is not a valid URL." },
        { ok: false, status: 400 },
      ),
    );

    let caught: unknown;
    try {
      await sendWhatsAppTemplate({ to: "+19995551234", contentSid: "HXabc", contentVariables: {} });
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(WhatsAppSendError);
    expect((caught as InstanceType<typeof WhatsAppSendError>).retryable).toBe(false);
    expect((caught as Error).message).toContain("Twilio 400");
  });

  it("throws a retryable WhatsAppSendError on a Twilio 5xx response", async () => {
    fetchMock.mockResolvedValue(fakeResponse({ message: "Internal error" }, { ok: false, status: 500 }));

    let caught: unknown;
    try {
      await sendWhatsAppTemplate({ to: "+19995551234", contentSid: "HXabc", contentVariables: {} });
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(WhatsAppSendError);
    expect((caught as InstanceType<typeof WhatsAppSendError>).retryable).toBe(true);
  });

  it("treats a 429 rate-limit response as retryable", async () => {
    fetchMock.mockResolvedValue(fakeResponse({ message: "Too many requests" }, { ok: false, status: 429 }));

    let caught: unknown;
    try {
      await sendWhatsAppTemplate({ to: "+19995551234", contentSid: "HXabc", contentVariables: {} });
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(WhatsAppSendError);
    expect((caught as InstanceType<typeof WhatsAppSendError>).retryable).toBe(true);
  });

  it("wraps a network/fetch failure in a retryable WhatsAppSendError", async () => {
    fetchMock.mockRejectedValue(new Error("ECONNRESET"));

    let caught: unknown;
    try {
      await sendWhatsAppTemplate({ to: "+19995551234", contentSid: "HXabc", contentVariables: {} });
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(WhatsAppSendError);
    expect((caught as InstanceType<typeof WhatsAppSendError>).retryable).toBe(true);
    expect((caught as Error).message).toContain("ECONNRESET");
  });

  it("throws WhatsAppNotConfiguredError without calling fetch when credentials are incomplete", async () => {
    getWhatsAppCredentials.mockResolvedValue({ ...DEFAULT_CREDS, authToken: undefined });

    await expect(
      sendWhatsAppTemplate({ to: "+19995551234", contentSid: "HXabc", contentVariables: {} }),
    ).rejects.toBeInstanceOf(WhatsAppNotConfiguredError);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
