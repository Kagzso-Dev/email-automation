import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Prisma } from "@prisma/client";

// WhatsApp media end to end against an in-memory stand-in for Prisma and a
// mocked Meta API (nothing is sent): inbound media queued once per message,
// the download job (stored / expired / too large / wrong content / checksum /
// retries), template header media in batch sends, and Inbox replies (24-hour
// window, text, media with caption / filename rules, Meta failures).

process.env.WHATSAPP_MEDIA_DIR = mkdtempSync(join(tmpdir(), "wa-media-flow-"));

type Row = Record<string, any>;
let seq = 0;
const tables: Record<string, Row[]> = {};
const T = (name: string) => (tables[name] ??= []);
const KEYS: Record<string, string> = { whatsAppTemplateHeaderMedia: "templateId", whatsAppSendMedia: "sendId" };

function matches(row: Row, where: Row = {}): boolean {
  return Object.entries(where).every(([k, cond]) => {
    if (k === "OR") return (cond as Row[]).some((w) => matches(row, w));
    const v = row[k];
    if (cond !== null && typeof cond === "object" && !(cond instanceof Date)) {
      if ("in" in cond) return cond.in.includes(v);
      if ("not" in cond) return v !== cond.not;
      return true;
    }
    return (v instanceof Date && cond instanceof Date ? v.getTime() === cond.getTime() : (v ?? null) === cond);
  });
}
const DEFAULTS: Record<string, Row> = {
  whatsAppMedia: { status: "PENDING", attempts: 0, providerMediaId: null, providerMediaAt: null, storageKey: null, inboundMessageId: null, sha256: null, filename: null, mimeType: null, error: null },
  whatsAppSend: { status: "QUEUED", batchId: null, providerMessageId: null, error: null, sentAt: null },
};
function model(name: string) {
  const rows = () => T(name);
  const withInclude = (r: Row | undefined, args: Row) => {
    if (!r) return null;
    const out = { ...r };
    if (args?.include?.media) out.media = { ...T("whatsAppMedia").find((x) => x.id === r.mediaId) };
    if (args?.include?.template) out.template = { ...T("whatsAppTemplate").find((x) => x.id === r.templateId) };
    if (args?.include?.batch) out.batch = r.batchId ? { template: { name: "Batch template" } } : null;
    return out;
  };
  const pk = KEYS[name] ?? "id";
  return {
    create: async ({ data }: Row) => {
      if (name === "whatsAppMedia" && data.inboundMessageId && rows().some((r) => r.inboundMessageId === data.inboundMessageId)) {
        throw new Prisma.PrismaClientKnownRequestError("Unique", { code: "P2002", clientVersion: "test" });
      }
      const row = { ...(pk === "id" ? { id: `${name}-${++seq}` } : {}), createdAt: new Date(Date.now() + ++seq), ...DEFAULTS[name], ...data };
      rows().push(row);
      return { ...row };
    },
    findUnique: async (args: Row) => withInclude(rows().find((r) => matches(r, args.where)), args),
    findFirst: async (args: Row) => {
      const hits = rows().filter((r) => matches(r, args?.where));
      if (args?.orderBy?.sentAt === "desc") hits.sort((a, b) => b.sentAt - a.sentAt);
      if (args?.orderBy?.createdAt === "asc") hits.sort((a, b) => a.createdAt - b.createdAt);
      return withInclude(hits[0], args);
    },
    findMany: async (args: Row = {}) => rows().filter((r) => matches(r, args.where)).map((r) => withInclude(r, args)),
    count: async (args: Row = {}) => rows().filter((r) => matches(r, args.where)).length,
    update: async ({ where, data }: Row) => {
      const r = rows().find((x) => matches(x, where))!;
      Object.assign(r, data);
      return { ...r };
    },
    upsert: async ({ where, create, update }: Row) => {
      const r = rows().find((x) => matches(x, where));
      if (r) {
        Object.assign(r, update);
        return { ...r };
      }
      const row = { ...(pk === "id" ? { id: `${name}-${++seq}` } : {}), createdAt: new Date(), ...DEFAULTS[name], ...create };
      rows().push(row);
      return { ...row };
    },
    deleteMany: async ({ where }: Row) => {
      const keep = rows().filter((x) => !matches(x, where));
      const count = rows().length - keep.length;
      tables[name] = keep;
      return { count };
    },
  };
}
const db = new Proxy({} as Row, { get: (_t, p: string) => model(p) });
vi.mock("../src/prisma.js", () => ({ prisma: db }));

