#!/usr/bin/env node
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { sha256Canonical } from "../../gauss/core/common.mjs";
import { executeGaussProblem } from "../../gauss/core/problem.mjs";
import { contributeNexusQuantum } from "../../gauss/core/quantum-contributor.mjs";
import { runAxioma } from "../../gauss/axioma/run.mjs";

const here = new URL("./", import.meta.url);
const gatePath = new URL("./organic-statistical-gate-v1.json", here);
const protocolPath = new URL("./round4-live-measurement-protocol-v1.json", here);
const planPath = new URL("./round3-architecture-plan-v1.json", here);

function parseArgs(argv) {
  const out = { round3: null, live: null, out: null };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!["--round3-report","--live-evidence","--out"].includes(arg)) throw new Error(`unknown argument:${arg}`);
    const value = argv[i + 1];
    if (!value || value.startsWith("--")) throw new Error(`missing value for ${arg}`);
    if (arg === "--round3-report") out.round3 = resolve(value);
    if (arg === "--live-evidence") out.live = resolve(value);
    if (arg === "--out") out.out = resolve(value);
    i += 1;
  }
  if (!out.round3) throw new Error("ROUND3_REPORT_REQUIRED");
  return out;
}

function validateFoundation(round3, gate, protocol, plan) {
  assert.equal(round3.stage, "ROUND_3_ARCHITECTURE_FINALISTS");
  assert.equal(round3.status, "PASS_THREE_ARCHITECTURE_FINALISTS_NO_RANK_OR_CLIENT_CLAIM");
  assert.equal(round3.finalistCount, 3);
  assert.deepStrictEqual(round3.finalistIds, ["S01","S10","S15"]);
  assert.equal(round3.commercialWinnerStatus, "NOT_YET_ELIGIBLE");
  assert.equal(gate.gateId, "CANO_ORGANIC_STATISTICAL_GATE_V1");
  assert.equal(gate.statisticalStandard.highConfidenceProbability, 0.999);
  assert.equal(gate.statisticalStandard.comparisonPower, 0.95);
  assert.equal(gate.commercialTarget.minimumSignedClientsPerCalendarMonth, 5);
  assert.equal(protocol.protocolId, "CANO_ROUND4_LIVE_ORGANIC_MEASUREMENT_V1");
  assert.equal(protocol.inputRequirement, "WALLE_VERIFIED_ROUND3_THREE_FINALISTS");
  assert.equal(protocol.decisionRules.highConfidenceProbability, 0.999);
  assert.equal(protocol.decisionRules.comparisonPower, 0.95);
  assert.equal(protocol.decisionRules.minimumSignedOrganicClientsPerMonth, 5);
  assert.equal(plan.planId, "CANO_ROUND3_ARCHITECTURES_V1");
  const planIds = plan.architectures.map((row) => row.strategyId);
  for (const id of round3.finalistIds) assert(planIds.includes(id), `missing finalist architecture:${id}`);
}

function finalistDefinitions(round3, plan) {
  const byId = new Map(plan.architectures.map((row) => [row.strategyId, row]));
  return round3.finalistIds.map((id) => {
    const row = byId.get(id);
    return Object.freeze({
      strategyId: id,
      name: row.name,
      primaryAsset: row.primaryAsset,
      supportingAssets: Object.freeze(row.supportingAssets),
      targetQueryIds: Object.freeze(row.targetQueryIds),
      conversionPath: row.conversionPath,
      internalLinkPlan: Object.freeze(row.internalLinkPlan),
      boundaries: Object.freeze(row.boundaries),
    });
  });
}

function validateLiveEvidence(live, finalistIds) {
  if (!live || typeof live !== "object" || Array.isArray(live)) throw new Error("LIVE_EVIDENCE_INVALID");
  assert.equal(live.schemaVersion, 1);
  assert.equal(live.siteId, "cano-penal");
  assert.equal(live.acquisitionMode, "ORGANIC_ONLY");
  assert.equal(live.paidTrafficIncluded, false);
  assert.equal(live.searchEvidence.source, "AUTHORIZED_FIRST_PARTY_OR_QUERY_LEVEL_TRACKER");
  assert.equal(live.attributionLedger.anonymized, true);
  assert.equal(live.attributionLedger.completeForMeasurementWindow, true);
  assert(Array.isArray(live.finalists));
  assert.deepStrictEqual([...live.finalists.map((row) => row.strategyId)].sort(), [...finalistIds].sort());
  for (const row of live.finalists) {
    assert(Number.isSafeInteger(row.organicSessions) && row.organicSessions >= 0);
    assert(Number.isSafeInteger(row.qualifiedContacts) && row.qualifiedContacts >= 0);
    assert(Number.isSafeInteger(row.signedClients) && row.signedClients >= 0);
    assert(row.signedClients <= row.qualifiedContacts);
    assert(row.qualifiedContacts <= row.organicSessions);
    assert(Number.isSafeInteger(row.portfolioTop3Queries) && row.portfolioTop3Queries >= 0);
    assert(Number.isSafeInteger(row.portfolioTop5Queries) && row.portfolioTop5Queries >= 0);
  }
}

