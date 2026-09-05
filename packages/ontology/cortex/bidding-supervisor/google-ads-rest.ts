const GOOGLE_ADS_BASE_URL = "https://googleads.googleapis.com";
const GOOGLE_OAUTH_TOKEN_URL = "https://oauth2.googleapis.com/token";

export const GOOGLE_ADS_API_VERSION = "v25";

export type GoogleAdsBiddingStrategyType =
  | "MAXIMIZE_CONVERSIONS"
  | "MAXIMIZE_CONVERSION_VALUE"
  | "TARGET_CPA"
  | "TARGET_ROAS"
  | "OTHER";

export interface GoogleAdsCampaignSnapshot {
  readonly customerId: string;
  readonly campaignId: string;
  readonly campaignResourceName: string;
  readonly campaignName: string;
  readonly status: string;
  readonly budgetResourceName: string;
  readonly budgetAmountMicros: number;
  readonly budgetExplicitlyShared: boolean;
  readonly recommendedBudgetAmountMicros: number | null;
  readonly biddingStrategyType: GoogleAdsBiddingStrategyType;
  readonly biddingStrategySystemStatus: string;
  readonly portfolioBiddingStrategyResourceName: string | null;
  readonly standardTargetCpaMicros: number | null;
  readonly standardTargetRoas: number | null;
  readonly costMicros: number;
  readonly conversions: number;
  readonly conversionValue: number;
}

export interface GoogleAdsPortfolioSnapshot {
  readonly customerId: string;
  readonly resourceName: string;
  readonly strategyId: string;
  readonly type: GoogleAdsBiddingStrategyType;
  readonly targetCpaMicros: number | null;
  readonly targetRoas: number | null;
  readonly cpcBidCeilingMicros: number | null;
  readonly cpcBidFloorMicros: number | null;
  readonly costMicros: number;
  readonly conversions: number;
  readonly conversionValue: number;
}

export type GoogleAdsControlMutation =
  | { readonly kind: "CAMPAIGN_BUDGET"; readonly resourceName: string; readonly expectedAmountMicros: number; readonly nextAmountMicros: number }
  | { readonly kind: "STANDARD_TARGET_CPA"; readonly resourceName: string; readonly expectedTargetCpaMicros: number; readonly nextTargetCpaMicros: number }
  | { readonly kind: "STANDARD_TARGET_ROAS"; readonly resourceName: string; readonly expectedTargetRoas: number; readonly nextTargetRoas: number }
  | { readonly kind: "PORTFOLIO_TARGET_CPA"; readonly resourceName: string; readonly strategyType: "TARGET_CPA" | "MAXIMIZE_CONVERSIONS"; readonly expectedTargetCpaMicros: number; readonly nextTargetCpaMicros: number }
  | { readonly kind: "PORTFOLIO_TARGET_ROAS"; readonly resourceName: string; readonly strategyType: "TARGET_ROAS" | "MAXIMIZE_CONVERSION_VALUE"; readonly expectedTargetRoas: number; readonly nextTargetRoas: number }
  | { readonly kind: "PORTFOLIO_BID_BOUNDS"; readonly resourceName: string; readonly strategyType: "TARGET_CPA" | "MAXIMIZE_CONVERSIONS" | "TARGET_ROAS" | "MAXIMIZE_CONVERSION_VALUE"; readonly expectedCeilingMicros: number | null; readonly nextCeilingMicros: number | null; readonly expectedFloorMicros: number | null; readonly nextFloorMicros: number | null };

export interface GoogleAdsMutationReceipt {
  readonly requestId: string | null;
  readonly resourceName: string;
  readonly recoveredAlreadyApplied: boolean;
}

export interface GoogleAdsAccessTokenProvider { (): Promise<string> }

export interface GoogleAdsRestClientConfig {
  readonly developerToken: string;
  readonly loginCustomerId?: string;
  readonly accessTokenProvider: GoogleAdsAccessTokenProvider;
  readonly fetchImpl?: typeof fetch;
  readonly maxReadRetries?: number;
  readonly timeoutMs?: number;
  readonly sleep?: (ms: number) => Promise<void>;
}

export interface GoogleOAuthRefreshTokenConfig {
  readonly clientId: string;
  readonly clientSecret: string;
  readonly refreshToken: string;
  readonly fetchImpl?: typeof fetch;
  readonly now?: () => number;
  readonly timeoutMs?: number;
}

