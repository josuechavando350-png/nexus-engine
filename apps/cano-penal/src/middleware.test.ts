import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest, type NextFetchEvent } from "next/server";
import { AD_CONTEXT_HEADERS } from "./ad-context";
import { middleware } from "./middleware";

const previousMode = process.env.NEXUS_AD_CONTEXT_MODE;
const previousEndpoint = process.env.NEXUS_AD_CONTEXT_CONTROL_ENDPOINT;
const previousToken = process.env.NEXUS_AD_CONTEXT_EDGE_TOKEN;
const edgeToken = "edge-token-0000000000000000000000000000000001";

function event(): NextFetchEvent {
  return { waitUntil: vi.fn(), passThroughOnException: vi.fn() } as unknown as NextFetchEvent;
}

function runtime(mode: "ACTIVE" | "OBSERVE_ONLY" | "KILLED" = "ACTIVE") {
  vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
    const url = String(input);
    if (url.endsWith("/v1/ad-context/runtime")) {
      return Response.json({
        policyId: "cano-paid-landing-v1",
        mode,
        revision: 1,
        digest: `sha256:${"a".repeat(64)}`,
      });
    }
    if (url.endsWith("/v1/ad-context/observe")) return Response.json({ accepted: true }, { status: 202 });
    throw new Error(`unexpected URL ${url}`);
  }));
}

beforeEach(() => {
  delete process.env.NEXUS_AD_CONTEXT_MODE;
  process.env.NEXUS_AD_CONTEXT_CONTROL_ENDPOINT = "https://control.example.test";
  process.env.NEXUS_AD_CONTEXT_EDGE_TOKEN = edgeToken;
  runtime("ACTIVE");
});

afterEach(() => {
  vi.unstubAllGlobals();
  if (previousMode === undefined) delete process.env.NEXUS_AD_CONTEXT_MODE;
  else process.env.NEXUS_AD_CONTEXT_MODE = previousMode;
  if (previousEndpoint === undefined) delete process.env.NEXUS_AD_CONTEXT_CONTROL_ENDPOINT;
  else process.env.NEXUS_AD_CONTEXT_CONTROL_ENDPOINT = previousEndpoint;
  if (previousToken === undefined) delete process.env.NEXUS_AD_CONTEXT_EDGE_TOKEN;
  else process.env.NEXUS_AD_CONTEXT_EDGE_TOKEN = previousToken;
});

describe("CANO ad-context edge middleware", () => {
  it("leaves direct traffic on the default experience without disabling shared caching", async () => {
    const response = await middleware(new NextRequest("https://cano.test/"), event());
    expect(response.headers.get(AD_CONTEXT_HEADERS.experience)).toBe("default");
    expect(response.headers.get(AD_CONTEXT_HEADERS.channel)).toBe("DIRECT_OR_UNKNOWN");
    expect(response.headers.get(AD_CONTEXT_HEADERS.applied)).toBe("0");
    expect(response.headers.get("cache-control")).toBeNull();
  });

  it("serves paid-search context for a real Google click signal and prevents cache bleed", async () => {
    const rawClickId = "EAIaIQobChMI-production-shaped-click-id";
    const response = await middleware(new NextRequest(`https://cano.test/?gclid=${rawClickId}`), event());
    expect(response.headers.get(AD_CONTEXT_HEADERS.experience)).toBe("paid-search");
    expect(response.headers.get(AD_CONTEXT_HEADERS.channel)).toBe("PAID_SEARCH");
    expect(response.headers.get(AD_CONTEXT_HEADERS.applied)).toBe("1");
    expect(response.headers.get("cache-control")).toBe("private, no-store, max-age=0");
    expect(JSON.stringify([...response.headers.entries()])).not.toContain(rawClickId);
  });

  it("overwrites attacker-supplied internal context instead of trusting it", async () => {
    const request = new NextRequest("https://cano.test/?gclid=safe-search-signal", {
      headers: {
        [AD_CONTEXT_HEADERS.experience]: "attacker-experience",
        [AD_CONTEXT_HEADERS.channel]: "PAID_SOCIAL",
        [AD_CONTEXT_HEADERS.reason]: "EXACT_RULE_MATCH",
        [AD_CONTEXT_HEADERS.applied]: "0",
      },
    });
    const response = await middleware(request, event());
    expect(response.headers.get(AD_CONTEXT_HEADERS.experience)).toBe("paid-search");
    expect(response.headers.get(AD_CONTEXT_HEADERS.channel)).toBe("PAID_SEARCH");
    expect(response.headers.get(AD_CONTEXT_HEADERS.applied)).toBe("1");
  });

  it("fails closed when control is unavailable and preserves an emergency kill switch", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("control unavailable"); }));
    const unavailable = await middleware(new NextRequest("https://cano.test/?gclid=search-signal"), event());
    expect(unavailable.headers.get(AD_CONTEXT_HEADERS.experience)).toBe("default");
    expect(unavailable.headers.get(AD_CONTEXT_HEADERS.applied)).toBe("0");

    runtime("ACTIVE");
    process.env.NEXUS_AD_CONTEXT_MODE = "KILLED";
    const killed = await middleware(new NextRequest("https://cano.test/?utm_source=google&utm_medium=cpc"), event());
    expect(killed.headers.get(AD_CONTEXT_HEADERS.experience)).toBe("default");
    expect(killed.headers.get(AD_CONTEXT_HEADERS.applied)).toBe("0");
  });

  it("fails closed while streaming an oversized control response without Content-Length", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (!url.endsWith("/v1/ad-context/runtime")) throw new Error(`unexpected URL ${url}`);
      const oversized = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("x".repeat(4_097)));
          controller.close();
        },
      });
      return new Response(oversized, { status: 200, headers: { "content-type": "application/json" } });
    }));
    const response = await middleware(new NextRequest("https://cano.test/?gclid=search-signal"), event());
    expect(response.headers.get(AD_CONTEXT_HEADERS.experience)).toBe("default");
    expect(response.headers.get(AD_CONTEXT_HEADERS.applied)).toBe("0");
  });
});
