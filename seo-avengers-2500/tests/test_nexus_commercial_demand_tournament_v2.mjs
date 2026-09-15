import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { runCommercialDemandTournamentV2 } from "../commercial-demand/tournament-engine-v2.mjs";

const SCENARIO_URL = new URL("../commercial-demand/nexus-commercial-demand-v2.json", import.meta.url);
const source = JSON.parse(await readFile(SCENARIO_URL, "utf8"));

function scenario() {
  return structuredClone(source);
}

test("V2 tournament is deterministic and hash-bound", () => {
  const first = runCommercialDemandTournamentV2(scenario());
  const second = runCommercialDemandTournamentV2(scenario());
  assert.equal(JSON.stringify(first), JSON.stringify(second));
  assert.match(first.scenarioSha256, /^sha256:[0-9a-f]{64}$/);
  assert.match(first.reportSha256, /^sha256:[0-9a-f]{64}$/);
});

test("15 clients is encoded as a minimum planning floor, not a forecast", () => {
  const report = runCommercialDemandTournamentV2(scenario());
  assert.equal(report.objective.minimumPlanningFloorClientsMilli, 15_000);
  assert.equal(report.objective.interpretation, "MINIMUM_PLANNING_FLOOR_NOT_FORECAST_OR_GUARANTEE");
  assert.ok(report.warnings.includes("NO_LEAD_OR_CLIENT_GUARANTEE"));
});

test("refreshed tournament selects the evidence-weighted 26-page hybrid", () => {
  const report = runCommercialDemandTournamentV2(scenario());
  assert.equal(report.tournament.selectedStrategyId, "EVIDENCE_WEIGHTED_HYBRID_26");
  assert.equal(report.tournament.selectedStrategy.pageCount, 26);
  assert.equal(report.tournament.selectedStrategy.coveredDemandFamilyCount, 25);
  assert.equal(report.tournament.selectedStrategy.relevantSessionsMilli, 633_870);
  assert.equal(report.tournament.selectedStrategy.strictCommercialSessionsMilli, 347_220);
  assert.equal(report.tournament.selectedStrategy.worstCaseModeledClientsMilli, 831);
});

test("26 pages beats reconciled 18 on unique evidence-backed family coverage while 32 adds no demand", () => {
  const report = runCommercialDemandTournamentV2(scenario());
  const rows = Object.fromEntries(report.tournament.evaluatedStrategies.map((row) => [row.id, row]));
  assert.equal(rows.SERVICES_PLUS_MIXED_CORE_RECONCILED_18.pageCount, 18);
  assert.equal(rows.SERVICES_PLUS_MIXED_CORE_RECONCILED_18.relevantSessionsMilli, 590_400);
  assert.equal(rows.EVIDENCE_WEIGHTED_HYBRID_26.relevantSessionsMilli, 633_870);
  assert.equal(rows.EXPANDED_PROBLEM_DECISION_32.relevantSessionsMilli, 633_870);
  assert.equal(rows.EXPANDED_PROBLEM_DECISION_32.pageCount, 32);
  assert.deepEqual(report.tournament.eligibleLeaderboardStrategyIds.slice(0, 2), [
    "EVIDENCE_WEIGHTED_HYBRID_26",
    "EXPANDED_PROBLEM_DECISION_32",
  ]);
});

test("semantic demand families prevent synonym and page double counting", () => {
  const report = runCommercialDemandTournamentV2(scenario());
  assert.equal(report.research.semanticDemandFamilyCount, 26);
  assert.equal(report.research.byIntent.DIRECT.rawSearchVolume, 3_040);
  assert.equal(report.research.byIntent.DECISION.rawSearchVolume, 140);
  assert.equal(report.research.byIntent.MIXED.rawSearchVolume, 6_370);
  assert.equal(report.research.byIntent.INFORMATIONAL.rawSearchVolume, 12_100);
  assert.ok(report.warnings.includes("SEMANTIC_VARIANTS_ARE_NOT_SUMMED"));
  assert.equal(
    report.tournament.selectedStrategy.coveredDemandFamilyIds.filter((id) => id === "WEB_QUOTE").length,
    1,
  );
});

