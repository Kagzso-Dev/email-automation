import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// services/whatsapp.ts reads credentials through the DB-backed lookup; mock it
// so no real network/DB call is ever made here. isSendConfigured is the real
// implementation's logic, reproduced so the mock stays honest.
const getWhatsAppCredentials = vi.fn();

vi.mock("../src/domain/whatsappCredentials.js", () => ({
  getWhatsAppCredentials: (...args: unknown[]) => getWhatsAppCredentials(...args),
  isSendConfigured: (c: { provider: string; accessToken?: string; phoneNumberId?: string }) =>
    Boolean(c.provider === "meta" && c.accessToken && c.phoneNumberId),
}));

const {
  sendTemplateMessage,
  sendTextMessage,
  sendMediaMessage,
  getPhoneNumberInfo,
  bodyComponentsFromVariables,
  WhatsAppSendError,
  WhatsAppNotConfiguredError,
} = await import("../src/services/whatsapp.js");

const DEFAULT_CREDS = {
  provider: "meta",
  graphApiBaseUrl: "https://graph.facebook.com",
  graphApiVersion: "v24.0",
  accessToken: "EAAtest-token",
  phoneNumberId: "1112223334",
  source: "environment" as const,
};

const MESSAGES_URL = "https://graph.facebook.com/v24.0/1112223334/messages";

function fakeResponse(body: unknown, init: { ok: boolean; status: number; statusText?: string }): Response {
  return {
    ok: init.ok,
    status: init.status,
    statusText: init.statusText ?? "",
    json: async () => body,
  } as Response;
}

const accepted = () =>
  fakeResponse(
    { messaging_product: "whatsapp", contacts: [{ input: "919876543210", wa_id: "919876543210" }], messages: [{ id: "wamid.ABC" }] },
    { ok: true, status: 200 },
  );

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  getWhatsAppCredentials.mockReset().mockResolvedValue(DEFAULT_CREDS);
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function sentBody(): Record<string, unknown> {
  const [, options] = fetchMock.mock.calls[0];
  return JSON.parse(options.body as string);
}

async function caught(p: Promise<unknown>): Promise<InstanceType<typeof WhatsAppSendError>> {
  try {
    await p;
  } catch (err) {
    return err as InstanceType<typeof WhatsAppSendError>;
  }
  throw new Error("expected a rejection");
}

