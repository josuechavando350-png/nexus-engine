import {
  GOOGLE_ADS_API_VERSION,
  type GoogleAdsAccessTokenProvider,
} from "../../bidding-supervisor/google-ads-rest.js";
import {
  keywordFitsGoogleLimits,
  normalizeSearchTerm,
  type ExactMatchCandidate,
  type SearchTermMatchType,
  type SearchTermObservation,
  type SearchTermTargetingStatus,
} from "./search-term-synthesizer.js";

const GOOGLE_ADS_BASE_URL = "https://googleads.googleapis.com";
const NUMERIC_CUSTOMER_ID = /^\d{5,20}$/u;
const NUMERIC_RESOURCE_ID = /^\d{1,20}$/u;
const DATE = /^\d{4}-\d{2}-\d{2}$/u;
const MAX_RESPONSE_BYTES = 32 * 1024 * 1024;
const MAX_CANDIDATES_PER_MUTATION = 50;

export interface SearchTermReportRequest {
  readonly startDate: string;
  readonly endDate: string;
  readonly campaignIds?: readonly string[];
}

export interface ExistingExactKeyword {
  readonly campaignId: string;
  readonly adGroupId: string;
  readonly resourceName: string;
  readonly text: string;
  readonly normalizedText: string;
}

export type ExactMatchExecutionMode = "VALIDATE_ONLY" | "APPLY";

export interface ExactMatchMaterializationOptions {
  readonly executionMode: ExactMatchExecutionMode;
  readonly adGroupNamePrefix?: string;
}

export interface ExactMatchMaterializedItem {
  readonly fingerprint: string;
  readonly campaignId: string;
  readonly searchTerm: string;
  readonly adGroupResourceName: string;
  readonly criterionResourceName: string;
}

export interface ExactMatchSkippedItem {
  readonly fingerprint: string;
  readonly campaignId: string;
  readonly searchTerm: string;
  readonly reason: "EXACT_KEYWORD_ALREADY_EXISTS" | "DUPLICATE_CANDIDATE";
  readonly existingResourceName: string | null;
}

export interface ExactMatchMaterializationReceipt {
  readonly status: "VALIDATED" | "APPLIED" | "NOOP";
  readonly requestId: string | null;
  readonly planned: readonly ExactMatchCandidate[];
  readonly materialized: readonly ExactMatchMaterializedItem[];
  readonly skipped: readonly ExactMatchSkippedItem[];
}

export class ExactMatchGoogleAdsError extends Error {
  constructor(
    public readonly code:
      | "INVALID_CONFIG"
      | "INVALID_INPUT"
      | "AUTHENTICATION_FAILED"
      | "QUOTA_EXHAUSTED"
      | "API_ERROR"
      | "INVALID_RESPONSE"
      | "TIMEOUT"
      | "AMBIGUOUS_MUTATION_OUTCOME",
    message: string,
    public readonly httpStatus: number | null = null,
    public readonly requestId: string | null = null,
    public readonly googleStatus: string | null = null,
  ) {
    super(message);
    this.name = "ExactMatchGoogleAdsError";
  }
}

export interface GoogleAdsExactMatchClientConfig {
  readonly developerToken: string;
  readonly loginCustomerId?: string;
  readonly accessTokenProvider: GoogleAdsAccessTokenProvider;
  readonly fetchImpl?: typeof fetch;
  readonly timeoutMs?: number;
  readonly maxReadRetries?: number;
  readonly maxReadPages?: number;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly apiVersion?: `v${number}`;
}

function containsControlCharacters(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

function numericCustomerId(value: string, label: string): string {
  const normalized = value.replaceAll("-", "").trim();
  if (!NUMERIC_CUSTOMER_ID.test(normalized)) throw new ExactMatchGoogleAdsError("INVALID_CONFIG", `${label} is malformed`);
  return normalized;
}

function numericResourceId(value: string, label: string): string {
  const normalized = value.trim();
  if (!NUMERIC_RESOURCE_ID.test(normalized)) throw new ExactMatchGoogleAdsError("INVALID_INPUT", `${label} is malformed`);
  return normalized;
}

function secret(value: string, label: string): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > 8192 || containsControlCharacters(normalized)) throw new ExactMatchGoogleAdsError("INVALID_CONFIG", `${label} is missing or malformed`);
  return normalized;
}

