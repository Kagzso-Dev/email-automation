import crypto from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

// processMetaWebhook writes through Prisma and the status tracker; both are
// mocked so no DB connection is opened.
const applyWhatsAppStatusEvent = vi.fn();
const findContact = vi.fn();
const upsertInbound = vi.fn();

vi.mock("../src/domain/whatsappTracking.js", () => ({
  applyWhatsAppStatusEvent: (...a: unknown[]) => applyWhatsAppStatusEvent(...a),
}));
vi.mock("../src/prisma.js", () => ({
  prisma: {
    whatsAppContact: { findUnique: (...a: unknown[]) => findContact(...a) },
    whatsAppInboundMessage: { upsert: (...a: unknown[]) => upsertInbound(...a) },
  },
}));

const { isValidMetaSignature, verifyWebhookSubscription, parseInboundMessage, processMetaWebhook } = await import(
  "../src/domain/whatsappWebhook.js"
);

beforeEach(() => {
  applyWhatsAppStatusEvent.mockReset().mockResolvedValue(undefined);
  findContact.mockReset().mockResolvedValue(null);
  upsertInbound.mockReset().mockResolvedValue({});
});

const SECRET = "app-secret";
const sign = (body: string, secret = SECRET) =>
  "sha256=" + crypto.createHmac("sha256", secret).update(body).digest("hex");

describe("verifyWebhookSubscription", () => {
  const q = (token: string, mode = "subscribe") => ({
    "hub.mode": mode,
    "hub.verify_token": token,
    "hub.challenge": "1158201444",
  });

  it("returns the challenge when mode and token match", () => {
    expect(verifyWebhookSubscription(q("verify-me"), "verify-me")).toBe("1158201444");
  });

  it("rejects a wrong token", () => {
    expect(verifyWebhookSubscription(q("nope"), "verify-me")).toBeNull();
  });

  it("rejects a mode other than subscribe", () => {
    expect(verifyWebhookSubscription(q("verify-me", "unsubscribe"), "verify-me")).toBeNull();
  });

  it("rejects everything when no verify token is configured", () => {
    expect(verifyWebhookSubscription(q(""), undefined)).toBeNull();
  });
});

describe("isValidMetaSignature", () => {
  const body = JSON.stringify({ object: "whatsapp_business_account", entry: [] });

  it("accepts a correct sha256 HMAC of the raw body", () => {
    expect(isValidMetaSignature(Buffer.from(body), sign(body), SECRET)).toBe(true);
  });

  it("rejects a signature made with a different secret", () => {
    expect(isValidMetaSignature(Buffer.from(body), sign(body, "other"), SECRET)).toBe(false);
  });

  it("rejects a tampered body", () => {
    expect(isValidMetaSignature(Buffer.from(body.replace("[]", "[{}]")), sign(body), SECRET)).toBe(false);
  });

  it("rejects a missing or malformed header", () => {
    expect(isValidMetaSignature(Buffer.from(body), undefined, SECRET)).toBe(false);
    expect(isValidMetaSignature(Buffer.from(body), "sha1=abc", SECRET)).toBe(false);
  });
});

describe("parseInboundMessage", () => {
  it("parses a text message", () => {
    const p = parseInboundMessage(
      { id: "wamid.1", from: "919876543210", timestamp: "1700000000", type: "text", text: { body: "hi" } },
      "Ada",
    );
    expect(p).toMatchObject({
      providerMessageId: "wamid.1",
      phone: "919876543210",
      profileName: "Ada",
      messageType: "text",
      body: "hi",
      sentAt: new Date(1700000000 * 1000),
    });
  });

  it("parses an image with caption and media id", () => {
    const p = parseInboundMessage(
      { id: "w", from: "91", type: "image", image: { id: "MEDIA9", mime_type: "image/jpeg", caption: "pic" } },
      null,
    );
    expect(p).toMatchObject({ messageType: "image", mediaId: "MEDIA9", mediaMimeType: "image/jpeg", body: "pic" });
  });

  it("parses a template quick-reply button tap with its context", () => {
    const p = parseInboundMessage(
      {
        id: "w",
        from: "91",
        type: "button",
        context: { id: "wamid.OUR" },
        button: { text: "Interested", payload: "INTERESTED" },
      },
      null,
    );
    expect(p).toMatchObject({ body: "Interested", replyPayload: "INTERESTED", contextMessageId: "wamid.OUR" });
  });

  it("parses an interactive button reply", () => {
    const p = parseInboundMessage(
      { id: "w", from: "91", type: "interactive", interactive: { type: "button_reply", button_reply: { id: "no", title: "Not Interested" } } },
      null,
    );
    expect(p).toMatchObject({ body: "Not Interested", replyPayload: "no" });
  });
});

