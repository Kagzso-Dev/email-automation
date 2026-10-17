/**
 * Decides whether db:seed may touch the connected database.
 *
 * - Plan mode (--dry-run) is read-only, so it needs no opt-in, but it still
 *   refuses a database other than SEED_EXPECTED_DATABASE so the plan you read
 *   is the plan for the database you meant.
 * - Writing requires ALLOW_DATABASE_SEED=true AND SEED_EXPECTED_DATABASE equal
 *   to the database the connection actually landed on (SELECT DATABASE()),
 *   which also covers a DATABASE_URL override pointing somewhere else.
 */
export type SeedGuardResult = { ok: true } | { ok: false; reason: string };

export function checkSeedGuard(opts: {
  env: Record<string, string | undefined>;
  connectedDatabase: string | null;
  dryRun: boolean;
}): SeedGuardResult {
  const expected = opts.env.SEED_EXPECTED_DATABASE?.trim();
  const connected = opts.connectedDatabase?.trim() || null;

  if (!expected) {
    return {
      ok: false,
      reason: "SEED_EXPECTED_DATABASE is not set — set it to the exact database name you approve for seeding.",
    };
  }
  if (!connected) {
    return { ok: false, reason: "The connection has no database selected (SELECT DATABASE() returned NULL)." };
  }
  if (connected !== expected) {
    return {
      ok: false,
      reason: `Connected database "${connected}" does not match SEED_EXPECTED_DATABASE "${expected}".`,
    };
  }
  if (!opts.dryRun && opts.env.ALLOW_DATABASE_SEED !== "true") {
    return {
      ok: false,
      reason: "Seeding is disabled — set ALLOW_DATABASE_SEED=true for this run (or use --dry-run to inspect the plan).",
    };
  }
  return { ok: true };
}
