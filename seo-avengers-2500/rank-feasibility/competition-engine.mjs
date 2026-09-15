import { createHash } from "node:crypto";

import { buildRankFeasibilityWithTrendReport } from "./longitudinal-engine.mjs";

const SCHEMA_VERSION = 1;
const PROFILE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

function compareStrings(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function canonicalJson(value) {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return JSON.stringify(typeof value === "string" ? value.normalize("NFC") : value);
  }
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) throw new TypeError("competition values must be safe integers");
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
  throw new TypeError("competition values must be JSON-compatible");
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

function keywordIdentity(value, label) {
  return stringValue(value, label, { maxBytes: 4096 })
    .normalize("NFKC")
    .toLocaleLowerCase("en-US")
    .trim()
    .replace(/\s+/gu, " ");
}

function validateCompetitionRows(value) {
  if (!Array.isArray(value) || value.length < 1 || value.length > 100_000) {
    throw new Error("keywordCoverageRecords must contain 1..100000 rows");
  }
  return value.map((row, index) => {
    exactKeys(
      row,
      ["competitor_ranked_count", "keyword", "search_volume", "site_ranked"],
      `keyword coverage row ${index}`,
    );
    if (typeof row.site_ranked !== "boolean") throw new Error(`site_ranked ${index} must be boolean`);
    return Object.freeze({
      keywordIdentity: keywordIdentity(row.keyword, `keyword ${index}`),
      siteRanked: row.site_ranked,
      competitorRankedCount: integerValue(row.competitor_ranked_count, `competitor ranked count ${index}`, 0, 100_000),
      searchVolume: integerValue(row.search_volume, `search volume ${index}`, 0, 1_000_000_000_000),
    });
  });
}

function validateCompetitionProfile(value) {
  exactKeys(
    value,
    [
      "low_competitor_count_max",
      "medium_competitor_count_max",
      "minimum_search_volume",
      "profile_id",
      "provenance",
      "schema_version",
    ],
    "competition assumption profile",
  );
  if (value.schema_version !== SCHEMA_VERSION) throw new Error("unsupported competition assumption profile schema");
  const profileId = stringValue(value.profile_id, "profile_id", { pattern: PROFILE_ID_RE, maxBytes: 128 });
  const provenance = stringValue(value.provenance, "provenance", { maxBytes: 4096 });
  const minimumSearchVolume = integerValue(value.minimum_search_volume, "minimum_search_volume", 1, 1_000_000_000_000);
  const lowCompetitorCountMax = integerValue(value.low_competitor_count_max, "low_competitor_count_max", 0, 100_000);
  const mediumCompetitorCountMax = integerValue(value.medium_competitor_count_max, "medium_competitor_count_max", 0, 100_000);
  if (mediumCompetitorCountMax < lowCompetitorCountMax) {
    throw new Error("medium_competitor_count_max must be greater than or equal to low_competitor_count_max");
  }
  const canonicalProfile = {
    schema_version: SCHEMA_VERSION,
    profile_id: profileId,
    provenance,
    minimum_search_volume: minimumSearchVolume,
    low_competitor_count_max: lowCompetitorCountMax,
    medium_competitor_count_max: mediumCompetitorCountMax,
  };
  return Object.freeze({
    schemaVersion: SCHEMA_VERSION,
    profileId,
    provenance,
    minimumSearchVolume,
    lowCompetitorCountMax,
    mediumCompetitorCountMax,
    sha256: sha256Canonical(canonicalProfile),
  });
}

