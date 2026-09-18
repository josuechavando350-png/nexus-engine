import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { __test as v2Test, runCommercialDemandTournamentV2 } from "../commercial-demand/tournament-engine-v2.mjs";
import { runCommercialDemandTournamentV4 } from "../commercial-demand/tournament-engine-v4.mjs";
import { auditCommercialGaussPareto } from "../commercial-demand/gauss-pareto-audit.mjs";

const load = async (path) => JSON.parse(await readFile(fileURLToPath(new URL(path, import.meta.url)), "utf8"));
const base = await load("../commercial-demand/nexus-commercial-demand-v2.json");
const v3Evidence = await load("../commercial-demand/service-intent-evidence-v3.json");
const v4Evidence = await load("../commercial-demand/software-intent-evidence-v4.json");
const clone = (value) => structuredClone(value);

function rehash(report) {
  const { reportSha256: _discarded, ...unsigned } = report;
  report.reportSha256 = v2Test.sha256Canonical(unsigned);
  return report;
}

test("native V2 really executes GAUSS Pareto with a problem-bound non-hardware Quantum receipt", async () => {
  const report = runCommercialDemandTournamentV2(base);
  const first = await auditCommercialGaussPareto(report);
  const second = await auditCommercialGaussPareto(report);
  assert.deepEqual(first, second);
  assert.equal(first.status, "PASS");
  assert.equal(first.sourceTournamentReportSha256, report.reportSha256);
  assert.equal(first.selectedStrategyId, report.tournament.selectedStrategyId);
  assert.ok(first.frontierIds.includes(first.selectedStrategyId));
  assert.equal(first.quantumStatus, "NOT_APPLICABLE");
  assert.match(first.gaussReportSha256, /^sha256:[0-9a-f]{64}$/);
  assert.equal(first.salesClaimStatus, "NOT_VALIDATED_FOR_SALES_CLAIMS");
  assert.match(first.interpretation, /NOT_OBSERVED_COMMERCIAL_OUTCOMES_OR_FORECAST/);
});

test("native V4 software-buyer tournament can be Pareto-checked without claiming CANO results", async () => {
  const v4 = runCommercialDemandTournamentV4(base, v3Evidence, v4Evidence);
  const proof = await auditCommercialGaussPareto(v4.demandTournament);
  assert.equal(proof.selectedStrategyId, "SOFTWARE_BUYER_FRONTIER_FULL_VALIDATED_36");
  assert.equal(proof.sourceScenarioSha256, v4.scenarioSha256);
  assert.ok(proof.frontierIds.includes(proof.selectedStrategyId));
  assert.equal(proof.salesClaimStatus, "NOT_VALIDATED_FOR_SALES_CLAIMS");
});

test("reject modified native report bytes before invoking GAUSS", async () => {
  const report = clone(runCommercialDemandTournamentV2(base));
  report.tournament.evaluatedStrategies[0].pageCount += 1;
  await assert.rejects(auditCommercialGaussPareto(report), /COMMERCIAL_GAUSS_PARETO_REPORT_HASH_MISMATCH/);
});

test("reject invalid planning provenance even when report hash is recomputed", async () => {
  const report = clone(runCommercialDemandTournamentV2(base));
  report.evidenceBoundary.trafficAndFunnel = "MEASURED_SIGNED_CONTRACTS";
  rehash(report);
  await assert.rejects(auditCommercialGaussPareto(report), /COMMERCIAL_GAUSS_PARETO_NOT_A_BOUNDED_V2_PLANNING_REPORT/);
});

test("reject a selected strategy that GAUSS proves dominated", async () => {
  const report = clone(runCommercialDemandTournamentV2(base));
  const eligible = report.tournament.evaluatedStrategies.filter((row) => row.eligible);
  assert.ok(eligible.length >= 2, "requires competing actual native V2 strategies");
  const disadvantaged = eligible.find((row) => row.id === report.tournament.selectedStrategyId);
  assert.ok(disadvantaged);
  disadvantaged.worstCaseModeledClientsMilli = 0;
  disadvantaged.strictCommercialSessionsMilli = 0;
  disadvantaged.relevantSessionsMilli = 0;
  disadvantaged.coveredDemandFamilyCount = 0;
  disadvantaged.pageCount = 10_000;
  Object.assign(report.tournament.selectedStrategy, {
    worstCaseModeledClientsMilli: 0,
    strictCommercialSessionsMilli: 0,
    relevantSessionsMilli: 0,
    coveredDemandFamilyCount: 0,
    pageCount: 10_000,
  });
  rehash(report);
  await assert.rejects(auditCommercialGaussPareto(report), /COMMERCIAL_GAUSS_PARETO_SELECTED_STRATEGY_DOMINATED/);
});

test("reject missing eligible strategies and duplicate IDs even with a recalculated checksum", async () => {
  const missing = clone(runCommercialDemandTournamentV2(base));
  missing.tournament.evaluatedStrategies.forEach((row) => {
    row.eligible = false;
    row.disqualifiers = ["TEST_ONLY"];
  });
  rehash(missing);
  await assert.rejects(auditCommercialGaussPareto(missing), /COMMERCIAL_GAUSS_PARETO_NO_ELIGIBLE_STRATEGY/);

  const duplicated = clone(runCommercialDemandTournamentV2(base));
  duplicated.tournament.evaluatedStrategies.push(clone(duplicated.tournament.evaluatedStrategies[0]));
  rehash(duplicated);
  await assert.rejects(auditCommercialGaussPareto(duplicated), /COMMERCIAL_GAUSS_PARETO_DUPLICATE_STRATEGY_ID/);
});
