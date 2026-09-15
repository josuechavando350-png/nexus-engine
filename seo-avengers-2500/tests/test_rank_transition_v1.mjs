import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { setTenantEnabled } from "../control-plane/tenant-control.mjs";
import {
  canonicalProviderRecordsSha256,
  publishAuthorizedProviderSnapshot,
} from "../evidence/authorized-provider-snapshot.mjs";
import { readTenantEvidenceSnapshot } from "../evidence/tenant-evidence.mjs";
import {
  attachAuthorityContext,
  buildTopicalAuthorityEvidenceReport,
} from "../rank-feasibility/authority-engine.mjs";
import { buildRankFeasibilityTrendCompetitionReport } from "../rank-feasibility/competition-engine.mjs";
import {
  buildRankTransitionReport,
  validateRankTransitionSnapshot,
} from "../rank-transition/transition-engine.mjs";
import { buildTenantRankTransitionModel } from "../rank-transition/tenant-transition.mjs";

const SITE_ID = "walle-rank-transition-probe";
const AUTHORITY_NON_CLAIM = "INTERNAL_TOPICAL_AUTHORITY_DIAGNOSTIC_NOT_SEARCH_ENGINE_RANKING_EVIDENCE";
const COMPETITION_CAPTURE_SHA256 = sha256Text("synthetic licensed competition export");
const AUTHORITY_CAPTURE_SHA256 = sha256Text("synthetic nexus topical authority assessment");
const TRANSITION_CAPTURE_SHA256 = sha256Text("synthetic privacy-safe rank transition export");
const DUMMY_MANIFEST = sha256Text("synthetic evidence manifest");

const feasibilityProfile = Object.freeze({
  schema_version: 1,
  profile_id: "rank-transition-feasibility-test",
  provenance: "synthetic mechanical thresholds; not Google constants",
  minimum_impressions: 100,
  high_gap_milli: 5_000,
  medium_gap_milli: 15_000,
});

const trendProfile = Object.freeze({
  schema_version: 1,
  profile_id: "rank-transition-trend-test",
  provenance: "synthetic mechanical thresholds; not Google constants",
  minimum_windows: 2,
  minimum_endpoint_impressions: 100,
  improving_delta_milli: 1_000,
  declining_delta_milli: 1_000,
});

const competitionProfile = Object.freeze({
  schema_version: 1,
  profile_id: "rank-transition-competition-test",
  provenance: "synthetic competition thresholds; not Google constants",
  minimum_search_volume: 50,
  low_competitor_count_max: 2,
  medium_competitor_count_max: 5,
});

const authorityProfile = Object.freeze({
  schema_version: 1,
  profile_id: "rank-transition-authority-test",
  provenance: "synthetic NEXUS internal authority thresholds; not Google constants",
  minimum_topics: 2,
  weak_authority_ppm_max: 300_000,
  moderate_authority_ppm_max: 700_000,
});

const transitionProfile = Object.freeze({
  schema_version: 1,
  profile_id: "rank-transition-empirical-test",
  provenance: "synthetic exact empirical cohort thresholds; no smoothing or Google constants",
  horizon_ms: 1_000_000,
  minimum_comparable_transitions: 3,
  minimum_distinct_opportunities: 2,
  minimum_impressions: 100,
});

