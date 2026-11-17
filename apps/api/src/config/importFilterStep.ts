// Import filter step configuration — deliberately separate from src/env.ts.
//
// Like config/domainBlocklist.ts this reads only its own variable and NEVER throws.
//
//   ENABLE_IMPORT_FILTER_STEP=true    WhatsApp Contacts and Voicecall Contact (every language) open a
//                                    filter step before "Import file" imports anything
//   unset, empty or anything else     off (default): "Import file" works exactly as before, and every
//                                    /api/import-filter endpoint except GET /config answers 404
//
// Read at request time, so restarting the API applies a change (the web app asks GET /config).

import { fileURLToPath } from "node:url";
import { config as loadEnv } from "dotenv";

loadEnv();
// src/config/importFilterStep.ts → repo root is four levels up.
loadEnv({ path: fileURLToPath(new URL("../../../../.env", import.meta.url)) });

const ON_VALUES = ["true", "1", "yes", "on"];

/** True only when ENABLE_IMPORT_FILTER_STEP says on. */
export function isImportFilterStepEnabled(): boolean {
  return ON_VALUES.includes((process.env.ENABLE_IMPORT_FILTER_STEP ?? "").trim().toLowerCase());
}
