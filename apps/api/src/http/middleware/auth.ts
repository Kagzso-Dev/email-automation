import type { NextFunction, Request, Response } from "express";
import type { Role } from "@prisma/client";
import { verifyAccess } from "../../domain/auth.service.js";
import { forbidden, unauthorized } from "../errors.js";

export function authRequired(req: Request, _res: Response, next: NextFunction) {
  const header = req.headers.authorization;
  if (!header?.startsWith("Bearer ")) return next(unauthorized("Missing bearer token"));
  const claims = verifyAccess(header.slice(7));
  req.user = { id: claims.sub, email: claims.email, role: claims.role };
  next();
}

export function requireRole(...roles: Role[]) {
  return (req: Request, _res: Response, next: NextFunction) => {
    if (!req.user) return next(unauthorized());
    if (!roles.includes(req.user.role)) return next(forbidden("Requires role: " + roles.join("/")));
    next();
  };
}