const enqueueWhatsAppMediaDownload = vi.fn(async () => "job");
vi.mock("../src/queue/queues.js", () => ({ enqueueWhatsAppMediaDownload }));
vi.mock("../src/domain/whatsappTracking.js", () => ({ applyWhatsAppStatusEvent: vi.fn() }));

/* eslint-disable @typescript-eslint/no-explicit-any */
const api = {
  uploadMedia: vi.fn(async (_input: any) => ({ id: "meta-media-1" })),
  getMediaInfo: vi.fn(async (_id: string): Promise<any> => ({})),
  downloadMedia: vi.fn(async (_url: string, _max: number): Promise<Buffer> => Buffer.alloc(0)),
  sendTemplateMessage: vi.fn(async (_input: any) => ({ providerMessageId: "wamid.T" })),
  sendMediaMessage: vi.fn(async (_input: any) => ({ providerMessageId: "wamid.M" })),
  sendTextMessage: vi.fn(async (_input: any) => ({ providerMessageId: "wamid.X" })),
};
vi.mock("../src/services/whatsapp.js", async (orig) => ({ ...(await orig<object>()), ...api }));

const { processMetaWebhook } = await import("../src/domain/whatsappWebhook.js");
const { processWhatsAppMediaDownload } = await import("../src/queue/whatsappMediaDownload.js");
const { processWhatsAppBulkSend } = await import("../src/queue/whatsappBulkSend.js");
const { setTemplateHeaderMedia, removeTemplateHeaderMedia } = await import("../src/domain/whatsappTemplateHeader.js");
const { sendReply, getConversation } = await import("../src/domain/whatsappInbox.js");
const { readMediaFile } = await import("../src/domain/whatsappMedia.js");
const { WhatsAppSendError } = await import("../src/services/whatsapp.js");

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64)]);
const PDF = Buffer.concat([Buffer.from("%PDF-1.7\n"), Buffer.alloc(64)]);
const MP4 = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from("ftypisom"), Buffer.alloc(64)]);
const OGG = Buffer.concat([Buffer.from("OggS"), Buffer.alloc(64)]);
const sha = async (b: Buffer) => (await import("node:crypto")).createHash("sha256").update(b).digest("hex");

const PHONE = "918838931463";
const webhook = (messages: Row[]) => ({
  object: "whatsapp_business_account",
  entry: [{ changes: [{ field: "messages", value: { metadata: { phone_number_id: "P1" }, contacts: [{ wa_id: PHONE, profile: { name: "Ragul" } }], messages } }] }],
});
const inMsg = (id: string, type: string, media: Row, ts = Math.floor(Date.now() / 1000)) => ({ id, from: PHONE, timestamp: String(ts), type, [type]: media });

beforeEach(() => {
  for (const k of Object.keys(tables)) delete tables[k];
  vi.clearAllMocks();
  api.uploadMedia.mockResolvedValue({ id: "meta-media-1" });
  // Inbound message upsert in the webhook: same fake, keyed by providerMessageId.
});

describe("inbound media (webhook)", () => {
  it("image, video, document and audio are each recorded once and queued for download", async () => {
    const payload = webhook([
      inMsg("wamid.1", "image", { id: "m-img", mime_type: "image/jpeg", caption: "Our shop", sha256: "abc" }),
      inMsg("wamid.2", "video", { id: "m-vid", mime_type: "video/mp4" }),
      inMsg("wamid.3", "document", { id: "m-doc", mime_type: "application/pdf", filename: "../quote.pdf" }),
      inMsg("wamid.4", "audio", { id: "m-aud", mime_type: "audio/ogg; codecs=opus", voice: true }),
      { id: "wamid.5", from: PHONE, timestamp: String(Math.floor(Date.now() / 1000)), type: "text", text: { body: "hi" } },
    ]);
    const r = await processMetaWebhook(payload as never, "P1");
    expect(r.messages).toBe(5);
    const media = T("whatsAppMedia");
    expect(media.map((m) => [m.kind, m.providerMediaId, m.mimeType, m.status])).toEqual([
      ["image", "m-img", "image/jpeg", "PENDING"],
      ["video", "m-vid", "video/mp4", "PENDING"],
      ["document", "m-doc", "application/pdf", "PENDING"],
      ["audio", "m-aud", "audio/ogg", "PENDING"],
    ]);
    expect(media[2]!.filename).toBe("quote.pdf"); // no path
    expect(enqueueWhatsAppMediaDownload).toHaveBeenCalledTimes(4);

    // Meta redelivers the same webhook: nothing new.
    await processMetaWebhook(payload as never, "P1");
    expect(T("whatsAppMedia")).toHaveLength(4);
    expect(T("whatsAppInboundMessage")).toHaveLength(5);
    expect(enqueueWhatsAppMediaDownload).toHaveBeenCalledTimes(4);
  });
});

