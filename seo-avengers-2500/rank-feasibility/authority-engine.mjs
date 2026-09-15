import { createHash } from "node:crypto";

const SCHEMA_VERSION = 1;
const PPM = 1_000_000;
const PROFILE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const SOURCE_NON_CLAIM = "INTERNAL_TOPICAL_AUTHORITY_DIAGNOSTIC_NOT_SEARCH_ENGINE_RANKING_EVIDENCE";

function compareStrings(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function canonicalJson(value) {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return JSON.stringify(typeof value === "string" ? value.normalize("NFC") : value);
  }
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) throw new TypeError("authority values must be safe integers");
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
  throw new TypeError("authority values must be JSON-compatible");
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
  const normalized = value.normalize("NFC").trim();
  if (!normalized) throw new Error(`${label} must not be empty`);
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

function topicIdentity(value, label) {
  return stringValue(value, label, { maxBytes: 4096 })
    .normalize("NFKC")
    .toLocaleLowerCase("en-US")
    .replace(/\s+/gu, " ");
}

function sourceStatus(value, label) {
  if (value === "READY" || value === "NEEDS_WORK" || value === "BLOCKED") return value;
  throw new Error(`${label} has invalid source assessment status`);
}

function validateAuthorityRows(value) {
  if (!Array.isArray(value) || value.length < 1 || value.length > 100_000) {
    throw new Error("topicalAuthorityRecords must contain 1..100000 rows");
  }
  return value.map((row, index) => {
    exactKeys(
      row,
      [
        "assessment_status",
        "authority_ppm",
        "centrality_ppm",
        "cohesion_ppm",
        "coverage_ppm",
        "intent_coverage_ppm",
        "primary_evidence_ppm",
        "source_non_claim",
        "topic_id",
      ],
      `topical authority row ${index}`,
    );
    if (row.source_non_claim !== SOURCE_NON_CLAIM) {
      throw new Error(`topical authority row ${index} must preserve source non-claim`);
    }
    return Object.freeze({
      topicId: topicIdentity(row.topic_id, `topic id ${index}`),
      assessmentStatus: sourceStatus(row.assessment_status, `assessment status ${index}`),
      coveragePpm: integerValue(row.coverage_ppm, `coverage ppm ${index}`, 0, PPM),
      intentCoveragePpm: integerValue(row.intent_coverage_ppm, `intent coverage ppm ${index}`, 0, PPM),
      primaryEvidencePpm: integerValue(row.primary_evidence_ppm, `primary evidence ppm ${index}`, 0, PPM),
      cohesionPpm: integerValue(row.cohesion_ppm, `cohesion ppm ${index}`, 0, PPM),
      centralityPpm: integerValue(row.centrality_ppm, `centrality ppm ${index}`, 0, PPM),
      authorityPpm: integerValue(row.authority_ppm, `authority ppm ${index}`, 0, PPM),
    });
  });
}

function normalizeAuthorityRows(rows) {
  const registry = new Map();
  let assessmentStatus = null;
  for (const row of rows) {
    if (assessmentStatus === null) assessmentStatus = row.assessmentStatus;
    if (row.assessmentStatus !== assessmentStatus) throw new Error("mixed topical authority assessment status is not allowed");
    const prior = registry.get(row.topicId);
    const normalized = Object.freeze({ ...row });
    if (prior === undefined) {
      registry.set(row.topicId, normalized);
      continue;
    }
    if (canonicalJson(prior) !== canonicalJson(normalized)) {
      throw new Error(`conflicting duplicate topical authority:${row.topicId}`);
    }
  }
  if (assessmentStatus === "BLOCKED") throw new Error("upstream topical authority assessment is BLOCKED");
  return Object.freeze([...registry.values()].sort((left, right) => compareStrings(left.topicId, right.topicId)));
}

