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

export const createContactInput = z.object({
  email: z.string().email(),
  firstName: z.string().max(120).optional(),
  lastName: z.string().max(120).optional(),
  customFields: customFields.optional(),
});
export type CreateContactInput = z.infer<typeof createContactInput>;

export const updateContactInput = createContactInput.partial().extend({
  status: contactStatus.optional(),
});

export const listContactsQuery = z.object({
  search: z.string().optional(),
  status: contactStatus.optional(),
  listId: z.string().optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(50),
});

/* ------------------------------------------------------------------ lists */

export const createListInput = z.object({
  name: z.string().min(1).max(160),
  description: z.string().max(1000).optional(),
});
export const updateListInput = createListInput.partial();

export const listMembersInput = z.object({
  add: z.array(z.string()).default([]),
  remove: z.array(z.string()).default([]),
});

/* ------------------------------------------------------------------ templates */

export const createTemplateInput = z.object({
  name: z.string().min(1).max(160),
  subject: z.string().min(1).max(300),
  htmlBody: z.string().min(1),
  textBody: z.string().optional(),
  variables: z.array(z.string()).default([]),
});
export type CreateTemplateInput = z.infer<typeof createTemplateInput>;

export const updateTemplateInput = createTemplateInput.partial();

export const previewTemplateInput = z.object({
  variables: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).default({}),
});

export const sendTestInput = z.object({
  to: z.string().email(),
  variables: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).default({}),
});

/* ------------------------------------------------------------------ campaigns */

export const createCampaignInput = z
  .object({
    name: z.string().min(1).max(160),
    templateId: z.string().min(1),
    listId: z.string().min(1),
    scheduleType,
    sendAt: z.coerce.date().optional(),
    cronExpression: z.string().max(120).optional(),
  })
  .superRefine((val, ctx) => {
    if (val.scheduleType === "ONCE" && !val.sendAt) {
      ctx.addIssue({ code: "custom", path: ["sendAt"], message: "sendAt is required for ONCE" });
    }
    if (val.scheduleType === "RECURRING" && !val.cronExpression) {
      ctx.addIssue({
        code: "custom",
        path: ["cronExpression"],
        message: "cronExpression is required for RECURRING",
      });
    }
  });
export type CreateCampaignInput = z.infer<typeof createCampaignInput>;

export const updateCampaignInput = z.object({
  name: z.string().min(1).max(160).optional(),
  templateId: z.string().min(1).optional(),
  listId: z.string().min(1).optional(),
  scheduleType: scheduleType.optional(),
  sendAt: z.coerce.date().nullable().optional(),
  cronExpression: z.string().max(120).nullable().optional(),
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

/* ------------------------------------------------------------------ helpers */

export const idParam = z.object({ id: z.string().min(1) });
