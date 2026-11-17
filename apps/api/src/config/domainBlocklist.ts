// Email domain blocklist configuration — deliberately separate from src/env.ts.
//
// Like config/aiCalls.ts this reads only its own variable and NEVER throws. The Domain mode switch ("Email all
// domains except blocked ones") is available in Settings by default: admins turn it on there, in the UI. It starts
// OFF (no stored mode = the Approved list), so nothing changes until an admin switches it.
//
// ENABLE_DOMAIN_BLOCKLIST is only a kill switch:
//
//   unset, empty or true            the switch is in Settings (default)
//   ENABLE_DOMAIN_BLOCKLIST=false   hide the switch and force the Approved list, exactly as before the feature: the
//                                   stored mode and the new tables (migration 0036) are never read, and every
//                                   /api/settings/sending-domains endpoint except GET answers 404. Restart the API
//                                   and the worker to apply.

import { fileURLToPath } from "node:url";
import { config as loadEnv } from "dotenv";

loadEnv();
// src/config/domainBlocklist.ts → repo root is four levels up.
loadEnv({ path: fileURLToPath(new URL("../../../../.env", import.meta.url)) });

const KILL_VALUES = ["false", "0", "no", "off"];

/** False only when ENABLE_DOMAIN_BLOCKLIST says off. Read at call time, so tests see the current value. */
export function isDomainBlocklistEnabled(): boolean {
  return !KILL_VALUES.includes((process.env.ENABLE_DOMAIN_BLOCKLIST ?? "").trim().toLowerCase());
}