function buildStatProblem(live) {
  return Object.freeze({
    schemaVersion: 1,
    problemId: "cano-round4-live-organic-statistics-v1",
    objective: "Compute 99.9 percent Wilson intervals for signed-client conversion rates from attributable organic sessions. This does not by itself select a commercial winner.",
    tasks: live.finalists.map((row) => ({
      taskId: `round4-wilson-${row.strategyId}`,
      layerId: "GAUSS.STATS.WILSON.001",
      input: {
        successes: row.signedClients,
        trials: row.organicSessions,
        confidence: 0.999,
      },
    })),
  });
}

function axiomaSummary(report) {
  assert.equal(report.registryOperators, 1000);
  assert.equal(report.coveredOperators, 1000);
  assert.equal(report.untestedOperators, 0);
  assert.equal(report.failedValidCases, 0);
  assert.equal(report.failedInvalidRejections, 0);
  let found = false;
  for (const suite of report.suites) for (const row of suite.operatorResults) if (row.id === "GAUSS.STATS.WILSON.001") found = true;
  assert.equal(found, true);
  return Object.freeze({
    registryOperators: 1000,
    coveredOperators: 1000,
    untestedOperators: 0,
    targetedOperatorIds: Object.freeze(["GAUSS.STATS.WILSON.001"]),
  });
}

