import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { runCommercialDemandTournament } from "../commercial-demand/tournament-engine.mjs";

const SCENARIO_URL = new URL("../commercial-demand/nexus-commercial-demand-v1.json", import.meta.url);
const source = JSON.parse(await readFile(SCENARIO_URL, "utf8"));

function scenario() {
  return structuredClone(source);
}

test("NEXUS tournament is byte-deterministic and hash-bound", () => {
  const first = runCommercialDemandTournament(scenario());
  const second = runCommercialDemandTournament(scenario());
  assert.equal(JSON.stringify(first), JSON.stringify(second));
  assert.match(first.scenarioSha256, /^sha256:[0-9a-f]{64}$/);
  assert.match(first.reportSha256, /^sha256:[0-9a-f]{64}$/);
});

test("current research seed set does not support the 5000-session hard target", () => {
  const report = runCommercialDemandTournament(scenario());
  assert.equal(report.status, "TOURNAMENT_COMPLETE");
  assert.equal(report.targetAssessment.targetSupportVerdict, "EXPAND_VALIDATED_DEMAND_BEFORE_CLAIM");
  assert.equal(report.tournament.selectedStrategy.relevantSessionsMilli, 994_590);
  assert.equal(report.tournament.selectedStrategy.strictCommercialSessionsMilli, 404_190);
  const hard = report.targetAssessment.targetGaps.find((row) => row.funnelId === "HARD_5000");
  assert.equal(hard.requiredSessions, 5_000);
  assert.equal(hard.sessionGapMilli, 4_005_410);
  assert.equal(hard.targetSupportedByCurrentSeedScenario, false);
});

test("funnel math reproduces hard poor and very-poor 15-client requirements exactly", () => {
  const report = runCommercialDemandTournament(scenario());
  const funnels = Object.fromEntries(report.funnels.map((row) => [row.id, row]));
  assert.equal(funnels.HARD_5000.requiredSessions, 5_000);
  assert.equal(funnels.HARD_5000.modeledClientsMilli, 15_000);
  assert.equal(funnels.POOR_6250.requiredSessions, 6_250);
  assert.equal(funnels.POOR_6250.modeledClientsMilli, 15_000);
  assert.equal(funnels.VERY_POOR_11500.requiredSessions, 11_429);
  assert.equal(funnels.VERY_POOR_11500.plannedSessions, 11_500);
  assert.equal(funnels.VERY_POOR_11500.plannedSessionsMeetTargetMath, true);
  assert.equal(funnels.VERY_POOR_11500.modeledClientsMilli, 15_093);
});

test("research totals preserve intent separation instead of pretending all volume is commercial", () => {
  const report = runCommercialDemandTournament(scenario());
  assert.equal(report.research.byIntent.DIRECT.rawSearchVolume, 3_530);
  assert.equal(report.research.byIntent.DECISION.rawSearchVolume, 170);
  assert.equal(report.research.byIntent.MIXED.rawSearchVolume, 13_120);
  assert.equal(report.research.byIntent.INFORMATIONAL.rawSearchVolume, 12_100);
  assert.ok(report.warnings.includes("SEARCH_VOLUME_IS_RESEARCH_NOT_UNIQUE_PEOPLE"));
  assert.ok(report.warnings.includes("MIXED_INTENT_DEMAND_IS_NOT_COUNTED_AS_PROVEN_COMMERCIAL_DEMAND"));
});

test("compact services-plus-mixed strategy wins current evidence instead of forcing the larger 26-page plan", () => {
  const report = runCommercialDemandTournament(scenario());
  assert.equal(report.tournament.selectedStrategyId, "SERVICES_PLUS_MIXED_CORE");
  assert.deepEqual(report.tournament.paretoFrontierStrategyIds, ["SERVICES_PLUS_MIXED_CORE", "DIRECT_SERVICES_ONLY"]);
  assert.equal(report.tournament.selectedStrategy.pageCount, 18);
  assert.equal(report.tournament.selectedStrategy.eligible, true);
});

