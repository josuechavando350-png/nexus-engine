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
import { buildRankFeasibilityReport } from "../rank-feasibility/feasibility-engine.mjs";
import { buildTenantRankFeasibility } from "../rank-feasibility/tenant-feasibility.mjs";

const SITE_ID = "walle-rank-feasibility-probe";

function profile() {
  return {
    schema_version: 1,
    profile_id: "rank-distance-policy-v1",
    provenance: "operator supplied rule bands; not a Google probability model",
    minimum_impressions: 100,
    high_gap_milli: 5_000,
    medium_gap_milli: 15_000,
  };
}

function searchRows() {
  return [
    {
      query: "defensa penal urgente",
      page_url: "https://example.test/defensa-penal",
      clicks: 100,
      impressions: 1_000,
      average_position_milli: 12_000,
    },
    {
      query: "abogado penalista",
      page_url: "https://example.test/abogado-penalista",
      clicks: 80,
      impressions: 500,
      average_position_milli: 2_000,
    },
    {
      query: "consulta penal especializada",
      page_url: "https://example.test/consulta",
      clicks: 1,
      impressions: 20,
      average_position_milli: 25_000,
    },
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

async function setupEvidence() {
  const root = await mkdtemp(join(tmpdir(), "walle-rank-feasibility-"));
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
    snapshot: {
      schema_version: 1,
      site_id: SITE_ID,
      control_generation: control.generation,
      capture_id: "rank-feasibility-capture-001",
      observed_at_unix_ms: 1_800_000_000_000,
      datasets: [dataset("GOOGLE_SEARCH_CONSOLE", "search_performance_records", searchRows())],
    },
  });
  return { controlRoot, evidenceRoot, control };
}

test("rank feasibility evaluates Top 10, Top 3 and Top 1 with explicit rule bands", () => {
  const report = buildRankFeasibilityReport({ searchPerformanceRecords: searchRows(), assumptionProfile: profile() });
  assert.equal(report.engineId, "WALLE_RANK_FEASIBILITY_V1");
  assert.equal(report.status, "FEASIBILITY_READY");
  assert.equal(report.interpretation, "RULE_BOUND_SEARCH_EVIDENCE_NOT_PROBABILITY");

  const opportunity = report.opportunities.find((item) => item.query === "defensa penal urgente");
  assert.equal(opportunity.observed.ctrPpm, 100_000);
  assert.equal(opportunity.observed.averagePositionMilli, 12_000);
  assert.deepEqual(
    opportunity.targets.map((target) => [target.rankTarget, target.gapMilli, target.feasibilityBand]),
    [
      ["TOP_10", 2_000, "HIGH"],
      ["TOP_3", 9_000, "MEDIUM"],
      ["TOP_1", 11_000, "MEDIUM"],
    ],
  );
});

test("already-observed rank targets are ACHIEVED and harder targets cannot outrank easier ones", () => {
  const report = buildRankFeasibilityReport({ searchPerformanceRecords: searchRows(), assumptionProfile: profile() });
  const opportunity = report.opportunities.find((item) => item.query === "abogado penalista");
  assert.deepEqual(
    opportunity.targets.map((target) => [target.rankTarget, target.feasibilityBand]),
    [
      ["TOP_10", "ACHIEVED"],
      ["TOP_3", "ACHIEVED"],
      ["TOP_1", "HIGH"],
    ],
  );
});

test("insufficient impressions remain explicit instead of receiving a fabricated feasibility band", () => {
  const report = buildRankFeasibilityReport({ searchPerformanceRecords: searchRows(), assumptionProfile: profile() });
  const opportunity = report.opportunities.find((item) => item.query === "consulta penal especializada");
  assert.ok(opportunity.targets.every((target) => target.feasibilityBand === "INSUFFICIENT_DATA"));
  assert.ok(opportunity.targets.every((target) => target.evidenceStatus === "INSUFFICIENT_IMPRESSIONS"));
  assert.equal(report.summary.insufficientOpportunityCount, 1);
});

test("duplicate query/page observations aggregate deterministically with impression-weighted position", () => {
  const rows = [
    {
      query: "cluster a",
      page_url: "https://example.test/a",
      clicks: 10,
      impressions: 100,
      average_position_milli: 10_000,
    },
    {
      query: "cluster a",
      page_url: "https://example.test/a",
      clicks: 30,
      impressions: 300,
      average_position_milli: 20_000,
    },
  ];
  const report = buildRankFeasibilityReport({ searchPerformanceRecords: rows, assumptionProfile: profile() });
  assert.equal(report.opportunities.length, 1);
  assert.deepEqual(report.opportunities[0].observed, {
    clicks: 40,
    impressions: 400,
    ctrPpm: 100_000,
    averagePositionMilli: 17_500,
    sourceRowCount: 2,
  });
});

