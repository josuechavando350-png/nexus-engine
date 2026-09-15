import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { runCommercialDemandTournamentV4 } from "../commercial-demand/tournament-engine-v4.mjs";
import { buildCommercialDemandScenarioV4 } from "../commercial-demand/tournament-v4-scenario.mjs";

const BASE_URL = new URL("../commercial-demand/nexus-commercial-demand-v2.json", import.meta.url);
const V3_EVIDENCE_URL = new URL("../commercial-demand/service-intent-evidence-v3.json", import.meta.url);
const V4_EVIDENCE_URL = new URL("../commercial-demand/software-intent-evidence-v4.json", import.meta.url);
const [baseSource, v3EvidenceSource, v4EvidenceSource] = await Promise.all([
  readFile(BASE_URL, "utf8").then(JSON.parse),
  readFile(V3_EVIDENCE_URL, "utf8").then(JSON.parse),
  readFile(V4_EVIDENCE_URL, "utf8").then(JSON.parse),
]);

function baseScenario() {
  return structuredClone(baseSource);
}

function v3Evidence() {
  return structuredClone(v3EvidenceSource);
}

function v4Evidence() {
  return structuredClone(v4EvidenceSource);
}

function run() {
  return runCommercialDemandTournamentV4(baseScenario(), v3Evidence(), v4Evidence());
}

test("V4 report is deterministic and hash-bound to the certified V3 chain plus V4 evidence", () => {
  const first = run();
  const second = run();
  assert.equal(JSON.stringify(first), JSON.stringify(second));
  assert.match(first.v3BaselineProof.reportSha256, /^sha256:[0-9a-f]{64}$/);
  assert.match(first.scenarioSha256, /^sha256:[0-9a-f]{64}$/);
  assert.match(first.evidenceSha256, /^sha256:[0-9a-f]{64}$/);
  assert.match(first.reportSha256, /^sha256:[0-9a-f]{64}$/);
  assert.equal(first.v3BaselineProof.selectedStrategyId, "SERVICE_FRONTIER_FULL_VALIDATED_32");
});

test("15 clients remains a planning floor and V4 never converts it into a forecast", () => {
  const report = run();
  assert.equal(report.objective.minimumPlanningFloorClientsMilli, 15_000);
  assert.equal(report.objective.interpretation, "MINIMUM_PLANNING_FLOOR_NOT_FORECAST_OR_GUARANTEE");
  assert.ok(report.warnings.includes("NO_LEAD_OR_CLIENT_GUARANTEE"));
  assert.equal(report.softwareBuyerEvidence.analyticsBoundary.ga4ConversionEvidence, "NOT_AVAILABLE_FROM_CONNECTED_PROPERTY");
  assert.equal(report.targetSupportVerdict, "EXPAND_VALIDATED_DEMAND_AND_OR_CHANNELS_BEFORE_FLOOR_CLAIM");
});

test("software buyer frontier selects 36 pages because four new evidence-backed families add distinct relevant demand", () => {
  const report = run();
  assert.equal(report.selectedStrategyId, "SOFTWARE_BUYER_FRONTIER_FULL_VALIDATED_36");
  const winner = report.demandTournament.tournament.selectedStrategy;
  assert.equal(winner.pageCount, 36);
  assert.equal(winner.coveredDemandFamilyCount, 35);
  assert.equal(winner.relevantSessionsMilli, 773_550);
  assert.equal(winner.strictCommercialSessionsMilli, 413_100);
  assert.equal(winner.worstCaseModeledClientsMilli, 1_015);
});

test("40-page bloat control loses when four extra pages add no unique demand family", () => {
  const report = run();
  const rows = Object.fromEntries(report.demandTournament.tournament.evaluatedStrategies.map((row) => [row.id, row]));
  const full = rows.SOFTWARE_BUYER_FRONTIER_FULL_VALIDATED_36;
  const bloat = rows.SOFTWARE_BUYER_BLOAT_CONTROL_40;
  assert.equal(full.pageCount, 36);
  assert.equal(bloat.pageCount, 40);
  assert.equal(bloat.relevantSessionsMilli, full.relevantSessionsMilli);
  assert.equal(bloat.strictCommercialSessionsMilli, full.strictCommercialSessionsMilli);
  assert.equal(bloat.coveredDemandFamilyCount, full.coveredDemandFamilyCount);
  assert.deepEqual(report.demandTournament.tournament.eligibleLeaderboardStrategyIds.slice(0, 2), [
    "SOFTWARE_BUYER_FRONTIER_FULL_VALIDATED_36",
    "SOFTWARE_BUYER_BLOAT_CONTROL_40",
  ]);
});

test("5,400 generic software-development searches stay informational and cannot inflate commercial capacity", () => {
  const report = run();
  assert.equal(report.demandTournament.research.semanticDemandFamilyCount, 39);
  assert.equal(report.demandTournament.research.byIntent.DIRECT.rawSearchVolume, 3_050);
  assert.equal(report.demandTournament.research.byIntent.DECISION.rawSearchVolume, 620);
  assert.equal(report.demandTournament.research.byIntent.MIXED.rawSearchVolume, 8_010);
  assert.equal(report.demandTournament.research.byIntent.INFORMATIONAL.rawSearchVolume, 17_830);
  assert.equal(report.growthFrontier.validatedRelevantRawSearchVolume, 11_680);
  const info = report.demandTournament.tournament.evaluatedStrategies.find((row) => row.id === "SOFTWARE_GENERIC_INFO_CONTROL_37");
  assert.equal(info.eligible, false);
  assert.ok(info.disqualifiers.includes("INFORMATIONAL_VOLUME_NOT_COMMERCIAL_CAPACITY"));
  assert.equal(info.relevantSessionsMilli, report.demandTournament.tournament.selectedStrategy.relevantSessionsMilli);
});

