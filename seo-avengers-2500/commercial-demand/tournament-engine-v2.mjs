import { createHash } from "node:crypto";

const SCHEMA_VERSION = 2;
const PPM = 1_000_000;
const MILLIS = 1_000;
const PPM_BIG = 1_000_000n;
const RATE_DENOMINATOR = PPM_BIG * PPM_BIG * PPM_BIG;
const INTENTS = Object.freeze(["DIRECT", "DECISION", "MIXED", "INFORMATIONAL"]);
const INTENT_SET = new Set(INTENTS);
const STRICT_INTENTS = new Set(["DIRECT", "DECISION"]);
const RELEVANT_INTENTS = new Set(["DIRECT", "DECISION", "MIXED"]);
const WARNINGS = Object.freeze([
  "NO_RANK_GUARANTEE",
  "NO_TRAFFIC_GUARANTEE",
  "NO_LEAD_OR_CLIENT_GUARANTEE",
  "SEARCH_VOLUME_IS_RESEARCH_NOT_UNIQUE_PEOPLE",
  "SEMANTIC_VARIANTS_ARE_NOT_SUMMED",
  "MIXED_INTENT_IS_MODELED_CAPACITY_NOT_PROVEN_COMMERCIAL_TRAFFIC",
  "GOOGLE_ADS_COMPETITION_INDEX_IS_NOT_ORGANIC_RANK_DIFFICULTY",
  "NO_AUTONOMOUS_PRODUCTION_ACTION",
]);

function compareStrings(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function canonicalJson(value) {
  if (value === null || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "string") return JSON.stringify(value.normalize("NFC"));
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) throw new TypeError("all numeric tournament inputs must be safe integers");
    return String(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value)
      .map(([key, item]) => [key.normalize("NFC"), item])
      .sort(([left], [right]) => compareStrings(left, right));
    const seen = new Set();
    return `{${entries.map(([key, item]) => {
      if (seen.has(key)) throw new Error("normalized key collision");
      seen.add(key);
      return `${JSON.stringify(key)}:${canonicalJson(item)}`;
    }).join(",")}}`;
  }
  throw new TypeError("tournament values must be JSON-compatible");
}

function sha256Canonical(value) {
  return `sha256:${createHash("sha256").update(Buffer.from(canonicalJson(value), "utf8")).digest("hex")}`;
}

function object(value, name) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError(`${name} must be object`);
  return value;
}

function array(value, name, { allowEmpty = false } = {}) {
  if (!Array.isArray(value)) throw new TypeError(`${name} must be array`);
  if (!allowEmpty && value.length === 0) throw new Error(`${name} must not be empty`);
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

function ppm(value, name) {
  return integer(value, name, 0, PPM);
}

function exactKeys(value, expected, name) {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw new Error(`${name} has unexpected keys`);
  }
}

function unique(values, name) {
  const seen = new Set();
  for (const value of values) {
    if (seen.has(value)) throw new Error(`duplicate ${name}: ${value}`);
    seen.add(value);
  }
}

function bigintToSafeNumber(value, name) {
  if (value < 0n || value > BigInt(Number.MAX_SAFE_INTEGER)) throw new RangeError(`${name} exceeds safe integer range`);
  return Number(value);
}

function ceilDiv(numerator, denominator) {
  if (denominator <= 0n) throw new RangeError("denominator must be positive");
  return (numerator + denominator - 1n) / denominator;
}

