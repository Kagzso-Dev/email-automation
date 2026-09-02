import { SESv2Client, SendEmailCommand } from "@aws-sdk/client-sesv2";
import { env } from "../env.js";
import { logger } from "../logger.js";
import {
  type DeliveryEvent,
  type EmailProvider,
  type OutboundMessage,
  PermanentSendError,
  type SendResult,
  TransientSendError,
} from "./types.js";

const TRANSIENT_CODES = new Set(["Throttling", "ThrottlingException", "ServiceUnavailable", "TooManyRequestsException"]);

export class SesProvider implements EmailProvider {
  readonly name = "ses";
  private client = new SESv2Client({
    region: env.AWS_REGION,
    credentials:
      env.AWS_ACCESS_KEY_ID && env.AWS_SECRET_ACCESS_KEY
        ? { accessKeyId: env.AWS_ACCESS_KEY_ID, secretAccessKey: env.AWS_SECRET_ACCESS_KEY }
        : undefined,
  });

  async send(msg: OutboundMessage): Promise<SendResult> {
    try {
      const out = await this.client.send(
        new SendEmailCommand({
          FromEmailAddress: msg.from,
          Destination: { ToAddresses: [msg.to] },
          ConfigurationSetName: env.SES_CONFIGURATION_SET || undefined,
          EmailTags: [{ Name: "emailLogId", Value: msg.tags.emailLogId }],
          Content: {
            Simple: {
              Subject: { Data: msg.subject, Charset: "UTF-8" },
              Body: {
                Html: { Data: msg.html, Charset: "UTF-8" },
                Text: { Data: msg.text, Charset: "UTF-8" },
              },
              Headers: Object.entries(msg.headers).map(([Name, Value]) => ({ Name, Value })),
            },
          },
        }),
      );
      return { providerMessageId: out.MessageId ?? "" };
    } catch (err) {
      const name = (err as { name?: string }).name ?? "";
      if (TRANSIENT_CODES.has(name)) throw new TransientSendError(`SES transient: ${name}`);
      // MessageRejected covers unverified recipients in sandbox — permanent for this job.
      throw new PermanentSendError(`SES rejected: ${name || (err as Error).message}`);
    }
  }

  /**
   * SES publishes delivery/bounce/complaint notifications through SNS. This
   * handles subscription confirmation and maps notification types. Signature
   * verification is left as a TODO gated behind the feature flag (see §8).
   */
  async parseWebhook(
    body: unknown,
    headers: Record<string, string | string[] | undefined>,
  ): Promise<DeliveryEvent[]> {
    const snsType = headers["x-amz-sns-message-type"];
    const parsed = typeof body === "string" ? JSON.parse(body) : (body as Record<string, unknown>);

    if (snsType === "SubscriptionConfirmation") {
      const url = parsed.SubscribeURL as string | undefined;
      if (url) {
        await fetch(url).catch((e) => logger.error({ e }, "SNS subscribe confirmation failed"));
      }
      return [];
    }

    const message =
      typeof parsed.Message === "string" ? JSON.parse(parsed.Message) : parsed.Message ?? parsed;
    const notificationType: string = message.notificationType ?? message.eventType ?? "";
    const providerMessageId: string = message.mail?.messageId ?? "";
    if (!providerMessageId) return [];

    switch (notificationType) {
      case "Delivery":
        return [{ type: "delivered", providerMessageId }];
      case "Bounce": {
        const hard = message.bounce?.bounceType === "Permanent";
        return [{ type: "bounced", providerMessageId, hard, detail: message.bounce?.bounceSubType }];
      }
      case "Complaint":
        return [{ type: "complained", providerMessageId, detail: message.complaint?.complaintFeedbackType }];
      default:
        return [];
    }
  }
}
