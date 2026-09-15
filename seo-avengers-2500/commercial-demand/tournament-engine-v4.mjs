import { runCommercialDemandTournamentV2, __test as v2Test } from "./tournament-engine-v2.mjs";
import { runCommercialDemandTournamentV3, __test as v3Test } from "./tournament-engine-v3.mjs";
import {
  ADDED_INFORMATIONAL_FAMILY_IDS_V4,
  ADDED_RELEVANT_FAMILY_IDS_V4,
  buildCommercialDemandScenarioV4,
} from "./tournament-v4-scenario.mjs";

const REQUIRED_EVIDENCE_BOUNDARY = "RESEARCH_AND_SENSITIVITY_EVIDENCE_ONLY_NO_RANK_TRAFFIC_LEAD_CLIENT_OR_REVENUE_FORECAST";
const REQUIRED_SENSITIVITY_CLASS = "HYPOTHETICAL_PLANNING_ASSUMPTION_NOT_OBSERVED";
const EXPECTED_V3_WINNER = "SERVICE_FRONTIER_FULL_VALIDATED_32";
const EXACT_SNAPSHOT_ID = "HYPD_EXACT_SOFTWARE_BUYER_FRONTIER_2026_09_15";
const DISCOVERY_SNAPSHOT_ID = "HYPD_SOFTWARE_BUYER_DISCOVERY_2026_09_15";

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

function validateSensitivityFunnels(raw) {
  const rows = array(raw, "evidence.sensitivityFunnels").map((source, index) => {
    const row = object(source, `evidence.sensitivityFunnels[${index}]`);
    const id = text(row.id, `evidence.sensitivityFunnels[${index}].id`);
    if (text(row.evidenceClass, `evidence.sensitivityFunnels[${index}].evidenceClass`) !== REQUIRED_SENSITIVITY_CLASS) {
      throw new Error(`sensitivity funnel ${id} must remain hypothetical`);
    }
    const normalized = { id, evidenceClass: REQUIRED_SENSITIVITY_CLASS };
    for (const key of ["leadConversionPpm", "qualifiedLeadPpm", "closeRatePpm"]) {
      normalized[key] = integer(row[key], `evidence.sensitivityFunnels[${index}].${key}`, 1, 1_000_000);
    }
    return normalized;
  });
  unique(rows.map((row) => row.id), "sensitivity funnel id");
  return rows;
}