function validateObservedSearch(raw) {
  const value = object(raw, "observedSearch");
  exactKeys(value, ["evidenceClass", "provider", "account", "window", "capturedAt", "aggregate", "note"], "observedSearch");
  if (text(value.evidenceClass, "observedSearch.evidenceClass") !== "FIRST_PARTY_OBSERVED_CARRIED_FORWARD_FROM_V1") {
    throw new Error("observedSearch evidence class must remain carried-forward first-party evidence");
  }
  for (const key of ["provider", "account", "window", "capturedAt", "note"]) text(value[key], `observedSearch.${key}`);
  const aggregate = object(value.aggregate, "observedSearch.aggregate");
  exactKeys(aggregate, ["clicks", "impressions", "ctrPpm", "averagePositionMilli"], "observedSearch.aggregate");
  integer(aggregate.clicks, "observedSearch.aggregate.clicks");
  integer(aggregate.impressions, "observedSearch.aggregate.impressions");
  ppm(aggregate.ctrPpm, "observedSearch.aggregate.ctrPpm");
  integer(aggregate.averagePositionMilli, "observedSearch.aggregate.averagePositionMilli", 1);
  if (aggregate.clicks > aggregate.impressions) throw new Error("observedSearch clicks exceed impressions");
  return structuredClone(value);
}

function validateKeywordResearch(raw) {
  const value = object(raw, "keywordResearch");
  exactKeys(
    value,
    ["evidenceClass", "snapshots", "rawCandidateRowCount", "deduplicationMethod", "families", "deduplicationExamples", "excludedExamples", "note"],
    "keywordResearch",
  );
  if (text(value.evidenceClass, "keywordResearch.evidenceClass") !== "RESEARCH_ESTIMATE_NOT_FIRST_PARTY_OUTCOME") {
    throw new Error("keywordResearch must remain research-estimate evidence");
  }
  if (
    text(value.deduplicationMethod, "keywordResearch.deduplicationMethod")
    !== "ONE_CONSERVATIVE_REPRESENTATIVE_VOLUME_PER_SEMANTIC_DEMAND_FAMILY_VARIANTS_ARE_NOT_SUMMED"
  ) {
    throw new Error("keywordResearch deduplication method must remain conservative family-level deduplication");
  }
  text(value.note, "keywordResearch.note");
  const rawCandidateRowCount = integer(value.rawCandidateRowCount, "keywordResearch.rawCandidateRowCount", 1);

  const snapshots = array(value.snapshots, "keywordResearch.snapshots").map((rawSnapshot, index) => {
    const snapshot = object(rawSnapshot, `keywordResearch.snapshots[${index}]`);
    exactKeys(snapshot, ["id", "provider", "capturedAt", "resultId", "location", "language"], `keywordResearch.snapshots[${index}]`);
    const normalized = {};
    for (const key of ["id", "provider", "capturedAt", "resultId", "location", "language"]) {
      normalized[key] = text(snapshot[key], `keywordResearch.snapshots[${index}].${key}`);
    }
    return normalized;
  });
  unique(snapshots.map((row) => row.id), "research snapshot id");
  const snapshotIds = new Set(snapshots.map((row) => row.id));

  const families = array(value.families, "keywordResearch.families").map((rawFamily, index) => {
    const family = object(rawFamily, `keywordResearch.families[${index}]`);
    exactKeys(
      family,
      ["id", "cluster", "intentClass", "representativeKeyword", "monthlySearchVolume", "competitionIndex", "sourceSnapshotId"],
      `keywordResearch.families[${index}]`,
    );
    const id = text(family.id, `keywordResearch.families[${index}].id`);
    const cluster = text(family.cluster, `keywordResearch.families[${index}].cluster`);
    const intentClass = text(family.intentClass, `keywordResearch.families[${index}].intentClass`);
    if (!INTENT_SET.has(intentClass)) throw new Error(`unknown intentClass: ${intentClass}`);
    const representativeKeyword = text(family.representativeKeyword, `keywordResearch.families[${index}].representativeKeyword`).toLocaleLowerCase("es-MX");
    const monthlySearchVolume = integer(family.monthlySearchVolume, `keywordResearch.families[${index}].monthlySearchVolume`);
    const competitionIndex = integer(family.competitionIndex, `keywordResearch.families[${index}].competitionIndex`, 0, 100);
    const sourceSnapshotId = text(family.sourceSnapshotId, `keywordResearch.families[${index}].sourceSnapshotId`);
    if (!snapshotIds.has(sourceSnapshotId)) throw new Error(`unknown research snapshot id: ${sourceSnapshotId}`);
    return { id, cluster, intentClass, representativeKeyword, monthlySearchVolume, competitionIndex, sourceSnapshotId };
  });
  unique(families.map((row) => row.id), "demand family id");
  unique(families.map((row) => row.representativeKeyword), "representative keyword");
  const familyIds = new Set(families.map((row) => row.id));

  const deduplicationExamples = array(value.deduplicationExamples, "keywordResearch.deduplicationExamples").map((rawExample, index) => {
    const example = object(rawExample, `keywordResearch.deduplicationExamples[${index}]`);
    exactKeys(example, ["familyId", "absorbedVariantExamples"], `keywordResearch.deduplicationExamples[${index}]`);
    const familyId = text(example.familyId, `keywordResearch.deduplicationExamples[${index}].familyId`);
    if (!familyIds.has(familyId)) throw new Error(`deduplication example references unknown family: ${familyId}`);
    const absorbedVariantExamples = array(example.absorbedVariantExamples, `keywordResearch.deduplicationExamples[${index}].absorbedVariantExamples`)
      .map((variant) => text(variant, "absorbedVariantExample").toLocaleLowerCase("es-MX"));
    unique(absorbedVariantExamples, `dedup variants for ${familyId}`);
    return { familyId, absorbedVariantExamples };
  });
  unique(deduplicationExamples.map((row) => row.familyId), "deduplication example family");

  const excludedExamples = array(value.excludedExamples, "keywordResearch.excludedExamples").map((rawExample, index) => {
    const example = object(rawExample, `keywordResearch.excludedExamples[${index}]`);
    exactKeys(example, ["keyword", "reason"], `keywordResearch.excludedExamples[${index}]`);
    return {
      keyword: text(example.keyword, `keywordResearch.excludedExamples[${index}].keyword`).toLocaleLowerCase("es-MX"),
      reason: text(example.reason, `keywordResearch.excludedExamples[${index}].reason`),
    };
  });
  unique(excludedExamples.map((row) => row.keyword), "excluded keyword example");

  return { snapshots, rawCandidateRowCount, families, deduplicationExamples, excludedExamples };
}

