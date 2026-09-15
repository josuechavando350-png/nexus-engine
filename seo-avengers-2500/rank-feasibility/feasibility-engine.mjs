import { createHash } from "node:crypto";

const SCHEMA_VERSION = 1;
const PPM = 1_000_000;
const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER);
const PROFILE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const RANK_TARGETS = Object.freeze([
  Object.freeze({ id: "TOP_10", targetPositionMaxMilli: 10_000 }),
  Object.freeze({ id: "TOP_3", targetPositionMaxMilli: 3_000 }),
  Object.freeze({ id: "TOP_1", targetPositionMaxMilli: 1_000 }),
]);
const BAND_ORDER = Object.freeze({
  INSUFFICIENT_DATA: 0,
  LOW: 1,
  MEDIUM: 2,
  HIGH: 3,
  ACHIEVED: 4,
});

function compareStrings(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function canonicalJson(value) {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return JSON.stringify(typeof value === "string" ? value.normalize("NFC") : value);
  }
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) throw new TypeError("feasibility values must be safe integers");
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
  throw new TypeError("feasibility values must be JSON-compatible");
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

function validateSearchRows(value) {
  if (!Array.isArray(value) || value.length < 1 || value.length > 100_000) {
    throw new Error("searchPerformanceRecords must contain 1..100000 rows");
  }
  return value.map((row, index) => {
    exactKeys(row, ["average_position_milli", "clicks", "impressions", "page_url", "query"], `search row ${index}`);
    const clicks = integerValue(row.clicks, `search clicks ${index}`, 0, 1_000_000_000_000);
    const impressions = integerValue(row.impressions, `search impressions ${index}`, 0, 1_000_000_000_000);
    if (clicks > impressions) throw new Error(`search clicks exceed impressions ${index}`);
    return Object.freeze({
      query: stringValue(row.query, `search query ${index}`, { maxBytes: 4096 }),
      pageUrl: stringValue(row.page_url, `search page ${index}`),
      clicks,
      impressions,
      averagePositionMilli: integerValue(row.average_position_milli, `average position ${index}`, 0, 1_000_000_000),
    });
  });
}

function validateAssumptionProfile(value) {
  exactKeys(
    value,
    ["high_gap_milli", "medium_gap_milli", "minimum_impressions", "profile_id", "provenance", "schema_version"],
    "rank feasibility assumption profile",
  );
  if (value.schema_version !== SCHEMA_VERSION) throw new Error("unsupported rank feasibility assumption profile schema");
  const profileId = stringValue(value.profile_id, "profile_id", { pattern: PROFILE_ID_RE, maxBytes: 128 });
  const provenance = stringValue(value.provenance, "provenance", { maxBytes: 4096 });
  const minimumImpressions = integerValue(value.minimum_impressions, "minimum_impressions", 1, 1_000_000_000_000);
  const highGapMilli = integerValue(value.high_gap_milli, "high_gap_milli", 0, 1_000_000_000);
  const mediumGapMilli = integerValue(value.medium_gap_milli, "medium_gap_milli", 0, 1_000_000_000);
  if (mediumGapMilli < highGapMilli) throw new Error("medium_gap_milli must be greater than or equal to high_gap_milli");

  const canonicalProfile = {
    schema_version: SCHEMA_VERSION,
    profile_id: profileId,
    provenance,
    minimum_impressions: minimumImpressions,
    high_gap_milli: highGapMilli,
    medium_gap_milli: mediumGapMilli,
  };
  return Object.freeze({
    schemaVersion: SCHEMA_VERSION,
    profileId,
    provenance,
    minimumImpressions,
    highGapMilli,
    mediumGapMilli,
    sha256: sha256Canonical(canonicalProfile),
  });
}

function aggregateSearchRows(rows) {
  const buckets = new Map();
  for (const row of rows) {
    const key = canonicalJson([row.query, row.pageUrl]);
    const bucket = buckets.get(key) ?? {
      query: row.query,
      pageUrl: row.pageUrl,
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
      const clicks = toSafeNumber(bucket.clicks, "aggregated clicks");
      const impressions = toSafeNumber(bucket.impressions, "aggregated impressions");
      const averagePositionMilli = bucket.impressions > 0n
        ? toSafeNumber(bucket.weightedPosition / bucket.impressions, "aggregated average position")
        : null;
      const ctrPpm = bucket.impressions > 0n
        ? toSafeNumber((bucket.clicks * BigInt(PPM)) / bucket.impressions, "aggregated ctr")
        : null;
      return Object.freeze({
        query: bucket.query,
        pageUrl: bucket.pageUrl,
        clicks,
        impressions,
        ctrPpm,
        averagePositionMilli,
        sourceRowCount: bucket.sourceRowCount,
      });
    })
    .sort((left, right) => compareStrings(left.query, right.query) || compareStrings(left.pageUrl, right.pageUrl));
}

