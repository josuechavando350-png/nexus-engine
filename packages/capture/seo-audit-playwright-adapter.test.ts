import { describe, expect, it } from "vitest";
import type { Browser } from "playwright";
import {
  isSeoAuditConnectivityFailure,
  PlaywrightSeoAuditBrowserAdapter,
  SeoAuditPlaywrightAdapterError,
  type SeoAuditPlaywrightLauncher,
} from "./seo-audit-playwright-adapter.js";

const unusedLauncher: SeoAuditPlaywrightLauncher = Object.freeze({
  launch: async () => { throw new Error("not used in constructor tests"); },
});

function browser(value: unknown): Browser {
  return value as Browser;
}

describe("SEO audit network resilience boundary", () => {
  it("accepts a bounded ordered failover list without attempting a connection during construction", () => {
    expect(() => new PlaywrightSeoAuditBrowserAdapter(unusedLauncher, {
      networkProxies: [
        "https://backup-one.example:8443",
        "http://user:password@backup-two.example:8080",
        "socks5://backup-three.example:1080",
      ],
    })).not.toThrow();
  });

  it("rejects proxy lists that could become unbounded routing machinery", () => {
    expect(() => new PlaywrightSeoAuditBrowserAdapter(unusedLauncher, {
      networkProxies: [
        "https://one.example",
        "https://two.example",
        "https://three.example",
        "https://four.example",
        "https://five.example",
      ],
    })).toThrow(SeoAuditPlaywrightAdapterError);
  });

  it("rejects proxy endpoints with paths, queries, fragments, or unsupported schemes", () => {
    for (const endpoint of [
      "https://proxy.example/path",
      "https://proxy.example/?pool=residential",
      "https://proxy.example/#route",
      "ftp://proxy.example:21",
    ]) {
      expect(() => new PlaywrightSeoAuditBrowserAdapter(unusedLauncher, { networkProxies: [endpoint] })).toThrow(/network proxy endpoint/u);
    }
  });

  it("classifies only connectivity failures as eligible for failover", () => {
    expect(isSeoAuditConnectivityFailure(new Error("page.goto: net::ERR_CONNECTION_REFUSED"))).toBe(true);
    expect(isSeoAuditConnectivityFailure(new Error("TimeoutError: page.goto: Timeout 15000ms exceeded."))).toBe(true);
    expect(isSeoAuditConnectivityFailure(new SeoAuditPlaywrightAdapterError("NETWORK_UNAVAILABLE", "offline"))).toBe(true);

    expect(isSeoAuditConnectivityFailure(new Error("HTTP 403 Forbidden"))).toBe(false);
    expect(isSeoAuditConnectivityFailure(new Error("HTTP 429 Too Many Requests"))).toBe(false);
    expect(isSeoAuditConnectivityFailure(new Error("challenge page detected"))).toBe(false);
  });

  it("keeps the launcher contract unchanged for existing dependency injection", async () => {
    const fake = browser({});
    const launcher: SeoAuditPlaywrightLauncher = Object.freeze({ launch: async () => fake });
    expect(await launcher.launch()).toBe(fake);
  });
});