function canonicalDate(value: string, label: string): string {
  if (!DATE.test(value)) throw new ExactMatchGoogleAdsError("INVALID_INPUT", `${label} must use YYYY-MM-DD`);
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) throw new ExactMatchGoogleAdsError("INVALID_INPUT", `${label} is not a real calendar date`);
  return value;
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ExactMatchGoogleAdsError("INVALID_RESPONSE", `${label} must be an object`);
  return value as Record<string, unknown>;
}

function optionalObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value) throw new ExactMatchGoogleAdsError("INVALID_RESPONSE", `${label} must be a non-empty string`);
  return value;
}

function apiNumericId(value: unknown, label: string): string {
  const normalized = typeof value === "number" && Number.isSafeInteger(value) ? String(value) : typeof value === "string" ? value : "";
  if (!NUMERIC_RESOURCE_ID.test(normalized)) throw new ExactMatchGoogleAdsError("INVALID_RESPONSE", `${label} is malformed`);
  return normalized;
}

function apiFiniteNumber(value: unknown, label: string, fallback = 0): number {
  if (value === undefined || value === null || value === "") return fallback;
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) throw new ExactMatchGoogleAdsError("INVALID_RESPONSE", `${label} must be finite and non-negative`);
  return parsed;
}

function apiSafeInteger(value: unknown, label: string, fallback = 0): number {
  const parsed = apiFiniteNumber(value, label, fallback);
  if (!Number.isSafeInteger(parsed)) throw new ExactMatchGoogleAdsError("INVALID_RESPONSE", `${label} exceeds safe integer range`);
  return parsed;
}

function parseTargetingStatus(value: unknown): SearchTermTargetingStatus {
  return value === "NONE" || value === "ADDED" || value === "EXCLUDED" || value === "ADDED_EXCLUDED" || value === "UNKNOWN" || value === "UNSPECIFIED" ? value : "UNKNOWN";
}

function parseMatchType(value: unknown): SearchTermMatchType {
  return value === "BROAD" || value === "PHRASE" || value === "EXACT" || value === "NEAR_EXACT" || value === "NEAR_PHRASE" || value === "AI_MAX" || value === "PERFORMANCE_MAX" || value === "UNKNOWN" || value === "UNSPECIFIED" ? value : "UNKNOWN";
}

function retryAfterMs(value: string | null): number | null {
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(60_000, Math.ceil(seconds * 1_000));
  const absolute = Date.parse(value);
  return Number.isFinite(absolute) ? Math.min(60_000, Math.max(0, absolute - Date.now())) : null;
}

async function defaultSleep(ms: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, ms));
}

async function boundedJson(response: Response): Promise<unknown> {
  const declared = response.headers.get("content-length");
  if (declared !== null && (!/^\d+$/u.test(declared) || Number(declared) > MAX_RESPONSE_BYTES)) {
    throw new ExactMatchGoogleAdsError("INVALID_RESPONSE", "Google Ads response declared an invalid or oversized body", response.status, response.headers.get("request-id"));
  }
  if (!response.body) return null;
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      total += next.value.byteLength;
      if (total > MAX_RESPONSE_BYTES) {
        await reader.cancel().catch(() => undefined);
        throw new ExactMatchGoogleAdsError("INVALID_RESPONSE", "Google Ads response exceeded bounded size", response.status, response.headers.get("request-id"));
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  if (!total) return null;
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
  } catch {
    throw new ExactMatchGoogleAdsError("INVALID_RESPONSE", "Google Ads returned malformed JSON", response.status, response.headers.get("request-id"));
  }
}

