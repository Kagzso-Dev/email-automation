import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { fake } from "./fakePrisma.js";

// Settings → Domain mode (domain/sendingDomainPolicy): the matching rule in both modes, which tables are
// read with the flag off and on, and the skip wording. Prisma is an in-memory fake.

vi.mock("../src/prisma.js", async () => ({ prisma: (await import("./fakePrisma.js")).fake.db }));

const policy = await import("../src/domain/sendingDomainPolicy.js");
const { isDomainBlocklistEnabled } = await import("../src/config/domainBlocklist.js");
const { domainAllowed, isEmailDomainAllowed } = await import("../src/domain/allowedDomains.js");
const { checkEmailDomain, domainBlocked } = policy;

const originalFlag = process.env.ENABLE_DOMAIN_BLOCKLIST;
const flag = (on: boolean) => {
  process.env.ENABLE_DOMAIN_BLOCKLIST = on ? "true" : "false";
};
const storeMode = (value: unknown) => fake.T("setting").push({ key: "sendingDomainMode", value });

beforeEach(() => {
  fake.reset();
  flag(false);
});
afterAll(() => {
  if (originalFlag === undefined) delete process.env.ENABLE_DOMAIN_BLOCKLIST;
  else process.env.ENABLE_DOMAIN_BLOCKLIST = originalFlag;
});

const ALLOW = (...allowed: string[]) => ({ mode: "ALLOWLIST" as const, allowed });
const BLOCK = (...blocked: string[]) => ({ mode: "BLOCKLIST" as const, blocked });
const verdict = (email: string, p: ReturnType<typeof ALLOW> | ReturnType<typeof BLOCK>) => {
  const v = checkEmailDomain(email, p);
  return v.ok ? "ok" : v.reason;
};

describe("ENABLE_DOMAIN_BLOCKLIST is a kill switch only (the switch itself is in the UI)", () => {
  it("unset, empty or true: available", () => {
    delete process.env.ENABLE_DOMAIN_BLOCKLIST;
    expect(isDomainBlocklistEnabled()).toBe(true);
    for (const v of ["", "  ", "true", "1", "yes"]) {
      process.env.ENABLE_DOMAIN_BLOCKLIST = v;
      expect(isDomainBlocklistEnabled(), JSON.stringify(v)).toBe(true);
    }
  });

  it("false, 0, no or off (any case): killed", () => {
    for (const v of ["false", "FALSE", " false ", "0", "no", "off"]) {
      process.env.ENABLE_DOMAIN_BLOCKLIST = v;
      expect(isDomainBlocklistEnabled(), JSON.stringify(v)).toBe(false);
    }
  });

  it("available but never switched (the default on every install): today's rule", async () => {
    delete process.env.ENABLE_DOMAIN_BLOCKLIST;
    fake.T("allowedDomain").push({ id: "a1", domain: "ok.com" });
    expect(await policy.getDomainMode()).toBe("ALLOWLIST");
    expect(await isEmailDomainAllowed("a@ok.com")).toBe(true);
    expect(await isEmailDomainAllowed("a@other.com")).toBe(false);
    expect(await policy.domainSkipReason("a@other.com")).toBe("domain not approved");
    expect(fake.model("blockedSendingDomain").findMany).not.toHaveBeenCalled();
  });
});

describe("ALLOWLIST mode — the rule as it was", () => {
  const p = ALLOW("gmail.com", "kagzso.com");

  it("allows listed domains, case-insensitively", () => {
    expect(verdict("a@gmail.com", p)).toBe("ok");
    expect(verdict("A@GMAIL.COM", p)).toBe("ok");
    expect(verdict("a@KAGZSO.com", p)).toBe("ok");
  });

  it("refuses other domains", () => {
    expect(verdict("a@evil.com", p)).toBe("not_approved");
  });

  it("is an exact match: a subdomain of an approved domain is not approved", () => {
    expect(verdict("a@mail.gmail.com", p)).toBe("not_approved");
  });

  it("refuses invalid and missing addresses when there is a list", () => {
    expect(verdict("garbage", p)).toBe("not_approved");
    expect(verdict("a@", p)).toBe("not_approved");
    expect(verdict("", p)).toBe("not_approved");
  });

  it("an empty list is no restriction, as before", () => {
    expect(verdict("a@anything.dev", ALLOW())).toBe("ok");
    expect(verdict("garbage", ALLOW())).toBe("ok");
  });

  it("gives exactly the answer domainAllowed always gave", () => {
    const emails = ["a@gmail.com", "A@Gmail.Com", "a@x.gmail.com", "a@evil.com", "garbage", "", "a@", "@gmail.com"];
    for (const list of [[], ["gmail.com"], ["gmail.com", "kagzso.com"]]) {
      for (const email of emails) {
        expect(checkEmailDomain(email, ALLOW(...list)).ok, `${email} vs [${list}]`).toBe(domainAllowed(email, list));
      }
    }
  });
});