export class GoogleAdsApiError extends Error {
  constructor(
    public readonly code:
      | "INVALID_CONFIG"
      | "AUTHENTICATION_FAILED"
      | "API_ERROR"
      | "QUOTA_EXHAUSTED"
      | "REMOTE_CONFLICT"
      | "INVALID_RESPONSE"
      | "TIMEOUT"
      | "AMBIGUOUS_MUTATION_OUTCOME",
    message: string,
    public readonly httpStatus: number | null = null,
    public readonly requestId: string | null = null,
    public readonly googleStatus: string | null = null,
  ) {
    super(message);
    this.name = "GoogleAdsApiError";
  }
}

function requireSecret(value: string, name: string): string {
  const normalized = value.trim();
  if (!normalized) throw new GoogleAdsApiError("INVALID_CONFIG", `${name} is required`);
  return normalized;
}

function normalizeNumericId(value: string, name: string): string {
  const normalized = value.replaceAll("-", "").trim();
  if (!/^\d{5,20}$/.test(normalized)) throw new GoogleAdsApiError("INVALID_CONFIG", `${name} is malformed`);
  return normalized;
}

function apiNumericId(value: unknown, name: string): string {
  const normalized = typeof value === "number" && Number.isSafeInteger(value) ? String(value) : typeof value === "string" ? value : "";
  if (!/^\d{1,20}$/.test(normalized)) throw new GoogleAdsApiError("INVALID_RESPONSE", `${name} is malformed`);
  return normalized;
}

function positiveSafeInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new GoogleAdsApiError("INVALID_CONFIG", `${name} must be a positive safe integer`);
  return value;
}

function numberFromApi(value: unknown, name: string, fallback = 0): number {
  if (value === undefined || value === null || value === "") return fallback;
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed)) throw new GoogleAdsApiError("INVALID_RESPONSE", `${name} is not finite`);
  return parsed;
}

function nullableNumberFromApi(value: unknown, name: string): number | null {
  if (value === undefined || value === null || value === "") return null;
  return numberFromApi(value, name);
}

function microsFromApi(value: unknown, name: string): number {
  const parsed = numberFromApi(value, name);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new GoogleAdsApiError("INVALID_RESPONSE", `${name} is outside safe integer range`);
  return parsed;
}

function nullableMicrosFromApi(value: unknown, name: string): number | null {
  if (value === undefined || value === null || value === "") return null;
  return microsFromApi(value, name);
}

function asObject(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new GoogleAdsApiError("INVALID_RESPONSE", `${name} must be an object`);
  return value as Record<string, unknown>;
}

function optionalObject(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function stringField(value: unknown, name: string): string {
  if (typeof value !== "string" || !value) throw new GoogleAdsApiError("INVALID_RESPONSE", `${name} must be a non-empty string`);
  return value;
}

function parseStrategyType(value: unknown): GoogleAdsBiddingStrategyType {
  return value === "MAXIMIZE_CONVERSIONS" || value === "MAXIMIZE_CONVERSION_VALUE" || value === "TARGET_CPA" || value === "TARGET_ROAS" ? value : "OTHER";
}

function resourceId(resourceName: string, segment: string): string {
  const match = new RegExp(`/${segment}/(\\d+)$`).exec(resourceName);
  if (!match?.[1]) throw new GoogleAdsApiError("INVALID_RESPONSE", `resource name is not a ${segment} resource`);
  return match[1];
}

function gaqlDate(ms: number): string {
  const date = new Date(ms);
  if (!Number.isFinite(date.getTime())) throw new GoogleAdsApiError("INVALID_CONFIG", "GAQL date is invalid");
  return date.toISOString().slice(0, 10);
}

function retryAfterMs(value: string | null): number | null {
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(60_000, Math.ceil(seconds * 1_000));
  const absolute = Date.parse(value);
  return Number.isFinite(absolute) ? Math.min(60_000, Math.max(0, absolute - Date.now())) : null;
}

function googleError(payload: unknown): { readonly status: string | null; readonly message: string } {
  const root = optionalObject(payload);
  const error = optionalObject(root?.error);
  return {
    status: typeof error?.status === "string" ? error.status : null,
    message: typeof error?.message === "string" && error.message ? error.message.slice(0, 500) : "Google Ads API request failed",
  };
}

function sameNumber(left: number | null, right: number | null): boolean {
  return left === null || right === null ? left === right : Math.abs(left - right) <= 1e-9;
}

async function defaultSleep(ms: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, ms));
}

