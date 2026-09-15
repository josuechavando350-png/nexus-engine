import { runCommercialDemandTournamentV2, __test as v2Test } from "./tournament-engine-v2.mjs";
import {
  ADDED_INFORMATIONAL_FAMILY_IDS,
  ADDED_RELEVANT_FAMILY_IDS,
  buildCommercialDemandScenarioV3,
} from "./tournament-v3-scenario.mjs";

const PPM = 1_000_000n;
const RATE_DENOMINATOR = PPM * PPM * PPM;
const MILLIS = 1_000n;
const REQUIRED_EVIDENCE_BOUNDARY = "RESEARCH_AND_SENSITIVITY_EVIDENCE_ONLY_NO_RANK_TRAFFIC_LEAD_CLIENT_OR_REVENUE_FORECAST";
const REQUIRED_SENSITIVITY_CLASS = "HYPOTHETICAL_PLANNING_ASSUMPTION_NOT_OBSERVED";

function object(value, name) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError(`${name} must be object`);
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

function array(value, name) {
  if (!Array.isArray(value) || value.length === 0) throw new TypeError(`${name} must be non-empty array`);
  return value;
}

function unique(values, name) {
  const seen = new Set();
  for (const value of values) {
    if (seen.has(value)) throw new Error(`duplicate ${name}: ${value}`);
    seen.add(value);
  }
}

function ceilDiv(numerator, denominator) {
  if (denominator <= 0n) throw new RangeError("denominator must be positive");
  return (numerator + denominator - 1n) / denominator;
}

function safeBigInt(value, name) {
  if (value < 0n || value > BigInt(Number.MAX_SAFE_INTEGER)) throw new RangeError(`${name} exceeds safe integer range`);
  return Number(value);
}

function requiredSessionsMilli(floorClientsMilli, funnel) {
  const rateProduct = BigInt(funnel.leadConversionPpm) * BigInt(funnel.qualifiedLeadPpm) * BigInt(funnel.closeRatePpm);
  if (rateProduct <= 0n) throw new Error(`funnel ${funnel.id} contains a zero rate`);
  return safeBigInt(
    ceilDiv(BigInt(floorClientsMilli) * RATE_DENOMINATOR, rateProduct),
    `requiredSessionsMilli.${funnel.id}`,
  );
}

