// Small AES-256-GCM helper for secrets kept in the Setting table (today: the SMTP password saved in Settings).
// The stored form is "v1:<iv>:<tag>:<ciphertext>", all base64. A wrong key or an edited value fails the GCM tag
// check and returns null — callers treat that as "no saved secret", never as an empty one.

import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto";

const VERSION = "v1";

function keyFrom(secret: string, purpose: string): Buffer {
  if (!secret) throw new Error("No encryption secret configured (SETTINGS_ENCRYPTION_KEY or JWT_ACCESS_SECRET)");
  return Buffer.from(hkdfSync("sha256", secret, "dispatch-settings", purpose, 32));
}

export function sealSecret(plain: string, secret: string, purpose: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", keyFrom(secret, purpose), iv);
  const ct = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [VERSION, iv.toString("base64"), tag.toString("base64"), ct.toString("base64")].join(":");
}

/** The plain text, or null when the value is malformed or was sealed with a different key. */
export function openSecret(sealed: string, secret: string, purpose: string): string | null {
  const parts = sealed.split(":");
  if (parts.length !== 4 || parts[0] !== VERSION) return null;
  try {
    const [, iv, tag, ct] = parts.map((p) => Buffer.from(p, "base64"));
    const decipher = createDecipheriv("aes-256-gcm", keyFrom(secret, purpose), iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ct), decipher.final()]).toString("utf8");
  } catch {
    return null;
  }
}
