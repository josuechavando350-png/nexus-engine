import { SqliteSemanticSearchIndex } from "./index.js";
import type { GoogleAdsAccessTokenProvider } from "../bidding-supervisor/google-ads-rest.js";

const GOOGLE_ADS_BASE_URL = "https://googleads.googleapis.com/v25";
const NUMERIC_ID = /^\d{5,20}$/u;
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;

export type SearchTermCoverage = "SEARCH_TERM_VIEW" | "PMAX_CAMPAIGN_SEARCH_TERM_VIEW" | "UNKNOWN";
export type SearchTermChannel = "SEARCH" | "PERFORMANCE_MAX" | "OTHER";

export interface CoveredSearchTerm {
  readonly campaignId: string;
  readonly campaignName: string;
  readonly channel: SearchTermChannel;
  readonly adGroupId: string | null;
  readonly searchTerm: string;
  readonly coverage: SearchTermCoverage;
  readonly impressions: number;
  readonly clicks: number;
  readonly conversions: number;
  readonly costMicros: number;
}

export interface CampaignCoverage {
  readonly campaignId: string;
  readonly campaignName: string;
  readonly channel: SearchTermChannel;
  readonly coverage: SearchTermCoverage;
  readonly termCount: number;
}

export interface SearchTermCoverageSnapshot {
  readonly campaigns: readonly CampaignCoverage[];
  readonly terms: readonly CoveredSearchTerm[];
}

export interface NegativeKeywordPlan {
  readonly campaignId: string;
  readonly channel: "SEARCH" | "PERFORMANCE_MAX";
  readonly searchTerm: string;
  readonly matchType: "EXACT" | "PHRASE";
  readonly reason: "LOW_SEMANTIC_RELEVANCE";
  readonly relevanceScore: number;
  readonly sourceCoverage: "SEARCH_TERM_VIEW" | "PMAX_CAMPAIGN_SEARCH_TERM_VIEW";
}

export interface SearchTermNegativePolicy {
  readonly minClicks: number;
  readonly maxConversions: number;
  readonly maxSemanticRelevance: number;
  readonly topK: number;
  readonly minSemanticCoverage: number;
  readonly matchType: "EXACT" | "PHRASE";
  readonly maxManagedNegativesPerCampaign: number;
}

export interface GoogleAdsSearchTermCoverageConfig {
  readonly customerId: string;
  readonly developerToken: string;
  readonly accessTokenProvider: GoogleAdsAccessTokenProvider;
  readonly loginCustomerId?: string;
  readonly fetchImpl?: typeof fetch;
  readonly timeoutMs?: number;
}

export class Cortex35Error extends Error {
  constructor(public readonly code: "INVALID_CONFIG" | "INVALID_INPUT" | "API_ERROR" | "INVALID_RESPONSE" | "UNSUPPORTED_COVERAGE" | "LIMIT_REACHED", message: string) {
    super(message);
    this.name = "Cortex35Error";
  }
}

function numericId(value: string, label: string): string {
  const normalized = value.replaceAll("-", "").trim();
  if (!NUMERIC_ID.test(normalized)) throw new Cortex35Error("INVALID_CONFIG", `${label} is malformed`);
  return normalized;
}
function secret(value: string, label: string): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > 8192 || /[\r\n\0]/u.test(normalized)) throw new Cortex35Error("INVALID_CONFIG", `${label} is invalid`);
  return normalized;
}
function finite(value: unknown, label: string): number {
  const parsed = typeof value === "number" ? value : Number(value ?? 0);
  if (!Number.isFinite(parsed) || parsed < 0) throw new Cortex35Error("INVALID_RESPONSE", `${label} is invalid`);
  return parsed;
}
function integer(value: number, label: string, min: number, max: number): number {
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new Cortex35Error("INVALID_CONFIG", `${label} is out of range`);
  return value;
}
function ratio(value: number, label: string): number {
  if (!Number.isFinite(value) || value < 0 || value > 1) throw new Cortex35Error("INVALID_CONFIG", `${label} is out of range`);
  return value;
}
function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Cortex35Error("INVALID_RESPONSE", `${label} must be an object`);
  return value as Record<string, unknown>;
}

