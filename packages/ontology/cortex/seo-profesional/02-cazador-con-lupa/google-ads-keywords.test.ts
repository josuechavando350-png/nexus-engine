import { describe, expect, it, vi } from "vitest";
import {
  ExactMatchGoogleAdsError,
  GoogleAdsExactMatchClient,
} from "./google-ads-keywords.js";
import {
  selectExactMatchCandidates,
  type ExactMatchCandidate,
  type SearchTermObservation,
} from "./search-term-synthesizer.js";

function client(fetchImpl: typeof fetch) {
  return new GoogleAdsExactMatchClient({
    developerToken: "developer-token-real-shape",
    loginCustomerId: "999-888-7777",
    accessTokenProvider: async () => "oauth-access-token-real-shape-123456",
    fetchImpl,
    maxReadRetries: 0,
  });
}

function candidate(searchTerm: string, campaignId = "1111111111", adGroupId = "2222222222"): ExactMatchCandidate {
  const observation: SearchTermObservation = {
    campaignId,
    adGroupId,
    searchTerm,
    targetingStatus: "NONE",
    searchTermMatchType: "BROAD",
    impressions: 100,
    clicks: 20,
    conversions: 4,
    conversionValue: 100,
    costMicros: 20_000_000,
  };
  const selected = selectExactMatchCandidates([observation], {
    startDate: "2026-08-01",
    endDate: "2026-08-31",
    minimumClicks: 1,
    minimumConversions: 1,
    minimumConversionRate: 0,
    maximumCandidates: 10,
  }).selected;
  if (!selected[0]) throw new Error("test candidate was not selected");
  return selected[0];
}

describe("GoogleAdsExactMatchClient search terms", () => {
  it("reads search_term_view through the documented paginated v25 search endpoint", async () => {
    const requests: Array<{ url: string; init: RequestInit; body: Record<string, unknown> }> = [];
    const fetchImpl: typeof fetch = vi.fn(async (input, init) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      requests.push({ url: String(input), init: init ?? {}, body });
      const pageToken = body.pageToken;
      if (!pageToken) {
        return new Response(JSON.stringify({
          results: [{
            campaign: { id: "1111111111" },
            adGroup: { id: "2222222222" },
            searchTermView: { searchTerm: "abogado penalista cdmx", status: "NONE" },
            segments: { searchTermMatchType: "BROAD" },
            metrics: { impressions: "100", clicks: "20", conversions: 4, conversionsValue: 100, costMicros: "20000000" },
          }],
          nextPageToken: "page-2-token",
        }), { status: 200, headers: { "content-type": "application/json", "request-id": "search-1" } });
      }
      expect(pageToken).toBe("page-2-token");
      return new Response(JSON.stringify({
        results: [{
          campaign: { id: "1111111111" },
          adGroup: { id: "3333333333" },
          searchTermView: { searchTerm: "defensa penal urgente", status: "NONE" },
          segments: { searchTermMatchType: "NEAR_EXACT" },
          metrics: { impressions: "50", clicks: "10", conversions: "2", conversionsValue: "40", costMicros: "10000000" },
        }],
      }), { status: 200, headers: { "content-type": "application/json", "request-id": "search-2" } });
    });

    const rows = await client(fetchImpl).fetchSearchTermObservations("123-456-7890", {
      startDate: "2026-08-01",
      endDate: "2026-08-31",
      campaignIds: ["1111111111"],
    });

    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ searchTerm: "abogado penalista cdmx", clicks: 20, conversions: 4, costMicros: 20_000_000 });
    expect(rows[1]).toMatchObject({ searchTerm: "defensa penal urgente", searchTermMatchType: "NEAR_EXACT", clicks: 10 });
    expect(requests).toHaveLength(2);
    expect(requests[0]!.url).toBe("https://googleads.googleapis.com/v25/customers/1234567890/googleAds:search");
    expect(requests[0]!.init.method).toBe("POST");
    expect(requests[0]!.init.redirect).toBe("error");
    expect(requests[0]!.init.headers).toMatchObject({
      authorization: "Bearer oauth-access-token-real-shape-123456",
      "developer-token": "developer-token-real-shape",
      "login-customer-id": "9998887777",
    });
    expect(requests[0]!.body).not.toHaveProperty("pageSize");
    expect(String(requests[0]!.body.query)).toContain("FROM search_term_view");
    expect(String(requests[0]!.body.query)).toContain("campaign.id = 1111111111");
    expect(requests[1]!.body.pageToken).toBe("page-2-token");
  });
});

