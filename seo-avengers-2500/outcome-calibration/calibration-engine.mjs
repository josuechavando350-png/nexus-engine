import { createHash } from "node:crypto";

const SCHEMA_VERSION = 1;
const ENGINE_ID = "WALLE_OUTCOME_CALIBRATION_V1";
const PPM = 1_000_000;
const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER);
const PROFILE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const TOKEN_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const SHA256_RE = /^sha256:[0-9a-f]{64}$/;
const SCENARIO_IDS = Object.freeze(["CONSERVATIVE", "BASE", "UPSIDE"]);
const RANK_TARGETS = Object.freeze(["TOP_10", "TOP_3", "TOP_1"]);
const SOURCE_AUTHORITY = "WALLE_GROWTH_ATTRIBUTION_CALIBRATION_EXPORT_V1";

function compareStrings(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function canonicalJson(value) {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return JSON.stringify(typeof value === "string" ? value.normalize("NFC") : value);
  }
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) throw new TypeError("calibration values must be safe integers");
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
  throw new TypeError("calibration values must be JSON-compatible");
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

function integerValue(value, label, minimum, maximum) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${label} must be an integer in range`);
  }
  return value;
}

function stringValue(value, label, { pattern = null, maxBytes = 4096 } = {}) {
  if (typeof value !== "string") throw new Error(`${label} must be a string`);
  const normalized = value.normalize("NFC").trim();
  if (!normalized) throw new Error(`${label} must not be empty`);
  if (Buffer.byteLength(normalized, "utf8") > maxBytes) throw new Error(`${label} exceeds size limit`);
  if (pattern !== null && !pattern.test(normalized)) throw new Error(`${label} has invalid format`);
  return normalized;
}

function sha256Value(value, label) {
  if (typeof value !== "string" || !SHA256_RE.test(value)) throw new Error(`${label} must be sha256:<64 lowercase hex>`);
  return value;
}

function enumValue(value, allowed, label) {
  if (!allowed.includes(value)) throw new Error(`${label} has unsupported value`);
  return value;
}

function booleanValue(value, label) {
  if (typeof value !== "boolean") throw new Error(`${label} must be boolean`);
  return value;
}

function nullableInteger(value, label, minimum, maximum) {
  if (value === null) return null;
  return integerValue(value, label, minimum, maximum);
}

function toSafeNumber(value, label) {
  if (value < -MAX_SAFE || value > MAX_SAFE) throw new Error(`${label} exceeds safe integer range`);
  return Number(value);
}

function validateProfile(value) {
  exactKeys(
    value,
    ["minimum_attribution_completeness_ppm", "minimum_records", "profile_id", "provenance", "schema_version"],
    "calibration profile",
  );
  if (value.schema_version !== SCHEMA_VERSION) throw new Error("unsupported calibration profile schema");
  const profileId = stringValue(value.profile_id, "profile_id", { pattern: PROFILE_ID_RE, maxBytes: 128 });
  const provenance = stringValue(value.provenance, "provenance", { maxBytes: 4096 });
  const minimumRecords = integerValue(value.minimum_records, "minimum_records", 2, 100_000);
  const minimumAttributionCompletenessPpm = integerValue(
    value.minimum_attribution_completeness_ppm,
    "minimum_attribution_completeness_ppm",
    0,
    PPM,
  );
  const normalized = {
    schema_version: SCHEMA_VERSION,
    profile_id: profileId,
    provenance,
    minimum_records: minimumRecords,
    minimum_attribution_completeness_ppm: minimumAttributionCompletenessPpm,
  };
  return Object.freeze({
    schemaVersion: SCHEMA_VERSION,
    profileId,
    provenance,
    minimumRecords,
    minimumAttributionCompletenessPpm,
    sha256: sha256Canonical(normalized),
  });
}

function validateRecord(row, index) {
  exactKeys(
    row,
    [
      "action_executed_at_unix_ms",
      "action_receipt_sha256",
      "attribution_completeness_ppm",
      "calibration_id",
      "client_cohort_report_sha256",
      "decision_report_sha256",
      "feasibility_report_sha256",
      "growth_attribution_receipt_sha256",
      "modeled_average_ticket_micros",
      "modeled_close_rate_ppm",
      "modeled_lead_conversion_ppm",
      "observation_complete",
      "observed_average_ticket_micros",
      "observed_close_rate_ppm",
      "observed_lead_conversion_ppm",
      "prediction_created_at_unix_ms",
      "rank_target",
      "scenario_assumption_profile_sha256",
      "scenario_id",
      "scenario_report_sha256",
      "window_end_unix_ms",
      "window_start_unix_ms",
    ],
    `calibration record ${index}`,
  );

  const predictionCreatedAtUnixMs = integerValue(
    row.prediction_created_at_unix_ms,
    `prediction_created_at_unix_ms ${index}`,
    1,
    Number.MAX_SAFE_INTEGER,
  );
  const actionExecutedAtUnixMs = integerValue(
    row.action_executed_at_unix_ms,
    `action_executed_at_unix_ms ${index}`,
    1,
    Number.MAX_SAFE_INTEGER,
  );
  const windowStartUnixMs = integerValue(row.window_start_unix_ms, `window_start_unix_ms ${index}`, 1, Number.MAX_SAFE_INTEGER);
  const windowEndUnixMs = integerValue(row.window_end_unix_ms, `window_end_unix_ms ${index}`, 1, Number.MAX_SAFE_INTEGER);
  if (predictionCreatedAtUnixMs > actionExecutedAtUnixMs) throw new Error(`prediction must precede action ${index}`);
  if (actionExecutedAtUnixMs > windowStartUnixMs) throw new Error(`action must not occur after observation window begins ${index}`);
  if (windowEndUnixMs <= windowStartUnixMs) throw new Error(`observation window must be positive ${index}`);

  const observedAverageTicketMicros = nullableInteger(
    row.observed_average_ticket_micros,
    `observed_average_ticket_micros ${index}`,
    0,
    9_000_000_000_000_000,
  );

  return Object.freeze({
    calibrationId: stringValue(row.calibration_id, `calibration_id ${index}`, { pattern: TOKEN_RE, maxBytes: 256 }),
    scenarioId: enumValue(row.scenario_id, SCENARIO_IDS, `scenario_id ${index}`),
    rankTarget: enumValue(row.rank_target, RANK_TARGETS, `rank_target ${index}`),
    scenarioReportSha256: sha256Value(row.scenario_report_sha256, `scenario_report_sha256 ${index}`),
    scenarioAssumptionProfileSha256: sha256Value(
      row.scenario_assumption_profile_sha256,
      `scenario_assumption_profile_sha256 ${index}`,
    ),
    feasibilityReportSha256: sha256Value(row.feasibility_report_sha256, `feasibility_report_sha256 ${index}`),
    decisionReportSha256: sha256Value(row.decision_report_sha256, `decision_report_sha256 ${index}`),
    actionReceiptSha256: sha256Value(row.action_receipt_sha256, `action_receipt_sha256 ${index}`),
    growthAttributionReceiptSha256: sha256Value(
      row.growth_attribution_receipt_sha256,
      `growth_attribution_receipt_sha256 ${index}`,
    ),
    clientCohortReportSha256: sha256Value(row.client_cohort_report_sha256, `client_cohort_report_sha256 ${index}`),
    predictionCreatedAtUnixMs,
    actionExecutedAtUnixMs,
    windowStartUnixMs,
    windowEndUnixMs,
    observationComplete: booleanValue(row.observation_complete, `observation_complete ${index}`),
    attributionCompletenessPpm: integerValue(
      row.attribution_completeness_ppm,
      `attribution_completeness_ppm ${index}`,
      0,
      PPM,
    ),
    modeledLeadConversionPpm: integerValue(
      row.modeled_lead_conversion_ppm,
      `modeled_lead_conversion_ppm ${index}`,
      0,
      PPM,
    ),
    observedLeadConversionPpm: integerValue(
      row.observed_lead_conversion_ppm,
      `observed_lead_conversion_ppm ${index}`,
      0,
      PPM,
    ),
    modeledCloseRatePpm: integerValue(row.modeled_close_rate_ppm, `modeled_close_rate_ppm ${index}`, 0, PPM),
    observedCloseRatePpm: integerValue(row.observed_close_rate_ppm, `observed_close_rate_ppm ${index}`, 0, PPM),
    modeledAverageTicketMicros: integerValue(
      row.modeled_average_ticket_micros,
      `modeled_average_ticket_micros ${index}`,
      0,
      9_000_000_000_000_000,
    ),
    observedAverageTicketMicros,
  });
}

function normalizedRecord(row) {
  return {
    calibration_id: row.calibrationId,
    scenario_id: row.scenarioId,
    rank_target: row.rankTarget,
    scenario_report_sha256: row.scenarioReportSha256,
    scenario_assumption_profile_sha256: row.scenarioAssumptionProfileSha256,
    feasibility_report_sha256: row.feasibilityReportSha256,
    decision_report_sha256: row.decisionReportSha256,
    action_receipt_sha256: row.actionReceiptSha256,
    growth_attribution_receipt_sha256: row.growthAttributionReceiptSha256,
    client_cohort_report_sha256: row.clientCohortReportSha256,
    prediction_created_at_unix_ms: row.predictionCreatedAtUnixMs,
    action_executed_at_unix_ms: row.actionExecutedAtUnixMs,
    window_start_unix_ms: row.windowStartUnixMs,
    window_end_unix_ms: row.windowEndUnixMs,
    observation_complete: row.observationComplete,
    attribution_completeness_ppm: row.attributionCompletenessPpm,
    modeled_lead_conversion_ppm: row.modeledLeadConversionPpm,
    observed_lead_conversion_ppm: row.observedLeadConversionPpm,
    modeled_close_rate_ppm: row.modeledCloseRatePpm,
    observed_close_rate_ppm: row.observedCloseRatePpm,
    modeled_average_ticket_micros: row.modeledAverageTicketMicros,
    observed_average_ticket_micros: row.observedAverageTicketMicros,
  };
}

function validateRecords(value) {
  if (!Array.isArray(value) || value.length < 1 || value.length > 100_000) {
    throw new Error("calibrationRecords must contain 1..100000 rows");
  }
  const calibrationIds = new Set();
  const actionReceipts = new Set();
  const records = value.map((row, index) => validateRecord(row, index));
  for (const record of records) {
    if (calibrationIds.has(record.calibrationId)) throw new Error(`duplicate calibration_id:${record.calibrationId}`);
    calibrationIds.add(record.calibrationId);
    if (actionReceipts.has(record.actionReceiptSha256)) {
      throw new Error(`duplicate action_receipt_sha256:${record.actionReceiptSha256}`);
    }
    actionReceipts.add(record.actionReceiptSha256);
  }
  return Object.freeze(records.sort((left, right) => compareStrings(left.calibrationId, right.calibrationId)));
}

function validateSnapshot(value) {
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
    "calibration snapshot",
  );
  if (value.schema_version !== SCHEMA_VERSION) throw new Error("unsupported calibration snapshot schema");
  const siteId = stringValue(value.site_id, "site_id", { pattern: /^[a-z0-9][a-z0-9-]{0,79}$/, maxBytes: 80 });
  const controlGeneration = integerValue(value.control_generation, "control_generation", 1, Number.MAX_SAFE_INTEGER);
  const evidenceManifestHash = sha256Value(value.evidence_manifest_hash, "evidence_manifest_hash");
  const captureId = stringValue(value.capture_id, "capture_id", { pattern: TOKEN_RE, maxBytes: 128 });
  const observedAtUnixMs = integerValue(value.observed_at_unix_ms, "observed_at_unix_ms", 1, Number.MAX_SAFE_INTEGER);
  if (value.source_authority !== SOURCE_AUTHORITY) throw new Error("calibration source_authority is not authorized");
  const sourceCaptureSha256 = sha256Value(value.source_capture_sha256, "source_capture_sha256");
  const records = validateRecords(value.records);
  const normalizedRows = records.map(normalizedRecord);
  const recordsSha256 = sha256Canonical(normalizedRows);
  if (value.records_sha256 !== recordsSha256) throw new Error("calibration records_sha256 mismatch");
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
  });
}

function absBigInt(value) {
  return value < 0n ? -value : value;
}

function percentileNearestRank(sortedBigInts, numerator, denominator) {
  if (sortedBigInts.length < 1) return null;
  const n = BigInt(sortedBigInts.length);
  const rank = (n * BigInt(numerator) + BigInt(denominator - 1)) / BigInt(denominator);
  const index = Number(rank - 1n);
  return sortedBigInts[index];
}

function metricStats(pairs, label) {
  if (pairs.length < 1) return null;
  let signedTotal = 0n;
  let absTotal = 0n;
  const absoluteErrors = [];
  for (const pair of pairs) {
    const error = BigInt(pair.observed) - BigInt(pair.modeled);
    const absolute = absBigInt(error);
    signedTotal += error;
    absTotal += absolute;
    absoluteErrors.push(absolute);
  }
  absoluteErrors.sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
  const count = BigInt(pairs.length);
  const p50 = percentileNearestRank(absoluteErrors, 50, 100);
  const p90 = percentileNearestRank(absoluteErrors, 90, 100);
  return Object.freeze({
    sampleCount: pairs.length,
    meanSignedError: toSafeNumber(signedTotal / count, `${label} mean signed error`),
    meanAbsoluteError: toSafeNumber(absTotal / count, `${label} mean absolute error`),
    p50AbsoluteError: toSafeNumber(p50, `${label} p50 absolute error`),
    p90AbsoluteError: toSafeNumber(p90, `${label} p90 absolute error`),
    maxAbsoluteError: toSafeNumber(absoluteErrors[absoluteErrors.length - 1], `${label} max absolute error`),
  });
}

function empiricalBands(records, minimumRecords) {
  const leadPairs = records.map((row) => ({ modeled: row.modeledLeadConversionPpm, observed: row.observedLeadConversionPpm }));
  const closePairs = records.map((row) => ({ modeled: row.modeledCloseRatePpm, observed: row.observedCloseRatePpm }));
  const ticketPairs = records
    .filter((row) => row.observedAverageTicketMicros !== null)
    .map((row) => ({ modeled: row.modeledAverageTicketMicros, observed: row.observedAverageTicketMicros }));
  return Object.freeze({
    status: records.length >= minimumRecords ? "CALIBRATION_READY" : "INSUFFICIENT_DATA",
    sampleCount: records.length,
    leadConversionPpm: records.length >= minimumRecords ? metricStats(leadPairs, "lead conversion") : null,
    closeRatePpm: records.length >= minimumRecords ? metricStats(closePairs, "close rate") : null,
    averageTicketMicros: ticketPairs.length >= minimumRecords ? metricStats(ticketPairs, "average ticket") : null,
    ticketSampleCount: ticketPairs.length,
  });
}

function byScenario(records, minimumRecords) {
  const result = {};
  for (const scenarioId of SCENARIO_IDS) {
    result[scenarioId] = empiricalBands(records.filter((row) => row.scenarioId === scenarioId), minimumRecords);
  }
  return Object.freeze(result);
}

function publicRecord(record) {
  const leadError = record.observedLeadConversionPpm - record.modeledLeadConversionPpm;
  const closeError = record.observedCloseRatePpm - record.modeledCloseRatePpm;
  const ticketError = record.observedAverageTicketMicros === null
    ? null
    : record.observedAverageTicketMicros - record.modeledAverageTicketMicros;
  return Object.freeze({
    calibrationId: record.calibrationId,
    scenarioId: record.scenarioId,
    rankTarget: record.rankTarget,
    bindings: Object.freeze({
      scenarioReportSha256: record.scenarioReportSha256,
      scenarioAssumptionProfileSha256: record.scenarioAssumptionProfileSha256,
      feasibilityReportSha256: record.feasibilityReportSha256,
      decisionReportSha256: record.decisionReportSha256,
      actionReceiptSha256: record.actionReceiptSha256,
      growthAttributionReceiptSha256: record.growthAttributionReceiptSha256,
      clientCohortReportSha256: record.clientCohortReportSha256,
    }),
    timeline: Object.freeze({
      predictionCreatedAtUnixMs: record.predictionCreatedAtUnixMs,
      actionExecutedAtUnixMs: record.actionExecutedAtUnixMs,
      windowStartUnixMs: record.windowStartUnixMs,
      windowEndUnixMs: record.windowEndUnixMs,
    }),
    attributionCompletenessPpm: record.attributionCompletenessPpm,
    errors: Object.freeze({
      leadConversionPpm: leadError,
      closeRatePpm: closeError,
      averageTicketMicros: ticketError,
    }),
  });
}

export function canonicalCalibrationRecordsSha256(records) {
  return sha256Canonical(validateRecords(records).map(normalizedRecord));
}

export function validateOutcomeCalibrationSnapshot(snapshot) {
  return validateSnapshot(snapshot);
}

export function buildOutcomeCalibrationReport({ calibrationSnapshot, calibrationProfile }) {
  const snapshot = validateSnapshot(calibrationSnapshot);
  const profile = validateProfile(calibrationProfile);
  const accepted = [];
  const excluded = [];
  for (const record of snapshot.records) {
    if (!record.observationComplete) {
      excluded.push(Object.freeze({ calibrationId: record.calibrationId, reason: "OBSERVATION_WINDOW_INCOMPLETE" }));
      continue;
    }
    if (record.attributionCompletenessPpm < profile.minimumAttributionCompletenessPpm) {
      excluded.push(Object.freeze({ calibrationId: record.calibrationId, reason: "ATTRIBUTION_COMPLETENESS_BELOW_PROFILE" }));
      continue;
    }
    accepted.push(record);
  }

  const globalBands = empiricalBands(accepted, profile.minimumRecords);
  const status = globalBands.status;
  const unsigned = {
    schemaVersion: SCHEMA_VERSION,
    engineId: ENGINE_ID,
    status,
    interpretation: "EMPIRICAL_MODEL_COMPONENT_ERROR_NOT_CAUSAL_LIFT_OR_FORECAST_ACCURACY_GUARANTEE",
    calibrationProfile: profile,
    sourceSnapshot: Object.freeze({
      siteId: snapshot.siteId,
      controlGeneration: snapshot.controlGeneration,
      evidenceManifestHash: snapshot.evidenceManifestHash,
      captureId: snapshot.captureId,
      observedAtUnixMs: snapshot.observedAtUnixMs,
      sourceAuthority: snapshot.sourceAuthority,
      sourceCaptureSha256: snapshot.sourceCaptureSha256,
      recordsSha256: snapshot.recordsSha256,
      sha256: snapshot.sha256,
    }),
    decisionBoundary: "GROWTH_SCENARIO_REMAINS_HYPOTHETICAL_REAL_OUTCOME_ATTRIBUTION_REMAINS_GROWTH_ATTRIBUTION",
    countCalibrationBoundary: "ABSOLUTE_CLIENT_AND_REVENUE_COUNT_CALIBRATION_DEFERRED_UNTIL_EXPLICIT_SCENARIO_HORIZON_EXISTS",
    summary: Object.freeze({
      inputRecordCount: snapshot.records.length,
      acceptedRecordCount: accepted.length,
      excludedRecordCount: excluded.length,
      acceptedRecordsSha256: sha256Canonical(accepted.map(normalizedRecord)),
      excludedRecordsSha256: sha256Canonical(excluded),
      empiricalBands: globalBands,
      byScenario: byScenario(accepted, profile.minimumRecords),
    }),
    acceptedRecords: Object.freeze(accepted.map(publicRecord)),
    excludedRecords: Object.freeze(excluded),
    warnings: Object.freeze([
      "NO_CAUSAL_SEO_LIFT_CLAIM",
      "NO_RANK_PROBABILITY_CLAIM",
      "NO_FUTURE_CLIENT_COUNT_GUARANTEE",
      "NO_FUTURE_REVENUE_GUARANTEE",
      "ERROR_BANDS_ARE_EMPIRICAL_DESCRIPTIVE_STATISTICS_NOT_CONFIDENCE_INTERVALS",
      "REAL_ATTRIBUTION_REMAINS_BOUND_TO_GROWTH_ATTRIBUTION_RECEIPTS",
      "CALIBRATION_DOES_NOT_REWRITE_HISTORICAL_SCENARIO_OR_DECISION_HASHES",
    ]),
  };
  return Object.freeze({ ...unsigned, reportSha256: sha256Canonical(unsigned) });
}