function validateAuthorityProfile(value) {
  exactKeys(
    value,
    [
      "minimum_topics",
      "moderate_authority_ppm_max",
      "profile_id",
      "provenance",
      "schema_version",
      "weak_authority_ppm_max",
    ],
    "authority assumption profile",
  );
  if (value.schema_version !== SCHEMA_VERSION) throw new Error("unsupported authority assumption profile schema");
  const profileId = stringValue(value.profile_id, "profile_id", { pattern: PROFILE_ID_RE, maxBytes: 128 });
  const provenance = stringValue(value.provenance, "provenance", { maxBytes: 4096 });
  const minimumTopics = integerValue(value.minimum_topics, "minimum_topics", 1, 100_000);
  const weakAuthorityPpmMax = integerValue(value.weak_authority_ppm_max, "weak_authority_ppm_max", 0, PPM);
  const moderateAuthorityPpmMax = integerValue(value.moderate_authority_ppm_max, "moderate_authority_ppm_max", 0, PPM);
  if (moderateAuthorityPpmMax < weakAuthorityPpmMax) {
    throw new Error("moderate_authority_ppm_max must be greater than or equal to weak_authority_ppm_max");
  }
  const canonicalProfile = {
    schema_version: SCHEMA_VERSION,
    profile_id: profileId,
    provenance,
    minimum_topics: minimumTopics,
    weak_authority_ppm_max: weakAuthorityPpmMax,
    moderate_authority_ppm_max: moderateAuthorityPpmMax,
  };
  return Object.freeze({
    schemaVersion: SCHEMA_VERSION,
    profileId,
    provenance,
    minimumTopics,
    weakAuthorityPpmMax,
    moderateAuthorityPpmMax,
    sha256: sha256Canonical(canonicalProfile),
  });
}

function averagePpm(rows, field) {
  const sum = rows.reduce((total, row) => total + BigInt(row[field]), 0n);
  return Number((sum + BigInt(Math.floor(rows.length / 2))) / BigInt(rows.length));
}

function strengthFor(authorityPpm, topicCount, profile) {
  if (topicCount < profile.minimumTopics) return "INSUFFICIENT_DATA";
  if (authorityPpm <= profile.weakAuthorityPpmMax) return "WEAK";
  if (authorityPpm <= profile.moderateAuthorityPpmMax) return "MODERATE";
  return "STRONG";
}

function componentAverages(rows) {
  return Object.freeze({
    coveragePpm: averagePpm(rows, "coveragePpm"),
    intentCoveragePpm: averagePpm(rows, "intentCoveragePpm"),
    primaryEvidencePpm: averagePpm(rows, "primaryEvidencePpm"),
    cohesionPpm: averagePpm(rows, "cohesionPpm"),
    centralityPpm: averagePpm(rows, "centralityPpm"),
    authorityPpm: averagePpm(rows, "authorityPpm"),
  });
}

