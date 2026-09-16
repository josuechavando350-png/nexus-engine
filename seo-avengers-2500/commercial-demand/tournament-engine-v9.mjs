import { createHash } from "node:crypto";
import { runCommercialDemandTournamentV8 } from "./tournament-engine-v8.mjs";
import { buildCommercialDemandScenarioV5 } from "./tournament-v5-scenario.mjs";

const REQUIRED_V8_VERDICT = "MEASUREMENT_CONTRACT_READY_OBSERVED_COHORTS_STILL_REQUIRED";
const REQUIRED_CONTRACT_ID = "NEXUS_COMMERCIAL_EXECUTION_SEQUENCE_CONTRACT_V9";
const REQUIRED_BOUNDARY = "EXECUTION_SEQUENCE_DESIGN_ONLY_NOT_PRODUCTION_MUTATION_TRAFFIC_FORECAST_OR_CLIENT_OUTCOME_FORECAST";
const REQUIRED_STRATEGY_ID = "OFFER_FIT_FULL_VALIDATED_40";
const REQUIRED_PAGE_COUNT = 40;
const REQUIRED_RELEVANT_SESSIONS_MILLI = 776_700;
const REQUIRED_WAVE_SIZE = 8;
const REQUIRED_EVENT_TYPES = Object.freeze(["SESSION", "CONTACT", "QUALIFIED_LEAD", "CLOSED_CLIENT"]);
const REQUIRED_WAVE_GATES = Object.freeze([
  "MEASUREMENT_CONTRACT_IMPLEMENTED_AND_VALIDATED",
  "NO_DUPLICATE_OR_ORPHAN_FUNNEL_EVENTS",
  "RAW_ATTRIBUTION_FIELDS_PRESERVED",
  "CONTENT_AND_INDEXABILITY_VALIDATION_GREEN",
  "NO_CLIENT_OR_REVENUE_GUARANTEE",
]);
const EXPLICIT_AUTHORIZATION_BOUNDARY = "FORBIDDEN_UNTIL_EXPLICIT_USER_AUTHORIZATION";

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
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) throw new TypeError(`${name} must be safe integer in range ${minimum}..${maximum}`);
  return value;
}

function boolean(value, name) {
  if (typeof value !== "boolean") throw new TypeError(`${name} must be boolean`);
  return value;
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]));
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