function validateTrafficAssumptions(raw) {
  const value = object(raw, "trafficAssumptions");
  exactKeys(value, ["evidenceClass", "clickToSessionPpm", "targetCtrPpmByIntent", "interpretation"], "trafficAssumptions");
  if (text(value.evidenceClass, "trafficAssumptions.evidenceClass") !== "EXPLICIT_PLANNING_ASSUMPTION") {
    throw new Error("traffic assumptions must remain explicit planning assumptions");
  }
  const clickToSessionPpm = ppm(value.clickToSessionPpm, "trafficAssumptions.clickToSessionPpm");
  const ctrRaw = object(value.targetCtrPpmByIntent, "trafficAssumptions.targetCtrPpmByIntent");
  exactKeys(ctrRaw, INTENTS, "trafficAssumptions.targetCtrPpmByIntent");
  const targetCtrPpmByIntent = {};
  for (const intent of INTENTS) targetCtrPpmByIntent[intent] = ppm(ctrRaw[intent], `targetCtrPpmByIntent.${intent}`);
  text(value.interpretation, "trafficAssumptions.interpretation");
  return { clickToSessionPpm, targetCtrPpmByIntent, evidenceClass: value.evidenceClass, interpretation: value.interpretation };
}

function validateFunnels(raw, floorClientsMilli) {
  const funnels = array(raw, "funnels").map((rawFunnel, index) => {
    const funnel = object(rawFunnel, `funnels[${index}]`);
    exactKeys(funnel, ["id", "leadConversionPpm", "qualifiedLeadPpm", "closeRatePpm"], `funnels[${index}]`);
    const id = text(funnel.id, `funnels[${index}].id`);
    const leadConversionPpm = ppm(funnel.leadConversionPpm, `funnels[${index}].leadConversionPpm`);
    const qualifiedLeadPpm = ppm(funnel.qualifiedLeadPpm, `funnels[${index}].qualifiedLeadPpm`);
    const closeRatePpm = ppm(funnel.closeRatePpm, `funnels[${index}].closeRatePpm`);
    if (leadConversionPpm === 0 || qualifiedLeadPpm === 0 || closeRatePpm === 0) throw new Error(`funnel ${id} cannot contain zero rates`);
    const rateProduct = BigInt(leadConversionPpm) * BigInt(qualifiedLeadPpm) * BigInt(closeRatePpm);
    const requiredSessionsMilli = bigintToSafeNumber(
      ceilDiv(BigInt(floorClientsMilli) * RATE_DENOMINATOR, rateProduct),
      `funnels[${index}].requiredSessionsMilli`,
    );
    return {
      id,
      leadConversionPpm,
      qualifiedLeadPpm,
      closeRatePpm,
      requiredSessionsMilli,
      requiredSessions: Math.ceil(requiredSessionsMilli / MILLIS),
    };
  });
  unique(funnels.map((row) => row.id), "funnel id");
  return funnels;
}