export function buildTopicalAuthorityEvidenceReport({ topicalAuthorityRecords, authorityAssumptionProfile }) {
  const rows = normalizeAuthorityRows(validateAuthorityRows(topicalAuthorityRecords));
  const profile = validateAuthorityProfile(authorityAssumptionProfile);
  const averages = componentAverages(rows);
  const authorityStrength = strengthFor(averages.authorityPpm, rows.length, profile);
  const topics = Object.freeze(rows.map((row) => Object.freeze({
    topicId: row.topicId,
    assessmentStatus: row.assessmentStatus,
    strength: strengthFor(row.authorityPpm, 1, { ...profile, minimumTopics: 1 }),
    coveragePpm: row.coveragePpm,
    intentCoveragePpm: row.intentCoveragePpm,
    primaryEvidencePpm: row.primaryEvidencePpm,
    cohesionPpm: row.cohesionPpm,
    centralityPpm: row.centralityPpm,
    authorityPpm: row.authorityPpm,
  })));
  const counts = { WEAK: 0, MODERATE: 0, STRONG: 0, INSUFFICIENT_DATA: 0 };
  for (const topic of topics) counts[topic.strength] += 1;
  const unsigned = {
    schemaVersion: SCHEMA_VERSION,
    engineId: "WALLE_TOPICAL_AUTHORITY_EVIDENCE_V1",
    status: authorityStrength === "INSUFFICIENT_DATA" ? "INSUFFICIENT_DATA" : "AUTHORITY_READY",
    interpretation: "INTERNAL_TOPICAL_AUTHORITY_CONTEXT_NOT_SEARCH_ENGINE_RANKING_EVIDENCE",
    sourceNonClaim: SOURCE_NON_CLAIM,
    authorityAssumptionProfile: profile,
    summary: Object.freeze({
      topicCount: rows.length,
      sourceAssessmentStatus: rows[0].assessmentStatus,
      authorityStrength,
      componentAverages: averages,
      topicStrengthCounts: Object.freeze(counts),
    }),
    topics,
    warnings: Object.freeze([
      "NO_RANK_GUARANTEE",
      "NO_PROBABILITY_CLAIM",
      "INTERNAL_AUTHORITY_IS_NOT_GOOGLE_AUTHORITY",
      "NOT_DOMAIN_AUTHORITY",
      "NO_BACKLINK_AUTHORITY_CLAIM",
      "NO_EXTERNAL_LINK_EQUITY_CLAIM",
      "NO_TIME_TO_RANK_CLAIM",
      "NO_CAUSAL_SEO_LIFT_CLAIM",
    ]),
  };
  return Object.freeze({ ...unsigned, reportSha256: sha256Canonical(unsigned) });
}

export function attachAuthorityContext({ rankCompetitionReport, authorityReport }) {
  if (!rankCompetitionReport || rankCompetitionReport.status !== "RANK_CONTEXT_READY") {
    throw new Error("rank competition report must be RANK_CONTEXT_READY");
  }
  if (!authorityReport || (authorityReport.status !== "AUTHORITY_READY" && authorityReport.status !== "INSUFFICIENT_DATA")) {
    throw new Error("authority report has invalid status");
  }
  const unsigned = {
    schemaVersion: SCHEMA_VERSION,
    engineId: "WALLE_RANK_CONTEXT_AUTHORITY_V1",
    status: "RANK_CONTEXT_READY",
    interpretation: "RULE_BOUND_SEARCH_TREND_COMPETITION_AND_INTERNAL_AUTHORITY_CONTEXT_NOT_PROBABILITY",
    rankCompetitionReportSha256: rankCompetitionReport.reportSha256,
    authorityReportSha256: authorityReport.reportSha256,
    summary: Object.freeze({
      rankContext: rankCompetitionReport.summary,
      authority: authorityReport.summary,
    }),
    opportunities: rankCompetitionReport.opportunities,
    authority: Object.freeze({
      status: authorityReport.status,
      authorityStrength: authorityReport.summary.authorityStrength,
      topicCount: authorityReport.summary.topicCount,
      sourceAssessmentStatus: authorityReport.summary.sourceAssessmentStatus,
      componentAverages: authorityReport.summary.componentAverages,
    }),
    decisionBoundary: "AUTHORITY_CONTEXT_ONLY_DOES_NOT_UPGRADE_OR_DOWNGRADE_FEASIBILITY_BAND",
    warnings: Object.freeze([
      "NO_RANK_GUARANTEE",
      "NO_PROBABILITY_CLAIM",
      "TOPIC_TO_QUERY_MAPPING_NOT_ESTABLISHED",
      "INTERNAL_AUTHORITY_IS_NOT_GOOGLE_AUTHORITY",
      "NO_EXTERNAL_BACKLINK_STRENGTH_IN_V1",
      "CALIBRATED_PROBABILITY_REQUIRES_OUTCOME_HISTORY_AND_ADDITIONAL_SIGNALS",
    ]),
  };
  return Object.freeze({ ...unsigned, reportSha256: sha256Canonical(unsigned) });
}
