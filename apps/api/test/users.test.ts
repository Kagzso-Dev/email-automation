import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { PASSWORD_MIN_LENGTH, changePasswordInput, createUserInput } from "@dispatch/shared";

// User management + own-password change, against an in-memory user table.
// The real (unchanged) login() runs on top of it, proving that created,
// disabled and re-enabled users behave correctly at sign-in.

type Row = { id: string; email: string; role: "ADMIN" | "EDITOR"; passwordHash: string; createdAt: Date };
let rows: Row[] = [];
let seq = 0;

const match = (r: Row, where: Partial<Row>) =>
  Object.entries(where).every(([k, v]) => r[k as keyof Row] === v);

const db = {
  user: {
    findUnique: async ({ where }: { where: Partial<Row> }) => rows.find((r) => match(r, where)) ?? null,
    findMany: async ({ where = {} }: { where?: Partial<Row> } = {}) => rows.filter((r) => match(r, where)),
    create: async ({ data }: { data: Omit<Row, "id" | "createdAt"> }) => {
      const row = { ...data, id: `u${++seq}`, createdAt: new Date(2026, 0, seq) };
      rows.push(row);
      return row;
    },
    update: async ({ where, data }: { where: { id: string }; data: Partial<Row> }) => {
      const row = rows.find((r) => r.id === where.id);
      if (!row) throw new Error("not found");
      Object.assign(row, data);
      return row;
    },
    delete: async ({ where }: { where: { id: string } }) => {
      const row = rows.find((r) => r.id === where.id);
      if (!row) throw new Error("not found");
      rows = rows.filter((r) => r !== row);
      return row;
    },
  },
};
vi.mock("../src/prisma.js", () => ({ prisma: db }));

const { createUser, deleteUser, listUsers, setUserDisabled, changeOwnPassword, isDisabledHash } = await import(
  "../src/domain/users.service.js"
);
const { login, refresh } = await import("../src/domain/auth.service.js");

// bcrypt cost 4 keeps fixture setup fast; real hashing (cost 12) is exercised via createUser.
const seedUser = (email: string, role: Row["role"], password: string) =>
  db.user.create({ data: { email, role, passwordHash: bcrypt.hashSync(password, 4) } });

const ADMIN_PW = "admin-password-1";
const EDITOR_PW = "editor-password-1";
let admin: Row;
let editor: Row;

beforeEach(async () => {
  rows = [];
  seq = 0;
  admin = await seedUser("admin@test.dev", "ADMIN", ADMIN_PW);
  editor = await seedUser("editor@test.dev", "EDITOR", EDITOR_PW);
});

describe("input validation", () => {
  it(`requires passwords of at least ${PASSWORD_MIN_LENGTH} characters`, () => {
    const base = { email: "a@b.co", role: "EDITOR" };
    expect(createUserInput.safeParse({ ...base, password: "x".repeat(PASSWORD_MIN_LENGTH - 1) }).success).toBe(false);
    expect(createUserInput.safeParse({ ...base, password: "x".repeat(PASSWORD_MIN_LENGTH) }).success).toBe(true);
    expect(changePasswordInput.safeParse({ currentPassword: "x", newPassword: "short" }).success).toBe(false);
  });

  it("rejects passwords bcrypt would silently truncate (over 72 bytes)", () => {
    expect(createUserInput.safeParse({ email: "a@b.co", role: "EDITOR", password: "x".repeat(73) }).success).toBe(false);
    expect(createUserInput.safeParse({ email: "a@b.co", role: "EDITOR", password: "é".repeat(37) }).success).toBe(false);
  });

  it("only accepts the app's roles", () => {
    expect(createUserInput.safeParse({ email: "a@b.co", role: "OWNER", password: "x".repeat(12) }).success).toBe(false);
    expect(createUserInput.parse({ email: " New@B.co ", role: "ADMIN", password: "x".repeat(12) }).email).toBe("new@b.co");
  });
});

