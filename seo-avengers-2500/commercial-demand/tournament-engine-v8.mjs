import { createHash } from "node:crypto";
import { runCommercialDemandTournamentV7 } from "./tournament-engine-v7.mjs";

const REQUIRED_V7_VERDICT = "OBSERVED_FUNNEL_REQUIRED_BEFORE_15_CLIENT_FLOOR_CLAIM";
const REQUIRED_V7_PROBABILITY_STATUS = "NOT_IDENTIFIABLE_FROM_AVAILABLE_EVIDENCE";
const REQUIRED_BOUNDARY = "MEASUREMENT_CONTRACT_AND_STATISTICAL_ACCEPTANCE_DESIGN_ONLY_NOT_PRODUCTION_INSTRUMENTATION_OR_OUTCOME_EVIDENCE";
const REQUIRED_CONTRACT_ID = "NEXUS_FUNNEL_MEASUREMENT_CONTRACT_V8";
const REQUIRED_TARGET_PPM = 13_073;
const REQUIRED_BASE_CHECKPOINT_SESSIONS = 1_148;
const REQUIRED_CHECKPOINT_MULTIPLIERS = Object.freeze([1, 2, 4, 8]);
const REQUIRED_EVENT_TYPES = Object.freeze(["SESSION", "CONTACT", "QUALIFIED_LEAD", "CLOSED_CLIENT"]);
const REQUIRED_QUALITY_GATES = Object.freeze([
  "NO_DUPLICATE_EVENT_IDS",
  "NO_ORPHAN_CONTACTS",
  "NO_ORPHAN_QUALIFIED_LEADS",
  "NO_ORPHAN_CLOSED_CLIENTS",
  "NO_REPEAT_CLIENT_AS_NEW_CLIENT",
  "QUALIFICATION_POLICY_VERSION_PRESENT",
  "RAW_ATTRIBUTION_FIELDS_PRESERVED",
  "COHORT_BOUNDARIES_DECLARED",
  "COHORT_MATURITY_EVIDENCE_DECLARED",
]);
const REQUIRED_FIELDS = Object.freeze({
  SESSION: Object.freeze(["eventId", "occurredAt", "sessionId", "landingPage", "rawSource", "rawMedium", "rawCampaign"]),
  CONTACT: Object.freeze(["eventId", "occurredAt", "sessionId", "leadId", "contactMethod"]),
  QUALIFIED_LEAD: Object.freeze(["eventId", "occurredAt", "leadId", "qualificationPolicyVersion"]),
  CLOSED_CLIENT: Object.freeze(["eventId", "occurredAt", "leadId", "newClientIdHash", "isNewClient"]),
});

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

function sameIntegerList(actual, expected, name) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error(`${name} does not match the required ordered list`);
}

function wilsonLower(successes, trials, z) {
  if (trials <= 0) throw new Error("Wilson trials must be positive");
  if (successes < 0 || successes > trials) throw new Error("Wilson successes must be within trials");
  const p = successes / trials;
  const z2 = z * z;
  const denominator = 1 + z2 / trials;
  const center = p + z2 / (2 * trials);
  const adjustment = z * Math.sqrt((p * (1 - p)) / trials + z2 / (4 * trials * trials));
  return (center - adjustment) / denominator;
}

function minimumSuccessesForWilsonLowerPpm(trials, targetPpm, z) {
  for (let successes = 0; successes <= trials; successes += 1) {
    const lowerPpm = Math.floor(wilsonLower(successes, trials, z) * 1_000_000);
    if (lowerPpm >= targetPpm) {
      return {
        successes,
        observedRatePpm: Math.round((successes / trials) * 1_000_000),
        wilsonLowerPpm: lowerPpm,
        previousWilsonLowerPpm: successes === 0 ? null : Math.floor(wilsonLower(successes - 1, trials, z) * 1_000_000),
      };
    }
  }
  throw new Error("Wilson target cannot be reached");
}

