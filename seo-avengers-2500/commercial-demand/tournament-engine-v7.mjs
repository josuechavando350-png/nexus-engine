import { createHash } from "node:crypto";
import { runCommercialDemandTournamentV6 } from "./tournament-engine-v6.mjs";

const REQUIRED_EVIDENCE_BOUNDARY = "MEASUREMENT_READINESS_EVIDENCE_ONLY_NOT_CONVERSION_RATE_CLIENT_OUTCOME_OR_PROBABILITY_EVIDENCE";
const REQUIRED_V6_VERDICT = "MULTI_CHANNEL_AND_OBSERVED_FUNNEL_EVIDENCE_REQUIRED_BEFORE_FLOOR_CLAIM";
const REQUIRED_V6_SESSIONS_MILLI = 1_147_440;
const REQUIRED_V6_FLOOR_PPM = 13_073;
const REQUIRED_HYPOTHETICAL_PPM = 7_700;

const EXPECTED_AUDITS = Object.freeze({
  "https://nexusbotstudio.com": Object.freeze({
    resolvedUrl: "https://www.nexusbotstudio.com/",
    statusCode: 200,
    scriptCount: 13,
  }),
  "https://nexusbotstudio.com/automation": Object.freeze({
    resolvedUrl: "https://www.nexusbotstudio.com/automation",
    statusCode: 200,
    scriptCount: 10,
  }),
});

const REQUIRED_DETECTOR_BASIS = Object.freeze([
  "NO_SCRIPT_URL_MATCH_GOOGLETAGMANAGER",
  "NO_SCRIPT_URL_MATCH_GOOGLE_ANALYTICS",
  "NO_SCRIPT_URL_MATCH_GTAG_JS",
]);
const REQUIRED_FUNNEL_EVENTS = Object.freeze(["SESSION", "CONTACT", "QUALIFIED_LEAD", "CLOSED_CLIENT"]);
const REQUIRED_ATTRIBUTION_DIMENSIONS = Object.freeze(["ACQUISITION_CHANNEL", "LANDING_PAGE", "CAMPAIGN_OR_SOURCE", "OBSERVATION_PERIOD"]);

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