test("input ordering does not change report bytes or report hash", () => {
  const rows = searchRows();
  const first = buildRankFeasibilityReport({ searchPerformanceRecords: rows, assumptionProfile: profile() });
  const second = buildRankFeasibilityReport({ searchPerformanceRecords: [...rows].reverse(), assumptionProfile: profile() });
  assert.equal(JSON.stringify(first), JSON.stringify(second));
  assert.equal(first.reportSha256, second.reportSha256);
  assert.match(first.reportSha256, /^sha256:[0-9a-f]{64}$/);
});

test("assumption changes are hash-bound and alter the feasibility result", () => {
  const first = buildRankFeasibilityReport({ searchPerformanceRecords: searchRows(), assumptionProfile: profile() });
  const changed = profile();
  changed.high_gap_milli = 1_000;
  const second = buildRankFeasibilityReport({ searchPerformanceRecords: searchRows(), assumptionProfile: changed });
  assert.notEqual(first.assumptionProfile.sha256, second.assumptionProfile.sha256);
  const firstTop10 = first.opportunities.find((item) => item.query === "defensa penal urgente").targets[0];
  const secondTop10 = second.opportunities.find((item) => item.query === "defensa penal urgente").targets[0];
  assert.equal(firstTop10.feasibilityBand, "HIGH");
  assert.equal(secondTop10.feasibilityBand, "MEDIUM");
});

test("floating point and malformed search evidence fail closed", () => {
  const floating = searchRows();
  floating[0].average_position_milli = 12_000.5;
  assert.throws(
    () => buildRankFeasibilityReport({ searchPerformanceRecords: floating, assumptionProfile: profile() }),
    /integer in range/,
  );

  const impossible = searchRows();
  impossible[0].clicks = impossible[0].impressions + 1;
  assert.throws(
    () => buildRankFeasibilityReport({ searchPerformanceRecords: impossible, assumptionProfile: profile() }),
    /clicks exceed impressions/,
  );
});

test("rule profile refuses inverted distance bands", () => {
  const invalid = profile();
  invalid.medium_gap_milli = invalid.high_gap_milli - 1;
  assert.throws(
    () => buildRankFeasibilityReport({ searchPerformanceRecords: searchRows(), assumptionProfile: invalid }),
    /medium_gap_milli must be greater than or equal/,
  );
});

test("successful output explicitly refuses rank probability and guarantee claims", () => {
  const report = buildRankFeasibilityReport({ searchPerformanceRecords: searchRows(), assumptionProfile: profile() });
  assert.ok(report.warnings.includes("NO_RANK_GUARANTEE"));
  assert.ok(report.warnings.includes("NO_PROBABILITY_CLAIM"));
  assert.ok(report.warnings.includes("NO_COMPETITOR_EVIDENCE_IN_V1"));
  assert.ok(report.warnings.includes("NO_LONGITUDINAL_TREND_EVIDENCE_IN_V1"));
  assert.ok(report.warnings.includes("NO_AUTHORITY_MODEL_IN_V1"));
  assert.doesNotMatch(JSON.stringify(report), /probabilityPpm|probabilityPercent|chancePercent/);
});

test("tenant rank feasibility consumes authorized revalidated evidence and binds the manifest", async () => {
  const { controlRoot, evidenceRoot } = await setupEvidence();
  const result = await buildTenantRankFeasibility({
    controlRoot,
    evidenceRoot,
    siteId: SITE_ID,
    assumptionProfile: profile(),
  });
  assert.equal(result.status, "READY");
  assert.equal(result.reason, "RANK_FEASIBILITY_READY");
  assert.match(result.evidenceManifestHash, /^sha256:[0-9a-f]{64}$/);
  assert.equal(result.report.engineId, "WALLE_RANK_FEASIBILITY_V1");
  assert.equal(result.report.summary.opportunityCount, 3);
});

test("disabled tenant cannot receive rank feasibility even when prior evidence exists", async () => {
  const { controlRoot, evidenceRoot, control } = await setupEvidence();
  await setTenantEnabled({ controlRoot, siteId: SITE_ID, enabled: false, expectedGeneration: control.generation });
  const result = await buildTenantRankFeasibility({
    controlRoot,
    evidenceRoot,
    siteId: SITE_ID,
    assumptionProfile: profile(),
  });
  assert.equal(result.status, "OFF");
  assert.equal(result.report, null);
});

test("operational rank feasibility has no network, provider-client, or control-mutation authority", async () => {
  const source = await readFile(new URL("../rank-feasibility/tenant-feasibility.mjs", import.meta.url), "utf8");
  assert.doesNotMatch(source, /node:http|node:https|node:net|node:dgram|node:tls/);
  assert.doesNotMatch(source, /\bfetch\s*\(|axios|googleapis|OAuth2|refresh_token|access_token/);
  assert.doesNotMatch(source, /setTenantEnabled|setTenantKillSwitch|appendTenantControl/);
  assert.match(source, /readTenantEvidenceSnapshot/);
  assert.match(source, /readTenantControl/);
});
