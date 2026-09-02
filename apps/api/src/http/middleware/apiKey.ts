import type { NextFunction, Request, Response } from "express";
import { verifyApiKey } from "../../domain/apiKeys.service.js";
import { unauthorized } from "../errors.js";

/** Accepts `Authorization: Bearer sk_...` or `X-Api-Key: sk_...`. */
export async function apiKeyRequired(req: Request, _res: Response, next: NextFunction) {
  const header = req.headers.authorization;
  const raw =
    (header?.startsWith("Bearer ") ? header.slice(7) : undefined) ??
    (typeof req.headers["x-api-key"] === "string" ? req.headers["x-api-key"] : undefined);
  if (!raw) return next(unauthorized("Missing API key"));
  const id = await verifyApiKey(raw);
  if (!id) return next(unauthorized("Invalid API key"));
  req.apiKeyId = id;
  next();
}
