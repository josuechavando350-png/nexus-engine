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
import { buildTenantRankContextWithAuthority } from "../rank-feasibility/tenant-authority.mjs";

const SITE_ID = "walle-rank-authority-probe";
const AUTHORITY_NON_CLAIM = "INTERNAL_TOPICAL_AUTHORITY_DIAGNOSTIC_NOT_SEARCH_ENGINE_RANKING_EVIDENCE";
const COMPETITION_CAPTURE_SHA256 = `sha256:${createHash("sha256").update("synthetic licensed competition export").digest("hex")}`;
const AUTHORITY_CAPTURE_SHA256 = `sha256:${createHash("sha256").update("synthetic nexus topical authority assessment").digest("hex")}`;

const feasibilityProfile = Object.freeze({
  schema_version: 1,
  profile_id: "rank-authority-feasibility-test",
  provenance: "synthetic mechanical thresholds; not Google constants",
  minimum_impressions: 100,
  high_gap_milli: 5_000,
  medium_gap_milli: 10_000,
});

const trendProfile = Object.freeze({
  schema_version: 1,
  profile_id: "rank-authority-trend-test",
  provenance: "synthetic mechanical thresholds; not Google constants",
  minimum_windows: 2,
  minimum_endpoint_impressions: 100,
  improving_delta_milli: 1_000,
  declining_delta_milli: 1_000,
});

const competitionProfile = Object.freeze({
  schema_version: 1,
  profile_id: "rank-authority-competition-test",
  provenance: "synthetic competition thresholds; not Google constants",
  minimum_search_volume: 50,
  low_competitor_count_max: 2,
  medium_competitor_count_max: 5,
});

const authorityProfile = Object.freeze({
  schema_version: 1,
  profile_id: "rank-authority-internal-test",
  provenance: "synthetic NEXUS internal authority thresholds; not Google constants",
  minimum_topics: 2,
  weak_authority_ppm_max: 300_000,
  moderate_authority_ppm_max: 700_000,
});

function currentRows() {
  return [
    { query: "alpha legal", page_url: "/alpha", clicks: 30, impressions: 500, average_position_milli: 8_000 },
    { query: "beta legal", page_url: "/beta", clicks: 25, impressions: 400, average_position_milli: 5_200 },
  ];
}

