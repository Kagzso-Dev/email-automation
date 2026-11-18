import { vi } from "vitest";
import { db as plus, fake } from "./fakePrismaPlus.js";

// fakePrismaPlus.ts plus the template_drafts table (migration 0039), without changing either fake:
//   - templateDraft: findMany (channel filter, newest first, take), findUnique, upsert, deleteMany (by id, or
//     updatedAt < cutoff for the 30-day purge); `select` is honoured, so a missing `state` is visible to tests
//   - drafts.missing = true: every template_drafts call fails like a database without migration 0039
// Every other model is fakePrismaPlus's. Not a test file itself. Use it as:
//
//   vi.mock("../src/prisma.js", async () => ({ prisma: (await import("./fakePrismaDrafts.js")).db }));

type Row = Record<string, any>;

export const drafts = {
  rows: [] as Row[],
  missing: false,
  reset() {
    this.rows = [];
    this.missing = false;
  },
};

const missingTable = () => Object.assign(new Error("The table `template_drafts` does not exist in the current database."), { code: "P2021" });
const guard = <A extends unknown[], R>(fn: (...a: A) => R) =>
  vi.fn(async (...a: A) => {
    if (drafts.missing) throw missingTable();
    return fn(...a);
  });
const pick = (r: Row | undefined, select?: Row) =>
  !r ? null : select ? Object.fromEntries(Object.entries(select).filter(([, on]) => on).map(([k]) => [k, r[k]])) : { ...r };
const matches = (r: Row, where: Row = {}) =>
  (where.id === undefined || r.id === where.id) &&
  (where.channel === undefined || r.channel === where.channel) &&
  (where.updatedAt?.lt === undefined || r.updatedAt < where.updatedAt.lt);

const templateDraft = {
  findMany: guard(({ where, take = 500, select }: Row) =>
    drafts.rows
      .filter((r) => matches(r, where))
      .sort((a, b) => b.updatedAt - a.updatedAt || (a.id < b.id ? 1 : -1))
      .slice(0, take)
      .map((r) => pick(r, select)),
  ),
  findUnique: guard(({ where, select }: Row) => pick(drafts.rows.find((r) => r.id === where.id), select)),
  upsert: guard(({ where, create, update, select }: Row) => {
    const hit = drafts.rows.find((r) => r.id === where.id);
    if (hit) return pick(Object.assign(hit, update), select);
    const row = { ...create };
    drafts.rows.push(row);
    return pick(row, select);
  }),
  deleteMany: guard(({ where }: Row) => {
    const before = drafts.rows.length;
    drafts.rows = drafts.rows.filter((r) => !matches(r, where));
    return { count: before - drafts.rows.length };
  }),
};

export const db = new Proxy({} as Row, {
  get: (_t, p) => (p === "templateDraft" ? templateDraft : (plus as Row)[p as string]),
});

export { fake, templateDraft };
