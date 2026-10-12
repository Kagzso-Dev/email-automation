import type { NextFunction, Request, Response } from "express";

/**
 * Baseline security headers on every API response. Routes that need stricter
 * ones (e.g. WhatsApp media sets its own CSP) still override them. No global
 * Content-Security-Policy: the unsubscribe pages use inline styles.
 */
export function securityHeaders(_req: Request, res: Response, next: NextFunction) {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  next();
}
