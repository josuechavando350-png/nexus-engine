import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
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
  buildRankCompetitionReport,
  buildRankFeasibilityTrendCompetitionReport,
} from "../rank-feasibility/competition-engine.mjs";
import { buildRankFeasibilityWithTrendReport } from "../rank-feasibility/longitudinal-engine.mjs";
import { buildTenantRankContextWithCompetition } from "../rank-feasibility/tenant-competition.mjs";

const SITE_ID = "walle-rank-competition-probe";
const SOURCE_CAPTURE_SHA256 = `sha256:${createHash("sha256").update("synthetic licensed competition export").digest("hex")}`;

const feasibilityProfile = Object.freeze({
  schema_version: 1,
  profile_id: "rank-competition-feasibility-test",
  provenance: "synthetic mechanical thresholds; not Google constants",
  minimum_impressions: 100,
  high_gap_milli: 5_000,
  medium_gap_milli: 10_000,
});

const trendProfile = Object.freeze({
  schema_version: 1,
  profile_id: "rank-competition-trend-test",
  provenance: "synthetic mechanical thresholds; not Google constants",
  minimum_windows: 2,
  minimum_endpoint_impressions: 100,
  improving_delta_milli: 1_000,
  declining_delta_milli: 1_000,
});

const competitionProfile = Object.freeze({
  schema_version: 1,
  profile_id: "rank-competition-pressure-test",
  provenance: "synthetic competition count thresholds; not Google constants",
  minimum_search_volume: 50,
  low_competitor_count_max: 2,
  medium_competitor_count_max: 5,
});

function currentRows() {
  return [
    { query: "Alpha Legal", page_url: "/alpha", clicks: 30, impressions: 500, average_position_milli: 8_000 },
    { query: "beta legal", page_url: "/beta", clicks: 25, impressions: 400, average_position_milli: 5_200 },
    { query: "gamma legal", page_url: "/gamma", clicks: 10, impressions: 300, average_position_milli: 6_000 },
    { query: "current only", page_url: "/current", clicks: 5, impressions: 150, average_position_milli: 15_000 },
  ];
}

function historyRows() {
  return [
    { query: "Alpha Legal", page_url: "/alpha", clicks: 12, impressions: 300, average_position_milli: 12_000, window_start_unix_ms: 1_000_000, window_end_unix_ms: 2_000_000 },
    { query: "Alpha Legal", page_url: "/alpha", clicks: 30, impressions: 500, average_position_milli: 8_000, window_start_unix_ms: 2_000_000, window_end_unix_ms: 3_000_000 },
    { query: "beta legal", page_url: "/beta", clicks: 20, impressions: 350, average_position_milli: 5_000, window_start_unix_ms: 1_000_000, window_end_unix_ms: 2_000_000 },
    { query: "beta legal", page_url: "/beta", clicks: 25, impressions: 400, average_position_milli: 5_200, window_start_unix_ms: 2_000_000, window_end_unix_ms: 3_000_000 },
    { query: "gamma legal", page_url: "/gamma", clicks: 20, impressions: 300, average_position_milli: 3_000, window_start_unix_ms: 1_000_000, window_end_unix_ms: 2_000_000 },
    { query: "gamma legal", page_url: "/gamma", clicks: 10, impressions: 300, average_position_milli: 6_000, window_start_unix_ms: 2_000_000, window_end_unix_ms: 3_000_000 },
    { query: "current only", page_url: "/current", clicks: 3, impressions: 120, average_position_milli: 17_000, window_start_unix_ms: 1_000_000, window_end_unix_ms: 2_000_000 },
    { query: "current only", page_url: "/current", clicks: 5, impressions: 150, average_position_milli: 15_000, window_start_unix_ms: 2_000_000, window_end_unix_ms: 3_000_000 },
  ];
}

function competitionRows() {
  return [
    { keyword: "  ALPHA   LEGAL ", site_ranked: true, competitor_ranked_count: 1, search_volume: 500 },
    { keyword: "beta legal", site_ranked: true, competitor_ranked_count: 4, search_volume: 400 },
    { keyword: "gamma legal", site_ranked: true, competitor_ranked_count: 8, search_volume: 300 },
    { keyword: "tiny volume", site_ranked: false, competitor_ranked_count: 1, search_volume: 10 },
    { keyword: "competition only", site_ranked: false, competitor_ranked_count: 3, search_volume: 200 },
  ];
}

