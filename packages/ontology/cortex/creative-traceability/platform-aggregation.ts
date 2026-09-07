import { SqliteCreativeTraceRegistry, type AggregatedMetricResolution } from "./index.js";
import type { GoogleAdsAccessTokenProvider } from "../bidding-supervisor/google-ads-rest.js";

const GOOGLE_ADS_BASE_URL = "https://googleads.googleapis.com/v25";
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
const NUMERIC_ID = /^\d{1,20}$/u;

export type PlatformEntityKind = "AD" | "AD_ASSET" | "PMAX_ASSET" | "ASSET_GROUP" | "CAMPAIGN";

export interface PlatformCreativeBinding {
  readonly kind: PlatformEntityKind;
  readonly platformId: string;
  readonly traceKeys: readonly string[];
}

export interface GoogleAdsCreativeMetricRow {
  readonly source: "AD_GROUP_AD" | "AD_GROUP_AD_ASSET_VIEW" | "ASSET_GROUP_ASSET" | "ASSET_GROUP" | "CAMPAIGN";
  readonly campaignId: string;
  readonly adGroupId: string | null;
  readonly adId: string | null;
  readonly assetGroupId: string | null;
  readonly assetId: string | null;
  readonly impressions: number;
  readonly clicks: number;
  readonly conversions: number;
  readonly conversionValue: number;
  readonly costMicros: number;
}

export interface CreativeAttributionScore {
  readonly entityKey: string;
  readonly source: GoogleAdsCreativeMetricRow["source"];
  readonly resolution: AggregatedMetricResolution["resolution"] | "UNBOUND";
  readonly creativeIds: readonly string[];
  readonly manifestDigests: readonly string[];
  readonly metrics: Readonly<{ impressions: number; clicks: number; conversions: number; conversionValue: number; costMicros: number }>;
  readonly efficiencyScore: number | null;
  readonly scoreScope: "INDIVIDUAL_CREATIVE" | "AGGREGATED_SET" | "UNRESOLVED";
}

export interface GoogleAdsCreativeMetricsConfig {
  readonly customerId: string;
  readonly developerToken: string;
  readonly accessTokenProvider: GoogleAdsAccessTokenProvider;
  readonly loginCustomerId?: string;
  readonly fetchImpl?: typeof fetch;
  readonly timeoutMs?: number;
}

export class Cortex36Error extends Error {
  constructor(public readonly code: "INVALID_CONFIG" | "INVALID_INPUT" | "API_ERROR" | "INVALID_RESPONSE" | "AMBIGUOUS_BINDING", message: string) {
    super(message);
    this.name = "Cortex36Error";
  }
}

function numericId(value: string, label: string): string {
  const normalized = value.replaceAll("-", "").trim();
  if (!/^\d{5,20}$/u.test(normalized)) throw new Cortex36Error("INVALID_CONFIG", `${label} is malformed`);
  return normalized;
}
function secret(value: string, label: string): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > 8192 || /[\r\n\0]/u.test(normalized)) throw new Cortex36Error("INVALID_CONFIG", `${label} is invalid`);
  return normalized;
}
function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Cortex36Error("INVALID_RESPONSE", `${label} must be an object`);
  return value as Record<string, unknown>;
}
function finite(value: unknown, label: string): number {
  const parsed = typeof value === "number" ? value : Number(value ?? 0);
  if (!Number.isFinite(parsed) || parsed < 0) throw new Cortex36Error("INVALID_RESPONSE", `${label} is invalid`);
  return parsed;
}
function idFromResource(value: unknown, segment: string, nullable = false): string | null {
  if ((value === undefined || value === null || value === "") && nullable) return null;
  if (typeof value !== "string") throw new Cortex36Error("INVALID_RESPONSE", `${segment} resource name is missing`);
  const match = new RegExp(`/${segment}/(\\d+)(?:~\\d+)?$`, "u").exec(value);
  if (!match?.[1]) throw new Cortex36Error("INVALID_RESPONSE", `${segment} resource name is malformed`);
  return match[1];
}

