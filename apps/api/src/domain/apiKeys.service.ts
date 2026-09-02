import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { prisma } from "../prisma.js";

const PREFIX = "sk_";

export function sha256(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

export async function createApiKey(name: string) {
  const raw = PREFIX + randomBytes(24).toString("hex");
  const key = await prisma.apiKey.create({
    data: { name, keyHash: sha256(raw), prefix: raw.slice(0, 10) },
  });
  // Raw value is returned exactly once and never stored.
  return { id: key.id, name: key.name, prefix: key.prefix, createdAt: key.createdAt, key: raw };
}

export async function verifyApiKey(raw: string): Promise<string | null> {
  if (!raw.startsWith(PREFIX)) return null;
  const hash = sha256(raw);
  const record = await prisma.apiKey.findUnique({ where: { keyHash: hash } });
  if (!record) return null;
  // Constant-time compare on the already-looked-up hash for good measure.
  const a = Buffer.from(hash);
  const b = Buffer.from(record.keyHash);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  await prisma.apiKey.update({ where: { id: record.id }, data: { lastUsed: new Date() } });
  return record.id;
}