describe("download job", () => {
  async function pending(over: Row = {}) {
    return db.whatsAppMedia.create({
      data: { purpose: "INBOUND", kind: "image", status: "PENDING", providerMediaId: "m-1", providerMediaAt: new Date(), mimeType: "image/png", inboundMessageId: `in-${++seq}`, ...over },
    });
  }

  it("stores the file privately with type, size and checksum", async () => {
    const m = await pending();
    api.getMediaInfo.mockResolvedValue({ id: "m-1", url: "https://lookaside.fbsbx.com/x", mime_type: "image/png", sha256: await sha(PNG), file_size: PNG.length });
    api.downloadMedia.mockResolvedValue(PNG);
    await processWhatsAppMediaDownload({ mediaId: m.id });
    const row = T("whatsAppMedia").find((x) => x.id === m.id)!;
    expect(row).toMatchObject({ status: "STORED", mimeType: "image/png", sizeBytes: PNG.length, sha256: await sha(PNG) });
    expect((await readMediaFile(row.storageKey)).equals(PNG)).toBe(true);
    // Already stored: a repeated job does nothing.
    await processWhatsAppMediaDownload({ mediaId: m.id });
    expect(api.getMediaInfo).toHaveBeenCalledTimes(1);
  });

  it("expired / missing media id → EXPIRED (no retry)", async () => {
    const m = await pending();
    api.getMediaInfo.mockRejectedValue(new WhatsAppSendError("Meta 400 (#100): Unsupported get request", false, "100"));
    await expect(processWhatsAppMediaDownload({ mediaId: m.id })).resolves.toMatchObject({ expired: expect.any(String) });
    expect(T("whatsAppMedia")[0]).toMatchObject({ status: "EXPIRED" });
  });

  it("older than Meta's 7-day window → EXPIRED without calling Meta", async () => {
    const m = await pending({ providerMediaAt: new Date(Date.now() - 8 * 24 * 3600_000) });
    await processWhatsAppMediaDownload({ mediaId: m.id });
    expect(T("whatsAppMedia")[0].status).toBe("EXPIRED");
    expect(api.getMediaInfo).not.toHaveBeenCalled();
  });

  it("too large → FAILED before downloading", async () => {
    const m = await pending();
    api.getMediaInfo.mockResolvedValue({ id: "m-1", url: "https://lookaside.fbsbx.com/x", file_size: 6 * 1024 * 1024 });
    await processWhatsAppMediaDownload({ mediaId: m.id });
    expect(T("whatsAppMedia")[0]).toMatchObject({ status: "FAILED", error: expect.stringMatching(/over the/) });
    expect(api.downloadMedia).not.toHaveBeenCalled();
  });

  it("content that isn't what the message declared → FAILED, nothing stored", async () => {
    const m = await pending();
    api.getMediaInfo.mockResolvedValue({ id: "m-1", url: "https://lookaside.fbsbx.com/x", mime_type: "image/png" });
    api.downloadMedia.mockResolvedValue(Buffer.concat([Buffer.from("MZ"), Buffer.alloc(64)]));
    await processWhatsAppMediaDownload({ mediaId: m.id });
    expect(T("whatsAppMedia")[0]).toMatchObject({ status: "FAILED", storageKey: null });
  });

  it("checksum mismatch → FAILED", async () => {
    const m = await pending();
    api.getMediaInfo.mockResolvedValue({ id: "m-1", url: "https://lookaside.fbsbx.com/x", mime_type: "image/png", sha256: "0".repeat(64) });
    api.downloadMedia.mockResolvedValue(PNG);
    await processWhatsAppMediaDownload({ mediaId: m.id });
    expect(T("whatsAppMedia")[0]).toMatchObject({ status: "FAILED", error: expect.stringMatching(/sha256/) });
  });

  it("transient errors are retried by the queue, then FAILED after 4 tries", async () => {
    const m = await pending();
    api.getMediaInfo.mockRejectedValue(new WhatsAppSendError("network error: ECONNRESET", true));
    for (let i = 0; i < 3; i++) await expect(processWhatsAppMediaDownload({ mediaId: m.id })).rejects.toThrow(/ECONNRESET/);
    await expect(processWhatsAppMediaDownload({ mediaId: m.id })).resolves.toMatchObject({ failed: expect.any(String) });
    expect(T("whatsAppMedia")[0]).toMatchObject({ status: "FAILED", attempts: 4 });
  });
});