function googleError(payload: unknown): { readonly status: string | null; readonly message: string } {
  const root = optionalObject(payload);
  const error = optionalObject(root?.error);
  return Object.freeze({
    status: typeof error?.status === "string" ? error.status : null,
    message: typeof error?.message === "string" && error.message ? error.message.slice(0, 500) : "Google Ads API request failed",
  });
}

function validateCampaignIds(values: readonly string[] | undefined): readonly string[] {
  if (values === undefined) return Object.freeze([]);
  if (!Array.isArray(values) || values.length > 100) throw new ExactMatchGoogleAdsError("INVALID_INPUT", "campaignIds must contain at most 100 ids");
  const normalized = values.map((value) => numericResourceId(value, "campaignId"));
  return Object.freeze([...new Set(normalized)]);
}

function gaqlCampaignFilter(campaignIds: readonly string[]): string | null {
  if (!campaignIds.length) return null;
  return campaignIds.length === 1 ? `campaign.id = ${campaignIds[0]}` : `campaign.id IN (${campaignIds.join(", ")})`;
}

function validateCandidate(candidate: ExactMatchCandidate): ExactMatchCandidate {
  if (!candidate || typeof candidate !== "object") throw new ExactMatchGoogleAdsError("INVALID_INPUT", "exact-match candidate is required");
  numericResourceId(candidate.campaignId, "candidate campaignId");
  numericResourceId(candidate.sourceAdGroupId, "candidate sourceAdGroupId");
  if (!keywordFitsGoogleLimits(candidate.searchTerm)) throw new ExactMatchGoogleAdsError("INVALID_INPUT", "candidate searchTerm exceeds Google keyword limits");
  if (normalizeSearchTerm(candidate.searchTerm) !== candidate.normalizedSearchTerm) throw new ExactMatchGoogleAdsError("INVALID_INPUT", "candidate normalizedSearchTerm does not match searchTerm");
  if (!/^[a-f0-9]{64}$/u.test(candidate.fingerprint)) throw new ExactMatchGoogleAdsError("INVALID_INPUT", "candidate fingerprint is malformed");
  return candidate;
}

function adGroupName(prefixInput: string | undefined, candidate: ExactMatchCandidate): string {
  const prefix = (prefixInput ?? "NEXUS EX").normalize("NFKC").replace(/\s+/gu, " ").trim();
  if (!prefix || prefix.length > 80 || containsControlCharacters(prefix)) throw new ExactMatchGoogleAdsError("INVALID_INPUT", "adGroupNamePrefix is empty, too long, or contains control characters");
  const value = `${prefix} | ${candidate.searchTerm} | ${candidate.fingerprint.slice(0, 12)}`;
  if (value.length > 256) throw new ExactMatchGoogleAdsError("INVALID_INPUT", "generated ad group name exceeds Google Ads limits");
  return value;
}

function resourceNameFromResult(value: unknown, field: string): string {
  const result = object(value, field);
  return requiredString(result.resourceName, `${field}.resourceName`);
}

export class GoogleAdsExactMatchClient {
  private readonly developerToken: string;
  private readonly loginCustomerId: string | null;
  private readonly accessTokenProvider: GoogleAdsAccessTokenProvider;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly maxReadRetries: number;
  private readonly maxReadPages: number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly apiVersion: `v${number}`;

