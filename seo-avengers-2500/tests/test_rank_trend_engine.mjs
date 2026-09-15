import assert from "node:assert/strict";
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
import { buildRankFeasibilityReport } from "../rank-feasibility/feasibility-engine.mjs";
import {
  buildRankFeasibilityWithTrendReport,
  buildRankTrendReport,
} from "../rank-feasibility/longitudinal-engine.mjs";
import { buildTenantRankFeasibilityWithTrend } from "../rank-feasibility/tenant-longitudinal.mjs";

const SITE_ID = "walle-rank-trend-probe";

const feasibilityProfile = Object.freeze({
  schema_version: 1,
  profile_id: "rank-feasibility-trend-test",
  provenance: "synthetic mechanical test thresholds; not Google constants",
  minimum_impressions: 100,
  high_gap_milli: 5_000,
  medium_gap_milli: 10_000,
});

const trendProfile = Object.freeze({
  schema_version: 1,
  profile_id: "rank-trend-test",
  provenance: "synthetic mechanical trend thresholds; not Google constants",
  minimum_windows: 2,
  minimum_endpoint_impressions: 100,
  improving_delta_milli: 1_000,
  declining_delta_milli: 1_000,
});

function currentRows() {
  return [
    { query: "alpha legal", page_url: "/alpha", clicks: 30, impressions: 500, average_position_milli: 8_000 },
    { query: "beta legal", page_url: "/beta", clicks: 25, impressions: 400, average_position_milli: 5_200 },
    { query: "gamma legal", page_url: "/gamma", clicks: 10, impressions: 300, average_position_milli: 6_000 },
  ];
}

function historyRows() {
  return [
    { query: "alpha legal", page_url: "/alpha", clicks: 12, impressions: 300, average_position_milli: 12_000, window_start_unix_ms: 1_000_000, window_end_unix_ms: 2_000_000 },
    { query: "alpha legal", page_url: "/alpha", clicks: 30, impressions: 500, average_position_milli: 8_000, window_start_unix_ms: 2_000_000, window_end_unix_ms: 3_000_000 },
    { query: "beta legal", page_url: "/beta", clicks: 20, impressions: 350, average_position_milli: 5_000, window_start_unix_ms: 1_000_000, window_end_unix_ms: 2_000_000 },
    { query: "beta legal", page_url: "/beta", clicks: 25, impressions: 400, average_position_milli: 5_200, window_start_unix_ms: 2_000_000, window_end_unix_ms: 3_000_000 },
    { query: "gamma legal", page_url: "/gamma", clicks: 20, impressions: 300, average_position_milli: 3_000, window_start_unix_ms: 1_000_000, window_end_unix_ms: 2_000_000 },
    { query: "gamma legal", page_url: "/gamma", clicks: 10, impressions: 300, average_position_milli: 6_000, window_start_unix_ms: 2_000_000, window_end_unix_ms: 3_000_000 },
  ];
}

function dataset(provider, key, records) {
  return {
    provider,
    key,
    records,
    records_sha256: canonicalProviderRecordsSha256(records),
  };
}

async function setup() {
  const root = await mkdtemp(join(tmpdir(), "walle-rank-trend-"));
  const controlRoot = join(root, "control");
  const evidenceRoot = join(root, "evidence");
  await mkdir(controlRoot, { mode: 0o700 });
  await mkdir(evidenceRoot, { mode: 0o700 });
  await mkdir(join(evidenceRoot, "tenants"), { mode: 0o700 });
  const control = await setTenantEnabled({ controlRoot, siteId: SITE_ID, enabled: true, expectedGeneration: 0 });
  return { root, controlRoot, evidenceRoot, control };
}

function snapshot(generation, { includeHistory = true } = {}) {
  const datasets = [dataset("GOOGLE_SEARCH_CONSOLE", "search_performance_records", currentRows())];
  if (includeHistory) {
    datasets.push(dataset("GOOGLE_SEARCH_CONSOLE", "search_performance_history_records", historyRows()));
  }
  return {
    schema_version: 1,
    site_id: SITE_ID,
    control_generation: generation,
    capture_id: "rank-trend-capture-001",
    observed_at_unix_ms: 4_000_000,
    datasets,
  };
}

test("longitudinal engine classifies improving, stable and declining observed momentum", () => {
  const report = buildRankTrendReport({
    searchPerformanceHistoryRecords: historyRows(),
    trendAssumptionProfile: trendProfile,
  });
  assert.equal(report.status, "TREND_READY");
  assert.equal(report.interpretation, "OBSERVED_LONGITUDINAL_SEARCH_EVIDENCE_NOT_PROBABILITY");
  assert.equal(report.opportunities.find((row) => row.query === "alpha legal").momentumBand, "IMPROVING");
  assert.equal(report.opportunities.find((row) => row.query === "beta legal").momentumBand, "STABLE");
  assert.equal(report.opportunities.find((row) => row.query === "gamma legal").momentumBand, "DECLINING");
  assert.deepEqual(report.summary.momentumBands, { IMPROVING: 1, STABLE: 1, DECLINING: 1, INSUFFICIENT_DATA: 0 });
});