describe("users service", () => {
  it("creates a user with a bcrypt hash the existing login accepts", async () => {
    const u = await createUser({ email: "new@test.dev", password: "brand-new-pass", role: "EDITOR" });
    expect(u).toEqual({ id: expect.any(String), email: "new@test.dev", role: "EDITOR", disabled: false, createdAt: expect.any(String) });
    expect(u).not.toHaveProperty("passwordHash");
    const stored = rows.find((r) => r.id === u.id)!;
    expect(stored.passwordHash).toMatch(/^\$2[aby]\$12\$/); // same cost as auth.service hashPassword()
    expect((await login("new@test.dev", "brand-new-pass")).user.role).toBe("EDITOR");
  });

  it("refuses duplicate emails", async () => {
    await expect(createUser({ email: "editor@test.dev", password: "another-pass-1", role: "ADMIN" })).rejects.toMatchObject({ status: 409 });
  });

  it("disabled users can't log in; re-enabling restores their original password", async () => {
    expect((await setUserDisabled(admin.id, editor.id, true)).disabled).toBe(true);
    await expect(login(editor.email, EDITOR_PW)).rejects.toMatchObject({ status: 401, message: "Invalid email or password" });
    expect((await setUserDisabled(admin.id, editor.id, false)).disabled).toBe(false);
    expect((await login(editor.email, EDITOR_PW)).user.email).toBe(editor.email);
  });

  it("disabling ends an existing session at its next refresh", async () => {
    const { refreshToken } = await login(editor.email, EDITOR_PW);
    await setUserDisabled(admin.id, editor.id, true);
    await expect(refresh(refreshToken)).rejects.toMatchObject({ status: 401 });
    await setUserDisabled(admin.id, editor.id, false);
    expect((await refresh(refreshToken)).user.id).toBe(editor.id);
  });

  it("disabling twice doesn't stack the marker", async () => {
    await setUserDisabled(admin.id, editor.id, true);
    await setUserDisabled(admin.id, editor.id, true);
    await setUserDisabled(admin.id, editor.id, false);
    expect(isDisabledHash(editor.passwordHash)).toBe(false);
    expect((await login(editor.email, EDITOR_PW)).user.email).toBe(editor.email);
  });

  it("admins can't disable themselves or the last active admin", async () => {
    await expect(setUserDisabled(admin.id, admin.id, true)).rejects.toMatchObject({ status: 400 });
    const other = await seedUser("admin2@test.dev", "ADMIN", "admin-two-pass");
    await setUserDisabled(admin.id, other.id, true); // fine: admin@ stays active
    // A second admin acting on the last remaining active admin is refused.
    const third = await seedUser("admin3@test.dev", "ADMIN", "admin-three-pass");
    await setUserDisabled(admin.id, third.id, true);
    await expect(setUserDisabled(third.id, admin.id, true)).rejects.toMatchObject({ status: 400 });
  });

  it("404s for an unknown user", async () => {
    await expect(setUserDisabled(admin.id, "nope", true)).rejects.toMatchObject({ status: 404 });
  });

  it("deleted users can't log in and their session ends at the next refresh", async () => {
    const { refreshToken } = await login(editor.email, EDITOR_PW);
    await deleteUser(admin.id, editor.id);
    expect(rows.map((r) => r.email)).toEqual(["admin@test.dev"]);
    await expect(login(editor.email, EDITOR_PW)).rejects.toMatchObject({ status: 401 });
    await expect(refresh(refreshToken)).rejects.toMatchObject({ status: 401 });
  });

  it("a deleted email can be added again as a new user", async () => {
    await deleteUser(admin.id, editor.id);
    const again = await createUser({ email: editor.email, password: "fresh-password-1", role: "EDITOR" });
    expect(again.id).not.toBe(editor.id);
    expect((await login(editor.email, "fresh-password-1")).user.id).toBe(again.id);
  });

  it("admins can't delete themselves or the last active admin; unknown ids are 404", async () => {
    await expect(deleteUser(admin.id, admin.id)).rejects.toMatchObject({ status: 400 });
    const other = await seedUser("admin2@test.dev", "ADMIN", "admin-two-pass");
    await setUserDisabled(admin.id, other.id, true);
    await expect(deleteUser(other.id, admin.id)).rejects.toMatchObject({ status: 400, message: "At least one active admin is required" });
    await deleteUser(admin.id, other.id); // a disabled admin can be deleted
    await expect(deleteUser(admin.id, "nope")).rejects.toMatchObject({ status: 404 });
    expect(rows.map((r) => r.email)).toEqual(["admin@test.dev", "editor@test.dev"]);
  });

  it("lists users without hashes", async () => {
    const list = await listUsers();
    expect(list.map((u) => u.email)).toEqual(["admin@test.dev", "editor@test.dev"]);
    expect(JSON.stringify(list)).not.toMatch(/passwordHash|\$2[aby]\$/);
  });

  it("changes the own password only with the correct current password", async () => {
    await expect(changeOwnPassword(admin.id, "wrong-password", "next-password-1")).rejects.toMatchObject({ status: 400 });
    await expect(changeOwnPassword(admin.id, ADMIN_PW, ADMIN_PW)).rejects.toMatchObject({ status: 400 });
    await changeOwnPassword(admin.id, ADMIN_PW, "next-password-1");
    await expect(login(admin.email, ADMIN_PW)).rejects.toMatchObject({ status: 401 });
    expect((await login(admin.email, "next-password-1")).user.id).toBe(admin.id);
  });
});

