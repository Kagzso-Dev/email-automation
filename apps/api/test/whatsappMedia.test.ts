import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

// Pure media rules: content sniffing, type / size validation per WhatsApp kind,
// filename sanitising and storage-key safety. No DB, no network.

process.env.WHATSAPP_MEDIA_DIR = mkdtempSync(join(tmpdir(), "wa-media-"));
vi.mock("../src/prisma.js", () => ({ prisma: {} }));

const m = await import("../src/domain/whatsappMedia.js");

const bytes = (...parts: (number[] | string)[]) =>
  Buffer.concat(parts.map((p) => (typeof p === "string" ? Buffer.from(p, "latin1") : Buffer.from(p))));
const pad = (b: Buffer, n = 64) => Buffer.concat([b, Buffer.alloc(n)]);

const SAMPLES = {
  jpeg: pad(bytes([0xff, 0xd8, 0xff, 0xe0], "JFIF")),
  png: pad(bytes([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
  webp: pad(bytes("RIFF", [0, 0, 0, 0], "WEBPVP8 ")),
  mp4: pad(bytes([0, 0, 0, 0x18], "ftypisom")),
  gp3: pad(bytes([0, 0, 0, 0x18], "ftyp3gp4")),
  m4a: pad(bytes([0, 0, 0, 0x18], "ftypM4A ")),
  pdf: pad(bytes("%PDF-1.7\n")),
  docx: pad(bytes([0x50, 0x4b, 0x03, 0x04], "....word/document.xml")),
  xlsx: pad(bytes([0x50, 0x4b, 0x03, 0x04], "....xl/workbook.xml")),
  pptx: pad(bytes([0x50, 0x4b, 0x03, 0x04], "....ppt/presentation.xml")),
  ole: pad(bytes([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])),
  ogg: pad(bytes("OggS")),
  mp3: pad(bytes("ID3")),
  aac: pad(bytes([0xff, 0xf1, 0x50, 0x80])),
  amr: pad(bytes("#!AMR\n")),
  txt: Buffer.from("Hello, this is a plain text note.\nLine two — with UTF-8 ✓\n"),
  exe: pad(bytes("MZ", [0x90, 0x00])),
};

describe("sniffMime (real content type from the bytes)", () => {
  it.each([
    ["jpeg", "image/jpeg"],
    ["png", "image/png"],
    ["webp", "image/webp"],
    ["mp4", "video/mp4"],
    ["gp3", "video/3gpp"],
    ["m4a", "audio/mp4"],
    ["pdf", "application/pdf"],
    ["docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"],
    ["xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"],
    ["pptx", "application/vnd.openxmlformats-officedocument.presentationml.presentation"],
    ["ogg", "audio/ogg"],
    ["mp3", "audio/mpeg"],
    ["aac", "audio/aac"],
    ["amr", "audio/amr"],
    ["txt", "text/plain"],
  ] as const)("%s → %s", (k, mime) => {
    expect(m.sniffMime(SAMPLES[k])).toBe(mime);
  });

  it("legacy Office files use the declared type / extension to pick doc, xls or ppt", () => {
    expect(m.sniffMime(SAMPLES.ole, "application/vnd.ms-excel")).toBe("application/vnd.ms-excel");
    expect(m.sniffMime(SAMPLES.ole, "deck.ppt")).toBe("application/vnd.ms-powerpoint");
    expect(m.sniffMime(SAMPLES.ole, "letter.doc")).toBe("application/msword");
  });

  it("unknown binary is not recognised", () => {
    expect(m.sniffMime(SAMPLES.exe)).toBeNull();
  });
});

describe("validateOutgoingMedia", () => {
  it("accepts each supported type and reports kind, extension and checksum", () => {
    const v = m.validateOutgoingMedia(SAMPLES.png, { declaredMime: "image/png", filename: "logo.png" });
    expect(v).toMatchObject({ kind: "image", mimeType: "image/png", ext: "png", filename: "logo.png", sizeBytes: SAMPLES.png.length });
    expect(v.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(m.validateOutgoingMedia(SAMPLES.mp4, { filename: "demo.mp4" }).kind).toBe("video");
    expect(m.validateOutgoingMedia(SAMPLES.pdf, { filename: "brochure.pdf" }).kind).toBe("document");
    expect(m.validateOutgoingMedia(SAMPLES.docx, { filename: "proposal.docx" }).kind).toBe("document");
    expect(m.validateOutgoingMedia(SAMPLES.ogg, { filename: "voice.ogg" }).kind).toBe("audio");
    expect(m.validateOutgoingMedia(SAMPLES.webp, { filename: "s.webp" }).kind).toBe("sticker");
  });

  it("rejects content that doesn't match its claim, unsupported files and empty files", () => {
    expect(() => m.validateOutgoingMedia(SAMPLES.exe, { declaredMime: "application/pdf", filename: "invoice.pdf" })).toThrow(/Unsupported file type/);
    expect(() => m.validateOutgoingMedia(SAMPLES.pdf, { declaredMime: "image/jpeg", filename: "photo.jpg" })).toThrow(/says it is image\/jpeg/);
    expect(() => m.validateOutgoingMedia(Buffer.alloc(0), {})).toThrow(/empty/);
  });

  it("only allows the kinds asked for (header media: image, video, document)", () => {
    expect(() => m.validateOutgoingMedia(SAMPLES.mp3, { filename: "a.mp3" }, m.HEADER_KINDS)).toThrow(/allowed here/);
    expect(() => m.validateOutgoingMedia(SAMPLES.webp, { filename: "s.webp" }, m.HEADER_KINDS)).toThrow(/allowed here/);
  });

  it("enforces Meta's size limits per kind", () => {
    const bigJpeg = Buffer.concat([SAMPLES.jpeg, Buffer.alloc(5 * 1024 * 1024)]);
    expect(() => m.validateOutgoingMedia(bigJpeg, { filename: "big.jpg" })).toThrow(/image files can be at most 5120 KB/);
    const bigSticker = Buffer.concat([SAMPLES.webp, Buffer.alloc(501 * 1024)]);
    expect(() => m.validateOutgoingMedia(bigSticker, { filename: "s.webp" })).toThrow(/sticker files/);
    // A 6 MB PDF is fine (documents: 100 MB).
    expect(m.validateOutgoingMedia(Buffer.concat([SAMPLES.pdf, Buffer.alloc(6 * 1024 * 1024)]), { filename: "x.pdf" }).kind).toBe("document");
  });
});

describe("filenames and storage keys", () => {
  it("safeFilename strips paths and control characters", () => {
    expect(m.safeFilename("../../etc/passwd", "txt")).toBe("passwd");
    expect(m.safeFilename("C:\\Users\\x\\report.pdf", "pdf")).toBe("report.pdf");
    expect(m.safeFilename('a"b<c>\u0000d.pdf', "pdf")).toBe("abcd.pdf");
    expect(m.safeFilename("", "jpg")).toBe("file.jpg");
    expect(m.safeFilename("...hidden", "txt")).toBe("hidden");
  });

  it("mediaPath only accepts generated keys (no traversal)", () => {
    expect(() => m.mediaPath("../secret.txt")).toThrow(/Invalid media reference/);
    expect(() => m.mediaPath("abc.jpg")).toThrow();
    expect(m.mediaPath("0c8e2c1a-1111-4222-8333-444455556666.jpg")).toContain("0c8e2c1a-1111-4222-8333-444455556666.jpg");
  });

  it("stores and reads back a file under a random name", async () => {
    const key = await m.storeMediaFile(SAMPLES.png, "png");
    expect(key).toMatch(/^[0-9a-f-]{36}\.png$/);
    expect((await m.readMediaFile(key)).equals(SAMPLES.png)).toBe(true);
    expect(await m.mediaFileExists(key)).toBe(true);
  });
});