test("insufficient windows remain explicit rather than fabricated momentum", () => {
  const report = buildRankTrendReport({
    searchPerformanceHistoryRecords: [historyRows()[0]],
    trendAssumptionProfile: trendProfile,
  });
  assert.equal(report.opportunities[0].momentumBand, "INSUFFICIENT_DATA");
  assert.equal(report.opportunities[0].evidenceStatus, "INSUFFICIENT_WINDOWS");
  assert.equal(report.opportunities[0].positionImprovementMilli, null);
});

test("endpoint impressions below the profile threshold remain insufficient", () => {
  const rows = historyRows().slice(0, 2).map((row) => ({ ...row }));
  rows[1].impressions = 50;
  rows[1].clicks = 5;
  const report = buildRankTrendReport({ searchPerformanceHistoryRecords: rows, trendAssumptionProfile: trendProfile });
  assert.equal(report.opportunities[0].momentumBand, "INSUFFICIENT_DATA");
  assert.equal(report.opportunities[0].evidenceStatus, "INSUFFICIENT_ENDPOINT_IMPRESSIONS");
});

test("history windows must be equal-duration and non-overlapping", () => {
  const durationMismatch = historyRows().slice(0, 2).map((row) => ({ ...row }));
  durationMismatch[1].window_end_unix_ms = 3_500_000;
  assert.throws(
    () => buildRankTrendReport({ searchPerformanceHistoryRecords: durationMismatch, trendAssumptionProfile: trendProfile }),
    /duration mismatch/,
  );

  const overlap = historyRows().slice(0, 2).map((row) => ({ ...row }));
  overlap[1].window_start_unix_ms = 1_500_000;
  overlap[1].window_end_unix_ms = 2_500_000;
  assert.throws(
    () => buildRankTrendReport({ searchPerformanceHistoryRecords: overlap, trendAssumptionProfile: trendProfile }),
    /overlap/,
  );
});

test("history input order does not change report bytes or report hash", () => {
  const forward = buildRankTrendReport({ searchPerformanceHistoryRecords: historyRows(), trendAssumptionProfile: trendProfile });
  const reverse = buildRankTrendReport({ searchPerformanceHistoryRecords: historyRows().reverse(), trendAssumptionProfile: trendProfile });
  assert.equal(JSON.stringify(forward), JSON.stringify(reverse));
  assert.equal(forward.reportSha256, reverse.reportSha256);
});

test("floating-point history evidence fails closed instead of being rounded", () => {
  const rows = historyRows().map((row) => ({ ...row }));
  rows[0].average_position_milli = 12.5;
  assert.throws(
    () => buildRankTrendReport({ searchPerformanceHistoryRecords: rows, trendAssumptionProfile: trendProfile }),
    /integer in range/,
  );
});

test("combined report adds momentum context without upgrading feasibility bands", () => {
  const base = buildRankFeasibilityReport({ searchPerformanceRecords: currentRows(), assumptionProfile: feasibilityProfile });
  const combined = buildRankFeasibilityWithTrendReport({
    searchPerformanceRecords: currentRows(),
    searchPerformanceHistoryRecords: historyRows(),
    feasibilityAssumptionProfile: feasibilityProfile,
    trendAssumptionProfile: trendProfile,
  });
  assert.equal(combined.decisionBoundary, "MOMENTUM_CONTEXT_ONLY_DOES_NOT_UPGRADE_FEASIBILITY_BAND");
  assert.equal(combined.summary.matchedTrendOpportunityCount, 3);
  assert.equal(combined.summary.missingTrendOpportunityCount, 0);
  for (const opportunity of combined.opportunities) {
    const original = base.opportunities.find((row) => row.query === opportunity.query && row.pageUrl === opportunity.pageUrl);
    assert.deepEqual(opportunity.targets, original.targets);
  }
});