function normalDataset(provider, key, records) {
  return {
    provider,
    key,
    records,
    records_sha256: canonicalProviderRecordsSha256(records),
  };
}

function competitionDataset(records = competitionRows()) {
  return {
    provider: "NEXUS_COMPETITIVE_SNAPSHOT",
    key: "keyword_coverage_records",
    records,
    records_sha256: canonicalProviderRecordsSha256(records),
    source_authority: "LICENSED_EXPORT:TEST_PROVIDER",
    source_capture_sha256: SOURCE_CAPTURE_SHA256,
  };
}

async function setup() {
  const root = await mkdtemp(join(tmpdir(), "walle-rank-competition-"));
  const controlRoot = join(root, "control");
  const evidenceRoot = join(root, "evidence");
  await mkdir(controlRoot, { mode: 0o700 });
  await mkdir(evidenceRoot, { mode: 0o700 });
  await mkdir(join(evidenceRoot, "tenants"), { mode: 0o700 });
  const control = await setTenantEnabled({ controlRoot, siteId: SITE_ID, enabled: true, expectedGeneration: 0 });
  return { root, controlRoot, evidenceRoot, control };
}

function snapshot(generation, { includeCompetition = true } = {}) {
  const datasets = [
    normalDataset("GOOGLE_SEARCH_CONSOLE", "search_performance_records", currentRows()),
    normalDataset("GOOGLE_SEARCH_CONSOLE", "search_performance_history_records", historyRows()),
  ];
  if (includeCompetition) datasets.push(competitionDataset());
  return {
    schema_version: 1,
    site_id: SITE_ID,
    control_generation: generation,
    capture_id: "rank-competition-capture-001",
    observed_at_unix_ms: 4_000_000,
    datasets,
  };
}

test("competition engine classifies low medium high and insufficient evidence from explicit thresholds", () => {
  const report = buildRankCompetitionReport({
    keywordCoverageRecords: competitionRows(),
    competitionAssumptionProfile: competitionProfile,
  });
  assert.equal(report.status, "COMPETITION_READY");
  assert.equal(report.interpretation, "AUTHORIZED_COMPETITION_EVIDENCE_NOT_RANK_PROBABILITY");
  assert.equal(report.competition.find((row) => row.keywordIdentity === "alpha legal").assessment.competitionBand, "LOW");
  assert.equal(report.competition.find((row) => row.keywordIdentity === "beta legal").assessment.competitionBand, "MEDIUM");
  assert.equal(report.competition.find((row) => row.keywordIdentity === "gamma legal").assessment.competitionBand, "HIGH");
  assert.equal(report.competition.find((row) => row.keywordIdentity === "tiny volume").assessment.competitionBand, "INSUFFICIENT_DATA");
});

test("competition input ordering and equivalent keyword spelling do not change report bytes", () => {
  const rows = competitionRows();
  rows.push({ keyword: "alpha legal", site_ranked: true, competitor_ranked_count: 1, search_volume: 500 });
  const forward = buildRankCompetitionReport({ keywordCoverageRecords: rows, competitionAssumptionProfile: competitionProfile });
  const reverse = buildRankCompetitionReport({ keywordCoverageRecords: [...rows].reverse(), competitionAssumptionProfile: competitionProfile });
  assert.equal(JSON.stringify(forward), JSON.stringify(reverse));
  assert.equal(forward.reportSha256, reverse.reportSha256);
});

test("conflicting normalized duplicate competition evidence fails closed", () => {
  const rows = competitionRows();
  rows.push({ keyword: "alpha legal", site_ranked: true, competitor_ranked_count: 9, search_volume: 500 });
  assert.throws(
    () => buildRankCompetitionReport({ keywordCoverageRecords: rows, competitionAssumptionProfile: competitionProfile }),
    /conflicting duplicate keyword coverage/,
  );
});

