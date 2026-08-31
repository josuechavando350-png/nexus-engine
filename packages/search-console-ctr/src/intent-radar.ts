import { canonicalJson, digestValue, type SearchAnalyticsDataset } from "./index";

export interface IntentRadarScope {
  readonly tenantId: string;
  readonly organizationId: string;
  readonly brandId: string;
}

export interface ScopedSearchDataset {
  readonly scope: IntentRadarScope;
  readonly dataset: SearchAnalyticsDataset;
}

export interface IntentRule {
  readonly id: string;
  readonly label: string;
  readonly anyTokens: readonly string[];
  readonly allTokens?: readonly string[];
}

export interface IntentRadarLimits {
  readonly maxRowsPerDataset: number;
  readonly maxRules: number;
  readonly maxSignals: number;
  readonly maxQueryLength: number;
}

export type IntentRadarEvidenceState =
  | "OBSERVED_SEARCH_CONSOLE"
  | "SYNTHETIC"
  | "NOT_ENOUGH_EVIDENCE";

export interface IntentSignal {
  readonly query: string;
  readonly intentIds: readonly string[];
  readonly currentImpressions: number;
  readonly baselineImpressions: number;
  readonly currentClicks: number;
  readonly baselineClicks: number;
  readonly impressionDelta: number;
  readonly clickDelta: number;
  readonly relativeImpressionDelta: number | null;
  readonly score: number;
  readonly digest: string;
}

export interface IntentRadarReport {
  readonly formatVersion: "nexus-intent-radar-v1";
  readonly scope: IntentRadarScope;
  readonly evidenceState: IntentRadarEvidenceState;
  readonly nonClaim: "OBSERVATIONAL_SEARCH_DEMAND_NOT_CAUSAL_OR_MARKET_COMPLETE";
  readonly currentDatasetDigest: string;
  readonly baselineDatasetDigest: string;
  readonly currentWindow: Readonly<{ startDate: string; endDate: string }>;
  readonly baselineWindow: Readonly<{ startDate: string; endDate: string }>;
  readonly signals: readonly IntentSignal[];
  readonly unmatchedQueryCount: number;
  readonly reportDigest: string;
}

const DEFAULT_LIMITS: IntentRadarLimits = Object.freeze({
  maxRowsPerDataset: 25_000,
  maxRules: 128,
  maxSignals: 500,
  maxQueryLength: 500,
});

function clean(value: string): string {
  return value.normalize("NFKC").replace(/\s+/g, " ").trim();
}