  constructor(config: GoogleAdsExactMatchClientConfig) {
    this.developerToken = secret(config.developerToken, "developerToken");
    this.loginCustomerId = config.loginCustomerId === undefined ? null : numericCustomerId(config.loginCustomerId, "loginCustomerId");
    if (typeof config.accessTokenProvider !== "function") throw new ExactMatchGoogleAdsError("INVALID_CONFIG", "accessTokenProvider is required");
    this.accessTokenProvider = config.accessTokenProvider;
    this.fetchImpl = config.fetchImpl ?? fetch;
    this.timeoutMs = config.timeoutMs ?? 20_000;
    if (!Number.isSafeInteger(this.timeoutMs) || this.timeoutMs < 1_000 || this.timeoutMs > 120_000) throw new ExactMatchGoogleAdsError("INVALID_CONFIG", "timeoutMs must be 1000..120000");
    this.maxReadRetries = config.maxReadRetries ?? 2;
    if (!Number.isSafeInteger(this.maxReadRetries) || this.maxReadRetries < 0 || this.maxReadRetries > 5) throw new ExactMatchGoogleAdsError("INVALID_CONFIG", "maxReadRetries must be 0..5");
    this.maxReadPages = config.maxReadPages ?? 20;
    if (!Number.isSafeInteger(this.maxReadPages) || this.maxReadPages < 1 || this.maxReadPages > 100) throw new ExactMatchGoogleAdsError("INVALID_CONFIG", "maxReadPages must be 1..100");
    this.sleep = config.sleep ?? defaultSleep;
    const apiVersion = config.apiVersion ?? GOOGLE_ADS_API_VERSION;
    if (!/^v\d{1,3}$/u.test(apiVersion)) throw new ExactMatchGoogleAdsError("INVALID_CONFIG", "apiVersion is malformed");
    this.apiVersion = apiVersion as `v${number}`;
  }