test("floating-point and malformed competition evidence fail closed", () => {
  const rows = competitionRows().map((row) => ({ ...row }));
  rows[0].search_volume = 12.5;
  assert.throws(
    () => buildRankCompetitionReport({ keywordCoverageRecords: rows, competitionAssumptionProfile: competitionProfile }),
    /integer in range/,
  );
  const malformed = competitionRows().map((row) => ({ ...row }));
  malformed[0].extra = "forbidden";
  assert.throws(
    () => buildRankCompetitionReport({ keywordCoverageRecords: malformed, competitionAssumptionProfile: competitionProfile }),
    /unexpected keyword coverage row 0 keys/,
  );
});

test("competition profile is hash-bound and rejects inverted pressure bands", () => {
  const first = buildRankCompetitionReport({ keywordCoverageRecords: competitionRows(), competitionAssumptionProfile: competitionProfile });
  const changed = buildRankCompetitionReport({
    keywordCoverageRecords: competitionRows(),
    competitionAssumptionProfile: { ...competitionProfile, medium_competitor_count_max: 6 },
  });
  assert.notEqual(first.competitionAssumptionProfile.sha256, changed.competitionAssumptionProfile.sha256);
  assert.notEqual(first.reportSha256, changed.reportSha256);
  assert.throws(
    () => buildRankCompetitionReport({
      keywordCoverageRecords: competitionRows(),
      competitionAssumptionProfile: { ...competitionProfile, low_competitor_count_max: 6, medium_competitor_count_max: 5 },
    }),
    /must be greater than or equal/,
  );
});

test("combined competition context cannot upgrade or downgrade existing rank feasibility bands", () => {
  const prior = buildRankFeasibilityWithTrendReport({
    searchPerformanceRecords: currentRows(),
    searchPerformanceHistoryRecords: historyRows(),
    feasibilityAssumptionProfile: feasibilityProfile,
    trendAssumptionProfile: trendProfile,
  });
  const combined = buildRankFeasibilityTrendCompetitionReport({
    searchPerformanceRecords: currentRows(),
    searchPerformanceHistoryRecords: historyRows(),
    keywordCoverageRecords: competitionRows(),
    feasibilityAssumptionProfile: feasibilityProfile,
    trendAssumptionProfile: trendProfile,
    competitionAssumptionProfile: competitionProfile,
  });
  assert.equal(combined.decisionBoundary, "COMPETITION_CONTEXT_ONLY_DOES_NOT_UPGRADE_OR_DOWNGRADE_FEASIBILITY_BAND");
  for (const opportunity of combined.opportunities) {
    const earlier = prior.opportunities.find((row) => row.query === opportunity.query && row.pageUrl === opportunity.pageUrl);
    assert.deepEqual(opportunity.targets, earlier.targets);
    assert.deepEqual(opportunity.momentum, earlier.momentum);
  }
});

test("current queries without competition evidence and competition-only keywords stay explicit", () => {
  const combined = buildRankFeasibilityTrendCompetitionReport({
    searchPerformanceRecords: currentRows(),
    searchPerformanceHistoryRecords: historyRows(),
    keywordCoverageRecords: competitionRows(),
    feasibilityAssumptionProfile: feasibilityProfile,
    trendAssumptionProfile: trendProfile,
    competitionAssumptionProfile: competitionProfile,
  });
  assert.equal(combined.summary.matchedCompetitionOpportunityCount, 3);
  assert.equal(combined.summary.missingCompetitionOpportunityCount, 1);
  assert.equal(combined.summary.competitionOnlyKeywordCount, 2);
  assert.equal(
    combined.opportunities.find((row) => row.query === "current only").competition.evidenceStatus,
    "NO_MATCHING_COMPETITION_RECORD",
  );
});

test("authorized publisher persists competition source authority and upstream artifact hash", async () => {
  const { controlRoot, evidenceRoot, control } = await setup();
  const published = await publishAuthorizedProviderSnapshot({
    controlRoot,
    evidenceRoot,
    siteId: SITE_ID,
    snapshot: snapshot(control.generation),
  });
  assert.equal(published.status, "PUBLISHED");
  const evidence = await readTenantEvidenceSnapshot({ controlRoot, evidenceRoot, siteId: SITE_ID });
  assert.equal(evidence.status, "READY");
  const provenance = evidence.datasets.upstream_evidence.find((row) => row.dataset_key === "keyword_coverage_records");
  assert.equal(provenance.provider, "NEXUS_COMPETITIVE_SNAPSHOT");
  assert.equal(provenance.source_authority, "LICENSED_EXPORT:TEST_PROVIDER");
  assert.equal(provenance.source_capture_sha256, SOURCE_CAPTURE_SHA256);
  assert.equal(provenance.records_sha256, canonicalProviderRecordsSha256(competitionRows()));
});