export function createGoogleOAuthRefreshTokenProvider(config: GoogleOAuthRefreshTokenConfig): GoogleAdsAccessTokenProvider {
  const clientId = requireSecret(config.clientId, "OAuth clientId");
  const clientSecret = requireSecret(config.clientSecret, "OAuth clientSecret");
  const refreshToken = requireSecret(config.refreshToken, "OAuth refreshToken");
  const fetchImpl = config.fetchImpl ?? fetch;
  const now = config.now ?? Date.now;
  const timeoutMs = config.timeoutMs ?? 15_000;
  positiveSafeInteger(timeoutMs, "OAuth timeoutMs");
  let cachedToken: string | null = null;
  let expiresAt = 0;
  let inFlight: Promise<string> | null = null;

  const refresh = async (): Promise<string> => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(GOOGLE_OAUTH_TOKEN_URL, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, refresh_token: refreshToken, grant_type: "refresh_token" }),
        signal: controller.signal,
        redirect: "error",
      });
      let payload: unknown = null;
      try { payload = await response.json(); } catch { payload = null; }
      if (!response.ok) throw new GoogleAdsApiError("AUTHENTICATION_FAILED", "OAuth access-token refresh failed", response.status);
      const root = asObject(payload, "OAuth response");
      const token = stringField(root.access_token, "OAuth access_token");
      const expiresIn = numberFromApi(root.expires_in, "OAuth expires_in");
      if (expiresIn <= 0) throw new GoogleAdsApiError("INVALID_RESPONSE", "OAuth expires_in must be positive");
      cachedToken = token;
      expiresAt = now() + Math.floor(expiresIn * 1_000);
      return token;
    } catch (error) {
      if (error instanceof GoogleAdsApiError) throw error;
      if (error instanceof DOMException && error.name === "AbortError") throw new GoogleAdsApiError("TIMEOUT", "OAuth access-token refresh timed out");
      throw new GoogleAdsApiError("AUTHENTICATION_FAILED", "OAuth access-token refresh failed");
    } finally {
      clearTimeout(timer);
    }
  };

  return async () => {
    if (cachedToken && expiresAt - now() > 300_000) return cachedToken;
    if (!inFlight) inFlight = refresh().finally(() => { inFlight = null; });
    return inFlight;
  };
}

export class GoogleAdsRestClient {
  private readonly developerToken: string;
  private readonly loginCustomerId: string | null;
  private readonly accessTokenProvider: GoogleAdsAccessTokenProvider;
  private readonly fetchImpl: typeof fetch;
  private readonly maxReadRetries: number;
  private readonly timeoutMs: number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(config: GoogleAdsRestClientConfig) {
    this.developerToken = requireSecret(config.developerToken, "developerToken");
    this.loginCustomerId = config.loginCustomerId ? normalizeNumericId(config.loginCustomerId, "loginCustomerId") : null;
    this.accessTokenProvider = config.accessTokenProvider;
    this.fetchImpl = config.fetchImpl ?? fetch;
    this.maxReadRetries = config.maxReadRetries ?? 2;
    if (!Number.isInteger(this.maxReadRetries) || this.maxReadRetries < 0 || this.maxReadRetries > 5) throw new GoogleAdsApiError("INVALID_CONFIG", "maxReadRetries must be an integer from 0 to 5");
    this.timeoutMs = config.timeoutMs ?? 20_000;
    positiveSafeInteger(this.timeoutMs, "timeoutMs");
    this.sleep = config.sleep ?? defaultSleep;
  }

