import { z } from "zod";

/* ------------------------------------------------------------------ shared enums */

export const contactStatus = z.enum(["ACTIVE", "UNSUBSCRIBED", "BOUNCED", "COMPLAINED"]);
export const scheduleType = z.enum(["ONCE", "RECURRING"]);
export const campaignStatus = z.enum([
  "DRAFT",
  "SCHEDULED",
  "SENDING",
  "SENT",
  "PAUSED",
  "FAILED",
]);
export const emailStatus = z.enum([
  "QUEUED",
  "SENT",
  "DELIVERED",
  "OPENED",
  "CLICKED",
  "BOUNCED",
  "COMPLAINED",
  "FAILED",
]);
export const role = z.enum(["ADMIN", "EDITOR"]);

/* ------------------------------------------------------------------ auth */

export const loginInput = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});
export type LoginInput = z.infer<typeof loginInput>;

export const refreshInput = z.object({
  refreshToken: z.string().min(10),
});

/* ------------------------------------------------------------------ contacts */

export const customFields = z.record(z.string(), z.union([z.string(), z.number(), z.boolean()]));

/** Phone number: any formatting accepted on input, stored as exactly 10 digits. */
export const phoneNumber = z
  .string()
  .transform((s) => s.replace(/\D/g, ""))
  .refine((s) => s.length === 10, "Phone number must contain exactly 10 digits");

export const createContactInput = z.object({
  email: z.string().email(),
  firstName: z.string().max(120).optional(),
  lastName: z.string().max(120).optional(),
  phone: phoneNumber.optional(),
  businessName: z.string().max(160).optional(),
  customFields: customFields.optional(),
});
export type CreateContactInput = z.infer<typeof createContactInput>;

export const updateContactInput = createContactInput.partial().extend({
  status: contactStatus.optional(),
  // Nullable so the editor can clear an optional field that was previously set.
  firstName: z.string().max(120).nullable().optional(),
  lastName: z.string().max(120).nullable().optional(),
  phone: phoneNumber.nullable().optional(),
  businessName: z.string().max(160).nullable().optional(),
});

export const listContactsQuery = z.object({
  search: z.string().optional(),
  status: contactStatus.optional(),
  listId: z.string().optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(50),
});

/* ------------------------------------------------------------------ approved domains */

/** Normalise user input ("@Gmail.com ", "https://mail.google.com/") to a bare host. */
export function normaliseDomain(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/^@/, "")
    .replace(/\/.*$/, "")
    .trim();
}

const domainPattern = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;

export const allowedDomainInput = z.object({
  domain: z
    .string()
    .min(1, "Domain is required")
    .transform(normaliseDomain)
    .pipe(z.string().regex(domainPattern, "Enter a valid domain, e.g. gmail.com")),
});
export type AllowedDomainInput = z.infer<typeof allowedDomainInput>;

/* ------------------------------------------------------------------ lists */

export const createListInput = z.object({
  name: z.string().min(1).max(160),
  description: z.string().max(1000).optional(),
});
export const updateListInput = createListInput.partial();

export const listMembersInput = z.object({
  add: z.array(z.string()).default([]),
  remove: z.array(z.string()).default([]),
  // Convenience shape for adding a single contact: POST { contactId }.
  contactId: z.string().min(1).optional(),
});

/* ------------------------------------------------------------------ templates */

export const templateKind = z.enum(["LETTER", "MEETING"]);
export type TemplateKind = z.infer<typeof templateKind>;

/** One call-to-action link in the template's link panel. `url` may hold {{vars}}. */
export const templateLink = z.object({
  label: z.string().min(1).max(120),
  url: z.string().min(1).max(2000),
});
export type TemplateLink = z.infer<typeof templateLink>;

/**
 * Structured meeting details for a MEETING template. Every field is optional so
 * the editor can fill them in incrementally. `startAt` / `endAt` accept either an
 * ISO 8601 date-time ("2026-09-15T14:00") or a {{variable}} resolved per send.
 */
export const templateMeeting = z.object({
  title: z.string().max(200).optional(),
  location: z.string().max(300).optional(),
  joinUrl: z.string().max(2000).optional(),
  startAt: z.string().max(120).optional(),
  endAt: z.string().max(120).optional(),
  timezone: z.string().max(80).optional(),
  description: z.string().max(2000).optional(),
});
export type TemplateMeeting = z.infer<typeof templateMeeting>;