test("competition dataset rejects wrong provider and missing provenance fields", async () => {
  const { controlRoot, evidenceRoot, control } = await setup();
  const wrongProvider = snapshot(control.generation);
  wrongProvider.datasets[2] = normalDataset("GOOGLE_SEARCH_CONSOLE", "keyword_coverage_records", competitionRows());
  await assert.rejects(
    publishAuthorizedProviderSnapshot({ controlRoot, evidenceRoot, siteId: SITE_ID, snapshot: wrongProvider }),
    /provider is not authorized for dataset key/,
  );

  const { controlRoot: controlRoot2, evidenceRoot: evidenceRoot2, control: control2 } = await setup();
  const missingProvenance = snapshot(control2.generation);
  missingProvenance.datasets[2] = normalDataset("NEXUS_COMPETITIVE_SNAPSHOT", "keyword_coverage_records", competitionRows());
  await assert.rejects(
    publishAuthorizedProviderSnapshot({ controlRoot: controlRoot2, evidenceRoot: evidenceRoot2, siteId: SITE_ID, snapshot: missingProvenance }),
    /unexpected provider dataset keys/,
  );
});

test("competition provider rejects malformed source authority and capture hash", async () => {
  const { controlRoot, evidenceRoot, control } = await setup();
  const malformed = snapshot(control.generation);
  malformed.datasets[2] = { ...competitionDataset(), source_authority: "has spaces" };
  await assert.rejects(
    publishAuthorizedProviderSnapshot({ controlRoot, evidenceRoot, siteId: SITE_ID, snapshot: malformed }),
    /source_authority has invalid format/,
  );

  const { controlRoot: controlRoot2, evidenceRoot: evidenceRoot2, control: control2 } = await setup();
  const badHash = snapshot(control2.generation);
  badHash.datasets[2] = { ...competitionDataset(), source_capture_sha256: "sha256:bad" };
  await assert.rejects(
    publishAuthorizedProviderSnapshot({ controlRoot: controlRoot2, evidenceRoot: evidenceRoot2, siteId: SITE_ID, snapshot: badHash }),
    /invalid competition source_capture_sha256/,
  );
});

test("tenant competition context consumes revalidated evidence and binds provenance plus manifest", async () => {
  const { controlRoot, evidenceRoot, control } = await setup();
  await publishAuthorizedProviderSnapshot({ controlRoot, evidenceRoot, siteId: SITE_ID, snapshot: snapshot(control.generation) });
  const evidence = await readTenantEvidenceSnapshot({ controlRoot, evidenceRoot, siteId: SITE_ID });
  const result = await buildTenantRankContextWithCompetition({
    controlRoot,
    evidenceRoot,
    siteId: SITE_ID,
    feasibilityAssumptionProfile: feasibilityProfile,
    trendAssumptionProfile: trendProfile,
    competitionAssumptionProfile: competitionProfile,
  });
  assert.equal(result.status, "READY");
  assert.equal(result.reason, "RANK_COMPETITION_READY");
  assert.equal(result.evidenceManifestHash, evidence.manifestHash);
  assert.equal(result.competitionProvenance.sourceCaptureSha256, SOURCE_CAPTURE_SHA256);
  assert.equal(result.competitionProvenance.normalizedRecordsSha256, canonicalProviderRecordsSha256(competitionRows()));
  assert.equal(result.report.summary.matchedCompetitionOpportunityCount, 3);
});