test("V4 records discovery as reviewed candidates rather than additive market size", () => {
  const report = run();
  assert.equal(report.softwareBuyerEvidence.keywordDiscovery.reviewedCandidateRows, 723);
  assert.equal(report.softwareBuyerEvidence.keywordDiscovery.resultId, "49208b09-f11e-4031-8fca-03b1ed756d85");
  assert.ok(report.warnings.includes("DISCOVERY_ROWS_ARE_NOT_UNIQUE_MARKET_SIZE"));
});

test("V4 quantifies the exact gain over the certified V3 32-page winner", () => {
  const report = run();
  assert.deepEqual(report.growthFrontier.v3BaselineDelta, {
    additionalPages: 4,
    additionalRelevantRawSearchVolume: 1_790,
    additionalRelevantSessionsMilli: 123_750,
    additionalStrictCommercialSessionsMilli: 64_800,
    additionalWorstCaseModeledClientsMilli: 163,
  });
  assert.equal(report.v3BaselineProof.winnerRelevantSessionsMilli, 649_800);
});

test("expanded search ceiling still misses 15 clients in the very-poor funnel even at impossible 100 percent click capture", () => {
  const report = run();
  const ceiling = report.demandTournament.research.ceiling;
  assert.equal(ceiling.rawRelevantSearchVolume, 11_680);
  assert.equal(ceiling.maxClickCaptureSessionsMilli, 10_512_000);
  const stress = Object.fromEntries(ceiling.stressScenarios.map((row) => [row.funnelId, row]));
  assert.equal(stress.HARD_5000.modeledClientsMilliAt100PercentSearchClickCapture, 31_536);
  assert.equal(stress.POOR_6250.modeledClientsMilliAt100PercentSearchClickCapture, 25_228);
  assert.equal(stress.VERY_POOR_11429.modeledClientsMilliAt100PercentSearchClickCapture, 13_797);
  assert.equal(stress.VERY_POOR_11429.supportsMinimumPlanningFloorAt100PercentSearchClickCapture, false);
});

test("current V4 modeled capacity remains far below the 15-client planning floor across stress funnels", () => {
  const report = run();
  const rows = Object.fromEntries(report.growthFrontier.stressFrontier.map((row) => [row.funnelId, row]));
  assert.equal(rows.HARD_5000.currentModeledClientsMilli, 2_320);
  assert.equal(rows.POOR_6250.currentModeledClientsMilli, 1_856);
  assert.equal(rows.VERY_POOR_11429.currentModeledClientsMilli, 1_015);
  assert.ok(rows.HARD_5000.sessionGapMilli > 0);
  assert.ok(rows.POOR_6250.sessionGapMilli > 0);
  assert.ok(rows.VERY_POOR_11429.sessionGapMilli > 0);
});

test("hypothetical high-conversion sensitivity is still not enough to turn current V4 traffic into 15 clients", () => {
  const report = run();
  const rows = Object.fromEntries(report.growthFrontier.sensitivityFrontier.map((row) => [row.funnelId, row]));
  assert.equal(rows.SENSITIVITY_BETTER_4000.currentModeledClientsMilli, 2_900);
  assert.equal(rows.SENSITIVITY_STRONG_2858.currentModeledClientsMilli, 4_061);
  assert.equal(rows.SENSITIVITY_HIGH_CONVERSION_1949.currentModeledClientsMilli, 5_956);
  for (const row of Object.values(rows)) {
    assert.equal(row.evidenceClass, "HYPOTHETICAL_PLANNING_ASSUMPTION_NOT_OBSERVED");
    assert.ok(row.sessionGapMilli > 0);
  }
});

test("software keyword metrics are fail-closed and cannot be silently inflated", () => {
  const changed = v4Evidence();
  changed.keywordMetrics.rows.find((row) => row.familyId === "SOFTWARE_DEVELOPMENT_COMPANY").monthlySearchVolume = 4_800;
  assert.throws(
    () => runCommercialDemandTournamentV4(baseScenario(), v3Evidence(), changed),
    /V4 metric evidence mismatch/,
  );
});

test("generic software development cannot be promoted from informational to commercial intent", () => {
  const changed = v4Evidence();
  changed.informationalGuards[0].classification = "DIRECT";
  assert.throws(
    () => runCommercialDemandTournamentV4(baseScenario(), v3Evidence(), changed),
    /V4 informational guard cannot be promoted/,
  );
});

test("V4 page counts are derived from explicit page ids and production mutation remains forbidden", () => {
  const scenario = buildCommercialDemandScenarioV4(baseScenario());
  const full = scenario.strategies.find((row) => row.id === "SOFTWARE_BUYER_FRONTIER_FULL_VALIDATED_36");
  assert.equal(full.pageIds.length, 36);
  assert.equal(Object.hasOwn(full, "pageCount"), false);
  const report = run();
  assert.equal(report.decisionBoundary, "PLAN_ONLY_NO_AUTONOMOUS_SITE_CMS_ADS_DNS_VERCEL_OR_TENANT_MUTATION");
  const serialized = JSON.stringify(report).toLowerCase();
  for (const forbidden of ["guaranteedclients", "rankprobability", "successprobability", "expectedrevenue"]) {
    assert.equal(serialized.includes(forbidden), false, `forbidden field: ${forbidden}`);
  }
});
