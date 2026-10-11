import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Meta media calls in services/whatsapp.ts with a mocked fetch (nothing leaves
// the machine): upload (multipart), media info, the authenticated, size-capped
// download with its host allow-list, and the template header component.

const getWhatsAppCredentials = vi.fn();
vi.mock("../src/domain/whatsappCredentials.js", () => ({
  getWhatsAppCredentials: (...a: unknown[]) => getWhatsAppCredentials(...a),
  isSendConfigured: (c: { provider: string; accessToken?: string; phoneNumberId?: string }) =>
    Boolean(c.provider === "meta" && c.accessToken && c.phoneNumberId),
}));

const { uploadMedia, getMediaInfo, downloadMedia, headerMediaComponent, WhatsAppSendError } = await import("../src/services/whatsapp.js");

const TOKEN = "EAAtest-token-1234567890";
beforeEach(() => {
  getWhatsAppCredentials.mockResolvedValue({
    provider: "meta",
    graphApiBaseUrl: "https://graph.facebook.com",
    graphApiVersion: "v24.0",
    accessToken: TOKEN,
    phoneNumberId: "1112223334",
    source: "environment",
  });
});
afterEach(() => vi.unstubAllGlobals());

const json = (body: unknown, status = 200) =>
  ({ ok: status < 400, status, statusText: "", json: async () => body, headers: new Headers() }) as unknown as Response;

function streamResponse(chunks: Uint8Array[], status = 200, contentLength?: number): Response {
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      for (const ch of chunks) c.enqueue(ch);
      c.close();
    },
  });
  const headers = new Headers(contentLength !== undefined ? { "content-length": String(contentLength) } : {});
  return new Response(status === 200 ? body : null, { status, headers });
}

describe("uploadMedia", () => {
  it("POSTs multipart to /{phone-number-id}/media with the token and returns the id", async () => {
    const fetchMock = vi.fn(async () => json({ id: "4490709327384033" }));
    vi.stubGlobal("fetch", fetchMock);
    const res = await uploadMedia({ data: Buffer.from("png-bytes"), mimeType: "image/png", filename: "banner.png" });
    expect(res).toEqual({ id: "4490709327384033" });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://graph.facebook.com/v24.0/1112223334/media");
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>).Authorization).toBe(`Bearer ${TOKEN}`);
    const form = init.body as FormData;
    expect(form.get("messaging_product")).toBe("whatsapp");
    expect(form.get("type")).toBe("image/png");
    expect((form.get("file") as File).name).toBe("banner.png");
  });

  it("Meta errors become WhatsAppSendError with the token redacted", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json({ error: { message: `bad ${TOKEN}`, code: 131053 } }, 400)));
    const err = await uploadMedia({ data: Buffer.from("x"), mimeType: "image/png", filename: "a.png" }).catch((e) => e);
    expect(err).toBeInstanceOf(WhatsAppSendError);
    expect(err.code).toBe("131053");
    expect(err.message).not.toContain(TOKEN);
  });
});

describe("getMediaInfo / downloadMedia", () => {
  it("getMediaInfo asks for the media with our phone number id", async () => {
    const fetchMock = vi.fn(async () => json({ id: "m1", url: "https://lookaside.fbsbx.com/whatsapp_business/attachments/?mid=m1", mime_type: "image/jpeg" }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(getMediaInfo("m1")).resolves.toMatchObject({ mime_type: "image/jpeg" });
    expect((fetchMock.mock.calls[0] as unknown as [string])[0]).toBe("https://graph.facebook.com/v24.0/m1?phone_number_id=1112223334");
  });

  it("downloads with the token and returns the bytes", async () => {
    const fetchMock = vi.fn(async () => streamResponse([new Uint8Array([1, 2, 3]), new Uint8Array([4])]));
    vi.stubGlobal("fetch", fetchMock);
    const buf = await downloadMedia("https://lookaside.fbsbx.com/x?mid=1", 100);
    expect([...buf]).toEqual([1, 2, 3, 4]);
    expect(((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].headers as Record<string, string>).Authorization).toBe(`Bearer ${TOKEN}`);
  });

  it("never sends the token to a host that isn't Meta's, or over http", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await expect(downloadMedia("https://evil.example.com/x", 100)).rejects.toThrow(/unexpected host/);
    await expect(downloadMedia("http://lookaside.fbsbx.com/x", 100)).rejects.toThrow(/unexpected host/);
    await expect(downloadMedia("not a url", 100)).rejects.toThrow(/invalid media URL/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("stops at the size limit (declared or streamed)", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => streamResponse([new Uint8Array(10)], 200, 10_000)));
    await expect(downloadMedia("https://lookaside.fbsbx.com/x", 100)).rejects.toMatchObject({ code: "too_large" });
    vi.stubGlobal("fetch", vi.fn(async () => streamResponse([new Uint8Array(60), new Uint8Array(60)])));
    await expect(downloadMedia("https://lookaside.fbsbx.com/x", 100)).rejects.toMatchObject({ code: "too_large" });
  });

  it("an expired URL (404) is retryable — the job asks Meta for a fresh one", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => streamResponse([], 404)));
    await expect(downloadMedia("https://lookaside.fbsbx.com/x", 100)).rejects.toMatchObject({ retryable: true, code: "404" });
  });
});

describe("headerMediaComponent", () => {
  it("builds image / video / document header parameters (filename only for documents)", () => {
    expect(headerMediaComponent("image", "m1")).toEqual({ type: "header", parameters: [{ type: "image", image: { id: "m1" } }] });
    expect(headerMediaComponent("video", "m2", "ignored.mp4")).toEqual({ type: "header", parameters: [{ type: "video", video: { id: "m2" } }] });
    expect(headerMediaComponent("document", "m3", "Brochure.pdf")).toEqual({
      type: "header",
      parameters: [{ type: "document", document: { id: "m3", filename: "Brochure.pdf" } }],
    });
  });
});