function validateExecutionContract(rawContract) {
  const contract = object(structuredClone(rawContract), "contract");
  if (contract.schemaVersion !== 1) throw new Error("unsupported V9 contract schemaVersion");
  if (text(contract.contractId, "contract.contractId") !== REQUIRED_CONTRACT_ID) throw new Error("unexpected V9 contractId");
  text(contract.capturedAt, "contract.capturedAt");
  if (text(contract.siteId, "contract.siteId") !== "nexus-bot-studio") throw new Error("unexpected V9 siteId");
  if (text(contract.boundary, "contract.boundary") !== REQUIRED_BOUNDARY) throw new Error("V9 contract boundary cannot be weakened");

  const baseline = object(contract.baseline, "contract.baseline");
  if (text(baseline.requiredStrategyId, "baseline.requiredStrategyId") !== REQUIRED_STRATEGY_ID) throw new Error("V9 strategy baseline drifted");
  if (integer(baseline.requiredPageCount, "baseline.requiredPageCount") !== REQUIRED_PAGE_COUNT) throw new Error("V9 page-count baseline drifted");
  if (integer(baseline.requiredRelevantSessionsMilli, "baseline.requiredRelevantSessionsMilli") !== REQUIRED_RELEVANT_SESSIONS_MILLI) throw new Error("V9 capacity baseline drifted");
  if (text(baseline.requiredV8Verdict, "baseline.requiredV8Verdict") !== REQUIRED_V8_VERDICT) throw new Error("V9 V8 verdict baseline drifted");

  const sequencing = object(contract.sequencingPolicy, "contract.sequencingPolicy");
  if (integer(sequencing.waveSize, "sequencing.waveSize", 1, 40) !== REQUIRED_WAVE_SIZE) throw new Error("V9 wave size drifted");
  if (text(sequencing.familyAssignmentRule, "sequencing.familyAssignmentRule") !== "ASSIGN_EACH_RELEVANT_DEMAND_FAMILY_TO_SELECTED_PAGE_WITH_FEWEST_DECLARED_FAMILIES_THEN_STABLE_PAGE_ID") throw new Error("V9 family assignment rule drifted");
  if (text(sequencing.pageRankingRule, "sequencing.pageRankingRule") !== "ASSIGNED_RELEVANT_SESSIONS_DESC_THEN_ASSIGNED_STRICT_COMMERCIAL_SESSIONS_DESC_THEN_ASSIGNED_RAW_SEARCH_VOLUME_DESC_THEN_STABLE_PAGE_ID") throw new Error("V9 page ranking rule drifted");
  if (boolean(sequencing.informationalFamiliesEligible, "sequencing.informationalFamiliesEligible") !== false) throw new Error("V9 informational families cannot become execution capacity");
  if (boolean(sequencing.zeroIncrementPagesAllowed, "sequencing.zeroIncrementPagesAllowed") !== true) throw new Error("V9 must preserve architecture-support pages");
  if (text(sequencing.zeroIncrementPageInterpretation, "sequencing.zeroIncrementPageInterpretation") !== "ARCHITECTURE_OR_DECISION_SUPPORT_ONLY_NOT_ADDITIVE_DEMAND") throw new Error("V9 zero-increment interpretation drifted");

  const preconditions = object(contract.preconditions, "contract.preconditions");
  if (boolean(preconditions.measurementContractMustBeImplementedBeforeOutcomeClaims, "preconditions.measurementContractMustBeImplementedBeforeOutcomeClaims") !== true) throw new Error("V9 measurement precondition cannot be weakened");
  if (text(preconditions.measurementContractId, "preconditions.measurementContractId") !== "NEXUS_FUNNEL_MEASUREMENT_CONTRACT_V8") throw new Error("V9 measurement contract id drifted");
  sameStringSet(array(preconditions.requiredEventTypes, "preconditions.requiredEventTypes").map((row) => text(row, "V9 event type")), REQUIRED_EVENT_TYPES, "V9 required event types");
  if (text(preconditions.productionInstrumentationStatus, "preconditions.productionInstrumentationStatus") !== "NOT_INSTALLED_BY_V9") throw new Error("V9 cannot pretend instrumentation is installed");
  if (text(preconditions.paidSearchActivationStatus, "preconditions.paidSearchActivationStatus") !== "NOT_AUTHORIZED_BY_V9") throw new Error("V9 cannot authorize paid search");

  const gates = array(contract.waveGates, "contract.waveGates").map((row) => text(row, "V9 wave gate"));
  sameStringSet(gates, REQUIRED_WAVE_GATES, "V9 wave gates");

  const paid = object(contract.paidSearchGate, "contract.paidSearchGate");
  if (text(paid.eligibleMatchType, "paid.eligibleMatchType") !== "EXACT_ONLY_FROM_CERTIFIED_V6_PORTFOLIO") throw new Error("V9 paid match boundary drifted");
  if (boolean(paid.activationRequiresMeasurementContract, "paid.activationRequiresMeasurementContract") !== true) throw new Error("V9 paid activation must require measurement");
  if (boolean(paid.activationRequiresSeparateAuthorization, "paid.activationRequiresSeparateAuthorization") !== true) throw new Error("V9 paid activation must require separate authorization");
  if (text(paid.phraseBroadFloorSupport, "paid.phraseBroadFloorSupport") !== "FORBIDDEN_WITHOUT_QUERY_LEVEL_INTENT_INCREMENTALITY_AND_OBSERVED_CONVERSION_EVIDENCE") throw new Error("V9 phrase/broad boundary drifted");
  if (text(paid.connectedGoogleAdsAccountOwnership, "paid.connectedGoogleAdsAccountOwnership") !== "THIRD_PARTY_NON_NEXUS_ACCOUNT") throw new Error("V9 connected Ads ownership drifted");
  if (text(paid.connectedGoogleAdsAccountOwnerAlias, "paid.connectedGoogleAdsAccountOwnerAlias") !== "LIC") throw new Error("V9 connected Ads owner drifted");
  if (boolean(paid.connectedGoogleAdsPerformanceMayBeUsedAsNexusEvidence, "paid.connectedGoogleAdsPerformanceMayBeUsedAsNexusEvidence") !== false) throw new Error("V9 cannot use third-party Ads performance as Nexus evidence");
  if (text(paid.connectedGoogleAdsMutation, "paid.connectedGoogleAdsMutation") !== "FORBIDDEN") throw new Error("V9 connected Ads mutation boundary drifted");
  if (text(paid.newConnectedGoogleAdsApiCalls, "paid.newConnectedGoogleAdsApiCalls") !== EXPLICIT_AUTHORIZATION_BOUNDARY) throw new Error("V9 connected Ads API-call boundary drifted");
  if (text(paid.historicalKeywordPlannerSnapshotInterpretation, "paid.historicalKeywordPlannerSnapshotInterpretation") !== "STATIC_MARKET_RESEARCH_ONLY_NOT_NEXUS_FIRST_PARTY_CAMPAIGN_PERFORMANCE") throw new Error("V9 historical planner interpretation drifted");

  const protectedResources = object(contract.protectedThirdPartyResources, "contract.protectedThirdPartyResources");
  if (text(protectedResources.protectedClientAlias, "protectedResources.protectedClientAlias") !== "LIC_CANO") throw new Error("V9 protected client alias drifted");
  for (const key of ["clientDataAccess", "googleAdsAccountAccess", "googleAdsMutation", "vercelAccess", "vercelMutation", "vercelDeployment", "otherClientTenantMutation"]) {
    if (text(protectedResources[key], `protectedResources.${key}`) !== EXPLICIT_AUTHORIZATION_BOUNDARY) throw new Error(`V9 protected resource boundary drifted: ${key}`);
  }
  if (boolean(protectedResources.clientDataUseAsNexusEvidence, "protectedResources.clientDataUseAsNexusEvidence") !== false) throw new Error("V9 cannot use Lic Cano client data as Nexus evidence");

  const rules = object(contract.planningRules, "contract.planningRules");
  const requiredRules = {
    waveOrderMayBeUsedAs: "IMPLEMENTATION_PRIORITY_ONLY",
    waveModeledSessionsMayBeUsedAs: "RELATIVE_PLANNING_CAPACITY_ONLY_NOT_TRAFFIC_FORECAST",
    cumulativeModeledSessionsMayBeUsedAs: "SCENARIO_COVERAGE_ACCOUNTING_ONLY_NOT_OBSERVED_TRAFFIC",
    productionMutation: "FORBIDDEN",
    autonomousPublishing: "FORBIDDEN",
    clientFloorClaim: "FORBIDDEN_UNTIL_V8_OBSERVED_COHORT_GATE_IS_SATISFIED",
  };
  for (const [key, expected] of Object.entries(requiredRules)) {
    if (text(rules[key], `planningRules.${key}`) !== expected) throw new Error(`V9 planning rule drifted: ${key}`);
  }

  return {
    schemaVersion: 1,
    contractId: contract.contractId,
    capturedAt: contract.capturedAt,
    siteId: contract.siteId,
    boundary: contract.boundary,
    baseline: structuredClone(baseline),
    sequencingPolicy: structuredClone(sequencing),
    preconditions: { ...structuredClone(preconditions), requiredEventTypes: [...preconditions.requiredEventTypes].sort() },
    waveGates: [...gates].sort(),
    paidSearchGate: structuredClone(paid),
    protectedThirdPartyResources: structuredClone(protectedResources),
    planningRules: structuredClone(rules),
  };
}