describe("BLOCKLIST mode", () => {
  const p = BLOCK("mailinator.com", "tempmail.com");

  it("allows every domain that isn't blocked", () => {
    for (const email of ["a@gmail.com", "b@kagzso.com", "c@unknown-startup.io"]) expect(verdict(email, p)).toBe("ok");
  });

  it("blocks listed domains", () => {
    expect(verdict("x@mailinator.com", p)).toBe("blocked");
    expect(verdict("y@tempmail.com", p)).toBe("blocked");
  });

  it("matches uppercase addresses and entries, and ignores surrounding spaces", () => {
    expect(verdict("X@MAILINATOR.COM", p)).toBe("blocked");
    expect(verdict("x@mailinator.com", BLOCK("MailInator.COM"))).toBe("blocked");
    expect(verdict("  x@mailinator.com ", p)).toBe("blocked");
  });

  it("blocks subdomains of a blocked domain", () => {
    expect(verdict("a@eu.mailinator.com", p)).toBe("blocked");
    expect(verdict("a@a.b.mailinator.com", p)).toBe("blocked");
    expect(verdict("a@mailinator.com.", p)).toBe("blocked"); // trailing dot
  });

  it("does not block look-alike domains", () => {
    expect(verdict("a@notmailinator.com", p)).toBe("ok");
    expect(verdict("a@mailinator.com.evil.io", p)).toBe("ok");
    expect(verdict("a@mailinator.co", p)).toBe("ok");
  });

  it("refuses invalid addresses", () => {
    for (const email of ["garbage", "a@", "@gmail.com", "a@nodot", "a b@x.com", "a@b@x.com"]) {
      expect(verdict(email, p), email).toBe("invalid");
    }
  });

  it("refuses a missing address", () => {
    expect(verdict("", p)).toBe("invalid");
    expect(verdict("   ", p)).toBe("invalid");
  });

  it("an empty blocked list emails every valid address (still refusing invalid ones)", () => {
    expect(verdict("a@mailinator.com", BLOCK())).toBe("ok");
    expect(verdict("garbage", BLOCK())).toBe("invalid");
  });

  it("ignores blank entries", () => {
    expect(domainBlocked("a@x.com", ["", "  "])).toBe(false);
  });
});

describe("loading the active policy", () => {
  beforeEach(() => {
    fake.T("allowedDomain").push({ id: "a1", domain: "ok.com" });
    fake.T("blockedSendingDomain").push({ id: "b1", domain: "mailinator.com" });
  });

  it("flag off: the Approved list only; the mode and the Blocked list are never read, even when a mode is stored", async () => {
    storeMode("BLOCKLIST");
    expect(await policy.getDomainMode()).toBe("ALLOWLIST");
    expect(await policy.loadDomainPolicy()).toEqual({ mode: "ALLOWLIST", allowed: ["ok.com"] });
    expect(await isEmailDomainAllowed("a@ok.com")).toBe(true);
    expect(await isEmailDomainAllowed("a@other.com")).toBe(false);
    expect(fake.model("setting").findUnique).not.toHaveBeenCalled();
    expect(fake.model("blockedSendingDomain").findMany).not.toHaveBeenCalled();
  });

  it("flag on, nothing stored (every existing install): ALLOWLIST with the same answers", async () => {
    flag(true);
    expect(await policy.getDomainMode()).toBe("ALLOWLIST");
    expect(await isEmailDomainAllowed("a@ok.com")).toBe(true);
    expect(await isEmailDomainAllowed("a@other.com")).toBe(false);
    expect(fake.model("blockedSendingDomain").findMany).not.toHaveBeenCalled();
  });

  it("flag on, BLOCKLIST stored: the Blocked list only", async () => {
    flag(true);
    storeMode("BLOCKLIST");
    expect(await policy.loadDomainPolicy()).toEqual({ mode: "BLOCKLIST", blocked: ["mailinator.com"] });
    expect(await isEmailDomainAllowed("a@other.com")).toBe(true);
    expect(await isEmailDomainAllowed("a@sub.mailinator.com")).toBe(false);
    expect(fake.model("allowedDomain").findMany).not.toHaveBeenCalled();
  });

  it("an unknown stored value counts as ALLOWLIST", async () => {
    flag(true);
    storeMode("OPEN");
    expect(await policy.getDomainMode()).toBe("ALLOWLIST");
  });

  it("is read fresh every time: switching back applies at once", async () => {
    flag(true);
    storeMode("BLOCKLIST");
    expect(await isEmailDomainAllowed("a@other.com")).toBe(true);
    fake.T("setting")[0]!.value = "ALLOWLIST";
    expect(await isEmailDomainAllowed("a@other.com")).toBe(false);
  });
});

describe("skip wording", () => {
  it("flag off: exactly the old texts, with nothing read", async () => {
    expect(await policy.domainSkipReason("a@x.com")).toBe("domain not approved");
    expect(await policy.domainSkipText("a@x.com")).toBe("email domain is not on the approved sending list");
    expect(await policy.domainRefusedMessage("a@x.com")).toBe("Email domain is not on the approved sending list: a@x.com");
    expect(fake.model("setting").findUnique).not.toHaveBeenCalled();
  });

  it("flag on, ALLOWLIST: the same old texts", async () => {
    flag(true);
    expect(await policy.domainSkipReason("a@x.com")).toBe("domain not approved");
    expect(await policy.domainSkipText("a@x.com")).toBe("email domain is not on the approved sending list");
  });

  it("BLOCKLIST: says blocked, or invalid", async () => {
    flag(true);
    storeMode("BLOCKLIST");
    expect(await policy.domainSkipReason("a@mailinator.com")).toBe("domain blocked");
    expect(await policy.domainSkipText("a@mailinator.com")).toBe("email domain is on the blocked sending list");
    expect(await policy.domainRefusedMessage("a@mailinator.com")).toBe(
      "Email domain is on the blocked sending list: a@mailinator.com",
    );
    expect(await policy.domainSkipReason("garbage")).toBe("invalid email address");
    expect(await policy.domainSkipText("garbage")).toBe("email address is not valid");
  });

  it("mode unreadable: falls back to the old texts", async () => {
    flag(true);
    fake.model("setting").findUnique.mockRejectedValueOnce(new Error("db down"));
    expect(await policy.domainSkipReason("a@x.com")).toBe("domain not approved");
  });
});