function validatePages(raw, familyIds) {
  const pages = array(raw, "pages").map((rawPage, index) => {
    const page = object(rawPage, `pages[${index}]`);
    exactKeys(page, ["id", "title", "demandFamilyIds"], `pages[${index}]`);
    const id = text(page.id, `pages[${index}].id`);
    const title = text(page.title, `pages[${index}].title`);
    const demandFamilyIds = array(page.demandFamilyIds, `pages[${index}].demandFamilyIds`)
      .map((familyId) => text(familyId, `pages[${index}].demandFamilyIds item`));
    unique(demandFamilyIds, `page ${id} demand family`);
    for (const familyId of demandFamilyIds) if (!familyIds.has(familyId)) throw new Error(`page ${id} references unknown demand family: ${familyId}`);
    return { id, title, demandFamilyIds };
  });
  unique(pages.map((row) => row.id), "page id");
  return pages;
}

function validateStrategies(raw, pageIds) {
  const strategies = array(raw, "strategies").map((rawStrategy, index) => {
    const strategy = object(rawStrategy, `strategies[${index}]`);
    exactKeys(strategy, ["id", "pageIds", "disqualifiers", "architecture"], `strategies[${index}]`);
    const id = text(strategy.id, `strategies[${index}].id`);
    const selectedPageIds = array(strategy.pageIds, `strategies[${index}].pageIds`).map((pageId) => text(pageId, `strategies[${index}].pageIds item`));
    unique(selectedPageIds, `strategy ${id} page`);
    for (const pageId of selectedPageIds) if (!pageIds.has(pageId)) throw new Error(`strategy ${id} references unknown page: ${pageId}`);
    const disqualifiers = array(strategy.disqualifiers, `strategies[${index}].disqualifiers`, { allowEmpty: true })
      .map((item) => text(item, `strategies[${index}].disqualifier`));
    unique(disqualifiers, `strategy ${id} disqualifier`);
    const architecture = text(strategy.architecture, `strategies[${index}].architecture`);
    return { id, pageIds: selectedPageIds, disqualifiers, architecture };
  });
  unique(strategies.map((row) => row.id), "strategy id");
  return strategies;
}

