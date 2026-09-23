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
const defaultPublicEvidence = new URL("./round2-public-evidence-v1.json", here);

const EXPECTED_SIX = Object.freeze(["S01","S05","S10","S15","S18","S23"]);
const EXPECTED_FINALISTS = Object.freeze(["S01","S05","S23"]);
const ROLE_PRIORITY = Object.freeze([
  "FIRST_PARTY_ADS_BINDING",
  "OWNED_PUBLIC_ASSET_EVIDENCE",
  "OFFICIAL_SOURCE_EVIDENCE",
  "TOTAL_PUBLIC_FACTS",
  "LOWER_EXPLICIT_COMPETITOR_COUNT",
]);

function parseArgs(argv) {
  const out = { round0Report: null, round1Report: null, out: null };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!["--round0-report","--round1-report","--out"].includes(arg)) throw new Error(`unknown argument:${arg}`);
    const value = argv[i + 1];
    if (!value || value.startsWith("--")) throw new Error(`missing value for ${arg}`);
    if (arg === "--round0-report") out.round0Report = resolve(value);
    if (arg === "--round1-report") out.round1Report = resolve(value);
    if (arg === "--out") out.out = resolve(value);
    i += 1;
  }
  if (!out.round0Report || !out.round1Report) throw new Error("ROUND0_AND_ROUND1_REPORT_REQUIRED");
  return out;
}

function validateReportHash(report, label) {
  if (!report || typeof report !== "object" || Array.isArray(report)) throw new Error(`${label}_INVALID`);
  const { reportSha256, ...unsigned } = report;
  assert.equal(reportSha256, sha256Canonical(unsigned), `${label} report SHA mismatch`);
  return reportSha256;
}

function validateInputs(round0, round1, publicEvidence) {
  const round0Sha = validateReportHash(round0, "ROUND0");
  const round1Sha = validateReportHash(round1, "ROUND1");
  assert.equal(round0.stage, "ROUND_0_INTEGRATED_FIELD");
  assert.equal(round0.status, "PASS");
  assert.equal(round0.avengers?.moduleCount, 2500);
  assert.equal(round0.avengers?.receiptCount, 2500);
  assert.equal(round0.avengers?.errorCount, 0);
  assert.equal(round1.stage, "ROUND_1_FIRST_PARTY_EVIDENCE");
  assert.equal(round1.round0ReportSha256, round0Sha);
  assert.equal(round1.status, "PASS_WITH_ONE_UNRESOLVED_SLOT");
  assert.deepStrictEqual(round1.advancedCandidateIds, ["S01","S05","S10","S15","S23"]);
  assert.deepStrictEqual(round1.unresolvedFamilyIds, ["F5_ACCOUNTANT_BUSINESS_CHANNEL"]);
  assert.equal(round1.adsReadOnly, true);
  assert.equal(round1.providerReplayInCi, false);
  assert.equal(round1.selectedStrategyId, null);

  assert.equal(publicEvidence.schemaVersion, 1);
  assert.equal(publicEvidence.evidenceId, "CANO_ROUND2_PUBLIC_MARKET_V1");
  assert.equal(publicEvidence.siteId, "cano-penal");
  assert.equal(publicEvidence.interpretation, "PUBLIC_MARKET_AND_OFFICIAL_SOURCE_EVIDENCE_FOR_TEST_READINESS_NOT_FIRST_PARTY_DEMAND_OR_OUTCOME_PROOF");
  assert.deepStrictEqual(publicEvidence.sixCandidateSet, EXPECTED_SIX);
  assert.deepStrictEqual(publicEvidence.roleGroups, {
    demandCapture: ["S01","S10"],
    demandCreation: ["S05","S18"],
    conversionInfrastructure: ["S15","S23"],
  });
  assert.equal(publicEvidence.candidateEvidence.S18.status, "SUPPORTED_EXTERNAL_AUDIENCE_TEST");
  assert(publicEvidence.candidateEvidence.S18.boundary.includes("DOES_NOT_PROVE_CANO_SUBSCRIBER_DEMAND"));
  assert(publicEvidence.hardBoundaries.includes("NO_PUBLIC_INTEREST_SIGNAL_AS_CANO_CONVERSION_PROOF"));
  return Object.freeze({ round0Sha, round1Sha });
}

