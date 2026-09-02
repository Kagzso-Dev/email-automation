import { env } from "../env.js";
import { sign, verify } from "./signing.js";

/**
 * Stateless unsubscribe token: base64url(contactId).hmac. No row is needed
 * until the recipient actually clicks; the Unsubscribe row is created then.
 */
export function unsubscribeToken(contactId: string): string {
  const id = Buffer.from(contactId).toString("base64url");
  return `${id}.${sign(id)}`;
}

export function unsubscribeUrl(contactId: string): string {
  return `${env.PUBLIC_API_URL}/api/unsubscribe/${unsubscribeToken(contactId)}`;
}

export function parseUnsubscribeToken(token: string): string | null {
  const [id, sig] = token.split(".");
  if (!id || !sig || !verify(id, sig)) return null;
  return Buffer.from(id, "base64url").toString("utf8");
}