function validateScenario(raw) {
  const source = object(raw, "scenario");
  exactKeys(
    source,
    ["schemaVersion", "scenarioId", "siteId", "market", "objective", "observedSearch", "keywordResearch", "trafficAssumptions", "funnels", "pages", "strategies", "decisionBoundary"],
    "scenario",
  );
  if (source.schemaVersion !== SCHEMA_VERSION) throw new Error("unsupported scenario schemaVersion");
  const scenarioId = text(source.scenarioId, "scenarioId");
  const siteId = text(source.siteId, "siteId");
  const market = object(source.market, "market");
  exactKeys(market, ["country", "language"], "market");
  text(market.country, "market.country");
  text(market.language, "market.language");

  const objective = object(source.objective, "objective");
  exactKeys(objective, ["minimumPlanningFloorClientsMilli", "interpretation", "optimizationGoal"], "objective");
  const minimumPlanningFloorClientsMilli = integer(objective.minimumPlanningFloorClientsMilli, "objective.minimumPlanningFloorClientsMilli", 1);
  if (text(objective.interpretation, "objective.interpretation") !== "MINIMUM_PLANNING_FLOOR_NOT_FORECAST_OR_GUARANTEE") {
    throw new Error("objective interpretation must remain a minimum planning floor, not a forecast");
  }
  if (
    text(objective.optimizationGoal, "objective.optimizationGoal")
    !== "MAXIMIZE_WORST_CASE_MODELED_CLIENT_CAPACITY_THEN_STRICT_COMMERCIAL_DEMAND_THEN_RELEVANT_DEMAND_THEN_FAMILY_COVERAGE_THEN_FEWER_PAGES"
  ) {
    throw new Error("unexpected optimizationGoal");
  }

  const observedSearch = validateObservedSearch(source.observedSearch);
  const keywordResearch = validateKeywordResearch(source.keywordResearch);
  const trafficAssumptions = validateTrafficAssumptions(source.trafficAssumptions);
  const familyIds = new Set(keywordResearch.families.map((row) => row.id));
  const funnels = validateFunnels(source.funnels, minimumPlanningFloorClientsMilli);
  const pages = validatePages(source.pages, familyIds);
  const pageIds = new Set(pages.map((row) => row.id));
  const strategies = validateStrategies(source.strategies, pageIds);
  const decisionBoundary = text(source.decisionBoundary, "decisionBoundary");
  if (decisionBoundary !== "PLAN_ONLY_NO_AUTONOMOUS_SITE_CMS_ADS_DNS_VERCEL_OR_TENANT_MUTATION") {
    throw new Error("decision boundary cannot authorize production mutation");
  }
  return {
    scenarioId,
    siteId,
    market: structuredClone(market),
    objective: structuredClone(objective),
    observedSearch,
    keywordResearch,
    trafficAssumptions,
    funnels,
    pages,
    strategies,
    decisionBoundary,
  };
}

function modeledSessionsMilli(volume, ctrPpm, clickToSessionPpm) {
  const numerator = BigInt(volume) * BigInt(ctrPpm) * BigInt(clickToSessionPpm) * BigInt(MILLIS);
  return bigintToSafeNumber(numerator / (PPM_BIG * PPM_BIG), "modeledSessionsMilli");
}

function summarizeFamilies(families, assumptions) {
  const byIntent = Object.fromEntries(INTENTS.map((intent) => [intent, { familyCount: 0, rawSearchVolume: 0, modeledSessionsMilli: 0 }]));
  for (const family of families) {
    const target = byIntent[family.intentClass];
    target.familyCount += 1;
    target.rawSearchVolume += family.monthlySearchVolume;
    target.modeledSessionsMilli += modeledSessionsMilli(
      family.monthlySearchVolume,
      assumptions.targetCtrPpmByIntent[family.intentClass],
      assumptions.clickToSessionPpm,
    );
  }
  return byIntent;
}

function modeledClientsMilli(sessionsMilli, funnel) {
  const rateProduct = BigInt(funnel.leadConversionPpm) * BigInt(funnel.qualifiedLeadPpm) * BigInt(funnel.closeRatePpm);
  return bigintToSafeNumber((BigInt(sessionsMilli) * rateProduct) / RATE_DENOMINATOR, `modeledClientsMilli.${funnel.id}`);
}

