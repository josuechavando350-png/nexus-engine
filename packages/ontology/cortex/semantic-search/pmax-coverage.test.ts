import test from "node:test";
import assert from "node:assert/strict";
import { SqliteSemanticSearchIndex } from "./index.js";
import { GoogleAdsSearchTermCoverageClient, planNegativeKeyword } from "./pmax-coverage.js";

const policy = { minClicks: 3, maxConversions: 0, maxSemanticRelevance: 0.2, topK: 3, minSemanticCoverage: 0.5, matchType: "EXACT" as const, maxManagedNegativesPerCampaign: 50 };

test("planner uses the real CORTEX #15 search index and preserves coverage provenance", async () => {
  const index = new SqliteSemanticSearchIndex(":memory:", null);
  try {
    await index.upsertDocuments([{ id: "criminal-defense", text: "abogado penal defensa delito audiencia fiscalía", landingPath: "/penal" }]);
    const negative = await planNegativeKeyword(index, { campaignId: "123456", campaignName: "PMax", channel: "PERFORMANCE_MAX", adGroupId: null, searchTerm: "receta pastel chocolate", coverage: "PMAX_CAMPAIGN_SEARCH_TERM_VIEW", impressions: 50, clicks: 5, conversions: 0, costMicros: 500000 }, policy);
    assert.equal(negative?.channel, "PERFORMANCE_MAX");
    assert.equal(negative?.sourceCoverage, "PMAX_CAMPAIGN_SEARCH_TERM_VIEW");
    assert.equal(negative?.reason, "LOW_SEMANTIC_RELEVANCE");

    const relevant = await planNegativeKeyword(index, { campaignId: "123456", campaignName: "Search", channel: "SEARCH", adGroupId: "44", searchTerm: "abogado penal defensa", coverage: "SEARCH_TERM_VIEW", impressions: 50, clicks: 5, conversions: 0, costMicros: 500000 }, policy);
    assert.equal(relevant, null);
  } finally { index.close(); }
});

test("Google Ads collector keeps Search and PMax reporting sources distinct", async () => {
  const calls: { url: string; query: string }[] = [];
  const fetchImpl: typeof fetch = async (url, init) => {
    const body = JSON.parse(String(init?.body)) as { query: string };
    calls.push({ url: String(url), query: body.query });
    if (body.query.startsWith("SELECT campaign.id, campaign.name, campaign.advertising_channel_type FROM campaign")) return Response.json({ results: [
      { campaign: { id: "111111", name: "Search", advertisingChannelType: "SEARCH" } },
      { campaign: { id: "222222", name: "PMax", advertisingChannelType: "PERFORMANCE_MAX" } },
      { campaign: { id: "333333", name: "Display", advertisingChannelType: "DISPLAY" } },
    ] });
    if (body.query.includes("FROM search_term_view")) return Response.json({ results: [{ campaign: { id: "111111", name: "Search" }, adGroup: { id: "77" }, searchTermView: { searchTerm: "abogado penal" }, metrics: { impressions: "10", clicks: "2", conversions: 1, costMicros: "1000" } }] });
    if (body.query.includes("FROM campaign_search_term_view")) return Response.json({ results: [{ campaign: { id: "222222", name: "PMax", advertisingChannelType: "PERFORMANCE_MAX" }, campaignSearchTermView: { searchTerm: "defensa penal" }, metrics: { impressions: "20", clicks: "3", conversions: 0, costMicros: "2000" } }] });
    throw new Error(`unexpected query ${body.query}`);
  };
  const client = new GoogleAdsSearchTermCoverageClient({ customerId: "1234567890", developerToken: "developer-token", accessTokenProvider: async () => "access-token", fetchImpl });
  const snapshot = await client.collectCoverage();
  assert.equal(snapshot.terms[0]?.coverage, "SEARCH_TERM_VIEW");
  assert.equal(snapshot.terms[1]?.coverage, "PMAX_CAMPAIGN_SEARCH_TERM_VIEW");
  assert.equal(snapshot.campaigns.find((item) => item.campaignId === "333333")?.coverage, "UNKNOWN");
  assert.ok(calls.every((call) => call.url.startsWith("https://googleads.googleapis.com/v25/customers/1234567890/")));
});

test("PMax negative application rechecks channel and refuses to exceed safety limit", async () => {
  let mutationCalls = 0;
  const fetchImpl: typeof fetch = async (_url, init) => {
    const body = JSON.parse(String(init?.body)) as { query?: string; operations?: unknown[] };
    if (body.query?.includes("FROM campaign WHERE campaign.id")) return Response.json({ results: [{ campaign: { id: "222222", advertisingChannelType: "PERFORMANCE_MAX" } }] });
    if (body.query?.includes("FROM campaign_criterion")) return Response.json({ results: [{ campaignCriterion: { resourceName: "customers/1234567890/campaignCriteria/222222~1", keyword: { text: "existing", matchType: "EXACT" } } }] });
    mutationCalls += 1;
    return Response.json({ results: [{ resourceName: "customers/1234567890/campaignCriteria/222222~2" }] }, { headers: { "request-id": "request-123" } });
  };
  const client = new GoogleAdsSearchTermCoverageClient({ customerId: "1234567890", developerToken: "developer-token", accessTokenProvider: async () => "access-token", fetchImpl });
  await assert.rejects(() => client.applyCampaignNegative({ campaignId: "222222", channel: "PERFORMANCE_MAX", searchTerm: "irrelevant", matchType: "EXACT", reason: "LOW_SEMANTIC_RELEVANCE", relevanceScore: 0, sourceCoverage: "PMAX_CAMPAIGN_SEARCH_TERM_VIEW" }, 1), /safety limit/);
  assert.equal(mutationCalls, 0);
});