describe("sendTemplateMessage", () => {
  it("returns Meta's message id on success", async () => {
    fetchMock.mockResolvedValue(accepted());
    const result = await sendTemplateMessage({ to: "+91 98765 43210", templateName: "greet", languageCode: "en" });
    expect(result).toEqual({ providerMessageId: "wamid.ABC" });
  });

  it("POSTs JSON to /{phone-number-id}/messages with a Bearer token", async () => {
    fetchMock.mockResolvedValue(accepted());
    await sendTemplateMessage({ to: "919876543210", templateName: "greet", languageCode: "en" });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, options] = fetchMock.mock.calls[0];
    expect(url).toBe(MESSAGES_URL);
    expect(options.method).toBe("POST");
    expect(options.headers.Authorization).toBe("Bearer EAAtest-token");
    expect(options.headers["Content-Type"]).toBe("application/json");
  });

  it("sends the template name, language, digits-only recipient and body params", async () => {
    fetchMock.mockResolvedValue(accepted());
    await sendTemplateMessage({
      to: "+91 98765-43210",
      templateName: "kagzso_greeting",
      languageCode: "en_US",
      components: bodyComponentsFromVariables({ "2": "Acme", "1": "Ada" }),
    });

    expect(sentBody()).toEqual({
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to: "919876543210",
      type: "template",
      template: {
        name: "kagzso_greeting",
        language: { code: "en_US" },
        components: [
          {
            type: "body",
            parameters: [
              { type: "text", text: "Ada" },
              { type: "text", text: "Acme" },
            ],
          },
        ],
      },
    });
  });

  it("omits components when the template has no variables", async () => {
    fetchMock.mockResolvedValue(accepted());
    await sendTemplateMessage({
      to: "919876543210",
      templateName: "hello_world",
      languageCode: "en_US",
      components: bodyComponentsFromVariables({}),
    });
    expect((sentBody().template as Record<string, unknown>).components).toBeUndefined();
  });

  it("throws a non-retryable error carrying Meta's code on a 4xx (e.g. template not found)", async () => {
    fetchMock.mockResolvedValue(
      fakeResponse(
        {
          error: {
            message: "(#132001) Template name does not exist in the translation",
            type: "OAuthException",
            code: 132001,
            error_data: { details: "template name (greet) does not exist in en" },
          },
        },
        { ok: false, status: 400 },
      ),
    );
    const err = await caught(sendTemplateMessage({ to: "919876543210", templateName: "greet", languageCode: "en" }));
    expect(err).toBeInstanceOf(WhatsAppSendError);
    expect(err.retryable).toBe(false);
    expect(err.code).toBe("132001");
    expect(err.message).toContain("Meta 400 (#132001)");
    expect(err.message).toContain("does not exist in en");
  });

  it("keeps Meta's subcode and fbtrace_id for the Send Queue, never the token", async () => {
    fetchMock.mockResolvedValue(
      fakeResponse(
        {
          error: {
            message: "(#200) You do not have the necessary permissions to send messages on behalf of this WhatsApp Business Account",
            type: "OAuthException",
            code: 200,
            error_subcode: 2494102,
            fbtrace_id: "AbC123xyz",
          },
        },
        { ok: false, status: 403 },
      ),
    );
    const err = await caught(sendTemplateMessage({ to: "919876543210", templateName: "g", languageCode: "en" }));
    expect(err.retryable).toBe(false);
    expect(err.code).toBe("200");
    expect(err.subcode).toBe("2494102");
    expect(err.fbtraceId).toBe("AbC123xyz");
    expect(err.message).toContain("Meta 403 (#200)");
    expect(err.message).toContain("[subcode 2494102, fbtrace_id AbC123xyz]");
    expect(err.message).not.toContain(DEFAULT_CREDS.accessToken);
  });

  it("redacts the access token if it ever appears in Meta's error text", async () => {
    fetchMock.mockResolvedValue(
      fakeResponse({ error: { message: `bad token ${DEFAULT_CREDS.accessToken}`, code: 190 } }, { ok: false, status: 401 }),
    );
    const err = await caught(sendTemplateMessage({ to: "919876543210", templateName: "g", languageCode: "en" }));
    expect(err.message).not.toContain(DEFAULT_CREDS.accessToken);
    expect(err.message).toContain("[redacted]");
  });

  it("treats Meta's throughput/rate-limit codes as retryable even on a 400", async () => {
    fetchMock.mockResolvedValue(
      fakeResponse({ error: { message: "Rate limit hit", code: 130429 } }, { ok: false, status: 400 }),
    );
    const err = await caught(sendTemplateMessage({ to: "919876543210", templateName: "g", languageCode: "en" }));
    expect(err.retryable).toBe(true);
  });

  it("treats 5xx and 429 responses as retryable", async () => {
    fetchMock.mockResolvedValueOnce(fakeResponse({ error: { message: "oops" } }, { ok: false, status: 500 }));
    expect((await caught(sendTemplateMessage({ to: "91", templateName: "g", languageCode: "en" }))).retryable).toBe(true);
    fetchMock.mockResolvedValueOnce(fakeResponse({}, { ok: false, status: 429 }));
    expect((await caught(sendTemplateMessage({ to: "91", templateName: "g", languageCode: "en" }))).retryable).toBe(true);
  });

  it("wraps a network failure in a retryable WhatsAppSendError", async () => {
    fetchMock.mockRejectedValue(new Error("ECONNRESET"));
    const err = await caught(sendTemplateMessage({ to: "919876543210", templateName: "g", languageCode: "en" }));
    expect(err.retryable).toBe(true);
    expect(err.message).toContain("ECONNRESET");
  });

  it("fails when Meta returns 200 without a message id", async () => {
    fetchMock.mockResolvedValue(fakeResponse({ messages: [] }, { ok: true, status: 200 }));
    const err = await caught(sendTemplateMessage({ to: "919876543210", templateName: "g", languageCode: "en" }));
    expect(err.retryable).toBe(false);
  });

  it("throws WhatsAppNotConfiguredError without calling fetch when credentials are incomplete", async () => {
    getWhatsAppCredentials.mockResolvedValue({ ...DEFAULT_CREDS, accessToken: undefined });
    await expect(
      sendTemplateMessage({ to: "919876543210", templateName: "g", languageCode: "en" }),
    ).rejects.toBeInstanceOf(WhatsAppNotConfiguredError);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("sendTextMessage", () => {
  it("sends a text message body", async () => {
    fetchMock.mockResolvedValue(accepted());
    await sendTextMessage({ to: "919876543210", body: "hello" });
    expect(sentBody()).toMatchObject({ type: "text", text: { body: "hello", preview_url: false } });
  });
});

describe("sendMediaMessage", () => {
  it("sends an image by media id with a caption", async () => {
    fetchMock.mockResolvedValue(accepted());
    await sendMediaMessage({ to: "919876543210", mediaType: "image", mediaId: "MEDIA1", caption: "look" });
    expect(sentBody()).toMatchObject({ type: "image", image: { id: "MEDIA1", caption: "look" } });
  });

  it("sends a document by link with a filename", async () => {
    fetchMock.mockResolvedValue(accepted());
    await sendMediaMessage({
      to: "919876543210",
      mediaType: "document",
      link: "https://example.com/a.pdf",
      filename: "a.pdf",
    });
    expect(sentBody()).toMatchObject({
      type: "document",
      document: { link: "https://example.com/a.pdf", filename: "a.pdf" },
    });
  });

  it("drops a caption on media types that don't support one", async () => {
    fetchMock.mockResolvedValue(accepted());
    await sendMediaMessage({ to: "919876543210", mediaType: "audio", mediaId: "M", caption: "x" });
    expect(sentBody()).toMatchObject({ type: "audio", audio: { id: "M" } });
    expect((sentBody().audio as Record<string, unknown>).caption).toBeUndefined();
  });

  it("requires exactly one of mediaId or link", async () => {
    await expect(sendMediaMessage({ to: "91", mediaType: "image" })).rejects.toBeInstanceOf(WhatsAppSendError);
    await expect(
      sendMediaMessage({ to: "91", mediaType: "image", mediaId: "a", link: "https://x" }),
    ).rejects.toBeInstanceOf(WhatsAppSendError);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("getPhoneNumberInfo", () => {
  it("GETs the phone number node and maps its fields", async () => {
    fetchMock.mockResolvedValue(
      fakeResponse(
        { id: "1112223334", display_phone_number: "+1 555-475-4546", verified_name: "Kagzso", quality_rating: "GREEN" },
        { ok: true, status: 200 },
      ),
    );
    const info = await getPhoneNumberInfo();
    const [url, options] = fetchMock.mock.calls[0];
    expect(url).toBe(
      "https://graph.facebook.com/v24.0/1112223334?fields=display_phone_number,verified_name,quality_rating",
    );
    expect(options.method).toBe("GET");
    expect(options.body).toBeUndefined();
    expect(info).toEqual({
      id: "1112223334",
      displayPhoneNumber: "+1 555-475-4546",
      verifiedName: "Kagzso",
      qualityRating: "GREEN",
    });
  });
});