function evaluateStrategy(strategy, pagesById, familiesById, assumptions, funnels, floorClientsMilli) {
  const selectedFamilies = new Set();
  for (const pageId of strategy.pageIds) {
    for (const familyId of pagesById.get(pageId).demandFamilyIds) selectedFamilies.add(familyId);
  }
  const familyRows = [...selectedFamilies].map((familyId) => familiesById.get(familyId));
  const byIntent = summarizeFamilies(familyRows, assumptions);
  const strictCommercialSessionsMilli = [...STRICT_INTENTS].reduce((sum, intent) => sum + byIntent[intent].modeledSessionsMilli, 0);
  const relevantSessionsMilli = [...RELEVANT_INTENTS].reduce((sum, intent) => sum + byIntent[intent].modeledSessionsMilli, 0);
  const informationalSessionsMilli = byIntent.INFORMATIONAL.modeledSessionsMilli;
  const stressScenarios = funnels.map((funnel) => {
    const clientsMilli = modeledClientsMilli(relevantSessionsMilli, funnel);
    return {
      funnelId: funnel.id,
      requiredSessions: funnel.requiredSessions,
      modeledClientsMilli: clientsMilli,
      floorGapClientsMilli: Math.max(0, floorClientsMilli - clientsMilli),
      supportsMinimumPlanningFloor: clientsMilli >= floorClientsMilli,
    };
  });
  const worstCaseModeledClientsMilli = Math.min(...stressScenarios.map((row) => row.modeledClientsMilli));
  return {
    id: strategy.id,
    eligible: strategy.disqualifiers.length === 0,
    disqualifiers: [...strategy.disqualifiers],
    architecture: strategy.architecture,
    pageCount: strategy.pageIds.length,
    pageIds: [...strategy.pageIds],
    coveredDemandFamilyIds: [...selectedFamilies].sort(compareStrings),
    coveredDemandFamilyCount: selectedFamilies.size,
    modeledSessionsByIntent: byIntent,
    strictCommercialSessionsMilli,
    relevantSessionsMilli,
    informationalSessionsMilli,
    stressScenarios,
    worstCaseModeledClientsMilli,
    supportsMinimumPlanningFloorAcrossStressScenarios: stressScenarios.every((row) => row.supportsMinimumPlanningFloor),
  };
}

function strategyTieBreak(left, right) {
  return (
    right.worstCaseModeledClientsMilli - left.worstCaseModeledClientsMilli
    || right.strictCommercialSessionsMilli - left.strictCommercialSessionsMilli
    || right.relevantSessionsMilli - left.relevantSessionsMilli
    || right.coveredDemandFamilyCount - left.coveredDemandFamilyCount
    || left.pageCount - right.pageCount
    || compareStrings(left.id, right.id)
  );
}

function buildResearchCeiling(families, assumptions, funnels, floorClientsMilli) {
  const relevantFamilies = families.filter((family) => RELEVANT_INTENTS.has(family.intentClass));
  const rawRelevantSearchVolume = relevantFamilies.reduce((sum, row) => sum + row.monthlySearchVolume, 0);
  const maxClickCaptureSessionsMilli = modeledSessionsMilli(rawRelevantSearchVolume, PPM, assumptions.clickToSessionPpm);
  const stressScenarios = funnels.map((funnel) => {
    const clientsMilli = modeledClientsMilli(maxClickCaptureSessionsMilli, funnel);
    return {
      funnelId: funnel.id,
      modeledClientsMilliAt100PercentSearchClickCapture: clientsMilli,
      supportsMinimumPlanningFloorAt100PercentSearchClickCapture: clientsMilli >= floorClientsMilli,
    };
  });
  return {
    boundary: "MATHEMATICAL_100_PERCENT_CLICK_CAPTURE_UPPER_BOUND_NOT_ACHIEVABLE_FORECAST_OR_EXPECTATION",
    rawRelevantSearchVolume,
    maxClickCaptureSessionsMilli,
    stressScenarios,
  };
}