function ratioPpmCeil(numerator, denominator, name) {
  if (denominator <= 0) throw new RangeError(`${name} denominator must be positive`);
  return safeBigInt(ceilDiv(BigInt(numerator) * PPM, BigInt(denominator)), name);
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

function validateServiceIntentEvidence(rawEvidence, scenario) {
  const evidence = object(structuredClone(rawEvidence), "evidence");
  if (evidence.schemaVersion !== 1) throw new Error("unsupported service intent evidence schemaVersion");
  if (text(evidence.evidenceId, "evidence.evidenceId") !== "NEXUS_SERVICE_INTENT_EVIDENCE_V3") throw new Error("unexpected evidenceId");
  text(evidence.capturedAt, "evidence.capturedAt");
  if (text(evidence.boundary, "evidence.boundary") !== REQUIRED_EVIDENCE_BOUNDARY) throw new Error("evidence boundary cannot be weakened");

  const market = object(evidence.market, "evidence.market");
  if (market.country !== scenario.market.country || market.language !== scenario.market.language) throw new Error("evidence market does not match scenario market");

  const offerEvidence = object(evidence.offerEvidence, "evidence.offerEvidence");
  if (offerEvidence.evidenceClass !== "FIRST_PARTY_PUBLIC_SITE_OFFER_SNAPSHOT") throw new Error("offer evidence must remain first-party public-site evidence");
  if (text(offerEvidence.url, "evidence.offerEvidence.url") !== "https://www.nexusbotstudio.com/") throw new Error("unexpected first-party offer URL");
  const offeredServiceLabels = array(offerEvidence.offeredServiceLabels, "evidence.offerEvidence.offeredServiceLabels")
    .map((label) => text(label, "offered service label"));
  unique(offeredServiceLabels, "offered service label");
  const offered = new Set(offeredServiceLabels);

  const metrics = object(evidence.keywordMetrics, "evidence.keywordMetrics");
  if (metrics.evidenceClass !== "GOOGLE_ADS_RESEARCH_ESTIMATE_NOT_FIRST_PARTY_OUTCOME") throw new Error("keyword metrics cannot be promoted to outcome evidence");
  const resultId = text(metrics.resultId, "evidence.keywordMetrics.resultId");
  const exactSnapshot = scenario.keywordResearch.snapshots.find((row) => row.id === "HYPD_EXACT_SERVICE_FRONTIER_2026_09_15");
  if (!exactSnapshot || exactSnapshot.resultId !== resultId) throw new Error("keyword metric resultId is not bound to the scenario snapshot");

  const familyById = new Map(scenario.keywordResearch.families.map((row) => [row.id, row]));
  const metricRows = array(metrics.rows, "evidence.keywordMetrics.rows").map((row, index) => {
    const value = object(row, `evidence.keywordMetrics.rows[${index}]`);
    const familyId = text(value.familyId, `evidence.keywordMetrics.rows[${index}].familyId`);
    const family = familyById.get(familyId);
    if (!family) throw new Error(`metric row references unknown family: ${familyId}`);
    const serviceLabel = text(value.serviceLabel, `evidence.keywordMetrics.rows[${index}].serviceLabel`);
    if (!offered.has(serviceLabel)) throw new Error(`metric row is not aligned to an offered service: ${serviceLabel}`);
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
      throw new Error(`metric evidence mismatch for family: ${familyId}`);
    }
    return { familyId, serviceLabel, keyword, monthlySearchVolume, competitionIndex, intentClass };
  });
  unique(metricRows.map((row) => row.familyId), "keyword metric family");

  const expectedMetricIds = [...ADDED_RELEVANT_FAMILY_IDS, ...ADDED_INFORMATIONAL_FAMILY_IDS].sort();
  const actualMetricIds = metricRows.map((row) => row.familyId).sort();
  if (JSON.stringify(actualMetricIds) !== JSON.stringify(expectedMetricIds)) throw new Error("keyword metric evidence does not cover every V3 family exactly once");

  const serpChecks = array(evidence.serpIntentChecks, "evidence.serpIntentChecks").map((row, index) => {
    const value = object(row, `evidence.serpIntentChecks[${index}]`);
    const familyId = text(value.familyId, `evidence.serpIntentChecks[${index}].familyId`);
    if (!ADDED_RELEVANT_FAMILY_IDS.includes(familyId)) throw new Error(`unexpected relevant SERP family: ${familyId}`);
    const family = familyById.get(familyId);
    const classification = text(value.classification, `evidence.serpIntentChecks[${index}].classification`);
    if (classification !== family.intentClass) throw new Error(`SERP classification mismatch for ${familyId}`);
    return { familyId, resultId: text(value.resultId, "SERP resultId"), classification, reason: text(value.reason, "SERP reason") };
  });
  unique(serpChecks.map((row) => row.familyId), "relevant SERP family");
  if (serpChecks.length !== ADDED_RELEVANT_FAMILY_IDS.length) throw new Error("missing relevant SERP intent check");

  const informationalGuards = array(evidence.informationalGuards, "evidence.informationalGuards").map((row, index) => {
    const value = object(row, `evidence.informationalGuards[${index}]`);
    const familyId = text(value.familyId, `evidence.informationalGuards[${index}].familyId`);
    if (!ADDED_INFORMATIONAL_FAMILY_IDS.includes(familyId)) throw new Error(`unexpected informational guard family: ${familyId}`);
    if (value.classification !== "INFORMATIONAL" || familyById.get(familyId)?.intentClass !== "INFORMATIONAL") {
      throw new Error(`informational guard cannot be promoted: ${familyId}`);
    }
    return { familyId, resultId: text(value.resultId, "informational resultId"), classification: "INFORMATIONAL", reason: text(value.reason, "informational reason") };
  });
  unique(informationalGuards.map((row) => row.familyId), "informational guard family");
  if (informationalGuards.length !== ADDED_INFORMATIONAL_FAMILY_IDS.length) throw new Error("missing informational SERP guard");

  const analyticsBoundary = object(evidence.analyticsBoundary, "evidence.analyticsBoundary");
  if (
    analyticsBoundary.ga4ConversionEvidence !== "NOT_AVAILABLE_FROM_CONNECTED_PROPERTY"
    || analyticsBoundary.interpretation !== "DO_NOT_INFER_FIRST_PARTY_LEAD_QUALIFICATION_OR_CLOSE_RATES"
  ) {
    throw new Error("GA4 boundary cannot be promoted to observed conversion evidence");
  }

  return {
    ...evidence,
    sensitivityFunnels: validateSensitivityFunnels(evidence.sensitivityFunnels),
  };
}

