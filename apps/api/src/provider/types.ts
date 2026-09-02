export interface OutboundMessage {
  to: string;
  from: string;
  subject: string;
  html: string;
  text: string;
  headers: Record<string, string>;
  tags: { emailLogId: string };
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
  /** Parse a raw provider callback body into normalised events. */
  parseWebhook(body: unknown, headers: Record<string, string | string[] | undefined>): Promise<DeliveryEvent[]>;
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