test("winner does not support the 15-client floor under current evidence and assumptions", () => {
  const report = runCommercialDemandTournamentV2(scenario());
  assert.equal(report.targetAssessment.targetSupportVerdict, "EXPAND_VALIDATED_DEMAND_AND_OR_CHANNELS_BEFORE_FLOOR_CLAIM");
  const stress = Object.fromEntries(report.tournament.selectedStrategy.stressScenarios.map((row) => [row.funnelId, row]));
  assert.equal(stress.HARD_5000.modeledClientsMilli, 1_901);
  assert.equal(stress.POOR_6250.modeledClientsMilli, 1_521);
  assert.equal(stress.VERY_POOR_11429.modeledClientsMilli, 831);
  assert.equal(stress.HARD_5000.supportsMinimumPlanningFloor, false);
  assert.equal(stress.POOR_6250.supportsMinimumPlanningFloor, false);
  assert.equal(stress.VERY_POOR_11429.supportsMinimumPlanningFloor, false);
});

test("100 percent click-capture ceiling is explicit and still fails the very-poor floor", () => {
  const report = runCommercialDemandTournamentV2(scenario());
  const ceiling = report.research.ceiling;
  assert.equal(ceiling.rawRelevantSearchVolume, 9_550);
  assert.equal(ceiling.maxClickCaptureSessionsMilli, 8_595_000);
  const stress = Object.fromEntries(ceiling.stressScenarios.map((row) => [row.funnelId, row]));
  assert.equal(stress.HARD_5000.modeledClientsMilliAt100PercentSearchClickCapture, 25_785);
  assert.equal(stress.POOR_6250.modeledClientsMilliAt100PercentSearchClickCapture, 20_628);
  assert.equal(stress.VERY_POOR_11429.modeledClientsMilliAt100PercentSearchClickCapture, 11_280);
  assert.equal(stress.VERY_POOR_11429.supportsMinimumPlanningFloorAt100PercentSearchClickCapture, false);
  assert.match(ceiling.boundary, /100_PERCENT_CLICK_CAPTURE_UPPER_BOUND/);
});

test("informational volume maximizer is ineligible before ranking", () => {
  const report = runCommercialDemandTournamentV2(scenario());
  const info = report.tournament.evaluatedStrategies.find((row) => row.id === "INFORMATIONAL_VOLUME_MAXIMIZER_33");
  assert.equal(info.eligible, false);
  assert.ok(info.disqualifiers.includes("INFORMATIONAL_VOLUME_DOMINATES"));
  assert.notEqual(report.tournament.selectedStrategyId, info.id);
});

test("page count cannot drift from the explicit page list", () => {
  const changed = scenario();
  changed.strategies[0].pageCount = 12;
  assert.throws(() => runCommercialDemandTournamentV2(changed), /unexpected keys/);
});

test("duplicate demand family ids fail closed", () => {
  const changed = scenario();
  changed.keywordResearch.families[1].id = changed.keywordResearch.families[0].id;
  assert.throws(() => runCommercialDemandTournamentV2(changed), /duplicate demand family id/);
});

test("unknown page family references fail closed", () => {
  const changed = scenario();
  changed.pages[0].demandFamilyIds = ["INVENTED_DEMAND"];
  assert.throws(() => runCommercialDemandTournamentV2(changed), /unknown demand family/);
});

test("first-party search baseline cannot silently become funnel evidence", () => {
  const baseline = runCommercialDemandTournamentV2(scenario());
  const changed = scenario();
  changed.observedSearch.aggregate.clicks = 1;
  changed.observedSearch.aggregate.ctrPpm = 400;
  const second = runCommercialDemandTournamentV2(changed);
  assert.deepEqual(second.tournament, baseline.tournament);
  assert.deepEqual(second.targetAssessment, baseline.targetAssessment);
  assert.notEqual(second.scenarioSha256, baseline.scenarioSha256);
});

test("report forbids autonomous production mutation and forecast claims", () => {
  const report = runCommercialDemandTournamentV2(scenario());
  assert.equal(report.evidenceBoundary.productionMutationAuthorized, false);
  assert.equal(report.decisionBoundary, "PLAN_ONLY_NO_AUTONOMOUS_SITE_CMS_ADS_DNS_VERCEL_OR_TENANT_MUTATION");
  const serialized = JSON.stringify(report).toLowerCase();
  for (const forbidden of ["successprobability", "rankprobability", "expectedrevenue", "guaranteedclients"]) {
    assert.equal(serialized.includes(forbidden), false, `forbidden field: ${forbidden}`);
  }
});