function validateSoftwareIntentEvidence(rawEvidence, scenario) {
  const evidence = object(structuredClone(rawEvidence), "evidence");
  if (evidence.schemaVersion !== 1) throw new Error("unsupported V4 software intent evidence schemaVersion");
  if (text(evidence.evidenceId, "evidence.evidenceId") !== "NEXUS_SOFTWARE_BUYER_INTENT_EVIDENCE_V4") {
    throw new Error("unexpected V4 software intent evidenceId");
  }
  text(evidence.capturedAt, "evidence.capturedAt");
  if (text(evidence.boundary, "evidence.boundary") !== REQUIRED_EVIDENCE_BOUNDARY) throw new Error("V4 evidence boundary cannot be weakened");

  const market = object(evidence.market, "evidence.market");
  if (market.country !== scenario.market.country || market.language !== scenario.market.language) {
    throw new Error("V4 evidence market does not match scenario market");
  }

  const offerEvidence = object(evidence.offerEvidence, "evidence.offerEvidence");
  if (offerEvidence.evidenceClass !== "FIRST_PARTY_PUBLIC_SITE_OFFER_SNAPSHOT") {
    throw new Error("V4 offer evidence must remain first-party public-site evidence");
  }
  if (text(offerEvidence.url, "evidence.offerEvidence.url") !== "https://www.nexusbotstudio.com/") {
    throw new Error("unexpected V4 first-party offer URL");
  }
  const offeredServiceLabels = array(offerEvidence.offeredServiceLabels, "evidence.offerEvidence.offeredServiceLabels")
    .map((label) => text(label, "offered service label"));
  unique(offeredServiceLabels, "offered service label");
  const offered = new Set(offeredServiceLabels);
  for (const required of ["Plataformas a medida", "Estrategia y Consultoría"]) {
    if (!offered.has(required)) throw new Error(`V4 offer snapshot missing required service line: ${required}`);
  }

  const discovery = object(evidence.keywordDiscovery, "evidence.keywordDiscovery");
  if (discovery.evidenceClass !== "GOOGLE_ADS_RESEARCH_DISCOVERY_NOT_MARKET_SIZE") {
    throw new Error("V4 discovery evidence cannot be promoted to market-size evidence");
  }
  const discoverySnapshot = scenario.keywordResearch.snapshots.find((row) => row.id === DISCOVERY_SNAPSHOT_ID);
  if (!discoverySnapshot || discoverySnapshot.resultId !== text(discovery.resultId, "evidence.keywordDiscovery.resultId")) {
    throw new Error("V4 discovery resultId is not bound to the scenario snapshot");
  }
  if (integer(discovery.reviewedCandidateRows, "evidence.keywordDiscovery.reviewedCandidateRows", 1) !== 723) {
    throw new Error("V4 discovery row count drifted from the reviewed result set");
  }
  if (text(discovery.interpretation, "evidence.keywordDiscovery.interpretation") !== "DISCOVERY_ROWS_ARE_REVIEWED_CANDIDATES_NOT_UNIQUE_DEMAND_AND_ARE_NOT_SUMMED_INTO_CAPACITY") {
    throw new Error("V4 discovery interpretation cannot be promoted");
  }

  const metrics = object(evidence.keywordMetrics, "evidence.keywordMetrics");
  if (metrics.evidenceClass !== "GOOGLE_ADS_RESEARCH_ESTIMATE_NOT_FIRST_PARTY_OUTCOME") {
    throw new Error("V4 keyword metrics cannot be promoted to outcome evidence");
  }
  const exactSnapshot = scenario.keywordResearch.snapshots.find((row) => row.id === EXACT_SNAPSHOT_ID);
  const resultId = text(metrics.resultId, "evidence.keywordMetrics.resultId");
  if (!exactSnapshot || exactSnapshot.resultId !== resultId) throw new Error("V4 exact keyword resultId is not bound to the scenario snapshot");

  const familyById = new Map(scenario.keywordResearch.families.map((row) => [row.id, row]));
  const metricRows = array(metrics.rows, "evidence.keywordMetrics.rows").map((row, index) => {
    const value = object(row, `evidence.keywordMetrics.rows[${index}]`);
    const familyId = text(value.familyId, `evidence.keywordMetrics.rows[${index}].familyId`);
    const family = familyById.get(familyId);
    if (!family) throw new Error(`V4 metric row references unknown family: ${familyId}`);
    const serviceLabel = text(value.serviceLabel, `evidence.keywordMetrics.rows[${index}].serviceLabel`);
    if (!offered.has(serviceLabel)) throw new Error(`V4 metric row is not aligned to an offered service: ${serviceLabel}`);
    const keyword = text(value.keyword, `evidence.keywordMetrics.rows[${index}].keyword`).toLocaleLowerCase("es-MX");
    const monthlySearchVolume = integer(value.monthlySearchVolume, `evidence.keywordMetrics.rows[${index}].monthlySearchVolume`);
    const competitionIndex = integer(value.competitionIndex, `evidence.keywordMetrics.rows[${index}].competitionIndex`, 0, 100);
    const intentClass = text(value.intentClass, `evidence.keywordMetrics.rows[${index}].intentClass`);
    if (
      family.representativeKeyword !== keyword
      || family.monthlySearchVolume !== monthlySearchVolume
      || family.competitionIndex !== competitionIndex
      || family.intentClass !== intentClass
    ) {
      throw new Error(`V4 metric evidence mismatch for family: ${familyId}`);
    }
    return { familyId, serviceLabel, keyword, monthlySearchVolume, competitionIndex, intentClass };
  });
  unique(metricRows.map((row) => row.familyId), "V4 keyword metric family");
  sameStringSet(
    metricRows.map((row) => row.familyId),
    [...ADDED_RELEVANT_FAMILY_IDS_V4, ...ADDED_INFORMATIONAL_FAMILY_IDS_V4],
    "V4 keyword metric families",
  );

  const serpChecks = array(evidence.serpIntentChecks, "evidence.serpIntentChecks").map((row, index) => {
    const value = object(row, `evidence.serpIntentChecks[${index}]`);
    const familyId = text(value.familyId, `evidence.serpIntentChecks[${index}].familyId`);
    if (!ADDED_RELEVANT_FAMILY_IDS_V4.includes(familyId)) throw new Error(`unexpected V4 relevant SERP family: ${familyId}`);
    const family = familyById.get(familyId);
    const classification = text(value.classification, `evidence.serpIntentChecks[${index}].classification`);
    if (classification !== family?.intentClass) throw new Error(`V4 SERP classification mismatch for ${familyId}`);
    return {
      familyId,
      resultId: text(value.resultId, `evidence.serpIntentChecks[${index}].resultId`),
      classification,
      reason: text(value.reason, `evidence.serpIntentChecks[${index}].reason`),
    };
  });
  unique(serpChecks.map((row) => row.familyId), "V4 relevant SERP family");
  sameStringSet(serpChecks.map((row) => row.familyId), ADDED_RELEVANT_FAMILY_IDS_V4, "V4 relevant SERP families");

  const informationalGuards = array(evidence.informationalGuards, "evidence.informationalGuards").map((row, index) => {
    const value = object(row, `evidence.informationalGuards[${index}]`);
    const familyId = text(value.familyId, `evidence.informationalGuards[${index}].familyId`);
    if (!ADDED_INFORMATIONAL_FAMILY_IDS_V4.includes(familyId)) throw new Error(`unexpected V4 informational guard family: ${familyId}`);
    if (value.classification !== "INFORMATIONAL" || familyById.get(familyId)?.intentClass !== "INFORMATIONAL") {
      throw new Error(`V4 informational guard cannot be promoted: ${familyId}`);
    }
    return {
      familyId,
      resultId: text(value.resultId, `evidence.informationalGuards[${index}].resultId`),
      classification: "INFORMATIONAL",
      reason: text(value.reason, `evidence.informationalGuards[${index}].reason`),
    };
  });
  unique(informationalGuards.map((row) => row.familyId), "V4 informational guard family");
  sameStringSet(informationalGuards.map((row) => row.familyId), ADDED_INFORMATIONAL_FAMILY_IDS_V4, "V4 informational guard families");

  const analyticsBoundary = object(evidence.analyticsBoundary, "evidence.analyticsBoundary");
  if (
    analyticsBoundary.ga4ConversionEvidence !== "NOT_AVAILABLE_FROM_CONNECTED_PROPERTY"
    || analyticsBoundary.interpretation !== "DO_NOT_INFER_FIRST_PARTY_LEAD_QUALIFICATION_OR_CLOSE_RATES"
  ) {
    throw new Error("V4 GA4 boundary cannot be promoted to observed conversion evidence");
  }

  return {
    ...evidence,
    sensitivityFunnels: validateSensitivityFunnels(evidence.sensitivityFunnels),
  };
}