describe("template header media", () => {
  async function batchWith(templateId: string) {
    T("whatsAppTemplate").push({ id: templateId, name: "Services Intro", providerTemplateName: "kagzso_services_intro", languageCode: "en" });
    T("whatsAppSendBatch").push({ id: `b-${templateId}`, templateId, status: "RUNNING", minDelaySec: 1, maxDelaySec: 1 });
    for (let i = 0; i < 2; i++) {
      T("whatsAppSend").push({ id: `s-${templateId}-${i}`, batchId: `b-${templateId}`, phone: PHONE, status: "QUEUED", contentVariables: { "1": "Ragul" }, createdAt: new Date(Date.now() + i) });
    }
  }

  it("image / video / document allowed; audio and stickers are not header media", async () => {
    T("whatsAppTemplate").push({ id: "t1" });
    await expect(setTemplateHeaderMedia("t1", { data: PNG, filename: "banner.png" }, "a@x")).resolves.toMatchObject({ kind: "image" });
    await expect(setTemplateHeaderMedia("t1", { data: MP4, filename: "demo.mp4" }, "a@x")).resolves.toMatchObject({ kind: "video" });
    await expect(setTemplateHeaderMedia("t1", { data: PDF, filename: "brochure.pdf" }, "a@x")).resolves.toMatchObject({ kind: "document" });
    await expect(setTemplateHeaderMedia("t1", { data: OGG, filename: "a.ogg" }, "a@x")).rejects.toThrow(/allowed here/);
    expect(T("whatsAppTemplateHeaderMedia")).toHaveLength(1); // replaced, not duplicated
    await expect(setTemplateHeaderMedia("missing", { data: PNG }, "a@x")).rejects.toThrow(/not found/);
  });

  it("batch sends put the header first, upload once and reuse the Meta media id", async () => {
    await batchWith("t2");
    await setTemplateHeaderMedia("t2", { data: PNG, filename: "banner.png" }, "a@x");
    await processWhatsAppBulkSend({ batchId: "b-t2" }).catch(() => undefined); // defers between items
    await processWhatsAppBulkSend({ batchId: "b-t2" }).catch(() => undefined);
    expect(api.uploadMedia).toHaveBeenCalledTimes(1);
    expect(api.sendTemplateMessage).toHaveBeenCalledTimes(2);
    expect(api.sendTemplateMessage.mock.calls[0]![0] as any).toEqual({
      to: PHONE,
      templateName: "kagzso_services_intro",
      languageCode: "en",
      components: [
        { type: "header", parameters: [{ type: "image", image: { id: "meta-media-1" } }] },
        { type: "body", parameters: [{ type: "text", text: "Ragul" }] },
      ],
    });
    expect(T("whatsAppSendMedia").map((r) => r.role)).toEqual(["header", "header"]);
  });

  it("document headers carry the filename; without header media the send is unchanged", async () => {
    await batchWith("t3");
    await setTemplateHeaderMedia("t3", { data: PDF, filename: "Kagzso brochure.pdf" }, "a@x");
    await processWhatsAppBulkSend({ batchId: "b-t3" }).catch(() => undefined);
    expect((api.sendTemplateMessage.mock.calls[0]![0] as any).components[0]).toEqual({
      type: "header",
      parameters: [{ type: "document", document: { id: "meta-media-1", filename: "Kagzso brochure.pdf" } }],
    });

    vi.clearAllMocks();
    await removeTemplateHeaderMedia("t3", "a@x");
    await processWhatsAppBulkSend({ batchId: "b-t3" }).catch(() => undefined);
    expect((api.sendTemplateMessage.mock.calls[0]![0] as any).components).toEqual([{ type: "body", parameters: [{ type: "text", text: "Ragul" }] }]);
    expect(api.uploadMedia).not.toHaveBeenCalled();
  });
});

