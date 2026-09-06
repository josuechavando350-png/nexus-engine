import { describe, expect, it, vi } from "vitest";
import { HttpProgrammaticSeoCatalogProvider, ProgrammaticSeoCatalogTransportError } from "./http-catalog-provider";

const TOKEN = "t".repeat(40);
const SITE_ID = "cano-penal";
const OBSERVED_AT = "2026-09-05T23:00:00.000Z";
const catalog = {
  sourceId: "cms",
  siteId: SITE_ID,
  baseUrl: "https://example.test/",
  observedAt: OBSERVED_AT,
  pages: [{
    pageId: "home",
    routeSegments: [],
    parentPageId: null,
    locale: "es-MX",
    title: "Example",
    description: "Example description for a verified governed page.",
    heading: "Example heading",
    bodyText: "Example heading. This page contains verified service information. Home-only distinctive statement.",
    distinctiveStatements: ["Home-only distinctive statement."],
    evidenceRefs: ["cms:home:v1"],
    updatedAt: OBSERVED_AT,
    indexable: true,
  }],
};

function response(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
}

describe("HttpProgrammaticSeoCatalogProvider", () => {
  it("binds request and response to the exact site and validates the governed catalog", async () => {
    const calls: Array<Parameters<typeof fetch>> = [];
    const fetchImpl = vi.fn(async (...args: Parameters<typeof fetch>) => {
      calls.push(args);
      return response(catalog);
    }) as typeof fetch;
    const provider = new HttpProgrammaticSeoCatalogProvider({ endpoint: "https://catalog.example.test/v1/catalog", bearerToken: TOKEN, maxRouteDepth: 8, fetchImpl });
    const result = await provider.getCatalog(SITE_ID);
    expect(result.siteId).toBe(SITE_ID);
    expect(result.baseUrl).toBe("https://example.test/");
    expect(result.digest).toMatch(/^sha256:[a-f0-9]{64}$/u);
    expect(calls[0]?.[1]?.body).toBe(JSON.stringify({ siteId: SITE_ID }));
  });

  it("rejects a response for another site", async () => {
    const provider = new HttpProgrammaticSeoCatalogProvider({
      endpoint: "https://catalog.example.test/v1/catalog",
      bearerToken: TOKEN,
      maxRouteDepth: 8,
      fetchImpl: (async () => response({ ...catalog, siteId: "other-site" })) as typeof fetch,
    });
    await expect(provider.getCatalog(SITE_ID)).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
  });

  it.each(["http://catalog.example.test/v1/catalog", "https://u:p@catalog.example.test/v1/catalog", "https://catalog.example.test/v1/catalog#x"])("rejects unsafe endpoint %s", (endpoint) => {
    expect(() => new HttpProgrammaticSeoCatalogProvider({ endpoint, bearerToken: TOKEN, maxRouteDepth: 8 })).toThrow(ProgrammaticSeoCatalogTransportError);
  });

  it("fails closed on malformed semantic content", async () => {
    const provider = new HttpProgrammaticSeoCatalogProvider({
      endpoint: "https://catalog.example.test/v1/catalog",
      bearerToken: TOKEN,
      maxRouteDepth: 8,
      fetchImpl: (async () => response({ ...catalog, baseUrl: "https://user:pass@example.test/" })) as typeof fetch,
    });
    await expect(provider.getCatalog(SITE_ID)).rejects.toBeInstanceOf(ProgrammaticSeoCatalogTransportError);
  });
});
