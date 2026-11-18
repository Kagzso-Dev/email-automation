// Image size controls configuration — deliberately separate from src/env.ts.
//
// Like config/importFilterStep.ts this reads only its own variable and NEVER throws.
//
//   ENABLE_IMAGE_SIZE_CONTROLS=true   Templates → Images shows Small | Best fit | Original size |
//                                    Edit alt text | Remove under each image, and the renderer uses
//                                    each image's stored size and alt text
//                                    (the value .env.example ships with)
//   unset, empty or anything else     off: the Images section and every rendered email are exactly as
//                                    before; stored sizes / alt texts are kept but ignored
//
// Read at call time, so restarting the API AND the worker applies a change (real sends render in the
// worker; the web app asks GET /api/image-size-controls/config).

import { fileURLToPath } from "node:url";
import { config as loadEnv } from "dotenv";

loadEnv();
// src/config/imageSizeControls.ts → repo root is four levels up.
loadEnv({ path: fileURLToPath(new URL("../../../../.env", import.meta.url)) });

const ON_VALUES = ["true", "1", "yes", "on"];

/** True only when ENABLE_IMAGE_SIZE_CONTROLS says on. */
export function isImageSizeControlsEnabled(): boolean {
  return ON_VALUES.includes((process.env.ENABLE_IMAGE_SIZE_CONTROLS ?? "").trim().toLowerCase());
}
