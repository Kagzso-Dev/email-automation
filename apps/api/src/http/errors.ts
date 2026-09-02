import type { NextFunction, Request, Response } from "express";
import { ZodError } from "zod";
import { logger } from "../logger.js";

export class AppError extends Error {
  constructor(
    public status: number,
    message: string,
    public code = "error",
    public details?: unknown,
  ) {
    super(message);
  }
}

export const notFound = (what = "Resource") => new AppError(404, `${what} not found`, "not_found");
export const badRequest = (msg: string, details?: unknown) =>
  new AppError(400, msg, "bad_request", details);
export const conflict = (msg: string) => new AppError(409, msg, "conflict");
export const unauthorized = (msg = "Unauthorized") => new AppError(401, msg, "unauthorized");
export const forbidden = (msg = "Forbidden") => new AppError(403, msg, "forbidden");

/** Wraps an async route handler so thrown errors reach the error middleware. */
export const wrap =
  <T extends (req: Request, res: Response, next: NextFunction) => Promise<unknown>>(fn: T) =>
  (req: Request, res: Response, next: NextFunction) =>
    fn(req, res, next).catch(next);

// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function errorHandler(err: unknown, req: Request, res: Response, _next: NextFunction) {
  if (err instanceof ZodError) {
    return res
      .status(400)
      .json({ error: "Validation failed", code: "validation", details: err.flatten() });
  }
  if (err instanceof AppError) {
    if (err.status >= 500) logger.error({ err, reqId: req.id }, err.message);
    return res
      .status(err.status)
      .json({ error: err.message, code: err.code, details: err.details ?? undefined });
  }
  // Prisma unique-constraint violation.
  if (typeof err === "object" && err !== null && (err as { code?: string }).code === "P2002") {
    return res.status(409).json({ error: "Already exists", code: "conflict" });
  }
  logger.error({ err, reqId: req.id }, "Unhandled error");
  return res.status(500).json({ error: "Internal server error", code: "internal" });
}