  private async request(
    customerIdInput: string,
    path: string,
    body: Readonly<Record<string, unknown>>,
    retrySafe: boolean,
  ): Promise<{ readonly payload: unknown; readonly requestId: string | null }> {
    const customerId = numericCustomerId(customerIdInput, "customerId");
    const url = `${GOOGLE_ADS_BASE_URL}/${this.apiVersion}/customers/${customerId}/${path}`;
    const attempts = retrySafe ? this.maxReadRetries + 1 : 1;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      const accessToken = secret(await this.accessTokenProvider(), "OAuth access token");
      const headers: Record<string, string> = {
        authorization: `Bearer ${accessToken}`,
        "content-type": "application/json",
        "developer-token": this.developerToken,
      };
      if (this.loginCustomerId) headers["login-customer-id"] = this.loginCustomerId;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);
      try {
        const response = await this.fetchImpl(url, {
          method: "POST",
          headers,
          body: JSON.stringify(body),
          signal: controller.signal,
          redirect: "error",
        });
        const requestId = response.headers.get("request-id");
        const payload = await boundedJson(response);
        if (response.ok) return Object.freeze({ payload, requestId });
        const detail = googleError(payload);
        if (retrySafe && (response.status === 429 || response.status >= 500) && attempt + 1 < attempts) {
          await this.sleep(retryAfterMs(response.headers.get("retry-after")) ?? Math.min(8_000, 500 * 2 ** attempt));
          continue;
        }
        if (!retrySafe && response.status >= 500) throw new ExactMatchGoogleAdsError("AMBIGUOUS_MUTATION_OUTCOME", "Google Ads mutation returned a server error; remote application is unconfirmed", response.status, requestId, detail.status);
        const code = response.status === 429 || detail.status === "RESOURCE_EXHAUSTED"
          ? "QUOTA_EXHAUSTED"
          : response.status === 401 || response.status === 403
            ? "AUTHENTICATION_FAILED"
            : "API_ERROR";
        throw new ExactMatchGoogleAdsError(code, detail.message, response.status, requestId, detail.status);
      } catch (error) {
        if (error instanceof ExactMatchGoogleAdsError) throw error;
        const aborted = error instanceof DOMException && error.name === "AbortError";
        if (retrySafe && attempt + 1 < attempts) {
          await this.sleep(Math.min(8_000, 500 * 2 ** attempt));
          continue;
        }
        if (!retrySafe) throw new ExactMatchGoogleAdsError("AMBIGUOUS_MUTATION_OUTCOME", aborted ? "Google Ads mutation timed out; remote application is unconfirmed" : "Google Ads mutation transport failed; remote application is unconfirmed");
        if (aborted) throw new ExactMatchGoogleAdsError("TIMEOUT", "Google Ads read timed out");
        throw new ExactMatchGoogleAdsError("API_ERROR", "Google Ads read transport failed");
      } finally {
        clearTimeout(timer);
      }
    }
    throw new ExactMatchGoogleAdsError("API_ERROR", "Google Ads request retry loop exhausted");
  }

  private async search(customerId: string, query: string): Promise<readonly Record<string, unknown>[]> {
    const rows: Record<string, unknown>[] = [];
    let pageToken: string | null = null;
    const seenTokens = new Set<string>();
    for (let page = 0; page < this.maxReadPages; page += 1) {
      const body: Record<string, unknown> = { query };
      if (pageToken) body.pageToken = pageToken;
      const { payload } = await this.request(customerId, "googleAds:search", body, true);
      const root = object(payload, "Google Ads search response");
      if (root.results !== undefined) {
        if (!Array.isArray(root.results)) throw new ExactMatchGoogleAdsError("INVALID_RESPONSE", "Google Ads search results must be an array");
        rows.push(...root.results.map((row, index) => object(row, `Google Ads search result ${rows.length + index}`)));
        if (rows.length > 100_000) throw new ExactMatchGoogleAdsError("INVALID_RESPONSE", "Google Ads search exceeded the bounded 100000-row limit");
      }
      if (root.nextPageToken === undefined || root.nextPageToken === null || root.nextPageToken === "") return Object.freeze(rows);
      pageToken = requiredString(root.nextPageToken, "Google Ads nextPageToken");
      if (pageToken.length > 8192 || seenTokens.has(pageToken)) throw new ExactMatchGoogleAdsError("INVALID_RESPONSE", "Google Ads pagination token is oversized or repeated");
      seenTokens.add(pageToken);
    }
    throw new ExactMatchGoogleAdsError("INVALID_RESPONSE", "Google Ads search exceeded configured maxReadPages");
  }

  async fetchSearchTermObservations(customerIdInput: string, requestInput: SearchTermReportRequest): Promise<readonly SearchTermObservation[]> {
    const customerId = numericCustomerId(customerIdInput, "customerId");
    if (!requestInput || typeof requestInput !== "object") throw new ExactMatchGoogleAdsError("INVALID_INPUT", "search term report request is required");
    const startDate = canonicalDate(requestInput.startDate, "startDate");
    const endDate = canonicalDate(requestInput.endDate, "endDate");
    if (startDate > endDate) throw new ExactMatchGoogleAdsError("INVALID_INPUT", "startDate must not be after endDate");
    const campaignIds = validateCampaignIds(requestInput.campaignIds);
    const conditions = [
      `segments.date BETWEEN '${startDate}' AND '${endDate}'`,
      "campaign.status = 'ENABLED'",
      "ad_group.status = 'ENABLED'",
    ];
    const campaignFilter = gaqlCampaignFilter(campaignIds);
    if (campaignFilter) conditions.push(campaignFilter);
    const query = [
      "SELECT campaign.id, ad_group.id, search_term_view.search_term, search_term_view.status,",
      "segments.search_term_match_type, metrics.impressions, metrics.clicks, metrics.conversions, metrics.conversions_value, metrics.cost_micros",
      "FROM search_term_view",
      `WHERE ${conditions.join(" AND ")}`,
      "ORDER BY metrics.conversions DESC",
    ].join(" ");
    const rows = await this.search(customerId, query);
    return Object.freeze(rows.map((row, index): SearchTermObservation => {
      const campaign = object(row.campaign, `row ${index} campaign`);
      const adGroup = object(row.adGroup, `row ${index} adGroup`);
      const searchTermView = object(row.searchTermView, `row ${index} searchTermView`);
      const segments = optionalObject(row.segments) ?? {};
      const metrics = optionalObject(row.metrics) ?? {};
      return Object.freeze({
        campaignId: apiNumericId(campaign.id, `row ${index} campaign.id`),
        adGroupId: apiNumericId(adGroup.id, `row ${index} adGroup.id`),
        searchTerm: requiredString(searchTermView.searchTerm, `row ${index} searchTerm`),
        targetingStatus: parseTargetingStatus(searchTermView.status),
        searchTermMatchType: parseMatchType(segments.searchTermMatchType),
        impressions: apiSafeInteger(metrics.impressions, `row ${index} impressions`),
        clicks: apiSafeInteger(metrics.clicks, `row ${index} clicks`),
        conversions: apiFiniteNumber(metrics.conversions, `row ${index} conversions`),
        conversionValue: apiFiniteNumber(metrics.conversionsValue, `row ${index} conversionsValue`),
        costMicros: apiSafeInteger(metrics.costMicros, `row ${index} costMicros`),
      });
    }));
  }

  async fetchExistingExactKeywords(customerIdInput: string, campaignIdsInput: readonly string[]): Promise<readonly ExistingExactKeyword[]> {
    const customerId = numericCustomerId(customerIdInput, "customerId");
    const campaignIds = validateCampaignIds(campaignIdsInput);
    if (!campaignIds.length) return Object.freeze([]);
    const campaignFilter = gaqlCampaignFilter(campaignIds)!;
    const query = [
      "SELECT campaign.id, ad_group.id, ad_group_criterion.resource_name, ad_group_criterion.keyword.text",
      "FROM ad_group_criterion",
      "WHERE ad_group_criterion.type = 'KEYWORD'",
      "AND ad_group_criterion.negative = FALSE",
      "AND ad_group_criterion.status != 'REMOVED'",
      "AND ad_group_criterion.keyword.match_type = 'EXACT'",
      `AND ${campaignFilter}`,
    ].join(" ");
    const rows = await this.search(customerId, query);
    return Object.freeze(rows.map((row, index): ExistingExactKeyword => {
      const campaign = object(row.campaign, `existing keyword row ${index} campaign`);
      const adGroup = object(row.adGroup, `existing keyword row ${index} adGroup`);
      const criterion = object(row.adGroupCriterion, `existing keyword row ${index} criterion`);
      const keyword = object(criterion.keyword, `existing keyword row ${index} keyword`);
      const text = requiredString(keyword.text, `existing keyword row ${index} text`);
      return Object.freeze({
        campaignId: apiNumericId(campaign.id, `existing keyword row ${index} campaign.id`),
        adGroupId: apiNumericId(adGroup.id, `existing keyword row ${index} adGroup.id`),
        resourceName: requiredString(criterion.resourceName, `existing keyword row ${index} resourceName`),
        text,
        normalizedText: normalizeSearchTerm(text),
      });
    }));
  }

  async materializeExactMatches(
    customerIdInput: string,
    candidatesInput: readonly ExactMatchCandidate[],
    optionsInput: ExactMatchMaterializationOptions,
  ): Promise<ExactMatchMaterializationReceipt> {
    const customerId = numericCustomerId(customerIdInput, "customerId");
    if (!Array.isArray(candidatesInput) || candidatesInput.length > MAX_CANDIDATES_PER_MUTATION) throw new ExactMatchGoogleAdsError("INVALID_INPUT", `candidates must contain at most ${MAX_CANDIDATES_PER_MUTATION} items`);
    if (!optionsInput || !(optionsInput.executionMode === "VALIDATE_ONLY" || optionsInput.executionMode === "APPLY")) throw new ExactMatchGoogleAdsError("INVALID_INPUT", "executionMode must be VALIDATE_ONLY or APPLY");
    const candidates = candidatesInput.map(validateCandidate);
    const campaignIds = [...new Set(candidates.map((candidate) => candidate.campaignId))];
    const existing = await this.fetchExistingExactKeywords(customerId, campaignIds);
    const existingByKey = new Map<string, ExistingExactKeyword>(existing.map((keyword) => [`${keyword.campaignId}\u0000${keyword.normalizedText}`, keyword] as const));
    const candidateKeys = new Set<string>();
    const planned: ExactMatchCandidate[] = [];
    const skipped: ExactMatchSkippedItem[] = [];

    for (const candidate of candidates) {
      const key = `${candidate.campaignId}\u0000${candidate.normalizedSearchTerm}`;
      const existingKeyword = existingByKey.get(key);
      if (existingKeyword) {
        skipped.push(Object.freeze({
          fingerprint: candidate.fingerprint,
          campaignId: candidate.campaignId,
          searchTerm: candidate.searchTerm,
          reason: "EXACT_KEYWORD_ALREADY_EXISTS",
          existingResourceName: existingKeyword.resourceName,
        }));
        continue;
      }
      if (candidateKeys.has(key)) {
        skipped.push(Object.freeze({
          fingerprint: candidate.fingerprint,
          campaignId: candidate.campaignId,
          searchTerm: candidate.searchTerm,
          reason: "DUPLICATE_CANDIDATE",
          existingResourceName: null,
        }));
        continue;
      }
      candidateKeys.add(key);
      planned.push(candidate);
    }

    if (!planned.length) {
      return Object.freeze({ status: "NOOP", requestId: null, planned: Object.freeze([]), materialized: Object.freeze([]), skipped: Object.freeze(skipped) });
    }

    const mutateOperations: Record<string, unknown>[] = [];
    for (let index = 0; index < planned.length; index += 1) {
      const candidate = planned[index]!;
      const temporaryAdGroupResourceName = `customers/${customerId}/adGroups/${-(index + 1)}`;
      mutateOperations.push({
        adGroupOperation: {
          create: {
            resourceName: temporaryAdGroupResourceName,
            campaign: `customers/${customerId}/campaigns/${candidate.campaignId}`,
            name: adGroupName(optionsInput.adGroupNamePrefix, candidate),
            status: "PAUSED",
            type: "SEARCH_STANDARD",
          },
        },
      });
      mutateOperations.push({
        adGroupCriterionOperation: {
          create: {
            adGroup: temporaryAdGroupResourceName,
            status: "ENABLED",
            negative: false,
            keyword: { text: candidate.searchTerm, matchType: "EXACT" },
          },
        },
      });
    }

    const validateOnly = optionsInput.executionMode === "VALIDATE_ONLY";
    const { payload, requestId } = await this.request(customerId, "googleAds:mutate", {
      mutateOperations,
      partialFailure: false,
      validateOnly,
    }, false);

    if (validateOnly) {
      return Object.freeze({ status: "VALIDATED", requestId, planned: Object.freeze(planned), materialized: Object.freeze([]), skipped: Object.freeze(skipped) });
    }

    const root = object(payload, "Google Ads mutate response");
    if (root.partialFailureError !== undefined && root.partialFailureError !== null) throw new ExactMatchGoogleAdsError("INVALID_RESPONSE", "Google Ads returned partialFailureError despite atomic mutation mode", null, requestId);
    if (!Array.isArray(root.mutateOperationResponses) || root.mutateOperationResponses.length !== planned.length * 2) {
      throw new ExactMatchGoogleAdsError("INVALID_RESPONSE", "Google Ads mutate response did not contain the expected operation result count", null, requestId);
    }
    const materialized: ExactMatchMaterializedItem[] = [];
    for (let index = 0; index < planned.length; index += 1) {
      const candidate = planned[index]!;
      const adGroupResponse = object(root.mutateOperationResponses[index * 2], `mutate response ${index * 2}`);
      const criterionResponse = object(root.mutateOperationResponses[index * 2 + 1], `mutate response ${index * 2 + 1}`);
      materialized.push(Object.freeze({
        fingerprint: candidate.fingerprint,
        campaignId: candidate.campaignId,
        searchTerm: candidate.searchTerm,
        adGroupResourceName: resourceNameFromResult(adGroupResponse.adGroupResult, `mutate response ${index * 2}.adGroupResult`),
        criterionResourceName: resourceNameFromResult(criterionResponse.adGroupCriterionResult, `mutate response ${index * 2 + 1}.adGroupCriterionResult`),
      }));
    }
    return Object.freeze({ status: "APPLIED", requestId, planned: Object.freeze(planned), materialized: Object.freeze(materialized), skipped: Object.freeze(skipped) });
  }
}
