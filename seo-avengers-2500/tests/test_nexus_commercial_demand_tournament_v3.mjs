import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { runCommercialDemandTournamentV3 } from "../commercial-demand/tournament-engine-v3.mjs";
import { buildCommercialDemandScenarioV3 } from "../commercial-demand/tournament-v3-scenario.mjs";

const BASE_URL = new URL("../commercial-demand/nexus-commercial-demand-v2.json", import.meta.url);
const EVIDENCE_URL = new URL("../commercial-demand/service-intent-evidence-v3.json", import.meta.url);
const [baseSource, evidenceSource] = await Promise.all([
  readFile(BASE_URL, "utf8").then(JSON.parse),
  readFile(EVIDENCE_URL, "utf8").then(JSON.parse),
]);

function baseScenario() {
  return structuredClone(baseSource);
}

function evidence() {
  return structuredClone(evidenceSource);
}

test("V3 report is deterministic and hash-bound to both scenario and evidence", () => {
  const first = runCommercialDemandTournamentV3(baseScenario(), evidence());
  const second = runCommercialDemandTournamentV3(baseScenario(), evidence());
  assert.equal(JSON.stringify(first), JSON.stringify(second));
  assert.match(first.scenarioSha256, /^sha256:[0-9a-f]{64}$/);
  assert.match(first.evidenceSha256, /^sha256:[0-9a-f]{64}$/);
  assert.match(first.reportSha256, /^sha256:[0-9a-f]{64}$/);
});

test("15 clients remains a minimum planning floor and never becomes a forecast", () => {
  const report = runCommercialDemandTournamentV3(baseScenario(), evidence());
  assert.equal(report.objective.minimumPlanningFloorClientsMilli, 15_000);
  assert.equal(report.objective.interpretation, "MINIMUM_PLANNING_FLOOR_NOT_FORECAST_OR_GUARANTEE");
  assert.ok(report.warnings.includes("NO_LEAD_OR_CLIENT_GUARANTEE"));
  assert.equal(report.serviceIntentEvidence.analyticsBoundary.ga4ConversionEvidence, "NOT_AVAILABLE_FROM_CONNECTED_PROPERTY");
});

test("service frontier selects the 32-page strategy because all six new relevant families add evidence-backed demand", () => {
  const report = runCommercialDemandTournamentV3(baseScenario(), evidence());
  assert.equal(report.selectedStrategyId, "SERVICE_FRONTIER_FULL_VALIDATED_32");
  const winner = report.demandTournament.tournament.selectedStrategy;
  assert.equal(winner.pageCount, 32);
  assert.equal(winner.coveredDemandFamilyCount, 31);
  assert.equal(winner.relevantSessionsMilli, 649_800);
  assert.equal(winner.strictCommercialSessionsMilli, 348_300);
  assert.equal(winner.worstCaseModeledClientsMilli, 852);
});

test("38-page bloat control cannot beat 32 pages when it adds no unique demand family", () => {
  const report = runCommercialDemandTournamentV3(baseScenario(), evidence());
  const rows = Object.fromEntries(report.demandTournament.tournament.evaluatedStrategies.map((row) => [row.id, row]));
  assert.equal(rows.SERVICE_FRONTIER_FULL_VALIDATED_32.pageCount, 32);
  assert.equal(rows.SERVICE_FRONTIER_BLOAT_CONTROL_38.pageCount, 38);
  assert.equal(rows.SERVICE_FRONTIER_BLOAT_CONTROL_38.relevantSessionsMilli, rows.SERVICE_FRONTIER_FULL_VALIDATED_32.relevantSessionsMilli);
  assert.equal(rows.SERVICE_FRONTIER_BLOAT_CONTROL_38.coveredDemandFamilyCount, rows.SERVICE_FRONTIER_FULL_VALIDATED_32.coveredDemandFamilyCount);
  assert.deepEqual(report.demandTournament.tournament.eligibleLeaderboardStrategyIds.slice(0, 2), [
    "SERVICE_FRONTIER_FULL_VALIDATED_32",
    "SERVICE_FRONTIER_BLOAT_CONTROL_38",
  ]);
});

test("generic AI-agent and dashboard volume stays informational and cannot inflate commercial capacity", () => {
  const report = runCommercialDemandTournamentV3(baseScenario(), evidence());
  assert.equal(report.demandTournament.research.semanticDemandFamilyCount, 34);
  assert.equal(report.demandTournament.research.byIntent.DIRECT.rawSearchVolume, 3_050);
  assert.equal(report.demandTournament.research.byIntent.DECISION.rawSearchVolume, 140);
  assert.equal(report.demandTournament.research.byIntent.MIXED.rawSearchVolume, 6_700);
  assert.equal(report.demandTournament.research.byIntent.INFORMATIONAL.rawSearchVolume, 12_430);
  assert.equal(report.growthFrontier.validatedRelevantRawSearchVolume, 9_890);
  const info = report.demandTournament.tournament.evaluatedStrategies.find((row) => row.id === "INFORMATIONAL_VOLUME_CONTROL_34");
  assert.equal(info.eligible, false);
  assert.ok(info.disqualifiers.includes("INFORMATIONAL_VOLUME_NOT_COMMERCIAL_CAPACITY"));
});

test("V3 quantifies the incremental gain over the V2 26-page winner without pretending the gain reaches 15 clients", () => {
  const report = runCommercialDemandTournamentV3(baseScenario(), evidence());
  assert.deepEqual(report.growthFrontier.v2BaselineDelta, {
    additionalRelevantSessionsMilli: 15_930,
    additionalStrictCommercialSessionsMilli: 1_080,
    additionalWorstCaseModeledClientsMilli: 21,
  });
  assert.equal(report.targetSupportVerdict, "EXPAND_VALIDATED_DEMAND_AND_OR_CHANNELS_BEFORE_FLOOR_CLAIM");
});