function familySessionsMilli(family, trafficAssumptions) {
  const ctrPpm = trafficAssumptions.targetCtrPpmByIntent[family.intentClass];
  if (!Number.isSafeInteger(ctrPpm)) throw new Error(`missing target CTR for intent ${family.intentClass}`);
  return Math.floor((family.monthlySearchVolume * ctrPpm * trafficAssumptions.clickToSessionPpm) / 1_000_000_000);
}

function buildSequencedPages(rawBaseScenario) {
  const scenario = buildCommercialDemandScenarioV5(rawBaseScenario);
  const strategy = scenario.strategies.find((row) => row.id === REQUIRED_STRATEGY_ID);
  if (!strategy || strategy.pageIds.length !== REQUIRED_PAGE_COUNT) throw new Error("V9 requires the certified V5 40-page strategy");
  const pageById = new Map(scenario.pages.map((row) => [row.id, row]));
  const familyById = new Map(scenario.keywordResearch.families.map((row) => [row.id, row]));
  const selectedPages = strategy.pageIds.map((id) => {
    const page = pageById.get(id);
    if (!page) throw new Error(`V9 selected page missing: ${id}`);
    return page;
  });

  const relevantFamilies = [...familyById.values()].filter((family) => family.intentClass !== "INFORMATIONAL");
  const assignedFamilyIdsByPage = new Map(selectedPages.map((page) => [page.id, []]));
  for (const family of relevantFamilies) {
    const candidates = selectedPages
      .filter((page) => page.demandFamilyIds.includes(family.id))
      .sort((a, b) => a.demandFamilyIds.length - b.demandFamilyIds.length || a.id.localeCompare(b.id));
    if (candidates.length === 0) throw new Error(`V9 relevant family has no selected page: ${family.id}`);
    assignedFamilyIdsByPage.get(candidates[0].id).push(family.id);
  }

  const rows = selectedPages.map((page) => {
    const assignedFamilies = assignedFamilyIdsByPage.get(page.id).map((id) => familyById.get(id));
    const assignedRelevantSessionsMilli = assignedFamilies.reduce((sum, family) => sum + familySessionsMilli(family, scenario.trafficAssumptions), 0);
    const assignedStrictCommercialSessionsMilli = assignedFamilies
      .filter((family) => family.intentClass === "DIRECT" || family.intentClass === "DECISION")
      .reduce((sum, family) => sum + familySessionsMilli(family, scenario.trafficAssumptions), 0);
    const assignedRawSearchVolume = assignedFamilies.reduce((sum, family) => sum + family.monthlySearchVolume, 0);
    return {
      pageId: page.id,
      title: page.title,
      declaredDemandFamilyIds: [...page.demandFamilyIds].sort(),
      assignedDemandFamilyIds: assignedFamilies.map((family) => family.id).sort(),
      assignedRelevantSessionsMilli,
      assignedStrictCommercialSessionsMilli,
      assignedRawSearchVolume,
      role: assignedFamilies.length === 0 ? "ARCHITECTURE_OR_DECISION_SUPPORT" : "DEMAND_CAPTURE",
    };
  });

  rows.sort((a, b) =>
    b.assignedRelevantSessionsMilli - a.assignedRelevantSessionsMilli
    || b.assignedStrictCommercialSessionsMilli - a.assignedStrictCommercialSessionsMilli
    || b.assignedRawSearchVolume - a.assignedRawSearchVolume
    || a.pageId.localeCompare(b.pageId));

  return { scenario, strategy, rows };
}