test("history-only and current-only opportunities are counted explicitly", () => {
  const history = historyRows();
  history.push({ query: "history only", page_url: "/old", clicks: 3, impressions: 150, average_position_milli: 20_000, window_start_unix_ms: 1_000_000, window_end_unix_ms: 2_000_000 });
  history.push({ query: "history only", page_url: "/old", clicks: 4, impressions: 160, average_position_milli: 18_000, window_start_unix_ms: 2_000_000, window_end_unix_ms: 3_000_000 });
  const current = currentRows();
  current.push({ query: "current only", page_url: "/new", clicks: 4, impressions: 150, average_position_milli: 20_000 });
  const combined = buildRankFeasibilityWithTrendReport({
    searchPerformanceRecords: current,
    searchPerformanceHistoryRecords: history,
    feasibilityAssumptionProfile: feasibilityProfile,
    trendAssumptionProfile: trendProfile,
  });
  assert.equal(combined.summary.historyOnlyOpportunityCount, 1);
  assert.equal(combined.summary.missingTrendOpportunityCount, 1);
  assert.equal(combined.opportunities.find((row) => row.query === "current only").momentum.evidenceStatus, "NO_MATCHING_HISTORY");
});

test("authorized provider snapshot accepts and revalidates Search Console history evidence", async () => {
  const { controlRoot, evidenceRoot, control } = await setup();
  const result = await publishAuthorizedProviderSnapshot({
    controlRoot,
    evidenceRoot,
    siteId: SITE_ID,
    snapshot: snapshot(control.generation),
  });
  assert.equal(result.status, "PUBLISHED");
  assert.equal(result.datasetCount, 3);
  const evidence = await readTenantEvidenceSnapshot({ controlRoot, evidenceRoot, siteId: SITE_ID });
  assert.equal(evidence.status, "READY");
  assert.equal(evidence.datasets.search_performance_history_records.length, 6);
  assert.equal(
    evidence.datasets.upstream_evidence.find((row) => row.dataset_key === "search_performance_history_records").provider,
    "GOOGLE_SEARCH_CONSOLE",
  );
});

test("tenant longitudinal feasibility consumes revalidated evidence and binds the manifest", async () => {
  const { controlRoot, evidenceRoot, control } = await setup();
  await publishAuthorizedProviderSnapshot({ controlRoot, evidenceRoot, siteId: SITE_ID, snapshot: snapshot(control.generation) });
  const evidence = await readTenantEvidenceSnapshot({ controlRoot, evidenceRoot, siteId: SITE_ID });
  const result = await buildTenantRankFeasibilityWithTrend({
    controlRoot,
    evidenceRoot,
    siteId: SITE_ID,
    feasibilityAssumptionProfile: feasibilityProfile,
    trendAssumptionProfile: trendProfile,
  });
  assert.equal(result.status, "READY");
  assert.equal(result.reason, "RANK_FEASIBILITY_TREND_READY");
  assert.equal(result.evidenceManifestHash, evidence.manifestHash);
  assert.equal(result.report.summary.matchedTrendOpportunityCount, 3);
});

test("disabled tenant cannot receive longitudinal rank feasibility", async () => {
  const { controlRoot, evidenceRoot, control } = await setup();
  await publishAuthorizedProviderSnapshot({ controlRoot, evidenceRoot, siteId: SITE_ID, snapshot: snapshot(control.generation) });
  await setTenantEnabled({ controlRoot, siteId: SITE_ID, enabled: false, expectedGeneration: control.generation });
  const result = await buildTenantRankFeasibilityWithTrend({
    controlRoot,
    evidenceRoot,
    siteId: SITE_ID,
    feasibilityAssumptionProfile: feasibilityProfile,
    trendAssumptionProfile: trendProfile,
  });
  assert.equal(result.status, "OFF");
  assert.equal(result.report, null);
});

test("missing history dataset is explicit insufficient data", async () => {
  const { controlRoot, evidenceRoot, control } = await setup();
  await publishAuthorizedProviderSnapshot({
    controlRoot,
    evidenceRoot,
    siteId: SITE_ID,
    snapshot: snapshot(control.generation, { includeHistory: false }),
  });
  const result = await buildTenantRankFeasibilityWithTrend({
    controlRoot,
    evidenceRoot,
    siteId: SITE_ID,
    feasibilityAssumptionProfile: feasibilityProfile,
    trendAssumptionProfile: trendProfile,
  });
  assert.equal(result.status, "INSUFFICIENT_DATA");
  assert.match(result.reason, /search_performance_history_records/);
  assert.equal(result.report, null);
});

test("operational longitudinal layer has no network, provider client, or control mutation authority", async () => {
  const source = await readFile(new URL("../rank-feasibility/tenant-longitudinal.mjs", import.meta.url), "utf8");
  for (const forbidden of [
    /node:http/,
    /node:https/,
    /node:net/,
    /node:tls/,
    /node:dgram/,
    /fetch\s*\(/,
    /axios/,
    /googleapis/,
    /OAuth2?/,
    /setTenantEnabled/,
    /setTenantKillSwitch/,
    /appendTenantControl/,
    /child_process/,
  ]) {
    assert.doesNotMatch(source, forbidden);
  }
  assert.match(source, /readTenantEvidenceSnapshot/);
  assert.match(source, /readTenantControl/);
});