test("doorway and information-volume strategies are disqualified before selection", () => {
  const report = runCommercialDemandTournament(scenario());
  const byId = Object.fromEntries(report.tournament.evaluatedStrategies.map((row) => [row.id, row]));
  assert.equal(byId.CITY_DOORWAY_SCALE.eligible, false);
  assert.ok(byId.CITY_DOORWAY_SCALE.disqualifiers.includes("UNVERIFIED_LOCATION_AND_DOORWAY_RISK"));
  assert.equal(byId.INFORMATIONAL_VOLUME_MAXIMIZER.eligible, false);
  assert.ok(byId.INFORMATIONAL_VOLUME_MAXIMIZER.disqualifiers.includes("TRAFFIC_WITHOUT_COMMERCIAL_INTENT_DOMINATES"));
  assert.notEqual(report.tournament.selectedStrategyId, "CITY_DOORWAY_SCALE");
  assert.notEqual(report.tournament.selectedStrategyId, "INFORMATIONAL_VOLUME_MAXIMIZER");
});

test("first-party observed clicks never become an invented funnel", () => {
  const baseline = runCommercialDemandTournament(scenario());
  const changed = scenario();
  changed.observedSearch.aggregate.clicks = 1;
  changed.observedSearch.aggregate.ctrPpm = 400;
  const second = runCommercialDemandTournament(changed);
  assert.deepEqual(second.funnels, baseline.funnels);
  assert.deepEqual(second.targetAssessment, baseline.targetAssessment);
  assert.notEqual(second.scenarioSha256, baseline.scenarioSha256);
  assert.notEqual(second.reportSha256, baseline.reportSha256);
});

test("changing an explicit CTR assumption changes the scenario and report identity", () => {
  const baseline = runCommercialDemandTournament(scenario());
  const changed = scenario();
  changed.trafficAssumptions.targetCtrPpmByIntent.DIRECT = 110_000;
  const second = runCommercialDemandTournament(changed);
  assert.notEqual(second.scenarioSha256, baseline.scenarioSha256);
  assert.notEqual(second.reportSha256, baseline.reportSha256);
  assert.notEqual(second.tournament.selectedStrategy.strictCommercialSessionsMilli, baseline.tournament.selectedStrategy.strictCommercialSessionsMilli);
});

test("duplicate opportunity ids fail closed", () => {
  const changed = scenario();
  changed.keywordResearch.opportunities[1].id = changed.keywordResearch.opportunities[0].id;
  assert.throws(() => runCommercialDemandTournament(changed), /duplicate opportunity id/);
});

test("unknown intent classes fail closed", () => {
  const changed = scenario();
  changed.keywordResearch.opportunities[0].intentClass = "MAGIC_BUYER";
  assert.throws(() => runCommercialDemandTournament(changed), /unknown intentClass/);
});

test("fractional numeric inputs fail closed instead of being rounded", () => {
  const changed = scenario();
  changed.keywordResearch.opportunities[0].monthlySearchVolume = 880.5;
  assert.throws(() => runCommercialDemandTournament(changed), /safe integer/);
});

test("report contains no success probability, revenue forecast, or autonomous production claim", () => {
  const report = runCommercialDemandTournament(scenario());
  const serialized = JSON.stringify(report).toLowerCase();
  for (const forbidden of ["successprobability", "rankprobability", "expectedrevenue", "autonomoussiteaction"]) {
    assert.equal(serialized.includes(forbidden), false, `forbidden claim field: ${forbidden}`);
  }
  assert.equal(report.evidenceBoundary.productionMutationAuthorized, false);
  assert.equal(report.decisionBoundary, "PLAN_ONLY_NO_AUTONOMOUS_SITE_CMS_ADS_DNS_VERCEL_OR_TENANT_MUTATION");
  assert.ok(report.warnings.includes("NO_LEAD_OR_CLIENT_GUARANTEE"));
});
