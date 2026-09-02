import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { env } from "../env.js";
import { logger } from "../logger.js";
import {
  type DeliveryEvent,
  type EmailProvider,
  type OutboundMessage,
  type SendResult,
  TransientSendError,
} from "./types.js";

const OUTBOX = join(process.cwd(), ".mail-outbox");

export class MockProvider implements EmailProvider {
  readonly name = "mock";

  async send(msg: OutboundMessage): Promise<SendResult> {
    if (env.MOCK_FAIL_RATE > 0 && Math.random() < env.MOCK_FAIL_RATE) {
      throw new TransientSendError("Injected mock failure (MOCK_FAIL_RATE)");
    }
    const id = `mock-${randomUUID()}`;
    await mkdir(OUTBOX, { recursive: true });
    const file = join(OUTBOX, `${Date.now()}-${msg.tags.emailLogId}.html`);
    const headerLines = Object.entries({
      From: msg.from,
      To: msg.to,
      Subject: msg.subject,
      "X-Provider-Message-Id": id,
      ...msg.headers,
    })
      .map(([k, v]) => `${k}: ${v}`)
      .join("\n");
    await writeFile(file, `${headerLines}\n\n<!-- text -->\n${msg.text}\n\n<!-- html -->\n${msg.html}\n`);
    logger.info({ to: msg.to, subject: msg.subject, file, providerMessageId: id }, "mock email written");
    return { providerMessageId: id };
  }

  async parseWebhook(): Promise<DeliveryEvent[]> {
    // No real callbacks; delivery events are simulated via the dev endpoint.
    return [];
  }
}
