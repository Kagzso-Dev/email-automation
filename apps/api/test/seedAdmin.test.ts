import bcrypt from "bcryptjs";
import { beforeEach, describe, expect, it } from "vitest";
import { ensureAdmin, type SeedAdminDb } from "../../../prisma/seedAdmin.js";

// The db:seed admin step: create-if-missing, never overwrite unless reset.

type Row = { id: string; email: string; role: string; passwordHash: string };
let rows: Row[];
let writes: string[];

const db: SeedAdminDb = {
  user: {
    findUnique: async ({ where }) => rows.find((r) => r.email === where.email) ?? null,
    create: async ({ data }) => {
      writes.push("create");
      const row = { id: `u${rows.length + 1}`, ...data };
      rows.push(row);
      return row;
    },
    update: async ({ where, data }) => {
      writes.push("update");
      const row = rows.find((r) => r.id === where.id)!;
      Object.assign(row, data);
      return row;
    },
  },
};

beforeEach(() => {
  rows = [];
  writes = [];
});

describe("ensureAdmin (db:seed)", () => {
  it("creates the admin with a cost-12 bcrypt hash when missing", async () => {
    const r = await ensureAdmin(db, { email: " Admin@Example.com ", password: "first-password", reset: false });
    expect(r).toEqual({ action: "created", email: "admin@example.com", role: "ADMIN" });
    expect(rows[0].passwordHash).toMatch(/^\$2[aby]\$12\$/);
    expect(await bcrypt.compare("first-password", rows[0].passwordHash)).toBe(true);
  });

  it("re-running leaves an existing user completely untouched", async () => {
    rows.push({ id: "u1", email: "admin@example.com", role: "ADMIN", passwordHash: "existing-hash" });
    const r = await ensureAdmin(db, { email: "admin@example.com", password: "different-password", reset: false });
    expect(r.action).toBe("unchanged");
    expect(rows[0].passwordHash).toBe("existing-hash");
    expect(writes).toEqual([]);
  });

  it("only resets the password when reset is requested, keeping the role", async () => {
    rows.push({ id: "u1", email: "admin@example.com", role: "EDITOR", passwordHash: "existing-hash" });
    const r = await ensureAdmin(db, { email: "admin@example.com", password: "recovered-password", reset: true });
    expect(r).toEqual({ action: "reset", email: "admin@example.com", role: "EDITOR" });
    expect(await bcrypt.compare("recovered-password", rows[0].passwordHash)).toBe(true);
    expect(writes).toEqual(["update"]);
  });

  it("result never carries the password or hash", async () => {
    const r = await ensureAdmin(db, { email: "a@example.com", password: "secret-password", reset: false });
    expect(JSON.stringify(r)).not.toMatch(/secret-password|\$2[aby]\$/);
  });
});
