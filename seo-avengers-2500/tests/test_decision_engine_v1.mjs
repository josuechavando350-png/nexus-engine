import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { setTenantEnabled } from "../control-plane/tenant-control.mjs";
import { buildDecisionReport } from "../decision-engine/decision-engine.mjs";
import { buildTenantDecisionReport } from "../decision-engine/tenant-decision.mjs";
import {
  canonicalProviderRecordsSha256,
  publishAuthorizedProviderSnapshot,
} from "../evidence/authorized-provider-snapshot.mjs";
import { readTenantEvidenceSnapshot } from "../evidence/tenant-evidence.mjs";
import { buildOpportunityPrioritizationReport } from "../opportunity-prioritization/prioritization-engine.mjs";
import {
  buildOutcomeCalibrationReport,
  canonicalCalibrationRecordsSha256,
} from "../outcome-calibration/calibration-engine.mjs";
import { buildRankTransitionReport } from "../rank-transition/transition-engine.mjs";

const SITE_ID = "walle-decision-probe";
const DUMMY_MANIFEST = sha256Text("decision-dummy-manifest");
const AUTHORITY_NON_CLAIM = "INTERNAL_TOPICAL_AUTHORITY_DIAGNOSTIC_NOT_SEARCH_ENGINE_RANKING_EVIDENCE";
const COMPETITION_CAPTURE_SHA256 = sha256Text("decision synthetic competition export");
const AUTHORITY_CAPTURE_SHA256 = sha256Text("decision synthetic authority export");
const TRANSITION_CAPTURE_SHA256 = sha256Text("decision synthetic transition export");
const CALIBRATION_CAPTURE_SHA256 = sha256Text("decision synthetic calibration export");

const feasibilityProfile = Object.freeze({
  schema_version: 1,
  profile_id: "decision-feasibility-test",
  provenance: "synthetic mechanical thresholds; not Google constants",
  minimum_impressions: 100,
  high_gap_milli: 5_000,
  medium_gap_milli: 10_000,
});

const trendProfile = Object.freeze({
  schema_version: 1,
  profile_id: "decision-trend-test",
  provenance: "synthetic mechanical thresholds; not Google constants",
  minimum_windows: 2,
  minimum_endpoint_impressions: 100,
  improving_delta_milli: 1_000,
  declining_delta_milli: 1_000,
});

const competitionProfile = Object.freeze({
  schema_version: 1,
  profile_id: "decision-competition-test",
  provenance: "synthetic competition thresholds; not Google constants",
  minimum_search_volume: 50,
  low_competitor_count_max: 2,
  medium_competitor_count_max: 5,
});

const authorityProfile = Object.freeze({
  schema_version: 1,
  profile_id: "decision-authority-test",
  provenance: "synthetic internal authority thresholds; not Google constants",
  minimum_topics: 2,
  weak_authority_ppm_max: 300_000,
  moderate_authority_ppm_max: 700_000,
});

const growthProfile = Object.freeze({
  schema_version: 1,
  profile_id: "decision-growth-test",
  provenance: "synthetic explicit CTR assumptions; not Google constants",
  click_to_session_ppm: 800_000,
  organic_funnel_source_ids: ["organic"],
  scenarios: [
    { scenario_id: "CONSERVATIVE", target_ctr_ppm: { TOP_10: 80_000, TOP_3: 120_000, TOP_1: 180_000 } },
    { scenario_id: "BASE", target_ctr_ppm: { TOP_10: 100_000, TOP_3: 160_000, TOP_1: 240_000 } },
    { scenario_id: "UPSIDE", target_ctr_ppm: { TOP_10: 120_000, TOP_3: 200_000, TOP_1: 300_000 } },
  ],
});

const prioritizationProfile = Object.freeze({
  schema_version: 1,
  profile_id: "decision-pareto-test",
  provenance: "synthetic deterministic multi-objective policy",
  scenario_id: "BASE",
  economic_objective: "INCREMENTAL_REVENUE_MICROS",
  minimum_feasibility_band: "MEDIUM",
  target_selection_policy: "HARDEST_UNACHIEVED_AT_OR_ABOVE_MINIMUM_FEASIBILITY",
  within_frontier_tie_break_policy: "ECONOMIC_THEN_FEASIBILITY_THEN_MOMENTUM_THEN_COMPETITION_THEN_IDENTITY",
  require_momentum_evidence: true,
  require_competition_evidence: true,
  require_positive_incremental_value: true,
  maximum_candidates: 100,
  max_results: 100,
});

