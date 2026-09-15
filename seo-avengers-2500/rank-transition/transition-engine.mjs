import { createHash } from "node:crypto";

const SCHEMA_VERSION = 1;
const ENGINE_ID = "WALLE_RANK_TRANSITION_V1";
const PPM = 1_000_000;
const PROFILE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const TOKEN_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const SHA256_RE = /^sha256:[0-9a-f]{64}$/;
const SOURCE_AUTHORITY = "WALLE_RANK_TRANSITION_EXPORT_V1";
const MOMENTUM_BANDS = Object.freeze(["IMPROVING", "STABLE", "DECLINING", "INSUFFICIENT_DATA"]);
const COMPETITION_BANDS = Object.freeze(["LOW", "MEDIUM", "HIGH", "INSUFFICIENT_DATA"]);
const AUTHORITY_STRENGTHS = Object.freeze(["WEAK", "MODERATE", "STRONG", "INSUFFICIENT_DATA"]);
const TARGETS = Object.freeze([
  Object.freeze({ id: "TOP_10", maxPositionMilli: 10_000 }),
  Object.freeze({ id: "TOP_3", maxPositionMilli: 3_000 }),
  Object.freeze({ id: "TOP_1", maxPositionMilli: 1_000 }),
]);

function compareStrings(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function canonicalJson(value) {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return JSON.stringify(typeof value === "string" ? value.normalize("NFC") : value);
  }
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) throw new TypeError("rank transition values must be safe integers");
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
  throw new TypeError("rank transition values must be JSON-compatible");
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

