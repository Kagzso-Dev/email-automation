import { z } from "zod";

/* ------------------------------------------------------------------ Call Flows (AI voice calls) */
// The UI-editable form of a voice agent's script. Mirrors the voice backend's
// validator (kagzso-voice-backend-english/app/flows/schema.py), which stays the
// authority: a flow is checked there again before it is published or dialled.
// Keys are snake_case because the definition is sent to the voice backend as-is.

export const CALL_FLOW_BASES = ["nila", "followup"] as const;
export type CallFlowBase = (typeof CALL_FLOW_BASES)[number];

/** Variables a script may use. phone_number is deliberately absent: it is never spoken. */
export const CALL_FLOW_VARIABLES = [
  "customer_name",
  "name",
  "honorific",
  "title",
  "gender",
  "addressed_name",
  "follow_up_detail",
  "company_name",
  "business_type",
  "title_to_use",
  "time_greeting",
] as const;

export const CALL_FLOW_GROUPS = ["greeting", "main_script", "questions", "objections", "closing", "tone", "rules"] as const;
export type CallFlowGroup = (typeof CALL_FLOW_GROUPS)[number];

/** Safety blocks each base must keep, text owned by the voice backend (builtin/locked_blocks.json). */
export const CALL_FLOW_LOCKED_KEYS: Record<CallFlowBase, readonly string[]> = {
  nila: [
    "nila_callback_request",
    "nila_data_safety",
    "nila_do_not_call",
    "nila_outcome_rules",
    "nila_rules_safety",
    "nila_runtime_data",
    "nila_wrong_person",
  ],
  followup: ["followup_runtime_data", "followup_situations"],
};

export const CALL_FLOW_MAX_BLOCK_CHARS = 8000;
export const CALL_FLOW_MAX_PROMPT_CHARS = 50_000;

const VAR_RE = /\{\{\s*([^{}]*?)\s*\}\}/g;
// Tab, LF and CR are allowed in scripts; every other control character is not.
// eslint-disable-next-line no-control-regex
const CONTROL_RE = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;

/** Variables used in `text` that are not allowed (deduplicated). */
export function unknownCallFlowVariables(text: string): string[] {
  const allowed = new Set<string>(CALL_FLOW_VARIABLES);
  const out = new Set<string>();
  for (const m of text.matchAll(VAR_RE)) {
    const name = m[1] ?? "";
    if (!allowed.has(name)) out.add(name);
  }
  return [...out].sort();
}

function flowText(max: number, { multiline }: { multiline: boolean }) {
  return z
    .string()
    .min(1)
    .max(max)
    .superRefine((v, ctx) => {
      if (CONTROL_RE.test(v)) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Contains control characters" });
      if (!multiline && /[\r\n]/.test(v)) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Must be a single line" });
      if (v.includes("[[END_CALL]]")) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Must not contain [[END_CALL]]" });
      const unknown = unknownCallFlowVariables(v);
      if (unknown.length) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Unknown variable(s): ${unknown.map((u) => `{{${u}}}`).join(", ")}`,
        });
      }
    });
}

const blockId = z.string().regex(/^[a-z0-9_]{1,40}$/, "Use 1-40 lowercase letters, digits or _");

export const callFlowTextBlock = z
  .object({
    id: blockId,
    group: z.enum(CALL_FLOW_GROUPS),
    text: flowText(CALL_FLOW_MAX_BLOCK_CHARS, { multiline: true }),
  })
  .strict();
export const callFlowLockedBlock = z.object({ id: blockId, locked: z.string().max(60) }).strict();
export type CallFlowTextBlock = z.infer<typeof callFlowTextBlock>;
export type CallFlowLockedBlock = z.infer<typeof callFlowLockedBlock>;
export type CallFlowBlock = CallFlowTextBlock | CallFlowLockedBlock;

export const isLockedBlock = (b: CallFlowBlock): b is CallFlowLockedBlock => "locked" in b;

export const callFlowDefinition = z
  .object({
    schema_version: z.literal(1),
    base: z.enum(CALL_FLOW_BASES),
    name: z.string().trim().min(1).max(100),
    language: z.literal("en"),
    voice_id: z
      .string()
      .regex(/^[A-Za-z0-9_-]{1,100}$/, "Invalid voice id")
      .nullable()
      .optional(),
    greeting: z.object({ text: flowText(300, { multiline: false }) }).strict(),
    blocks: z.array(z.union([callFlowLockedBlock, callFlowTextBlock])).min(1).max(80),
    silence: z
      .object({ reprompt: flowText(200, { multiline: false }), closing: flowText(200, { multiline: false }) })
      .strict(),
    limits: z.object({ max_duration_sec: z.number().int().min(30).max(600) }).strict(),
    transfer: z
      .object({
        // Live transfer is not implemented yet: the number is stored only.
        enabled: z.literal(false),
        number: z
          .string()
          .regex(/^\+[1-9]\d{7,14}$/, "Use E.164, e.g. +919876543210")
          .nullable(),
      })
      .strict(),
  })
  .strict()
  .superRefine((flow, ctx) => {
    const ids = flow.blocks.map((b) => b.id);
    const dupes = [...new Set(ids.filter((id, i) => ids.indexOf(id) !== i))];
    if (dupes.length) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["blocks"], message: `Duplicate block id(s): ${dupes.join(", ")}` });
    const locked = flow.blocks.filter(isLockedBlock).map((b) => b.locked).sort();
    const required = [...CALL_FLOW_LOCKED_KEYS[flow.base]].sort();
    if (locked.join(",") !== required.join(",")) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["blocks"],
        message: `Locked safety blocks can't be removed, added or duplicated (required: ${required.join(", ")})`,
      });
    }
  });
