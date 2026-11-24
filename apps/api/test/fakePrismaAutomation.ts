import { vi } from "vitest";
import { db as plus, fake } from "./fakePrismaPlus.js";

// fakePrismaPlus.ts plus the two Automation tables (migration 0041), without changing that fake:
//   - automationDmSend: findFirst, create, findMany (platform filter, newest first, skip/take), count
//   - automationCampaignAction: findFirst, create
//   - automation.missing = true: every call to either table fails like a database without migration 0041
// Every other model is fakePrismaPlus's. Not a test file itself. Use it as:
//
//   vi.mock("../src/prisma.js", async () => ({ prisma: (await import("./fakePrismaAutomation.js")).db }));

type Row = Record<string, any>;

export const automation = {
  sends: [] as Row[],
  actions: [] as Row[],
  missing: false,
  /** Every model name the router touched (proves the flag-off path never reaches the database). */
  touched: [] as string[],
  reset() {
    this.sends = [];
    this.actions = [];
    this.missing = false;
    this.touched = [];
  },
};

const missingTable = () => Object.assign(new Error("The table `automation_dm_sends` does not exist in the current database."), { code: "P2021" });
let seq = 0;
const guard = <A extends unknown[], R>(model: string, fn: (...a: A) => R) =>
  vi.fn(async (...a: A) => {
    automation.touched.push(model);
    if (automation.missing) throw missingTable();
    return fn(...a);
  });

const table = (name: string, rows: () => Row[]) => ({
  findFirst: guard(name, () => rows()[0] ?? null),
  create: guard(name, ({ data }: Row) => {
    const row = { id: `row-${++seq}`, createdAt: new Date(Date.now() + seq), ...data };
    rows().push(row);
    return { ...row };
  }),
  findMany: guard(name, ({ where = {}, skip = 0, take = 50 }: Row) =>
    rows()
      .filter((r) => where.platform === undefined || r.platform === where.platform)
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(skip, skip + take)
      .map((r) => ({ ...r })),
  ),
  count: guard(name, ({ where = {} }: Row = {}) => rows().filter((r) => where.platform === undefined || r.platform === where.platform).length),
});

const automationDmSend = table("automationDmSend", () => automation.sends);
const automationCampaignAction = table("automationCampaignAction", () => automation.actions);

export const db = new Proxy({} as Row, {
  get: (_t, p) =>
    p === "automationDmSend" ? automationDmSend : p === "automationCampaignAction" ? automationCampaignAction : (plus as Row)[p as string],
});

export { fake };
