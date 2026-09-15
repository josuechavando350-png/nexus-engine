import { createHash } from "node:crypto";

import { buildRankFeasibilityReport } from "./feasibility-engine.mjs";

const SCHEMA_VERSION = 1;
const PPM = 1_000_000;
const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER);
const PROFILE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

function compareStrings(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function canonicalJson(value) {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return JSON.stringify(typeof value === "string" ? value.normalize("NFC") : value);
  }
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) throw new TypeError("rank trend values must be safe integers");
    return String(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value)
      .map(([key, item]) => [key.normalize("NFC"), item])
      .sort(([left], [right]) => compareStrings(left, right));
    const seen = new Set();
    return `{${entries.map(([key, item]) => {
      if (seen.has(key)) throw new TypeError("normalized mapping key collision");
      seen.add(key);
      return `${JSON.stringify(key)}:${canonicalJson(item)}`;
    }).join(",")}}`;
  }
  throw new TypeError("rank trend values must be JSON-compatible");
}

function sha256Canonical(value) {
  return `sha256:${createHash("sha256").update(Buffer.from(canonicalJson(value), "utf8")).digest("hex")}`;
}

function exactKeys(value, expected, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  if (JSON.stringify(Object.keys(value).sort()) !== JSON.stringify([...expected].sort())) {
    throw new Error(`unexpected ${label} keys`);
  }
}

function stringValue(value, label, { pattern = null, maxBytes = 16_384 } = {}) {
  if (typeof value !== "string") throw new Error(`${label} must be a string`);
  const normalized = value.normalize("NFC");
  if (!normalized.trim()) throw new Error(`${label} must not be empty`);
  if (Buffer.byteLength(normalized, "utf8") > maxBytes) throw new Error(`${label} exceeds size limit`);
  if (pattern !== null && !pattern.test(normalized)) throw new Error(`${label} has invalid format`);
  return normalized;
}