function stringValue(value, label, { pattern = null, maxBytes = 4096 } = {}) {
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

function booleanValue(value, label) {
  if (typeof value !== "boolean") throw new Error(`${label} must be boolean`);
  return value;
}

function enumValue(value, allowed, label) {
  if (!allowed.includes(value)) throw new Error(`${label} has unsupported value`);
  return value;
}

function sha256Value(value, label) {
  if (typeof value !== "string" || !SHA256_RE.test(value)) throw new Error(`${label} must be sha256:<64 lowercase hex>`);
  return value;
}

function validateProfile(value) {
  exactKeys(
    value,
    [
      "horizon_ms",
      "minimum_comparable_transitions",
      "minimum_distinct_opportunities",
      "minimum_impressions",
      "profile_id",
      "provenance",
      "schema_version",
    ],
    "rank transition profile",
  );
  if (value.schema_version !== SCHEMA_VERSION) throw new Error("unsupported rank transition profile schema");
  const profileId = stringValue(value.profile_id, "profile_id", { pattern: PROFILE_ID_RE, maxBytes: 128 });
  const provenance = stringValue(value.provenance, "provenance", { maxBytes: 4096 });
  const horizonMs = integerValue(value.horizon_ms, "horizon_ms", 1, Number.MAX_SAFE_INTEGER);
  const minimumComparableTransitions = integerValue(
    value.minimum_comparable_transitions,
    "minimum_comparable_transitions",
    2,
    100_000,
  );
  const minimumDistinctOpportunities = integerValue(
    value.minimum_distinct_opportunities,
    "minimum_distinct_opportunities",
    1,
    minimumComparableTransitions,
  );
  const minimumImpressions = integerValue(value.minimum_impressions, "minimum_impressions", 1, 1_000_000_000_000);
  const normalized = {
    schema_version: SCHEMA_VERSION,
    profile_id: profileId,
    provenance,
    horizon_ms: horizonMs,
    minimum_comparable_transitions: minimumComparableTransitions,
    minimum_distinct_opportunities: minimumDistinctOpportunities,
    minimum_impressions: minimumImpressions,
  };
  return Object.freeze({
    schemaVersion: SCHEMA_VERSION,
    profileId,
    provenance,
    horizonMs,
    minimumComparableTransitions,
    minimumDistinctOpportunities,
    minimumImpressions,
    sha256: sha256Canonical(normalized),
  });
}

function rankState(positionMilli) {
  if (positionMilli <= 1_000) return "TOP_1";
  if (positionMilli <= 3_000) return "TOP_3";
  if (positionMilli <= 10_000) return "TOP_10";
  return "OUTSIDE_TOP_10";
}

function validateRecord(row, index, profile) {
  exactKeys(
    row,
    [
      "authority_strength",
      "competition_band",
      "context_captured_at_unix_ms",
      "momentum_band",
      "observation_complete",
      "opportunity_identity_sha256",
      "outcome_impressions",
      "outcome_observed_at_unix_ms",
      "outcome_position_milli",
      "rank_context_report_sha256",
      "start_impressions",
      "start_position_milli",
      "transition_id",
    ],
    `rank transition record ${index}`,
  );
  const contextCapturedAtUnixMs = integerValue(
    row.context_captured_at_unix_ms,
    `context_captured_at_unix_ms ${index}`,
    1,
    Number.MAX_SAFE_INTEGER,
  );
  const outcomeObservedAtUnixMs = integerValue(
    row.outcome_observed_at_unix_ms,
    `outcome_observed_at_unix_ms ${index}`,
    1,
    Number.MAX_SAFE_INTEGER,
  );
  if (outcomeObservedAtUnixMs <= contextCapturedAtUnixMs) throw new Error(`rank transition chronology invalid ${index}`);
  if (outcomeObservedAtUnixMs - contextCapturedAtUnixMs !== profile.horizonMs) {
    throw new Error(`rank transition horizon mismatch ${index}`);
  }
  return Object.freeze({
    transitionId: stringValue(row.transition_id, `transition_id ${index}`, { pattern: TOKEN_RE, maxBytes: 256 }),
    opportunityIdentitySha256: sha256Value(row.opportunity_identity_sha256, `opportunity_identity_sha256 ${index}`),
    rankContextReportSha256: sha256Value(row.rank_context_report_sha256, `rank_context_report_sha256 ${index}`),
    contextCapturedAtUnixMs,
    outcomeObservedAtUnixMs,
    startPositionMilli: integerValue(row.start_position_milli, `start_position_milli ${index}`, 0, 1_000_000_000),
    startImpressions: integerValue(row.start_impressions, `start_impressions ${index}`, 0, 1_000_000_000_000),
    outcomePositionMilli: integerValue(row.outcome_position_milli, `outcome_position_milli ${index}`, 0, 1_000_000_000),
    outcomeImpressions: integerValue(row.outcome_impressions, `outcome_impressions ${index}`, 0, 1_000_000_000_000),
    momentumBand: enumValue(row.momentum_band, MOMENTUM_BANDS, `momentum_band ${index}`),
    competitionBand: enumValue(row.competition_band, COMPETITION_BANDS, `competition_band ${index}`),
    authorityStrength: enumValue(row.authority_strength, AUTHORITY_STRENGTHS, `authority_strength ${index}`),
    observationComplete: booleanValue(row.observation_complete, `observation_complete ${index}`),
  });
}

function normalizedRecord(row) {
  return {
    transition_id: row.transitionId,
    opportunity_identity_sha256: row.opportunityIdentitySha256,
    rank_context_report_sha256: row.rankContextReportSha256,
    context_captured_at_unix_ms: row.contextCapturedAtUnixMs,
    outcome_observed_at_unix_ms: row.outcomeObservedAtUnixMs,
    start_position_milli: row.startPositionMilli,
    start_impressions: row.startImpressions,
    outcome_position_milli: row.outcomePositionMilli,
    outcome_impressions: row.outcomeImpressions,
    momentum_band: row.momentumBand,
    competition_band: row.competitionBand,
    authority_strength: row.authorityStrength,
    observation_complete: row.observationComplete,
  };
}

function validateRecords(value, profile) {
  if (!Array.isArray(value) || value.length < 1 || value.length > 100_000) {
    throw new Error("rank transition records must contain 1..100000 rows");
  }
  const transitionIds = new Set();
  const observationKeys = new Set();
  const rows = value.map((row, index) => validateRecord(row, index, profile));
  for (const row of rows) {
    if (transitionIds.has(row.transitionId)) throw new Error(`duplicate transition_id:${row.transitionId}`);
    transitionIds.add(row.transitionId);
    const observationKey = canonicalJson([row.opportunityIdentitySha256, row.contextCapturedAtUnixMs]);
    if (observationKeys.has(observationKey)) {
      throw new Error(`duplicate opportunity transition observation:${row.opportunityIdentitySha256}:${row.contextCapturedAtUnixMs}`);
    }
    observationKeys.add(observationKey);
  }
  return Object.freeze(rows.sort((left, right) => compareStrings(left.transitionId, right.transitionId)));
}

export function validateRankTransitionSnapshot(value, transitionProfile) {
  const profile = validateProfile(transitionProfile);
  exactKeys(
    value,
    [
      "capture_id",
      "control_generation",
      "evidence_manifest_hash",
      "observed_at_unix_ms",
      "records",
      "records_sha256",
      "schema_version",
      "site_id",
      "source_authority",
      "source_capture_sha256",
    ],
    "rank transition snapshot",
  );
  if (value.schema_version !== SCHEMA_VERSION) throw new Error("unsupported rank transition snapshot schema");
  const siteId = stringValue(value.site_id, "site_id", { pattern: /^[a-z0-9][a-z0-9-]{0,79}$/, maxBytes: 80 });
  const controlGeneration = integerValue(value.control_generation, "control_generation", 1, Number.MAX_SAFE_INTEGER);
  const evidenceManifestHash = sha256Value(value.evidence_manifest_hash, "evidence_manifest_hash");
  const captureId = stringValue(value.capture_id, "capture_id", { pattern: TOKEN_RE, maxBytes: 128 });
  const observedAtUnixMs = integerValue(value.observed_at_unix_ms, "observed_at_unix_ms", 1, Number.MAX_SAFE_INTEGER);
  if (value.source_authority !== SOURCE_AUTHORITY) throw new Error("rank transition source_authority is not authorized");
  const sourceCaptureSha256 = sha256Value(value.source_capture_sha256, "source_capture_sha256");
  const records = validateRecords(value.records, profile);
  if (records.some((record) => record.outcomeObservedAtUnixMs > observedAtUnixMs)) {
    throw new Error("rank transition snapshot observed_at precedes record outcome");
  }
  const normalizedRows = records.map(normalizedRecord);
  const recordsSha256 = sha256Canonical(normalizedRows);
  if (value.records_sha256 !== recordsSha256) throw new Error("rank transition records_sha256 mismatch");
  const canonicalSnapshot = {
    schema_version: SCHEMA_VERSION,
    site_id: siteId,
    control_generation: controlGeneration,
    evidence_manifest_hash: evidenceManifestHash,
    capture_id: captureId,
    observed_at_unix_ms: observedAtUnixMs,
    source_authority: SOURCE_AUTHORITY,
    source_capture_sha256: sourceCaptureSha256,
    records_sha256: recordsSha256,
    records: normalizedRows,
  };
  return Object.freeze({
    schemaVersion: SCHEMA_VERSION,
    siteId,
    controlGeneration,
    evidenceManifestHash,
    captureId,
    observedAtUnixMs,
    sourceAuthority: SOURCE_AUTHORITY,
    sourceCaptureSha256,
    recordsSha256,
    records,
    sha256: sha256Canonical(canonicalSnapshot),
    profile,
  });
}

function validateRankAuthorityReport(value) {
  exactKeys(
    value,
    [
      "authority",
      "authorityReportSha256",
      "decisionBoundary",
      "engineId",
      "interpretation",
      "opportunities",
      "rankCompetitionReportSha256",
      "reportSha256",
      "schemaVersion",
      "status",
      "summary",
      "warnings",
    ],
    "rank authority context report",
  );
  if (value.schemaVersion !== SCHEMA_VERSION) throw new Error("unsupported rank authority context schema");
  if (value.engineId !== "WALLE_RANK_CONTEXT_AUTHORITY_V1" || value.status !== "RANK_CONTEXT_READY") {
    throw new Error("rank authority context report is not ready");
  }
  const { reportSha256, ...unsigned } = value;
  if (sha256Value(reportSha256, "rank authority report sha256") !== sha256Canonical(unsigned)) {
    throw new Error("rank authority report sha256 mismatch");
  }
  if (!value.authority || typeof value.authority !== "object" || Array.isArray(value.authority)) {
    throw new Error("rank authority context authority must be an object");
  }
  const authorityStrength = enumValue(
    value.authority.authorityStrength,
    AUTHORITY_STRENGTHS,
    "current authority strength",
  );
  if (!Array.isArray(value.opportunities) || value.opportunities.length < 1 || value.opportunities.length > 100_000) {
    throw new Error("rank authority context opportunities must contain 1..100000 rows");
  }
  const opportunities = value.opportunities.map((opportunity, index) => {
    if (!opportunity || typeof opportunity !== "object" || Array.isArray(opportunity)) {
      throw new Error(`rank authority opportunity ${index} must be an object`);
    }
    const query = stringValue(opportunity.query, `current query ${index}`, { maxBytes: 4096 });
    const pageUrl = stringValue(opportunity.pageUrl, `current page ${index}`, { maxBytes: 16_384 });
    if (!opportunity.observed || typeof opportunity.observed !== "object" || Array.isArray(opportunity.observed)) {
      throw new Error(`current observed ${index} must be an object`);
    }
    const observedImpressions = integerValue(
      opportunity.observed.impressions,
      `current impressions ${index}`,
      0,
      1_000_000_000_000,
    );
    const observedPositionMilli = opportunity.observed.averagePositionMilli === null
      ? null
      : integerValue(opportunity.observed.averagePositionMilli, `current position ${index}`, 0, 1_000_000_000);
    if (!opportunity.momentum || typeof opportunity.momentum !== "object" || Array.isArray(opportunity.momentum)) {
      throw new Error(`current momentum ${index} must be an object`);
    }
    if (!opportunity.competition || typeof opportunity.competition !== "object" || Array.isArray(opportunity.competition)) {
      throw new Error(`current competition ${index} must be an object`);
    }
    const momentumBand = enumValue(opportunity.momentum.momentumBand, MOMENTUM_BANDS, `current momentum band ${index}`);
    const competitionBand = enumValue(
      opportunity.competition.competitionBand,
      COMPETITION_BANDS,
      `current competition band ${index}`,
    );
    return Object.freeze({ query, pageUrl, observedImpressions, observedPositionMilli, momentumBand, competitionBand });
  });
  return Object.freeze({ reportSha256, authorityStrength, opportunities });
}

function cohortKey({ startState, momentumBand, competitionBand, authorityStrength }) {
  return canonicalJson([startState, momentumBand, competitionBand, authorityStrength]);
}

function empiricalProbabilityPpm(successCount, sampleCount) {
  if (sampleCount < 1) return null;
  return Number((BigInt(successCount) * BigInt(PPM)) / BigInt(sampleCount));
}

function buildHistoricalCohorts(records, profile) {
  const registry = new Map();
  let excludedIncompleteCount = 0;
  let excludedLowImpressionCount = 0;
  for (const record of records) {
    if (!record.observationComplete) {
      excludedIncompleteCount += 1;
      continue;
    }
    if (record.startImpressions < profile.minimumImpressions || record.outcomeImpressions < profile.minimumImpressions) {
      excludedLowImpressionCount += 1;
      continue;
    }
    const startState = rankState(record.startPositionMilli);
    const key = cohortKey({
      startState,
      momentumBand: record.momentumBand,
      competitionBand: record.competitionBand,
      authorityStrength: record.authorityStrength,
    });
    const cohort = registry.get(key) ?? {
      startState,
      momentumBand: record.momentumBand,
      competitionBand: record.competitionBand,
      authorityStrength: record.authorityStrength,
      sampleCount: 0,
      opportunities: new Set(),
      targetSuccesses: Object.fromEntries(TARGETS.map((target) => [target.id, 0])),
    };
    cohort.sampleCount += 1;
    cohort.opportunities.add(record.opportunityIdentitySha256);
    for (const target of TARGETS) {
      if (record.outcomePositionMilli <= target.maxPositionMilli) cohort.targetSuccesses[target.id] += 1;
    }
    registry.set(key, cohort);
  }

  const cohorts = Object.freeze([...registry.values()]
    .map((cohort) => {
      const distinctOpportunityCount = cohort.opportunities.size;
      const sampleReady = cohort.sampleCount >= profile.minimumComparableTransitions
        && distinctOpportunityCount >= profile.minimumDistinctOpportunities;
      return Object.freeze({
        startState: cohort.startState,
        momentumBand: cohort.momentumBand,
        competitionBand: cohort.competitionBand,
        authorityStrength: cohort.authorityStrength,
        sampleCount: cohort.sampleCount,
        distinctOpportunityCount,
        sampleStatus: sampleReady ? "EMPIRICAL_SAMPLE_READY" : "INSUFFICIENT_DATA",
        targets: Object.freeze(TARGETS.map((target) => Object.freeze({
          rankTarget: target.id,
          successCount: cohort.targetSuccesses[target.id],
          sampleCount: cohort.sampleCount,
          empiricalProbabilityPpm: sampleReady
            ? empiricalProbabilityPpm(cohort.targetSuccesses[target.id], cohort.sampleCount)
            : null,
        }))),
      });
    })
    .sort((left, right) => (
      compareStrings(left.startState, right.startState)
      || compareStrings(left.momentumBand, right.momentumBand)
      || compareStrings(left.competitionBand, right.competitionBand)
      || compareStrings(left.authorityStrength, right.authorityStrength)
    )));

  return Object.freeze({
    cohorts,
    excludedIncompleteCount,
    excludedLowImpressionCount,
  });
}

function targetForCurrent(target, currentPositionMilli, cohort) {
  if (currentPositionMilli <= target.maxPositionMilli) {
    return Object.freeze({
      rankTarget: target.id,
      targetPositionMaxMilli: target.maxPositionMilli,
      status: "ALREADY_ACHIEVED",
      sampleCount: cohort?.sampleCount ?? 0,
      distinctOpportunityCount: cohort?.distinctOpportunityCount ?? 0,
      successCount: null,
      empiricalProbabilityPpm: null,
    });
  }
  if (cohort === undefined || cohort.sampleStatus !== "EMPIRICAL_SAMPLE_READY") {
    return Object.freeze({
      rankTarget: target.id,
      targetPositionMaxMilli: target.maxPositionMilli,
      status: "INSUFFICIENT_DATA",
      sampleCount: cohort?.sampleCount ?? 0,
      distinctOpportunityCount: cohort?.distinctOpportunityCount ?? 0,
      successCount: cohort?.targets.find((item) => item.rankTarget === target.id)?.successCount ?? 0,
      empiricalProbabilityPpm: null,
    });
  }
  const historical = cohort.targets.find((item) => item.rankTarget === target.id);
  return Object.freeze({
    rankTarget: target.id,
    targetPositionMaxMilli: target.maxPositionMilli,
    status: "EMPIRICAL_TRANSITION_FREQUENCY_READY",
    sampleCount: cohort.sampleCount,
    distinctOpportunityCount: cohort.distinctOpportunityCount,
    successCount: historical.successCount,
    empiricalProbabilityPpm: historical.empiricalProbabilityPpm,
  });
}

export function buildRankTransitionReport({ rankAuthorityContextReport, transitionSnapshot, transitionProfile }) {
  const current = validateRankAuthorityReport(rankAuthorityContextReport);
  const snapshot = validateRankTransitionSnapshot(transitionSnapshot, transitionProfile);
  const profile = snapshot.profile;
  const history = buildHistoricalCohorts(snapshot.records, profile);
  const cohortRegistry = new Map(history.cohorts.map((cohort) => [cohortKey(cohort), cohort]));

  let readyOpportunityCount = 0;
  let insufficientOpportunityCount = 0;
  let missingCurrentPositionCount = 0;

  const opportunities = Object.freeze(current.opportunities
    .map((opportunity) => {
      if (opportunity.observedPositionMilli === null || opportunity.observedImpressions < profile.minimumImpressions) {
        missingCurrentPositionCount += 1;
        insufficientOpportunityCount += 1;
        return Object.freeze({
          query: opportunity.query,
          pageUrl: opportunity.pageUrl,
          status: "INSUFFICIENT_DATA",
          reason: opportunity.observedPositionMilli === null ? "CURRENT_POSITION_UNOBSERVED" : "CURRENT_IMPRESSIONS_BELOW_MINIMUM",
          observedPositionMilli: opportunity.observedPositionMilli,
          observedImpressions: opportunity.observedImpressions,
          startState: opportunity.observedPositionMilli === null ? null : rankState(opportunity.observedPositionMilli),
          momentumBand: opportunity.momentumBand,
          competitionBand: opportunity.competitionBand,
          authorityStrength: current.authorityStrength,
          targets: Object.freeze([]),
        });
      }

      const startState = rankState(opportunity.observedPositionMilli);
      const key = cohortKey({
        startState,
        momentumBand: opportunity.momentumBand,
        competitionBand: opportunity.competitionBand,
        authorityStrength: current.authorityStrength,
      });
      const cohort = cohortRegistry.get(key);
      const targets = Object.freeze(TARGETS.map((target) => targetForCurrent(target, opportunity.observedPositionMilli, cohort)));
      const hasReadyUnachieved = targets.some((target) => target.status === "EMPIRICAL_TRANSITION_FREQUENCY_READY");
      const hasUnachieved = targets.some((target) => target.status !== "ALREADY_ACHIEVED");
      const status = hasReadyUnachieved || !hasUnachieved ? "TRANSITION_READY" : "INSUFFICIENT_DATA";
      if (status === "TRANSITION_READY") readyOpportunityCount += 1;
      else insufficientOpportunityCount += 1;
      return Object.freeze({
        query: opportunity.query,
        pageUrl: opportunity.pageUrl,
        status,
        reason: status === "TRANSITION_READY" ? "EMPIRICAL_COHORT_AVAILABLE" : "NO_SUFFICIENT_COMPARABLE_COHORT",
        observedPositionMilli: opportunity.observedPositionMilli,
        observedImpressions: opportunity.observedImpressions,
        startState,
        momentumBand: opportunity.momentumBand,
        competitionBand: opportunity.competitionBand,
        authorityStrength: current.authorityStrength,
        targets,
      });
    })
    .sort((left, right) => compareStrings(left.query, right.query) || compareStrings(left.pageUrl, right.pageUrl)));

  const readyCohortCount = history.cohorts.filter((cohort) => cohort.sampleStatus === "EMPIRICAL_SAMPLE_READY").length;
  const status = readyOpportunityCount > 0 ? "TRANSITION_READY" : "INSUFFICIENT_DATA";
  const unsigned = {
    schemaVersion: SCHEMA_VERSION,
    engineId: ENGINE_ID,
    status,
    interpretation: "EMPIRICAL_HISTORICAL_TRANSITION_FREQUENCY_NOT_CAUSAL_RANK_FORECAST",
    transitionProfile: profile,
    source: Object.freeze({
      sourceAuthority: snapshot.sourceAuthority,
      sourceCaptureSha256: snapshot.sourceCaptureSha256,
      transitionSnapshotSha256: snapshot.sha256,
      recordsSha256: snapshot.recordsSha256,
      captureId: snapshot.captureId,
      observedAtUnixMs: snapshot.observedAtUnixMs,
      evidenceManifestHash: snapshot.evidenceManifestHash,
    }),
    currentRankContextReportSha256: current.reportSha256,
    summary: Object.freeze({
      historicalRecordCount: snapshot.records.length,
      acceptedHistoricalRecordCount: snapshot.records.length - history.excludedIncompleteCount - history.excludedLowImpressionCount,
      excludedIncompleteCount: history.excludedIncompleteCount,
      excludedLowImpressionCount: history.excludedLowImpressionCount,
      empiricalCohortCount: history.cohorts.length,
      readyCohortCount,
      currentOpportunityCount: opportunities.length,
      readyOpportunityCount,
      insufficientOpportunityCount,
      missingCurrentPositionCount,
    }),
    transitionCohorts: history.cohorts,
    opportunities,
    decisionBoundary: "NO_SMOOTHING_NO_EXTRAPOLATION_EXACT_COMPARABLE_COHORT_OR_INSUFFICIENT_DATA",
    warnings: Object.freeze([
      "NO_RANK_GUARANTEE",
      "NO_CAUSAL_SEO_LIFT_CLAIM",
      "NO_TIME_TO_RANK_CLAIM_BEYOND_EXPLICIT_HORIZON",
      "EMPIRICAL_FREQUENCY_IS_NOT_A_CONFIDENCE_INTERVAL",
      "NO_SMOOTHING_OR_BAYESIAN_PRIOR_IN_V1",
      "NO_EXTRAPOLATION_ACROSS_POSITION_MOMENTUM_COMPETITION_AUTHORITY_COHORTS",
      "AUTHORITY_STRENGTH_IS_INTERNAL_CONTEXT_NOT_GOOGLE_AUTHORITY",
      "HISTORICAL_OUTCOME_FREQUENCIES_MAY_NOT_GENERALIZE",
    ]),
  };
  return Object.freeze({ ...unsigned, reportSha256: sha256Canonical(unsigned) });
}

export const RANK_TRANSITION_SOURCE_AUTHORITY = SOURCE_AUTHORITY;
