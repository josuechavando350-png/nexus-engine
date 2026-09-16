import { createHash } from "node:crypto";
import { runCommercialDemandTournamentV5 } from "./tournament-engine-v5.mjs";

const REQUIRED_EVIDENCE_BOUNDARY = "PAID_SEARCH_PLANNER_EVIDENCE_ONLY_NOT_ACTUAL_TRAFFIC_CONVERSION_CLIENT_OR_REVENUE_OUTCOME";
const EXPECTED_V5_WINNER = "OFFER_FIT_FULL_VALIDATED_40";
const REQUIRED_PORTFOLIO = Object.freeze([
  "agencia seo",
  "consultoria seo",
  "servicios seo",
  "agencia de desarrollo web",
  "diseño web profesional",
  "cotizacion pagina web",
  "servicios de automatizacion",
  "chatbot whatsapp business",
  "automatizar whatsapp",
  "chatbot para empresas",
  "inteligencia artificial para empresas",
  "empresa de desarrollo de software",
  "software a medida",
  "desarrollo de software a medida",
  "consultoria tecnologica",
  "consultoria inteligencia artificial",
  "integracion de sistemas",
]);

const EXACT_EXPECTATIONS = Object.freeze([
  Object.freeze({ resultId: "36165dc8-5410-4033-a884-d663c34b3285", match: "exact", dateInterval: "next_month", bidUsdCents: 200, averageCpcUsdCents: 114, costUsdCents: 26079, clicksMilli: 229570 }),
  Object.freeze({ resultId: "ebbc56eb-7c05-4a7f-a65e-737b497653dc", match: "exact", dateInterval: "next_month", bidUsdCents: 400, averageCpcUsdCents: 189, costUsdCents: 65526, clicksMilli: 347330 }),
  Object.freeze({ resultId: "eeb14390-1634-4971-9f88-1abc9ffeb66b", match: "exact", dateInterval: "next_month", bidUsdCents: 800, averageCpcUsdCents: 250, costUsdCents: 92696, clicksMilli: 370740 }),
]);

const MATCH_CONTROL_EXPECTATIONS = Object.freeze([
  Object.freeze({ resultId: "62473bfc-c0e2-40e4-8a99-e6504963f01b", match: "phrase", dateInterval: "next_month", bidUsdCents: 400, averageCpcUsdCents: 159, costUsdCents: 196618, clicksMilli: 1240300 }),
  Object.freeze({ resultId: "96c9a3e8-3269-4872-81aa-3cadd1ee7057", match: "broad", dateInterval: "next_month", bidUsdCents: 400, averageCpcUsdCents: 190, costUsdCents: 216353, clicksMilli: 1141360 }),
]);

const HIGH_CONVERSION_SENSITIVITY_PPM = 7700;

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

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]));
  }
  return value;
}

function sha256(value) {
  return `sha256:${createHash("sha256").update(JSON.stringify(canonicalize(value))).digest("hex")}`;
}

function sameStringSet(actual, expected, name) {
  const left = [...actual].sort();
  const right = [...expected].sort();
  if (JSON.stringify(left) !== JSON.stringify(right)) throw new Error(`${name} does not match the required set`);
}

function ceilRatioPpm(clientsMilli, sessionsMilli) {
  return Math.ceil((clientsMilli * 1_000_000) / sessionsMilli);
}

function modeledClientsMilli(sessionsMilli, sessionToClientPpm) {
  return Math.floor((sessionsMilli * sessionToClientPpm) / 1_000_000);
}

function validateForecastRows(rawRows, expectedRows, name, requireEligibility = false) {
  const rows = array(rawRows, name).map((raw, index) => {
    const value = object(raw, `${name}[${index}]`);
    const expected = expectedRows.find((row) => row.resultId === text(value.resultId, `${name}[${index}].resultId`));
    if (!expected) throw new Error(`unexpected ${name} resultId`);
    for (const key of ["match", "dateInterval"]) {
      if (text(value[key], `${name}[${index}].${key}`) !== expected[key]) throw new Error(`${name} mismatch for ${expected.resultId}.${key}`);
    }
    for (const key of ["bidUsdCents", "averageCpcUsdCents", "costUsdCents", "clicksMilli"]) {
      if (integer(value[key], `${name}[${index}].${key}`) !== expected[key]) throw new Error(`${name} mismatch for ${expected.resultId}.${key}`);
    }
    if (requireEligibility && text(value.floorSupportEligibility, `${name}[${index}].floorSupportEligibility`) !== "INELIGIBLE_WITHOUT_QUERY_LEVEL_INTENT_AND_OFFER_FIT_EVIDENCE") {
      throw new Error(`${name} cannot be promoted to floor support`);
    }
    return structuredClone(expected);
  });
  sameStringSet(rows.map((row) => row.resultId), expectedRows.map((row) => row.resultId), `${name} resultIds`);
  return rows.sort((a, b) => a.bidUsdCents - b.bidUsdCents || a.match.localeCompare(b.match));
}