test("expanded research ceiling still cannot support 15 clients in the very-poor funnel even at impossible 100 percent click capture", () => {
  const report = runCommercialDemandTournamentV3(baseScenario(), evidence());
  const ceiling = report.demandTournament.research.ceiling;
  assert.equal(ceiling.rawRelevantSearchVolume, 9_890);
  assert.equal(ceiling.maxClickCaptureSessionsMilli, 8_901_000);
  const stress = Object.fromEntries(ceiling.stressScenarios.map((row) => [row.funnelId, row]));
  assert.equal(stress.HARD_5000.modeledClientsMilliAt100PercentSearchClickCapture, 26_703);
  assert.equal(stress.POOR_6250.modeledClientsMilliAt100PercentSearchClickCapture, 21_362);
  assert.equal(stress.VERY_POOR_11429.modeledClientsMilliAt100PercentSearchClickCapture, 11_682);
  assert.equal(stress.VERY_POOR_11429.supportsMinimumPlanningFloorAt100PercentSearchClickCapture, false);
});

test("growth frontier states the exact session multiplier required by each original stress funnel", () => {
  const report = runCommercialDemandTournamentV3(baseScenario(), evidence());
  const rows = Object.fromEntries(report.growthFrontier.stressFrontier.map((row) => [row.funnelId, row]));
  assert.equal(rows.HARD_5000.requiredSessionsMilli, 5_000_000);
  assert.equal(rows.HARD_5000.currentModeledClientsMilli, 1_949);
  assert.equal(rows.HARD_5000.requiredSessionMultiplePpm, 7_694_676);
  assert.equal(rows.POOR_6250.requiredSessionsMilli, 6_250_000);
  assert.equal(rows.POOR_6250.currentModeledClientsMilli, 1_559);
  assert.equal(rows.POOR_6250.requiredSessionMultiplePpm, 9_618_345);
  assert.equal(rows.VERY_POOR_11429.requiredSessionsMilli, 11_428_572);
  assert.equal(rows.VERY_POOR_11429.currentModeledClientsMilli, 852);
  assert.equal(rows.VERY_POOR_11429.requiredSessionMultiplePpm, 17_587_831);
});

test("hypothetical conversion sensitivity remains labeled and shows traffic still has to grow", () => {
  const report = runCommercialDemandTournamentV3(baseScenario(), evidence());
  const rows = Object.fromEntries(report.growthFrontier.sensitivityFrontier.map((row) => [row.funnelId, row]));
  assert.equal(rows.SENSITIVITY_BETTER_4000.requiredSessionsMilli, 4_000_000);
  assert.equal(rows.SENSITIVITY_BETTER_4000.currentModeledClientsMilli, 2_436);
  assert.equal(rows.SENSITIVITY_STRONG_2858.requiredSessionsMilli, 2_857_143);
  assert.equal(rows.SENSITIVITY_STRONG_2858.currentModeledClientsMilli, 3_411);
  assert.equal(rows.SENSITIVITY_HIGH_CONVERSION_1949.requiredSessionsMilli, 1_948_052);
  assert.equal(rows.SENSITIVITY_HIGH_CONVERSION_1949.currentModeledClientsMilli, 5_003);
  for (const row of Object.values(rows)) {
    assert.equal(row.evidenceClass, "HYPOTHETICAL_PLANNING_ASSUMPTION_NOT_OBSERVED");
    assert.ok(row.sessionGapMilli > 0);
  }
});

test("service metrics are fail-closed and cannot be silently inflated", () => {
  const changed = evidence();
  changed.keywordMetrics.rows.find((row) => row.familyId === "SYSTEM_INTEGRATION").monthlySearchVolume = 1_700;
  assert.throws(() => runCommercialDemandTournamentV3(baseScenario(), changed), /metric evidence mismatch/);
});

test("SERP informational guards cannot be promoted to commercial intent", () => {
  const changed = evidence();
  changed.informationalGuards[0].classification = "DIRECT";
  assert.throws(() => runCommercialDemandTournamentV3(baseScenario(), changed), /informational guard cannot be promoted/);
});

test("missing GA4 conversion evidence cannot silently become observed funnel evidence", () => {
  const changed = evidence();
  changed.analyticsBoundary.ga4ConversionEvidence = "OBSERVED";
  assert.throws(() => runCommercialDemandTournamentV3(baseScenario(), changed), /GA4 boundary cannot be promoted/);
});

test("V3 page counts are derived from explicit page ids and production mutation remains forbidden", () => {
  const scenario = buildCommercialDemandScenarioV3(baseScenario());
  const full = scenario.strategies.find((row) => row.id === "SERVICE_FRONTIER_FULL_VALIDATED_32");
  assert.equal(full.pageIds.length, 32);
  assert.equal(Object.hasOwn(full, "pageCount"), false);
  const report = runCommercialDemandTournamentV3(baseScenario(), evidence());
  assert.equal(report.decisionBoundary, "PLAN_ONLY_NO_AUTONOMOUS_SITE_CMS_ADS_DNS_VERCEL_OR_TENANT_MUTATION");
  const serialized = JSON.stringify(report).toLowerCase();
  for (const forbidden of ["guaranteedclients", "rankprobability", "successprobability", "expectedrevenue"]) {
    assert.equal(serialized.includes(forbidden), false, `forbidden field: ${forbidden}`);
  }
});