export type CallFlowDefinition = z.infer<typeof callFlowDefinition>;

export const createCallFlowInput = z
  .object({
    name: z.string().trim().min(1).max(100),
    description: z.string().trim().max(1000).optional().nullable(),
    base: z.enum(CALL_FLOW_BASES),
  })
  .strict();

export const saveCallFlowDraftInput = z
  .object({
    definition: callFlowDefinition,
    description: z.string().trim().max(1000).optional().nullable(),
  })
  .strict();

export const callFlowSample = z
  .object({
    customer_name: z.string().trim().max(100).optional().nullable(),
    gender: z.string().trim().max(20).optional().nullable(),
    company_name: z.string().trim().max(150).optional().nullable(),
    business_type: z.string().trim().max(100).optional().nullable(),
    follow_up_detail: z.string().trim().max(500).optional().nullable(),
  })
  .strict();

/** Preview takes any JSON object: the voice backend reports validation errors in the response. */
export const previewCallFlowInput = z
  .object({ definition: z.record(z.unknown()), sample: callFlowSample.default({}) })
  .strict();

export const callFlowVersionParam = z.object({ id: z.string().min(1), version: z.coerce.number().int().min(1) });

/** `numberId` is an id from GET /api/call-flows/test-numbers — never a typed-in number. */
export const testCallFlowInput = z
  .object({
    version: z.number().int().min(1),
    numberId: z.string().trim().min(1).max(64),
    customerName: z.string().trim().max(100).optional().nullable(),
    gender: z.string().trim().max(20).optional().nullable(),
    followUpDetail: z.string().trim().max(500).optional().nullable(),
  })
  .strict();

/* ------------------------------------------------------------------ test-call trial numbers */

/** Saved trial numbers per install (AI_CALL_FLOW_TEST_NUMBERS entries don't count). */
export const MAX_TEST_CALL_NUMBERS = 5;

export const addTestCallNumberInput = z
  .object({
    phone: z.string().trim().min(1, "Enter a phone number").max(40),
    label: z.string().trim().max(60).optional().nullable(),
  })
  .strict();

export interface TestCallNumber {
  /** "db:<id>" for a saved number, "env:<hash>" for an AI_CALL_FLOW_TEST_NUMBERS entry. */
  id: string;
  /** Masked for display, e.g. "+91 98XXX XXX10". */
  masked: string;
  label: string | null;
  source: "saved" | "env";
}

export interface TestCallNumberList {
  items: TestCallNumber[];
  max: number;
  /** True until migration 0023_ai_call_test_numbers is applied: only env numbers work. */
  tableMissing: boolean;
}

/** "+919876543210" → "+91 98XXX XXX10"; other E.164 numbers keep their first 3 and last 2 characters. */
export function maskTestCallNumber(phone: string): string {
  const m = /^\+91(\d{10})$/.exec(phone);
  if (m) return `+91 ${m[1]!.slice(0, 2)}XXX XXX${m[1]!.slice(-2)}`;
  if (phone.length <= 6) return phone.replace(/\d/g, "X");
  return phone.slice(0, 3) + "X".repeat(phone.length - 5) + phone.slice(-2);
}
