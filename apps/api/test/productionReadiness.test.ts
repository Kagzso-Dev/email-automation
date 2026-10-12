import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import express from "express";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { productionConfigWarnings } from "../src/config/productionChecks.js";
import { securityHeaders } from "../src/http/securityHeaders.js";

const strong = "x".repeat(40);
const good = {
  NODE_ENV: "production" as const,
  PUBLIC_API_URL: "https://api.example.com",
  WEB_ORIGIN: "https://app.example.com",
  EMAIL_PROVIDER: "smtp" as const,
  JWT_ACCESS_SECRET: strong,
  JWT_REFRESH_SECRET: "y".repeat(40),
  LINK_SIGNING_SECRET: "z".repeat(40),
};

describe("productionConfigWarnings", () => {
  it("no warnings outside production, whatever the values", () => {
    expect(productionConfigWarnings({ ...good, NODE_ENV: "development", EMAIL_PROVIDER: "mock", PUBLIC_API_URL: "http://localhost:4000" })).toEqual([]);
  });

  it("no warnings for a good production config", () => {
    expect(productionConfigWarnings(good)).toEqual([]);
  });

  it("flags localhost URLs, mock email, short and shared secrets — names only, never values", () => {
    const w = productionConfigWarnings({
      ...good,
      PUBLIC_API_URL: "http://localhost:4000",
      WEB_ORIGIN: "https://app.example.com,http://localhost:5173",
      EMAIL_PROVIDER: "mock",
      JWT_ACCESS_SECRET: "short-secret",
      JWT_REFRESH_SECRET: "short-secret",
    });
    expect(w).toEqual([
      "PUBLIC_API_URL points at localhost — tracking, unsubscribe and media links will not work for recipients",
      "WEB_ORIGIN includes localhost",
      "EMAIL_PROVIDER is mock — emails are saved locally, not sent",
      "JWT_ACCESS_SECRET is shorter than 32 characters",
      "JWT_REFRESH_SECRET is shorter than 32 characters",
      "JWT_ACCESS_SECRET and JWT_REFRESH_SECRET are the same",
    ]);
    expect(w.join(" ")).not.toContain("short-secret");
  });

  it("flags a non-https public URL", () => {
    expect(productionConfigWarnings({ ...good, PUBLIC_API_URL: "http://api.example.com" })).toEqual(["PUBLIC_API_URL is not https"]);
  });
});

describe("securityHeaders", () => {
  let server: Server;
  let base = "";
  beforeAll(() => {
    const app = express();
    app.disable("x-powered-by");
    app.use(securityHeaders);
    app.get("/plain", (_req, res) => res.json({ ok: true }));
    // A route that sets its own stricter headers keeps them (like WhatsApp media).
    app.get("/own", (_req, res) => {
      res.setHeader("X-Frame-Options", "SAMEORIGIN");
      res.send("x");
    });
    server = app.listen(0);
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => new Promise<void>((r) => server.close(() => r())));

  it("adds the baseline headers and hides x-powered-by", async () => {
    const res = await fetch(`${base}/plain`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("x-frame-options")).toBe("DENY");
    expect(res.headers.get("referrer-policy")).toBe("strict-origin-when-cross-origin");
    expect(res.headers.get("x-powered-by")).toBeNull();
  });

  it("a route can still override a header", async () => {
    expect((await fetch(`${base}/own`)).headers.get("x-frame-options")).toBe("SAMEORIGIN");
  });
});