function tokens(value: string): Set<string> {
  return new Set(
    clean(value)
      .toLocaleLowerCase("en-US")
      .normalize("NFKD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/[^a-z0-9]+/g, " ")
      .split(/\s+/)
      .filter(Boolean),
  );
}

function sameScope(left: IntentRadarScope, right: IntentRadarScope): boolean {
  return left.tenantId === right.tenantId
    && left.organizationId === right.organizationId
    && left.brandId === right.brandId;
}

function validateScope(scope: IntentRadarScope): void {
  for (const [label, value] of Object.entries(scope)) {
    if (typeof value !== "string" || clean(value).length < 1 || clean(value).length > 128) {
      throw new Error(`scope.${label} must be a non-empty string up to 128 characters`);
    }
  }
}

function validateLimits(limits: IntentRadarLimits): void {
  const ceilings: Record<keyof IntentRadarLimits, number> = {
    maxRowsPerDataset: 25_000,
    maxRules: 512,
    maxSignals: 5_000,
    maxQueryLength: 2_000,
  };
  for (const key of Object.keys(ceilings) as Array<keyof IntentRadarLimits>) {
    const value = limits[key];
    if (!Number.isInteger(value) || value < 1 || value > ceilings[key]) {
      throw new Error(`${key} must be an integer from 1 to ${ceilings[key]}`);
    }
  }
}

function queryDimensionIndex(dataset: SearchAnalyticsDataset): number {
  const indices = dataset.request.dimensions
    .map((dimension, index) => dimension === "query" ? index : -1)
    .filter((index) => index >= 0);
  if (indices.length !== 1) throw new Error("Intent Radar requires exactly one query dimension");
  return indices[0]!;
}

function validateRules(rules: readonly IntentRule[], limits: IntentRadarLimits): readonly IntentRule[] {
  if (!Array.isArray(rules) || rules.length > limits.maxRules) throw new Error("intent rule budget exceeded");
  const ids = new Set<string>();
  return Object.freeze(rules.map((rule) => {
    const id = clean(rule.id);
    const label = clean(rule.label);
    if (!id || !label || ids.has(id)) throw new Error("intent rule ids and labels must be non-empty and ids unique");
    ids.add(id);
    const anyTokens = [...new Set(rule.anyTokens.map(clean).filter(Boolean))].sort();
    const allTokens = [...new Set((rule.allTokens ?? []).map(clean).filter(Boolean))].sort();
    if (anyTokens.length === 0 && allTokens.length === 0) throw new Error(`intent rule ${id} must contain tokens`);
    if (anyTokens.length + allTokens.length > 64) throw new Error(`intent rule ${id} token budget exceeded`);
    if ([...anyTokens, ...allTokens].some((token) => token.length > 80)) throw new Error(`intent rule ${id} token too long`);
    return Object.freeze({ id, label, anyTokens: Object.freeze(anyTokens), ...(allTokens.length ? { allTokens: Object.freeze(allTokens) } : {}) });
  }).sort((a, b) => a.id.localeCompare(b.id, "en")));
}

interface AggregatedQuery {
  impressions: number;
  clicks: number;
}

function aggregate(dataset: SearchAnalyticsDataset, limits: IntentRadarLimits): ReadonlyMap<string, AggregatedQuery> {
  if (dataset.rows.length > limits.maxRowsPerDataset) throw new Error("Intent Radar dataset row budget exceeded");
  const queryIndex = queryDimensionIndex(dataset);
  const output = new Map<string, AggregatedQuery>();
  for (const row of dataset.rows) {
    const query = clean(row.keys[queryIndex] ?? "");
    if (!query) continue;
    if (query.length > limits.maxQueryLength) throw new Error("query exceeds Intent Radar length budget");
    const previous = output.get(query) ?? { impressions: 0, clicks: 0 };
    previous.impressions += row.impressions;
    previous.clicks += row.clicks;
    if (!Number.isSafeInteger(previous.impressions) || !Number.isSafeInteger(previous.clicks)) {
      throw new Error("aggregated search metrics exceed safe integer range");
    }
    output.set(query, previous);
  }
  return output;
}

function classify(query: string, rules: readonly IntentRule[]): readonly string[] {
  const queryTokens = tokens(query);
  return Object.freeze(rules.filter((rule) => {
    const any = rule.anyTokens.length === 0 || rule.anyTokens.some((token) => queryTokens.has(tokens(token).values().next().value ?? ""));
    const all = (rule.allTokens ?? []).every((token) => [...tokens(token)].every((part) => queryTokens.has(part)));
    return any && all;
  }).map((rule) => rule.id));
}

function evidenceState(current: SearchAnalyticsDataset, baseline: SearchAnalyticsDataset, signalCount: number): IntentRadarEvidenceState {
  if (current.sourceAuthority !== baseline.sourceAuthority) throw new Error("mixed Search Console authorities are forbidden");
  if (signalCount === 0) return "NOT_ENOUGH_EVIDENCE";
  return current.sourceAuthority === "SEARCH_CONSOLE_API" ? "OBSERVED_SEARCH_CONSOLE" : "SYNTHETIC";
}

function signalDigest(value: Omit<IntentSignal, "digest">): string {
  return `intent-signal:sha256:${digestValue(value)}`;
}

export function analyzeIntentRadar(
  current: ScopedSearchDataset,
  baseline: ScopedSearchDataset,
  rules: readonly IntentRule[],
  limits: IntentRadarLimits = DEFAULT_LIMITS,
): IntentRadarReport {
  validateScope(current.scope);
  validateScope(baseline.scope);
  if (!sameScope(current.scope, baseline.scope)) throw new Error("cross-tenant/scope Intent Radar analysis is forbidden");
  validateLimits(limits);
  if (current.dataset.request.siteUrl !== baseline.dataset.request.siteUrl) throw new Error("Intent Radar datasets must target the same Search Console property");
  if (baseline.dataset.request.endDate >= current.dataset.request.startDate) throw new Error("baseline window must end before current window starts");
  const normalizedRules = validateRules(rules, limits);
  const currentQueries = aggregate(current.dataset, limits);
  const baselineQueries = aggregate(baseline.dataset, limits);
  const queryNames = [...new Set([...currentQueries.keys(), ...baselineQueries.keys()])].sort((a, b) => a.localeCompare(b, "en"));
  const built: IntentSignal[] = [];
  let unmatchedQueryCount = 0;

  for (const query of queryNames) {
    const intentIds = classify(query, normalizedRules);
    if (intentIds.length === 0) unmatchedQueryCount += 1;
    const currentMetrics = currentQueries.get(query) ?? { impressions: 0, clicks: 0 };
    const baselineMetrics = baselineQueries.get(query) ?? { impressions: 0, clicks: 0 };
    const impressionDelta = currentMetrics.impressions - baselineMetrics.impressions;
    const clickDelta = currentMetrics.clicks - baselineMetrics.clicks;
    const relativeImpressionDelta = baselineMetrics.impressions === 0 ? null : impressionDelta / baselineMetrics.impressions;
    const noveltyBoost = baselineMetrics.impressions === 0 && currentMetrics.impressions > 0 ? Math.log1p(currentMetrics.impressions) : 0;
    const growth = impressionDelta > 0 ? Math.log1p(impressionDelta) : 0;
    const clickGrowth = clickDelta > 0 ? Math.log1p(clickDelta) * 0.5 : 0;
    const score = growth + clickGrowth + noveltyBoost;
    if (score <= 0) continue;
    const unsigned = {
      query,
      intentIds,
      currentImpressions: currentMetrics.impressions,
      baselineImpressions: baselineMetrics.impressions,
      currentClicks: currentMetrics.clicks,
      baselineClicks: baselineMetrics.clicks,
      impressionDelta,
      clickDelta,
      relativeImpressionDelta,
      score,
    };
    built.push(Object.freeze({ ...unsigned, digest: signalDigest(unsigned) }));
  }

  const signals = Object.freeze(built
    .sort((a, b) => b.score - a.score || b.currentImpressions - a.currentImpressions || a.query.localeCompare(b.query, "en"))
    .slice(0, limits.maxSignals));
  const core = {
    formatVersion: "nexus-intent-radar-v1" as const,
    scope: Object.freeze({ ...current.scope }),
    evidenceState: evidenceState(current.dataset, baseline.dataset, signals.length),
    nonClaim: "OBSERVATIONAL_SEARCH_DEMAND_NOT_CAUSAL_OR_MARKET_COMPLETE" as const,
    currentDatasetDigest: current.dataset.datasetDigest,
    baselineDatasetDigest: baseline.dataset.datasetDigest,
    currentWindow: Object.freeze({ startDate: current.dataset.request.startDate, endDate: current.dataset.request.endDate }),
    baselineWindow: Object.freeze({ startDate: baseline.dataset.request.startDate, endDate: baseline.dataset.request.endDate }),
    signals,
    unmatchedQueryCount,
  };
  return Object.freeze({ ...core, reportDigest: `intent-radar:sha256:${digestValue(core)}` });
}

export function verifyIntentRadar(
  current: ScopedSearchDataset,
  baseline: ScopedSearchDataset,
  rules: readonly IntentRule[],
  report: IntentRadarReport,
  limits: IntentRadarLimits = DEFAULT_LIMITS,
): boolean {
  try {
    const replay = analyzeIntentRadar(current, baseline, rules, limits);
    return canonicalJson(replay) === canonicalJson(report);
  } catch {
    return false;
  }
}
