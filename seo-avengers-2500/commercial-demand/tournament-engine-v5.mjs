import { runCommercialDemandTournamentV2, __test as v2Test } from "./tournament-engine-v2.mjs";
import { __test as v3Test } from "./tournament-engine-v3.mjs";
import { runCommercialDemandTournamentV4, __test as v4Test } from "./tournament-engine-v4.mjs";
import {
  ADDED_RELEVANT_FAMILY_IDS_V5,
  OFFER_FIT_GUARD_EXPECTATIONS_V5,
  OVERLAP_GUARD_EXPECTATIONS_V5,
  buildCommercialDemandScenarioV5,
} from "./tournament-v5-scenario.mjs";

const REQUIRED_EVIDENCE_BOUNDARY = "OFFER_FIT_AND_RESEARCH_EVIDENCE_ONLY_NO_RANK_TRAFFIC_LEAD_CLIENT_OR_REVENUE_FORECAST";
const EXPECTED_V4_WINNER = "SOFTWARE_BUYER_FRONTIER_FULL_VALIDATED_36";
const DISCOVERY_SNAPSHOT_ID = "HYPD_OFFER_FIT_DISCOVERY_2026_09_16";
const EXACT_SNAPSHOT_ID = "HYPD_EXACT_OFFER_FIT_FRONTIER_2026_09_16";
const ELIGIBLE_OFFER_FIT_CLASS = "FIRST_PARTY_ALIGNED_DISTINCT_DEMAND_FAMILY";

function object(value, name) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError(`${name} must be object`);
  return value;
}

function array(value, name) {
  if (!Array.isArray(value) || value.length === 0) throw new TypeError(`${name} must be non-empty array`);
  return value;
}

function text(value, name) {
  if (typeof value !== "string" || value.trim() === "") throw new TypeError(`${name} must be non-empty string`);
  return value.normalize("NFC").trim();
}

function integer(value, name, minimum = 0, maximum = Number.MAX_SAFE_INTEGER) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new TypeError(`${name} must be safe integer in range ${minimum}..${maximum}`);
  }
  return value;
}

function unique(values, name) {
  const seen = new Set();
  for (const value of values) {
    if (seen.has(value)) throw new Error(`duplicate ${name}: ${value}`);
    seen.add(value);
  }
}

function sameStringSet(actual, expected, name) {
  const left = [...actual].sort();
  const right = [...expected].sort();
  if (JSON.stringify(left) !== JSON.stringify(right)) throw new Error(`${name} does not match the required set`);
}

function expectationMap(rows, key) {
  return new Map(rows.map((row) => [row[key], row]));
}

