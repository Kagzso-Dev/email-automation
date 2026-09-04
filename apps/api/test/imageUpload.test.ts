import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  IMAGE_UPLOAD_MAX_BYTES,
  ImageUploadError,
  storeTemplateImage,
} from "../src/domain/imageUpload.js";

const dir = mkdtempSync(join(tmpdir(), "dispatch-uploads-"));

// Smallest byte sequences that pass the magic-number check for each type.
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0]);
const GIF = Buffer.concat([Buffer.from("GIF89a"), Buffer.alloc(4)]);
const WEBP = Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(4), Buffer.from("WEBP"), Buffer.alloc(4)]);

const file = (buffer: Buffer, mimetype: string) => ({ buffer, mimetype, size: buffer.length });

describe("storeTemplateImage", () => {
  afterAll(() => {
    // best-effort cleanup; tmpdir is reaped by the OS anyway
  });

  it("writes the file and returns a public /uploads URL", async () => {
    const out = await storeTemplateImage(file(PNG, "image/png"), dir);
    expect(out.url).toMatch(/^https?:\/\/.+\/uploads\/template-images\/.+\.png$/);
    expect(existsSync(out.path)).toBe(true);
    expect(readFileSync(out.path).equals(PNG)).toBe(true);
  });

  it("maps each accepted mime type to the right extension", async () => {
    expect((await storeTemplateImage(file(JPEG, "image/jpeg"), dir)).filename).toMatch(/\.jpg$/);
    expect((await storeTemplateImage(file(GIF, "image/gif"), dir)).filename).toMatch(/\.gif$/);
    expect((await storeTemplateImage(file(WEBP, "image/webp"), dir)).filename).toMatch(/\.webp$/);
  });

  it("rejects an unsupported type", async () => {
    await expect(storeTemplateImage(file(PNG, "image/svg+xml"), dir)).rejects.toThrow(
      ImageUploadError,
    );
  });

  it("rejects a file over the size limit", async () => {
    const big = { buffer: PNG, mimetype: "image/png", size: IMAGE_UPLOAD_MAX_BYTES + 1 };
    await expect(storeTemplateImage(big, dir)).rejects.toThrow(/too large/i);
  });

  it("rejects bytes that don't match the claimed type", async () => {
    await expect(storeTemplateImage(file(Buffer.from("not an image"), "image/png"), dir)).rejects.toThrow(
      /valid image/i,
    );
  });

  it("rejects an empty file", async () => {
    await expect(storeTemplateImage(file(Buffer.alloc(0), "image/png"), dir)).rejects.toThrow(
      ImageUploadError,
    );
  });

  it("gives each upload a unique filename", async () => {
    const a = await storeTemplateImage(file(PNG, "image/png"), dir);
    const b = await storeTemplateImage(file(PNG, "image/png"), dir);
    expect(a.filename).not.toBe(b.filename);
  });
});
