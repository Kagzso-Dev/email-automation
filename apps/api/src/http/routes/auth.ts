import { Router } from "express";
import { loginInput, refreshInput } from "@dispatch/shared";
import { env } from "../../env.js";
import { login, refresh } from "../../domain/auth.service.js";
import { wrap } from "../errors.js";
import { rateLimit } from "express-rate-limit";

export const authRouter = Router();

const loginLimiter = rateLimit({ windowMs: 60_000, limit: 10, standardHeaders: true });

const refreshCookie = "dispatch_refresh";
const cookieOpts = {
  httpOnly: true,
  sameSite: "lax" as const,
  secure: env.NODE_ENV === "production",
  maxAge: env.JWT_REFRESH_TTL * 1000,
  path: "/api/auth",
};

authRouter.post(
  "/login",
  loginLimiter,
  wrap(async (req, res) => {
    const { email, password } = loginInput.parse(req.body);
    const result = await login(email, password);
    res.cookie(refreshCookie, result.refreshToken, cookieOpts);
    res.json({ accessToken: result.accessToken, expiresIn: result.expiresIn, user: result.user });
  }),
);

authRouter.post(
  "/refresh",
  wrap(async (req, res) => {
    const token =
      req.cookies?.[refreshCookie] ??
      (req.body && Object.keys(req.body).length ? refreshInput.parse(req.body).refreshToken : undefined);
    if (!token) return res.status(401).json({ error: "No refresh token", code: "unauthorized" });
    const result = await refresh(token);
    res.cookie(refreshCookie, result.refreshToken, cookieOpts);
    res.json({ accessToken: result.accessToken, expiresIn: result.expiresIn, user: result.user });
  }),
);

authRouter.post("/logout", (req, res) => {
  res.clearCookie(refreshCookie, { path: "/api/auth" });
  res.status(204).end();
});