async function boundedJson(response: Response): Promise<unknown> {
  const declared = response.headers.get("content-length");
  if (declared !== null && (!/^\d+$/u.test(declared) || Number(declared) > MAX_RESPONSE_BYTES)) throw new Cortex36Error("INVALID_RESPONSE", "Google Ads response is oversized");
  if (!response.body) return null;
  const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let total = 0;
  try {
    for (;;) {
      const next = await reader.read(); if (next.done) break; total += next.value.byteLength;
      if (total > MAX_RESPONSE_BYTES) { await reader.cancel().catch(() => undefined); throw new Cortex36Error("INVALID_RESPONSE", "Google Ads response is oversized"); }
      chunks.push(next.value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(total); let offset = 0; for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  try { return total ? JSON.parse(new TextDecoder().decode(bytes)) as unknown : null; }
  catch { throw new Cortex36Error("INVALID_RESPONSE", "Google Ads response is malformed JSON"); }
}

export class GoogleAdsCreativeMetricsClient {
  private readonly customerId: string;
  private readonly developerToken: string;
  private readonly loginCustomerId?: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(private readonly config: GoogleAdsCreativeMetricsConfig) {
    this.customerId = numericId(config.customerId, "customerId");
    this.developerToken = secret(config.developerToken, "developerToken");
    this.loginCustomerId = config.loginCustomerId ? numericId(config.loginCustomerId, "loginCustomerId") : undefined;
    this.fetchImpl = config.fetchImpl ?? fetch;
    this.timeoutMs = config.timeoutMs ?? 15_000;
    if (!Number.isSafeInteger(this.timeoutMs) || this.timeoutMs < 1000 || this.timeoutMs > 120_000) throw new Cortex36Error("INVALID_CONFIG", "timeoutMs is invalid");
  }

  private async search(query: string): Promise<readonly Record<string, unknown>[]> {
    const rows: Record<string, unknown>[] = []; let pageToken: string | undefined;
    for (let page = 0; page < 100; page += 1) {
      const token = secret(await this.config.accessTokenProvider(), "accessToken");
      const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), this.timeoutMs);
      let response: Response;
      try {
        response = await this.fetchImpl(`${GOOGLE_ADS_BASE_URL}/customers/${this.customerId}/googleAds:search`, { method: "POST", redirect: "error", signal: controller.signal, headers: { authorization: `Bearer ${token}`, "developer-token": this.developerToken, ...(this.loginCustomerId ? { "login-customer-id": this.loginCustomerId } : {}), "content-type": "application/json", accept: "application/json" }, body: JSON.stringify({ query, pageSize: 10_000, ...(pageToken ? { pageToken } : {}) }) });
      } catch (error) { throw new Cortex36Error("API_ERROR", controller.signal.aborted ? "Google Ads request timed out" : error instanceof Error ? error.message : "Google Ads transport failed"); }
      finally { clearTimeout(timer); }
      const parsed = await boundedJson(response);
      if (!response.ok) throw new Cortex36Error("API_ERROR", `Google Ads rejected request with HTTP ${response.status}`);
      const root = object(parsed, "search response"); const results = root.results ?? [];
      if (!Array.isArray(results)) throw new Cortex36Error("INVALID_RESPONSE", "results must be an array");
      for (const row of results) rows.push(object(row, "Google Ads row"));
      if (!root.nextPageToken) return Object.freeze(rows);
      if (typeof root.nextPageToken !== "string" || root.nextPageToken.length > 4096) throw new Cortex36Error("INVALID_RESPONSE", "nextPageToken is invalid");
      pageToken = root.nextPageToken;
    }
    throw new Cortex36Error("INVALID_RESPONSE", "pagination exceeded safety limit");
  }

  private metricRow(row: Record<string, unknown>, source: GoogleAdsCreativeMetricRow["source"]): GoogleAdsCreativeMetricRow {
    const campaign = object(row.campaign, "campaign"); const metrics = object(row.metrics, "metrics");
    const campaignId = String(campaign.id ?? ""); if (!NUMERIC_ID.test(campaignId)) throw new Cortex36Error("INVALID_RESPONSE", "campaign.id is malformed");
    const adGroup = row.adGroup ? object(row.adGroup, "adGroup") : null;
    const adGroupAd = row.adGroupAd ? object(row.adGroupAd, "adGroupAd") : null;
    const ad = adGroupAd?.ad ? object(adGroupAd.ad, "ad") : null;
    const asset = row.asset ? object(row.asset, "asset") : null;
    const assetGroup = row.assetGroup ? object(row.assetGroup, "assetGroup") : null;
    return Object.freeze({ source, campaignId, adGroupId: adGroup?.id === undefined ? null : String(adGroup.id), adId: ad?.id === undefined ? null : String(ad.id), assetGroupId: assetGroup?.id === undefined ? null : String(assetGroup.id), assetId: asset?.id === undefined ? null : String(asset.id), impressions: finite(metrics.impressions, "impressions"), clicks: finite(metrics.clicks, "clicks"), conversions: finite(metrics.conversions, "conversions"), conversionValue: finite(metrics.conversionsValue, "conversionsValue"), costMicros: finite(metrics.costMicros, "costMicros") });
  }

  async collect(): Promise<readonly GoogleAdsCreativeMetricRow[]> {
    const rows: GoogleAdsCreativeMetricRow[] = [];
    for (const row of await this.search("SELECT campaign.id, ad_group.id, ad_group_ad.ad.id, metrics.impressions, metrics.clicks, metrics.conversions, metrics.conversions_value, metrics.cost_micros FROM ad_group_ad WHERE campaign.status != 'REMOVED'")) rows.push(this.metricRow(row, "AD_GROUP_AD"));
    for (const row of await this.search("SELECT campaign.id, ad_group.id, ad_group_ad.ad.id, asset.id, metrics.impressions, metrics.clicks, metrics.conversions, metrics.conversions_value, metrics.cost_micros FROM ad_group_ad_asset_view WHERE campaign.status != 'REMOVED'")) rows.push(this.metricRow(row, "AD_GROUP_AD_ASSET_VIEW"));
    for (const row of await this.search("SELECT campaign.id, asset_group.id, asset.id, metrics.impressions, metrics.clicks, metrics.conversions, metrics.conversions_value, metrics.cost_micros FROM asset_group_asset WHERE campaign.status != 'REMOVED'")) rows.push(this.metricRow(row, "ASSET_GROUP_ASSET"));
    return Object.freeze(rows);
  }
}

function bindingKey(kind: PlatformEntityKind, id: string): string { return `${kind}:${id}`; }
function entityFor(row: GoogleAdsCreativeMetricRow): { kind: PlatformEntityKind; id: string } {
  if (row.source === "AD_GROUP_AD" && row.adId) return { kind: "AD", id: row.adId };
  if (row.source === "AD_GROUP_AD_ASSET_VIEW" && row.adId && row.assetId) return { kind: "AD_ASSET", id: `${row.adId}:${row.assetId}` };
  if (row.source === "ASSET_GROUP_ASSET" && row.assetId) return { kind: "PMAX_ASSET", id: row.assetId };
  if (row.source === "ASSET_GROUP" && row.assetGroupId) return { kind: "ASSET_GROUP", id: row.assetGroupId };
  return { kind: "CAMPAIGN", id: row.campaignId };
}

export function scoreCreativeAttribution(registry: SqliteCreativeTraceRegistry, rows: readonly GoogleAdsCreativeMetricRow[], bindings: readonly PlatformCreativeBinding[]): readonly CreativeAttributionScore[] {
  const bindingMap = new Map<string, readonly string[]>();
  for (const binding of bindings) {
    if (!binding.platformId || !Array.isArray(binding.traceKeys) || binding.traceKeys.length < 1 || new Set(binding.traceKeys).size !== binding.traceKeys.length) throw new Cortex36Error("INVALID_INPUT", "creative platform binding is invalid");
    const key = bindingKey(binding.kind, binding.platformId);
    if (bindingMap.has(key)) throw new Cortex36Error("AMBIGUOUS_BINDING", `duplicate platform binding ${key}`);
    bindingMap.set(key, Object.freeze([...binding.traceKeys]));
  }
  return Object.freeze(rows.map((row): CreativeAttributionScore => {
    const entity = entityFor(row); const key = bindingKey(entity.kind, entity.id); const traceKeys = bindingMap.get(key);
    const metrics = Object.freeze({ impressions: row.impressions, clicks: row.clicks, conversions: row.conversions, conversionValue: row.conversionValue, costMicros: row.costMicros });
    if (!traceKeys) return Object.freeze({ entityKey: key, source: row.source, resolution: "UNBOUND", creativeIds: Object.freeze([]), manifestDigests: Object.freeze([]), metrics, efficiencyScore: null, scoreScope: "UNRESOLVED" });
    const resolution = registry.resolveAggregate({ aggregationId: `cortex36-${entity.kind.toLowerCase()}-${entity.id.replaceAll(":", "-")}`, metric: "google_ads_performance", value: row.conversionValue, traceKeys });
    const exact = resolution.resolution === "EXACT" && resolution.creativeIds.length === 1;
    const efficiencyScore = exact ? (row.costMicros > 0 ? row.conversionValue / (row.costMicros / 1_000_000) : row.conversionValue > 0 ? Number.POSITIVE_INFINITY : 0) : null;
    return Object.freeze({ entityKey: key, source: row.source, resolution: resolution.resolution, creativeIds: resolution.creativeIds, manifestDigests: resolution.manifestDigests, metrics, efficiencyScore, scoreScope: exact ? "INDIVIDUAL_CREATIVE" : resolution.resolvedTraceCount > 0 ? "AGGREGATED_SET" : "UNRESOLVED" });
  }));
}