function validateOfferFitEvidence(rawEvidence, scenario) {
  const evidence = object(structuredClone(rawEvidence), "evidence");
  if (evidence.schemaVersion !== 1) throw new Error("unsupported V5 offer-fit evidence schemaVersion");
  if (text(evidence.evidenceId, "evidence.evidenceId") !== "NEXUS_OFFER_FIT_DEMAND_EVIDENCE_V5") {
    throw new Error("unexpected V5 offer-fit evidenceId");
  }
  text(evidence.capturedAt, "evidence.capturedAt");
  if (text(evidence.boundary, "evidence.boundary") !== REQUIRED_EVIDENCE_BOUNDARY) {
    throw new Error("V5 evidence boundary cannot be weakened");
  }

  const market = object(evidence.market, "evidence.market");
  if (market.country !== scenario.market.country || market.language !== scenario.market.language) {
    throw new Error("V5 evidence market does not match scenario market");
  }

  const offerEvidence = object(evidence.offerEvidence, "evidence.offerEvidence");
  if (offerEvidence.evidenceClass !== "FIRST_PARTY_PUBLIC_SITE_OFFER_SNAPSHOT") {
    throw new Error("V5 offer evidence must remain first-party public-site evidence");
  }
  if (text(offerEvidence.url, "evidence.offerEvidence.url") !== "https://www.nexusbotstudio.com/") {
    throw new Error("unexpected V5 first-party offer URL");
  }
  const offeredServiceLabels = array(offerEvidence.offeredServiceLabels, "evidence.offerEvidence.offeredServiceLabels")
    .map((label) => text(label, "offered service label"));
  unique(offeredServiceLabels, "offered service label");
  const offered = new Set(offeredServiceLabels);
  for (const required of ["Plataformas a medida", "Datos y Analytics", "Estrategia y Consultoría"]) {
    if (!offered.has(required)) throw new Error(`V5 offer snapshot missing required service line: ${required}`);
  }

  const discovery = object(evidence.keywordDiscovery, "evidence.keywordDiscovery");
  if (discovery.evidenceClass !== "GOOGLE_ADS_RESEARCH_DISCOVERY_NOT_MARKET_SIZE") {
    throw new Error("V5 discovery evidence cannot be promoted to market-size evidence");
  }
  const discoverySnapshot = scenario.keywordResearch.snapshots.find((row) => row.id === DISCOVERY_SNAPSHOT_ID);
  if (!discoverySnapshot || discoverySnapshot.resultId !== text(discovery.resultId, "evidence.keywordDiscovery.resultId")) {
    throw new Error("V5 discovery resultId is not bound to the scenario snapshot");
  }
  if (integer(discovery.reviewedCandidateRows, "evidence.keywordDiscovery.reviewedCandidateRows", 1) !== 2656) {
    throw new Error("V5 discovery row count drifted from the reviewed result set");
  }
  if (text(discovery.interpretation, "evidence.keywordDiscovery.interpretation") !== "DISCOVERY_ROWS_ARE_REVIEWED_CANDIDATES_NOT_UNIQUE_DEMAND_AND_ARE_NOT_SUMMED_INTO_CAPACITY") {
    throw new Error("V5 discovery interpretation cannot be promoted");
  }

  const metrics = object(evidence.keywordMetrics, "evidence.keywordMetrics");
  if (metrics.evidenceClass !== "GOOGLE_ADS_RESEARCH_ESTIMATE_NOT_FIRST_PARTY_OUTCOME") {
    throw new Error("V5 keyword metrics cannot be promoted to outcome evidence");
  }
  const exactSnapshot = scenario.keywordResearch.snapshots.find((row) => row.id === EXACT_SNAPSHOT_ID);
  const resultId = text(metrics.resultId, "evidence.keywordMetrics.resultId");
  if (!exactSnapshot || exactSnapshot.resultId !== resultId) throw new Error("V5 exact keyword resultId is not bound to the scenario snapshot");
  if (integer(metrics.researchedKeywordCount, "evidence.keywordMetrics.researchedKeywordCount", 1) !== 9) {
    throw new Error("V5 exact researched keyword count drifted from 9");
  }

  const familyById = new Map(scenario.keywordResearch.families.map((row) => [row.id, row]));
  const eligibleRows = array(metrics.eligibleRows, "evidence.keywordMetrics.eligibleRows").map((row, index) => {
    const value = object(row, `evidence.keywordMetrics.eligibleRows[${index}]`);
    const familyId = text(value.familyId, `evidence.keywordMetrics.eligibleRows[${index}].familyId`);
    if (!ADDED_RELEVANT_FAMILY_IDS_V5.includes(familyId)) throw new Error(`unexpected V5 eligible family: ${familyId}`);
    const family = familyById.get(familyId);
    if (!family) throw new Error(`V5 eligible metric references unknown family: ${familyId}`);
    const serviceLabel = text(value.serviceLabel, `evidence.keywordMetrics.eligibleRows[${index}].serviceLabel`);
    if (!offered.has(serviceLabel)) throw new Error(`V5 eligible family is not aligned to an offered service: ${serviceLabel}`);
    if (text(value.offerFitClass, `evidence.keywordMetrics.eligibleRows[${index}].offerFitClass`) !== ELIGIBLE_OFFER_FIT_CLASS) {
      throw new Error(`V5 eligible family lacks required offer-fit class: ${familyId}`);
    }
    const keyword = text(value.keyword, `evidence.keywordMetrics.eligibleRows[${index}].keyword`).toLocaleLowerCase("es-MX");
    const monthlySearchVolume = integer(value.monthlySearchVolume, `evidence.keywordMetrics.eligibleRows[${index}].monthlySearchVolume`);
    const competitionIndex = integer(value.competitionIndex, `evidence.keywordMetrics.eligibleRows[${index}].competitionIndex`, 0, 100);
    const intentClass = text(value.intentClass, `evidence.keywordMetrics.eligibleRows[${index}].intentClass`);
    if (
      family.representativeKeyword !== keyword
      || family.monthlySearchVolume !== monthlySearchVolume
      || family.competitionIndex !== competitionIndex
      || family.intentClass !== intentClass
    ) {
      throw new Error(`V5 eligible metric evidence mismatch for family: ${familyId}`);
    }
    return { familyId, serviceLabel, offerFitClass: ELIGIBLE_OFFER_FIT_CLASS, keyword, monthlySearchVolume, competitionIndex, intentClass };
  });
  unique(eligibleRows.map((row) => row.familyId), "V5 eligible family");
  sameStringSet(eligibleRows.map((row) => row.familyId), ADDED_RELEVANT_FAMILY_IDS_V5, "V5 eligible families");

  const guardExpected = expectationMap(OFFER_FIT_GUARD_EXPECTATIONS_V5, "guardId");
  const guardRows = array(metrics.guardRows, "evidence.keywordMetrics.guardRows").map((row, index) => {
    const value = object(row, `evidence.keywordMetrics.guardRows[${index}]`);
    const guardId = text(value.guardId, `evidence.keywordMetrics.guardRows[${index}].guardId`);
    const expected = guardExpected.get(guardId);
    if (!expected) throw new Error(`unexpected V5 offer-fit guard: ${guardId}`);
    for (const key of ["keyword", "intentClass", "offerFitClass"]) {
      if (text(value[key], `evidence.keywordMetrics.guardRows[${index}].${key}`) !== expected[key]) {
        throw new Error(`V5 guard metric mismatch for ${guardId}.${key}`);
      }
    }
    for (const key of ["monthlySearchVolume", "competitionIndex"]) {
      if (integer(value[key], `evidence.keywordMetrics.guardRows[${index}].${key}`, 0, key === "competitionIndex" ? 100 : Number.MAX_SAFE_INTEGER) !== expected[key]) {
        throw new Error(`V5 guard metric mismatch for ${guardId}.${key}`);
      }
    }
    return structuredClone(expected);
  });
  unique(guardRows.map((row) => row.guardId), "V5 guard id");
  sameStringSet(guardRows.map((row) => row.guardId), OFFER_FIT_GUARD_EXPECTATIONS_V5.map((row) => row.guardId), "V5 guard ids");

  const overlapExpected = expectationMap(OVERLAP_GUARD_EXPECTATIONS_V5, "guardId");
  const overlapRows = array(metrics.overlapRows, "evidence.keywordMetrics.overlapRows").map((row, index) => {
    const value = object(row, `evidence.keywordMetrics.overlapRows[${index}]`);
    const guardId = text(value.guardId, `evidence.keywordMetrics.overlapRows[${index}].guardId`);
    const expected = overlapExpected.get(guardId);
    if (!expected) throw new Error(`unexpected V5 overlap guard: ${guardId}`);
    for (const key of ["keyword", "existingFamilyId", "overlapClass"]) {
      if (text(value[key], `evidence.keywordMetrics.overlapRows[${index}].${key}`) !== expected[key]) {
        throw new Error(`V5 overlap metric mismatch for ${guardId}.${key}`);
      }
    }
    for (const key of ["monthlySearchVolume", "competitionIndex"]) {
      if (integer(value[key], `evidence.keywordMetrics.overlapRows[${index}].${key}`, 0, key === "competitionIndex" ? 100 : Number.MAX_SAFE_INTEGER) !== expected[key]) {
        throw new Error(`V5 overlap metric mismatch for ${guardId}.${key}`);
      }
    }
    const existingFamily = familyById.get(expected.existingFamilyId);
    if (!existingFamily) throw new Error(`V5 overlap guard references missing existing family: ${expected.existingFamilyId}`);
    if (existingFamily.monthlySearchVolume !== expected.monthlySearchVolume) {
      throw new Error(`V5 overlap guard volume does not match existing family: ${guardId}`);
    }
    return structuredClone(expected);
  });
  unique(overlapRows.map((row) => row.guardId), "V5 overlap guard id");
  sameStringSet(overlapRows.map((row) => row.guardId), OVERLAP_GUARD_EXPECTATIONS_V5.map((row) => row.guardId), "V5 overlap guard ids");

  const serpChecks = array(evidence.serpIntentChecks, "evidence.serpIntentChecks").map((row, index) => {
    const value = object(row, `evidence.serpIntentChecks[${index}]`);
    const familyId = text(value.familyId, `evidence.serpIntentChecks[${index}].familyId`);
    if (!ADDED_RELEVANT_FAMILY_IDS_V5.includes(familyId)) throw new Error(`unexpected V5 eligible SERP family: ${familyId}`);
    const family = familyById.get(familyId);
    const classification = text(value.classification, `evidence.serpIntentChecks[${index}].classification`);
    if (classification !== family?.intentClass) throw new Error(`V5 SERP classification mismatch for ${familyId}`);
    return {
      familyId,
      resultId: text(value.resultId, `evidence.serpIntentChecks[${index}].resultId`),
      classification,
      reason: text(value.reason, `evidence.serpIntentChecks[${index}].reason`),
    };
  });
  unique(serpChecks.map((row) => row.familyId), "V5 SERP family");
  sameStringSet(serpChecks.map((row) => row.familyId), ADDED_RELEVANT_FAMILY_IDS_V5, "V5 SERP families");

  const offerFitGuards = array(evidence.offerFitGuards, "evidence.offerFitGuards").map((row, index) => {
    const value = object(row, `evidence.offerFitGuards[${index}]`);
    const guardId = text(value.guardId, `evidence.offerFitGuards[${index}].guardId`);
    const expected = guardExpected.get(guardId);
    if (!expected) throw new Error(`unexpected V5 offer-fit SERP guard: ${guardId}`);
    const classification = text(value.classification, `evidence.offerFitGuards[${index}].classification`);
    const offerFitClass = text(value.offerFitClass, `evidence.offerFitGuards[${index}].offerFitClass`);
    if (classification !== expected.intentClass || offerFitClass !== expected.offerFitClass) {
      throw new Error(`V5 offer-fit guard cannot be promoted: ${guardId}`);
    }
    return {
      guardId,
      resultId: text(value.resultId, `evidence.offerFitGuards[${index}].resultId`),
      classification,
      offerFitClass,
      reason: text(value.reason, `evidence.offerFitGuards[${index}].reason`),
    };
  });
  unique(offerFitGuards.map((row) => row.guardId), "V5 offer-fit SERP guard id");
  sameStringSet(offerFitGuards.map((row) => row.guardId), OFFER_FIT_GUARD_EXPECTATIONS_V5.map((row) => row.guardId), "V5 offer-fit SERP guards");

  const overlapGuards = array(evidence.overlapGuards, "evidence.overlapGuards").map((row, index) => {
    const value = object(row, `evidence.overlapGuards[${index}]`);
    const guardId = text(value.guardId, `evidence.overlapGuards[${index}].guardId`);
    const expected = overlapExpected.get(guardId);
    if (!expected) throw new Error(`unexpected V5 overlap evidence guard: ${guardId}`);
    if (
      text(value.existingFamilyId, `evidence.overlapGuards[${index}].existingFamilyId`) !== expected.existingFamilyId
      || text(value.classification, `evidence.overlapGuards[${index}].classification`) !== expected.overlapClass
    ) {
      throw new Error(`V5 overlap guard cannot become additive: ${guardId}`);
    }
    return {
      guardId,
      existingFamilyId: expected.existingFamilyId,
      classification: expected.overlapClass,
      reason: text(value.reason, `evidence.overlapGuards[${index}].reason`),
    };
  });
  unique(overlapGuards.map((row) => row.guardId), "V5 overlap evidence guard id");
  sameStringSet(overlapGuards.map((row) => row.guardId), OVERLAP_GUARD_EXPECTATIONS_V5.map((row) => row.guardId), "V5 overlap evidence guards");

  const analyticsBoundary = object(evidence.analyticsBoundary, "evidence.analyticsBoundary");
  if (
    analyticsBoundary.ga4ConversionEvidence !== "NOT_AVAILABLE_FROM_CONNECTED_PROPERTY"
    || analyticsBoundary.interpretation !== "DO_NOT_INFER_FIRST_PARTY_LEAD_QUALIFICATION_OR_CLOSE_RATES"
  ) {
    throw new Error("V5 GA4 boundary cannot be promoted to observed conversion evidence");
  }

  return {
    ...evidence,
    sensitivityFunnels: v4Test.validateSensitivityFunnels(evidence.sensitivityFunnels),
  };
}