export async function runCanoRound4({ round3Report, gate, protocol, plan, liveEvidence = null }) {
  validateFoundation(round3Report, gate, protocol, plan);
  const finalists = finalistDefinitions(round3Report, plan);

  if (liveEvidence === null) {
    const unsigned = {
      schemaVersion: 1,
      tournamentId: "CANO_PENAL_CDMX_ZERO",
      stage: "ROUND_4_LIVE_ORGANIC_FINAL",
      status: "BLOCKED_LIVE_EVIDENCE_REQUIRED",
      round3ReportSha256: round3Report.reportSha256,
      finalistIds: round3Report.finalistIds,
      finalists,
      statisticalGateId: gate.gateId,
      requiredConfidence: gate.statisticalStandard.highConfidenceProbability,
      requiredComparisonPower: gate.statisticalStandard.comparisonPower,
      minimumSignedOrganicClientsPerMonth: gate.commercialTarget.minimumSignedClientsPerCalendarMonth,
      repeatabilityMonths: gate.commercialTarget.repeatabilityMonths,
      scenarioMatrix: gate.clientRateScenarioMatrix,
      requiredLiveInputs: Object.freeze([
        "AUTHORIZED_QUERY_LEVEL_SEARCH_VISIBILITY_OR_SEARCH_CONSOLE_PLUS_REPEATABLE_QUERY_LEVEL_RANK_MEASUREMENT",
        "ORGANIC_SESSIONS_BY_FINALIST_ENTRY_ASSET",
        "QUALIFIED_CONTACTS_BY_FINALIST",
        "ANONYMIZED_SIGNED_CLIENT_LEDGER_WITH_ORGANIC_ATTRIBUTION",
      ]),
      selectedStrategyId: null,
      commercialWinnerStatus: "NOT_ELIGIBLE_LIVE_EVIDENCE_MISSING",
      rankingWinnerStatus: "NOT_ELIGIBLE_QUERY_LEVEL_RANK_EVIDENCE_MISSING",
      gaussStatus: "NOT_EXECUTED_NO_LIVE_BINOMIAL_INPUT",
      axiomaStatus: "NOT_EXECUTED_NO_LIVE_BINOMIAL_INPUT",
      quantumStatus: "NOT_APPLICABLE_NO_ROUND4_ISING_TASK",
      decisionBoundary: "NO_LIVE_DATA_NO_WINNER_NO_FORECAST_NO_PRODUCTION_MUTATION",
    };
    return Object.freeze({ ...unsigned, reportSha256: sha256Canonical(unsigned) });
  }

  validateLiveEvidence(liveEvidence, round3Report.finalistIds);
  const [gauss, axioma] = await Promise.all([
    executeGaussProblem(buildStatProblem(liveEvidence), { quantumContributor: contributeNexusQuantum }),
    Promise.resolve().then(() => runAxioma()),
  ]);
  assert.equal(gauss.status, "PASS");
  assert.equal(gauss.quantumContribution?.status, "NOT_APPLICABLE");
  assert.equal(gauss.quantumContribution?.hardwareExecution, false);
  assert.equal(gauss.quantumContribution?.quantumAdvantageClaimAllowed, false);

  const stats = round3Report.finalistIds.map((id) => {
    const input = liveEvidence.finalists.find((row) => row.strategyId === id);
    const task = gauss.taskResults.find((row) => row.taskId === `round4-wilson-${id}`);
    assert.equal(task?.status, "EXECUTED");
    return Object.freeze({
      strategyId: id,
      organicSessions: input.organicSessions,
      qualifiedContacts: input.qualifiedContacts,
      signedClients: input.signedClients,
      portfolioTop3Queries: input.portfolioTop3Queries,
      portfolioTop5Queries: input.portfolioTop5Queries,
      signedClientRate: input.organicSessions === 0 ? null : input.signedClients / input.organicSessions,
      wilson999: task.output,
      commercialTargetMetThisWindow: input.signedClients >= 5,
    });
  });

  const targetMet = stats.filter((row) => row.commercialTargetMetThisWindow);
  const unsigned = {
    schemaVersion: 1,
    tournamentId: "CANO_PENAL_CDMX_ZERO",
    stage: "ROUND_4_LIVE_ORGANIC_FINAL",
    status: targetMet.length > 0 ? "LIVE_EVIDENCE_EVALUATED_NO_AUTOMATIC_CHAMPION" : "LIVE_EVIDENCE_EVALUATED_TARGET_NOT_MET",
    round3ReportSha256: round3Report.reportSha256,
    finalistIds: round3Report.finalistIds,
    statisticalGateId: gate.gateId,
    requiredConfidence: 0.999,
    requiredComparisonPower: 0.95,
    finalistStatistics: stats,
    commercialTargetMetStrategyIds: Object.freeze(targetMet.map((row) => row.strategyId)),
    gauss: Object.freeze({ engineId: gauss.engineId, status: gauss.status, reportSha256: gauss.reportSha256 }),
    axioma: axiomaSummary(axioma),
    quantum: Object.freeze({
      engineId: gauss.quantumContribution.engineId,
      status: gauss.quantumContribution.status,
      interpretation: "ROUND4_USES_BINOMIAL_STATISTICS_ONLY; QUANTUM_NOT_FORCED",
    }),
    selectedStrategyId: null,
    commercialWinnerStatus: "REQUIRES_STATISTICAL_COMPARISON_AND_REPEATABILITY_EVIDENCE",
    repeatabilityRequirement: "3_CONSECUTIVE_MONTHS_AT_OR_ABOVE_5_ATTRIBUTABLE_SIGNED_ORGANIC_CLIENTS",
    decisionBoundary: "ONE_MONTH_TARGET_OR_NONOVERLAPPING_POINT_ESTIMATES_DO_NOT_AUTOMATICALLY_DECLARE_CHAMPION",
  };
  return Object.freeze({ ...unsigned, reportSha256: sha256Canonical(unsigned) });
}

async function main(argv) {
  const args = parseArgs(argv);
  const [r3, gate, protocol, plan, live] = await Promise.all([
    readFile(args.round3).then((b) => JSON.parse(b)),
    readFile(gatePath).then((b) => JSON.parse(b)),
    readFile(protocolPath).then((b) => JSON.parse(b)),
    readFile(planPath).then((b) => JSON.parse(b)),
    args.live ? readFile(args.live).then((b) => JSON.parse(b)) : Promise.resolve(null),
  ]);
  const report = await runCanoRound4({ round3Report: r3, gate, protocol, plan, liveEvidence: live });
  const output = `${JSON.stringify(report, null, 2)}\n`;
  if (args.out) await writeFile(args.out, output); else process.stdout.write(output);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(error?.stack ?? String(error));
    process.exitCode = 1;
  });
}
