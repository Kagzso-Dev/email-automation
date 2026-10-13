import { describe, expect, it } from "vitest";
import { createUserInput } from "@dispatch/shared";
import { generatePassword } from "../../web/src/lib/password.js";

// The web "Generate strong password" helper (Settings → Users). Pure, so it
// runs here; the web app has no test runner of its own.

describe("generatePassword", () => {
  it("produces 16 characters that pass the server's password rule", () => {
    for (let i = 0; i < 50; i++) {
      const pw = generatePassword();
      expect(pw).toHaveLength(16);
      expect(createUserInput.safeParse({ email: "a@b.co", role: "EDITOR", password: pw }).success).toBe(true);
    }
  });

  it("avoids look-alike characters and doesn't repeat", () => {
    const many = Array.from({ length: 200 }, () => generatePassword());
    expect(many.join("")).not.toMatch(/[0O1lI]/);
    expect(new Set(many).size).toBe(many.length);
  });
});
