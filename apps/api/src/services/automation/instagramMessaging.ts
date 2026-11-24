// Instagram Messaging API (via the Facebook Page linked to the Instagram account) — Automation, ENABLE_AUTOMATION.
//
// Instagram only lets a business message people who have messaged it first, by their Instagram-scoped id, so the
// recipients are the account's existing conversations — there is no "type any @handle". The time of each customer's
// last message drives the 24-hour rule in domain/automation/dmWindow.ts.
//
//   account        GET  /{ig-account-id}?fields=username,name
//   conversations  GET  /{page-id}/conversations?platform=instagram   (with each one's latest messages)
//   send           POST /{page-id}/messages

import { instagramMessagingSettings } from "../../config/automation.js";
import { AppError } from "../../http/errors.js";
import { upstream } from "./upstream.js";

export interface IgConversation {
  /** The customer's Instagram-scoped id (the only id Instagram accepts as a recipient). */
  recipientId: string;
  username: string | null;
  /** Their most recent message to us among the conversation's latest messages; null = none found. */
  lastInboundAt: Date | null;
  updatedAt: Date | null;
}

const MAX_PAGES = 5; // up to 250 conversations, most recently active first

function creds() {
  const s = instagramMessagingSettings();
  if (!s.configured || !s.token || !s.pageId || !s.igAccountId) {
    throw new AppError(
      409,
      "Instagram messaging isn't connected: set INSTAGRAM_PAGE_ID, INSTAGRAM_ACCOUNT_ID and INSTAGRAM_MESSAGING_ACCESS_TOKEN in .env and restart the API.",
      "not_connected",
    );
  }
  return { token: s.token, pageId: s.pageId, igAccountId: s.igAccountId, base: `https://graph.facebook.com/${s.graphVersion}` };
}

const date = (v: unknown): Date | null => {
  if (typeof v !== "string") return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
};

export async function getMessagingAccount(): Promise<{ id: string; username: string | null }> {
  const c = creds();
  const res = await upstream({
    platform: "meta",
    url: `${c.base}/${c.igAccountId}?fields=username,name`,
    token: c.token,
    tokenEnvVar: "INSTAGRAM_MESSAGING_ACCESS_TOKEN",
  });
  return { id: c.igAccountId, username: typeof res.body?.username === "string" ? res.body.username : null };
}

export async function listConversations(): Promise<IgConversation[]> {
  const c = creds();
  const out: IgConversation[] = [];
  let after: string | null = null;
  for (let page = 0; page < MAX_PAGES; page++) {
    const q = new URLSearchParams({
      platform: "instagram",
      fields: "participants,updated_time,messages.limit(10){from,created_time}",
      limit: "50",
    });
    if (after) q.set("after", after);
    // The cursor is used instead of paging.next: that URL can carry a token.
    const res = await upstream({ platform: "meta", url: `${c.base}/${c.pageId}/conversations?${q}`, token: c.token, tokenEnvVar: "INSTAGRAM_MESSAGING_ACCESS_TOKEN" });
    for (const conv of Array.isArray(res.body?.data) ? res.body.data : []) {
      const participants: unknown[] = Array.isArray(conv?.participants?.data) ? conv.participants.data : [];
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const customer = participants.find((p: any) => p?.id && String(p.id) !== c.igAccountId) as { id?: unknown; username?: unknown } | undefined;
      if (!customer?.id) continue;
      const customerId = String(customer.id);
      let last: Date | null = null;
      for (const m of Array.isArray(conv?.messages?.data) ? conv.messages.data : []) {
        if (String(m?.from?.id ?? "") !== customerId) continue;
        const at = date(m?.created_time);
        if (at && (!last || at > last)) last = at;
      }
      out.push({
        recipientId: customerId,
        username: typeof customer.username === "string" ? customer.username : null,
        lastInboundAt: last,
        updatedAt: date(conv?.updated_time),
      });
    }
    after = typeof res.body?.paging?.cursors?.after === "string" && res.body?.paging?.next ? res.body.paging.cursors.after : null;
    if (!after) break;
  }
  return out;
}

export async function sendMessage(input: { recipientId: string; text: string; tag: "HUMAN_AGENT" | null }): Promise<{ messageId: string | null }> {
  const c = creds();
  const res = await upstream({
    platform: "meta",
    url: `${c.base}/${c.pageId}/messages`,
    token: c.token,
    method: "POST",
    tokenEnvVar: "INSTAGRAM_MESSAGING_ACCESS_TOKEN",
    json: {
      recipient: { id: input.recipientId },
      message: { text: input.text },
      messaging_type: input.tag ? "MESSAGE_TAG" : "RESPONSE",
      ...(input.tag ? { tag: input.tag } : {}),
    },
  });
  return { messageId: typeof res.body?.message_id === "string" ? res.body.message_id : null };
}
