import bcrypt from "bcryptjs";
import type { Role } from "@prisma/client";
import type { CreateUserInput, UserSummary } from "@dispatch/shared";
import { prisma } from "../prisma.js";
import { hashPassword } from "./auth.service.js";
import { badRequest, conflict, notFound } from "../http/errors.js";

/*
 * Disabling a user prefixes the stored bcrypt hash with "!". bcrypt hashes are
 * exactly 60 characters and bcrypt.compare() returns false for any other
 * length, so the unchanged login() rejects the user with its usual generic
 * error, and refresh() refuses to renew an existing session. Re-enabling strips
 * the prefix and the original password works again. No schema change is needed.
 */
const DISABLED_PREFIX = "!";

export const isDisabledHash = (hash: string) => hash.startsWith(DISABLED_PREFIX);
export const disableHash = (hash: string) => (isDisabledHash(hash) ? hash : DISABLED_PREFIX + hash);
export const enableHash = (hash: string) => (isDisabledHash(hash) ? hash.slice(DISABLED_PREFIX.length) : hash);

type UserRow = { id: string; email: string; role: Role; passwordHash: string; createdAt: Date };

/** The only shape that leaves this module — the hash is never returned. */
export function toSummary(u: UserRow): UserSummary {
  return {
    id: u.id,
    email: u.email,
    role: u.role,
    disabled: isDisabledHash(u.passwordHash),
    createdAt: u.createdAt.toISOString(),
  };
}

const userSelect = { id: true, email: true, role: true, passwordHash: true, createdAt: true } as const;

export async function listUsers(): Promise<UserSummary[]> {
  const rows = await prisma.user.findMany({ orderBy: { createdAt: "asc" }, select: userSelect });
  return rows.map(toSummary);
}

export async function createUser(input: CreateUserInput): Promise<UserSummary> {
  const email = input.email.toLowerCase();
  if (await prisma.user.findUnique({ where: { email }, select: { id: true } })) {
    throw conflict("A user with that email already exists");
  }
  const row = await prisma.user.create({
    data: { email, role: input.role, passwordHash: await hashPassword(input.password) },
    select: userSelect,
  });
  return toSummary(row);
}

export async function setUserDisabled(actorId: string, userId: string, disabled: boolean): Promise<UserSummary> {
  const user = await prisma.user.findUnique({ where: { id: userId }, select: userSelect });
  if (!user) throw notFound("User");
  if (disabled) {
    if (user.id === actorId) throw badRequest("You can't disable your own account");
    if (user.role === "ADMIN" && !isDisabledHash(user.passwordHash)) {
      const admins = await prisma.user.findMany({ where: { role: "ADMIN" }, select: { passwordHash: true } });
      if (admins.filter((a) => !isDisabledHash(a.passwordHash)).length <= 1) {
        throw badRequest("At least one active admin is required");
      }
    }
  }
  const passwordHash = disabled ? disableHash(user.passwordHash) : enableHash(user.passwordHash);
  if (passwordHash === user.passwordHash) return toSummary(user);
  const row = await prisma.user.update({ where: { id: userId }, data: { passwordHash }, select: userSelect });
  return toSummary(row);
}

/*
 * Deleting removes only the user row. No other table has a foreign key to
 * users — campaigns, call flows, AI call runs and WhatsApp keep the creator as
 * plain id/email text — so history stays intact. The deleted user's session
 * ends at its next refresh (refresh() finds no user).
 */
export async function deleteUser(actorId: string, userId: string): Promise<void> {
  const user = await prisma.user.findUnique({ where: { id: userId }, select: userSelect });
  if (!user) throw notFound("User");
  if (user.id === actorId) throw badRequest("You can't delete your own account");
  if (user.role === "ADMIN" && !isDisabledHash(user.passwordHash)) {
    const admins = await prisma.user.findMany({ where: { role: "ADMIN" }, select: { passwordHash: true } });
    if (admins.filter((a) => !isDisabledHash(a.passwordHash)).length <= 1) {
      throw badRequest("At least one active admin is required");
    }
  }
  await prisma.user.delete({ where: { id: userId } });
}

export async function changeOwnPassword(userId: string, currentPassword: string, newPassword: string) {
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { passwordHash: true } });
  // 400 rather than 401: a 401 makes the web client drop the session.
  if (!user || isDisabledHash(user.passwordHash) || !(await bcrypt.compare(currentPassword, user.passwordHash))) {
    throw badRequest("Current password is incorrect");
  }
  if (currentPassword === newPassword) throw badRequest("New password must be different from the current one");
  await prisma.user.update({ where: { id: userId }, data: { passwordHash: await hashPassword(newPassword) } });
}