function validatePaidSearchEvidence(rawEvidence) {
  const evidence = object(structuredClone(rawEvidence), "evidence");
  if (evidence.schemaVersion !== 1) throw new Error("unsupported V6 paid-search evidence schemaVersion");
  if (text(evidence.evidenceId, "evidence.evidenceId") !== "NEXUS_PAID_SEARCH_CHANNEL_EVIDENCE_V6") throw new Error("unexpected V6 evidenceId");
  text(evidence.capturedAt, "evidence.capturedAt");
  if (text(evidence.boundary, "evidence.boundary") !== REQUIRED_EVIDENCE_BOUNDARY) throw new Error("V6 evidence boundary cannot be weakened");

  const market = object(evidence.market, "evidence.market");
  if (text(market.country, "evidence.market.country") !== "Mexico" || text(market.language, "evidence.market.language") !== "Spanish") {
    throw new Error("V6 evidence market drifted");
  }

  const portfolio = object(evidence.portfolio, "evidence.portfolio");
  if (text(portfolio.evidenceClass, "evidence.portfolio.evidenceClass") !== "CURRENT_OFFER_ALIGNED_EXACT_MATCH_PLANNING_PORTFOLIO") throw new Error("unexpected V6 portfolio evidence class");
  if (integer(portfolio.keywordCount, "evidence.portfolio.keywordCount", 1) !== REQUIRED_PORTFOLIO.length) throw new Error("V6 portfolio keyword count drifted");
  const keywords = array(portfolio.keywords, "evidence.portfolio.keywords").map((row) => text(row, "V6 portfolio keyword").toLocaleLowerCase("es-MX"));
  if (new Set(keywords).size !== keywords.length) throw new Error("V6 portfolio contains duplicate keyword");
  sameStringSet(keywords, REQUIRED_PORTFOLIO, "V6 portfolio keywords");
  if (text(portfolio.interpretation, "evidence.portfolio.interpretation") !== "PORTFOLIO_IS_FOR_CHANNEL_FEASIBILITY_ONLY_AND_DOES_NOT_EXPAND_THE_V5_ORGANIC_DEMAND_UNIVERSE") throw new Error("V6 portfolio interpretation cannot be promoted");

  const metrics = object(evidence.keywordMetrics, "evidence.keywordMetrics");
  if (text(metrics.evidenceClass, "evidence.keywordMetrics.evidenceClass") !== "GOOGLE_ADS_KNOWN_KEYWORD_RESEARCH_ESTIMATE_NOT_FIRST_PARTY_OUTCOME") throw new Error("V6 keyword metrics cannot be promoted to outcome evidence");
  if (text(metrics.resultId, "evidence.keywordMetrics.resultId") !== "c56bf255-fe7c-46f1-9f6d-91896c6fd392") throw new Error("V6 keyword metrics resultId drifted");
  if (integer(metrics.researchedKeywordCount, "evidence.keywordMetrics.researchedKeywordCount", 1) !== 26) throw new Error("V6 researched keyword count drifted");
  text(metrics.sourceUnits, "evidence.keywordMetrics.sourceUnits");
  if (text(metrics.interpretation, "evidence.keywordMetrics.interpretation") !== "KEYWORD_METRICS_SUPPORT_CHANNEL_COST_CONTEXT_ONLY_AND_ARE_NOT_SUMMED_AS_NEW_ORGANIC_MARKET_SIZE") throw new Error("V6 keyword metrics interpretation cannot be promoted");

  const exactMatchForecasts = validateForecastRows(evidence.exactMatchForecasts, EXACT_EXPECTATIONS, "V6 exact forecasts");
  const matchExpansionControls = validateForecastRows(evidence.matchExpansionControls, MATCH_CONTROL_EXPECTATIONS, "V6 match controls", true);

  const analytics = object(evidence.analyticsBoundary, "evidence.analyticsBoundary");
  if (text(analytics.ga4ConversionEvidence, "evidence.analyticsBoundary.ga4ConversionEvidence") !== "NOT_AVAILABLE_FROM_CONNECTED_PROPERTY") throw new Error("V6 cannot invent GA4 conversion evidence");
  if (text(analytics.conversionAssumptions, "evidence.analyticsBoundary.conversionAssumptions") !== "HYPOTHETICAL_PLANNING_ASSUMPTIONS_ONLY") throw new Error("V6 conversion assumptions must remain hypothetical");
  if (text(analytics.paidOrganicOverlap, "evidence.analyticsBoundary.paidOrganicOverlap") !== "UNOBSERVED") throw new Error("V6 paid-organic overlap must remain unobserved");
  if (text(analytics.paidClickToSessionLoss, "evidence.analyticsBoundary.paidClickToSessionLoss") !== "UNOBSERVED") throw new Error("V6 paid click-to-session loss must remain unobserved");

  const rules = object(evidence.planningRules, "evidence.planningRules");
  if (text(rules.exactForecastMayBeUsedAs, "evidence.planningRules.exactForecastMayBeUsedAs") !== "PAID_CHANNEL_CAPTURE_ENVELOPE_NOT_INCREMENTAL_OUTCOME_FORECAST") throw new Error("V6 exact forecast use boundary drifted");
  if (text(rules.phraseBroadMayBeUsedAs, "evidence.planningRules.phraseBroadMayBeUsedAs") !== "UNCERTAINTY_CONTROLS_ONLY") throw new Error("V6 phrase/broad use boundary drifted");
  if (text(rules.organicPlusPaidSummation, "evidence.planningRules.organicPlusPaidSummation") !== "ONLY_AS_ZERO_OVERLAP_UPPER_BOUND_NOT_EXPECTED_OUTCOME") throw new Error("V6 summation boundary drifted");
  if (text(rules.clientFloorSupport, "evidence.planningRules.clientFloorSupport") !== "REQUIRES_OBSERVED_CONVERSION_AND_INCREMENTALITY_EVIDENCE") throw new Error("V6 floor-support boundary drifted");

  return {
    schemaVersion: 1,
    evidenceId: evidence.evidenceId,
    capturedAt: evidence.capturedAt,
    market: { country: market.country, language: market.language },
    boundary: evidence.boundary,
    portfolio: { keywordCount: keywords.length, keywords: [...keywords].sort() },
    keywordMetrics: { resultId: metrics.resultId, researchedKeywordCount: metrics.researchedKeywordCount },
    exactMatchForecasts,
    matchExpansionControls,
    analyticsBoundary: structuredClone(analytics),
    planningRules: structuredClone(rules),
  };
}