describe("processMetaWebhook", () => {
  const payload = (value: Record<string, unknown>) => ({
    object: "whatsapp_business_account",
    entry: [{ id: "WABA", changes: [{ field: "messages", value: { messaging_product: "whatsapp", metadata: { phone_number_id: "PNID" }, ...value } }] }],
  });

  it("applies sent / delivered / read statuses with Meta's timestamps", async () => {
    const res = await processMetaWebhook(
      payload({
        statuses: [
          { id: "wamid.A", status: "sent", timestamp: "1700000000", recipient_id: "91" },
          { id: "wamid.A", status: "delivered", timestamp: "1700000005", recipient_id: "91" },
          { id: "wamid.A", status: "read", timestamp: "1700000010", recipient_id: "91" },
        ],
      }),
      "PNID",
    );
    expect(res).toEqual({ statuses: 3, messages: 0, ignored: 0 });
    expect(applyWhatsAppStatusEvent.mock.calls.map((c) => c[0].status)).toEqual(["sent", "delivered", "read"]);
    expect(applyWhatsAppStatusEvent.mock.calls[2][0].timestamp).toEqual(new Date(1700000010 * 1000));
  });

  it("passes a failed status's error code and details through", async () => {
    await processMetaWebhook(
      payload({
        statuses: [
          {
            id: "wamid.F",
            status: "failed",
            timestamp: "1700000000",
            errors: [{ code: 131026, title: "Message undeliverable", error_data: { details: "Receiver incapable" } }],
          },
        ],
      }),
      "PNID",
    );
    expect(applyWhatsAppStatusEvent).toHaveBeenCalledWith(
      expect.objectContaining({ providerMessageId: "wamid.F", status: "failed", errorCode: "131026", errorMessage: "Receiver incapable" }),
    );
  });

  it("stores an inbound message idempotently, linked to a matching contact and profile name", async () => {
    findContact.mockResolvedValue({ id: "contact1" });
    const res = await processMetaWebhook(
      payload({
        contacts: [{ wa_id: "919876543210", profile: { name: "Ada" } }],
        messages: [{ id: "wamid.IN", from: "919876543210", timestamp: "1700000000", type: "text", text: { body: "hello" } }],
      }),
      "PNID",
    );
    expect(res.messages).toBe(1);
    const arg = upsertInbound.mock.calls[0][0];
    expect(arg.where).toEqual({ providerMessageId: "wamid.IN" });
    expect(arg.update).toEqual({});
    expect(arg.create).toMatchObject({ phone: "919876543210", profileName: "Ada", body: "hello", whatsappContactId: "contact1" });
  });

  it("ignores events for a different phone number id", async () => {
    const res = await processMetaWebhook(payload({ statuses: [{ id: "x", status: "read" }] }), "OTHER");
    expect(res).toEqual({ statuses: 0, messages: 0, ignored: 1 });
    expect(applyWhatsAppStatusEvent).not.toHaveBeenCalled();
  });

  it("ignores non-WhatsApp objects and non-message fields", async () => {
    expect((await processMetaWebhook({ object: "page", entry: [] }, "PNID")).ignored).toBe(1);
    const res = await processMetaWebhook(
      { object: "whatsapp_business_account", entry: [{ changes: [{ field: "account_update", value: {} }] }] },
      "PNID",
    );
    expect(res.ignored).toBe(1);
  });
});