function normalizeCompetitionRows(rows) {
  const registry = new Map();
  for (const row of rows) {
    const prior = registry.get(row.keywordIdentity);
    const value = Object.freeze({
      keyword: row.keywordIdentity,
      keywordIdentity: row.keywordIdentity,
      siteRanked: row.siteRanked,
      competitorRankedCount: row.competitorRankedCount,
      searchVolume: row.searchVolume,
    });
    if (prior === undefined) {
      registry.set(row.keywordIdentity, value);
      continue;
    }
    if (
      prior.siteRanked !== value.siteRanked
      || prior.competitorRankedCount !== value.competitorRankedCount
      || prior.searchVolume !== value.searchVolume
    ) {
      throw new Error(`conflicting duplicate keyword coverage:${row.keywordIdentity}`);
    }
  }
  return [...registry.values()].sort((left, right) => compareStrings(left.keywordIdentity, right.keywordIdentity));
}

function assessCompetition(row, profile) {
  if (row.searchVolume < profile.minimumSearchVolume) {
    return Object.freeze({
      competitionBand: "INSUFFICIENT_DATA",
      evidenceStatus: "INSUFFICIENT_SEARCH_VOLUME",
      siteCoverageState: row.siteRanked ? "OBSERVED_RANKED" : "OBSERVED_NOT_RANKED",
      competitorRankedCount: row.competitorRankedCount,
      searchVolume: row.searchVolume,
      minimumSearchVolume: profile.minimumSearchVolume,
    });
  }
  let competitionBand = "HIGH";
  if (row.competitorRankedCount <= profile.lowCompetitorCountMax) competitionBand = "LOW";
  else if (row.competitorRankedCount <= profile.mediumCompetitorCountMax) competitionBand = "MEDIUM";
  return Object.freeze({
    competitionBand,
    evidenceStatus: "SUFFICIENT_FOR_RULE_EVALUATION",
    siteCoverageState: row.siteRanked ? "OBSERVED_RANKED" : "OBSERVED_NOT_RANKED",
    competitorRankedCount: row.competitorRankedCount,
    searchVolume: row.searchVolume,
    minimumSearchVolume: profile.minimumSearchVolume,
  });
}

function summarize(competitionRows) {
  const bands = { LOW: 0, MEDIUM: 0, HIGH: 0, INSUFFICIENT_DATA: 0 };
  let siteRankedCount = 0;
  let siteNotRankedCount = 0;
  for (const row of competitionRows) {
    bands[row.assessment.competitionBand] += 1;
    if (row.assessment.siteCoverageState === "OBSERVED_RANKED") siteRankedCount += 1;
    else siteNotRankedCount += 1;
  }
  return Object.freeze({
    keywordCount: competitionRows.length,
    siteRankedCount,
    siteNotRankedCount,
    competitionBands: Object.freeze(bands),
  });
}

export function buildRankCompetitionReport({ keywordCoverageRecords, competitionAssumptionProfile }) {
  const rows = normalizeCompetitionRows(validateCompetitionRows(keywordCoverageRecords));
  const profile = validateCompetitionProfile(competitionAssumptionProfile);
  const competition = Object.freeze(rows.map((row) => Object.freeze({
    keyword: row.keyword,
    keywordIdentity: row.keywordIdentity,
    assessment: assessCompetition(row, profile),
  })));
  const unsigned = {
    schemaVersion: SCHEMA_VERSION,
    engineId: "WALLE_RANK_COMPETITION_V1",
    status: "COMPETITION_READY",
    interpretation: "AUTHORIZED_COMPETITION_EVIDENCE_NOT_RANK_PROBABILITY",
    competitionAssumptionProfile: profile,
    summary: summarize(competition),
    competition,
    warnings: Object.freeze([
      "NO_RANK_GUARANTEE",
      "NO_PROBABILITY_CLAIM",
      "NO_TIME_TO_RANK_CLAIM",
      "COMPETITOR_COUNT_IS_NOT_DOMAIN_AUTHORITY",
      "SEARCH_VOLUME_IS_NOT_TRAFFIC_FORECAST",
      "NO_CAUSAL_SEO_LIFT_CLAIM",
      "NO_GOOGLE_SEARCH_SCRAPING_BY_THIS_ENGINE",
    ]),
  };
  return Object.freeze({ ...unsigned, reportSha256: sha256Canonical(unsigned) });
}