export function runCommercialDemandTournamentV5(rawBaseScenario, rawV3Evidence, rawV4Evidence, rawV5Evidence) {
  const v4BaselineReport = runCommercialDemandTournamentV4(rawBaseScenario, rawV3Evidence, rawV4Evidence);
  if (v4BaselineReport.selectedStrategyId !== EXPECTED_V4_WINNER) {
    throw new Error(`V5 requires the certified V4 winner ${EXPECTED_V4_WINNER}`);
  }

  const scenario = buildCommercialDemandScenarioV5(rawBaseScenario);
  const evidence = validateOfferFitEvidence(rawV5Evidence, scenario);
  const demandTournament = runCommercialDemandTournamentV2(scenario);
  const winner = demandTournament.tournament.selectedStrategy;
  const baseline = demandTournament.tournament.evaluatedStrategies.find((row) => row.id === "V4_SOFTWARE_BUYER_BASELINE_36");
  if (!baseline) throw new Error("V5 baseline strategy result is missing");
  if (baseline.pageCount !== v4BaselineReport.growthFrontier.winnerPageCount) {
    throw new Error("V5 baseline page count does not match certified V4");
  }
  if (baseline.relevantSessionsMilli !== v4BaselineReport.growthFrontier.winnerRelevantSessionsMilli) {
    throw new Error("V5 baseline relevant-session capacity does not match certified V4");
  }

  const floorClientsMilli = demandTournament.objective.minimumPlanningFloorClientsMilli;
  const currentSessionsMilli = winner.relevantSessionsMilli;
  const ceilingSessionsMilli = demandTournament.research.ceiling.maxClickCaptureSessionsMilli;
  const stressFrontier = v3Test.buildFrontierRows(demandTournament.funnels, floorClientsMilli, currentSessionsMilli, ceilingSessionsMilli);
  const sensitivityFrontier = v3Test.buildFrontierRows(evidence.sensitivityFunnels, floorClientsMilli, currentSessionsMilli, ceilingSessionsMilli);

  const eligibleIncrementalRawSearchVolume = evidence.keywordMetrics.eligibleRows.reduce((sum, row) => sum + row.monthlySearchVolume, 0);
  const guardedRawSearchVolume = evidence.keywordMetrics.guardRows.reduce((sum, row) => sum + row.monthlySearchVolume, 0);
  const overlapRawSearchVolume = evidence.keywordMetrics.overlapRows.reduce((sum, row) => sum + row.monthlySearchVolume, 0);
  const exactSnapshotRawSearchVolume = eligibleIncrementalRawSearchVolume + guardedRawSearchVolume + overlapRawSearchVolume;

  const unsigned = {
    schemaVersion: 5,
    engineId: "WALLE_NEXUS_COMMERCIAL_DEMAND_TOURNAMENT_V5",
    status: "OFFER_FIT_GATED_DEMAND_FRONTIER_COMPLETE",
    interpretation: "DETERMINISTIC_RESEARCH_AND_PLANNING_EXPERIMENT_NOT_RANK_TRAFFIC_LEAD_CLIENT_OR_REVENUE_FORECAST",
    v4BaselineProof: {
      reportSha256: v4BaselineReport.reportSha256,
      selectedStrategyId: v4BaselineReport.selectedStrategyId,
      targetSupportVerdict: v4BaselineReport.targetSupportVerdict,
      winnerPageCount: v4BaselineReport.growthFrontier.winnerPageCount,
      winnerRelevantSessionsMilli: v4BaselineReport.growthFrontier.winnerRelevantSessionsMilli,
    },
    evidenceSha256: v2Test.sha256Canonical(rawV5Evidence),
    scenarioSha256: demandTournament.scenarioSha256,
    market: demandTournament.market,
    objective: demandTournament.objective,
    offerFitEvidence: {
      evidenceId: evidence.evidenceId,
      capturedAt: evidence.capturedAt,
      offerEvidence: evidence.offerEvidence,
      keywordDiscovery: evidence.keywordDiscovery,
      keywordMetrics: evidence.keywordMetrics,
      serpIntentChecks: evidence.serpIntentChecks,
      offerFitGuards: evidence.offerFitGuards,
      overlapGuards: evidence.overlapGuards,
      analyticsBoundary: evidence.analyticsBoundary,
    },
    demandTournament,
    selectedStrategyId: demandTournament.tournament.selectedStrategyId,
    targetSupportVerdict: demandTournament.targetAssessment.targetSupportVerdict,
    offerFitAccounting: {
      exactResearchedKeywordCount: evidence.keywordMetrics.researchedKeywordCount,
      exactSnapshotRawSearchVolume,
      eligibleIncrementalRawSearchVolume,
      guardedRawSearchVolume,
      overlapRawSearchVolume,
      totalNonAdditiveRawSearchVolume: guardedRawSearchVolume + overlapRawSearchVolume,
      boundary: "ONLY_FIRST_PARTY_ALIGNED_DISTINCT_FAMILIES_ENTER_THE_DEMAND_SCENARIO_ADJACENT_UNPROVEN_INFORMATIONAL_AND_OVERLAP_VOLUME_ADDS_ZERO_CAPACITY",
    },
    growthFrontier: {
      winnerPageCount: winner.pageCount,
      winnerRelevantSessionsMilli: currentSessionsMilli,
      winnerWorstCaseModeledClientsMilli: winner.worstCaseModeledClientsMilli,
      validatedRelevantRawSearchVolume: demandTournament.research.ceiling.rawRelevantSearchVolume,
      mathematicalSearchCeilingSessionsMilli: ceilingSessionsMilli,
      v4BaselineDelta: {
        additionalPages: winner.pageCount - baseline.pageCount,
        additionalRelevantRawSearchVolume:
          demandTournament.research.ceiling.rawRelevantSearchVolume
          - v4BaselineReport.growthFrontier.validatedRelevantRawSearchVolume,
        additionalRelevantSessionsMilli: winner.relevantSessionsMilli - baseline.relevantSessionsMilli,
        additionalStrictCommercialSessionsMilli: winner.strictCommercialSessionsMilli - baseline.strictCommercialSessionsMilli,
        additionalWorstCaseModeledClientsMilli: winner.worstCaseModeledClientsMilli - baseline.worstCaseModeledClientsMilli,
      },
      stressFrontier,
      sensitivityFrontier,
      boundary: "SESSION_MULTIPLIERS_AND_SENSITIVITY_FUNNELS_ARE_REQUIREMENT_MATH_NOT_EXPECTATIONS_OR_FORECASTS",
    },
    warnings: [
      "NO_RANK_GUARANTEE",
      "NO_TRAFFIC_GUARANTEE",
      "NO_LEAD_OR_CLIENT_GUARANTEE",
      "DISCOVERY_ROWS_ARE_NOT_UNIQUE_MARKET_SIZE",
      "ADJACENT_PRODUCT_DEMAND_IS_EXCLUDED_UNLESS_FIRST_PARTY_OFFER_ALIGNED",
      "UNPROVEN_FIRST_PARTY_OFFER_ALIGNMENT_ADDS_ZERO_CAPACITY",
      "EXISTING_FAMILY_SYNONYMS_ADD_ZERO_INCREMENTAL_CAPACITY",
      "SERP_INTENT_CLASSIFICATION_IS_RESEARCH_EVIDENCE_NOT_OUTCOME_EVIDENCE",
      "SENSITIVITY_FUNNELS_ARE_HYPOTHETICAL_NOT_OBSERVED",
      "GA4_FUNNEL_EVIDENCE_NOT_AVAILABLE_DO_NOT_PROMOTE_ASSUMPTIONS_TO_FACTS",
      "NO_AUTONOMOUS_PRODUCTION_ACTION",
    ],
    decisionBoundary: demandTournament.decisionBoundary,
  };

  return Object.freeze({ ...unsigned, reportSha256: v2Test.sha256Canonical(unsigned) });
}

export const __test = Object.freeze({
  validateOfferFitEvidence,
});