function lexicographicScore(profile) {
  // Decimal places encode an explicit lexicographic policy. Lower-priority
  // dimensions can never overturn a higher-priority dimension in this bounded set.
  return (
    profile.firstPartyAdsBinding * 1_000_000_000
    + profile.ownedPublicAssetEvidence * 1_000_000
    + profile.officialSourceEvidence * 1_000
    + profile.totalPublicFacts * 10
    - profile.explicitCompetitorCount
  );
}

export function buildReadinessProfiles(round1, publicEvidence) {
  const profiles = [];
  for (const candidateId of EXPECTED_SIX) {
    const entry = publicEvidence.candidateEvidence[candidateId];
    if (!entry || !Array.isArray(entry.facts) || entry.facts.length < 1) throw new Error(`ROUND2_PUBLIC_EVIDENCE_MISSING:${candidateId}`);
    const owned = entry.facts.filter((row) => row.kind === "FIRST_PARTY_PUBLIC_SITE").length;
    const official = entry.facts.filter((row) => row.kind === "OFFICIAL").length;
    const competitors = entry.facts.filter((row) => row.kind === "COMPETITOR_PUBLIC_SITE").length;
    const firstPartyAdsBinding = candidateId === "S23"
      && round1.adsFindings?.primaryConversionAction === "WhatsApp - canopenal"
      && round1.adsFindings?.trackedPrimaryConversions90d === 2
      ? 1 : 0;
    const profile = {
      candidateId,
      firstPartyAdsBinding,
      ownedPublicAssetEvidence: owned,
      officialSourceEvidence: official,
      totalPublicFacts: entry.facts.length,
      explicitCompetitorCount: competitors,
      publicEvidenceStatus: entry.status,
    };
    profiles.push(Object.freeze({ ...profile, lexicographicTestReadiness: lexicographicScore(profile) }));
  }
  return Object.freeze(profiles);
}

export function buildRound2Problem(profiles, roleGroups) {
  const byId = new Map(profiles.map((row) => [row.candidateId, row]));
  const points = profiles.map((row) => ({
    id: row.candidateId,
    values: [
      row.firstPartyAdsBinding,
      row.ownedPublicAssetEvidence,
      row.officialSourceEvidence,
      row.totalPublicFacts,
      row.explicitCompetitorCount,
    ],
  }));
  const order = [...EXPECTED_SIX];
  const fields = order.map((id) => -byId.get(id).lexicographicTestReadiness);
  const couplings = [];
  for (const pair of Object.values(roleGroups)) {
    assert.equal(pair.length, 2);
    const [leftId, rightId] = pair;
    const i = order.indexOf(leftId);
    const j = order.indexOf(rightId);
    assert(i >= 0 && j >= 0 && i < j);
    const pairPenalty = Math.max(
      byId.get(leftId).lexicographicTestReadiness,
      byId.get(rightId).lexicographicTestReadiness,
    ) + 1;
    couplings.push({ i, j, value: pairPenalty });
  }
  return Object.freeze({
    schemaVersion: 1,
    problemId: "cano-penal-cdmx-round2-v1",
    objective: "Audit six test-ready candidates on raw evidence dimensions and solve a bounded one-per-role portfolio model. The lexicographic readiness policy is explicit and is not a commercial outcome forecast.",
    tasks: [
      {
        taskId: "cano-round2-evidence-pareto",
        layerId: "GAUSS.MATH.PARETO.002",
        input: { points, objectives: ["MAX","MAX","MAX","MAX","MIN"] },
      },
      {
        taskId: "cano-round2-role-portfolio",
        layerId: "GAUSS.PHYSICS.ISING_EXACT_GROUND.003",
        input: { fields, couplings, offset: 0 },
      },
    ],
  });
}

