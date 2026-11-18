// Image size controls (ENABLE_IMAGE_SIZE_CONTROLS, off by default): the web app's switch.
//
//   GET /api/image-size-controls/config   { enabled }: always answers, for any signed-in user
//
// Sizes and alt texts are saved with the template through the existing /api/templates endpoints.

import { Router } from "express";
import { isImageSizeControlsEnabled } from "../../config/imageSizeControls.js";
import { authRequired } from "../middleware/auth.js";
import { wrap } from "../errors.js";

export const imageSizeControlsRouter = Router();
imageSizeControlsRouter.use(authRequired);

imageSizeControlsRouter.get(
  "/config",
  wrap(async (_req, res) => {
    res.json({ enabled: isImageSizeControlsEnabled() });
  }),
);
