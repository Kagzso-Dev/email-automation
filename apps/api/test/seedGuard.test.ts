import { describe, expect, it } from "vitest";
import { checkSeedGuard } from "../../../prisma/seedGuard.js";
import { planAdmin } from "../../../prisma/seedAdmin.js";

// db:seed safety: opt-in + expected-database match, and a read-only plan.

const approved = { SEED_EXPECTED_DATABASE: "kagzso_prod", ALLOW_DATABASE_SEED: "true" };

describe("checkSeedGuard (db:seed)", () => {
  it("allows a write only with opt-in and a matching database", () => {
    expect(checkSeedGuard({ env: approved, connectedDatabase: "kagzso_prod", dryRun: false })).toEqual({ ok: true });
  });

  it("blocks writes unless ALLOW_DATABASE_SEED is exactly true", () => {
    for (const flag of [undefined, "", "false", "TRUE", "1"]) {
      const r = checkSeedGuard({
        env: { ...approved, ALLOW_DATABASE_SEED: flag },
        connectedDatabase: "kagzso_prod",
        dryRun: false,
      });
      expect(r.ok).toBe(false);
    }
  });

  it("aborts when the connected database is not the expected one", () => {
    const r = checkSeedGuard({ env: approved, connectedDatabase: "dispatch", dryRun: false });
    expect(r).toMatchObject({ ok: false });
    expect(!r.ok && r.reason).toMatch(/"dispatch" does not match/);
  });

  it("aborts when SEED_EXPECTED_DATABASE is missing or no database is selected", () => {
    expect(checkSeedGuard({ env: { ALLOW_DATABASE_SEED: "true" }, connectedDatabase: "dispatch", dryRun: false }).ok).toBe(false);
    expect(checkSeedGuard({ env: approved, connectedDatabase: null, dryRun: false }).ok).toBe(false);
  });

  it("dry run needs no opt-in but still requires the expected database", () => {
    const env = { SEED_EXPECTED_DATABASE: "kagzso_prod" };
    expect(checkSeedGuard({ env, connectedDatabase: "kagzso_prod", dryRun: true })).toEqual({ ok: true });
    expect(checkSeedGuard({ env, connectedDatabase: "dispatch", dryRun: true }).ok).toBe(false);
  });
});

describe("planAdmin (db:seed --dry-run)", () => {
  const db = (row: { id: string; email: string; role: string } | null) => ({
    user: { findUnique: async () => row },
  });

  it("plans create when the email is free", async () => {
    expect(await planAdmin(db(null), { email: " Admin@Example.com ", reset: false })).toEqual({
      action: "create",
      email: "admin@example.com",
      role: "ADMIN",
    });
  });

  it("plans skip for an existing user, reporting their current role", async () => {
    const existing = { id: "u1", email: "admin@example.com", role: "EDITOR" };
    expect(await planAdmin(db(existing), { email: "admin@example.com", reset: false })).toEqual({
      action: "skip",
      email: "admin@example.com",
      role: "EDITOR",
    });
    expect((await planAdmin(db(existing), { email: "admin@example.com", reset: true })).action).toBe("reset");
  });
});