  private async request(customerIdInput: string, path: string, body: Record<string, unknown>, retrySafe: boolean): Promise<{ readonly payload: unknown; readonly requestId: string | null }> {
    const customerId = normalizeNumericId(customerIdInput, "customerId");
    const url = `${GOOGLE_ADS_BASE_URL}/${GOOGLE_ADS_API_VERSION}/customers/${customerId}/${path}`;
    const attempts = retrySafe ? this.maxReadRetries + 1 : 1;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      const accessToken = requireSecret(await this.accessTokenProvider(), "OAuth access token");
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);
      try {
        const headers: Record<string, string> = { authorization: `Bearer ${accessToken}`, "content-type": "application/json", "developer-token": this.developerToken };
        if (this.loginCustomerId) headers["login-customer-id"] = this.loginCustomerId;
        const response = await this.fetchImpl(url, { method: "POST", headers, body: JSON.stringify(body), signal: controller.signal, redirect: "error" });
        const requestId = response.headers.get("request-id");
        let payload: unknown = null;
        try { payload = await response.json(); } catch { payload = null; }
        if (response.ok) return { payload, requestId };
        const detail = googleError(payload);
        if (retrySafe && (response.status === 429 || response.status >= 500) && attempt + 1 < attempts) {
          await this.sleep(retryAfterMs(response.headers.get("retry-after")) ?? Math.min(8_000, 500 * 2 ** attempt));
          continue;
        }
        if (!retrySafe && response.status >= 500) throw new GoogleAdsApiError("AMBIGUOUS_MUTATION_OUTCOME", "Google Ads mutation returned a server error; remote application is unconfirmed", response.status, requestId, detail.status);
        const code = response.status === 429 || detail.status === "RESOURCE_EXHAUSTED" ? "QUOTA_EXHAUSTED" : response.status === 401 || response.status === 403 ? "AUTHENTICATION_FAILED" : "API_ERROR";
        throw new GoogleAdsApiError(code, detail.message, response.status, requestId, detail.status);
      } catch (error) {
        if (error instanceof GoogleAdsApiError) throw error;
        const aborted = error instanceof DOMException && error.name === "AbortError";
        if (retrySafe && attempt + 1 < attempts) {
          await this.sleep(Math.min(8_000, 500 * 2 ** attempt));
          continue;
        }
        if (!retrySafe) throw new GoogleAdsApiError("AMBIGUOUS_MUTATION_OUTCOME", aborted ? "Google Ads mutation timed out; remote application is unconfirmed" : "Google Ads mutation transport failed; remote application is unconfirmed");
        if (aborted) throw new GoogleAdsApiError("TIMEOUT", "Google Ads API read timed out");
        throw new GoogleAdsApiError("API_ERROR", "Google Ads API read transport failed");
      } finally {
        clearTimeout(timer);
      }
    }
    throw new GoogleAdsApiError("API_ERROR", "Google Ads API retry loop exhausted");
  }

  private async search(customerId: string, query: string): Promise<readonly Record<string, unknown>[]> {
    const { payload } = await this.request(customerId, "googleAds:search", { query }, true);
    const root = asObject(payload, "Google Ads search response");
    if (root.nextPageToken) throw new GoogleAdsApiError("INVALID_RESPONSE", "supervisor query unexpectedly exceeded one page");
    if (root.results === undefined) return [];
    if (!Array.isArray(root.results)) throw new GoogleAdsApiError("INVALID_RESPONSE", "Google Ads search results must be an array");
    return root.results.map((row, index) => asObject(row, `Google Ads search result ${index}`));
  }

  async getCampaignSnapshot(customerIdInput: string, campaignIdInput: string, startMs: number, endMs: number): Promise<GoogleAdsCampaignSnapshot> {
    const customerId = normalizeNumericId(customerIdInput, "customerId");
    const campaignId = normalizeNumericId(campaignIdInput, "campaignId");
    if (startMs > endMs) throw new GoogleAdsApiError("INVALID_CONFIG", "report start must not be after report end");
    const query = [
      "SELECT campaign.id, campaign.name, campaign.resource_name, campaign.status, campaign.campaign_budget, campaign.bidding_strategy, campaign.bidding_strategy_type, campaign.bidding_strategy_system_status,",
      "campaign.maximize_conversions.target_cpa_micros, campaign.maximize_conversion_value.target_roas,",
      "campaign_budget.amount_micros, campaign_budget.explicitly_shared, campaign_budget.recommended_budget_amount_micros,",
      "metrics.cost_micros, metrics.conversions, metrics.conversions_value FROM campaign",
      `WHERE campaign.id = ${campaignId} AND segments.date BETWEEN '${gaqlDate(startMs)}' AND '${gaqlDate(endMs)}' LIMIT 1`,
    ].join(" ");
    const rows = await this.search(customerId, query);
    if (rows.length !== 1) throw new GoogleAdsApiError("INVALID_RESPONSE", `expected exactly one Google Ads campaign row, got ${rows.length}`);
    const campaign = asObject(rows[0]!.campaign, "campaign");
    if (apiNumericId(campaign.id, "campaign.id") !== campaignId) throw new GoogleAdsApiError("INVALID_RESPONSE", "Google Ads campaign id did not match requested campaign");
    const budget = asObject(rows[0]!.campaignBudget, "campaignBudget");
    const metrics = optionalObject(rows[0]!.metrics) ?? {};
    const maximizeConversions = optionalObject(campaign.maximizeConversions);
    const maximizeConversionValue = optionalObject(campaign.maximizeConversionValue);
    return Object.freeze({
      customerId,
      campaignId,
      campaignResourceName: stringField(campaign.resourceName, "campaign.resourceName"),
      campaignName: stringField(campaign.name, "campaign.name"),
      status: stringField(campaign.status, "campaign.status"),
      budgetResourceName: stringField(campaign.campaignBudget, "campaign.campaignBudget"),
      budgetAmountMicros: microsFromApi(budget.amountMicros, "campaignBudget.amountMicros"),
      budgetExplicitlyShared: budget.explicitlyShared === true,
      recommendedBudgetAmountMicros: nullableMicrosFromApi(budget.recommendedBudgetAmountMicros, "campaignBudget.recommendedBudgetAmountMicros"),
      biddingStrategyType: parseStrategyType(campaign.biddingStrategyType),
      biddingStrategySystemStatus: stringField(campaign.biddingStrategySystemStatus, "campaign.biddingStrategySystemStatus"),
      portfolioBiddingStrategyResourceName: typeof campaign.biddingStrategy === "string" && campaign.biddingStrategy ? campaign.biddingStrategy : null,
      standardTargetCpaMicros: nullableMicrosFromApi(maximizeConversions?.targetCpaMicros, "campaign.maximizeConversions.targetCpaMicros"),
      standardTargetRoas: nullableNumberFromApi(maximizeConversionValue?.targetRoas, "campaign.maximizeConversionValue.targetRoas"),
      costMicros: microsFromApi(metrics.costMicros ?? 0, "metrics.costMicros"),
      conversions: numberFromApi(metrics.conversions, "metrics.conversions", 0),
      conversionValue: numberFromApi(metrics.conversionsValue, "metrics.conversionsValue", 0),
    });
  }

  async getPortfolioSnapshot(customerIdInput: string, resourceName: string, startMs: number, endMs: number): Promise<GoogleAdsPortfolioSnapshot> {
    const customerId = normalizeNumericId(customerIdInput, "customerId");
    const strategyId = resourceId(resourceName, "biddingStrategies");
    const query = [
      "SELECT bidding_strategy.resource_name, bidding_strategy.id, bidding_strategy.type,",
      "bidding_strategy.target_cpa.target_cpa_micros, bidding_strategy.target_cpa.cpc_bid_ceiling_micros, bidding_strategy.target_cpa.cpc_bid_floor_micros,",
      "bidding_strategy.maximize_conversions.target_cpa_micros, bidding_strategy.maximize_conversions.cpc_bid_ceiling_micros, bidding_strategy.maximize_conversions.cpc_bid_floor_micros,",
      "bidding_strategy.target_roas.target_roas, bidding_strategy.target_roas.cpc_bid_ceiling_micros, bidding_strategy.target_roas.cpc_bid_floor_micros,",
      "bidding_strategy.maximize_conversion_value.target_roas, bidding_strategy.maximize_conversion_value.cpc_bid_ceiling_micros, bidding_strategy.maximize_conversion_value.cpc_bid_floor_micros,",
      "metrics.cost_micros, metrics.conversions, metrics.conversions_value FROM bidding_strategy",
      `WHERE bidding_strategy.id = ${strategyId} AND segments.date BETWEEN '${gaqlDate(startMs)}' AND '${gaqlDate(endMs)}' LIMIT 1`,
    ].join(" ");
    const rows = await this.search(customerId, query);
    if (rows.length !== 1) throw new GoogleAdsApiError("INVALID_RESPONSE", `expected exactly one portfolio strategy row, got ${rows.length}`);
    const strategy = asObject(rows[0]!.biddingStrategy, "biddingStrategy");
    if (apiNumericId(strategy.id, "biddingStrategy.id") !== strategyId) throw new GoogleAdsApiError("INVALID_RESPONSE", "Google Ads bidding strategy id did not match requested strategy");
    const observedResourceName = stringField(strategy.resourceName, "biddingStrategy.resourceName");
    if (observedResourceName !== resourceName) throw new GoogleAdsApiError("INVALID_RESPONSE", "Google Ads bidding strategy resource name changed");
    const metrics = optionalObject(rows[0]!.metrics) ?? {};
    const type = parseStrategyType(strategy.type);
    const scheme = type === "TARGET_CPA" ? optionalObject(strategy.targetCpa) : type === "MAXIMIZE_CONVERSIONS" ? optionalObject(strategy.maximizeConversions) : type === "TARGET_ROAS" ? optionalObject(strategy.targetRoas) : type === "MAXIMIZE_CONVERSION_VALUE" ? optionalObject(strategy.maximizeConversionValue) : undefined;
    return Object.freeze({
      customerId,
      resourceName: observedResourceName,
      strategyId,
      type,
      targetCpaMicros: type === "TARGET_CPA" || type === "MAXIMIZE_CONVERSIONS" ? nullableMicrosFromApi(scheme?.targetCpaMicros, "biddingStrategy target CPA") : null,
      targetRoas: type === "TARGET_ROAS" || type === "MAXIMIZE_CONVERSION_VALUE" ? nullableNumberFromApi(scheme?.targetRoas, "biddingStrategy target ROAS") : null,
      cpcBidCeilingMicros: nullableMicrosFromApi(scheme?.cpcBidCeilingMicros, "biddingStrategy cpcBidCeilingMicros"),
      cpcBidFloorMicros: nullableMicrosFromApi(scheme?.cpcBidFloorMicros, "biddingStrategy cpcBidFloorMicros"),
      costMicros: microsFromApi(metrics.costMicros ?? 0, "metrics.costMicros"),
      conversions: numberFromApi(metrics.conversions, "metrics.conversions", 0),
      conversionValue: numberFromApi(metrics.conversionsValue, "metrics.conversionsValue", 0),
    });
  }

  private async campaignControls(customerId: string, campaignResourceName: string) {
    const campaignId = resourceId(campaignResourceName, "campaigns");
    const rows = await this.search(customerId, `SELECT campaign.resource_name, campaign.campaign_budget, campaign.maximize_conversions.target_cpa_micros, campaign.maximize_conversion_value.target_roas, campaign_budget.amount_micros FROM campaign WHERE campaign.id = ${campaignId} LIMIT 1`);
    if (rows.length !== 1) throw new GoogleAdsApiError("REMOTE_CONFLICT", "campaign no longer resolves uniquely");
    const campaign = asObject(rows[0]!.campaign, "campaign");
    const budget = asObject(rows[0]!.campaignBudget, "campaignBudget");
    return Object.freeze({
      budgetResourceName: stringField(campaign.campaignBudget, "campaign.campaignBudget"),
      budgetAmountMicros: microsFromApi(budget.amountMicros, "campaignBudget.amountMicros"),
      targetCpaMicros: nullableMicrosFromApi(optionalObject(campaign.maximizeConversions)?.targetCpaMicros, "campaign target CPA"),
      targetRoas: nullableNumberFromApi(optionalObject(campaign.maximizeConversionValue)?.targetRoas, "campaign target ROAS"),
    });
  }

  private async portfolioControls(customerId: string, resourceName: string, strategyType: GoogleAdsBiddingStrategyType) {
    const strategyId = resourceId(resourceName, "biddingStrategies");
    const rows = await this.search(customerId, [
      "SELECT bidding_strategy.resource_name, bidding_strategy.type, bidding_strategy.target_cpa.target_cpa_micros, bidding_strategy.target_cpa.cpc_bid_ceiling_micros, bidding_strategy.target_cpa.cpc_bid_floor_micros,",
      "bidding_strategy.maximize_conversions.target_cpa_micros, bidding_strategy.maximize_conversions.cpc_bid_ceiling_micros, bidding_strategy.maximize_conversions.cpc_bid_floor_micros,",
      "bidding_strategy.target_roas.target_roas, bidding_strategy.target_roas.cpc_bid_ceiling_micros, bidding_strategy.target_roas.cpc_bid_floor_micros,",
      "bidding_strategy.maximize_conversion_value.target_roas, bidding_strategy.maximize_conversion_value.cpc_bid_ceiling_micros, bidding_strategy.maximize_conversion_value.cpc_bid_floor_micros",
      `FROM bidding_strategy WHERE bidding_strategy.id = ${strategyId} LIMIT 1`,
    ].join(" "));
    if (rows.length !== 1) throw new GoogleAdsApiError("REMOTE_CONFLICT", "portfolio strategy no longer resolves uniquely");
    const strategy = asObject(rows[0]!.biddingStrategy, "biddingStrategy");
    const observedType = parseStrategyType(strategy.type);
    if (observedType !== strategyType) throw new GoogleAdsApiError("REMOTE_CONFLICT", "portfolio strategy type changed before mutation");
    const scheme = observedType === "TARGET_CPA" ? optionalObject(strategy.targetCpa) : observedType === "MAXIMIZE_CONVERSIONS" ? optionalObject(strategy.maximizeConversions) : observedType === "TARGET_ROAS" ? optionalObject(strategy.targetRoas) : observedType === "MAXIMIZE_CONVERSION_VALUE" ? optionalObject(strategy.maximizeConversionValue) : undefined;
    return Object.freeze({
      targetCpaMicros: observedType === "TARGET_CPA" || observedType === "MAXIMIZE_CONVERSIONS" ? nullableMicrosFromApi(scheme?.targetCpaMicros, "portfolio target CPA") : null,
      targetRoas: observedType === "TARGET_ROAS" || observedType === "MAXIMIZE_CONVERSION_VALUE" ? nullableNumberFromApi(scheme?.targetRoas, "portfolio target ROAS") : null,
      ceilingMicros: nullableMicrosFromApi(scheme?.cpcBidCeilingMicros, "portfolio CPC ceiling"),
      floorMicros: nullableMicrosFromApi(scheme?.cpcBidFloorMicros, "portfolio CPC floor"),
    });
  }

  async applyMutation(customerIdInput: string, action: GoogleAdsControlMutation): Promise<GoogleAdsMutationReceipt> {
    const customerId = normalizeNumericId(customerIdInput, "customerId");
    let path: string;
    let updateMask: string;
    let update: Record<string, unknown>;

    if (action.kind === "CAMPAIGN_BUDGET") {
      const budgetId = resourceId(action.resourceName, "campaignBudgets");
      const rows = await this.search(customerId, `SELECT campaign_budget.resource_name, campaign_budget.amount_micros FROM campaign_budget WHERE campaign_budget.id = ${budgetId} LIMIT 1`);
      if (rows.length !== 1) throw new GoogleAdsApiError("REMOTE_CONFLICT", "campaign budget no longer resolves uniquely");
      const current = microsFromApi(asObject(rows[0]!.campaignBudget, "campaignBudget").amountMicros, "campaignBudget.amountMicros");
      if (current === action.nextAmountMicros) return Object.freeze({ requestId: null, resourceName: action.resourceName, recoveredAlreadyApplied: true });
      if (current !== action.expectedAmountMicros) throw new GoogleAdsApiError("REMOTE_CONFLICT", "campaign budget changed after supervisor observation");
      path = "campaignBudgets:mutate";
      updateMask = "amount_micros";
      update = { resourceName: action.resourceName, amountMicros: action.nextAmountMicros };
    } else if (action.kind === "STANDARD_TARGET_CPA" || action.kind === "STANDARD_TARGET_ROAS") {
      const current = await this.campaignControls(customerId, action.resourceName);
      path = "campaigns:mutate";
      if (action.kind === "STANDARD_TARGET_CPA") {
        if (current.targetCpaMicros === action.nextTargetCpaMicros) return Object.freeze({ requestId: null, resourceName: action.resourceName, recoveredAlreadyApplied: true });
        if (current.targetCpaMicros !== action.expectedTargetCpaMicros) throw new GoogleAdsApiError("REMOTE_CONFLICT", "campaign target CPA changed after supervisor observation");
        updateMask = "maximize_conversions.target_cpa_micros";
        update = { resourceName: action.resourceName, maximizeConversions: { targetCpaMicros: action.nextTargetCpaMicros } };
      } else {
        if (sameNumber(current.targetRoas, action.nextTargetRoas)) return Object.freeze({ requestId: null, resourceName: action.resourceName, recoveredAlreadyApplied: true });
        if (!sameNumber(current.targetRoas, action.expectedTargetRoas)) throw new GoogleAdsApiError("REMOTE_CONFLICT", "campaign target ROAS changed after supervisor observation");
        updateMask = "maximize_conversion_value.target_roas";
        update = { resourceName: action.resourceName, maximizeConversionValue: { targetRoas: action.nextTargetRoas } };
      }
    } else {
      const current = await this.portfolioControls(customerId, action.resourceName, action.strategyType);
      const schemeKey = action.strategyType === "TARGET_CPA" ? "targetCpa" : action.strategyType === "MAXIMIZE_CONVERSIONS" ? "maximizeConversions" : action.strategyType === "TARGET_ROAS" ? "targetRoas" : "maximizeConversionValue";
      const maskPrefix = action.strategyType === "TARGET_CPA" ? "target_cpa" : action.strategyType === "MAXIMIZE_CONVERSIONS" ? "maximize_conversions" : action.strategyType === "TARGET_ROAS" ? "target_roas" : "maximize_conversion_value";
      const scheme: Record<string, unknown> = {};
      const masks: string[] = [];
      if (action.kind === "PORTFOLIO_TARGET_CPA") {
        if (current.targetCpaMicros === action.nextTargetCpaMicros) return Object.freeze({ requestId: null, resourceName: action.resourceName, recoveredAlreadyApplied: true });
        if (current.targetCpaMicros !== action.expectedTargetCpaMicros) throw new GoogleAdsApiError("REMOTE_CONFLICT", "portfolio target CPA changed after supervisor observation");
        scheme.targetCpaMicros = action.nextTargetCpaMicros;
        masks.push(`${maskPrefix}.target_cpa_micros`);
      } else if (action.kind === "PORTFOLIO_TARGET_ROAS") {
        if (sameNumber(current.targetRoas, action.nextTargetRoas)) return Object.freeze({ requestId: null, resourceName: action.resourceName, recoveredAlreadyApplied: true });
        if (!sameNumber(current.targetRoas, action.expectedTargetRoas)) throw new GoogleAdsApiError("REMOTE_CONFLICT", "portfolio target ROAS changed after supervisor observation");
        scheme.targetRoas = action.nextTargetRoas;
        masks.push(`${maskPrefix}.target_roas`);
      } else {
        if (current.ceilingMicros === action.nextCeilingMicros && current.floorMicros === action.nextFloorMicros) return Object.freeze({ requestId: null, resourceName: action.resourceName, recoveredAlreadyApplied: true });
        if (current.ceilingMicros !== action.expectedCeilingMicros || current.floorMicros !== action.expectedFloorMicros) throw new GoogleAdsApiError("REMOTE_CONFLICT", "portfolio bid bounds changed after supervisor observation");
        if (action.nextCeilingMicros !== action.expectedCeilingMicros) {
          if (action.nextCeilingMicros === null) throw new GoogleAdsApiError("INVALID_CONFIG", "supervisor does not clear portfolio CPC ceilings");
          scheme.cpcBidCeilingMicros = action.nextCeilingMicros;
          masks.push(`${maskPrefix}.cpc_bid_ceiling_micros`);
        }
        if (action.nextFloorMicros !== action.expectedFloorMicros) {
          if (action.nextFloorMicros === null) throw new GoogleAdsApiError("INVALID_CONFIG", "supervisor does not clear portfolio CPC floors");
          scheme.cpcBidFloorMicros = action.nextFloorMicros;
          masks.push(`${maskPrefix}.cpc_bid_floor_micros`);
        }
        if (masks.length === 0) throw new GoogleAdsApiError("INVALID_CONFIG", "portfolio bid-bounds mutation has no changes");
      }
      path = "biddingStrategies:mutate";
      updateMask = masks.join(",");
      update = { resourceName: action.resourceName, [schemeKey]: scheme };
    }

    const { payload, requestId } = await this.request(customerId, path, { operations: [{ updateMask, update }] }, false);
    try {
      const root = asObject(payload, "Google Ads mutate response");
      if (!Array.isArray(root.results) || root.results.length !== 1) throw new GoogleAdsApiError("INVALID_RESPONSE", "Google Ads mutate response must contain one result");
      const resourceName = stringField(asObject(root.results[0], "Google Ads mutate result").resourceName, "Google Ads mutate resourceName");
      if (resourceName !== action.resourceName) throw new GoogleAdsApiError("INVALID_RESPONSE", "Google Ads mutate result resource did not match requested resource");
      return Object.freeze({ requestId, resourceName, recoveredAlreadyApplied: false });
    } catch (error) {
      if (error instanceof GoogleAdsApiError && error.code === "AMBIGUOUS_MUTATION_OUTCOME") throw error;
      throw new GoogleAdsApiError("AMBIGUOUS_MUTATION_OUTCOME", "Google Ads accepted the mutation request but the response could not certify the resulting resource", 200, requestId);
    }
  }
}
