import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { env } from "../src/env.js";
import { inlineLocalImages } from "../src/render/inlineImages.js";

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
const uploadsDir = join(process.cwd(), env.UPLOADS_DIR, "template-images");
const name = `test-${Date.now()}.png`;
const localUrl = `${env.PUBLIC_API_URL}/uploads/template-images/${name}`;

beforeAll(async () => {
  await mkdir(uploadsDir, { recursive: true });
  await writeFile(join(uploadsDir, name), PNG);
});
afterAll(async () => {
  await rm(join(uploadsDir, name), { force: true });
});

describe("inlineLocalImages", () => {
  it("replaces a local upload <img> with a cid: ref and attaches the bytes", async () => {
    const html = `<div><img src="${localUrl}" alt="" /></div><p>hi</p>`;
    const out = await inlineLocalImages(html, undefined);

    expect(out.html).not.toContain(localUrl);
    expect(out.html).toMatch(/<img src="cid:img-[0-9a-f-]+@dispatch"/);
    expect(out.attachments).toHaveLength(1);
    const att = out.attachments![0];
    expect(att.encoding).toBe("base64");
    expect(att.contentType).toBe("image/png");
    expect(Buffer.from(att.content, "base64").equals(PNG)).toBe(true);
    expect(out.html).toContain(`cid:${att.cid}`);
  });

  it("leaves an externally-hosted image URL untouched", async () => {
    const html = `<img src="https://cdn.example.com/hero.jpg" alt="" />`;
    const out = await inlineLocalImages(html, undefined);
    expect(out.html).toBe(html);
    expect(out.attachments).toBeUndefined();
  });

  it("keeps existing attachments and appends the image", async () => {
    const ics = { filename: "invite.ics", content: "BEGIN:VCALENDAR", contentType: "text/calendar" };
    const out = await inlineLocalImages(`<img src="${localUrl}" />`, [ics]);
    expect(out.attachments).toHaveLength(2);
    expect(out.attachments![0]).toBe(ics);
  });

  it("leaves the src alone when the file is missing (email still sends)", async () => {
    const html = `<img src="${env.PUBLIC_API_URL}/uploads/template-images/does-not-exist.png" />`;
    const out = await inlineLocalImages(html, undefined);
    expect(out.html).toBe(html);
    expect(out.attachments).toBeUndefined();
  });

  it("does not touch a cid: or data: src", async () => {
    const html = `<img src="cid:x@y" /><img src="data:image/png;base64,AAAA" />`;
    const out = await inlineLocalImages(html, undefined);
    expect(out.html).toBe(html);
  });

  it("rejects path traversal in the /uploads path", async () => {
    const html = `<img src="${env.PUBLIC_API_URL}/uploads/template-images/../../../etc/passwd" />`;
    const out = await inlineLocalImages(html, undefined);
    expect(out.html).toBe(html);
    expect(out.attachments).toBeUndefined();
  });
});
