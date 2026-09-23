#!/usr/bin/env node
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { sha256Canonical } from "../../gauss/core/common.mjs";
import { executeGaussProblem } from "../../gauss/core/problem.mjs";
import { contributeNexusQuantum } from "../../gauss/core/quantum-contributor.mjs";
import { runAxioma } from "../../gauss/axioma/run.mjs";
import { buildCanoTournamentZero } from "./tournament-zero.mjs";
import { buildGaussRound0Problem, buildStrategyField, structuralShortlist, strategyFieldDigest } from "./strategy-field.mjs";

const here = new URL("./", import.meta.url);
const defaultIdentity = new URL("./identity.json", here);
const defaultAudit = new URL("./audit-evidence.json", here);
const defaultManifest = new URL("./audit-manifest.json", here);

function parseArgs(argv) {
  const result = { avengersSummary: null, out: null };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!["--avengers-summary", "--out"].includes(arg)) throw new Error(`unknown argument:${arg}`);
    const value = argv[i + 1];
    if (!value || value.startsWith("--")) throw new Error(`missing value for ${arg}`);
    if (arg === "--avengers-summary") result.avengersSummary = resolve(value);
    if (arg === "--out") result.out = resolve(value);
    i += 1;
  }
  if (!result.avengersSummary) throw new Error("AVENGERS_SUMMARY_REQUIRED");
  return result;
}

function summarizeAxioma(report) {
  assert.equal(report.registryOperators, 1000);
  assert.equal(report.coveredOperators, 1000);
  assert.equal(report.untestedOperators, 0);
  assert.equal(report.failedValidCases, 0);
  assert.equal(report.failedInvalidRejections, 0);
  const targeted = new Map();
  for (const suite of report.suites) for (const item of suite.operatorResults) {
    if (["GAUSS.MATH.PARETO.002", "GAUSS.PHYSICS.ISING_EXACT_GROUND.003"].includes(item.id)) targeted.set(item.id, item);
  }
  for (const id of ["GAUSS.MATH.PARETO.002", "GAUSS.PHYSICS.ISING_EXACT_GROUND.003"]) assert(targeted.has(id), `AXIOMA missing tournament operator:${id}`);
  return Object.freeze({
    registryOperators: report.registryOperators, coveredOperators: report.coveredOperators, untestedOperators: report.untestedOperators,
    validCases: report.validCases, passedValidCases: report.passedValidCases, failedValidCases: report.failedValidCases,
    invalidCases: report.invalidCases, passedInvalidRejections: report.passedInvalidRejections, failedInvalidRejections: report.failedInvalidRejections,
    targetedOperatorIds: Object.freeze([...targeted.keys()].sort()),
  });
}

function validateAvengersSummary(summary, auditSha256) {
  if (!summary || typeof summary !== "object" || Array.isArray(summary)) throw new Error("AVENGERS_SUMMARY_INVALID");
  if (summary.schemaVersion !== 1 || summary.engineId !== "SEO_AVENGERS_2500_CANO_ROUND0") throw new Error("AVENGERS_SUMMARY_IDENTITY_MISMATCH");
  if (summary.siteId !== "cano-penal" || summary.auditSha256 !== auditSha256) throw new Error("AVENGERS_SUMMARY_AUDIT_BINDING_MISMATCH");
  if (summary.moduleCount !== 2500 || summary.receiptCount !== 2500 || summary.errorCount !== 0) throw new Error("AVENGERS_FULL_2500_NOT_PROVEN");
  if (!Array.isArray(summary.ranges) || summary.ranges.length !== 6) throw new Error("AVENGERS_RANGE_SUMMARY_INVALID");
  return Object.freeze(structuredClone(summary));
}