describe("Inbox replies (24-hour window)", () => {
  const inbound = (hoursAgo: number) =>
    T("whatsAppInboundMessage").push({ id: `in-${++seq}`, phone: PHONE, sentAt: new Date(Date.now() - hoursAgo * 3600_000), messageType: "text", body: "hello", profileName: "Ragul" });

  it("refused when the customer never wrote or the window has closed", async () => {
    await expect(sendReply(PHONE, { text: "Hi" }, "a@x")).rejects.toMatchObject({ status: 409 });
    inbound(25);
    await expect(sendReply(PHONE, { text: "Hi" }, "a@x")).rejects.toThrow(/24-hour reply window has closed/);
    expect(api.sendTextMessage).not.toHaveBeenCalled();
  });

  it("text reply inside the window is sent and recorded", async () => {
    inbound(2);
    const msg = await sendReply(PHONE, { text: "Thanks, Ragul!" }, "a@x");
    expect(api.sendTextMessage).toHaveBeenCalledWith({ to: PHONE, body: "Thanks, Ragul!" });
    expect(msg).toMatchObject({ direction: "out", status: "SENT", text: "Thanks, Ragul!" });
    expect(T("whatsAppSend")[0]).toMatchObject({ providerMessageId: "wamid.X", status: "SENT", batchId: null });
  });

  it("media replies: caption for image/document, filename for documents, no caption on audio", async () => {
    inbound(1);
    await sendReply(PHONE, { text: "Our catalogue", file: { data: PDF, filename: "Catalogue.pdf", declaredMime: "application/pdf" } }, "a@x");
    expect(api.sendMediaMessage).toHaveBeenLastCalledWith({ to: PHONE, mediaType: "document", mediaId: "meta-media-1", caption: "Our catalogue", filename: "Catalogue.pdf" });
    await sendReply(PHONE, { text: "Look", file: { data: PNG, filename: "p.png" } }, "a@x");
    expect(api.sendMediaMessage).toHaveBeenLastCalledWith({ to: PHONE, mediaType: "image", mediaId: "meta-media-1", caption: "Look", filename: undefined });
    await expect(sendReply(PHONE, { text: "listen", file: { data: OGG, filename: "v.ogg" } }, "a@x")).rejects.toThrow(/can't have a caption/);
    await expect(sendReply(PHONE, { file: { data: Buffer.from("MZ\u0090\u0000"), filename: "x.pdf" } }, "a@x")).rejects.toMatchObject({ status: 400 });
    expect(T("whatsAppSendMedia").map((r) => r.role)).toEqual(["attachment", "attachment"]);
  });

  it("a Meta error is recorded on the message (FAILED), not thrown away", async () => {
    inbound(1);
    api.sendTextMessage.mockRejectedValueOnce(new WhatsAppSendError("Meta 400 (#131047): Re-engagement message", false, "131047"));
    const msg = await sendReply(PHONE, { text: "Hi" }, "a@x");
    expect(msg).toMatchObject({ status: "FAILED", error: expect.stringMatching(/131047/) });
    expect(T("whatsAppSend")[0]).toMatchObject({ status: "FAILED", errorCode: "131047" });
  });

  it("the conversation merges both directions with their media, oldest first", async () => {
    inbound(3);
    await sendReply(PHONE, { text: "Brochure", file: { data: PDF, filename: "b.pdf" } }, "a@x");
    const c = await getConversation(`+${PHONE}`);
    expect(c.windowOpen).toBe(true);
    expect(c.messages.map((m) => [m.direction, m.type])).toEqual([
      ["in", "text"],
      ["out", "document"],
    ]);
    expect(c.messages[1]!.media).toMatchObject({ kind: "document", filename: "b.pdf", status: "STORED" });
    expect(JSON.stringify(c)).not.toMatch(/storageKey|providerMediaId|\.whatsapp-media/);
  });
});