describe("/api/users (HTTP)", () => {
  let server: Server;
  let base = "";
  const token = (u: Row) => jwt.sign({ sub: u.id, email: u.email, role: u.role }, process.env.JWT_ACCESS_SECRET!);
  const call = (path: string, init: RequestInit & { as?: Row } = {}) =>
    fetch(base + path, {
      ...init,
      headers: { "Content-Type": "application/json", ...(init.as ? { Authorization: `Bearer ${token(init.as)}` } : {}) },
    });

  beforeAll(async () => {
    const { createApp } = await import("../src/http/app.js");
    server = createApp().listen(0);
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => new Promise<void>((r) => server.close(() => r())));

  it("requires sign-in and the ADMIN role", async () => {
    expect((await call("/api/users")).status).toBe(401);
    expect((await call("/api/users", { as: editor })).status).toBe(403);
    expect((await call("/api/users/me/password", { method: "POST", as: editor, body: "{}" })).status).toBe(403);
    expect((await call(`/api/users/${admin.id}`, { method: "PATCH", as: editor, body: '{"disabled":true}' })).status).toBe(403);
    expect((await call(`/api/users/${admin.id}`, { method: "DELETE", as: editor })).status).toBe(403);
    expect(rows).toHaveLength(2);
  });

  it("deletes a user (204); deleting yourself is a 400", async () => {
    const res = await call(`/api/users/${editor.id}`, { method: "DELETE", as: admin });
    expect(res.status).toBe(204);
    expect(rows.map((r) => r.email)).toEqual(["admin@test.dev"]);
    expect((await call(`/api/users/${admin.id}`, { method: "DELETE", as: admin })).status).toBe(400);
    expect((await call(`/api/users/${editor.id}`, { method: "DELETE", as: admin })).status).toBe(404);
  });

  it("lists, creates and disables users without ever returning a password or hash", async () => {
    const password = "http-created-pass";
    const created = await call("/api/users", { method: "POST", as: admin, body: JSON.stringify({ email: "h@test.dev", password, role: "EDITOR" }) });
    expect(created.status).toBe(201);
    const createdText = await created.text();
    expect(createdText).not.toContain(password);
    expect(createdText).not.toMatch(/passwordHash|\$2[aby]\$/);
    const { id } = JSON.parse(createdText) as { id: string };

    const patched = await call(`/api/users/${id}`, { method: "PATCH", as: admin, body: '{"disabled":true}' });
    expect(await patched.json()).toMatchObject({ id, disabled: true });

    const listText = await (await call("/api/users", { as: admin })).text();
    expect(listText).not.toMatch(/passwordHash|\$2[aby]\$/);
    expect(JSON.parse(listText).items).toHaveLength(3);
  });

  it("rejects short passwords without echoing them", async () => {
    const res = await call("/api/users", { method: "POST", as: admin, body: JSON.stringify({ email: "s@test.dev", password: "tiny-pw", role: "EDITOR" }) });
    expect(res.status).toBe(400);
    expect(await res.text()).not.toContain("tiny-pw");
  });

  it("changes the caller's own password; a wrong current password is a 400, not a 401", async () => {
    const wrong = await call("/api/users/me/password", { method: "POST", as: admin, body: JSON.stringify({ currentPassword: "nope", newPassword: "another-good-pass" }) });
    expect(wrong.status).toBe(400); // 401 would make the web client sign the admin out
    const ok = await call("/api/users/me/password", { method: "POST", as: admin, body: JSON.stringify({ currentPassword: ADMIN_PW, newPassword: "another-good-pass" }) });
    expect(ok.status).toBe(204);
    expect(await ok.text()).toBe("");
  });
});
