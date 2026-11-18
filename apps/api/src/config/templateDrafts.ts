// Template drafts configuration — deliberately separate from src/env.ts.
//
// Like config/importFilterStep.ts this reads only its own variable and NEVER throws.
//
//   ENABLE_TEMPLATE_DRAFTS=true      Templates (email) and WhatsApp Templates → "Create in Meta" save unfinished
//                                    "New template" forms as drafts, with a Drafts tab on both pages
//   unset, empty or anything else    off (default): both pages work exactly as before, every
//                                    /api/template-drafts endpoint except GET /config answers 404, and the
//                                    30-day sweep touches nothing
//
// Read at request time, so restarting the API applies a change (the web app asks GET /config).

import { fileURLToPath } from "node:url";
import { config as loadEnv } from "dotenv";

loadEnv();
// src/config/templateDrafts.ts → repo root is four levels up.
loadEnv({ path: fileURLToPath(new URL("../../../../.env", import.meta.url)) });

const ON_VALUES = ["true", "1", "yes", "on"];

/** True only when ENABLE_TEMPLATE_DRAFTS says on. */
export function isTemplateDraftsEnabled(): boolean {
  return ON_VALUES.includes((process.env.ENABLE_TEMPLATE_DRAFTS ?? "").trim().toLowerCase());
}