function buildFrontierRows(funnels, floorClientsMilli, currentSessionsMilli, ceilingSessionsMilli) {
  return funnels.map((funnel) => {
    const requiredMilli = requiredSessionsMilli(floorClientsMilli, funnel);
    return {
      funnelId: funnel.id,
      evidenceClass: funnel.evidenceClass ?? "EXPLICIT_PLANNING_ASSUMPTION",
      requiredSessionsMilli: requiredMilli,
      requiredSessions: Math.ceil(requiredMilli / 1_000),
      currentModeledSessionsMilli: currentSessionsMilli,
      currentModeledClientsMilli: v2Test.modeledClientsMilli(currentSessionsMilli, funnel),
      sessionGapMilli: Math.max(0, requiredMilli - currentSessionsMilli),
      requiredSessionMultiplePpm: ratioPpmCeil(requiredMilli, currentSessionsMilli, `requiredSessionMultiplePpm.${funnel.id}`),
      requiredShareOfResearchCeilingPpm: ratioPpmCeil(requiredMilli, ceilingSessionsMilli, `requiredShareOfResearchCeilingPpm.${funnel.id}`),
    };
  });
}

export function runCommercialDemandTournamentV3(rawBaseScenario, rawEvidence) {
  const scenario = buildCommercialDemandScenarioV3(rawBaseScenario);
  const evidence = validateServiceIntentEvidence(rawEvidence, scenario);
  const demandTournament = runCommercialDemandTournamentV2(scenario);
  const winner = demandTournament.tournament.selectedStrategy;
  const baseline = demandTournament.tournament.evaluatedStrategies.find((row) => row.id === "V2_EVIDENCE_WEIGHTED_HYBRID_BASELINE_26");
  if (!baseline) throw new Error("V3 baseline strategy result is missing");

  const floorClientsMilli = demandTournament.objective.minimumPlanningFloorClientsMilli;
  const currentSessionsMilli = winner.relevantSessionsMilli;
  const ceilingSessionsMilli = demandTournament.research.ceiling.maxClickCaptureSessionsMilli;
  const stressFrontier = buildFrontierRows(demandTournament.funnels, floorClientsMilli, currentSessionsMilli, ceilingSessionsMilli);
  const sensitivityFrontier = buildFrontierRows(evidence.sensitivityFunnels, floorClientsMilli, currentSessionsMilli, ceilingSessionsMilli);

  const unsigned = {
    schemaVersion: 3,
    engineId: "WALLE_NEXUS_COMMERCIAL_DEMAND_TOURNAMENT_V3",
    status: "TOURNAMENT_AND_GROWTH_FRONTIER_COMPLETE",
    interpretation: "DETERMINISTIC_RESEARCH_AND_PLANNING_EXPERIMENT_NOT_RANK_TRAFFIC_LEAD_CLIENT_OR_REVENUE_FORECAST",
    evidenceSha256: v2Test.sha256Canonical(rawEvidence),
    scenarioSha256: demandTournament.scenarioSha256,
    market: demandTournament.market,
    objective: demandTournament.objective,
    serviceIntentEvidence: {
      evidenceId: evidence.evidenceId,
      capturedAt: evidence.capturedAt,
      offerEvidence: evidence.offerEvidence,
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
      v2BaselineDelta: {
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
  requiredSessionsMilli,
  ratioPpmCeil,
  validateServiceIntentEvidence,
  buildFrontierRows,
});