function validateMeasurementContract(rawContract) {
  const contract = object(structuredClone(rawContract), "contract");
  if (contract.schemaVersion !== 1) throw new Error("unsupported V8 contract schemaVersion");
  if (text(contract.contractId, "contract.contractId") !== REQUIRED_CONTRACT_ID) throw new Error("unexpected V8 contractId");
  text(contract.capturedAt, "contract.capturedAt");
  if (text(contract.siteId, "contract.siteId") !== "nexus-bot-studio") throw new Error("unexpected V8 siteId");
  if (text(contract.boundary, "contract.boundary") !== REQUIRED_BOUNDARY) throw new Error("V8 contract boundary cannot be weakened");

  const objective = object(contract.objective, "contract.objective");
  if (text(objective.metric, "contract.objective.metric") !== "NEW_CLIENTS_PER_MONTH") throw new Error("V8 objective metric drifted");
  if (integer(objective.planningFloorClients, "contract.objective.planningFloorClients") !== 15) throw new Error("V8 planning floor drifted");
  if (integer(objective.v6RequiredSessionToClientPpm, "contract.objective.v6RequiredSessionToClientPpm") !== REQUIRED_TARGET_PPM) throw new Error("V8 V6 target rate drifted");
  if (text(objective.interpretation, "contract.objective.interpretation") !== "RATE_REQUIREMENT_FROM_CERTIFIED_V6_UPPER_BOUND_NOT_OBSERVED_CONVERSION") throw new Error("V8 objective interpretation cannot be promoted");

  const events = array(contract.eventContract, "contract.eventContract").map((raw, index) => {
    const event = object(raw, `contract.eventContract[${index}]`);
    const eventType = text(event.eventType, `event[${index}].eventType`);
    if (!REQUIRED_EVENT_TYPES.includes(eventType)) throw new Error(`unexpected V8 event type ${eventType}`);
    const requiredFields = array(event.requiredFields, `event[${index}].requiredFields`).map((row) => text(row, "V8 event required field"));
    sameStringSet(requiredFields, REQUIRED_FIELDS[eventType], `V8 ${eventType} required fields`);
    const expectedUnit = {
      SESSION: "UNIQUE_SESSION_ID",
      CONTACT: "UNIQUE_LEAD_ID",
      QUALIFIED_LEAD: "UNIQUE_LEAD_ID_UNDER_VERSIONED_POLICY",
      CLOSED_CLIENT: "UNIQUE_NEW_CLIENT_ID_HASH",
    }[eventType];
    if (text(event.unitOfCount, `event[${index}].unitOfCount`) !== expectedUnit) throw new Error(`V8 ${eventType} unit of count drifted`);
    return { eventType, unitOfCount: event.unitOfCount, requiredFields: [...requiredFields].sort() };
  });
  sameStringSet(events.map((row) => row.eventType), REQUIRED_EVENT_TYPES, "V8 event types");

  const joinRules = object(contract.joinAndCountingRules, "contract.joinAndCountingRules");
  const requiredJoinRules = {
    eventId: "UNIQUE_ACROSS_DATASET",
    contactRequiresSession: true,
    qualifiedLeadRequiresContact: true,
    closedClientRequiresQualifiedLead: true,
    closedClientCountRule: "COUNT_DISTINCT_NEW_CLIENT_ID_HASH_WHERE_IS_NEW_CLIENT_TRUE",
    repeatPurchaseOrExpansionRule: "MUST_NOT_COUNT_AS_NEW_CLIENT",
    qualificationPolicyRule: "POLICY_VERSION_MUST_BE_RETAINED_AND_NOT_REWRITTEN_RETROACTIVELY",
    attributionRule: "PRESERVE_RAW_SOURCE_MEDIUM_CAMPAIGN_AND_LANDING_PAGE_BEFORE_ANY_NORMALIZED_CHANNEL_MAPPING",
    cohortRule: "SESSION_DENOMINATOR_AND_DOWNSTREAM_OUTCOMES_MUST_USE_THE_SAME_DECLARED_COHORT",
    maturityRule: "DO_NOT_DECLARE_A_COHORT_MATURE_UNTIL_CLOSE_LAG_EVIDENCE_SUPPORTS_THE_CUTOFF",
  };
  for (const [key, expected] of Object.entries(requiredJoinRules)) {
    if (typeof expected === "boolean") {
      if (boolean(joinRules[key], `joinRules.${key}`) !== expected) throw new Error(`V8 join rule drifted: ${key}`);
    } else if (text(joinRules[key], `joinRules.${key}`) !== expected) {
      throw new Error(`V8 join rule drifted: ${key}`);
    }
  }

  const privacy = object(contract.privacyRules, "contract.privacyRules");
  if (boolean(privacy.rawPhoneRequired, "privacy.rawPhoneRequired") !== false) throw new Error("V8 analytics contract must not require raw phone");
  if (boolean(privacy.rawEmailRequired, "privacy.rawEmailRequired") !== false) throw new Error("V8 analytics contract must not require raw email");
  if (boolean(privacy.messageBodyRequired, "privacy.messageBodyRequired") !== false) throw new Error("V8 analytics contract must not require message content");
  if (text(privacy.clientIdentityForAnalysis, "privacy.clientIdentityForAnalysis") !== "PSEUDONYMOUS_STABLE_HASH_ONLY") throw new Error("V8 client identity rule drifted");
  if (text(privacy.interpretation, "privacy.interpretation") !== "ANALYTICS_CONTRACT_DOES_NOT_REQUIRE_RAW_CONTACT_PII_OR_MESSAGE_CONTENT") throw new Error("V8 privacy interpretation drifted");

  const qualityGates = array(contract.qualityGates, "contract.qualityGates").map((row) => text(row, "V8 quality gate"));
  sameStringSet(qualityGates, REQUIRED_QUALITY_GATES, "V8 quality gates");

  const design = object(contract.statisticalDesign, "contract.statisticalDesign");
  if (text(design.method, "statisticalDesign.method") !== "WILSON_SCORE_LOWER_BOUND") throw new Error("V8 statistical method drifted");
  if (integer(design.confidenceLevelPermille, "statisticalDesign.confidenceLevelPermille") !== 950) throw new Error("V8 confidence level drifted");
  if (integer(design.zMilli, "statisticalDesign.zMilli") !== 1960) throw new Error("V8 z value drifted");
  if (integer(design.targetSessionToClientPpm, "statisticalDesign.targetSessionToClientPpm") !== REQUIRED_TARGET_PPM) throw new Error("V8 target PPM drifted");
  if (text(design.successDefinition, "statisticalDesign.successDefinition") !== "UNIQUE_NEW_CLOSED_CLIENT") throw new Error("V8 success definition drifted");
  if (text(design.denominatorDefinition, "statisticalDesign.denominatorDefinition") !== "UNIQUE_SESSION_IN_FULLY_MATURED_DECLARED_COHORT") throw new Error("V8 denominator definition drifted");
  if (text(design.checkpointBasis, "statisticalDesign.checkpointBasis") !== "MULTIPLES_OF_CEILING_OF_CERTIFIED_V6_ZERO_OVERLAP_UPPER_BOUND_SESSIONS") throw new Error("V8 checkpoint basis drifted");
  if (integer(design.baseCheckpointSessions, "statisticalDesign.baseCheckpointSessions") !== REQUIRED_BASE_CHECKPOINT_SESSIONS) throw new Error("V8 base checkpoint drifted");
  const multipliers = array(design.checkpointMultipliers, "statisticalDesign.checkpointMultipliers").map((row) => integer(row, "V8 checkpoint multiplier", 1, 100));
  sameIntegerList(multipliers, REQUIRED_CHECKPOINT_MULTIPLIERS, "V8 checkpoint multipliers");
  if (text(design.interpretation, "statisticalDesign.interpretation") !== "PROSPECTIVE_RATE_EVIDENCE_DESIGN_ONLY_NOT_PROBABILITY_OF_MONTHLY_CLIENT_COUNT") throw new Error("V8 statistical interpretation cannot be promoted");

  const rules = object(contract.planningRules, "contract.planningRules");
  const expectedRules = {
    schemaMayBeUsedAs: "FUTURE_FIRST_PARTY_EVIDENCE_CONTRACT_ONLY",
    statisticalGateMayBeUsedAs: "CONVERSION_RATE_SUPPORT_CHECK_ON_FULLY_MATURED_OBSERVED_COHORTS_ONLY",
    statisticalGateMayNotBeUsedAs: "TRAFFIC_FORECAST_OR_MONTHLY_CLIENT_PROBABILITY",
    instrumentationStatus: "NOT_INSTALLED_BY_V8",
    outcomeEvidenceStatus: "NOT_OBSERVED_IN_V8",
    productionMutation: "FORBIDDEN",
  };
  for (const [key, expected] of Object.entries(expectedRules)) {
    if (text(rules[key], `planningRules.${key}`) !== expected) throw new Error(`V8 planning rule drifted: ${key}`);
  }

  return {
    schemaVersion: 1,
    contractId: contract.contractId,
    capturedAt: contract.capturedAt,
    siteId: contract.siteId,
    boundary: contract.boundary,
    objective: structuredClone(objective),
    eventContract: events.sort((a, b) => a.eventType.localeCompare(b.eventType)),
    joinAndCountingRules: structuredClone(joinRules),
    privacyRules: structuredClone(privacy),
    qualityGates: [...qualityGates].sort(),
    statisticalDesign: {
      method: design.method,
      confidenceLevelPermille: design.confidenceLevelPermille,
      zMilli: design.zMilli,
      targetSessionToClientPpm: design.targetSessionToClientPpm,
      successDefinition: design.successDefinition,
      denominatorDefinition: design.denominatorDefinition,
      checkpointBasis: design.checkpointBasis,
      baseCheckpointSessions: design.baseCheckpointSessions,
      checkpointMultipliers: [...multipliers],
      interpretation: design.interpretation,
    },
    planningRules: structuredClone(rules),
  };
}

