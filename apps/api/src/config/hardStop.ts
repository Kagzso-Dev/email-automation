// Hard stop configuration — deliberately separate from src/env.ts.
//
// Like config/importFilterStep.ts this reads only its own variable and NEVER throws.
//
//   ENABLE_HARD_STOP=true    "Hard stop" on each running send and "Stop all running sends" (admin). Work already in
//                            progress always finishes; everything not started is cancelled. The queue workers start
//                            each item with an "only if still queued" write and check the stop before each item,
//                            retry and follow-up (domain/hardStop.ts).
//   unset, empty or other    off (default): every worker runs exactly its earlier code, and every /api/hard-stop
//                            endpoint except GET /config answers 404.
//
// Read on every use, so restarting the API and the worker applies a change.

import { fileURLToPath } from "node:url";
import { config as loadEnv } from "dotenv";

loadEnv();
// src/config/hardStop.ts → repo root is four levels up.
loadEnv({ path: fileURLToPath(new URL("../../../../.env", import.meta.url)) });

const ON_VALUES = ["true", "1", "yes", "on"];

/** True only when ENABLE_HARD_STOP says on. */
export function isHardStopEnabled(): boolean {
  return ON_VALUES.includes((process.env.ENABLE_HARD_STOP ?? "").trim().toLowerCase());
}