export async function runCanoRound0({ identity, auditBytes, audit, auditManifest, avengersSummary }) {
  const zero = buildCanoTournamentZero(identity, { auditManifest, auditBytes });
  assert.equal(zero.status, "AUDIT_BOUND_STRATEGY_GENERATION_PENDING");
  assert.equal(zero.strategyCount, 0);
  const strategies = buildStrategyField(audit);
  const shortlist = structuralShortlist([...strategies]);
  const problem = buildGaussRound0Problem(strategies, shortlist);
  const [gauss, axioma] = await Promise.all([
    executeGaussProblem(problem, { quantumContributor: contributeNexusQuantum }),
    Promise.resolve().then(() => runAxioma()),
  ]);
  assert.equal(gauss.status, "PASS", JSON.stringify(gauss.errors));
  assert.equal(gauss.executedLayerCount, 2);
  assert.equal(gauss.failedLayerCount, 0);
  assert.equal(gauss.quantumContribution?.status, "EXECUTED");
  assert.equal(gauss.quantumContribution?.simulation?.verdict, "PASS");
  assert.equal(gauss.quantumContribution?.simulation?.hardwareExecution, false);
  assert.equal(gauss.quantumContribution?.simulation?.quantumAdvantageClaimAllowed, false);

  const pareto = gauss.taskResults.find((row) => row.taskId === "cano-structural-pareto");
  const ising = gauss.taskResults.find((row) => row.taskId === "cano-portfolio-diversity");
  assert.equal(pareto?.status, "EXECUTED");
  assert.equal(ising?.status, "EXECUTED");
  const frontierIds = Object.freeze([...(pareto.output?.frontierIds ?? [])].sort());
  const dominatedIds = Object.freeze([...(pareto.output?.dominatedIds ?? [])].sort());
  assert.equal(frontierIds.length + dominatedIds.length, 24);
  const spins = ising.output?.spins;
  if (!Array.isArray(spins) || spins.length !== shortlist.length) throw new Error("ISING_SHORTLIST_BINDING_INVALID");
  const portfolioSignalCandidateIds = Object.freeze(shortlist.filter((_, index) => spins[index] === 1).map((row) => row.id));

  const auditSha256 = auditManifest.evidenceSha256;
  const avengers = validateAvengersSummary(avengersSummary, auditSha256);
  const axiomaSummary = summarizeAxioma(axioma);
  const unsigned = {
    schemaVersion: 1, tournamentId: "CANO_PENAL_CDMX_ZERO", stage: "ROUND_0_INTEGRATED_FIELD", status: "PASS",
    auditSha256, zeroStateSha256: zero.stateSha256, strategyCount: strategies.length, strategyFieldSha256: strategyFieldDigest(strategies),
    strategies, structuralShortlistCount: shortlist.length, structuralShortlistIds: Object.freeze(shortlist.map((row) => row.id)),
    gauss: Object.freeze({
      engineId: gauss.engineId, status: gauss.status, problemSha256: gauss.problemSha256, reportSha256: gauss.reportSha256,
      structuralParetoFrontierIds: frontierIds, structuralParetoDominatedIds: dominatedIds,
    }),
    quantum: Object.freeze({
      engineId: gauss.quantumContribution.engineId, status: gauss.quantumContribution.status,
      sourceTaskId: gauss.quantumContribution.sourceTaskId, sourceTaskOutputSha256: gauss.quantumContribution.sourceTaskOutputSha256,
      simulationReceiptSha256: gauss.quantumContribution.simulation.receiptSha256,
      exactGroundStateEnergy: gauss.quantumContribution.simulation.exactGroundStateEnergy,
      portfolioSignalCandidateIds,
      interpretation: "BOUNDED_PORTFOLIO_DIVERSITY_SIGNAL_NOT_COMMERCIAL_WINNER_OR_QUANTUM_ADVANTAGE",
    }),
    axioma: axiomaSummary, avengers, selectedStrategyId: null, commercialWinnerStatus: "NOT_YET_ELIGIBLE",
    nextStage: "ROUND_1_DEEP_EVIDENCE_ANALYSIS_OF_12_STRUCTURAL_CANDIDATES",
    decisionBoundary: "NO_PRODUCTION_MUTATION_NO_RANKING_GUARANTEE_NO_CLIENT_FORECAST_NO_AUTONOMOUS_WINNER",
  };
  return Object.freeze({ ...unsigned, reportSha256: sha256Canonical(unsigned) });
}

async function main(argv) {
  const args = parseArgs(argv);
  const [identityBytes, auditBytes, manifestBytes, avengersBytes] = await Promise.all([
    readFile(defaultIdentity), readFile(defaultAudit), readFile(defaultManifest), readFile(args.avengersSummary),
  ]);
  const report = await runCanoRound0({
    identity: JSON.parse(identityBytes.toString("utf8")), auditBytes, audit: JSON.parse(auditBytes.toString("utf8")),
    auditManifest: JSON.parse(manifestBytes.toString("utf8")), avengersSummary: JSON.parse(avengersBytes.toString("utf8")),
  });
  const output = `${JSON.stringify(report, null, 2)}\n`;
  if (args.out) await writeFile(args.out, output); else process.stdout.write(output);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main(process.argv.slice(2)).catch((error) => {
  console.error(error?.stack ?? String(error));
  process.exitCode = 1;
});