function summarizeAxioma(report) {
  assert.equal(report.registryOperators, 1000);
  assert.equal(report.coveredOperators, 1000);
  assert.equal(report.untestedOperators, 0);
  assert.equal(report.failedValidCases, 0);
  assert.equal(report.failedInvalidRejections, 0);
  const required = new Set(["GAUSS.MATH.PARETO.002","GAUSS.PHYSICS.ISING_EXACT_GROUND.003"]);
  for (const suite of report.suites) for (const item of suite.operatorResults) required.delete(item.id);
  assert.equal(required.size, 0, `AXIOMA missing Round 2 operators:${[...required].join(",")}`);
  return Object.freeze({
    registryOperators: report.registryOperators,
    coveredOperators: report.coveredOperators,
    untestedOperators: report.untestedOperators,
    validCases: report.validCases,
    passedValidCases: report.passedValidCases,
    invalidCases: report.invalidCases,
    passedInvalidRejections: report.passedInvalidRejections,
    targetedOperatorIds: Object.freeze(["GAUSS.MATH.PARETO.002","GAUSS.PHYSICS.ISING_EXACT_GROUND.003"]),
  });
}

export async function runCanoRound2({ round0Report, round1Report, publicEvidence }) {
  const bindings = validateInputs(round0Report, round1Report, publicEvidence);
  const profiles = buildReadinessProfiles(round1Report, publicEvidence);
  const problem = buildRound2Problem(profiles, publicEvidence.roleGroups);
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

  const pareto = gauss.taskResults.find((row) => row.taskId === "cano-round2-evidence-pareto");
  const ising = gauss.taskResults.find((row) => row.taskId === "cano-round2-role-portfolio");
  assert.equal(pareto?.status, "EXECUTED");
  assert.equal(ising?.status, "EXECUTED");
  const spins = ising.output?.spins;
  assert(Array.isArray(spins) && spins.length === EXPECTED_SIX.length);
  const finalistIds = Object.freeze(EXPECTED_SIX.filter((_, index) => spins[index] === 1));
  assert.deepStrictEqual(finalistIds, EXPECTED_FINALISTS);

  for (const pair of Object.values(publicEvidence.roleGroups)) {
    assert.equal(pair.filter((id) => finalistIds.includes(id)).length, 1, `Round 2 must select exactly one candidate from role pair:${pair.join(",")}`);
  }
  const reserves = Object.freeze(EXPECTED_SIX.filter((id) => !finalistIds.includes(id)));
  const publicEvidenceSha256 = sha256Canonical(publicEvidence);
  const axiomaSummary = summarizeAxioma(axioma);

  const unsigned = {
    schemaVersion: 1,
    tournamentId: "CANO_PENAL_CDMX_ZERO",
    stage: "ROUND_2_ROLE_DIVERSE_FINALISTS",
    status: "PASS",
    round0ReportSha256: bindings.round0Sha,
    round1ReportSha256: bindings.round1Sha,
    publicEvidenceSha256,
    publicSourceReplayInCi: false,
    avengers: Object.freeze({
      moduleCount: round0Report.avengers.moduleCount,
      receiptCount: round0Report.avengers.receiptCount,
      successCount: round0Report.avengers.successCount,
      insufficientDataCount: round0Report.avengers.insufficientDataCount,
      errorCount: round0Report.avengers.errorCount,
      summarySha256: round0Report.avengers.summarySha256,
      interpretation: "ROUND0_FULL_2500_EXECUTION_IS_REUSED_AS_BOUND_ENGINE_EVIDENCE; NO_NEW_GSC_OR_CRM_PROVIDER_DATA_WAS_INVENTED_FOR_ROUND2",
    }),
    sixCandidateIds: EXPECTED_SIX,
    readinessPolicy: ROLE_PRIORITY,
    readinessProfiles: profiles,
    gauss: Object.freeze({
      engineId: gauss.engineId,
      status: gauss.status,
      problemSha256: gauss.problemSha256,
      reportSha256: gauss.reportSha256,
      evidenceParetoFrontierIds: Object.freeze([...(pareto.output?.frontierIds ?? [])].sort()),
      evidenceParetoDominatedIds: Object.freeze([...(pareto.output?.dominatedIds ?? [])].sort()),
      rolePortfolioEnergy: ising.output.energy,
      rolePortfolioDegeneracy: ising.output.degeneracy,
      interpretation: "RAW_EVIDENCE_PARETO_AND_EXPLICIT_TEST_READINESS_PORTFOLIO_NOT_COMMERCIAL_OUTCOME_RANKING",
    }),
    quantum: Object.freeze({
      engineId: gauss.quantumContribution.engineId,
      status: gauss.quantumContribution.status,
      sourceTaskId: gauss.quantumContribution.sourceTaskId,
      simulationReceiptSha256: gauss.quantumContribution.simulation.receiptSha256,
      hardwareExecution: false,
      quantumAdvantageClaimAllowed: false,
      interpretation: "CLASSICAL_STATEVECTOR_CHECK_OF_BOUNDED_ROLE_PORTFOLIO_NO_QPU_NO_ADVANTAGE_CLAIM",
    }),
    axioma: axiomaSummary,
    finalistIds,
    finalistCount: finalistIds.length,
    reserveCandidateIds: reserves,
    commercialWinnerStatus: "NOT_YET_ELIGIBLE",
    nextStage: "ROUND_3_CONTROLLED_EXPERIMENT_DESIGN_FOR_S01_S05_S23",
    finalistInterpretation: Object.freeze({
      S01: "HIGH_INTENT_PENAL_FISCAL_CAPTURE_CHALLENGER",
      S05: "INTERACTIVE_PREVENTIVE_DEMAND_CREATION_CHALLENGER",
      S23: "FIRST_PARTY_WHATSAPP_CONVERSION_INFRASTRUCTURE_CHALLENGER",
    }),
    reserveInterpretation: Object.freeze({
      S10: "URGENT_DETENTION_ROUTE_REMAINS_VALID_BUT_IS_NOT_NOVEL_AND_CURRENT_ADS_SLICE_HAS_NO_PRIMARY_CONVERSION_PROOF",
      S15: "DIAGNOSTIC_METHOD_IS_A_SUPPORTING_TRUST_LAYER_AND_HAS_NO_ATTRIBUTED_DIAGNOSTIC_TO_CLIENT_OUTCOME",
      S18: "MONTHLY_BRIEF_IS_TESTABLE_EXTERNAL_AUDIENCE_SUPPORT_AND_CAN_SERVE_AS_DISTRIBUTION_LAYER_FOR_S05",
    }),
    selectedStrategyId: null,
    decisionBoundary: "NO_COMMERCIAL_WINNER_NO_PRODUCTION_MUTATION_NO_ADS_WRITE_NO_PUBLIC_INTEREST_AS_CLIENT_OUTCOME_NO_QPU_OR_QUANTUM_ADVANTAGE_CLAIM",
  };
  return Object.freeze({ ...unsigned, reportSha256: sha256Canonical(unsigned) });
}

async function main(argv) {
  const args = parseArgs(argv);
  const [round0Bytes, round1Bytes, publicBytes] = await Promise.all([
    readFile(args.round0Report),
    readFile(args.round1Report),
    readFile(defaultPublicEvidence),
  ]);
  const report = await runCanoRound2({
    round0Report: JSON.parse(round0Bytes.toString("utf8")),
    round1Report: JSON.parse(round1Bytes.toString("utf8")),
    publicEvidence: JSON.parse(publicBytes.toString("utf8")),
  });
  const output = `${JSON.stringify(report, null, 2)}\n`;
  if (args.out) await writeFile(args.out, output); else process.stdout.write(output);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(error?.stack ?? String(error));
    process.exitCode = 1;
  });
}