test("rewritten competition provenance is blocked even when evidence manifest hashes are updated", async () => {
  const { controlRoot, evidenceRoot, control } = await setup();
  await publishAuthorizedProviderSnapshot({ controlRoot, evidenceRoot, siteId: SITE_ID, snapshot: snapshot(control.generation) });
  const tenantRoot = join(evidenceRoot, "tenants", SITE_ID);
  const upstreamPath = join(tenantRoot, "upstream_evidence.json");
  const manifestPath = join(tenantRoot, "manifest.json");
  const upstream = JSON.parse(await readFile(upstreamPath, "utf8"));
  upstream.find((row) => row.dataset_key === "keyword_coverage_records").provider = "NEXUS_SITE_SNAPSHOT";
  const upstreamBytes = Buffer.from(`${JSON.stringify(upstream)}\n`, "utf8");
  await writeFile(upstreamPath, upstreamBytes);
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  manifest.datasets.find((row) => row.key === "upstream_evidence").sha256 = `sha256:${createHash("sha256").update(upstreamBytes).digest("hex")}`;
  await writeFile(manifestPath, `${JSON.stringify(manifest)}\n`);

  const evidence = await readTenantEvidenceSnapshot({ controlRoot, evidenceRoot, siteId: SITE_ID });
  assert.equal(evidence.status, "READY");
  const result = await buildTenantRankContextWithCompetition({
    controlRoot,
    evidenceRoot,
    siteId: SITE_ID,
    feasibilityAssumptionProfile: feasibilityProfile,
    trendAssumptionProfile: trendProfile,
    competitionAssumptionProfile: competitionProfile,
  });
  assert.equal(result.status, "BLOCKED");
  assert.equal(result.reason, "COMPETITION_PROVENANCE_INVALID_OR_MISSING");
  assert.equal(result.report, null);
});

test("disabled tenant cannot receive competition rank context", async () => {
  const { controlRoot, evidenceRoot, control } = await setup();
  await publishAuthorizedProviderSnapshot({ controlRoot, evidenceRoot, siteId: SITE_ID, snapshot: snapshot(control.generation) });
  await setTenantEnabled({ controlRoot, siteId: SITE_ID, enabled: false, expectedGeneration: control.generation });
  const result = await buildTenantRankContextWithCompetition({
    controlRoot,
    evidenceRoot,
    siteId: SITE_ID,
    feasibilityAssumptionProfile: feasibilityProfile,
    trendAssumptionProfile: trendProfile,
    competitionAssumptionProfile: competitionProfile,
  });
  assert.equal(result.status, "OFF");
  assert.equal(result.report, null);
});

test("missing competition dataset remains explicit insufficient data", async () => {
  const { controlRoot, evidenceRoot, control } = await setup();
  await publishAuthorizedProviderSnapshot({
    controlRoot,
    evidenceRoot,
    siteId: SITE_ID,
    snapshot: snapshot(control.generation, { includeCompetition: false }),
  });
  const result = await buildTenantRankContextWithCompetition({
    controlRoot,
    evidenceRoot,
    siteId: SITE_ID,
    feasibilityAssumptionProfile: feasibilityProfile,
    trendAssumptionProfile: trendProfile,
    competitionAssumptionProfile: competitionProfile,
  });
  assert.equal(result.status, "INSUFFICIENT_DATA");
  assert.match(result.reason, /keyword_coverage_records/);
  assert.equal(result.report, null);
});

test("operational competition layer has no network, provider client, process escape, or control mutation authority", async () => {
  const sources = await Promise.all([
    readFile(new URL("../rank-feasibility/competition-engine.mjs", import.meta.url), "utf8"),
    readFile(new URL("../rank-feasibility/tenant-competition.mjs", import.meta.url), "utf8"),
  ]);
  const source = sources.join("\n");
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
    /child_process/,
    /setTenantEnabled/,
    /setTenantKillSwitch/,
    /appendTenantControl/,
  ]) {
    assert.doesNotMatch(source, forbidden);
  }
  assert.match(source, /readTenantEvidenceSnapshot/);
  assert.match(source, /readTenantControl/);
});

test("competition output explicitly refuses probability, authority, traffic and causal claims", () => {
  const report = buildRankCompetitionReport({ keywordCoverageRecords: competitionRows(), competitionAssumptionProfile: competitionProfile });
  assert.ok(report.warnings.includes("NO_PROBABILITY_CLAIM"));
  assert.ok(report.warnings.includes("COMPETITOR_COUNT_IS_NOT_DOMAIN_AUTHORITY"));
  assert.ok(report.warnings.includes("SEARCH_VOLUME_IS_NOT_TRAFFIC_FORECAST"));
  assert.ok(report.warnings.includes("NO_CAUSAL_SEO_LIFT_CLAIM"));
});
