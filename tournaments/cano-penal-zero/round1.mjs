#!/usr/bin/env node
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { sha256Canonical } from "../../gauss/core/common.mjs";
import { executeGaussProblem } from "../../gauss/core/problem.mjs";
import { contributeNexusQuantum } from "../../gauss/core/quantum-contributor.mjs";
import { runAxioma } from "../../gauss/axioma/run.mjs";

const here = new URL("./", import.meta.url);
const defaultAdsEvidence = new URL("./ads-evidence-v1.json", here);
const defaultAdsManifest = new URL("./ads-evidence-manifest-v1.json", here);

const ADS_SIGNAL_MAP = Object.freeze({
  S01: Object.freeze(["ADS_TAX_FISCAL_NOT_CURRENTLY_TESTED"]),
  S04: Object.freeze(["ADS_TAX_FISCAL_NOT_CURRENTLY_TESTED"]),
  S05: Object.freeze([]),
  S06: Object.freeze([]),
  S09: Object.freeze(["ADS_INSTITUTIONAL_LEAKAGE", "ADS_CITATORIO_SLICE"]),
  S10: Object.freeze(["ADS_INSTITUTIONAL_LEAKAGE", "ADS_DETENTION_SLICE"]),
  S13: Object.freeze([]),
  S15: Object.freeze([]),
  S18: Object.freeze([]),
  S19: Object.freeze([]),
  S22: Object.freeze(["ADS_WHATSAPP_PRIMARY_ACTION"]),
  S23: Object.freeze(["ADS_WHATSAPP_PRIMARY_ACTION", "ADS_WHATSAPP_PRIMARY_ACTION_RECENT"]),
});

function parseArgs(argv) {
  const result = { round0Report: null, out: null };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!["--round0-report", "--out"].includes(arg)) throw new Error(`unknown argument:${arg}`);
    const value = argv[i + 1];
    if (!value || value.startsWith("--")) throw new Error(`missing value for ${arg}`);
    if (arg === "--round0-report") result.round0Report = resolve(value);
    if (arg === "--out") result.out = resolve(value);
    i += 1;
  }
  if (!result.round0Report) throw new Error("ROUND0_REPORT_REQUIRED");
  return result;
}

