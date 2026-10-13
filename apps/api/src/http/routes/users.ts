import { Router } from "express";
import { changePasswordInput, createUserInput, idParam, setUserDisabledInput } from "@dispatch/shared";
import { rateLimit } from "express-rate-limit";
import { changeOwnPassword, createUser, deleteUser, listUsers, setUserDisabled } from "../../domain/users.service.js";
import { logger } from "../../logger.js";
import { authRequired, requireRole } from "../middleware/auth.js";
import { wrap } from "../errors.js";

// Admin-only user management. Request bodies may carry passwords; they are
// never logged and never echoed back — responses use UserSummary only.
export const usersRouter = Router();
usersRouter.use(authRequired, requireRole("ADMIN"));

const passwordLimiter = rateLimit({ windowMs: 60_000, limit: 10, standardHeaders: true });

usersRouter.get(
  "/",
  wrap(async (_req, res) => {
    res.json({ items: await listUsers() });
  }),
);

usersRouter.post(
  "/",
  wrap(async (req, res) => {
    res.status(201).json(await createUser(createUserInput.parse(req.body)));
  }),
);

usersRouter.patch(
  "/:id",
  wrap(async (req, res) => {
    const { id } = idParam.parse(req.params);
    const { disabled } = setUserDisabledInput.parse(req.body);
    res.json(await setUserDisabled(req.user!.id, id, disabled));
  }),
);

usersRouter.delete(
  "/:id",
  wrap(async (req, res) => {
    const { id } = idParam.parse(req.params);
    await deleteUser(req.user!.id, id);
    logger.info({ userId: id, by: req.user!.email }, "user deleted");
    res.status(204).end();
  }),
);

usersRouter.post(
  "/me/password",
  passwordLimiter,
  wrap(async (req, res) => {
    const { currentPassword, newPassword } = changePasswordInput.parse(req.body);
    await changeOwnPassword(req.user!.id, currentPassword, newPassword);
    res.status(204).end();
  }),
);
