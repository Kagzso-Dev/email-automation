import { createHmac, timingSafeEqual } from "node:crypto";
import { env } from "../env.js";

function hmac(value: string): string {
  return createHmac("sha256", env.LINK_SIGNING_SECRET).update(value).digest("base64url");
}

/** Sign an arbitrary string payload (used for tracked link target URLs). */
export function sign(value: string): string {
  return hmac(value);
}

export function verify(value: string, signature: string): boolean {
  const expected = Buffer.from(hmac(value));
  const given = Buffer.from(signature);
  return expected.length === given.length && timingSafeEqual(expected, given);
}