export function buildRankFeasibilityTrendCompetitionReport({
  searchPerformanceRecords,
  searchPerformanceHistoryRecords,
  keywordCoverageRecords,
  feasibilityAssumptionProfile,
  trendAssumptionProfile,
  competitionAssumptionProfile,
}) {
  const rankContext = buildRankFeasibilityWithTrendReport({
    searchPerformanceRecords,
    searchPerformanceHistoryRecords,
    feasibilityAssumptionProfile,
    trendAssumptionProfile,
  });
  const competition = buildRankCompetitionReport({ keywordCoverageRecords, competitionAssumptionProfile });
  const competitionByKeyword = new Map(competition.competition.map((row) => [row.keywordIdentity, row]));
  const currentKeywords = new Set();
  let matchedCompetitionOpportunityCount = 0;
  let missingCompetitionOpportunityCount = 0;

  const opportunities = Object.freeze(rankContext.opportunities.map((opportunity) => {
    const identity = keywordIdentity(opportunity.query, "rank opportunity query");
    currentKeywords.add(identity);
    const competitive = competitionByKeyword.get(identity) ?? null;
    if (competitive === null) missingCompetitionOpportunityCount += 1;
    else matchedCompetitionOpportunityCount += 1;
    return Object.freeze({
      query: opportunity.query,
      pageUrl: opportunity.pageUrl,
      observed: opportunity.observed,
      targets: opportunity.targets,
      momentum: opportunity.momentum,
      competition: competitive === null
        ? Object.freeze({
          keywordIdentity: identity,
          competitionBand: "INSUFFICIENT_DATA",
          evidenceStatus: "NO_MATCHING_COMPETITION_RECORD",
        })
        : Object.freeze({
          keywordIdentity: competitive.keywordIdentity,
          competitionBand: competitive.assessment.competitionBand,
          evidenceStatus: competitive.assessment.evidenceStatus,
          siteCoverageState: competitive.assessment.siteCoverageState,
          competitorRankedCount: competitive.assessment.competitorRankedCount,
          searchVolume: competitive.assessment.searchVolume,
          minimumSearchVolume: competitive.assessment.minimumSearchVolume,
        }),
    });
  }));

  const competitionOnlyKeywordCount = competition.competition.reduce(
    (count, row) => count + (currentKeywords.has(row.keywordIdentity) ? 0 : 1),
    0,
  );
  const unsigned = {
    schemaVersion: SCHEMA_VERSION,
    engineId: "WALLE_RANK_FEASIBILITY_TREND_COMPETITION_V1",
    status: "RANK_CONTEXT_READY",
    interpretation: "RULE_BOUND_SEARCH_TREND_AND_COMPETITION_EVIDENCE_NOT_PROBABILITY",
    rankContextReportSha256: rankContext.reportSha256,
    competitionReportSha256: competition.reportSha256,
    summary: Object.freeze({
      currentOpportunityCount: rankContext.opportunities.length,
      matchedCompetitionOpportunityCount,
      missingCompetitionOpportunityCount,
      competitionOnlyKeywordCount,
      rankContext: rankContext.summary,
      competition: competition.summary,
    }),
    opportunities,
    decisionBoundary: "COMPETITION_CONTEXT_ONLY_DOES_NOT_UPGRADE_OR_DOWNGRADE_FEASIBILITY_BAND",
    warnings: Object.freeze([
      "NO_RANK_GUARANTEE",
      "NO_PROBABILITY_CLAIM",
      "NO_TIME_TO_RANK_CLAIM",
      "COMPETITION_CONTEXT_IS_NOT_DOMAIN_AUTHORITY",
      "NO_CAUSAL_SEO_LIFT_CLAIM",
      "CALIBRATED_PROBABILITY_REQUIRES_OUTCOME_HISTORY_AND_ADDITIONAL_SIGNALS",
    ]),
  };
  return Object.freeze({ ...unsigned, reportSha256: sha256Canonical(unsigned) });
}