function compareStrings(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function canonicalJson(value) {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return JSON.stringify(typeof value === "string" ? value.normalize("NFC") : value);
  }
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) throw new TypeError("test canonical values must be safe integers");
    return String(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value)
      .map(([key, item]) => [key.normalize("NFC"), item])
      .sort(([left], [right]) => compareStrings(left, right));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(",")}}`;
  }
  throw new TypeError("test canonical values must be JSON-compatible");
}

function sha256Canonical(value) {
  return `sha256:${createHash("sha256").update(Buffer.from(canonicalJson(value), "utf8")).digest("hex")}`;
}

function sha256Text(value) {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function identity(value) {
  return sha256Text(`opportunity:${value}`);
}

function currentRows() {
  return [
    { query: "alpha legal", page_url: "/alpha", clicks: 30, impressions: 500, average_position_milli: 12_000 },
    { query: "beta legal", page_url: "/beta", clicks: 25, impressions: 400, average_position_milli: 8_000 },
  ];
}

function historyRows() {
  return [
    { query: "alpha legal", page_url: "/alpha", clicks: 10, impressions: 300, average_position_milli: 20_000, window_start_unix_ms: 1_000_000, window_end_unix_ms: 2_000_000 },
    { query: "alpha legal", page_url: "/alpha", clicks: 30, impressions: 500, average_position_milli: 12_000, window_start_unix_ms: 2_000_000, window_end_unix_ms: 3_000_000 },
    { query: "beta legal", page_url: "/beta", clicks: 20, impressions: 350, average_position_milli: 8_200, window_start_unix_ms: 1_000_000, window_end_unix_ms: 2_000_000 },
    { query: "beta legal", page_url: "/beta", clicks: 25, impressions: 400, average_position_milli: 8_000, window_start_unix_ms: 2_000_000, window_end_unix_ms: 3_000_000 },
  ];
}

function competitionRows() {
  return [
    { keyword: "alpha legal", site_ranked: true, competitor_ranked_count: 1, search_volume: 500 },
    { keyword: "beta legal", site_ranked: true, competitor_ranked_count: 4, search_volume: 400 },
  ];
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
      coverage_ppm: 550_000,
      intent_coverage_ppm: 500_000,
      primary_evidence_ppm: 450_000,
      cohesion_ppm: 550_000,
      centrality_ppm: 500_000,
      authority_ppm: 500_000,
      source_non_claim: AUTHORITY_NON_CLAIM,
    },
    {
      topic_id: "Urgent Defense",
      assessment_status: "READY",
      coverage_ppm: 900_000,
      intent_coverage_ppm: 850_000,
      primary_evidence_ppm: 800_000,
      cohesion_ppm: 900_000,
      centrality_ppm: 850_000,
      authority_ppm: 900_000,
      source_non_claim: AUTHORITY_NON_CLAIM,
    },
  ];
}

function rankAuthorityReport() {
  const rank = buildRankFeasibilityTrendCompetitionReport({
    searchPerformanceRecords: currentRows(),
    searchPerformanceHistoryRecords: historyRows(),
    keywordCoverageRecords: competitionRows(),
    feasibilityAssumptionProfile: feasibilityProfile,
    trendAssumptionProfile: trendProfile,
    competitionAssumptionProfile: competitionProfile,
  });
  const authority = buildTopicalAuthorityEvidenceReport({
    topicalAuthorityRecords: authorityRows(),
    authorityAssumptionProfile: authorityProfile,
  });
  return attachAuthorityContext({ rankCompetitionReport: rank, authorityReport: authority });
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
      transition_id: "t-001",
      opportunity_identity_sha256: identity("one"),
      rank_context_report_sha256: sha256Text("historical-rank-report-one"),
      context_captured_at_unix_ms: 4_000_000,
      outcome_observed_at_unix_ms: 5_000_000,
      start_position_milli: 12_000,
      start_impressions: 500,
      outcome_position_milli: 9_000,
      outcome_impressions: 600,
      ...shared,
    },
    {
      transition_id: "t-002",
      opportunity_identity_sha256: identity("two"),
      rank_context_report_sha256: sha256Text("historical-rank-report-two"),
      context_captured_at_unix_ms: 4_100_000,
      outcome_observed_at_unix_ms: 5_100_000,
      start_position_milli: 15_000,
      start_impressions: 450,
      outcome_position_milli: 2_500,
      outcome_impressions: 650,
      ...shared,
    },
    {
      transition_id: "t-003",
      opportunity_identity_sha256: identity("three"),
      rank_context_report_sha256: sha256Text("historical-rank-report-three"),
      context_captured_at_unix_ms: 4_200_000,
      outcome_observed_at_unix_ms: 5_200_000,
      start_position_milli: 20_000,
      start_impressions: 700,
      outcome_position_milli: 15_000,
      outcome_impressions: 750,
      ...shared,
    },
  ];
}

function snapshotRecordsSha256(records) {
  return sha256Canonical([...records].sort((left, right) => compareStrings(left.transition_id, right.transition_id)));
}

function rankTransitionSnapshot({
  siteId = SITE_ID,
  controlGeneration = 1,
  evidenceManifestHash = DUMMY_MANIFEST,
  observedAtUnixMs = 6_000_000,
  records = transitionRecords(),
  sourceAuthority = "WALLE_RANK_TRANSITION_EXPORT_V1",
  sourceCaptureSha256 = TRANSITION_CAPTURE_SHA256,
} = {}) {
  return {
    schema_version: 1,
    site_id: siteId,
    control_generation: controlGeneration,
    evidence_manifest_hash: evidenceManifestHash,
    capture_id: "rank-transition-capture-001",
    observed_at_unix_ms: observedAtUnixMs,
    source_authority: sourceAuthority,
    source_capture_sha256: sourceCaptureSha256,
    records_sha256: snapshotRecordsSha256(records),
    records,
  };
}

function normalDataset(provider, key, records) {
  return { provider, key, records, records_sha256: canonicalProviderRecordsSha256(records) };
}

function competitionDataset(records = competitionRows()) {
  return {
    provider: "NEXUS_COMPETITIVE_SNAPSHOT",
    key: "keyword_coverage_records",
    records,
    records_sha256: canonicalProviderRecordsSha256(records),
    source_authority: "LICENSED_EXPORT:TEST_PROVIDER",
    source_capture_sha256: COMPETITION_CAPTURE_SHA256,
  };
}

function authorityDataset(records = authorityRows()) {
  return {
    provider: "NEXUS_AUTHORITY_SNAPSHOT",
    key: "topical_authority_records",
    records,
    records_sha256: canonicalProviderRecordsSha256(records),
    source_authority: "NEXUS_TOPICAL_AUTHORITY_GRAPH:V1",
    source_capture_sha256: AUTHORITY_CAPTURE_SHA256,
  };
}

function providerSnapshot(generation, observedAtUnixMs = 10_000_000) {
  return {
    schema_version: 1,
    site_id: SITE_ID,
    control_generation: generation,
    capture_id: "rank-transition-current-evidence-001",
    observed_at_unix_ms: observedAtUnixMs,
    datasets: [
      normalDataset("GOOGLE_SEARCH_CONSOLE", "search_performance_records", currentRows()),
      normalDataset("GOOGLE_SEARCH_CONSOLE", "search_performance_history_records", historyRows()),
      competitionDataset(),
      authorityDataset(),
    ],
  };
}

async function setup() {
  const root = await mkdtemp(join(tmpdir(), "walle-rank-transition-"));
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

function tenantArgs(state, transition = {}) {
  return {
    controlRoot: state.controlRoot,
    evidenceRoot: state.evidenceRoot,
    siteId: SITE_ID,
    feasibilityAssumptionProfile: feasibilityProfile,
    trendAssumptionProfile: trendProfile,
    competitionAssumptionProfile: competitionProfile,
    authorityAssumptionProfile: authorityProfile,
    transitionProfile,
    transitionSnapshot: rankTransitionSnapshot({
      controlGeneration: state.control.generation,
      evidenceManifestHash: state.evidence.manifestHash,
      ...transition,
    }),
  };
}

test("empirical transition cohorts expose raw numerator denominator frequencies without a magic score", () => {
  const report = buildRankTransitionReport({
    rankAuthorityContextReport: rankAuthorityReport(),
    transitionSnapshot: rankTransitionSnapshot(),
    transitionProfile,
  });
  assert.equal(report.status, "TRANSITION_READY");
  const alpha = report.opportunities.find((row) => row.query === "alpha legal");
  assert.equal(alpha.startState, "OUTSIDE_TOP_10");
  const top10 = alpha.targets.find((row) => row.rankTarget === "TOP_10");
  const top3 = alpha.targets.find((row) => row.rankTarget === "TOP_3");
  const top1 = alpha.targets.find((row) => row.rankTarget === "TOP_1");
  assert.deepEqual([top10.successCount, top10.sampleCount, top10.empiricalProbabilityPpm], [2, 3, 666_666]);
  assert.deepEqual([top3.successCount, top3.sampleCount, top3.empiricalProbabilityPpm], [1, 3, 333_333]);
  assert.deepEqual([top1.successCount, top1.sampleCount, top1.empiricalProbabilityPpm], [0, 3, 0]);
  assert.ok(!JSON.stringify(report).includes("transitionScore"));
  assert.ok(!JSON.stringify(report).includes("confidenceInterval"));
});

test("already achieved rank targets are not restated as future probabilities", () => {
  const report = buildRankTransitionReport({
    rankAuthorityContextReport: rankAuthorityReport(),
    transitionSnapshot: rankTransitionSnapshot(),
    transitionProfile,
  });
  const beta = report.opportunities.find((row) => row.query === "beta legal");
  const top10 = beta.targets.find((row) => row.rankTarget === "TOP_10");
  assert.equal(top10.status, "ALREADY_ACHIEVED");
  assert.equal(top10.empiricalProbabilityPpm, null);
});

test("minimum distinct opportunity evidence prevents repeated history from pretending sample breadth", () => {
  const repeated = transitionRecords().map((row, index) => ({
    ...row,
    transition_id: `repeat-${index}`,
    opportunity_identity_sha256: identity("same"),
    context_captured_at_unix_ms: 4_000_000 + index * 100_000,
    outcome_observed_at_unix_ms: 5_000_000 + index * 100_000,
  }));
  const report = buildRankTransitionReport({
    rankAuthorityContextReport: rankAuthorityReport(),
    transitionSnapshot: rankTransitionSnapshot({ records: repeated }),
    transitionProfile,
  });
  const cohort = report.transitionCohorts.find((row) => row.startState === "OUTSIDE_TOP_10");
  assert.equal(cohort.sampleCount, 3);
  assert.equal(cohort.distinctOpportunityCount, 1);
  assert.equal(cohort.sampleStatus, "INSUFFICIENT_DATA");
  assert.equal(report.opportunities.find((row) => row.query === "alpha legal").status, "INSUFFICIENT_DATA");
});

test("incomplete and low-impression transitions are excluded explicitly", () => {
  const records = transitionRecords();
  records.push({
    ...records[0],
    transition_id: "excluded-incomplete",
    opportunity_identity_sha256: identity("excluded-incomplete"),
    context_captured_at_unix_ms: 4_300_000,
    outcome_observed_at_unix_ms: 5_300_000,
    observation_complete: false,
  });
  records.push({
    ...records[0],
    transition_id: "excluded-low-impressions",
    opportunity_identity_sha256: identity("excluded-low"),
    context_captured_at_unix_ms: 4_400_000,
    outcome_observed_at_unix_ms: 5_400_000,
    start_impressions: 99,
  });
  const report = buildRankTransitionReport({
    rankAuthorityContextReport: rankAuthorityReport(),
    transitionSnapshot: rankTransitionSnapshot({ records }),
    transitionProfile,
  });
  assert.equal(report.summary.historicalRecordCount, 5);
  assert.equal(report.summary.acceptedHistoricalRecordCount, 3);
  assert.equal(report.summary.excludedIncompleteCount, 1);
  assert.equal(report.summary.excludedLowImpressionCount, 1);
});

test("exact conditioning refuses silent fallback across competition or authority cohorts", () => {
  const records = transitionRecords().map((row) => ({ ...row, competition_band: "MEDIUM" }));
  const report = buildRankTransitionReport({
    rankAuthorityContextReport: rankAuthorityReport(),
    transitionSnapshot: rankTransitionSnapshot({ records }),
    transitionProfile,
  });
  const alpha = report.opportunities.find((row) => row.query === "alpha legal");
  assert.equal(alpha.competitionBand, "LOW");
  assert.equal(alpha.status, "INSUFFICIENT_DATA");
  assert.ok(alpha.targets.filter((row) => row.status !== "ALREADY_ACHIEVED").every((row) => row.empiricalProbabilityPpm === null));
  assert.equal(report.decisionBoundary, "NO_SMOOTHING_NO_EXTRAPOLATION_EXACT_COMPARABLE_COHORT_OR_INSUFFICIENT_DATA");
});

test("record ordering is deterministic and source/profile identities are hash-bound", () => {
  const records = transitionRecords();
  const forward = buildRankTransitionReport({
    rankAuthorityContextReport: rankAuthorityReport(),
    transitionSnapshot: rankTransitionSnapshot({ records }),
    transitionProfile,
  });
  const reverse = buildRankTransitionReport({
    rankAuthorityContextReport: rankAuthorityReport(),
    transitionSnapshot: rankTransitionSnapshot({ records: [...records].reverse() }),
    transitionProfile,
  });
  assert.equal(JSON.stringify(forward), JSON.stringify(reverse));
  assert.equal(forward.reportSha256, reverse.reportSha256);
  const changed = buildRankTransitionReport({
    rankAuthorityContextReport: rankAuthorityReport(),
    transitionSnapshot: rankTransitionSnapshot({ records }),
    transitionProfile: { ...transitionProfile, minimum_comparable_transitions: 4 },
  });
  assert.notEqual(forward.transitionProfile.sha256, changed.transitionProfile.sha256);
  assert.notEqual(forward.reportSha256, changed.reportSha256);
});

test("snapshot schema source authority and records digest fail closed", () => {
  assert.throws(
    () => validateRankTransitionSnapshot(rankTransitionSnapshot({ sourceAuthority: "GOOGLE_PRIVATE_RANK_MODEL" }), transitionProfile),
    /source_authority is not authorized/,
  );
  const tampered = rankTransitionSnapshot();
  tampered.records_sha256 = sha256Text("wrong");
  assert.throws(() => validateRankTransitionSnapshot(tampered, transitionProfile), /records_sha256 mismatch/);
  const extra = rankTransitionSnapshot();
  extra.raw_client_email = "no@example.test";
  assert.throws(() => validateRankTransitionSnapshot(extra, transitionProfile), /unexpected rank transition snapshot keys/);
});

test("chronology horizon and snapshot observation time are enforced", () => {
  const wrongHorizon = transitionRecords();
  wrongHorizon[0] = { ...wrongHorizon[0], outcome_observed_at_unix_ms: 5_000_001 };
  assert.throws(
    () => validateRankTransitionSnapshot(rankTransitionSnapshot({ records: wrongHorizon }), transitionProfile),
    /horizon mismatch/,
  );
  assert.throws(
    () => validateRankTransitionSnapshot(rankTransitionSnapshot({ observedAtUnixMs: 5_000_000 }), transitionProfile),
    /observed_at precedes record outcome/,
  );
});

test("duplicate transition IDs and duplicate opportunity-time observations cannot inflate samples", () => {
  const duplicateId = transitionRecords();
  duplicateId[1] = { ...duplicateId[1], transition_id: duplicateId[0].transition_id };
  assert.throws(
    () => validateRankTransitionSnapshot(rankTransitionSnapshot({ records: duplicateId }), transitionProfile),
    /duplicate transition_id/,
  );
  const duplicateObservation = transitionRecords();
  duplicateObservation[1] = {
    ...duplicateObservation[1],
    opportunity_identity_sha256: duplicateObservation[0].opportunity_identity_sha256,
    context_captured_at_unix_ms: duplicateObservation[0].context_captured_at_unix_ms,
    outcome_observed_at_unix_ms: duplicateObservation[0].outcome_observed_at_unix_ms,
  };
  assert.throws(
    () => validateRankTransitionSnapshot(rankTransitionSnapshot({ records: duplicateObservation }), transitionProfile),
    /duplicate opportunity transition observation/,
  );
});

test("tampered current rank context cannot be used with a copied report hash", () => {
  const current = rankAuthorityReport();
  const tampered = structuredClone(current);
  tampered.opportunities[0].observed.averagePositionMilli = 50_000;
  assert.throws(
    () => buildRankTransitionReport({
      rankAuthorityContextReport: tampered,
      transitionSnapshot: rankTransitionSnapshot(),
      transitionProfile,
    }),
    /rank authority report sha256 mismatch/,
  );
});

test("tenant transition model binds current control generation evidence manifest and exact rank context", async () => {
  const state = await setup();
  const result = await buildTenantRankTransitionModel(tenantArgs(state));
  assert.equal(result.status, "READY");
  assert.equal(result.reason, "RANK_TRANSITION_MODEL_READY");
  assert.equal(result.evidenceManifestHash, state.evidence.manifestHash);
  assert.equal(result.report.status, "TRANSITION_READY");
  assert.equal(result.rankContextReportSha256, result.report.currentRankContextReportSha256);
  assert.match(result.transitionSnapshotSha256, /^sha256:[0-9a-f]{64}$/);
});

test("tenant transition model reports stale control generation and evidence manifest instead of rebinding", async () => {
  const state = await setup();
  const staleGeneration = await buildTenantRankTransitionModel(tenantArgs(state, { controlGeneration: state.control.generation + 1 }));
  assert.equal(staleGeneration.status, "STALE");
  assert.equal(staleGeneration.reason, "RANK_TRANSITION_CONTROL_GENERATION_STALE");

  const staleManifest = await buildTenantRankTransitionModel(tenantArgs(state, { evidenceManifestHash: sha256Text("other-manifest") }));
  assert.equal(staleManifest.status, "STALE");
  assert.equal(staleManifest.reason, "RANK_TRANSITION_EVIDENCE_MANIFEST_STALE");
});

test("tenant transition model blocks cross-tenant or future historical exports", async () => {
  const state = await setup();
  const crossTenant = await buildTenantRankTransitionModel(tenantArgs(state, { siteId: "other-tenant" }));
  assert.equal(crossTenant.status, "BLOCKED");
  assert.equal(crossTenant.reason, "RANK_TRANSITION_CROSS_TENANT_SNAPSHOT");

  const future = await buildTenantRankTransitionModel(tenantArgs(state, { observedAtUnixMs: 10_000_001 }));
  assert.equal(future.status, "BLOCKED");
  assert.equal(future.reason, "RANK_TRANSITION_HISTORY_NEWER_THAN_CURRENT_EVIDENCE");
});

test("insufficient empirical transition sample remains insufficient at tenant boundary", async () => {
  const state = await setup();
  const records = transitionRecords().slice(0, 2);
  const result = await buildTenantRankTransitionModel(tenantArgs(state, { records }));
  assert.equal(result.status, "INSUFFICIENT_DATA");
  assert.equal(result.reason, "RANK_TRANSITION_SAMPLE_INSUFFICIENT");
  assert.equal(result.report.status, "INSUFFICIENT_DATA");
});

test("rank transition production layer has no provider network process publish or tenant-control mutation authority", async () => {
  const engine = await readFile(new URL("../rank-transition/transition-engine.mjs", import.meta.url), "utf8");
  const tenant = await readFile(new URL("../rank-transition/tenant-transition.mjs", import.meta.url), "utf8");
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
  ]) {
    assert.ok(!source.includes(forbidden), `forbidden production capability: ${forbidden}`);
  }
  assert.ok(source.includes("readTenantEvidenceSnapshot"));
  assert.ok(source.includes("readTenantControl"));
});

test("rank transition output refuses causal Google and smoothing claims", () => {
  const report = buildRankTransitionReport({
    rankAuthorityContextReport: rankAuthorityReport(),
    transitionSnapshot: rankTransitionSnapshot(),
    transitionProfile,
  });
  assert.equal(report.interpretation, "EMPIRICAL_HISTORICAL_TRANSITION_FREQUENCY_NOT_CAUSAL_RANK_FORECAST");
  assert.ok(report.warnings.includes("NO_RANK_GUARANTEE"));
  assert.ok(report.warnings.includes("NO_CAUSAL_SEO_LIFT_CLAIM"));
  assert.ok(report.warnings.includes("NO_SMOOTHING_OR_BAYESIAN_PRIOR_IN_V1"));
  assert.ok(report.warnings.includes("AUTHORITY_STRENGTH_IS_INTERNAL_CONTEXT_NOT_GOOGLE_AUTHORITY"));
});