describe("GoogleAdsExactMatchClient materialization", () => {
  it("skips an existing exact keyword and atomically creates a paused single-intent ad group plus exact keyword for the new term", async () => {
    const existingCandidate = candidate("abogado penalista cdmx");
    const newCandidate = candidate("defensa penal urgente", "1111111111", "3333333333");
    const requests: Array<{ url: string; body: Record<string, unknown> }> = [];
    const fetchImpl: typeof fetch = vi.fn(async (input, init) => {
      const url = String(input);
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      requests.push({ url, body });
      if (url.endsWith("/googleAds:search")) {
        return new Response(JSON.stringify({
          results: [{
            campaign: { id: "1111111111" },
            adGroup: { id: "4444444444" },
            adGroupCriterion: {
              resourceName: "customers/1234567890/adGroupCriteria/4444444444~5555555555",
              keyword: { text: "Abogado Penalista CDMX" },
            },
          }],
        }), { status: 200, headers: { "content-type": "application/json", "request-id": "existing-1" } });
      }
      return new Response(JSON.stringify({
        mutateOperationResponses: [
          { adGroupResult: { resourceName: "customers/1234567890/adGroups/7000000001" } },
          { adGroupCriterionResult: { resourceName: "customers/1234567890/adGroupCriteria/7000000001~8000000001" } },
        ],
      }), { status: 200, headers: { "content-type": "application/json", "request-id": "mutate-1" } });
    });

    const receipt = await client(fetchImpl).materializeExactMatches("123-456-7890", [existingCandidate, newCandidate], {
      executionMode: "APPLY",
      adGroupNamePrefix: "NEXUS EXACT",
    });

    expect(receipt.status).toBe("APPLIED");
    expect(receipt.skipped).toEqual([expect.objectContaining({
      searchTerm: "abogado penalista cdmx",
      reason: "EXACT_KEYWORD_ALREADY_EXISTS",
      existingResourceName: "customers/1234567890/adGroupCriteria/4444444444~5555555555",
    })]);
    expect(receipt.materialized).toEqual([expect.objectContaining({
      searchTerm: "defensa penal urgente",
      adGroupResourceName: "customers/1234567890/adGroups/7000000001",
      criterionResourceName: "customers/1234567890/adGroupCriteria/7000000001~8000000001",
    })]);
    expect(requests).toHaveLength(2);
    expect(requests[1]!.url).toBe("https://googleads.googleapis.com/v25/customers/1234567890/googleAds:mutate");
    expect(requests[1]!.body).toMatchObject({ partialFailure: false, validateOnly: false });
    const operations = requests[1]!.body.mutateOperations as Array<Record<string, unknown>>;
    expect(operations).toHaveLength(2);
    expect(operations[0]).toEqual({
      adGroupOperation: {
        create: {
          resourceName: "customers/1234567890/adGroups/-1",
          campaign: "customers/1234567890/campaigns/1111111111",
          name: expect.stringMatching(/^NEXUS EXACT \| defensa penal urgente \| [a-f0-9]{12}$/u),
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
          keyword: { text: "defensa penal urgente", matchType: "EXACT" },
        },
      },
    });
  });

  it("supports validate-only while still exercising Google's real mutation contract", async () => {
    const newCandidate = candidate("defensa penal urgente");
    const fetchImpl: typeof fetch = vi.fn(async (input, init) => {
      const url = String(input);
      if (url.endsWith("/googleAds:search")) return new Response(JSON.stringify({ results: [] }), { status: 200 });
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      expect(body.validateOnly).toBe(true);
      expect(body.partialFailure).toBe(false);
      return new Response(JSON.stringify({}), { status: 200, headers: { "request-id": "validate-1" } });
    });

    const receipt = await client(fetchImpl).materializeExactMatches("1234567890", [newCandidate], { executionMode: "VALIDATE_ONLY" });
    expect(receipt).toMatchObject({ status: "VALIDATED", requestId: "validate-1", materialized: [] });
    expect(receipt.planned).toHaveLength(1);
  });

  it("does not blindly retry an ambiguous mutation after Google returns a server failure", async () => {
    const newCandidate = candidate("defensa penal urgente");
    let mutationCalls = 0;
    const fetchImpl: typeof fetch = vi.fn(async (input) => {
      const url = String(input);
      if (url.endsWith("/googleAds:search")) return new Response(JSON.stringify({ results: [] }), { status: 200 });
      mutationCalls += 1;
      return new Response(JSON.stringify({ error: { status: "INTERNAL", message: "temporary server failure" } }), {
        status: 503,
        headers: { "content-type": "application/json", "request-id": "mutate-503" },
      });
    });

    await expect(client(fetchImpl).materializeExactMatches("1234567890", [newCandidate], { executionMode: "APPLY" })).rejects.toMatchObject({
      code: "AMBIGUOUS_MUTATION_OUTCOME",
      requestId: "mutate-503",
    });
    expect(mutationCalls).toBe(1);
  });

  it("requires an explicit execution mode instead of silently mutating", async () => {
    const newCandidate = candidate("defensa penal urgente");
    const fetchImpl: typeof fetch = vi.fn();
    await expect(client(fetchImpl).materializeExactMatches("1234567890", [newCandidate], {} as never)).rejects.toBeInstanceOf(ExactMatchGoogleAdsError);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