export function runCommercialDemandTournamentV4(rawBaseScenario, rawV3Evidence, rawV4Evidence) {
  const v3BaselineReport = runCommercialDemandTournamentV3(rawBaseScenario, rawV3Evidence);
  if (v3BaselineReport.selectedStrategyId !== EXPECTED_V3_WINNER) {
    throw new Error(`V4 requires the certified V3 winner ${EXPECTED_V3_WINNER}`);
  }

  const scenario = buildCommercialDemandScenarioV4(rawBaseScenario);
  const evidence = validateSoftwareIntentEvidence(rawV4Evidence, scenario);
  const demandTournament = runCommercialDemandTournamentV2(scenario);
  const winner = demandTournament.tournament.selectedStrategy;
  const baseline = demandTournament.tournament.evaluatedStrategies.find((row) => row.id === "V3_SERVICE_FRONTIER_BASELINE_32");
  if (!baseline) throw new Error("V4 baseline strategy result is missing");

  if (baseline.pageCount !== v3BaselineReport.growthFrontier.winnerPageCount) {
    throw new Error("V4 baseline page count does not match certified V3");
  }
  if (baseline.relevantSessionsMilli !== v3BaselineReport.growthFrontier.winnerRelevantSessionsMilli) {
    throw new Error("V4 baseline relevant-session capacity does not match certified V3");
  }

  const floorClientsMilli = demandTournament.objective.minimumPlanningFloorClientsMilli;
  const currentSessionsMilli = winner.relevantSessionsMilli;
  const ceilingSessionsMilli = demandTournament.research.ceiling.maxClickCaptureSessionsMilli;
  const stressFrontier = v3Test.buildFrontierRows(demandTournament.funnels, floorClientsMilli, currentSessionsMilli, ceilingSessionsMilli);
  const sensitivityFrontier = v3Test.buildFrontierRows(evidence.sensitivityFunnels, floorClientsMilli, currentSessionsMilli, ceilingSessionsMilli);

  const unsigned = {
    schemaVersion: 4,
    engineId: "WALLE_NEXUS_COMMERCIAL_DEMAND_TOURNAMENT_V4",
    status: "SOFTWARE_BUYER_FRONTIER_AND_GROWTH_REQUIREMENT_COMPLETE",
    interpretation: "DETERMINISTIC_RESEARCH_AND_PLANNING_EXPERIMENT_NOT_RANK_TRAFFIC_LEAD_CLIENT_OR_REVENUE_FORECAST",
    v3BaselineProof: {
      reportSha256: v3BaselineReport.reportSha256,
      selectedStrategyId: v3BaselineReport.selectedStrategyId,
      targetSupportVerdict: v3BaselineReport.targetSupportVerdict,
      winnerPageCount: v3BaselineReport.growthFrontier.winnerPageCount,
      winnerRelevantSessionsMilli: v3BaselineReport.growthFrontier.winnerRelevantSessionsMilli,
    },
    evidenceSha256: v2Test.sha256Canonical(rawV4Evidence),
    scenarioSha256: demandTournament.scenarioSha256,
    market: demandTournament.market,
    objective: demandTournament.objective,
    softwareBuyerEvidence: {
      evidenceId: evidence.evidenceId,
      capturedAt: evidence.capturedAt,
      offerEvidence: evidence.offerEvidence,
      keywordDiscovery: evidence.keywordDiscovery,
      keywordMetrics: evidence.keywordMetrics,
      serpIntentChecks: evidence.serpIntentChecks,
      informationalGuards: evidence.informationalGuards,
      analyticsBoundary: evidence.analyticsBoundary,
    },
    demandTournament,
    selectedStrategyId: demandTournament.tournament.selectedStrategyId,
    targetSupportVerdict: demandTournament.targetAssessment.targetSupportVerdict,
    growthFrontier: {
      winnerPageCount: winner.pageCount,
      winnerRelevantSessionsMilli: currentSessionsMilli,
      winnerWorstCaseModeledClientsMilli: winner.worstCaseModeledClientsMilli,
      validatedRelevantRawSearchVolume: demandTournament.research.ceiling.rawRelevantSearchVolume,
      mathematicalSearchCeilingSessionsMilli: ceilingSessionsMilli,
      v3BaselineDelta: {
        additionalPages: winner.pageCount - baseline.pageCount,
        additionalRelevantRawSearchVolume:
          demandTournament.research.ceiling.rawRelevantSearchVolume
          - v3BaselineReport.growthFrontier.validatedRelevantRawSearchVolume,
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
      "GENERIC_SOFTWARE_DEVELOPMENT_VOLUME_IS_INFORMATIONAL_AND_EXCLUDED_FROM_COMMERCIAL_CAPACITY",
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
  validateSoftwareIntentEvidence,
  validateSensitivityFunnels,
});