const transitionProfile = Object.freeze({
  schema_version: 1,
  profile_id: "decision-transition-test",
  provenance: "synthetic exact comparable transition policy",
  horizon_ms: 1_000_000,
  minimum_comparable_transitions: 3,
  minimum_distinct_opportunities: 2,
  minimum_impressions: 100,
});

const calibrationProfile = Object.freeze({
  schema_version: 1,
  profile_id: "decision-calibration-test",
  provenance: "synthetic empirical error policy",
  minimum_records: 3,
  minimum_attribution_completeness_ppm: 800_000,
});

const funnel = Object.freeze([
  Object.freeze({
    source_id: "organic",
    sessions: 1_000,
    lead_conversion_ppm: 200_000,
    close_rate_ppm: 250_000,
    average_ticket_micros: 5_000_000_000,
  }),
]);

function compareStrings(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function canonicalJson(value) {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return JSON.stringify(typeof value === "string" ? value.normalize("NFC") : value);
  }
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) throw new TypeError("test values must be safe integers");
    return String(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value)
      .map(([key, item]) => [key.normalize("NFC"), item])
      .sort(([left], [right]) => compareStrings(left, right));
    const seen = new Set();
    return `{${entries.map(([key, item]) => {
      if (seen.has(key)) throw new Error("normalized key collision");
      seen.add(key);
      return `${JSON.stringify(key)}:${canonicalJson(item)}`;
    }).join(",")}}`;
  }
  throw new TypeError("test values must be JSON-compatible");
}

function sha256Canonical(value) {
  return `sha256:${createHash("sha256").update(Buffer.from(canonicalJson(value), "utf8")).digest("hex")}`;
}

