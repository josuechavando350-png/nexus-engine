import { describe, expect, it, vi } from "vitest";
import { HttpPageInventoryProvider, PageInventoryTransportError } from "./http-page-inventory-provider";

const TOKEN = "t".repeat(40);
const SITE = "https://example.test/";
const snapshot = {
  sourceId: "page-inventory",
  siteUrl: SITE,
  observedAt: "2026-09-05T23:00:00.000Z",
  pages: [{
    pageId: "home",
    url: SITE,
    locale: "en-US",
    siteName: "Example",
    indexable: true,
    canonicalUrl: SITE,
    currentMetadata: {
      title: "Example",
      metaDescription: "Example description for verified page inventory.",
    },
    primaryHeading: "Example heading",
    visibleText: "Example heading. Verified statement about the service and its page content.",
    summaryCandidates: ["Verified statement about the service and its page content."],
  }],
};

function response(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    ...init,
    headers: { "content-type": "application/json", ...(init.headers ?? {}) },
  });
}

describe("HttpPageInventoryProvider", () => {
  it("binds the request and response to the exact site identity", async () => {
    const calls: Array<Parameters<typeof fetch>> = [];
    const fetchImpl = vi.fn(async (...args: Parameters<typeof fetch>) => {
      calls.push(args);
      return response(snapshot);
    }) as typeof fetch;
    const provider = new HttpPageInventoryProvider({ endpoint: "https://inventory.example.test/v1/pages", bearerToken: TOKEN, fetchImpl });
    const result = await provider.getInventory(SITE);
    expect(result.siteUrl).toBe(SITE);
    expect(result.digest).toMatch(/^sha256:[a-f0-9]{64}$/u);
    const [, init] = calls[0]!;
    expect(init?.body).toBe(JSON.stringify({ siteUrl: SITE }));
    expect(init?.headers).toEqual({ authorization: `Bearer ${TOKEN}`, "content-type": "application/json" });
  });

  it("rejects a cross-site response", async () => {
    const provider = new HttpPageInventoryProvider({
      endpoint: "https://inventory.example.test/v1/pages",
      bearerToken: TOKEN,
      fetchImpl: (async () => response({ ...snapshot, siteUrl: "https://attacker.test/" })) as typeof fetch,
    });
    await expect(provider.getInventory(SITE)).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
  });

  it.each(["http://inventory.example.test/v1/pages", "https://user:pass@inventory.example.test/v1/pages", "https://inventory.example.test/v1/pages#x"])("rejects unsafe endpoint %s", (endpoint) => {
    expect(() => new HttpPageInventoryProvider({ endpoint, bearerToken: TOKEN })).toThrow(PageInventoryTransportError);
  });

  it("fails closed on non-JSON and oversized responses", async () => {
    for (const make of [
      () => new Response("ok", { status: 200, headers: { "content-type": "text/plain" } }),
      () => new Response(`"${"x".repeat(2 * 1024 * 1024)}"`, { status: 200, headers: { "content-type": "application/json" } }),
    ]) {
      const provider = new HttpPageInventoryProvider({ endpoint: "https://inventory.example.test/v1/pages", bearerToken: TOKEN, fetchImpl: (async () => make()) as typeof fetch });
      await expect(provider.getInventory(SITE)).rejects.toBeInstanceOf(PageInventoryTransportError);
    }
  });
});