function integerValue(value, label, minimum, maximum) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${label} must be an integer in range`);
  }
  return value;
}

function toSafeNumber(value, label) {
  if (value < 0n || value > MAX_SAFE) throw new Error(`${label} exceeds safe integer range`);
  return Number(value);
}

function validateHistoryRows(value) {
  if (!Array.isArray(value) || value.length < 1 || value.length > 100_000) {
    throw new Error("searchPerformanceHistoryRecords must contain 1..100000 rows");
  }
  return value.map((row, index) => {
    exactKeys(
      row,
      [
        "average_position_milli",
        "clicks",
        "impressions",
        "page_url",
        "query",
        "window_end_unix_ms",
        "window_start_unix_ms",
      ],
      `search history row ${index}`,
    );
    const clicks = integerValue(row.clicks, `history clicks ${index}`, 0, 1_000_000_000_000);
    const impressions = integerValue(row.impressions, `history impressions ${index}`, 0, 1_000_000_000_000);
    if (clicks > impressions) throw new Error(`history clicks exceed impressions ${index}`);
    const windowStartUnixMs = integerValue(row.window_start_unix_ms, `history window start ${index}`, 1, Number.MAX_SAFE_INTEGER);
    const windowEndUnixMs = integerValue(row.window_end_unix_ms, `history window end ${index}`, 1, Number.MAX_SAFE_INTEGER);
    if (windowEndUnixMs <= windowStartUnixMs) throw new Error(`history window must be half-open and positive ${index}`);
    return Object.freeze({
      query: stringValue(row.query, `history query ${index}`, { maxBytes: 4096 }),
      pageUrl: stringValue(row.page_url, `history page ${index}`),
      clicks,
      impressions,
      averagePositionMilli: integerValue(row.average_position_milli, `history average position ${index}`, 0, 1_000_000_000),
      windowStartUnixMs,
      windowEndUnixMs,
    });
  });
}

function validateTrendProfile(value) {
  exactKeys(
    value,
    [
      "declining_delta_milli",
      "improving_delta_milli",
      "minimum_endpoint_impressions",
      "minimum_windows",
      "profile_id",
      "provenance",
      "schema_version",
    ],
    "rank trend assumption profile",
  );
  if (value.schema_version !== SCHEMA_VERSION) throw new Error("unsupported rank trend assumption profile schema");
  const profileId = stringValue(value.profile_id, "profile_id", { pattern: PROFILE_ID_RE, maxBytes: 128 });
  const provenance = stringValue(value.provenance, "provenance", { maxBytes: 4096 });
  const minimumWindows = integerValue(value.minimum_windows, "minimum_windows", 2, 3660);
  const minimumEndpointImpressions = integerValue(
    value.minimum_endpoint_impressions,
    "minimum_endpoint_impressions",
    1,
    1_000_000_000_000,
  );
  const improvingDeltaMilli = integerValue(value.improving_delta_milli, "improving_delta_milli", 1, 1_000_000_000);
  const decliningDeltaMilli = integerValue(value.declining_delta_milli, "declining_delta_milli", 1, 1_000_000_000);
  const canonicalProfile = {
    schema_version: SCHEMA_VERSION,
    profile_id: profileId,
    provenance,
    minimum_windows: minimumWindows,
    minimum_endpoint_impressions: minimumEndpointImpressions,
    improving_delta_milli: improvingDeltaMilli,
    declining_delta_milli: decliningDeltaMilli,
  };
  return Object.freeze({
    schemaVersion: SCHEMA_VERSION,
    profileId,
    provenance,
    minimumWindows,
    minimumEndpointImpressions,
    improvingDeltaMilli,
    decliningDeltaMilli,
    sha256: sha256Canonical(canonicalProfile),
  });
}

function aggregateHistoryWindows(rows) {
  const buckets = new Map();
  for (const row of rows) {
    const key = canonicalJson([row.query, row.pageUrl, row.windowStartUnixMs, row.windowEndUnixMs]);
    const bucket = buckets.get(key) ?? {
      query: row.query,
      pageUrl: row.pageUrl,
      windowStartUnixMs: row.windowStartUnixMs,
      windowEndUnixMs: row.windowEndUnixMs,
      clicks: 0n,
      impressions: 0n,
      weightedPosition: 0n,
      sourceRowCount: 0,
    };
    bucket.clicks += BigInt(row.clicks);
    bucket.impressions += BigInt(row.impressions);
    bucket.weightedPosition += BigInt(row.averagePositionMilli) * BigInt(row.impressions);
    bucket.sourceRowCount += 1;
    buckets.set(key, bucket);
  }

  return [...buckets.values()]
    .map((bucket) => {
      const clicks = toSafeNumber(bucket.clicks, "aggregated history clicks");
      const impressions = toSafeNumber(bucket.impressions, "aggregated history impressions");
      return Object.freeze({
        query: bucket.query,
        pageUrl: bucket.pageUrl,
        windowStartUnixMs: bucket.windowStartUnixMs,
        windowEndUnixMs: bucket.windowEndUnixMs,
        clicks,
        impressions,
        ctrPpm: bucket.impressions > 0n
          ? toSafeNumber((bucket.clicks * BigInt(PPM)) / bucket.impressions, "aggregated history ctr")
          : null,
        averagePositionMilli: bucket.impressions > 0n
          ? toSafeNumber(bucket.weightedPosition / bucket.impressions, "aggregated history average position")
          : null,
        sourceRowCount: bucket.sourceRowCount,
      });
    })
    .sort((left, right) => (
      compareStrings(left.query, right.query)
      || compareStrings(left.pageUrl, right.pageUrl)
      || left.windowStartUnixMs - right.windowStartUnixMs
      || left.windowEndUnixMs - right.windowEndUnixMs
    ));
}

function groupHistoryWindows(windows) {
  const grouped = new Map();
  for (const window of windows) {
    const key = canonicalJson([window.query, window.pageUrl]);
    const value = grouped.get(key) ?? { query: window.query, pageUrl: window.pageUrl, windows: [] };
    value.windows.push(window);
    grouped.set(key, value);
  }
  return [...grouped.values()]
    .map((group) => {
      group.windows.sort((left, right) => left.windowStartUnixMs - right.windowStartUnixMs || left.windowEndUnixMs - right.windowEndUnixMs);
      const duration = group.windows[0].windowEndUnixMs - group.windows[0].windowStartUnixMs;
      for (let index = 0; index < group.windows.length; index += 1) {
        const window = group.windows[index];
        if (window.windowEndUnixMs - window.windowStartUnixMs !== duration) {
          throw new Error(`history window duration mismatch:${group.query}:${group.pageUrl}`);
        }
        if (index > 0 && window.windowStartUnixMs < group.windows[index - 1].windowEndUnixMs) {
          throw new Error(`history windows overlap:${group.query}:${group.pageUrl}`);
        }
      }
      return Object.freeze({
        query: group.query,
        pageUrl: group.pageUrl,
        windowDurationMs: duration,
        windows: Object.freeze(group.windows),
      });
    })
    .sort((left, right) => compareStrings(left.query, right.query) || compareStrings(left.pageUrl, right.pageUrl));
}

function endpointView(window) {
  return Object.freeze({
    windowStartUnixMs: window.windowStartUnixMs,
    windowEndUnixMs: window.windowEndUnixMs,
    clicks: window.clicks,
    impressions: window.impressions,
    ctrPpm: window.ctrPpm,
    averagePositionMilli: window.averagePositionMilli,
  });
}

function assessTrend(group, profile) {
  const first = group.windows[0];
  const latest = group.windows[group.windows.length - 1];
  let momentumBand = "INSUFFICIENT_DATA";
  let evidenceStatus = "INSUFFICIENT_WINDOWS";
  let positionImprovementMilli = null;
  let ctrDeltaPpm = null;

  if (group.windows.length >= profile.minimumWindows) {
    if (
      first.impressions < profile.minimumEndpointImpressions
      || latest.impressions < profile.minimumEndpointImpressions
      || first.averagePositionMilli === null
      || latest.averagePositionMilli === null
    ) {
      evidenceStatus = "INSUFFICIENT_ENDPOINT_IMPRESSIONS";
    } else {
      evidenceStatus = "SUFFICIENT_FOR_TREND_EVALUATION";
      positionImprovementMilli = first.averagePositionMilli - latest.averagePositionMilli;
      ctrDeltaPpm = latest.ctrPpm - first.ctrPpm;
      if (positionImprovementMilli >= profile.improvingDeltaMilli) momentumBand = "IMPROVING";
      else if (positionImprovementMilli <= -profile.decliningDeltaMilli) momentumBand = "DECLINING";
      else momentumBand = "STABLE";
    }
  }

  return Object.freeze({
    query: group.query,
    pageUrl: group.pageUrl,
    windowCount: group.windows.length,
    windowDurationMs: group.windowDurationMs,
    firstWindow: endpointView(first),
    latestWindow: endpointView(latest),
    positionImprovementMilli,
    ctrDeltaPpm,
    momentumBand,
    evidenceStatus,
    minimumWindows: profile.minimumWindows,
    minimumEndpointImpressions: profile.minimumEndpointImpressions,
  });
}

function buildTrendSummary(opportunities) {
  const counts = { IMPROVING: 0, STABLE: 0, DECLINING: 0, INSUFFICIENT_DATA: 0 };
  for (const opportunity of opportunities) counts[opportunity.momentumBand] += 1;
  return Object.freeze({ opportunityCount: opportunities.length, momentumBands: Object.freeze(counts) });
}

export function buildRankTrendReport({ searchPerformanceHistoryRecords, trendAssumptionProfile }) {
  const rows = validateHistoryRows(searchPerformanceHistoryRecords);
  const profile = validateTrendProfile(trendAssumptionProfile);
  const groups = groupHistoryWindows(aggregateHistoryWindows(rows));
  const opportunities = Object.freeze(groups.map((group) => assessTrend(group, profile)));
  const unsigned = {
    schemaVersion: SCHEMA_VERSION,
    engineId: "WALLE_RANK_TREND_V1",
    status: "TREND_READY",
    interpretation: "OBSERVED_LONGITUDINAL_SEARCH_EVIDENCE_NOT_PROBABILITY",
    trendAssumptionProfile: profile,
    summary: buildTrendSummary(opportunities),
    opportunities,
    warnings: Object.freeze([
      "NO_RANK_GUARANTEE",
      "NO_PROBABILITY_CLAIM",
      "NO_TIME_TO_RANK_CLAIM",
      "MOMENTUM_DOES_NOT_GUARANTEE_CONTINUATION",
      "NO_COMPETITOR_EVIDENCE_IN_V1",
      "NO_AUTHORITY_MODEL_IN_V1",
      "NO_CAUSAL_SEO_LIFT_CLAIM",
      "EQUAL_NON_OVERLAPPING_HISTORY_WINDOWS_REQUIRED",
    ]),
  };
  return Object.freeze({ ...unsigned, reportSha256: sha256Canonical(unsigned) });
}

function opportunityKey(query, pageUrl) {
  return canonicalJson([query, pageUrl]);
}

export function buildRankFeasibilityWithTrendReport({
  searchPerformanceRecords,
  searchPerformanceHistoryRecords,
  feasibilityAssumptionProfile,
  trendAssumptionProfile,
}) {
  const feasibility = buildRankFeasibilityReport({
    searchPerformanceRecords,
    assumptionProfile: feasibilityAssumptionProfile,
  });
  const trend = buildRankTrendReport({ searchPerformanceHistoryRecords, trendAssumptionProfile });
  const trendByKey = new Map(trend.opportunities.map((opportunity) => [opportunityKey(opportunity.query, opportunity.pageUrl), opportunity]));
  const currentKeys = new Set();
  let matchedTrendOpportunityCount = 0;
  let missingTrendOpportunityCount = 0;

  const opportunities = Object.freeze(feasibility.opportunities.map((opportunity) => {
    const key = opportunityKey(opportunity.query, opportunity.pageUrl);
    currentKeys.add(key);
    const observedTrend = trendByKey.get(key) ?? null;
    if (observedTrend === null) missingTrendOpportunityCount += 1;
    else matchedTrendOpportunityCount += 1;
    return Object.freeze({
      query: opportunity.query,
      pageUrl: opportunity.pageUrl,
      observed: opportunity.observed,
      targets: opportunity.targets,
      momentum: observedTrend ?? Object.freeze({
        query: opportunity.query,
        pageUrl: opportunity.pageUrl,
        momentumBand: "INSUFFICIENT_DATA",
        evidenceStatus: "NO_MATCHING_HISTORY",
      }),
    });
  }));

  const historyOnlyOpportunityCount = trend.opportunities.reduce(
    (count, opportunity) => count + (currentKeys.has(opportunityKey(opportunity.query, opportunity.pageUrl)) ? 0 : 1),
    0,
  );
  const unsigned = {
    schemaVersion: SCHEMA_VERSION,
    engineId: "WALLE_RANK_FEASIBILITY_TREND_V1",
    status: "FEASIBILITY_TREND_READY",
    interpretation: "RULE_BOUND_SEARCH_EVIDENCE_WITH_OBSERVED_MOMENTUM_NOT_PROBABILITY",
    feasibilityReportSha256: feasibility.reportSha256,
    trendReportSha256: trend.reportSha256,
    summary: Object.freeze({
      currentOpportunityCount: feasibility.opportunities.length,
      matchedTrendOpportunityCount,
      missingTrendOpportunityCount,
      historyOnlyOpportunityCount,
      feasibility: feasibility.summary,
      trend: trend.summary,
    }),
    opportunities,
    decisionBoundary: "MOMENTUM_CONTEXT_ONLY_DOES_NOT_UPGRADE_FEASIBILITY_BAND",
    warnings: Object.freeze([
      "NO_RANK_GUARANTEE",
      "NO_PROBABILITY_CLAIM",
      "NO_TIME_TO_RANK_CLAIM",
      "NO_COMPETITOR_EVIDENCE_IN_V1",
      "NO_AUTHORITY_MODEL_IN_V1",
      "NO_CAUSAL_SEO_LIFT_CLAIM",
      "HISTORY_WINDOW_RECENCY_IS_NOT_A_GOOGLE_FORECAST",
    ]),
  };
  return Object.freeze({ ...unsigned, reportSha256: sha256Canonical(unsigned) });
}
