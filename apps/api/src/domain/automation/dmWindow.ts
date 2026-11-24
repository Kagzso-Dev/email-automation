// Instagram's messaging window, as one pure rule (Automation, ENABLE_AUTOMATION). The API enforces it on every send
// (decided again at send time, not only in the preview); the web app only displays what it says.
//
//   less than 24 h since the customer's last message    a normal message (messaging_type RESPONSE)
//   24 h up to 7 days                                   only with the HUMAN_AGENT tag: needs Meta's approval
//                                                       (INSTAGRAM_HUMAN_AGENT_ENABLED), one recipient at a time,
//                                                       and the sender ticking "Reply as a human agent"
//   7 days or more, or no message from them             nothing may be sent
//
// Instagram has no WhatsApp-style pre-approved templates that open the window, so there is no other way through.

export const STANDARD_WINDOW_MS = 24 * 60 * 60 * 1000;
export const HUMAN_AGENT_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

export type WindowState = "open" | "human_agent" | "closed" | "no_inbound";

export interface WindowInfo {
  state: WindowState;
  /** When the current state ends (open → human_agent → closed); null when closed already. */
  endsAt: Date | null;
}

export function windowState(lastInboundAt: Date | null, now: Date): WindowInfo {
  if (!lastInboundAt || Number.isNaN(lastInboundAt.getTime())) return { state: "no_inbound", endsAt: null };
  const age = now.getTime() - lastInboundAt.getTime();
  if (age < STANDARD_WINDOW_MS) return { state: "open", endsAt: new Date(lastInboundAt.getTime() + STANDARD_WINDOW_MS) };
  if (age < HUMAN_AGENT_WINDOW_MS) return { state: "human_agent", endsAt: new Date(lastInboundAt.getTime() + HUMAN_AGENT_WINDOW_MS) };
  return { state: "closed", endsAt: null };
}

export type SendBlockReason =
  | "no_inbound"
  | "closed"
  | "human_agent_disabled"
  | "human_agent_bulk"
  | "human_agent_not_chosen"
  | "no_conversation";

export interface SendDecision {
  allowed: boolean;
  /** The message tag to send with, when one is needed. */
  tag: "HUMAN_AGENT" | null;
  state: WindowState;
  reason: SendBlockReason | null;
}

export const BLOCK_REASON_TEXT: Record<SendBlockReason, string> = {
  no_inbound: "They haven't messaged your Instagram account, so Instagram doesn't allow a message.",
  closed: "More than 7 days since their last message — Instagram doesn't allow a message now.",
  human_agent_disabled:
    "More than 24 hours since their last message. Only a human-agent reply (HUMAN_AGENT tag) is allowed now, and it is off (INSTAGRAM_HUMAN_AGENT_ENABLED needs Meta's approval).",
  human_agent_bulk: "More than 24 hours since their last message: a human-agent reply goes to one person at a time. Send to them on their own.",
  human_agent_not_chosen: "More than 24 hours since their last message: tick “Reply as a human agent” to send with the HUMAN_AGENT tag.",
  no_conversation: "No Instagram conversation with this person was found.",
};

export function decideSend(input: {
  lastInboundAt: Date | null;
  now: Date;
  humanAgentEnabled: boolean;
  useHumanAgentTag: boolean;
  recipientCount: number;
}): SendDecision {
  const { state } = windowState(input.lastInboundAt, input.now);
  if (state === "open") return { allowed: true, tag: null, state, reason: null };
  if (state === "no_inbound") return { allowed: false, tag: null, state, reason: "no_inbound" };
  if (state === "closed") return { allowed: false, tag: null, state, reason: "closed" };
  // 24 h – 7 days
  if (!input.humanAgentEnabled) return { allowed: false, tag: null, state, reason: "human_agent_disabled" };
  if (input.recipientCount !== 1) return { allowed: false, tag: null, state, reason: "human_agent_bulk" };
  if (!input.useHumanAgentTag) return { allowed: false, tag: null, state, reason: "human_agent_not_chosen" };
  return { allowed: true, tag: "HUMAN_AGENT", state, reason: null };
}