const templateFields = z.object({
  name: z.string().min(1).max(160),
  kind: templateKind.default("LETTER"),
  subject: z.string().min(1).max(300),
  // The message written as a plain letter (paragraphs + {{variables}}), not HTML.
  bodyText: z.string().min(1).max(50_000).optional(),
  // Closing / regards block, appended after the body (e.g. "Best regards,\nThe Team").
  signature: z.string().max(2000).optional(),
  // Render-ready HTML. Normally derived from bodyText by the API; may be sent
  // directly as an escape hatch.
  htmlBody: z.string().min(1).optional(),
  textBody: z.string().optional(),
  // Call-to-action links rendered as a button panel after the body.
  links: z.array(templateLink).max(20).default([]),
  // Meeting card details; only rendered when kind = "MEETING".
  meeting: templateMeeting.optional(),
  // Optional image embedded in the email body — a hosted image URL. Placed at a
  // {{image}} placeholder if the message contains one, otherwise at the top of
  // the body. `nullish` so the editor can clear it.
  imageUrl: z.string().max(2000).nullish(),
  // Optional video link. Rendered as a "▶ Watch video" button (email clients
  // can't embed players). Placed at a {{video_link}} placeholder if present,
  // otherwise after the message body.
  videoUrl: z.string().max(2000).nullish(),
  variables: z.array(z.string()).default([]),
});

const requireBody = (
  v: { bodyText?: string; htmlBody?: string },
  ctx: z.RefinementCtx,
) => {
  if (!v.bodyText?.trim() && !v.htmlBody?.trim()) {
    ctx.addIssue({ code: "custom", path: ["bodyText"], message: "Message body is required" });
  }
};

export const createTemplateInput = templateFields.superRefine(requireBody);
export type CreateTemplateInput = z.infer<typeof createTemplateInput>;

export const updateTemplateInput = templateFields.partial();

export const previewTemplateInput = z.object({
  variables: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).default({}),
});

export const sendTestInput = z.object({
  to: z.string().email(),
  variables: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).default({}),
});

/** Manually send one template to one existing contact, through the real send pipeline. */
export const sendManualEmailInput = z.object({
  templateId: z.string().min(1),
});
export type SendManualEmailInput = z.infer<typeof sendManualEmailInput>;

/**
 * Manually send one template to many existing contacts as a paced drip batch
 * (one send at a time with a random gap). Ineligible contacts are recorded as
 * skipped rather than rejecting the whole request.
 */
export const sendManualBulkInput = z.object({
  templateId: z.string().min(1),
  contactIds: z.array(z.string().min(1)).min(1, "Select at least one contact").max(500),
  // Lead-generation flow: delete every targeted contact once the batch finishes.
  purgeAfter: z.boolean().default(false),
});
export type SendManualBulkInput = z.infer<typeof sendManualBulkInput>;

/**
 * Filter for the Send Queue batch-history lists. Both the email
 * (ManualSendBatch) and WhatsApp (whatsapp_send_batches) status enums are
 * RUNNING | DONE | CANCELLED, so one schema serves both channels.
 */
export const sendBatchHistoryQuery = z.object({
  status: z.enum(["RUNNING", "DONE", "CANCELLED"]).optional(),
});
export type SendBatchHistoryQuery = z.infer<typeof sendBatchHistoryQuery>;

/* ------------------------------------------------------------------ settings */

/**
 * Min/max seconds waited between the individual sends of a manual bulk ("drip")
 * send. Both ends inclusive; min may equal max (a fixed delay).
 */
export const bulkSendSettingsInput = z
  .object({
    minDelaySec: z.coerce.number().int().min(1).max(3600),
    maxDelaySec: z.coerce.number().int().min(1).max(3600),
  })
  .superRefine((v, ctx) => {
    if (v.minDelaySec > v.maxDelaySec) {
      ctx.addIssue({
        code: "custom",
        path: ["maxDelaySec"],
        message: "Maximum must be greater than or equal to the minimum",
      });
    }
  });
export type BulkSendSettingsInput = z.infer<typeof bulkSendSettingsInput>;

/* ------------------------------------------------------------------ campaigns */

export const createCampaignInput = z
  .object({
    name: z.string().min(1, "Name is required").max(160),
    templateId: z.string().min(1, "Pick a template"),
    listId: z.string().min(1, "Pick a list"),
    scheduleType,
    // The form sends the field it doesn't use as `null` — accept that as "unset".
    sendAt: z.coerce.date().nullish(),
    cronExpression: z.string().max(120).nullish(),
  })
  .superRefine((val, ctx) => {
    if (val.scheduleType === "ONCE") {
      if (!val.sendAt) {
        ctx.addIssue({
          code: "custom",
          path: ["sendAt"],
          message: "Pick a date and time to send",
        });
      } else if (val.sendAt.getTime() <= Date.now()) {
        ctx.addIssue({
          code: "custom",
          path: ["sendAt"],
          message: "Send date and time must be in the future",
        });
      }
    }
    if (val.scheduleType === "RECURRING" && !val.cronExpression) {
      ctx.addIssue({
        code: "custom",
        path: ["cronExpression"],
        message: "Choose how often this campaign repeats",
      });
    }
  });
export type CreateCampaignInput = z.infer<typeof createCampaignInput>;