function sha256Text(value) {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function target(rankTarget, targetPositionMaxMilli, observedPositionMilli, observedImpressions, feasibilityBand) {
  return {
    rankTarget,
    targetPositionMaxMilli,
    observedPositionMilli,
    gapMilli: Math.max(0, observedPositionMilli - targetPositionMaxMilli),
    feasibilityBand,
    evidenceStatus: "SUFFICIENT_FOR_RULE_EVALUATION",
    minimumImpressions: 100,
    observedImpressions,
  };
}

function rankOpportunity({
  query = "alpha legal",
  pageUrl = "/alpha",
  position = 12_000,
  clicks = 30,
  impressions = 1_000,
  momentumBand = "IMPROVING",
  competitionBand = "LOW",
} = {}) {
  return {
    query,
    pageUrl,
    observed: {
      clicks,
      impressions,
      ctrPpm: Math.floor((clicks * 1_000_000) / impressions),
      averagePositionMilli: position,
      sourceRowCount: 1,
    },
    targets: [
      target("TOP_10", 10_000, position, impressions, position <= 10_000 ? "ACHIEVED" : "HIGH"),
      target("TOP_3", 3_000, position, impressions, position <= 3_000 ? "ACHIEVED" : "MEDIUM"),
      target("TOP_1", 1_000, position, impressions, position <= 1_000 ? "ACHIEVED" : "LOW"),
    ],
    momentum: {
      query,
      pageUrl,
      momentumBand,
      evidenceStatus: momentumBand === "INSUFFICIENT_DATA" ? "NO_MATCHING_HISTORY" : "SUFFICIENT_FOR_TREND_EVALUATION",
    },
    competition: {
      keywordIdentity: query,
      competitionBand,
      evidenceStatus: competitionBand === "INSUFFICIENT_DATA"
        ? "NO_MATCHING_COMPETITION_RECORD"
        : "SUFFICIENT_FOR_RULE_EVALUATION",
    },
  };
}

function rankAuthorityReport(opportunities = [rankOpportunity()]) {
  const unsigned = {
    schemaVersion: 1,
    engineId: "WALLE_RANK_CONTEXT_AUTHORITY_V1",
    status: "RANK_CONTEXT_READY",
    interpretation: "RULE_BOUND_SEARCH_TREND_COMPETITION_AND_INTERNAL_AUTHORITY_CONTEXT_NOT_PROBABILITY",
    rankCompetitionReportSha256: sha256Text("decision-rank-competition"),
    authorityReportSha256: sha256Text("decision-authority"),
    summary: {},
    opportunities,
    authority: {
      status: "AUTHORITY_READY",
      authorityStrength: "MODERATE",
      topicCount: 3,
      sourceAssessmentStatus: "READY",
      componentAverages: {
        coveragePpm: 500_000,
        intentCoveragePpm: 500_000,
        primaryEvidencePpm: 500_000,
        cohesionPpm: 500_000,
        centralityPpm: 500_000,
        authorityPpm: 500_000,
      },
    },
    decisionBoundary: "AUTHORITY_CONTEXT_ONLY_DOES_NOT_UPGRADE_OR_DOWNGRADE_FEASIBILITY_BAND",
    warnings: ["NO_RANK_GUARANTEE", "NO_PROBABILITY_CLAIM"],
  };
  return { ...unsigned, reportSha256: sha256Canonical(unsigned) };
}

function buildPrioritization(rankReport = rankAuthorityReport()) {
  return buildOpportunityPrioritizationReport({
    rankAuthorityReport: rankReport,
    revenueFunnelRecords: funnel,
    growthAssumptionProfile: growthProfile,
    prioritizationProfile,
  });
}

function transitionRecords() {
  const shared = {
    momentum_band: "IMPROVING",
    competition_band: "LOW",
    authority_strength: "MODERATE",
    observation_complete: true,
  };
  return [
    {
      transition_id: "decision-transition-001",
      opportunity_identity_sha256: sha256Text("decision-opportunity-001"),
      rank_context_report_sha256: sha256Text("historical-rank-context-001"),
      context_captured_at_unix_ms: 4_000_000,
      outcome_observed_at_unix_ms: 5_000_000,
      start_position_milli: 12_000,
      start_impressions: 500,
      outcome_position_milli: 2_500,
      outcome_impressions: 600,
      ...shared,
    },
    {
      transition_id: "decision-transition-002",
      opportunity_identity_sha256: sha256Text("decision-opportunity-002"),
      rank_context_report_sha256: sha256Text("historical-rank-context-002"),
      context_captured_at_unix_ms: 4_100_000,
      outcome_observed_at_unix_ms: 5_100_000,
      start_position_milli: 15_000,
      start_impressions: 600,
      outcome_position_milli: 5_000,
      outcome_impressions: 700,
      ...shared,
    },
    {
      transition_id: "decision-transition-003",
      opportunity_identity_sha256: sha256Text("decision-opportunity-003"),
      rank_context_report_sha256: sha256Text("historical-rank-context-003"),
      context_captured_at_unix_ms: 4_200_000,
      outcome_observed_at_unix_ms: 5_200_000,
      start_position_milli: 20_000,
      start_impressions: 700,
      outcome_position_milli: 9_000,
      outcome_impressions: 800,
      ...shared,
    },
  ];
}

function transitionSnapshot({
  siteId = SITE_ID,
  controlGeneration = 1,
  evidenceManifestHash = DUMMY_MANIFEST,
  records = transitionRecords(),
  observedAtUnixMs = 6_000_000,
} = {}) {
  const normalized = [...records].sort((left, right) => compareStrings(left.transition_id, right.transition_id));
  return {
    schema_version: 1,
    site_id: siteId,
    control_generation: controlGeneration,
    evidence_manifest_hash: evidenceManifestHash,
    capture_id: "decision-transition-capture-001",
    observed_at_unix_ms: observedAtUnixMs,
    source_authority: "WALLE_RANK_TRANSITION_EXPORT_V1",
    source_capture_sha256: TRANSITION_CAPTURE_SHA256,
    records_sha256: sha256Canonical(normalized),
    records,
  };
}

function buildTransition(rankReport = rankAuthorityReport(), profile = transitionProfile, snapshot = transitionSnapshot()) {
  return buildRankTransitionReport({
    rankAuthorityContextReport: rankReport,
    transitionSnapshot: snapshot,
    transitionProfile: profile,
  });
}

function calibrationRecords(growthAssumptionProfileSha256, { count = 3, profileHash = growthAssumptionProfileSha256 } = {}) {
  return Array.from({ length: count }, (_, index) => ({
    calibration_id: `decision-calibration-${String(index + 1).padStart(3, "0")}`,
    scenario_id: "BASE",
    rank_target: "TOP_3",
    scenario_report_sha256: sha256Text(`scenario-report-${index}`),
    scenario_assumption_profile_sha256: profileHash,
    feasibility_report_sha256: sha256Text(`feasibility-report-${index}`),
    decision_report_sha256: sha256Text(`historical-decision-report-${index}`),
    action_receipt_sha256: sha256Text(`action-receipt-${index}`),
    growth_attribution_receipt_sha256: sha256Text(`growth-attribution-${index}`),
    client_cohort_report_sha256: sha256Text(`client-cohort-${index}`),
    prediction_created_at_unix_ms: 1_000_000 + index * 10_000,
    action_executed_at_unix_ms: 2_000_000 + index * 10_000,
    window_start_unix_ms: 3_000_000 + index * 10_000,
    window_end_unix_ms: 4_000_000 + index * 10_000,
    observation_complete: true,
    attribution_completeness_ppm: 1_000_000,
    modeled_lead_conversion_ppm: 200_000,
    observed_lead_conversion_ppm: 210_000 + index * 10_000,
    modeled_close_rate_ppm: 250_000,
    observed_close_rate_ppm: 240_000 - index * 5_000,
    modeled_average_ticket_micros: 5_000_000_000,
    observed_average_ticket_micros: 5_100_000_000 + index * 100_000_000,
  }));
}

function calibrationSnapshot(growthAssumptionProfileSha256, {
  siteId = SITE_ID,
  controlGeneration = 1,
  evidenceManifestHash = DUMMY_MANIFEST,
  records = null,
  profileHash = growthAssumptionProfileSha256,
  observedAtUnixMs = 6_000_000,
} = {}) {
  const selected = records ?? calibrationRecords(growthAssumptionProfileSha256, { profileHash });
  return {
    schema_version: 1,
    site_id: siteId,
    control_generation: controlGeneration,
    evidence_manifest_hash: evidenceManifestHash,
    capture_id: "decision-calibration-capture-001",
    observed_at_unix_ms: observedAtUnixMs,
    source_authority: "WALLE_GROWTH_ATTRIBUTION_CALIBRATION_EXPORT_V1",
    source_capture_sha256: CALIBRATION_CAPTURE_SHA256,
    records_sha256: canonicalCalibrationRecordsSha256(selected),
    records: selected,
  };
}

function buildCalibration(prioritization, options = {}) {
  return buildOutcomeCalibrationReport({
    calibrationSnapshot: calibrationSnapshot(prioritization.growthAssumptionProfileSha256, options),
    calibrationProfile,
  });
}

function readyBundle() {
  const rank = rankAuthorityReport();
  const prioritization = buildPrioritization(rank);
  const transition = buildTransition(rank);
  const calibration = buildCalibration(prioritization);
  return { rank, prioritization, transition, calibration };
}

test("decision engine promotes only when prioritized transition and exact profile calibration are ready", () => {
  const { prioritization, transition, calibration } = readyBundle();
  const report = buildDecisionReport({
    prioritizationReport: prioritization,
    rankTransitionReport: transition,
    outcomeCalibrationReport: calibration,
  });
  assert.equal(report.status, "DECISION_READY");
  assert.equal(report.summary.promotedToOptimizationCount, 1);
  assert.equal(report.decisions[0].optimizationEligibility, "PROMOTE_TO_OPTIMIZATION");
  assert.equal(report.decisions[0].selectedTarget.rankTarget, "TOP_3");
  assert.equal(report.decisions[0].empiricalTransition.empiricalProbabilityPpm, 333_333);
  assert.equal(report.decisions[0].exactGrowthProfileCalibrationReady, true);
});

test("decision engine does not convert transition frequency into a hidden expected-value score", () => {
  const { prioritization, transition, calibration } = readyBundle();
  const report = buildDecisionReport({ prioritizationReport: prioritization, rankTransitionReport: transition, outcomeCalibrationReport: calibration });
  const serialized = JSON.stringify(report);
  assert.equal(serialized.includes("decisionScore"), false);
  assert.equal(serialized.includes("priorityScorePpm"), false);
  assert.equal(serialized.includes("probabilityAdjusted"), false);
  assert.equal(report.decisions[0].economicObjective.scenarioValue, prioritization.opportunities[0].objective.value);
  assert.equal(report.calibrationContext.decisionBoundary, "CALIBRATION_QUALIFIES_EVIDENCE_BUT_DOES_NOT_REWRITE_SCENARIO_VALUE");
});

test("exact current growth-profile calibration is mandatory even when global calibration is ready", () => {
  const { rank, prioritization, transition } = readyBundle();
  const calibration = buildCalibration(prioritization, { profileHash: sha256Text("different-growth-profile") });
  assert.equal(calibration.status, "CALIBRATION_READY");
  const report = buildDecisionReport({ prioritizationReport: prioritization, rankTransitionReport: transition, outcomeCalibrationReport: calibration });
  assert.equal(report.status, "INSUFFICIENT_DATA");
  assert.equal(report.decisions[0].optimizationEligibility, "HOLD_FOR_EVIDENCE");
  assert.deepEqual(report.decisions[0].reasons, ["EXACT_GROWTH_PROFILE_CALIBRATION_NOT_READY"]);
  assert.equal(report.calibrationContext.matchedRecordCount, 0);
  assert.ok(rank.reportSha256);
});

test("insufficient exact transition sample holds the opportunity instead of inventing probability", () => {
  const rank = rankAuthorityReport();
  const prioritization = buildPrioritization(rank);
  const transition = buildTransition(rank, { ...transitionProfile, minimum_comparable_transitions: 4 });
  const calibration = buildCalibration(prioritization);
  const report = buildDecisionReport({ prioritizationReport: prioritization, rankTransitionReport: transition, outcomeCalibrationReport: calibration });
  assert.equal(report.status, "INSUFFICIENT_DATA");
  assert.equal(report.decisions[0].optimizationEligibility, "HOLD_FOR_EVIDENCE");
  assert.deepEqual(report.decisions[0].reasons, ["EMPIRICAL_TRANSITION_NOT_READY"]);
  assert.equal(report.decisions[0].empiricalTransition.empiricalProbabilityPpm, null);
});

test("prioritization and transition must bind the same current rank-context report", () => {
  const rank = rankAuthorityReport();
  const prioritization = buildPrioritization(rank);
  const otherRank = rankAuthorityReport([rankOpportunity({ clicks: 31 })]);
  const transition = buildTransition(otherRank);
  const calibration = buildCalibration(prioritization);
  assert.throws(
    () => buildDecisionReport({ prioritizationReport: prioritization, rankTransitionReport: transition, outcomeCalibrationReport: calibration }),
    /not bound to the same rank context report/,
  );
});

test("tampered upstream report hashes fail closed", () => {
  const { prioritization, transition, calibration } = readyBundle();
  const tampered = structuredClone(prioritization);
  tampered.opportunities[0].objective.value += 1;
  assert.throws(
    () => buildDecisionReport({ prioritizationReport: tampered, rankTransitionReport: transition, outcomeCalibrationReport: calibration }),
    /prioritization report hash mismatch/,
  );
});

test("calibration context exposes descriptive exact-profile errors without confidence claims", () => {
  const { prioritization, transition, calibration } = readyBundle();
  const report = buildDecisionReport({ prioritizationReport: prioritization, rankTransitionReport: transition, outcomeCalibrationReport: calibration });
  assert.equal(report.calibrationContext.matchedRecordCount, 3);
  assert.equal(report.calibrationContext.empiricalErrorStats.leadConversionPpm.p50AbsoluteError, 20_000);
  assert.equal(report.calibrationContext.empiricalErrorStats.leadConversionPpm.p90AbsoluteError, 30_000);
  assert.equal(report.calibrationContext.empiricalErrorStats.closeRatePpm.p90AbsoluteError, 20_000);
  assert.equal(report.calibrationContext.empiricalErrorStats.averageTicketMicros.p90AbsoluteError, 300_000_000);
  assert.ok(report.warnings.includes("CALIBRATION_ERRORS_ARE_DESCRIPTIVE_NOT_CONFIDENCE_INTERVALS"));
});

test("decision identities are deterministic and evidence-bound", () => {
  const { prioritization, transition, calibration } = readyBundle();
  const first = buildDecisionReport({ prioritizationReport: prioritization, rankTransitionReport: transition, outcomeCalibrationReport: calibration });
  const second = buildDecisionReport({ prioritizationReport: prioritization, rankTransitionReport: transition, outcomeCalibrationReport: calibration });
  assert.equal(first.reportSha256, second.reportSha256);
  assert.equal(first.decisions[0].decisionId, second.decisions[0].decisionId);
  const weakerTransition = buildTransition(rankAuthorityReport(), { ...transitionProfile, minimum_distinct_opportunities: 3 });
  const changed = buildDecisionReport({ prioritizationReport: prioritization, rankTransitionReport: weakerTransition, outcomeCalibrationReport: calibration });
  assert.notEqual(first.reportSha256, changed.reportSha256);
  assert.notEqual(first.decisions[0].decisionId, changed.decisions[0].decisionId);
});

function currentRows() {
  return [{ query: "alpha legal", page_url: "/alpha", clicks: 30, impressions: 1_000, average_position_milli: 12_000 }];
}

function historyRows() {
  return [
    { query: "alpha legal", page_url: "/alpha", clicks: 15, impressions: 600, average_position_milli: 20_000, window_start_unix_ms: 1_000_000, window_end_unix_ms: 2_000_000 },
    { query: "alpha legal", page_url: "/alpha", clicks: 30, impressions: 1_000, average_position_milli: 12_000, window_start_unix_ms: 2_000_000, window_end_unix_ms: 3_000_000 },
  ];
}

function competitionRows() {
  return [{ keyword: "alpha legal", site_ranked: true, competitor_ranked_count: 1, search_volume: 500 }];
}

function authorityRows() {
  return [
    {
      topic_id: "Criminal Defense",
      assessment_status: "READY",
      coverage_ppm: 300_000,
      intent_coverage_ppm: 250_000,
      primary_evidence_ppm: 200_000,
      cohesion_ppm: 250_000,
      centrality_ppm: 250_000,
      authority_ppm: 200_000,
      source_non_claim: AUTHORITY_NON_CLAIM,
    },
    {
      topic_id: "Legal Strategy",
      assessment_status: "READY",
      coverage_ppm: 600_000,
      intent_coverage_ppm: 550_000,
      primary_evidence_ppm: 500_000,
      cohesion_ppm: 600_000,
      centrality_ppm: 550_000,
      authority_ppm: 500_000,
      source_non_claim: AUTHORITY_NON_CLAIM,
    },
  ];
}

function normalDataset(provider, key, records) {
  return { provider, key, records, records_sha256: canonicalProviderRecordsSha256(records) };
}

function providerSnapshot(generation) {
  return {
    schema_version: 1,
    site_id: SITE_ID,
    control_generation: generation,
    capture_id: "decision-current-evidence-001",
    observed_at_unix_ms: 10_000_000,
    datasets: [
      normalDataset("GOOGLE_SEARCH_CONSOLE", "search_performance_records", currentRows()),
      normalDataset("GOOGLE_SEARCH_CONSOLE", "search_performance_history_records", historyRows()),
      {
        provider: "NEXUS_COMPETITIVE_SNAPSHOT",
        key: "keyword_coverage_records",
        records: competitionRows(),
        records_sha256: canonicalProviderRecordsSha256(competitionRows()),
        source_authority: "LICENSED_EXPORT:DECISION_TEST",
        source_capture_sha256: COMPETITION_CAPTURE_SHA256,
      },
      {
        provider: "NEXUS_AUTHORITY_SNAPSHOT",
        key: "topical_authority_records",
        records: authorityRows(),
        records_sha256: canonicalProviderRecordsSha256(authorityRows()),
        source_authority: "NEXUS_TOPICAL_AUTHORITY_GRAPH:V1",
        source_capture_sha256: AUTHORITY_CAPTURE_SHA256,
      },
      normalDataset("NEXUS_CRM", "revenue_funnel_records", funnel),
    ],
  };
}

async function setupTenant() {
  const root = await mkdtemp(join(tmpdir(), "walle-decision-"));
  const controlRoot = join(root, "control");
  const evidenceRoot = join(root, "evidence");
  await mkdir(controlRoot, { mode: 0o700 });
  await mkdir(evidenceRoot, { mode: 0o700 });
  await mkdir(join(evidenceRoot, "tenants"), { mode: 0o700 });
  const control = await setTenantEnabled({ controlRoot, siteId: SITE_ID, enabled: true, expectedGeneration: 0 });
  await publishAuthorizedProviderSnapshot({
    controlRoot,
    evidenceRoot,
    siteId: SITE_ID,
    snapshot: providerSnapshot(control.generation),
  });
  const evidence = await readTenantEvidenceSnapshot({ controlRoot, evidenceRoot, siteId: SITE_ID });
  assert.equal(evidence.status, "READY");
  return { root, controlRoot, evidenceRoot, control, evidence };
}

function normalizedGrowthProfileSha256() {
  return sha256Canonical(growthProfile);
}

function tenantArguments(state) {
  const growthHash = normalizedGrowthProfileSha256();
  return {
    controlRoot: state.controlRoot,
    evidenceRoot: state.evidenceRoot,
    siteId: SITE_ID,
    feasibilityAssumptionProfile: feasibilityProfile,
    trendAssumptionProfile: trendProfile,
    competitionAssumptionProfile: competitionProfile,
    authorityAssumptionProfile: authorityProfile,
    growthAssumptionProfile: growthProfile,
    prioritizationProfile,
    calibrationProfile,
    calibrationSnapshot: calibrationSnapshot(growthHash, {
      controlGeneration: state.control.generation,
      evidenceManifestHash: state.evidence.manifestHash,
    }),
    transitionProfile,
    transitionSnapshot: transitionSnapshot({
      controlGeneration: state.control.generation,
      evidenceManifestHash: state.evidence.manifestHash,
    }),
  };
}

test("tenant decision composes authorized prioritization calibration and transition evidence", async () => {
  const state = await setupTenant();
  const result = await buildTenantDecisionReport(tenantArguments(state));
  assert.equal(result.status, "READY");
  assert.equal(result.reason, "DECISION_REPORT_READY");
  assert.equal(result.evidenceManifestHash, state.evidence.manifestHash);
  assert.equal(result.report.status, "DECISION_READY");
  assert.equal(result.report.summary.promotedToOptimizationCount, 1);
  assert.equal(result.report.decisions[0].optimizationEligibility, "PROMOTE_TO_OPTIMIZATION");
  assert.equal(result.prioritizationReportSha256, result.report.inputs.prioritizationReportSha256);
  assert.equal(result.rankTransitionReportSha256, result.report.inputs.rankTransitionReportSha256);
  assert.equal(result.outcomeCalibrationReportSha256, result.report.inputs.outcomeCalibrationReportSha256);
});

test("decision production layer has no network process publish site mutation or control mutation authority", async () => {
  const engine = await readFile(new URL("../decision-engine/decision-engine.mjs", import.meta.url), "utf8");
  const tenant = await readFile(new URL("../decision-engine/tenant-decision.mjs", import.meta.url), "utf8");
  const source = `${engine}\n${tenant}`;
  for (const forbidden of [
    "node:http",
    "node:https",
    "node:net",
    "node:tls",
    "child_process",
    "undici",
    "axios",
    "fetch(",
    "publishAuthorizedProviderSnapshot",
    "setTenantEnabled",
    "appendTenantControl",
    "site_mutation",
    "external_link_creation",
  ]) {
    assert.ok(!source.includes(forbidden), `forbidden production capability: ${forbidden}`);
  }
  assert.ok(source.includes("readTenantEvidenceSnapshot"));
  assert.ok(source.includes("readTenantControl"));
});

test("decision output explicitly remains non-autonomous and non-forecasting", () => {
  const { prioritization, transition, calibration } = readyBundle();
  const report = buildDecisionReport({ prioritizationReport: prioritization, rankTransitionReport: transition, outcomeCalibrationReport: calibration });
  assert.equal(report.interpretation, "EVIDENCE_GATED_OPTIMIZATION_ELIGIBILITY_NOT_AUTONOMOUS_ACTION_OR_OUTCOME_FORECAST");
  assert.equal(report.decisionBoundary, "NO_HIDDEN_SCORE_NO_AUTONOMOUS_SITE_ACTION_OPTIMIZATION_BUILDER_MUST_ENFORCE_BUDGET_CAPACITY_DEPENDENCIES_RISK_AND_POLICY");
  assert.ok(report.warnings.includes("NO_FUTURE_CLIENT_OR_REVENUE_GUARANTEE"));
  assert.ok(report.warnings.includes("DECISION_ENGINE_DOES_NOT_EXECUTE_SITE_CHANGES"));
  assert.ok(report.warnings.includes("DECISION_ENGINE_DOES_NOT_SELECT_A_BUDGET_CONSTRAINED_PORTFOLIO"));
});
