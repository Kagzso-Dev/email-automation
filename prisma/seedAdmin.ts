import bcrypt from "bcryptjs";

// bcrypt cost — matches hashPassword() in apps/api/src/domain/auth.service.ts.
export const BCRYPT_COST = 12;

/** The slice of PrismaClient the admin seed needs (kept narrow so it can be faked in tests). */
export interface SeedAdminDb {
  user: {
    findUnique(args: { where: { email: string } }): Promise<{ id: string; email: string; role: string } | null>;
    create(args: { data: { email: string; passwordHash: string; role: "ADMIN" } }): Promise<{ email: string; role: string }>;
    update(args: { where: { id: string }; data: { passwordHash: string } }): Promise<{ email: string; role: string }>;
  };
}

export type SeedAdminResult = { action: "created" | "unchanged" | "reset"; email: string; role: string };

/**
 * Creates the admin only if no user has that email. An existing user's
 * password is never touched unless `reset` is true (SEED_ADMIN_RESET=true);
 * a reset changes the password only — role and other fields are kept.
 */
export async function ensureAdmin(
  db: SeedAdminDb,
  opts: { email: string; password: string; reset: boolean },
): Promise<SeedAdminResult> {
  const email = opts.email.trim().toLowerCase();
  const existing = await db.user.findUnique({ where: { email } });
  if (!existing) {
    const u = await db.user.create({
      data: { email, passwordHash: await bcrypt.hash(opts.password, BCRYPT_COST), role: "ADMIN" },
    });
    return { action: "created", email: u.email, role: u.role };
  }
  if (!opts.reset) return { action: "unchanged", email: existing.email, role: existing.role };
  const u = await db.user.update({
    where: { id: existing.id },
    data: { passwordHash: await bcrypt.hash(opts.password, BCRYPT_COST) },
  });
  return { action: "reset", email: u.email, role: u.role };
}