function boolean(value, name) {
  if (typeof value !== "boolean") throw new TypeError(`${name} must be boolean`);
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

function ceilBigIntRatioToNumber(numerator, denominator, name) {
  if (denominator <= 0n) throw new Error(`${name} denominator must be positive`);
  const value = (numerator + denominator - 1n) / denominator;
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error(`${name} exceeds safe integer range`);
  return Number(value);
}

function validateObservabilityEvidence(rawEvidence) {
  const evidence = object(structuredClone(rawEvidence), "evidence");
  if (evidence.schemaVersion !== 1) throw new Error("unsupported V7 evidence schemaVersion");
  if (text(evidence.evidenceId, "evidence.evidenceId") !== "NEXUS_FUNNEL_OBSERVABILITY_EVIDENCE_V7") throw new Error("unexpected V7 evidenceId");
  text(evidence.capturedAt, "evidence.capturedAt");
  if (text(evidence.siteId, "evidence.siteId") !== "nexus-bot-studio") throw new Error("unexpected V7 siteId");
  if (text(evidence.boundary, "evidence.boundary") !== REQUIRED_EVIDENCE_BOUNDARY) throw new Error("V7 evidence boundary cannot be weakened");

  const market = object(evidence.market, "evidence.market");
  if (text(market.country, "evidence.market.country") !== "Mexico" || text(market.language, "evidence.market.language") !== "Spanish") {
    throw new Error("V7 evidence market drifted");
  }

  const audits = array(evidence.liveBrowserAudits, "evidence.liveBrowserAudits").map((raw, index) => {
    const audit = object(raw, `evidence.liveBrowserAudits[${index}]`);
    if (text(audit.source, `audit[${index}].source`) !== "HYPD_BROWSER_RESOURCE_INVENTORY") throw new Error("V7 audit source drifted");
    const rawUrl = text(audit.rawUrl, `audit[${index}].rawUrl`);
    const expected = EXPECTED_AUDITS[rawUrl];
    if (!expected) throw new Error("unexpected V7 audited URL");
    if (text(audit.resolvedUrl, `audit[${index}].resolvedUrl`) !== expected.resolvedUrl) throw new Error(`V7 audit resolved URL drifted for ${rawUrl}`);
    if (integer(audit.statusCode, `audit[${index}].statusCode`) !== expected.statusCode) throw new Error(`V7 audit status drifted for ${rawUrl}`);
    if (integer(audit.scriptCount, `audit[${index}].scriptCount`) !== expected.scriptCount) throw new Error(`V7 audit script count drifted for ${rawUrl}`);
    if (boolean(audit.observedGoogleAnalyticsOrAdsBrowserTag, `audit[${index}].observedGoogleAnalyticsOrAdsBrowserTag`) !== false) {
      throw new Error("V7 cannot invent browser-visible Google measurement tags");
    }
    const detectorBasis = array(audit.detectorBasis, `audit[${index}].detectorBasis`).map((row) => text(row, "V7 detector basis"));
    sameStringSet(detectorBasis, REQUIRED_DETECTOR_BASIS, "V7 detector basis");
    if (text(audit.interpretation, `audit[${index}].interpretation`) !== "BROWSER_VISIBLE_GOOGLE_MEASUREMENT_TAG_NOT_OBSERVED_DOES_NOT_RULE_OUT_SERVER_SIDE_OR_OTHER_MEASUREMENT") {
      throw new Error("V7 browser audit interpretation cannot be strengthened");
    }
    return {
      source: audit.source,
      rawUrl,
      resolvedUrl: audit.resolvedUrl,
      statusCode: audit.statusCode,
      scriptCount: audit.scriptCount,
      observedGoogleAnalyticsOrAdsBrowserTag: false,
      detectorBasis: [...detectorBasis].sort(),
      interpretation: audit.interpretation,
    };
  });
  sameStringSet(audits.map((row) => row.rawUrl), Object.keys(EXPECTED_AUDITS), "V7 audited URLs");

  const sources = object(evidence.connectedDataSources, "evidence.connectedDataSources");
  if (integer(sources.ga4AccessiblePropertyCount, "sources.ga4AccessiblePropertyCount") !== 0) throw new Error("V7 cannot invent an accessible GA4 property");
  if (text(sources.ga4Status, "sources.ga4Status") !== "NO_ACCESSIBLE_PROPERTIES_IN_CONNECTED_DATA_SOURCE") throw new Error("V7 GA4 status drifted");
  if (boolean(sources.nexusGoogleAdsAccountObserved, "sources.nexusGoogleAdsAccountObserved") !== false) throw new Error("V7 cannot invent a connected Nexus Google Ads account");
  if (text(sources.googleAdsStatus, "sources.googleAdsStatus") !== "NO_NEXUS_ACCOUNT_OBSERVED_IN_CONNECTED_DATA_SOURCE") throw new Error("V7 Google Ads status drifted");
  if (integer(sources.metaAdsAccessibleAccountCount, "sources.metaAdsAccessibleAccountCount") !== 0) throw new Error("V7 cannot invent an accessible Meta Ads account");
  if (text(sources.metaAdsStatus, "sources.metaAdsStatus") !== "NO_ACCESSIBLE_ACCOUNTS_IN_CONNECTED_DATA_SOURCE") throw new Error("V7 Meta Ads status drifted");
  if (text(sources.nexusFirstPartyConversionDataset, "sources.nexusFirstPartyConversionDataset") !== "UNAVAILABLE") throw new Error("V7 cannot invent a first-party conversion dataset");
  if (text(sources.interpretation, "sources.interpretation") !== "CONNECTED_SOURCE_SCOPE_IS_NOT_PROOF_THAT_NO_EXTERNAL_ANALYTICS_OR_AD_ACCOUNT_EXISTS") throw new Error("V7 connected-source interpretation cannot be strengthened");

  const funnel = object(evidence.planningFunnelSensitivity, "evidence.planningFunnelSensitivity");
  if (text(funnel.evidenceClass, "funnel.evidenceClass") !== "HYPOTHETICAL_PLANNING_SENSITIVITY_NOT_OBSERVED_FUNNEL") throw new Error("V7 funnel evidence class drifted");
  const visitToContactPpm = integer(funnel.visitToContactPpm, "funnel.visitToContactPpm", 1, 1_000_000);
  const contactToQualifiedPpm = integer(funnel.contactToQualifiedPpm, "funnel.contactToQualifiedPpm", 1, 1_000_000);
  const qualifiedToClosePpm = integer(funnel.qualifiedToClosePpm, "funnel.qualifiedToClosePpm", 1, 1_000_000);
  const derivedSessionToClientPpm = integer(funnel.derivedSessionToClientPpm, "funnel.derivedSessionToClientPpm", 1, 1_000_000);
  if (visitToContactPpm !== 40_000 || contactToQualifiedPpm !== 550_000 || qualifiedToClosePpm !== 350_000 || derivedSessionToClientPpm !== REQUIRED_HYPOTHETICAL_PPM) {
    throw new Error("V7 hypothetical funnel sensitivity drifted");
  }
  const recomputed = Math.floor(Math.floor((visitToContactPpm * contactToQualifiedPpm) / 1_000_000) * qualifiedToClosePpm / 1_000_000);
  if (recomputed !== derivedSessionToClientPpm) throw new Error("V7 hypothetical funnel product is inconsistent");
  if (boolean(funnel.observed, "funnel.observed") !== false) throw new Error("V7 hypothetical funnel cannot be promoted to observed evidence");

  const requiredEvents = array(evidence.requiredObservedFunnelEvents, "evidence.requiredObservedFunnelEvents").map((row) => text(row, "V7 funnel event"));
  sameStringSet(requiredEvents, REQUIRED_FUNNEL_EVENTS, "V7 required funnel events");
  const attributionDimensions = array(evidence.requiredAttributionDimensions, "evidence.requiredAttributionDimensions").map((row) => text(row, "V7 attribution dimension"));
  sameStringSet(attributionDimensions, REQUIRED_ATTRIBUTION_DIMENSIONS, "V7 attribution dimensions");

  const rules = object(evidence.planningRules, "evidence.planningRules");
  const expectedRules = {
    browserAuditMayBeUsedAs: "MEASUREMENT_READINESS_SIGNAL_ONLY_NOT_PROOF_OF_TOTAL_ANALYTICS_ABSENCE",
    connectedSourceMayBeUsedAs: "ACCESS_SCOPE_SIGNAL_ONLY_NOT_PROOF_NO_EXTERNAL_ACCOUNT_EXISTS",
    funnelSensitivityMayBeUsedAs: "BREAK_EVEN_REQUIREMENT_MATH_ONLY_NOT_EXPECTED_CONVERSION",
    probabilityClaim: "NOT_IDENTIFIABLE_WITHOUT_OBSERVED_FUNNEL_DISTRIBUTION",
    clientFloorSupport: "REQUIRES_OBSERVED_SESSION_CONTACT_QUALIFIED_CLOSE_COUNTS_AND_CHANNEL_ATTRIBUTION",
  };
  for (const [key, expected] of Object.entries(expectedRules)) {
    if (text(rules[key], `rules.${key}`) !== expected) throw new Error(`V7 planning rule drifted: ${key}`);
  }

  return {
    schemaVersion: 1,
    evidenceId: evidence.evidenceId,
    capturedAt: evidence.capturedAt,
    siteId: evidence.siteId,
    market: { country: market.country, language: market.language },
    boundary: evidence.boundary,
    liveBrowserAudits: audits.sort((a, b) => a.rawUrl.localeCompare(b.rawUrl)),
    connectedDataSources: structuredClone(sources),
    planningFunnelSensitivity: {
      evidenceClass: funnel.evidenceClass,
      visitToContactPpm,
      contactToQualifiedPpm,
      qualifiedToClosePpm,
      derivedSessionToClientPpm,
      observed: false,
    },
    requiredObservedFunnelEvents: [...requiredEvents].sort(),
    requiredAttributionDimensions: [...attributionDimensions].sort(),
    planningRules: structuredClone(rules),
  };
}

export function runCommercialDemandTournamentV7(rawBaseScenario, rawV3Evidence, rawV4Evidence, rawV5Evidence, rawV6Evidence, rawV7Evidence) {
  const v6 = runCommercialDemandTournamentV6(rawBaseScenario, rawV3Evidence, rawV4Evidence, rawV5Evidence, rawV6Evidence);
  if (v6.targetSupportVerdict !== REQUIRED_V6_VERDICT) throw new Error("V7 requires the certified V6 verdict");
  const envelope = v6.channelFrontier?.maxExactCaptureEnvelope;
  if (!envelope || envelope.combinedNoOverlapUpperBoundSessionsMilli !== REQUIRED_V6_SESSIONS_MILLI) throw new Error("V7 requires the certified V6 session envelope");
  if (envelope.requiredSessionToClientPpmFor15Clients !== REQUIRED_V6_FLOOR_PPM) throw new Error("V7 requires the certified V6 15-client rate requirement");
  if (envelope.highConversionSensitivityPpm !== REQUIRED_HYPOTHETICAL_PPM || envelope.highConversionUpperBoundModeledClientsMilli !== 8_835) {
    throw new Error("V7 requires the certified V6 hypothetical high-conversion sensitivity");
  }

  const evidence = validateObservabilityEvidence(rawV7Evidence);
  const funnel = evidence.planningFunnelSensitivity;
  const requiredPpm = envelope.requiredSessionToClientPpmFor15Clients;
  const relativeUpliftFactorPpm = ceilBigIntRatioToNumber(BigInt(requiredPpm) * 1_000_000n, BigInt(funnel.derivedSessionToClientPpm), "V7 relative uplift factor");
  const visitToContactOnlyPpm = ceilBigIntRatioToNumber(
    BigInt(requiredPpm) * 1_000_000_000_000n,
    BigInt(funnel.contactToQualifiedPpm) * BigInt(funnel.qualifiedToClosePpm),
    "V7 visit-to-contact break-even",
  );
  const contactToQualifiedOnlyPpm = ceilBigIntRatioToNumber(
    BigInt(requiredPpm) * 1_000_000_000_000n,
    BigInt(funnel.visitToContactPpm) * BigInt(funnel.qualifiedToClosePpm),
    "V7 contact-to-qualified break-even",
  );
  const qualifiedToCloseOnlyPpm = ceilBigIntRatioToNumber(
    BigInt(requiredPpm) * 1_000_000_000_000n,
    BigInt(funnel.visitToContactPpm) * BigInt(funnel.contactToQualifiedPpm),
    "V7 qualified-to-close break-even",
  );

  const evidenceSha256 = sha256(evidence);
  const reportWithoutHash = {
    schemaVersion: 1,
    engineId: "WALLE_NEXUS_COMMERCIAL_DEMAND_TOURNAMENT_V7",
    objective: structuredClone(v6.objective),
    v6BaselineProof: {
      reportSha256: v6.reportSha256,
      targetSupportVerdict: v6.targetSupportVerdict,
      organicPageCount: v6.v5BaselineProof.pageCount,
      organicModeledSessionsMilli: v6.v5BaselineProof.organicModeledSessionsMilli,
      maxExactPaidClicksMilli: envelope.forecastPaidClicksMilli,
      combinedNoOverlapUpperBoundSessionsMilli: envelope.combinedNoOverlapUpperBoundSessionsMilli,
      hypotheticalHighConversionPpm: envelope.highConversionSensitivityPpm,
      hypotheticalHighConversionClientsMilli: envelope.highConversionUpperBoundModeledClientsMilli,
      requiredSessionToClientPpmFor15Clients: envelope.requiredSessionToClientPpmFor15Clients,
    },
    observabilityEvidence: evidence,
    evidenceSha256,
    measurementReadiness: {
      status: "FIRST_PARTY_FUNNEL_OUTCOME_DATA_UNAVAILABLE",
      auditedPageCount: evidence.liveBrowserAudits.length,
      browserVisibleGoogleMeasurementTagObservedOnAuditedPages: evidence.liveBrowserAudits.some((row) => row.observedGoogleAnalyticsOrAdsBrowserTag),
      ga4AccessiblePropertyCount: evidence.connectedDataSources.ga4AccessiblePropertyCount,
      nexusGoogleAdsAccountObserved: evidence.connectedDataSources.nexusGoogleAdsAccountObserved,
      metaAdsAccessibleAccountCount: evidence.connectedDataSources.metaAdsAccessibleAccountCount,
      requiredObservedFunnelEvents: [...evidence.requiredObservedFunnelEvents],
      requiredAttributionDimensions: [...evidence.requiredAttributionDimensions],
      probabilityOfAtLeast15ClientsPerMonth: "NOT_IDENTIFIABLE_FROM_AVAILABLE_EVIDENCE",
    },
    conversionFrontier: {
      v6CombinedNoOverlapUpperBoundSessionsMilli: envelope.combinedNoOverlapUpperBoundSessionsMilli,
      hypotheticalPlanningSessionToClientPpm: funnel.derivedSessionToClientPpm,
      hypotheticalPlanningClientsMilliAtV6Envelope: envelope.highConversionUpperBoundModeledClientsMilli,
      requiredSessionToClientPpmFor15Clients: envelope.requiredSessionToClientPpmFor15Clients,
      requiredSessionToClientPpmFor16Clients: envelope.requiredSessionToClientPpmFor16Clients,
      requiredSessionToClientPpmFor20Clients: envelope.requiredSessionToClientPpmFor20Clients,
      relativeUpliftFactorPpmVsHypotheticalPlanningSensitivity: relativeUpliftFactorPpm,
      oneStageBreakEvenRequirements: {
        visitToContactPpmIfOtherStagesFixed: visitToContactOnlyPpm,
        contactToQualifiedPpmIfOtherStagesFixed: contactToQualifiedOnlyPpm,
        qualifiedToClosePpmIfOtherStagesFixed: qualifiedToCloseOnlyPpm,
      },
      floorSupportEligible: false,
      floorSupportReason: "OBSERVED_CONVERSION_DISTRIBUTION_AND_CHANNEL_INCREMENTALITY_ARE_MISSING",
    },
    targetSupportVerdict: "OBSERVED_FUNNEL_REQUIRED_BEFORE_15_CLIENT_FLOOR_CLAIM",
    warnings: [
      "BROWSER_VISIBLE_GOOGLE_MEASUREMENT_TAG_NOT_OBSERVED_ON_AUDITED_PAGES",
      "CONNECTED_DATA_SOURCE_SCOPE_DOES_NOT_PROVE_TOTAL_ACCOUNT_ABSENCE",
      "FIRST_PARTY_FUNNEL_OUTCOME_DATA_IS_UNAVAILABLE",
      "FUNNEL_CONVERSION_REMAINS_HYPOTHETICAL",
      "PROBABILITY_OF_15_PLUS_CLIENTS_IS_NOT_IDENTIFIABLE",
      "NO_LEAD_CLIENT_OR_REVENUE_GUARANTEE",
    ],
    decisionBoundary: "PLAN_ONLY_NO_AUTONOMOUS_SITE_CMS_ADS_DNS_OR_TENANT_MUTATION",
  };

  return { ...reportWithoutHash, reportSha256: sha256(reportWithoutHash) };
}
