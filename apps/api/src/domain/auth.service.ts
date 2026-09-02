import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import type { Role } from "@prisma/client";
import { env } from "../env.js";
import { prisma } from "../prisma.js";
import { unauthorized } from "../http/errors.js";

export interface AccessClaims {
  sub: string;
  email: string;
  role: Role;
}

export function hashPassword(plain: string): Promise<string> {
  return bcrypt.hash(plain, 12);
}

export async function issueTokens(user: { id: string; email: string; role: Role }) {
  const accessToken = jwt.sign(
    { sub: user.id, email: user.email, role: user.role } satisfies AccessClaims,
    env.JWT_ACCESS_SECRET,
    { expiresIn: env.JWT_ACCESS_TTL },
  );
  const refreshToken = jwt.sign({ sub: user.id }, env.JWT_REFRESH_SECRET, {
    expiresIn: env.JWT_REFRESH_TTL,
  });
  return { accessToken, refreshToken, expiresIn: env.JWT_ACCESS_TTL };
}

export async function login(email: string, password: string) {
  const user = await prisma.user.findUnique({ where: { email: email.toLowerCase() } });
  if (!user || !(await bcrypt.compare(password, user.passwordHash))) {
    throw unauthorized("Invalid email or password");
  }
  const tokens = await issueTokens(user);
  return { ...tokens, user: { id: user.id, email: user.email, role: user.role } };
}

export async function refresh(refreshToken: string) {
  let payload: { sub: string };
  try {
    payload = jwt.verify(refreshToken, env.JWT_REFRESH_SECRET) as { sub: string };
  } catch {
    throw unauthorized("Invalid refresh token");
  }
  const user = await prisma.user.findUnique({ where: { id: payload.sub } });
  if (!user) throw unauthorized("Invalid refresh token");
  const tokens = await issueTokens(user);
  return { ...tokens, user: { id: user.id, email: user.email, role: user.role } };
}

export function verifyAccess(token: string): AccessClaims {
  try {
    return jwt.verify(token, env.JWT_ACCESS_SECRET) as AccessClaims;
  } catch {
    throw unauthorized("Invalid or expired token");
  }
}