async function boundedJson(response: Response): Promise<unknown> {
  const declared = response.headers.get("content-length");
  if (declared !== null && (!/^\d+$/u.test(declared) || Number(declared) > MAX_RESPONSE_BYTES)) throw new Cortex35Error("INVALID_RESPONSE", "Google Ads response is oversized");
  if (!response.body) return null;
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      total += next.value.byteLength;
      if (total > MAX_RESPONSE_BYTES) { await reader.cancel().catch(() => undefined); throw new Cortex35Error("INVALID_RESPONSE", "Google Ads response is oversized"); }
      chunks.push(next.value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(total); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  try { return total ? JSON.parse(new TextDecoder().decode(bytes)) as unknown : null; }
  catch { throw new Cortex35Error("INVALID_RESPONSE", "Google Ads response is malformed JSON"); }
}

function channel(value: unknown): SearchTermChannel {
  return value === "SEARCH" ? "SEARCH" : value === "PERFORMANCE_MAX" ? "PERFORMANCE_MAX" : "OTHER";
}

export class GoogleAdsSearchTermCoverageClient {
  private readonly customerId: string;
  private readonly developerToken: string;
  private readonly loginCustomerId?: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(private readonly config: GoogleAdsSearchTermCoverageConfig) {
    this.customerId = numericId(config.customerId, "customerId");
    this.developerToken = secret(config.developerToken, "developerToken");
    this.loginCustomerId = config.loginCustomerId ? numericId(config.loginCustomerId, "loginCustomerId") : undefined;
    this.fetchImpl = config.fetchImpl ?? fetch;
    this.timeoutMs = config.timeoutMs ?? 15_000;
    integer(this.timeoutMs, "timeoutMs", 1000, 120_000);
  }

  private async request(path: string, body: unknown): Promise<{ body: unknown; requestId: string | null }> {
    const token = secret(await this.config.accessTokenProvider(), "accessToken");
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let response: Response;
    try {
      response = await this.fetchImpl(`${GOOGLE_ADS_BASE_URL}/customers/${this.customerId}/${path}`, {
        method: "POST",
        redirect: "error",
        signal: controller.signal,
        headers: {
          authorization: `Bearer ${token}`,
          "developer-token": this.developerToken,
          ...(this.loginCustomerId ? { "login-customer-id": this.loginCustomerId } : {}),
          "content-type": "application/json",
          accept: "application/json",
        },
        body: JSON.stringify(body),
      });
    } catch (error) {
      if (controller.signal.aborted) throw new Cortex35Error("API_ERROR", "Google Ads request timed out");
      throw new Cortex35Error("API_ERROR", error instanceof Error ? error.message : "Google Ads transport failed");
    } finally { clearTimeout(timer); }
    const parsed = await boundedJson(response);
    if (!response.ok) throw new Cortex35Error("API_ERROR", `Google Ads rejected request with HTTP ${response.status}`);
    return { body: parsed, requestId: response.headers.get("request-id") };
  }

  private async search(query: string): Promise<readonly Record<string, unknown>[]> {
    const rows: Record<string, unknown>[] = [];
    let pageToken: string | undefined;
    for (let page = 0; page < 100; page += 1) {
      const response = await this.request("googleAds:search", { query, pageSize: 10_000, ...(pageToken ? { pageToken } : {}) });
      const root = object(response.body, "search response");
      const results = root.results === undefined ? [] : root.results;
      if (!Array.isArray(results)) throw new Cortex35Error("INVALID_RESPONSE", "Google Ads results must be an array");
      for (const item of results) rows.push(object(item, "Google Ads row"));
      if (root.nextPageToken === undefined || root.nextPageToken === "") return Object.freeze(rows);
      if (typeof root.nextPageToken !== "string" || root.nextPageToken.length > 4096) throw new Cortex35Error("INVALID_RESPONSE", "Google Ads nextPageToken is invalid");
      pageToken = root.nextPageToken;
    }
    throw new Cortex35Error("INVALID_RESPONSE", "Google Ads pagination exceeded safety limit");
  }

  async collectCoverage(): Promise<SearchTermCoverageSnapshot> {
    const campaignRows = await this.search("SELECT campaign.id, campaign.name, campaign.advertising_channel_type FROM campaign WHERE campaign.status != 'REMOVED'");
    const campaigns = new Map<string, { name: string; channel: SearchTermChannel }>();
    for (const row of campaignRows) {
      const campaign = object(row.campaign, "campaign");
      const id = String(campaign.id ?? "");
      if (!/^\d{1,20}$/u.test(id)) throw new Cortex35Error("INVALID_RESPONSE", "campaign.id is malformed");
      campaigns.set(id, { name: typeof campaign.name === "string" ? campaign.name : "", channel: channel(campaign.advertisingChannelType) });
    }

    const terms: CoveredSearchTerm[] = [];
    const searchRows = await this.search("SELECT campaign.id, campaign.name, ad_group.id, search_term_view.search_term, metrics.impressions, metrics.clicks, metrics.conversions, metrics.cost_micros FROM search_term_view WHERE campaign.status != 'REMOVED'");
    for (const row of searchRows) {
      const campaign = object(row.campaign, "campaign");
      const adGroup = object(row.adGroup, "adGroup");
      const view = object(row.searchTermView, "searchTermView");
      const metrics = object(row.metrics, "metrics");
      const campaignId = String(campaign.id ?? "");
      const term = typeof view.searchTerm === "string" ? view.searchTerm.trim() : "";
      if (!campaigns.has(campaignId) || !term || term.length > 2048) throw new Cortex35Error("INVALID_RESPONSE", "search_term_view row is invalid");
      terms.push(Object.freeze({ campaignId, campaignName: typeof campaign.name === "string" ? campaign.name : campaigns.get(campaignId)!.name, channel: "SEARCH", adGroupId: String(adGroup.id ?? ""), searchTerm: term, coverage: "SEARCH_TERM_VIEW", impressions: finite(metrics.impressions, "impressions"), clicks: finite(metrics.clicks, "clicks"), conversions: finite(metrics.conversions, "conversions"), costMicros: finite(metrics.costMicros, "costMicros") }));
    }

    const pmaxRows = await this.search("SELECT campaign.id, campaign.name, campaign.advertising_channel_type, campaign_search_term_view.search_term, metrics.impressions, metrics.clicks, metrics.conversions, metrics.cost_micros FROM campaign_search_term_view WHERE campaign.status != 'REMOVED' AND campaign.advertising_channel_type = 'PERFORMANCE_MAX'");
    for (const row of pmaxRows) {
      const campaign = object(row.campaign, "campaign");
      const view = object(row.campaignSearchTermView, "campaignSearchTermView");
      const metrics = object(row.metrics, "metrics");
      const campaignId = String(campaign.id ?? "");
      const term = typeof view.searchTerm === "string" ? view.searchTerm.trim() : "";
      if (!campaigns.has(campaignId) || !term || term.length > 2048) throw new Cortex35Error("INVALID_RESPONSE", "campaign_search_term_view PMax row is invalid");
      terms.push(Object.freeze({ campaignId, campaignName: typeof campaign.name === "string" ? campaign.name : campaigns.get(campaignId)!.name, channel: "PERFORMANCE_MAX", adGroupId: null, searchTerm: term, coverage: "PMAX_CAMPAIGN_SEARCH_TERM_VIEW", impressions: finite(metrics.impressions, "impressions"), clicks: finite(metrics.clicks, "clicks"), conversions: finite(metrics.conversions, "conversions"), costMicros: finite(metrics.costMicros, "costMicros") }));
    }

    const counts = new Map<string, number>();
    for (const term of terms) counts.set(term.campaignId, (counts.get(term.campaignId) ?? 0) + 1);
    const coverage = [...campaigns.entries()].map(([campaignId, campaign]): CampaignCoverage => Object.freeze({
      campaignId,
      campaignName: campaign.name,
      channel: campaign.channel,
      coverage: campaign.channel === "SEARCH" ? "SEARCH_TERM_VIEW" : campaign.channel === "PERFORMANCE_MAX" ? "PMAX_CAMPAIGN_SEARCH_TERM_VIEW" : "UNKNOWN",
      termCount: counts.get(campaignId) ?? 0,
    })).sort((a, b) => a.campaignId.localeCompare(b.campaignId));
    return Object.freeze({ campaigns: Object.freeze(coverage), terms: Object.freeze(terms.sort((a, b) => a.campaignId.localeCompare(b.campaignId) || a.searchTerm.localeCompare(b.searchTerm))) });
  }

  async applyCampaignNegative(plan: NegativeKeywordPlan, maxManagedNegativesPerCampaign: number): Promise<{ resourceName: string; requestId: string | null; alreadyExists: boolean }> {
    integer(maxManagedNegativesPerCampaign, "maxManagedNegativesPerCampaign", 1, 10_000);
    if (!(plan.channel === "SEARCH" || plan.channel === "PERFORMANCE_MAX") || !(plan.sourceCoverage === "SEARCH_TERM_VIEW" || plan.sourceCoverage === "PMAX_CAMPAIGN_SEARCH_TERM_VIEW")) throw new Cortex35Error("UNSUPPORTED_COVERAGE", "negative keyword plan has unsupported coverage");
    if ((plan.channel === "PERFORMANCE_MAX") !== (plan.sourceCoverage === "PMAX_CAMPAIGN_SEARCH_TERM_VIEW")) throw new Cortex35Error("UNSUPPORTED_COVERAGE", "plan channel does not match its evidence coverage");
    const campaignRows = await this.search(`SELECT campaign.id, campaign.advertising_channel_type FROM campaign WHERE campaign.id = ${plan.campaignId} LIMIT 1`);
    if (campaignRows.length !== 1) throw new Cortex35Error("INVALID_RESPONSE", "target campaign was not found uniquely");
    const actualCampaign = object(campaignRows[0]!.campaign, "campaign");
    const actualChannel = channel(actualCampaign.advertisingChannelType);
    if (actualChannel !== plan.channel) throw new Cortex35Error("UNSUPPORTED_COVERAGE", "campaign channel changed since planning");

    const existingRows = await this.search(`SELECT campaign_criterion.resource_name, campaign_criterion.keyword.text, campaign_criterion.keyword.match_type FROM campaign_criterion WHERE campaign.id = ${plan.campaignId} AND campaign_criterion.negative = TRUE AND campaign_criterion.type = 'KEYWORD'`);
    for (const row of existingRows) {
      const criterion = object(row.campaignCriterion, "campaignCriterion");
      const keyword = object(criterion.keyword, "campaignCriterion.keyword");
      if (keyword.text === plan.searchTerm && keyword.matchType === plan.matchType && typeof criterion.resourceName === "string") return { resourceName: criterion.resourceName, requestId: null, alreadyExists: true };
    }
    const platformCap = plan.channel === "PERFORMANCE_MAX" ? 10_000 : maxManagedNegativesPerCampaign;
    if (existingRows.length >= Math.min(platformCap, maxManagedNegativesPerCampaign)) throw new Cortex35Error("LIMIT_REACHED", "campaign negative keyword safety limit reached");

    const response = await this.request("campaignCriteria:mutate", { operations: [{ create: { campaign: `customers/${this.customerId}/campaigns/${plan.campaignId}`, negative: true, keyword: { text: plan.searchTerm, matchType: plan.matchType } } }], partialFailure: false, validateOnly: false });
    const root = object(response.body, "mutate response");
    if (!Array.isArray(root.results) || root.results.length !== 1) throw new Cortex35Error("INVALID_RESPONSE", "negative keyword mutation returned invalid result cardinality");
    const result = object(root.results[0], "mutation result");
    if (typeof result.resourceName !== "string" || !result.resourceName) throw new Cortex35Error("INVALID_RESPONSE", "negative keyword mutation is missing resourceName");
    return Object.freeze({ resourceName: result.resourceName, requestId: response.requestId, alreadyExists: false });
  }
}

export function createSearchTermNegativePolicy(input: SearchTermNegativePolicy): SearchTermNegativePolicy {
  integer(input.minClicks, "minClicks", 1, 1_000_000_000);
  if (!Number.isFinite(input.maxConversions) || input.maxConversions < 0 || input.maxConversions > 1_000_000_000) throw new Cortex35Error("INVALID_CONFIG", "maxConversions is out of range");
  ratio(input.maxSemanticRelevance, "maxSemanticRelevance");
  integer(input.topK, "topK", 1, 100);
  ratio(input.minSemanticCoverage, "minSemanticCoverage");
  if (!(input.matchType === "EXACT" || input.matchType === "PHRASE")) throw new Cortex35Error("INVALID_CONFIG", "matchType is invalid");
  integer(input.maxManagedNegativesPerCampaign, "maxManagedNegativesPerCampaign", 1, 10_000);
  return Object.freeze({ ...input });
}

export async function planNegativeKeyword(index: SqliteSemanticSearchIndex, term: CoveredSearchTerm, policyInput: SearchTermNegativePolicy): Promise<NegativeKeywordPlan | null> {
  const policy = createSearchTermNegativePolicy(policyInput);
  if (!(term.coverage === "SEARCH_TERM_VIEW" || term.coverage === "PMAX_CAMPAIGN_SEARCH_TERM_VIEW")) return null;
  if (!(term.channel === "SEARCH" || term.channel === "PERFORMANCE_MAX")) return null;
  if (term.clicks < policy.minClicks || term.conversions > policy.maxConversions) return null;
  const search = await index.search(term.searchTerm, { topK: policy.topK, minSemanticCoverage: policy.minSemanticCoverage });
  const relevanceScore = search.hits[0]?.score ?? 0;
  if (relevanceScore > policy.maxSemanticRelevance) return null;
  return Object.freeze({ campaignId: term.campaignId, channel: term.channel, searchTerm: term.searchTerm, matchType: policy.matchType, reason: "LOW_SEMANTIC_RELEVANCE", relevanceScore, sourceCoverage: term.coverage });
}
