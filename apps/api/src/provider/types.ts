export interface OutboundAttachment {
  filename: string;
  /** UTF-8 string, or base64 when `encoding` is "base64" (e.g. an inlined image). */
  content: string;
  contentType: string;
  encoding?: "base64";
  /** Set for inline images referenced from the HTML as `<img src="cid:...">`. */
  cid?: string;
}

export interface OutboundMessage {
  to: string;
  from: string;
  subject: string;
  html: string;
  text: string;
  headers: Record<string, string>;
  tags: { emailLogId: string };
  attachments?: OutboundAttachment[];
}

export interface SendResult {
  providerMessageId: string;
}

export type DeliveryEvent =
  | { type: "delivered"; providerMessageId: string }
  | { type: "bounced"; providerMessageId: string; hard: boolean; detail?: string }
  | { type: "complained"; providerMessageId: string; detail?: string };

export interface EmailProvider {
  readonly name: string;
  send(msg: OutboundMessage): Promise<SendResult>;
}

/** Transient — retry with backoff. */
export class TransientSendError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TransientSendError";
  }
}

/** Permanent — straight to the dead-letter queue, no retry. */
export class PermanentSendError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PermanentSendError";
  }
}
