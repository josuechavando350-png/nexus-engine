import { createHash } from "node:crypto";

const SCHEMA_VERSION = 1;
const ENGINE_ID = "WALLE_DECISION_ENGINE_V1";
const POLICY_ID = "PROMOTE_ONLY_WITH_PRIORITIZATION_EMPIRICAL_TRANSITION_AND_EXACT_PROFILE_CALIBRATION";
const SHA256_RE = /^sha256:[0-9a-f]{64}$/;
const PPM = 1_000_000;

function compareStrings(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function canonicalJson(value) {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return JSON.stringify(typeof value === "string" ? value.normalize("NFC") : value);
  }
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) throw new TypeError("decision values must be safe integers");
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
  throw new TypeError("decision values must be JSON-compatible");
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

function stringValue(value, label, maxBytes = 16_384) {
  if (typeof value !== "string") throw new Error(`${label} must be a string`);
  const normalized = value.normalize("NFC").trim();
  if (!normalized) throw new Error(`${label} must not be empty`);
  if (Buffer.byteLength(normalized, "utf8") > maxBytes) throw new Error(`${label} exceeds size limit`);
  return normalized;
}

function integerValue(value, label, minimum, maximum) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${label} must be an integer in range`);
  }
  return value;
}

function sha256Value(value, label) {
  if (typeof value !== "string" || !SHA256_RE.test(value)) throw new Error(`${label} must be sha256:<64 lowercase hex>`);
  return value;
}

function validateHashedReport(report, expectedEngineId, label) {
  if (!report || typeof report !== "object" || Array.isArray(report)) throw new Error(`${label} must be an object`);
  if (report.schemaVersion !== SCHEMA_VERSION) throw new Error(`${label} schema mismatch`);
  if (report.engineId !== expectedEngineId) throw new Error(`${label} engine mismatch`);
  const { reportSha256, ...unsigned } = report;
  sha256Value(reportSha256, `${label} reportSha256`);
  if (sha256Canonical(unsigned) !== reportSha256) throw new Error(`${label} hash mismatch`);
  return reportSha256;
}

function opportunityKey(query, pageUrl) {
  return canonicalJson([query, pageUrl]);
}

function validatePrioritizationReport(report) {
  const reportSha256 = validateHashedReport(report, "WALLE_OPPORTUNITY_PRIORITIZATION_V2", "prioritization report");
  if (report.status !== "PRIORITIZATION_READY") throw new Error("prioritization report must be PRIORITIZATION_READY");
  if (report.interpretation !== "DETERMINISTIC_MULTI_OBJECTIVE_PRIORITY_NOT_FORECAST_OR_PROBABILITY") {
    throw new Error("prioritization interpretation mismatch");
  }
  sha256Value(report.rankAuthorityReportSha256, "prioritization rank authority hash");
  const growthAssumptionProfileSha256 = sha256Value(
    report.growthAssumptionProfileSha256,
    "prioritization growth assumption profile hash",
  );
  if (!report.prioritizationProfile || typeof report.prioritizationProfile !== "object" || Array.isArray(report.prioritizationProfile)) {
    throw new Error("prioritization profile missing");
  }
  const scenarioId = stringValue(report.prioritizationProfile.scenarioId, "prioritization scenarioId", 64);
  const economicObjective = stringValue(report.prioritizationProfile.economicObjective, "prioritization economicObjective", 128);
  if (!Array.isArray(report.opportunities) || report.opportunities.length < 1 || report.opportunities.length > 2_000) {
    throw new Error("prioritization opportunities must contain 1..2000 rows");
  }
  const seen = new Set();
  let priorRank = 0;
  const opportunities = Object.freeze(report.opportunities.map((row, index) => {
    exactKeys(
      row,
      [
        "dominatedByCount",
        "economicScenario",
        "objective",
        "objectiveVector",
        "pageUrl",
        "paretoFrontier",
        "paretoLayer",
        "priorityRank",
        "query",
        "selectedTarget",
        "signals",
      ],
      `prioritization opportunity ${index}`,
    );
    const query = stringValue(row.query, `prioritization query ${index}`, 4096);
    const pageUrl = stringValue(row.pageUrl, `prioritization page ${index}`);
    const key = opportunityKey(query, pageUrl);
    if (seen.has(key)) throw new Error(`duplicate prioritization opportunity:${query}:${pageUrl}`);
    seen.add(key);
    const priorityRank = integerValue(row.priorityRank, `priorityRank ${index}`, 1, 2_000);
    if (priorityRank <= priorRank) throw new Error("prioritization opportunities must preserve strict priority order");
    priorRank = priorityRank;
    const paretoLayer = integerValue(row.paretoLayer, `paretoLayer ${index}`, 1, 2_000);
    if (typeof row.paretoFrontier !== "boolean") throw new Error(`paretoFrontier ${index} must be boolean`);
    if (row.paretoFrontier !== (paretoLayer === 1)) throw new Error(`pareto frontier semantics mismatch ${index}`);
    exactKeys(row.selectedTarget, ["feasibilityBand", "gapMilli", "rankTarget"], `selected target ${index}`);
    const rankTarget = stringValue(row.selectedTarget.rankTarget, `rankTarget ${index}`, 32);
    if (!["TOP_10", "TOP_3", "TOP_1"].includes(rankTarget)) throw new Error(`unsupported rank target ${index}`);
    const feasibilityBand = stringValue(row.selectedTarget.feasibilityBand, `feasibilityBand ${index}`, 32);
    if (!["LOW", "MEDIUM", "HIGH"].includes(feasibilityBand)) throw new Error(`unsupported selected feasibility ${index}`);
    const gapMilli = integerValue(row.selectedTarget.gapMilli, `gapMilli ${index}`, 1, 1_000_000_000);
    exactKeys(row.objective, ["id", "value"], `objective ${index}`);
    if (row.objective.id !== economicObjective) throw new Error(`objective id mismatch ${index}`);
    const objectiveValue = integerValue(row.objective.value, `objective value ${index}`, 0, Number.MAX_SAFE_INTEGER);
    exactKeys(
      row.economicScenario,
      ["assumedCtrPpm", "incrementalVsModeledCurrent", "scenarioId"],
      `economic scenario ${index}`,
    );
    if (row.economicScenario.scenarioId !== scenarioId) throw new Error(`economic scenario mismatch ${index}`);
    integerValue(row.economicScenario.assumedCtrPpm, `assumed CTR ${index}`, 0, PPM);
    return Object.freeze({
      key,
      query,
      pageUrl,
      priorityRank,
      paretoLayer,
      paretoFrontier: row.paretoFrontier,
      rankTarget,
      feasibilityBand,
      gapMilli,
      objectiveValue,
    });
  }));
  return Object.freeze({
    reportSha256,
    rankAuthorityReportSha256: report.rankAuthorityReportSha256,
    growthAssumptionProfileSha256,
    scenarioId,
    economicObjective,
    opportunities,
  });
}

function validateRankTransitionReport(report) {
  const reportSha256 = validateHashedReport(report, "WALLE_RANK_TRANSITION_V1", "rank transition report");
  if (!["TRANSITION_READY", "INSUFFICIENT_DATA"].includes(report.status)) throw new Error("rank transition report status invalid");
  if (report.interpretation !== "EMPIRICAL_HISTORICAL_TRANSITION_FREQUENCY_NOT_CAUSAL_RANK_FORECAST") {
    throw new Error("rank transition interpretation mismatch");
  }
  const currentRankContextReportSha256 = sha256Value(
    report.currentRankContextReportSha256,
    "rank transition current rank context hash",
  );
  const horizonMs = integerValue(report.transitionProfile?.horizonMs, "rank transition horizonMs", 1, Number.MAX_SAFE_INTEGER);
  if (!Array.isArray(report.opportunities) || report.opportunities.length < 1 || report.opportunities.length > 100_000) {
    throw new Error("rank transition opportunities must contain 1..100000 rows");
  }
  const registry = new Map();
  for (const [index, row] of report.opportunities.entries()) {
    const query = stringValue(row.query, `rank transition query ${index}`, 4096);
    const pageUrl = stringValue(row.pageUrl, `rank transition page ${index}`);
    const key = opportunityKey(query, pageUrl);
    if (registry.has(key)) throw new Error(`duplicate rank transition opportunity:${query}:${pageUrl}`);
    if (!Array.isArray(row.targets)) throw new Error(`rank transition targets ${index} must be an array`);
    const targets = new Map();
    for (const [targetIndex, target] of row.targets.entries()) {
      const rankTarget = stringValue(target.rankTarget, `transition target ${index}:${targetIndex}`, 32);
      if (!["TOP_10", "TOP_3", "TOP_1"].includes(rankTarget) || targets.has(rankTarget)) {
        throw new Error(`invalid or duplicate transition target ${index}:${targetIndex}`);
      }
      const status = stringValue(target.status, `transition target status ${index}:${targetIndex}`, 128);
      if (!["ALREADY_ACHIEVED", "INSUFFICIENT_DATA", "EMPIRICAL_TRANSITION_FREQUENCY_READY"].includes(status)) {
        throw new Error(`unsupported transition target status ${index}:${targetIndex}`);
      }
      const sampleCount = integerValue(target.sampleCount, `transition sampleCount ${index}:${targetIndex}`, 0, 100_000);
      const distinctOpportunityCount = integerValue(
        target.distinctOpportunityCount,
        `transition distinctOpportunityCount ${index}:${targetIndex}`,
        0,
        100_000,
      );
      const successCount = target.successCount === null
        ? null
        : integerValue(target.successCount, `transition successCount ${index}:${targetIndex}`, 0, sampleCount);
      const empiricalProbabilityPpm = target.empiricalProbabilityPpm === null
        ? null
        : integerValue(target.empiricalProbabilityPpm, `transition probability ${index}:${targetIndex}`, 0, PPM);
      if (status === "EMPIRICAL_TRANSITION_FREQUENCY_READY") {
        if (sampleCount < 1 || successCount === null || empiricalProbabilityPpm === null) {
          throw new Error(`ready transition target lacks empirical counts ${index}:${targetIndex}`);
        }
        const expected = Number((BigInt(successCount) * BigInt(PPM)) / BigInt(sampleCount));
        if (empiricalProbabilityPpm !== expected) throw new Error(`transition probability arithmetic mismatch ${index}:${targetIndex}`);
      } else if (empiricalProbabilityPpm !== null) {
        throw new Error(`non-ready transition target cannot expose probability ${index}:${targetIndex}`);
      }
      targets.set(rankTarget, Object.freeze({ status, sampleCount, distinctOpportunityCount, successCount, empiricalProbabilityPpm }));
    }
    registry.set(key, Object.freeze({ query, pageUrl, status: row.status, targets }));
  }
  return Object.freeze({ reportSha256, currentRankContextReportSha256, horizonMs, registry });
}

function percentileNearestRank(values, numerator, denominator) {
  if (values.length < 1) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const rank = Math.max(1, Math.ceil((sorted.length * numerator) / denominator));
  return sorted[rank - 1];
}

function metricErrorStats(records, field) {
  const values = records
    .map((record) => record.errors[field])
    .filter((value) => value !== null)
    .map((value) => integerValue(value, `calibration ${field} error`, -Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER));
  if (values.length < 1) return Object.freeze({ sampleCount: 0, p50AbsoluteError: null, p90AbsoluteError: null, maxAbsoluteError: null });
  const absolute = values.map((value) => Math.abs(value));
  return Object.freeze({
    sampleCount: absolute.length,
    p50AbsoluteError: percentileNearestRank(absolute, 50, 100),
    p90AbsoluteError: percentileNearestRank(absolute, 90, 100),
    maxAbsoluteError: Math.max(...absolute),
  });
}

function validateCalibrationReport(report, growthAssumptionProfileSha256, scenarioId) {
  const reportSha256 = validateHashedReport(report, "WALLE_OUTCOME_CALIBRATION_V1", "outcome calibration report");
  if (!["CALIBRATION_READY", "INSUFFICIENT_DATA"].includes(report.status)) throw new Error("calibration report status invalid");
  if (report.interpretation !== "EMPIRICAL_MODEL_COMPONENT_ERROR_NOT_CAUSAL_LIFT_OR_FORECAST_ACCURACY_GUARANTEE") {
    throw new Error("calibration interpretation mismatch");
  }
  const minimumRecords = integerValue(report.calibrationProfile?.minimumRecords, "calibration minimumRecords", 1, 100_000);
  if (!Array.isArray(report.acceptedRecords) || report.acceptedRecords.length > 100_000) {
    throw new Error("calibration acceptedRecords must be bounded array");
  }
  const matched = [];
  const seen = new Set();
  for (const [index, record] of report.acceptedRecords.entries()) {
    const calibrationId = stringValue(record.calibrationId, `calibration id ${index}`, 256);
    if (seen.has(calibrationId)) throw new Error(`duplicate calibration id:${calibrationId}`);
    seen.add(calibrationId);
    if (!record.bindings || typeof record.bindings !== "object" || Array.isArray(record.bindings)) {
      throw new Error(`calibration bindings ${index} missing`);
    }
    sha256Value(record.bindings.scenarioAssumptionProfileSha256, `calibration scenario profile hash ${index}`);
    if (!record.errors || typeof record.errors !== "object" || Array.isArray(record.errors)) {
      throw new Error(`calibration errors ${index} missing`);
    }
    if (record.scenarioId === scenarioId && record.bindings.scenarioAssumptionProfileSha256 === growthAssumptionProfileSha256) {
      matched.push(record);
    }
  }
  const exactProfileReady = matched.length >= minimumRecords;
  return Object.freeze({
    reportSha256,
    exactProfileReady,
    matchedRecordCount: matched.length,
    minimumRecords,
    scenarioId,
    growthAssumptionProfileSha256,
    errors: Object.freeze({
      leadConversionPpm: metricErrorStats(matched, "leadConversionPpm"),
      closeRatePpm: metricErrorStats(matched, "closeRatePpm"),
      averageTicketMicros: metricErrorStats(matched, "averageTicketMicros"),
    }),
  });
}

export function buildDecisionReport({ prioritizationReport, rankTransitionReport, outcomeCalibrationReport }) {
  const prioritization = validatePrioritizationReport(prioritizationReport);
  const transition = validateRankTransitionReport(rankTransitionReport);
  if (transition.currentRankContextReportSha256 !== prioritization.rankAuthorityReportSha256) {
    throw new Error("prioritization and rank transition are not bound to the same rank context report");
  }
  const calibration = validateCalibrationReport(
    outcomeCalibrationReport,
    prioritization.growthAssumptionProfileSha256,
    prioritization.scenarioId,
  );

  let promotedCount = 0;
  let heldTransitionCount = 0;
  let heldCalibrationCount = 0;
  const decisions = Object.freeze(prioritization.opportunities.map((opportunity) => {
    const transitionOpportunity = transition.registry.get(opportunity.key);
    const transitionTarget = transitionOpportunity?.targets.get(opportunity.rankTarget) ?? null;
    const reasons = [];
    if (transitionTarget === null || transitionTarget.status !== "EMPIRICAL_TRANSITION_FREQUENCY_READY") {
      reasons.push("EMPIRICAL_TRANSITION_NOT_READY");
      heldTransitionCount += 1;
    }
    if (!calibration.exactProfileReady) {
      reasons.push("EXACT_GROWTH_PROFILE_CALIBRATION_NOT_READY");
      heldCalibrationCount += 1;
    }
    const optimizationEligibility = reasons.length === 0 ? "PROMOTE_TO_OPTIMIZATION" : "HOLD_FOR_EVIDENCE";
    if (optimizationEligibility === "PROMOTE_TO_OPTIMIZATION") promotedCount += 1;
    const decisionUnsigned = {
      query: opportunity.query,
      pageUrl: opportunity.pageUrl,
      priorityRank: opportunity.priorityRank,
      paretoLayer: opportunity.paretoLayer,
      paretoFrontier: opportunity.paretoFrontier,
      selectedTarget: Object.freeze({
        rankTarget: opportunity.rankTarget,
        feasibilityBand: opportunity.feasibilityBand,
        gapMilli: opportunity.gapMilli,
      }),
      economicObjective: Object.freeze({ id: prioritization.economicObjective, scenarioValue: opportunity.objectiveValue }),
      empiricalTransition: transitionTarget === null
        ? null
        : Object.freeze({
          horizonMs: transition.horizonMs,
          status: transitionTarget.status,
          successCount: transitionTarget.successCount,
          sampleCount: transitionTarget.sampleCount,
          distinctOpportunityCount: transitionTarget.distinctOpportunityCount,
          empiricalProbabilityPpm: transitionTarget.empiricalProbabilityPpm,
        }),
      exactGrowthProfileCalibrationReady: calibration.exactProfileReady,
      optimizationEligibility,
      reasons: Object.freeze(reasons),
    };
    return Object.freeze({
      decisionId: sha256Canonical({
        policyId: POLICY_ID,
        prioritizationReportSha256: prioritization.reportSha256,
        rankTransitionReportSha256: transition.reportSha256,
        outcomeCalibrationReportSha256: calibration.reportSha256,
        query: opportunity.query,
        pageUrl: opportunity.pageUrl,
        rankTarget: opportunity.rankTarget,
      }),
      ...decisionUnsigned,
    });
  }));

  const status = promotedCount > 0 ? "DECISION_READY" : "INSUFFICIENT_DATA";
  const unsigned = {
    schemaVersion: SCHEMA_VERSION,
    engineId: ENGINE_ID,
    status,
    interpretation: "EVIDENCE_GATED_OPTIMIZATION_ELIGIBILITY_NOT_AUTONOMOUS_ACTION_OR_OUTCOME_FORECAST",
    decisionPolicyId: POLICY_ID,
    inputs: Object.freeze({
      prioritizationReportSha256: prioritization.reportSha256,
      rankTransitionReportSha256: transition.reportSha256,
      outcomeCalibrationReportSha256: calibration.reportSha256,
      rankContextReportSha256: prioritization.rankAuthorityReportSha256,
      growthAssumptionProfileSha256: prioritization.growthAssumptionProfileSha256,
    }),
    calibrationContext: Object.freeze({
      exactProfileReady: calibration.exactProfileReady,
      scenarioId: calibration.scenarioId,
      growthAssumptionProfileSha256: calibration.growthAssumptionProfileSha256,
      matchedRecordCount: calibration.matchedRecordCount,
      minimumRecords: calibration.minimumRecords,
      empiricalErrorStats: calibration.errors,
      decisionBoundary: "CALIBRATION_QUALIFIES_EVIDENCE_BUT_DOES_NOT_REWRITE_SCENARIO_VALUE",
    }),
    summary: Object.freeze({
      prioritizedCandidateCount: decisions.length,
      promotedToOptimizationCount: promotedCount,
      heldForEvidenceCount: decisions.length - promotedCount,
      heldTransitionCount,
      heldCalibrationCount,
    }),
    decisions,
    decisionBoundary: "NO_HIDDEN_SCORE_NO_AUTONOMOUS_SITE_ACTION_OPTIMIZATION_BUILDER_MUST_ENFORCE_BUDGET_CAPACITY_DEPENDENCIES_RISK_AND_POLICY",
    warnings: Object.freeze([
      "NO_RANK_GUARANTEE",
      "NO_CAUSAL_SEO_LIFT_CLAIM",
      "NO_FUTURE_CLIENT_OR_REVENUE_GUARANTEE",
      "EMPIRICAL_TRANSITION_FREQUENCY_MAY_NOT_GENERALIZE",
      "CALIBRATION_ERRORS_ARE_DESCRIPTIVE_NOT_CONFIDENCE_INTERVALS",
      "SCENARIO_ECONOMIC_VALUE_REMAINS_BOUNDED_HYPOTHETICAL_NOT_FORECAST",
      "DECISION_ENGINE_DOES_NOT_EXECUTE_SITE_CHANGES",
      "DECISION_ENGINE_DOES_NOT_SELECT_A_BUDGET_CONSTRAINED_PORTFOLIO",
    ]),
  };
  return Object.freeze({ ...unsigned, reportSha256: sha256Canonical(unsigned) });
}

export const DECISION_POLICY_ID = POLICY_ID;