function sha256Bytes(bytes) {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function ppm(numerator, denominator) {
  if (!Number.isSafeInteger(numerator) || !Number.isSafeInteger(denominator) || denominator <= 0) throw new Error("PPM_INPUT_INVALID");
  return Math.round((numerator / denominator) * 1_000_000);
}

function validateRound0(report) {
  if (!report || typeof report !== "object" || Array.isArray(report)) throw new Error("ROUND0_INVALID");
  assert.equal(report.schemaVersion, 1);
  assert.equal(report.tournamentId, "CANO_PENAL_CDMX_ZERO");
  assert.equal(report.stage, "ROUND_0_INTEGRATED_FIELD");
  assert.equal(report.status, "PASS");
  assert.equal(report.strategyCount, 24);
  assert.equal(report.structuralShortlistCount, 12);
  assert.equal(report.selectedStrategyId, null);
  assert.equal(report.commercialWinnerStatus, "NOT_YET_ELIGIBLE");
  const { reportSha256, ...unsigned } = report;
  assert.equal(reportSha256, sha256Canonical(unsigned), "Round 0 report SHA mismatch");
  const expected = ["S01","S04","S05","S06","S09","S10","S13","S15","S18","S19","S22","S23"];
  assert.deepStrictEqual(report.structuralShortlistIds, expected);
  const byId = new Map(report.strategies.map((row) => [row.id, row]));
  for (const id of expected) assert(byId.has(id), `Round 0 shortlist strategy missing:${id}`);
  return Object.freeze({ reportSha256, shortlist: Object.freeze(expected.map((id) => byId.get(id))) });
}

function validateAdsEvidence(evidence, bytes, manifest) {
  if (!evidence || typeof evidence !== "object" || Array.isArray(evidence)) throw new Error("ADS_EVIDENCE_INVALID");
  assert.equal(evidence.schemaVersion, 1);
  assert.equal(evidence.evidenceId, "CANO_GOOGLE_ADS_FIRST_PARTY_V1");
  assert.equal(evidence.siteId, "cano-penal");
  assert.equal(evidence.source.provider, "GOOGLE_ADS");
  assert.equal(evidence.source.accessMode, "READ_ONLY_CONNECTED_ACCOUNT");
  assert.equal(evidence.source.providerReplayInCi, false);
  assert.equal(manifest.schemaVersion, 1);
  assert.equal(manifest.evidenceId, evidence.evidenceId);
  assert.equal(manifest.siteId, evidence.siteId);
  assert.equal(manifest.providerReplayInCi, false);
  assert.equal(manifest.evidenceSha256, sha256Bytes(bytes), "ADS_EVIDENCE_SHA_MISMATCH");

  const c = evidence.campaign90d;
  assert.equal(c.campaignName, "CL | Leads-Search | PENAL");
  assert.equal(c.status, "ENABLED");
  assert.equal(c.adGroupName, "PENAL");
  assert.equal(c.biddingStrategyType, "TARGET_SPEND");
  assert.equal(c.dailyBudgetMxnMicros, 328_000_000);
  assert.equal(c.primaryConversions, 2);
  assert.equal(evidence.primaryConversionSemantics.observedPrimaryActions90d.length, 1);
  assert.equal(evidence.primaryConversionSemantics.observedPrimaryActions90d[0].action, "WhatsApp - canopenal");
  assert.equal(evidence.primaryConversionSemantics.observedPrimaryActions90d[0].primaryConversions, 2);
  assert.equal(evidence.campaign30d.primaryConversions, 2);
  assert.equal(evidence.primaryConversionSemantics.observedPrimaryActions30d[0].primaryConversions, 2);

  const broad = evidence.broadKeywordConcentration90d;
  assert.equal(broad.keywords.length, 2);
  assert.equal(broad.combinedPrimaryConversions, 0);
  assert.equal(broad.shareOfCampaignClicksPpm, ppm(broad.combinedClicks, c.clicks));
  assert.equal(broad.shareOfCampaignImpressionsPpm, ppm(broad.combinedImpressions, c.impressions));
  assert.equal(broad.shareOfCampaignCostPpm, ppm(broad.combinedCostMxnMicros, c.costMxnMicros));

  const institutional = evidence.institutionalLeakage90d;
  assert.equal(institutional.fiscaliaTerms.primaryConversions, 0);
  assert.equal(institutional.ministerioPublicoTerms.primaryConversions, 0);
  assert.equal(institutional.configuredPositiveCriterion.keyword, "ministerio público");
  assert.equal(institutional.configuredPositiveCriterion.matchType, "BROAD");
  assert.equal(institutional.observedCriteria.fiscaliaNegativeObserved, false);

  const destinations = evidence.adDestinations90d;
  assert.equal(destinations.allActiveSearchAdFinalUrlsAreHomepage, true);
  assert.equal(destinations.activeCampaignAdRows.length, 4);
  assert.equal(destinations.activeCampaignAdRows.reduce((sum, row) => sum + row.clicks, 0), c.clicks);
  assert.equal(destinations.activeCampaignAdRows.reduce((sum, row) => sum + row.impressions, 0), c.impressions);
  assert.equal(destinations.activeCampaignAdRows.reduce((sum, row) => sum + row.costMxnMicros, 0), c.costMxnMicros);
  assert.equal(destinations.activeCampaignAdRows.reduce((sum, row) => sum + row.primaryConversions, 0), c.primaryConversions);
  assert(destinations.activeCampaignAdRows.every((row) => row.finalUrls.length === 1 && row.finalUrls[0] === "https://www.canopenal.com/"));

  const convertingTerms = evidence.primaryConvertingSearchTerms90d;
  assert.equal(convertingTerms.length, 2);
  assert.deepStrictEqual(convertingTerms.map((row) => row.query), ["abogado penal","abogado penalista"]);
  assert.equal(convertingTerms.reduce((sum, row) => sum + row.primaryConversions, 0), c.primaryConversions);
  assert(convertingTerms.every((row) => row.primaryConversions === 1));

  const taxFiscal = evidence.intentSlices90d.trueTaxFiscalObservedTerms;
  assert.equal(taxFiscal.length, 2);
  assert.equal(taxFiscal.reduce((sum, row) => sum + row.impressions, 0), 2);
  assert.equal(taxFiscal.reduce((sum, row) => sum + row.clicks, 0), 0);
  assert(evidence.interpretationBoundaries.includes("PRIMARY_CONVERSION_IS_ADS_TRACKED_ACTION_NOT_SIGNED_CLIENT"));
  assert(evidence.interpretationBoundaries.includes("CURRENT_CAMPAIGN_EXPOSURE_IS_NOT_TOTAL_MARKET_DEMAND"));
  return Object.freeze({ evidenceSha256: manifest.evidenceSha256 });
}

function axiomaSummary(report) {
  assert.equal(report.registryOperators, 1000);
  assert.equal(report.coveredOperators, 1000);
  assert.equal(report.untestedOperators, 0);
  assert.equal(report.failedValidCases, 0);
  assert.equal(report.failedInvalidRejections, 0);
  const required = new Set(["GAUSS.MATH.PARETO.002", "GAUSS.STATS.WILSON.001"]);
  for (const suite of report.suites) for (const item of suite.operatorResults) required.delete(item.id);
  assert.equal(required.size, 0, `AXIOMA missing Round 1 operators:${[...required].join(",")}`);
  return Object.freeze({
    registryOperators: report.registryOperators,
    coveredOperators: report.coveredOperators,
    untestedOperators: report.untestedOperators,
    validCases: report.validCases,
    passedValidCases: report.passedValidCases,
    invalidCases: report.invalidCases,
    passedInvalidRejections: report.passedInvalidRejections,
    targetedOperatorIds: Object.freeze(["GAUSS.MATH.PARETO.002", "GAUSS.STATS.WILSON.001"]),
  });
}

function buildRound1Problem(shortlist, ads) {
  const points = shortlist.map((row) => ({
    id: row.id,
    values: [
      ADS_SIGNAL_MAP[row.id]?.length ?? 0,
      row.structuralMetrics.usableEvidenceCount,
      row.structuralMetrics.uncertainEvidenceCount,
      row.structuralMetrics.dependencyCount,
    ],
  }));
  return Object.freeze({
    schemaVersion: 1,
    problemId: "cano-penal-cdmx-round1-v1",
    objective: "Measure first-party evidence readiness of the 12 structural survivors and quantify the observed Google Ads primary-conversion proportion. These are evidence diagnostics, not commercial outcome forecasts.",
    tasks: [
      {
        taskId: "cano-round1-evidence-pareto",
        layerId: "GAUSS.MATH.PARETO.002",
        input: { points, objectives: ["MAX", "MAX", "MIN", "MIN"] },
      },
      {
        taskId: "cano-ads-primary-conversion-wilson",
        layerId: "GAUSS.STATS.WILSON.001",
        input: { successes: ads.campaign90d.primaryConversions, trials: ads.campaign90d.clicks, confidence: 0.95 },
      },
    ],
  });
}

function familyDecisions(shortlist, ads) {
  const ids = new Set(shortlist.map((row) => row.id));
  for (const id of Object.keys(ADS_SIGNAL_MAP)) if (!ids.has(id)) throw new Error(`ADS_SIGNAL_MAP_NOT_SHORTLISTED:${id}`);
  const requirePair = (a, b) => { if (!ids.has(a) || !ids.has(b)) throw new Error(`ROUND1_PAIR_MISSING:${a}:${b}`); };
  requirePair("S01","S04"); requirePair("S05","S06"); requirePair("S09","S10");
  requirePair("S13","S15"); requirePair("S18","S19"); requirePair("S22","S23");

  assert(ads.intentSlices90d.detention.impressions > ads.intentSlices90d.citatorio.impressions);
  assert(ads.intentSlices90d.detention.clicks > ads.intentSlices90d.citatorio.clicks);
  assert.equal(ads.intentSlices90d.detention.primaryConversions, 0);
  assert.equal(ads.intentSlices90d.citatorio.primaryConversions, 0);
  assert.equal(ads.primaryConversionSemantics.observedPrimaryActions90d[0].action, "WhatsApp - canopenal");

  return Object.freeze([
    Object.freeze({
      familyId: "F1_PENAL_FISCAL_CAPTURE", status: "ADVANCE_TEST_READY", candidateId: "S01", heldCandidateId: "S04",
      reason: "EXISTING_FISCAL_HUB_FIRST; CURRENT_ADS_CAMPAIGN_HAS_NOT_MEANINGFULLY_TESTED_TRUE_TAX_FISCAL_DEMAND",
    }),
    Object.freeze({
      familyId: "F2_INTERACTIVE_FISCAL_PREVENTION", status: "ADVANCE_TEST_READY", candidateId: "S05", heldCandidateId: "S06",
      reason: "BASE_INTERACTIVE_PRODUCT_PRECEDES_ALERT_LAYER; ALERTS_ADD_CONSENT_AND_OPERATIONAL_DEPENDENCIES",
    }),
    Object.freeze({
      familyId: "F3_URGENT_CRIMINAL_INTENT", status: "ADVANCE_TEST_READY", candidateId: "S10", heldCandidateId: "S09",
      reason: "CURRENT_CAMPAIGN_OBSERVED_MORE_DETENTION_SEARCH_ACTIVITY_THAN_CITATORIO; NEITHER HAS PRIMARY_CONVERSION_PROOF",
    }),
    Object.freeze({
      familyId: "F4_AUTHORITY_PROOF", status: "ADVANCE_TEST_READY", candidateId: "S15", heldCandidateId: "S13",
      reason: "DIAGNOSTIC_IS_AN_EXISTING_TRANSACTIONAL_OFFER; TIMELINE_REMAINS_SUPPORTING_TRUST_LAYER_NOT_DISPROVEN",
    }),
    Object.freeze({
      familyId: "F5_ACCOUNTANT_BUSINESS_CHANNEL", status: "INSUFFICIENT_DATA", candidateId: null, heldCandidateId: null,
      unresolvedCandidateIds: Object.freeze(["S18","S19"]),
      reason: "NO_FIRST_PARTY_ACCOUNTANT_OR_REFERRAL_DEMAND_AND_NO_ATTRIBUTED_BUSINESS_OUTCOME_DATA",
    }),
    Object.freeze({
      familyId: "F6_LOCAL_CONVERSION_TRUST", status: "ADVANCE_TEST_READY", candidateId: "S23", heldCandidateId: "S22",
      reason: "WHATSAPP_IS_THE_ONLY_OBSERVED_PRIMARY_GOOGLE_ADS_CONVERSION_ACTION; DIAGNOSTIC_TO_CONTRACT_OUTCOME_REMAINS_MISSING",
    }),
  ]);
}

export async function runCanoRound1({ round0Report, adsEvidence, adsBytes, adsManifest }) {
  const round0 = validateRound0(round0Report);
  const adsBinding = validateAdsEvidence(adsEvidence, adsBytes, adsManifest);
  const problem = buildRound1Problem(round0.shortlist, adsEvidence);
  const [gauss, axioma] = await Promise.all([
    executeGaussProblem(problem, { quantumContributor: contributeNexusQuantum }),
    Promise.resolve().then(() => runAxioma()),
  ]);
  assert.equal(gauss.status, "PASS", JSON.stringify(gauss.errors));
  assert.equal(gauss.quantumContribution?.status, "NOT_APPLICABLE");
  assert.equal(gauss.quantumContribution?.hardwareExecution, false);
  assert.equal(gauss.quantumContribution?.quantumAdvantageClaimAllowed, false);

  const pareto = gauss.taskResults.find((row) => row.taskId === "cano-round1-evidence-pareto");
  const wilson = gauss.taskResults.find((row) => row.taskId === "cano-ads-primary-conversion-wilson");
  assert.equal(pareto?.status, "EXECUTED");
  assert.equal(wilson?.status, "EXECUTED");
  const decisions = familyDecisions(round0.shortlist, adsEvidence);
  const advancedCandidateIds = Object.freeze(decisions.filter((row) => row.status === "ADVANCE_TEST_READY").map((row) => row.candidateId));
  assert.deepStrictEqual(advancedCandidateIds, ["S01","S05","S10","S15","S23"]);
  const unresolved = decisions.filter((row) => row.status === "INSUFFICIENT_DATA");
  assert.equal(unresolved.length, 1);

  const unsigned = {
    schemaVersion: 1,
    tournamentId: "CANO_PENAL_CDMX_ZERO",
    stage: "ROUND_1_FIRST_PARTY_EVIDENCE",
    status: "PASS_WITH_ONE_UNRESOLVED_SLOT",
    round0ReportSha256: round0.reportSha256,
    adsEvidenceSha256: adsBinding.evidenceSha256,
    providerReplayInCi: false,
    adsReadOnly: true,
    shortlistInputIds: Object.freeze(round0.shortlist.map((row) => row.id)),
    familyDecisions: decisions,
    advancedCandidateIds,
    advancedCount: advancedCandidateIds.length,
    unresolvedFamilyIds: Object.freeze(unresolved.map((row) => row.familyId)),
    gauss: Object.freeze({
      engineId: gauss.engineId,
      status: gauss.status,
      reportSha256: gauss.reportSha256,
      evidenceParetoFrontierIds: Object.freeze([...(pareto.output?.frontierIds ?? [])].sort()),
      evidenceParetoDominatedIds: Object.freeze([...(pareto.output?.dominatedIds ?? [])].sort()),
      trackedPrimaryConversionWilson95: Object.freeze(structuredClone(wilson.output)),
      interpretation: "ADS_TRACKING_PROPORTION_AND_EVIDENCE_FRONTIER_NOT_SIGNED_CLIENT_RATE_OR_STRATEGY_WINNER",
    }),
    quantum: Object.freeze({
      engineId: gauss.quantumContribution.engineId,
      status: gauss.quantumContribution.status,
      receiptSha256: gauss.quantumContribution.receiptSha256,
      reasonCodes: gauss.quantumContribution.reasonCodes,
      interpretation: "NO_ISING_SUBPROBLEM_IN_ROUND1; QUANTUM_NOT_FORCED_DECORATIVELY",
    }),
    axioma: axiomaSummary(axioma),
    adsFindings: Object.freeze({
      biddingStrategyType: adsEvidence.campaign90d.biddingStrategyType,
      dailyBudgetMxnMicros: adsEvidence.campaign90d.dailyBudgetMxnMicros,
      clicks90d: adsEvidence.campaign90d.clicks,
      impressions90d: adsEvidence.campaign90d.impressions,
      costMxnMicros90d: adsEvidence.campaign90d.costMxnMicros,
      trackedPrimaryConversions90d: adsEvidence.campaign90d.primaryConversions,
      primaryConversionAction: "WhatsApp - canopenal",
      primaryConvertingSearchTerms90d: Object.freeze(adsEvidence.primaryConvertingSearchTerms90d.map((row) => row.query)),
      broadTwoKeywordCostSharePpm: adsEvidence.broadKeywordConcentration90d.shareOfCampaignCostPpm,
      fiscaliaLeakageCostMxnMicros90d: adsEvidence.institutionalLeakage90d.fiscaliaTerms.costMxnMicros,
      ministerioPublicoLeakageCostMxnMicros90d: adsEvidence.institutionalLeakage90d.ministerioPublicoTerms.costMxnMicros,
      configuredBroadMinisterioPublico: true,
      allActiveSearchAdFinalUrlsAreHomepage: adsEvidence.adDestinations90d.allActiveSearchAdFinalUrlsAreHomepage,
      trueTaxFiscalObservedImpressions90d: adsEvidence.intentSlices90d.trueTaxFiscalObservedTerms.reduce((sum, row) => sum + row.impressions, 0),
    }),
    paidSearchPrerequisite: "PRESERVE_OBSERVED_CONVERTING_GENERIC_TERMS_WHILE_ENFORCING_QUERY_HYGIENE_AND_INTENT_ISOLATION_BEFORE_NEW_PAID_SEARCH_TESTS",
    penalFiscalPaidDemandStatus: "NOT_ESTABLISHED_BY_CURRENT_CAMPAIGN",
    selectedStrategyId: null,
    commercialWinnerStatus: "NOT_YET_ELIGIBLE",
    nextStage: "ROUND_2_DEEP_ANALYSIS_OF_FIVE_ADVANCED_PLUS_ONE_UNRESOLVED_SLOT_AFTER_MORE_EVIDENCE",
    decisionBoundary: "NO_ADS_WRITE_NO_BUDGET_CHANGE_NO_PRODUCTION_MUTATION_NO_SIGNED_CLIENT_CLAIM_NO_FORCED_SIXTH_ADVANCER",
  };
  return Object.freeze({ ...unsigned, reportSha256: sha256Canonical(unsigned) });
}

async function main(argv) {
  const args = parseArgs(argv);
  const [round0Bytes, adsBytes, manifestBytes] = await Promise.all([
    readFile(args.round0Report), readFile(defaultAdsEvidence), readFile(defaultAdsManifest),
  ]);
  const report = await runCanoRound1({
    round0Report: JSON.parse(round0Bytes.toString("utf8")),
    adsEvidence: JSON.parse(adsBytes.toString("utf8")),
    adsBytes,
    adsManifest: JSON.parse(manifestBytes.toString("utf8")),
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
