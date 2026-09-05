import { afterEach, describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { AD_CONTEXT_HEADERS } from "./ad-context";
import { middleware } from "./middleware";

const previousMode = process.env.NEXUS_AD_CONTEXT_MODE;

afterEach(() => {
  if (previousMode === undefined) delete process.env.NEXUS_AD_CONTEXT_MODE;
  else process.env.NEXUS_AD_CONTEXT_MODE = previousMode;
});

describe("CANO ad-context edge middleware", () => {
  it("leaves direct traffic on the default experience without disabling shared caching", () => {
    delete process.env.NEXUS_AD_CONTEXT_MODE;
    const response = middleware(new NextRequest("https://cano.test/"));
    expect(response.headers.get(AD_CONTEXT_HEADERS.experience)).toBe("default");
    expect(response.headers.get(AD_CONTEXT_HEADERS.channel)).toBe("DIRECT_OR_UNKNOWN");
    expect(response.headers.get(AD_CONTEXT_HEADERS.applied)).toBe("0");
    expect(response.headers.get("cache-control")).toBeNull();
  });

  it("serves paid-search context for a real Google click signal and prevents cache bleed", () => {
    const rawClickId = "EAIaIQobChMI-production-shaped-click-id";
    const response = middleware(new NextRequest(`https://cano.test/?gclid=${rawClickId}`));
    expect(response.headers.get(AD_CONTEXT_HEADERS.experience)).toBe("paid-search");
    expect(response.headers.get(AD_CONTEXT_HEADERS.channel)).toBe("PAID_SEARCH");
    expect(response.headers.get(AD_CONTEXT_HEADERS.applied)).toBe("1");
    expect(response.headers.get("cache-control")).toBe("private, no-store, max-age=0");
    expect(JSON.stringify([...response.headers.entries()])).not.toContain(rawClickId);
  });

  it("overwrites attacker-supplied internal context instead of trusting it", () => {
    const request = new NextRequest("https://cano.test/?gclid=safe-search-signal", {
      headers: {
        [AD_CONTEXT_HEADERS.experience]: "attacker-experience",
        [AD_CONTEXT_HEADERS.channel]: "PAID_SOCIAL",
        [AD_CONTEXT_HEADERS.reason]: "EXACT_RULE_MATCH",
        [AD_CONTEXT_HEADERS.applied]: "0",
      },
    });
    const response = middleware(request);
    expect(response.headers.get(AD_CONTEXT_HEADERS.experience)).toBe("paid-search");
    expect(response.headers.get(AD_CONTEXT_HEADERS.channel)).toBe("PAID_SEARCH");
    expect(response.headers.get(AD_CONTEXT_HEADERS.applied)).toBe("1");
  });

  it("fails closed on an invalid runtime mode and supports the kill switch", () => {
    process.env.NEXUS_AD_CONTEXT_MODE = "unexpected-value";
    const invalid = middleware(new NextRequest("https://cano.test/?gclid=search-signal"));
    expect(invalid.headers.get(AD_CONTEXT_HEADERS.experience)).toBe("default");
    expect(invalid.headers.get(AD_CONTEXT_HEADERS.applied)).toBe("0");

    process.env.NEXUS_AD_CONTEXT_MODE = "KILLED";
    const killed = middleware(new NextRequest("https://cano.test/?utm_source=google&utm_medium=cpc"));
    expect(killed.headers.get(AD_CONTEXT_HEADERS.experience)).toBe("default");
    expect(killed.headers.get(AD_CONTEXT_HEADERS.applied)).toBe("0");
  });
});
