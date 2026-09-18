import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { runCommercialDemandTournamentV5 } from "../commercial-demand/tournament-engine-v5.mjs";
import { buildCommercialDemandScenarioV5 } from "../commercial-demand/tournament-v5-scenario.mjs";

const BASE_URL = new URL("../commercial-demand/nexus-commercial-demand-v2.json", import.meta.url);
const V3_EVIDENCE_URL = new URL("../commercial-demand/service-intent-evidence-v3.json", import.meta.url);
const V4_EVIDENCE_URL = new URL("../commercial-demand/software-intent-evidence-v4.json", import.meta.url);
const V5_EVIDENCE_URL = new URL("../commercial-demand/demand-fit-evidence-v5.json", import.meta.url);
const [baseSource, v3EvidenceSource, v4EvidenceSource, v5EvidenceSource] = await Promise.all([
  readFile(BASE_URL, "utf8").then(JSON.parse),
  readFile(V3_EVIDENCE_URL, "utf8").then(JSON.parse),
  readFile(V4_EVIDENCE_URL, "utf8").then(JSON.parse),
  readFile(V5_EVIDENCE_URL, "utf8").then(JSON.parse),
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

function v5Evidence() {
  return structuredClone(v5EvidenceSource);
}

function run() {
  return runCommercialDemandTournamentV5(baseScenario(), v3Evidence(), v4Evidence(), v5Evidence());
}

test("V5 report is deterministic and hash-bound through the certified V4 chain", () => {
  const first = run();
  const second = run();
  assert.equal(JSON.stringify(first), JSON.stringify(second));
  assert.match(first.v4BaselineProof.reportSha256, /^sha256:[0-9a-f]{64}$/);
  assert.match(first.scenarioSha256, /^sha256:[0-9a-f]{64}$/);
  assert.match(first.evidenceSha256, /^sha256:[0-9a-f]{64}$/);
  assert.match(first.reportSha256, /^sha256:[0-9a-f]{64}$/);
  assert.equal(first.v4BaselineProof.selectedStrategyId, "SOFTWARE_BUYER_FRONTIER_FULL_VALIDATED_36");
});

test("15 clients remains a planning floor and offer-fit gating cannot turn it into a forecast", () => {
  const report = run();
  assert.equal(report.objective.minimumPlanningFloorClientsMilli, 15_000);
  assert.equal(report.objective.interpretation, "MINIMUM_PLANNING_FLOOR_NOT_FORECAST_OR_GUARANTEE");
  assert.equal(report.targetSupportVerdict, "EXPAND_VALIDATED_DEMAND_AND_OR_CHANNELS_BEFORE_FLOOR_CLAIM");
  assert.ok(report.warnings.includes("NO_LEAD_OR_CLIENT_GUARANTEE"));
  assert.equal(report.offerFitEvidence.analyticsBoundary.ga4ConversionEvidence, "NOT_AVAILABLE_FROM_CONNECTED_PROPERTY");
});

test("offer-fit frontier selects 40 pages because exactly four new aligned families add distinct demand", () => {
  const report = run();
  assert.equal(report.selectedStrategyId, "OFFER_FIT_FULL_VALIDATED_40");
  const winner = report.demandTournament.tournament.selectedStrategy;
  assert.equal(winner.pageCount, 40);
  assert.equal(winner.coveredDemandFamilyCount, 39);
  assert.equal(winner.relevantSessionsMilli, 776_700);
  assert.equal(winner.strictCommercialSessionsMilli, 413_100);
  assert.equal(winner.worstCaseModeledClientsMilli, 1_019);
});

test("44-page bloat control loses when four extra pages add no new demand family", () => {
  const report = run();
  const rows = Object.fromEntries(report.demandTournament.tournament.evaluatedStrategies.map((row) => [row.id, row]));
  const full = rows.OFFER_FIT_FULL_VALIDATED_40;
  const bloat = rows.OFFER_FIT_BLOAT_CONTROL_44;
  assert.equal(full.pageCount, 40);
  assert.equal(bloat.pageCount, 44);
  assert.equal(bloat.relevantSessionsMilli, full.relevantSessionsMilli);
  assert.equal(bloat.coveredDemandFamilyCount, full.coveredDemandFamilyCount);
  assert.deepEqual(report.demandTournament.tournament.eligibleLeaderboardStrategyIds.slice(0, 2), [
    "OFFER_FIT_FULL_VALIDATED_40",
    "OFFER_FIT_BLOAT_CONTROL_44",
  ]);
});

test("V5 counts only 70 of 9,410 exact researched monthly volume as new additive capacity", () => {
  const report = run();
  assert.deepEqual(report.offerFitAccounting, {
    exactResearchedKeywordCount: 9,
    exactSnapshotRawSearchVolume: 9_410,
    eligibleIncrementalRawSearchVolume: 70,
    guardedRawSearchVolume: 9_170,
    overlapRawSearchVolume: 170,
    totalNonAdditiveRawSearchVolume: 9_340,
    boundary: "ONLY_FIRST_PARTY_ALIGNED_DISTINCT_FAMILIES_ENTER_THE_DEMAND_SCENARIO_ADJACENT_UNPROVEN_INFORMATIONAL_AND_OVERLAP_VOLUME_ADDS_ZERO_CAPACITY",
  });
});

test("large adjacent ERP POS and packaged-software markets never enter the modeled demand scenario", () => {
  const scenario = buildCommercialDemandScenarioV5(baseScenario());
  const keywords = new Set(scenario.keywordResearch.families.map((row) => row.representativeKeyword));
  for (const forbidden of ["sistemas erp", "puntos de venta para negocios", "software de gestion empresarial", "desarrollo de ecommerce", "empresa de inteligencia artificial"]) {
    assert.equal(keywords.has(forbidden), false, `non-additive term entered scenario: ${forbidden}`);
  }
  const report = run();
  assert.equal(report.demandTournament.research.semanticDemandFamilyCount, 43);
  assert.equal(report.demandTournament.research.byIntent.DIRECT.rawSearchVolume, 3_050);
  assert.equal(report.demandTournament.research.byIntent.DECISION.rawSearchVolume, 620);
  assert.equal(report.demandTournament.research.byIntent.MIXED.rawSearchVolume, 8_080);
  assert.equal(report.demandTournament.research.byIntent.INFORMATIONAL.rawSearchVolume, 17_830);
});

test("V5 quantifies the small evidence-backed gain over V4 without hiding diminishing returns", () => {
  const report = run();
  assert.deepEqual(report.growthFrontier.v4BaselineDelta, {
    additionalPages: 4,
    additionalRelevantRawSearchVolume: 70,
    additionalRelevantSessionsMilli: 3_150,
    additionalStrictCommercialSessionsMilli: 0,
    additionalWorstCaseModeledClientsMilli: 4,
  });
  assert.equal(report.v4BaselineProof.winnerRelevantSessionsMilli, 773_550);
  assert.equal(report.growthFrontier.validatedRelevantRawSearchVolume, 11_750);
});

test("expanded V5 search ceiling still misses 15 clients in the very-poor funnel at impossible 100 percent click capture", () => {
  const report = run();
  const ceiling = report.demandTournament.research.ceiling;
  assert.equal(ceiling.rawRelevantSearchVolume, 11_750);
  assert.equal(ceiling.maxClickCaptureSessionsMilli, 10_575_000);
  const stress = Object.fromEntries(ceiling.stressScenarios.map((row) => [row.funnelId, row]));
  assert.equal(stress.HARD_5000.modeledClientsMilliAt100PercentSearchClickCapture, 31_725);
  assert.equal(stress.POOR_6250.modeledClientsMilliAt100PercentSearchClickCapture, 25_380);
  assert.equal(stress.VERY_POOR_11429.modeledClientsMilliAt100PercentSearchClickCapture, 13_879);
  assert.equal(stress.VERY_POOR_11429.supportsMinimumPlanningFloorAt100PercentSearchClickCapture, false);
});

test("current V5 capacity remains far below the floor under stress and hypothetical sensitivity", () => {
  const report = run();
  const stress = Object.fromEntries(report.growthFrontier.stressFrontier.map((row) => [row.funnelId, row]));
  assert.equal(stress.HARD_5000.currentModeledClientsMilli, 2_330);
  assert.equal(stress.POOR_6250.currentModeledClientsMilli, 1_864);
  assert.equal(stress.VERY_POOR_11429.currentModeledClientsMilli, 1_019);
  const sensitivity = Object.fromEntries(report.growthFrontier.sensitivityFrontier.map((row) => [row.funnelId, row]));
  assert.equal(sensitivity.SENSITIVITY_BETTER_4000.currentModeledClientsMilli, 2_912);
  assert.equal(sensitivity.SENSITIVITY_STRONG_2858.currentModeledClientsMilli, 4_077);
  assert.equal(sensitivity.SENSITIVITY_HIGH_CONVERSION_1949.currentModeledClientsMilli, 5_980);
  for (const row of Object.values(sensitivity)) assert.equal(row.evidenceClass, "HYPOTHETICAL_PLANNING_ASSUMPTION_NOT_OBSERVED");
});

test("eligible keyword metrics are fail-closed and cannot be inflated", () => {
  const changed = v5Evidence();
  changed.keywordMetrics.eligibleRows.find((row) => row.familyId === "AI_CONSULTING_SPECIALIZED").monthlySearchVolume = 300;
  assert.throws(
    () => runCommercialDemandTournamentV5(baseScenario(), v3Evidence(), v4Evidence(), changed),
    /V5 eligible metric evidence mismatch/,
  );
});

test("adjacent product guards cannot be promoted into eligible capacity", () => {
  const changed = v5Evidence();
  const guard = changed.keywordMetrics.guardRows.find((row) => row.guardId === "POS_ADJACENT_PRODUCT");
  guard.offerFitClass = "FIRST_PARTY_ALIGNED_DISTINCT_DEMAND_FAMILY";
  assert.throws(
    () => runCommercialDemandTournamentV5(baseScenario(), v3Evidence(), v4Evidence(), changed),
    /V5 guard metric mismatch/,
  );
});

test("existing-family synonyms cannot become additive by changing their volume or classification", () => {
  const changed = v5Evidence();
  changed.keywordMetrics.overlapRows[0].monthlySearchVolume = 1_700;
  assert.throws(
    () => runCommercialDemandTournamentV5(baseScenario(), v3Evidence(), v4Evidence(), changed),
    /V5 overlap metric mismatch/,
  );
});

test("V5 requires explicit first-party offer lines for every counted family", () => {
  const changed = v5Evidence();
  changed.offerEvidence.offeredServiceLabels = changed.offerEvidence.offeredServiceLabels.filter((label) => label !== "Datos y Analytics");
  assert.throws(
    () => runCommercialDemandTournamentV5(baseScenario(), v3Evidence(), v4Evidence(), changed),
    /V5 offer snapshot missing required service line/,
  );
});

test("V5 page counts are explicit and production mutation remains forbidden", () => {
  const scenario = buildCommercialDemandScenarioV5(baseScenario());
  const full = scenario.strategies.find((row) => row.id === "OFFER_FIT_FULL_VALIDATED_40");
  assert.equal(full.pageIds.length, 40);
  assert.equal(Object.hasOwn(full, "pageCount"), false);
  const report = run();
  assert.equal(report.decisionBoundary, "PLAN_ONLY_NO_AUTONOMOUS_SITE_CMS_ADS_DNS_VERCEL_OR_TENANT_MUTATION");
  const serialized = JSON.stringify(report).toLowerCase();
  for (const forbidden of ["guaranteedclients", "rankprobability", "successprobability", "expectedrevenue"]) {
    assert.equal(serialized.includes(forbidden), false, `forbidden field: ${forbidden}`);
  }
});