export const updateCampaignInput = z
  .object({
    name: z.string().min(1).max(160).optional(),
    templateId: z.string().min(1).optional(),
    listId: z.string().min(1).optional(),
    scheduleType: scheduleType.optional(),
    sendAt: z.coerce.date().nullable().optional(),
    cronExpression: z.string().max(120).nullable().optional(),
  })
  .superRefine((val, ctx) => {
    if (val.sendAt && val.sendAt.getTime() <= Date.now()) {
      ctx.addIssue({ code: "custom", path: ["sendAt"], message: "sendAt must be in the future" });
    }
  });

/* ------------------------------------------------------------------ triggers */

export const conditionOp = z.enum(["eq", "ne", "contains", "exists", "gt", "lt"]);
export const triggerCondition = z.object({
  field: z.string().min(1), // dot-path into the webhook payload
  op: conditionOp,
  value: z.union([z.string(), z.number(), z.boolean()]).optional(),
});
export type TriggerCondition = z.infer<typeof triggerCondition>;

export const createTriggerInput = z.object({
  name: z.string().min(1).max(160),
  eventKey: z
    .string()
    .min(1)
    .max(80)
    .regex(/^[a-z0-9][a-z0-9_.-]*$/, "lowercase letters, digits, dot, dash, underscore"),
  templateId: z.string().min(1),
  conditions: z.array(triggerCondition).default([]),
  active: z.boolean().default(true),
});
export const updateTriggerInput = createTriggerInput.partial();

export const triggerWebhookInput = z.object({
  contactEmail: z.string().email(),
  // Optional identity so the same event isn't sent twice; defaults to a hash of the payload.
  dedupeKey: z.string().max(200).optional(),
  // Upsert the contact if they don't exist yet.
  contact: z
    .object({
      firstName: z.string().max(120).optional(),
      lastName: z.string().max(120).optional(),
      customFields: customFields.optional(),
    })
    .optional(),
  payload: z.record(z.string(), z.unknown()).default({}),
});
export type TriggerWebhookInput = z.infer<typeof triggerWebhookInput>;

/* ------------------------------------------------------------------ api keys */

export const createApiKeyInput = z.object({
  name: z.string().min(1).max(120),
});

/* ------------------------------------------------------------------ whatsapp (isolated from email) */

export const whatsAppContactStatus = z.enum(["ACTIVE", "UNSUBSCRIBED", "BLOCKED"]);

/**
 * WhatsApp phone: any formatting accepted on input, stored as digits only
 * (country code included, no leading '+'). 8–15 digits per E.164.
 */
export const whatsAppPhone = z
  .string()
  .transform((s) => s.replace(/[^\d]/g, ""))
  .refine((s) => s.length >= 8 && s.length <= 15, "Enter a valid phone number with country code");

export const createWhatsAppContactInput = z.object({
  phone: whatsAppPhone,
  firstName: z.string().max(120).optional(),
  lastName: z.string().max(120).optional(),
  businessName: z.string().max(160).optional(),
});
export type CreateWhatsAppContactInput = z.infer<typeof createWhatsAppContactInput>;

export const updateWhatsAppContactInput = createWhatsAppContactInput.partial().extend({
  status: whatsAppContactStatus.optional(),
  // Nullable so the editor can clear a previously set optional field.
  firstName: z.string().max(120).nullable().optional(),
  lastName: z.string().max(120).nullable().optional(),
  businessName: z.string().max(160).nullable().optional(),
});

export const listWhatsAppContactsQuery = z.object({
  search: z.string().optional(),
  status: whatsAppContactStatus.optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(50),
});

/** Twilio Content template. The SID is created in the Twilio console. */
export const createWhatsAppTemplateInput = z.object({
  name: z.string().min(1).max(160),
  contentSid: z
    .string()
    .trim()
    .regex(/^HX[0-9a-fA-F]{32}$/, "Enter a valid Twilio Content SID (HX…)"),
  body: z.string().min(1).max(4000),
  variables: z.array(z.string().min(1).max(60)).max(20).default([]),
  buttonLabels: z.array(z.string().min(1).max(40)).max(3).default([]),
});
export type CreateWhatsAppTemplateInput = z.infer<typeof createWhatsAppTemplateInput>;

export const updateWhatsAppTemplateInput = createWhatsAppTemplateInput.partial();

/**
 * Bulk WhatsApp send. `source` picks the recipient table: "whatsapp" resolves
 * ids against whatsapp_contacts, "contacts" reads phone/name (read-only) from
 * the email contacts table to seed a send from the Contacts page.
 */
export const sendWhatsAppBulkInput = z.object({
  templateId: z.string().min(1),
  contactIds: z.array(z.string().min(1)).min(1, "Select at least one contact").max(500),
  source: z.enum(["whatsapp", "contacts"]),
  // Lead-generation flow: delete every targeted recipient once the batch finishes.
  purgeAfter: z.boolean().default(false),
});
export type SendWhatsAppBulkInput = z.infer<typeof sendWhatsAppBulkInput>;

/* ------------------------------------------------------------------ helpers */

export const idParam = z.object({ id: z.string().min(1) });