export function runCommercialDemandTournamentV9(rawBaseScenario, rawV3Evidence, rawV4Evidence, rawV5Evidence, rawV6Evidence, rawV7Evidence, rawV8Contract, rawV9Contract) {
  const v8 = runCommercialDemandTournamentV8(rawBaseScenario, rawV3Evidence, rawV4Evidence, rawV5Evidence, rawV6Evidence, rawV7Evidence, rawV8Contract);
  if (v8.targetSupportVerdict !== REQUIRED_V8_VERDICT) throw new Error("V9 requires the certified V8 verdict");
  if (v8.measurementImplementationReadiness?.productionInstrumentationInstalledByV8 !== false) throw new Error("V9 requires V8 to remain non-production");
  const contract = validateExecutionContract(rawV9Contract);
  const { rows } = buildSequencedPages(rawBaseScenario);
  const totalRelevantSessionsMilli = rows.reduce((sum, row) => sum + row.assignedRelevantSessionsMilli, 0);
  if (totalRelevantSessionsMilli !== REQUIRED_RELEVANT_SESSIONS_MILLI) throw new Error(`V9 page assignment must conserve certified V5 capacity; got ${totalRelevantSessionsMilli}`);

  const waves = [];
  let cumulativeRelevantSessionsMilli = 0;
  for (let offset = 0; offset < rows.length; offset += contract.sequencingPolicy.waveSize) {
    const pages = rows.slice(offset, offset + contract.sequencingPolicy.waveSize);
    const waveRelevantSessionsMilli = pages.reduce((sum, row) => sum + row.assignedRelevantSessionsMilli, 0);
    const waveStrictCommercialSessionsMilli = pages.reduce((sum, row) => sum + row.assignedStrictCommercialSessionsMilli, 0);
    cumulativeRelevantSessionsMilli += waveRelevantSessionsMilli;
    waves.push({
      wave: waves.length + 1,
      pageCount: pages.length,
      pageIds: pages.map((row) => row.pageId),
      pages,
      waveRelevantSessionsMilli,
      waveStrictCommercialSessionsMilli,
      cumulativeRelevantSessionsMilli,
      cumulativeCapacityPpm: Math.floor((cumulativeRelevantSessionsMilli * 1_000_000) / REQUIRED_RELEVANT_SESSIONS_MILLI),
      releaseGate: "REQUIRES_SEPARATE_IMPLEMENTATION_AUTHORIZATION_AND_ALL_V9_WAVE_GATES_GREEN",
    });
  }
  if (waves.length !== 5 || waves.some((wave) => wave.pageCount !== REQUIRED_WAVE_SIZE)) throw new Error("V9 must produce five 8-page waves");

  const evidenceSha256 = sha256(contract);
  const reportWithoutHash = {
    schemaVersion: 1,
    engineId: "WALLE_NEXUS_COMMERCIAL_DEMAND_TOURNAMENT_V9",
    objective: structuredClone(v8.objective),
    v8BaselineProof: {
      reportSha256: v8.reportSha256,
      targetSupportVerdict: v8.targetSupportVerdict,
      measurementContractId: v8.measurementContract.contractId,
      instrumentationStatus: v8.measurementImplementationReadiness.productionInstrumentationInstalledByV8 ? "INSTALLED" : "NOT_INSTALLED_BY_V8",
      probabilityOfAtLeast15ClientsPerMonth: v8.measurementImplementationReadiness.probabilityOfAtLeast15ClientsPerMonth,
    },
    executionContract: contract,
    evidenceSha256,
    executionSequence: {
      strategyId: REQUIRED_STRATEGY_ID,
      pageCount: rows.length,
      conservedRelevantSessionsMilli: totalRelevantSessionsMilli,
      waveSize: REQUIRED_WAVE_SIZE,
      waveCount: waves.length,
      waves,
      paidSearchActivation: "BLOCKED_PENDING_MEASUREMENT_IMPLEMENTATION_AND_SEPARATE_AUTHORIZATION",
      protectedThirdPartyResources: "BLOCKED_UNTIL_EXPLICIT_USER_AUTHORIZATION",
      productionExecutionStatus: "NOT_AUTHORIZED",
    },
    targetSupportVerdict: "EXECUTION_SEQUENCE_READY_MEASUREMENT_AND_OBSERVED_COHORTS_STILL_REQUIRED",
    warnings: [
      "WAVE_CAPACITY_IS_MODELED_NOT_OBSERVED_TRAFFIC",
      "PAGE_PRIORITY_IS_IMPLEMENTATION_ORDER_NOT_RANK_FORECAST",
      "PRODUCTION_INSTRUMENTATION_NOT_INSTALLED",
      "PAID_SEARCH_NOT_AUTHORIZED",
      "LIC_CANO_ADS_DATA_VERCEL_AND_TENANT_RESOURCES_PROTECTED",
      "PROBABILITY_OF_15_PLUS_CLIENTS_REMAINS_UNIDENTIFIABLE",
      "NO_LEAD_CLIENT_OR_REVENUE_GUARANTEE",
    ],
    decisionBoundary: "PLAN_ONLY_NO_AUTONOMOUS_SITE_CMS_ADS_DNS_VERCEL_OR_TENANT_MUTATION",
  };
  return { ...reportWithoutHash, reportSha256: sha256(reportWithoutHash) };
}