function targetAssessment(observed, target, profile) {
  if (observed.impressions < profile.minimumImpressions || observed.averagePositionMilli === null) {
    return Object.freeze({
      rankTarget: target.id,
      targetPositionMaxMilli: target.targetPositionMaxMilli,
      observedPositionMilli: observed.averagePositionMilli,
      gapMilli: observed.averagePositionMilli === null
        ? null
        : Math.max(0, observed.averagePositionMilli - target.targetPositionMaxMilli),
      feasibilityBand: "INSUFFICIENT_DATA",
      evidenceStatus: "INSUFFICIENT_IMPRESSIONS",
      minimumImpressions: profile.minimumImpressions,
      observedImpressions: observed.impressions,
    });
  }

  const gapMilli = Math.max(0, observed.averagePositionMilli - target.targetPositionMaxMilli);
  let feasibilityBand = "LOW";
  if (gapMilli === 0) feasibilityBand = "ACHIEVED";
  else if (gapMilli <= profile.highGapMilli) feasibilityBand = "HIGH";
  else if (gapMilli <= profile.mediumGapMilli) feasibilityBand = "MEDIUM";

  return Object.freeze({
    rankTarget: target.id,
    targetPositionMaxMilli: target.targetPositionMaxMilli,
    observedPositionMilli: observed.averagePositionMilli,
    gapMilli,
    feasibilityBand,
    evidenceStatus: "SUFFICIENT_FOR_RULE_EVALUATION",
    minimumImpressions: profile.minimumImpressions,
    observedImpressions: observed.impressions,
  });
}

function assertTargetMonotonicity(targets) {
  const byId = new Map(targets.map((target) => [target.rankTarget, target]));
  const top10 = byId.get("TOP_10");
  const top3 = byId.get("TOP_3");
  const top1 = byId.get("TOP_1");
  for (const [easier, harder] of [[top10, top3], [top3, top1]]) {
    if (BAND_ORDER[easier.feasibilityBand] < BAND_ORDER[harder.feasibilityBand]) {
      throw new Error(`rank feasibility monotonicity violated:${easier.rankTarget}:${harder.rankTarget}`);
    }
  }
}

function buildSummary(opportunities) {
  const targets = {};
  for (const target of RANK_TARGETS) {
    targets[target.id] = { ACHIEVED: 0, HIGH: 0, MEDIUM: 0, LOW: 0, INSUFFICIENT_DATA: 0 };
  }
  let sufficientOpportunityCount = 0;
  let insufficientOpportunityCount = 0;
  for (const opportunity of opportunities) {
    const fullyInsufficient = opportunity.targets.every((target) => target.feasibilityBand === "INSUFFICIENT_DATA");
    if (fullyInsufficient) insufficientOpportunityCount += 1;
    else sufficientOpportunityCount += 1;
    for (const target of opportunity.targets) targets[target.rankTarget][target.feasibilityBand] += 1;
  }
  return Object.freeze({
    opportunityCount: opportunities.length,
    sufficientOpportunityCount,
    insufficientOpportunityCount,
    targets: Object.freeze(Object.fromEntries(
      RANK_TARGETS.map((target) => [target.id, Object.freeze(targets[target.id])]),
    )),
  });
}

export function buildRankFeasibilityReport({ searchPerformanceRecords, assumptionProfile }) {
  const rows = validateSearchRows(searchPerformanceRecords);
  const profile = validateAssumptionProfile(assumptionProfile);
  const aggregated = aggregateSearchRows(rows);

  const opportunities = aggregated.map((observed) => {
    const targets = Object.freeze(RANK_TARGETS.map((target) => targetAssessment(observed, target, profile)));
    assertTargetMonotonicity(targets);
    return Object.freeze({
      query: observed.query,
      pageUrl: observed.pageUrl,
      observed: Object.freeze({
        clicks: observed.clicks,
        impressions: observed.impressions,
        ctrPpm: observed.ctrPpm,
        averagePositionMilli: observed.averagePositionMilli,
        sourceRowCount: observed.sourceRowCount,
      }),
      targets,
    });
  });

  const unsigned = {
    schemaVersion: SCHEMA_VERSION,
    engineId: "WALLE_RANK_FEASIBILITY_V1",
    status: "FEASIBILITY_READY",
    interpretation: "RULE_BOUND_SEARCH_EVIDENCE_NOT_PROBABILITY",
    assumptionProfile: profile,
    summary: buildSummary(opportunities),
    opportunities: Object.freeze(opportunities),
    warnings: Object.freeze([
      "NO_RANK_GUARANTEE",
      "NO_PROBABILITY_CLAIM",
      "NO_TIME_TO_RANK_CLAIM",
      "NO_COMPETITOR_EVIDENCE_IN_V1",
      "NO_LONGITUDINAL_TREND_EVIDENCE_IN_V1",
      "NO_AUTHORITY_MODEL_IN_V1",
      "BANDS_DEPEND_ON_EXPLICIT_ASSUMPTION_PROFILE",
    ]),
  };
  return Object.freeze({ ...unsigned, reportSha256: sha256Canonical(unsigned) });
}