export function runCommercialDemandTournamentV8(rawBaseScenario, rawV3Evidence, rawV4Evidence, rawV5Evidence, rawV6Evidence, rawV7Evidence, rawV8Contract) {
  const v7 = runCommercialDemandTournamentV7(rawBaseScenario, rawV3Evidence, rawV4Evidence, rawV5Evidence, rawV6Evidence, rawV7Evidence);
  if (v7.targetSupportVerdict !== REQUIRED_V7_VERDICT) throw new Error("V8 requires the certified V7 verdict");
  if (v7.measurementReadiness?.probabilityOfAtLeast15ClientsPerMonth !== REQUIRED_V7_PROBABILITY_STATUS) throw new Error("V8 requires the certified V7 probability boundary");
  if (v7.conversionFrontier?.requiredSessionToClientPpmFor15Clients !== REQUIRED_TARGET_PPM) throw new Error("V8 requires the certified V7 target conversion rate");
  if (v7.v6BaselineProof?.combinedNoOverlapUpperBoundSessionsMilli !== 1_147_440) throw new Error("V8 requires the certified V6 traffic envelope through V7");

  const contract = validateMeasurementContract(rawV8Contract);
  if (contract.statisticalDesign.baseCheckpointSessions !== Math.ceil(v7.v6BaselineProof.combinedNoOverlapUpperBoundSessionsMilli / 1000)) {
    throw new Error("V8 base checkpoint must remain tied to the certified V6 envelope");
  }

  const z = contract.statisticalDesign.zMilli / 1000;
  const targetPpm = contract.statisticalDesign.targetSessionToClientPpm;
  const checkpoints = contract.statisticalDesign.checkpointMultipliers.map((multiplier) => {
    const sessions = contract.statisticalDesign.baseCheckpointSessions * multiplier;
    const threshold = minimumSuccessesForWilsonLowerPpm(sessions, targetPpm, z);
    return {
      multiplier,
      sessions,
      minimumUniqueNewClosedClientsForWilsonLowerBound: threshold.successes,
      minimumObservedRatePpmAtThreshold: threshold.observedRatePpm,
      wilsonLowerPpmAtThreshold: threshold.wilsonLowerPpm,
      wilsonLowerPpmOneFewerClient: threshold.previousWilsonLowerPpm,
      targetSessionToClientPpm: targetPpm,
      confidenceLevelPermille: contract.statisticalDesign.confidenceLevelPermille,
      evidenceUse: "CONVERSION_RATE_GATE_ONLY_ON_FULLY_MATURED_OBSERVED_COHORT",
    };
  });

  const contractSha256 = sha256(contract);
  const reportWithoutHash = {
    schemaVersion: 1,
    engineId: "WALLE_NEXUS_COMMERCIAL_DEMAND_TOURNAMENT_V8",
    objective: structuredClone(v7.objective),
    v7BaselineProof: {
      reportSha256: v7.reportSha256,
      targetSupportVerdict: v7.targetSupportVerdict,
      probabilityStatus: v7.measurementReadiness.probabilityOfAtLeast15ClientsPerMonth,
      combinedNoOverlapUpperBoundSessionsMilli: v7.v6BaselineProof.combinedNoOverlapUpperBoundSessionsMilli,
      requiredSessionToClientPpmFor15Clients: v7.conversionFrontier.requiredSessionToClientPpmFor15Clients,
      firstPartyOutcomeDataStatus: v7.measurementReadiness.status,
    },
    measurementContract: contract,
    contractSha256,
    statisticalAcceptanceFrontier: {
      method: contract.statisticalDesign.method,
      confidenceLevelPermille: contract.statisticalDesign.confidenceLevelPermille,
      targetSessionToClientPpm: targetPpm,
      checkpoints,
      interpretation: "THESE_THRESHOLDS_SUPPORT_ONLY_A_CONVERSION_RATE_LOWER_BOUND_ON_MATURED_OBSERVED_COHORTS_AND_DO_NOT_PREDICT_MONTHLY_CLIENT_COUNTS",
    },
    measurementImplementationReadiness: {
      contractDefined: true,
      productionInstrumentationInstalledByV8: false,
      firstPartyObservedOutcomeDatasetAvailable: false,
      cohortMaturityCutoffKnownFromObservedCloseLag: false,
      attributionJoinObserved: false,
      newClientDeduplicationObserved: false,
      probabilityOfAtLeast15ClientsPerMonth: "STILL_NOT_IDENTIFIABLE_UNTIL_REAL_COHORTS_EXIST",
    },
    targetSupportVerdict: "MEASUREMENT_CONTRACT_READY_OBSERVED_COHORTS_STILL_REQUIRED",
    warnings: [
      "V8_DOES_NOT_INSTALL_PRODUCTION_TRACKING",
      "STATISTICAL_THRESHOLDS_ARE_NOT_TRAFFIC_OR_CLIENT_FORECASTS",
      "COHORT_MATURITY_REQUIRES_OBSERVED_CLOSE_LAG_EVIDENCE",
      "PROBABILITY_OF_15_PLUS_CLIENTS_REMAINS_UNIDENTIFIABLE",
      "NO_LEAD_CLIENT_OR_REVENUE_GUARANTEE",
    ],
    decisionBoundary: "PLAN_ONLY_NO_AUTONOMOUS_SITE_CMS_ADS_DNS_OR_TENANT_MUTATION",
  };

  return { ...reportWithoutHash, reportSha256: sha256(reportWithoutHash) };
}