export function runCommercialDemandTournamentV2(rawScenario) {
  const source = structuredClone(rawScenario);
  const scenarioSha256 = sha256Canonical(source);
  const scenario = validateScenario(source);
  const researchByIntent = summarizeFamilies(scenario.keywordResearch.families, scenario.trafficAssumptions);
  const pagesById = new Map(scenario.pages.map((row) => [row.id, row]));
  const familiesById = new Map(scenario.keywordResearch.families.map((row) => [row.id, row]));
  const evaluatedStrategies = scenario.strategies.map((strategy) => evaluateStrategy(
    strategy,
    pagesById,
    familiesById,
    scenario.trafficAssumptions,
    scenario.funnels,
    scenario.objective.minimumPlanningFloorClientsMilli,
  ));
  const eligible = evaluatedStrategies.filter((row) => row.eligible).sort(strategyTieBreak);
  if (eligible.length === 0) throw new Error("no eligible tournament strategy");
  const winner = eligible[0];
  const targetSupportVerdict = winner.supportsMinimumPlanningFloorAcrossStressScenarios
    ? "WINNER_SUPPORTS_MINIMUM_PLANNING_FLOOR_ACROSS_STRESS_SCENARIOS"
    : "EXPAND_VALIDATED_DEMAND_AND_OR_CHANNELS_BEFORE_FLOOR_CLAIM";
  const researchCeiling = buildResearchCeiling(
    scenario.keywordResearch.families,
    scenario.trafficAssumptions,
    scenario.funnels,
    scenario.objective.minimumPlanningFloorClientsMilli,
  );

  const unsigned = {
    schemaVersion: SCHEMA_VERSION,
    engineId: "WALLE_NEXUS_COMMERCIAL_DEMAND_TOURNAMENT_V2",
    status: "TOURNAMENT_COMPLETE",
    interpretation: "DETERMINISTIC_PLANNING_EXPERIMENT_NOT_RANK_TRAFFIC_LEAD_CLIENT_OR_REVENUE_FORECAST",
    scenarioId: scenario.scenarioId,
    siteId: scenario.siteId,
    scenarioSha256,
    market: scenario.market,
    objective: scenario.objective,
    evidenceBoundary: {
      observedSearch: scenario.observedSearch.evidenceClass,
      keywordResearch: "RESEARCH_ESTIMATE_NOT_FIRST_PARTY_OUTCOME",
      trafficAndFunnel: "EXPLICIT_PLANNING_ASSUMPTIONS",
      productionMutationAuthorized: false,
    },
    observedBaseline: scenario.observedSearch,
    research: {
      snapshots: scenario.keywordResearch.snapshots,
      deduplicationMethod: source.keywordResearch.deduplicationMethod,
      rawCandidateRowCount: scenario.keywordResearch.rawCandidateRowCount,
      semanticDemandFamilyCount: scenario.keywordResearch.families.length,
      byIntent: researchByIntent,
      deduplicationExamples: scenario.keywordResearch.deduplicationExamples,
      excludedExamples: scenario.keywordResearch.excludedExamples,
      ceiling: researchCeiling,
    },
    assumptions: scenario.trafficAssumptions,
    funnels: scenario.funnels,
    architecture: {
      catalogPageCount: scenario.pages.length,
      pages: scenario.pages,
      invariant: "STRATEGY_PAGE_COUNT_IS_DERIVED_FROM_EXPLICIT_PAGE_IDS_NEVER_DECLARED_SEPARATELY",
    },
    tournament: {
      evaluatedStrategies,
      eligibleLeaderboardStrategyIds: eligible.map((row) => row.id),
      selectedStrategyId: winner.id,
      selectedStrategy: winner,
      selectionPolicy: scenario.objective.optimizationGoal,
    },
    targetAssessment: {
      targetSupportVerdict,
      minimumPlanningFloorClientsMilli: scenario.objective.minimumPlanningFloorClientsMilli,
      winnerWorstCaseModeledClientsMilli: winner.worstCaseModeledClientsMilli,
      boundary: "MODELED_CLIENT_COUNTS_USE_RESEARCH_ESTIMATES_PLUS_EXPLICIT_CTR_AND_FUNNEL_ASSUMPTIONS_AND_ARE_NOT_FORECASTS",
    },
    warnings: [...WARNINGS],
    decisionBoundary: scenario.decisionBoundary,
  };
  return Object.freeze({ ...unsigned, reportSha256: sha256Canonical(unsigned) });
}

export const __test = Object.freeze({
  canonicalJson,
  sha256Canonical,
  validateScenario,
  modeledSessionsMilli,
  modeledClientsMilli,
  strategyTieBreak,
});