function historyRows() {
  return [
    { query: "alpha legal", page_url: "/alpha", clicks: 12, impressions: 300, average_position_milli: 12_000, window_start_unix_ms: 1_000_000, window_end_unix_ms: 2_000_000 },
    { query: "alpha legal", page_url: "/alpha", clicks: 30, impressions: 500, average_position_milli: 8_000, window_start_unix_ms: 2_000_000, window_end_unix_ms: 3_000_000 },
    { query: "beta legal", page_url: "/beta", clicks: 20, impressions: 350, average_position_milli: 5_000, window_start_unix_ms: 1_000_000, window_end_unix_ms: 2_000_000 },
    { query: "beta legal", page_url: "/beta", clicks: 25, impressions: 400, average_position_milli: 5_200, window_start_unix_ms: 2_000_000, window_end_unix_ms: 3_000_000 },
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

async function setup() {
  const root = await mkdtemp(join(tmpdir(), "walle-rank-authority-"));
  const controlRoot = join(root, "control");
  const evidenceRoot = join(root, "evidence");
  await mkdir(controlRoot, { mode: 0o700 });
  await mkdir(evidenceRoot, { mode: 0o700 });
  await mkdir(join(evidenceRoot, "tenants"), { mode: 0o700 });
  const control = await setTenantEnabled({ controlRoot, siteId: SITE_ID, enabled: true, expectedGeneration: 0 });
  return { root, controlRoot, evidenceRoot, control };
}

function snapshot(generation, { includeAuthority = true, authorityRecords = authorityRows() } = {}) {
  const datasets = [
    normalDataset("GOOGLE_SEARCH_CONSOLE", "search_performance_records", currentRows()),
    normalDataset("GOOGLE_SEARCH_CONSOLE", "search_performance_history_records", historyRows()),
    competitionDataset(),
  ];
  if (includeAuthority) datasets.push(authorityDataset(authorityRecords));
  return {
    schema_version: 1,
    site_id: SITE_ID,
    control_generation: generation,
    capture_id: "rank-authority-capture-001",
    observed_at_unix_ms: 4_000_000,
    datasets,
  };
}

function rankCompetitionReport() {
  return buildRankFeasibilityTrendCompetitionReport({
    searchPerformanceRecords: currentRows(),
    searchPerformanceHistoryRecords: historyRows(),
    keywordCoverageRecords: competitionRows(),
    feasibilityAssumptionProfile: feasibilityProfile,
    trendAssumptionProfile: trendProfile,
    competitionAssumptionProfile: competitionProfile,
  });
}

test("authority engine classifies internal topical strength from explicit hash-bound thresholds", () => {
  const report = buildTopicalAuthorityEvidenceReport({
    topicalAuthorityRecords: authorityRows(),
    authorityAssumptionProfile: authorityProfile,
  });
  assert.equal(report.status, "AUTHORITY_READY");
  assert.equal(report.interpretation, "INTERNAL_TOPICAL_AUTHORITY_CONTEXT_NOT_SEARCH_ENGINE_RANKING_EVIDENCE");
  assert.equal(report.summary.authorityStrength, "MODERATE");
  assert.equal(report.topics.find((row) => row.topicId === "criminal defense").strength, "WEAK");
  assert.equal(report.topics.find((row) => row.topicId === "legal strategy").strength, "MODERATE");
  assert.equal(report.topics.find((row) => row.topicId === "urgent defense").strength, "STRONG");
  assert.equal(report.summary.componentAverages.authorityPpm, 533_333);
});

test("authority evidence ordering and equivalent topic spelling are byte-deterministic", () => {
  const rows = authorityRows();
  rows.push({ ...rows[0], topic_id: "  CRIMINAL   DEFENSE " });
  const forward = buildTopicalAuthorityEvidenceReport({ topicalAuthorityRecords: rows, authorityAssumptionProfile: authorityProfile });
  const reverse = buildTopicalAuthorityEvidenceReport({ topicalAuthorityRecords: [...rows].reverse(), authorityAssumptionProfile: authorityProfile });
  assert.equal(JSON.stringify(forward), JSON.stringify(reverse));
  assert.equal(forward.reportSha256, reverse.reportSha256);
});

test("conflicting normalized topical authority duplicates fail closed", () => {
  const rows = authorityRows();
  rows.push({ ...rows[0], topic_id: "criminal defense", authority_ppm: 800_000 });
  assert.throws(
    () => buildTopicalAuthorityEvidenceReport({ topicalAuthorityRecords: rows, authorityAssumptionProfile: authorityProfile }),
    /conflicting duplicate topical authority/,
  );
});

test("floating point, malformed, and source non-claim drift are rejected", () => {
  const floating = authorityRows().map((row) => ({ ...row }));
  floating[0].authority_ppm = 200_000.5;
  assert.throws(
    () => buildTopicalAuthorityEvidenceReport({ topicalAuthorityRecords: floating, authorityAssumptionProfile: authorityProfile }),
    /integer in range/,
  );
  const extra = authorityRows().map((row) => ({ ...row }));
  extra[0].domain_authority = 99;
  assert.throws(
    () => buildTopicalAuthorityEvidenceReport({ topicalAuthorityRecords: extra, authorityAssumptionProfile: authorityProfile }),
    /unexpected topical authority row 0 keys/,
  );
  const drift = authorityRows().map((row) => ({ ...row }));
  drift[0].source_non_claim = "GOOGLE_AUTHORITY";
  assert.throws(
    () => buildTopicalAuthorityEvidenceReport({ topicalAuthorityRecords: drift, authorityAssumptionProfile: authorityProfile }),
    /must preserve source non-claim/,
  );
});

test("authority profile changes are hash-bound and inverted bands are rejected", () => {
  const first = buildTopicalAuthorityEvidenceReport({ topicalAuthorityRecords: authorityRows(), authorityAssumptionProfile: authorityProfile });
  const changed = buildTopicalAuthorityEvidenceReport({
    topicalAuthorityRecords: authorityRows(),
    authorityAssumptionProfile: { ...authorityProfile, moderate_authority_ppm_max: 750_000 },
  });
  assert.notEqual(first.authorityAssumptionProfile.sha256, changed.authorityAssumptionProfile.sha256);
  assert.notEqual(first.reportSha256, changed.reportSha256);
  assert.throws(
    () => buildTopicalAuthorityEvidenceReport({
      topicalAuthorityRecords: authorityRows(),
      authorityAssumptionProfile: { ...authorityProfile, weak_authority_ppm_max: 800_000, moderate_authority_ppm_max: 700_000 },
    }),
    /must be greater than or equal/,
  );
});

test("blocked upstream topical authority assessment cannot be promoted", () => {
  const rows = authorityRows().map((row) => ({ ...row, assessment_status: "BLOCKED" }));
  assert.throws(
    () => buildTopicalAuthorityEvidenceReport({ topicalAuthorityRecords: rows, authorityAssumptionProfile: authorityProfile }),
    /upstream topical authority assessment is BLOCKED/,
  );
});

test("authority context preserves feasibility momentum and competition without query-topic inference", () => {
  const rank = rankCompetitionReport();
  const authority = buildTopicalAuthorityEvidenceReport({ topicalAuthorityRecords: authorityRows(), authorityAssumptionProfile: authorityProfile });
  const combined = attachAuthorityContext({ rankCompetitionReport: rank, authorityReport: authority });
  assert.equal(combined.decisionBoundary, "AUTHORITY_CONTEXT_ONLY_DOES_NOT_UPGRADE_OR_DOWNGRADE_FEASIBILITY_BAND");
  assert.deepEqual(combined.opportunities, rank.opportunities);
  assert.equal(combined.authority.authorityStrength, "MODERATE");
  assert.ok(combined.warnings.includes("TOPIC_TO_QUERY_MAPPING_NOT_ESTABLISHED"));
  assert.ok(combined.opportunities.every((opportunity) => !("authority" in opportunity)));
});

test("too few authority topics remains explicit insufficient data", () => {
  const report = buildTopicalAuthorityEvidenceReport({
    topicalAuthorityRecords: [authorityRows()[0]],
    authorityAssumptionProfile: authorityProfile,
  });
  assert.equal(report.status, "INSUFFICIENT_DATA");
  assert.equal(report.summary.authorityStrength, "INSUFFICIENT_DATA");
});

test("authorized publisher persists authority source provenance and exact normalized records hash", async () => {
  const { controlRoot, evidenceRoot, control } = await setup();
  const published = await publishAuthorizedProviderSnapshot({ controlRoot, evidenceRoot, siteId: SITE_ID, snapshot: snapshot(control.generation) });
  assert.equal(published.status, "PUBLISHED");
  const evidence = await readTenantEvidenceSnapshot({ controlRoot, evidenceRoot, siteId: SITE_ID });
  assert.equal(evidence.status, "READY");
  const provenance = evidence.datasets.upstream_evidence.find((row) => row.dataset_key === "topical_authority_records");
  assert.equal(provenance.provider, "NEXUS_AUTHORITY_SNAPSHOT");
  assert.equal(provenance.source_authority, "NEXUS_TOPICAL_AUTHORITY_GRAPH:V1");
  assert.equal(provenance.source_capture_sha256, AUTHORITY_CAPTURE_SHA256);
  assert.equal(provenance.records_sha256, canonicalProviderRecordsSha256(authorityRows()));
});

test("authority dataset rejects wrong provider missing provenance and invalid PPM", async () => {
  const { controlRoot, evidenceRoot, control } = await setup();
  const wrongProvider = snapshot(control.generation);
  wrongProvider.datasets[3] = normalDataset("NEXUS_SITE_SNAPSHOT", "topical_authority_records", authorityRows());
  await assert.rejects(
    publishAuthorizedProviderSnapshot({ controlRoot, evidenceRoot, siteId: SITE_ID, snapshot: wrongProvider }),
    /provider is not authorized for dataset key/,
  );

  const second = await setup();
  const missingProvenance = snapshot(second.control.generation);
  missingProvenance.datasets[3] = normalDataset("NEXUS_AUTHORITY_SNAPSHOT", "topical_authority_records", authorityRows());
  await assert.rejects(
    publishAuthorizedProviderSnapshot({ controlRoot: second.controlRoot, evidenceRoot: second.evidenceRoot, siteId: SITE_ID, snapshot: missingProvenance }),
    /unexpected provider dataset keys/,
  );

  const third = await setup();
  const badRows = authorityRows().map((row) => ({ ...row }));
  badRows[0].centrality_ppm = 1_000_001;
  const invalidPpm = snapshot(third.control.generation, { authorityRecords: badRows });
  await assert.rejects(
    publishAuthorizedProviderSnapshot({ controlRoot: third.controlRoot, evidenceRoot: third.evidenceRoot, siteId: SITE_ID, snapshot: invalidPpm }),
    /authority centrality ppm 0 must be an integer in range/,
  );
});

test("tenant authority context consumes revalidated evidence and binds both provenance and manifest", async () => {
  const { controlRoot, evidenceRoot, control } = await setup();
  await publishAuthorizedProviderSnapshot({ controlRoot, evidenceRoot, siteId: SITE_ID, snapshot: snapshot(control.generation) });
  const result = await buildTenantRankContextWithAuthority({
    controlRoot,
    evidenceRoot,
    siteId: SITE_ID,
    feasibilityAssumptionProfile: feasibilityProfile,
    trendAssumptionProfile: trendProfile,
    competitionAssumptionProfile: competitionProfile,
    authorityAssumptionProfile: authorityProfile,
  });
  assert.equal(result.status, "READY");
  assert.equal(result.reason, "RANK_AUTHORITY_CONTEXT_READY");
  assert.match(result.evidenceManifestHash, /^sha256:[0-9a-f]{64}$/);
  assert.equal(result.authorityProvenance.provider, "NEXUS_AUTHORITY_SNAPSHOT");
  assert.equal(result.authorityProvenance.sourceCaptureSha256, AUTHORITY_CAPTURE_SHA256);
  assert.equal(result.report.authority.authorityStrength, "MODERATE");
  assert.equal(result.report.decisionBoundary, "AUTHORITY_CONTEXT_ONLY_DOES_NOT_UPGRADE_OR_DOWNGRADE_FEASIBILITY_BAND");
});

test("disabled tenant cannot receive authority rank context", async () => {
  const { controlRoot, evidenceRoot, control } = await setup();
  await publishAuthorizedProviderSnapshot({ controlRoot, evidenceRoot, siteId: SITE_ID, snapshot: snapshot(control.generation) });
  await setTenantEnabled({ controlRoot, siteId: SITE_ID, enabled: false, expectedGeneration: control.generation });
  const result = await buildTenantRankContextWithAuthority({
    controlRoot,
    evidenceRoot,
    siteId: SITE_ID,
    feasibilityAssumptionProfile: feasibilityProfile,
    trendAssumptionProfile: trendProfile,
    competitionAssumptionProfile: competitionProfile,
    authorityAssumptionProfile: authorityProfile,
  });
  assert.equal(result.status, "OFF");
  assert.equal(result.report, null);
});

test("missing and empty authority evidence stay explicit insufficient data", async () => {
  const missing = await setup();
  await publishAuthorizedProviderSnapshot({
    controlRoot: missing.controlRoot,
    evidenceRoot: missing.evidenceRoot,
    siteId: SITE_ID,
    snapshot: snapshot(missing.control.generation, { includeAuthority: false }),
  });
  const missingResult = await buildTenantRankContextWithAuthority({
    controlRoot: missing.controlRoot,
    evidenceRoot: missing.evidenceRoot,
    siteId: SITE_ID,
    feasibilityAssumptionProfile: feasibilityProfile,
    trendAssumptionProfile: trendProfile,
    competitionAssumptionProfile: competitionProfile,
    authorityAssumptionProfile: authorityProfile,
  });
  assert.equal(missingResult.status, "INSUFFICIENT_DATA");
  assert.equal(missingResult.reason, "REQUIRED_DATASETS_MISSING:topical_authority_records");

  const empty = await setup();
  await publishAuthorizedProviderSnapshot({
    controlRoot: empty.controlRoot,
    evidenceRoot: empty.evidenceRoot,
    siteId: SITE_ID,
    snapshot: snapshot(empty.control.generation, { authorityRecords: [] }),
  });
  const emptyResult = await buildTenantRankContextWithAuthority({
    controlRoot: empty.controlRoot,
    evidenceRoot: empty.evidenceRoot,
    siteId: SITE_ID,
    feasibilityAssumptionProfile: feasibilityProfile,
    trendAssumptionProfile: trendProfile,
    competitionAssumptionProfile: competitionProfile,
    authorityAssumptionProfile: authorityProfile,
  });
  assert.equal(emptyResult.status, "INSUFFICIENT_DATA");
  assert.equal(emptyResult.reason, "REQUIRED_DATASETS_EMPTY:topical_authority_records");
});

test("authority operational layer has no network provider process or control mutation authority", async () => {
  const engineSource = await readFile(new URL("../rank-feasibility/authority-engine.mjs", import.meta.url), "utf8");
  const tenantSource = await readFile(new URL("../rank-feasibility/tenant-authority.mjs", import.meta.url), "utf8");
  const joined = `${engineSource}\n${tenantSource}`;
  for (const forbidden of [
    "node:http", "node:https", "node:net", "node:dgram", "node:tls", "axios", "googleapis", "OAuth2",
    "child_process", "setTenantEnabled", "setTenantKillSwitch", "appendTenantControl",
  ]) {
    assert.equal(joined.includes(forbidden), false, `forbidden authority surface:${forbidden}`);
  }
  assert.match(tenantSource, /readTenantEvidenceSnapshot/);
  assert.match(tenantSource, /readTenantControl/);
});

test("authority output explicitly refuses Google authority ranking probability and backlink claims", () => {
  const report = buildTopicalAuthorityEvidenceReport({ topicalAuthorityRecords: authorityRows(), authorityAssumptionProfile: authorityProfile });
  for (const warning of [
    "NO_RANK_GUARANTEE",
    "NO_PROBABILITY_CLAIM",
    "INTERNAL_AUTHORITY_IS_NOT_GOOGLE_AUTHORITY",
    "NOT_DOMAIN_AUTHORITY",
    "NO_BACKLINK_AUTHORITY_CLAIM",
    "NO_EXTERNAL_LINK_EQUITY_CLAIM",
  ]) {
    assert.ok(report.warnings.includes(warning));
  }
  assert.equal(report.sourceNonClaim, AUTHORITY_NON_CLAIM);
});