export function runCommercialDemandTournamentV6(rawBaseScenario, rawV3Evidence, rawV4Evidence, rawV5Evidence, rawV6Evidence) {
  const v5 = runCommercialDemandTournamentV5(rawBaseScenario, rawV3Evidence, rawV4Evidence, rawV5Evidence);
  if (v5.selectedStrategyId !== EXPECTED_V5_WINNER) throw new Error(`V6 requires certified V5 winner ${EXPECTED_V5_WINNER}`);
  const v5Winner = v5.demandTournament?.tournament?.selectedStrategy;
  if (!v5Winner || v5Winner.pageCount !== 40 || v5Winner.relevantSessionsMilli !== 776700) throw new Error("V6 requires the certified V5 40-page capacity baseline");

  const evidence = validatePaidSearchEvidence(rawV6Evidence);
  const exact = evidence.exactMatchForecasts;
  const maxExact = exact.reduce((best, row) => row.clicksMilli > best.clicksMilli ? row : best, exact[0]);
  const organicModeledSessionsMilli = v5Winner.relevantSessionsMilli;
  const combinedNoOverlapUpperBoundSessionsMilli = organicModeledSessionsMilli + maxExact.clicksMilli;
  const highConversionUpperBoundModeledClientsMilli = modeledClientsMilli(combinedNoOverlapUpperBoundSessionsMilli, HIGH_CONVERSION_SENSITIVITY_PPM);
  const minimumPlanningFloorClientsMilli = v5.objective.minimumPlanningFloorClientsMilli;

  const exactFrontier = exact.map((row) => {
    const combined = organicModeledSessionsMilli + row.clicksMilli;
    return {
      ...row,
      combinedNoOverlapUpperBoundSessionsMilli: combined,
      highConversionUpperBoundModeledClientsMilli: modeledClientsMilli(combined, HIGH_CONVERSION_SENSITIVITY_PPM),
      floorSupportEligible: false,
      floorSupportReason: "PAID_ORGANIC_INCREMENTALITY_AND_OBSERVED_CONVERSION_ARE_MISSING",
    };
  });

  const matchExpansionControls = evidence.matchExpansionControls.map((row) => {
    const combined = organicModeledSessionsMilli + row.clicksMilli;
    return {
      ...row,
      combinedNoOverlapUpperBoundSessionsMilli: combined,
      rawHypotheticalHighConversionClientsMilli: modeledClientsMilli(combined, HIGH_CONVERSION_SENSITIVITY_PPM),
      floorSupportEligible: false,
      floorSupportReason: "MATCH_EXPANSION_LACKS_QUERY_LEVEL_INTENT_AND_OFFER_FIT_EVIDENCE_AND_CONVERSION_IS_UNOBSERVED",
    };
  });

  const evidenceSha256 = sha256(evidence);
  const reportWithoutHash = {
    schemaVersion: 1,
    engineId: "WALLE_NEXUS_COMMERCIAL_DEMAND_TOURNAMENT_V6",
    objective: structuredClone(v5.objective),
    v5BaselineProof: {
      reportSha256: v5.reportSha256,
      selectedStrategyId: v5.selectedStrategyId,
      pageCount: v5Winner.pageCount,
      organicModeledSessionsMilli,
      validatedRelevantRawSearchVolume: v5.growthFrontier.validatedRelevantRawSearchVolume,
      targetSupportVerdict: v5.targetSupportVerdict,
    },
    paidSearchEvidence: evidence,
    evidenceSha256,
    channelFrontier: {
      exactMatchForecasts: exactFrontier,
      maxExactCaptureEnvelope: {
        bidUsdCents: maxExact.bidUsdCents,
        forecastPaidClicksMilli: maxExact.clicksMilli,
        forecastPaidCostUsdCents: maxExact.costUsdCents,
        organicModeledSessionsMilli,
        combinedNoOverlapUpperBoundSessionsMilli,
        zeroOverlapAssumption: "UPPER_BOUND_ONLY_NOT_EXPECTED_OUTCOME",
        highConversionSensitivityPpm: HIGH_CONVERSION_SENSITIVITY_PPM,
        highConversionUpperBoundModeledClientsMilli,
        minimumPlanningFloorClientsMilli,
        gapToFloorClientsMilli: Math.max(0, minimumPlanningFloorClientsMilli - highConversionUpperBoundModeledClientsMilli),
        requiredSessionToClientPpmFor15Clients: ceilRatioPpm(15000, combinedNoOverlapUpperBoundSessionsMilli),
        requiredSessionToClientPpmFor16Clients: ceilRatioPpm(16000, combinedNoOverlapUpperBoundSessionsMilli),
        requiredSessionToClientPpmFor20Clients: ceilRatioPpm(20000, combinedNoOverlapUpperBoundSessionsMilli),
      },
      matchExpansionControls,
    },
    targetSupportVerdict: "MULTI_CHANNEL_AND_OBSERVED_FUNNEL_EVIDENCE_REQUIRED_BEFORE_FLOOR_CLAIM",
    warnings: [
      "PAID_SEARCH_FORECAST_IS_NOT_ACTUAL_TRAFFIC",
      "PAID_ORGANIC_OVERLAP_IS_UNOBSERVED",
      "GA4_CONVERSION_EVIDENCE_IS_UNAVAILABLE",
      "PHRASE_AND_BROAD_MATCH_FORECASTS_CANNOT_SUPPORT_CLIENT_FLOOR",
      "NO_LEAD_OR_CLIENT_GUARANTEE",
    ],
    decisionBoundary: "PLAN_ONLY_NO_AUTONOMOUS_SITE_CMS_ADS_DNS_OR_TENANT_MUTATION",
  };
  return { ...reportWithoutHash, reportSha256: sha256(reportWithoutHash) };
}

export const __test = Object.freeze({
  REQUIRED_PORTFOLIO,
  EXACT_EXPECTATIONS,
  MATCH_CONTROL_EXPECTATIONS,
  HIGH_CONVERSION_SENSITIVITY_PPM,
  validatePaidSearchEvidence,
});
