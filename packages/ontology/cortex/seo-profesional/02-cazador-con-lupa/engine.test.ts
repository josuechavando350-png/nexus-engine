import { describe, expect, it, vi } from "vitest";
import { ExactMatchSynthesizerEngine } from "./engine.js";
import { GoogleAdsExactMatchClient } from "./google-ads-keywords.js";

function response(body: unknown, requestId: string): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json", "request-id": requestId },
  });
}

describe("ExactMatchSynthesizerEngine", () => {
  it("runs search-term evidence through selection, duplicate inventory and Google's validate-only mutation contract", async () => {
    const requests: Array<{ url: string; body: Record<string, unknown> }> = [];
    const fetchImpl: typeof fetch = vi.fn(async (input, init) => {
      const url = String(input);
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      requests.push({ url, body });

      if (url.endsWith("/googleAds:search")) {
        const query = String(body.query ?? "");
        if (query.includes("FROM search_term_view")) {
          return response({
            results: [
              {
                campaign: { id: "1111111111" },
                adGroup: { id: "2222222222" },
                searchTermView: { searchTerm: "abogado penalista cdmx", status: "NONE" },
                segments: { searchTermMatchType: "BROAD" },
                metrics: {
                  impressions: "200",
                  clicks: "30",
                  conversions: 6,
                  conversionsValue: 180,
                  costMicros: "30000000",
                },
              },
              {
                campaign: { id: "1111111111" },
                adGroup: { id: "3333333333" },
                searchTermView: { searchTerm: "consulta sin conversion", status: "NONE" },
                segments: { searchTermMatchType: "PHRASE" },
                metrics: {
                  impressions: "100",
                  clicks: "20",
                  conversions: 0,
                  conversionsValue: 0,
                  costMicros: "10000000",
                },
              },
            ],
          }, "terms-1");
        }
        if (query.includes("FROM ad_group_criterion")) return response({ results: [] }, "inventory-1");
        throw new Error(`unexpected search query: ${query}`);
      }

      if (url.endsWith("/googleAds:mutate")) {
        expect(body.validateOnly).toBe(true);
        expect(body.partialFailure).toBe(false);
        const operations = body.mutateOperations as Array<Record<string, unknown>>;
        expect(operations).toHaveLength(2);
        expect(operations[0]).toMatchObject({
          adGroupOperation: {
            create: {
              resourceName: "customers/1234567890/adGroups/-1",
              campaign: "customers/1234567890/campaigns/1111111111",
              status: "PAUSED",
              type: "SEARCH_STANDARD",
            },
          },
        });
        expect(operations[1]).toEqual({
          adGroupCriterionOperation: {
            create: {
              adGroup: "customers/1234567890/adGroups/-1",
              status: "ENABLED",
              negative: false,
              keyword: { text: "abogado penalista cdmx", matchType: "EXACT" },
            },
          },
        });
        return response({}, "validate-1");
      }

      throw new Error(`unexpected URL: ${url}`);
    });

    const client = new GoogleAdsExactMatchClient({
      developerToken: "developer-token-real-shape",
      accessTokenProvider: async () => "oauth-access-token-real-shape-123456",
      fetchImpl,
      maxReadRetries: 0,
    });
    const engine = new ExactMatchSynthesizerEngine(client);

    const result = await engine.run({
      customerId: "123-456-7890",
      campaignIds: ["1111111111"],
      policy: {
        startDate: "2026-08-01",
        endDate: "2026-08-31",
        minimumClicks: 10,
        minimumConversions: 2,
        minimumConversionRate: 0.1,
        maximumCostPerConversionMicros: 6_000_000,
        minimumConversionValuePerCost: 2,
        maximumCandidates: 10,
      },
      materialization: { executionMode: "VALIDATE_ONLY", adGroupNamePrefix: "NEXUS EXACT" },
    });

    expect(result.observationCount).toBe(2);
    expect(result.selection.selected).toHaveLength(1);
    expect(result.selection.selected[0]).toMatchObject({ searchTerm: "abogado penalista cdmx", conversions: 6 });
    expect(result.selection.rejected).toEqual([
      expect.objectContaining({
        normalizedSearchTerm: "consulta sin conversion",
        reasons: expect.arrayContaining(["BELOW_MINIMUM_CONVERSIONS", "BELOW_MINIMUM_CONVERSION_RATE"]),
      }),
    ]);
    expect(result.materialization).toMatchObject({
      status: "VALIDATED",
      requestId: "validate-1",
      materialized: [],
    });
    expect(requests.map((request) => request.url)).toEqual([
      "https://googleads.googleapis.com/v25/customers/1234567890/googleAds:search",
      "https://googleads.googleapis.com/v25/customers/1234567890/googleAds:search",
      "https://googleads.googleapis.com/v25/customers/1234567890/googleAds:mutate",
    ]);
  });
});
