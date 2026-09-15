import { createHash } from "node:crypto";

const SCHEMA_VERSION = 1;
const PPM = 1_000_000;
const MILLIS = 1_000;
const PPM_BIG = 1_000_000n;
const FUNNEL_DENOMINATOR = PPM_BIG * PPM_BIG * PPM_BIG;
const INTENTS = Object.freeze(["DIRECT", "DECISION", "MIXED", "INFORMATIONAL"]);
const INTENT_SET = new Set(INTENTS);
const STRICT_COMMERCIAL_INTENTS = new Set(["DIRECT", "DECISION"]);
const RELEVANT_INTENTS = new Set(["DIRECT", "DECISION", "MIXED"]);
const WARNINGS = Object.freeze([
  "NO_RANK_GUARANTEE",
  "NO_TRAFFIC_GUARANTEE",
  "NO_LEAD_OR_CLIENT_GUARANTEE",
  "SEARCH_VOLUME_IS_RESEARCH_NOT_UNIQUE_PEOPLE",
  "GOOGLE_ADS_COMPETITION_INDEX_IS_NOT_ORGANIC_RANK_DIFFICULTY",
  "MIXED_INTENT_DEMAND_IS_NOT_COUNTED_AS_PROVEN_COMMERCIAL_DEMAND",
  "NO_AUTONOMOUS_SITE_ACTION",
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

function ceilDiv(numerator, denominator) {
  if (denominator <= 0n) throw new RangeError("ceilDiv denominator must be positive");
  return (numerator + denominator - 1n) / denominator;
}

function bigintToSafeNumber(value, name) {
  if (value < 0n || value > BigInt(Number.MAX_SAFE_INTEGER)) throw new RangeError(`${name} exceeds safe integer range`);
  return Number(value);
}

function validateObservedSearch(raw) {
  const value = object(raw, "observedSearch");
  exactKeys(value, ["evidenceClass", "provider", "account", "window", "capturedAt", "aggregate", "queryRows", "note"], "observedSearch");
  if (text(value.evidenceClass, "observedSearch.evidenceClass") !== "FIRST_PARTY_OBSERVED") {
    throw new Error("observedSearch must be FIRST_PARTY_OBSERVED");
  }
  text(value.provider, "observedSearch.provider");
  text(value.account, "observedSearch.account");
  text(value.window, "observedSearch.window");
  text(value.capturedAt, "observedSearch.capturedAt");
  text(value.note, "observedSearch.note");
  const aggregate = object(value.aggregate, "observedSearch.aggregate");
  exactKeys(aggregate, ["clicks", "impressions", "ctrPpm", "averagePositionMilli"], "observedSearch.aggregate");
  integer(aggregate.clicks, "observedSearch.aggregate.clicks");
  integer(aggregate.impressions, "observedSearch.aggregate.impressions");
  ppm(aggregate.ctrPpm, "observedSearch.aggregate.ctrPpm");
  integer(aggregate.averagePositionMilli, "observedSearch.aggregate.averagePositionMilli", 1, 1_000_000);
  if (aggregate.clicks > aggregate.impressions) throw new Error("observedSearch aggregate clicks exceed impressions");
  const queryRows = array(value.queryRows, "observedSearch.queryRows");
  const identities = [];
  for (const [index, rowRaw] of queryRows.entries()) {
    const row = object(rowRaw, `observedSearch.queryRows[${index}]`);
    exactKeys(row, ["query", "pageUrl", "clicks", "impressions", "averagePositionMilli"], `observedSearch.queryRows[${index}]`);
    const query = text(row.query, `observedSearch.queryRows[${index}].query`);
    const pageUrl = text(row.pageUrl, `observedSearch.queryRows[${index}].pageUrl`);
    integer(row.clicks, `observedSearch.queryRows[${index}].clicks`);
    integer(row.impressions, `observedSearch.queryRows[${index}].impressions`);
    integer(row.averagePositionMilli, `observedSearch.queryRows[${index}].averagePositionMilli`, 1, 1_000_000);
    if (row.clicks > row.impressions) throw new Error(`observedSearch query clicks exceed impressions: ${query}`);
    identities.push(`${query}\u0000${pageUrl}`);
  }
  unique(identities, "observed query/page identity");
  return structuredClone(value);
}

function validateOpportunities(raw) {
  const research = object(raw, "keywordResearch");
  exactKeys(research, ["evidenceClass", "provider", "capturedAt", "location", "language", "opportunities", "deduplicationBoundary"], "keywordResearch");
  if (text(research.evidenceClass, "keywordResearch.evidenceClass") !== "RESEARCH_ESTIMATE_NOT_FIRST_PARTY_OUTCOME") {
    throw new Error("keywordResearch must remain research-estimate evidence");
  }
  text(research.provider, "keywordResearch.provider");
  text(research.capturedAt, "keywordResearch.capturedAt");
  text(research.location, "keywordResearch.location");
  text(research.language, "keywordResearch.language");
  text(research.deduplicationBoundary, "keywordResearch.deduplicationBoundary");
  const opportunities = array(research.opportunities, "keywordResearch.opportunities");
  const ids = [];
  const keywords = [];
  const normalized = opportunities.map((rowRaw, index) => {
    const row = object(rowRaw, `keywordResearch.opportunities[${index}]`);
    exactKeys(row, ["id", "keyword", "cluster", "intentClass", "monthlySearchVolume", "competitionIndex"], `keywordResearch.opportunities[${index}]`);
    const id = text(row.id, `keywordResearch.opportunities[${index}].id`);
    const keyword = text(row.keyword, `keywordResearch.opportunities[${index}].keyword`).toLocaleLowerCase("es-MX");
    const cluster = text(row.cluster, `keywordResearch.opportunities[${index}].cluster`);
    const intentClass = text(row.intentClass, `keywordResearch.opportunities[${index}].intentClass`);
    if (!INTENT_SET.has(intentClass)) throw new Error(`unknown intentClass: ${intentClass}`);
    const monthlySearchVolume = integer(row.monthlySearchVolume, `keywordResearch.opportunities[${index}].monthlySearchVolume`);
    const competitionIndex = integer(row.competitionIndex, `keywordResearch.opportunities[${index}].competitionIndex`, 0, 100);
    ids.push(id);
    keywords.push(keyword);
    return { id, keyword, cluster, intentClass, monthlySearchVolume, competitionIndex };
  });
  unique(ids, "opportunity id");
  unique(keywords, "opportunity keyword");
  return normalized;
}

function validateTrafficAssumptions(raw) {
  const value = object(raw, "trafficAssumptions");
  exactKeys(value, ["evidenceClass", "clickToSessionPpm", "targetCtrPpmByIntent", "interpretation"], "trafficAssumptions");
  if (text(value.evidenceClass, "trafficAssumptions.evidenceClass") !== "EXPLICIT_PLANNING_ASSUMPTION") {
    throw new Error("trafficAssumptions must remain explicit assumptions");
  }
  const clickToSessionPpm = ppm(value.clickToSessionPpm, "trafficAssumptions.clickToSessionPpm");
  const ctrRaw = object(value.targetCtrPpmByIntent, "trafficAssumptions.targetCtrPpmByIntent");
  exactKeys(ctrRaw, INTENTS, "trafficAssumptions.targetCtrPpmByIntent");
  const targetCtrPpmByIntent = {};
  for (const intent of INTENTS) targetCtrPpmByIntent[intent] = ppm(ctrRaw[intent], `targetCtrPpmByIntent.${intent}`);
  text(value.interpretation, "trafficAssumptions.interpretation");
  return { clickToSessionPpm, targetCtrPpmByIntent, evidenceClass: value.evidenceClass, interpretation: value.interpretation };
}

function validateFunnels(raw, targetClientsMilli) {
  const funnels = array(raw, "funnels");
  const ids = [];
  const normalized = funnels.map((rowRaw, index) => {
    const row = object(rowRaw, `funnels[${index}]`);
    exactKeys(row, ["id", "plannedSessions", "leadConversionPpm", "qualifiedLeadPpm", "closeRatePpm"], `funnels[${index}]`);
    const id = text(row.id, `funnels[${index}].id`);
    ids.push(id);
    const plannedSessions = integer(row.plannedSessions, `funnels[${index}].plannedSessions`, 1);
    const leadConversionPpm = ppm(row.leadConversionPpm, `funnels[${index}].leadConversionPpm`);
    const qualifiedLeadPpm = ppm(row.qualifiedLeadPpm, `funnels[${index}].qualifiedLeadPpm`);
    const closeRatePpm = ppm(row.closeRatePpm, `funnels[${index}].closeRatePpm`);
    if (leadConversionPpm === 0 || qualifiedLeadPpm === 0 || closeRatePpm === 0) throw new Error(`funnel ${id} cannot have zero conversion rate`);
    const rateProduct = BigInt(leadConversionPpm) * BigInt(qualifiedLeadPpm) * BigInt(closeRatePpm);
    const requiredSessions = bigintToSafeNumber(
      ceilDiv(BigInt(targetClientsMilli) * FUNNEL_DENOMINATOR, rateProduct * BigInt(MILLIS)),
      `funnels[${index}].requiredSessions`,
    );
    const modeledClientsMilli = bigintToSafeNumber(
      (BigInt(plannedSessions) * rateProduct * BigInt(MILLIS)) / FUNNEL_DENOMINATOR,
      `funnels[${index}].modeledClientsMilli`,
    );
    return {
      id,
      plannedSessions,
      leadConversionPpm,
      qualifiedLeadPpm,
      closeRatePpm,
      requiredSessions,
      plannedSessionsMeetTargetMath: plannedSessions >= requiredSessions,
      modeledClientsMilli,
    };
  });
  unique(ids, "funnel id");
  return normalized;
}

function validateStrategies(raw, knownClusters) {
  const strategies = array(raw, "strategies");
  const ids = [];
  const normalized = strategies.map((rowRaw, index) => {
    const row = object(rowRaw, `strategies[${index}]`);
    const allowed = new Set(["id", "pageCount", "includeIntentClasses", "includeClusters", "disqualifiers", "architecture"]);
    for (const key of Object.keys(row)) if (!allowed.has(key)) throw new Error(`strategies[${index}] has unexpected key: ${key}`);
    for (const key of ["id", "pageCount", "includeIntentClasses", "includeClusters", "disqualifiers"]) {
      if (!(key in row)) throw new Error(`strategies[${index}] missing key: ${key}`);
    }
    const id = text(row.id, `strategies[${index}].id`);
    ids.push(id);
    const pageCount = integer(row.pageCount, `strategies[${index}].pageCount`, 1, 10_000);
    const includeIntentClasses = array(row.includeIntentClasses, `strategies[${index}].includeIntentClasses`).map((value) => {
      const intent = text(value, `strategies[${index}].includeIntentClasses item`);
      if (!INTENT_SET.has(intent)) throw new Error(`strategy ${id} references unknown intent: ${intent}`);
      return intent;
    });
    unique(includeIntentClasses, `strategy ${id} intent`);
    const includeClusters = array(row.includeClusters, `strategies[${index}].includeClusters`).map((value) => {
      const cluster = text(value, `strategies[${index}].includeClusters item`);
      if (!knownClusters.has(cluster)) throw new Error(`strategy ${id} references unknown cluster: ${cluster}`);
      return cluster;
    });
    unique(includeClusters, `strategy ${id} cluster`);
    const disqualifiers = array(row.disqualifiers, `strategies[${index}].disqualifiers`, { allowEmpty: true }).map((value) => text(value, `strategies[${index}].disqualifier`));
    unique(disqualifiers, `strategy ${id} disqualifier`);
    const architecture = row.architecture === undefined ? null : text(row.architecture, `strategies[${index}].architecture`);
    return { id, pageCount, includeIntentClasses, includeClusters, disqualifiers, architecture };
  });
  unique(ids, "strategy id");
  return normalized;
}

function validateScenario(raw) {
  const scenario = object(raw, "scenario");
  exactKeys(
    scenario,
    ["schemaVersion", "scenarioId", "siteId", "market", "objective", "observedSearch", "keywordResearch", "trafficAssumptions", "funnels", "strategies", "executionPlan"],
    "scenario",
  );
  if (scenario.schemaVersion !== SCHEMA_VERSION) throw new Error("unsupported scenario schemaVersion");
  const scenarioId = text(scenario.scenarioId, "scenarioId");
  const siteId = text(scenario.siteId, "siteId");
  const market = object(scenario.market, "market");
  exactKeys(market, ["country", "language"], "market");
  text(market.country, "market.country");
  text(market.language, "market.language");
  const objective = object(scenario.objective, "objective");
  exactKeys(objective, ["targetClientsMilli", "interpretation"], "objective");
  const targetClientsMilli = integer(objective.targetClientsMilli, "objective.targetClientsMilli", 1);
  if (text(objective.interpretation, "objective.interpretation") !== "PLANNING_TARGET_NOT_FORECAST_OR_GUARANTEE") {
    throw new Error("objective interpretation must remain a non-forecast planning target");
  }
  const observedSearch = validateObservedSearch(scenario.observedSearch);
  const opportunities = validateOpportunities(scenario.keywordResearch);
  const trafficAssumptions = validateTrafficAssumptions(scenario.trafficAssumptions);
  const knownClusters = new Set(opportunities.map((row) => row.cluster));
  const funnels = validateFunnels(scenario.funnels, targetClientsMilli);
  const strategies = validateStrategies(scenario.strategies, knownClusters);
  const executionPlan = object(scenario.executionPlan, "executionPlan");
  exactKeys(executionPlan, ["wave1", "wave2", "wave3Boundary"], "executionPlan");
  const wave1 = array(executionPlan.wave1, "executionPlan.wave1").map((value) => text(value, "executionPlan.wave1 item"));
  const wave2 = array(executionPlan.wave2, "executionPlan.wave2").map((value) => text(value, "executionPlan.wave2 item"));
  unique(wave1, "wave1 item");
  unique(wave2, "wave2 item");
  const wave3Boundary = text(executionPlan.wave3Boundary, "executionPlan.wave3Boundary");
  return {
    scenarioId,
    siteId,
    market: structuredClone(market),
    objective: structuredClone(objective),
    observedSearch,
    keywordResearchMeta: {
      evidenceClass: scenario.keywordResearch.evidenceClass,
      provider: scenario.keywordResearch.provider,
      capturedAt: scenario.keywordResearch.capturedAt,
      location: scenario.keywordResearch.location,
      language: scenario.keywordResearch.language,
      deduplicationBoundary: scenario.keywordResearch.deduplicationBoundary,
    },
    opportunities,
    trafficAssumptions,
    funnels,
    strategies,
    executionPlan: { wave1, wave2, wave3Boundary },
  };
}

function modeledSessionsMilli(volume, ctrPpm, clickToSessionPpm) {
  const numerator = BigInt(volume) * BigInt(ctrPpm) * BigInt(clickToSessionPpm) * BigInt(MILLIS);
  return bigintToSafeNumber(numerator / (PPM_BIG * PPM_BIG), "modeledSessionsMilli");
}

function summarizeResearch(opportunities, trafficAssumptions) {
  const rows = Object.fromEntries(INTENTS.map((intent) => [intent, { queryCount: 0, rawSearchVolume: 0, modeledSessionsMilli: 0 }]));
  for (const row of opportunities) {
    const target = rows[row.intentClass];
    target.queryCount += 1;
    target.rawSearchVolume += row.monthlySearchVolume;
    target.modeledSessionsMilli += modeledSessionsMilli(
      row.monthlySearchVolume,
      trafficAssumptions.targetCtrPpmByIntent[row.intentClass],
      trafficAssumptions.clickToSessionPpm,
    );
  }
  return rows;
}

function evaluateStrategy(strategy, opportunities, trafficAssumptions) {
  const intents = new Set(strategy.includeIntentClasses);
  const clusters = new Set(strategy.includeClusters);
  const selected = opportunities.filter((row) => intents.has(row.intentClass) && clusters.has(row.cluster));
  const byIntent = Object.fromEntries(INTENTS.map((intent) => [intent, { queryCount: 0, rawSearchVolume: 0, modeledSessionsMilli: 0 }]));
  for (const row of selected) {
    const target = byIntent[row.intentClass];
    target.queryCount += 1;
    target.rawSearchVolume += row.monthlySearchVolume;
    target.modeledSessionsMilli += modeledSessionsMilli(
      row.monthlySearchVolume,
      trafficAssumptions.targetCtrPpmByIntent[row.intentClass],
      trafficAssumptions.clickToSessionPpm,
    );
  }
  const strictCommercialSessionsMilli = [...STRICT_COMMERCIAL_INTENTS].reduce((sum, intent) => sum + byIntent[intent].modeledSessionsMilli, 0);
  const relevantSessionsMilli = [...RELEVANT_INTENTS].reduce((sum, intent) => sum + byIntent[intent].modeledSessionsMilli, 0);
  const informationalSessionsMilli = byIntent.INFORMATIONAL.modeledSessionsMilli;
  const clusterCount = new Set(selected.map((row) => row.cluster)).size;
  const totalModeledSessionsMilli = relevantSessionsMilli + informationalSessionsMilli;
  const informationalSharePpm = totalModeledSessionsMilli === 0
    ? 0
    : Math.floor((informationalSessionsMilli * PPM) / totalModeledSessionsMilli);
  return {
    id: strategy.id,
    eligible: strategy.disqualifiers.length === 0,
    disqualifiers: [...strategy.disqualifiers],
    pageCount: strategy.pageCount,
    architecture: strategy.architecture,
    selectedOpportunityCount: selected.length,
    clusterCount,
    rawSearchVolume: selected.reduce((sum, row) => sum + row.monthlySearchVolume, 0),
    modeledSessionsByIntent: byIntent,
    strictCommercialSessionsMilli,
    relevantSessionsMilli,
    informationalSessionsMilli,
    informationalSharePpm,
  };
}

function dominates(left, right) {
  const noWorse =
    left.strictCommercialSessionsMilli >= right.strictCommercialSessionsMilli &&
    left.relevantSessionsMilli >= right.relevantSessionsMilli &&
    left.clusterCount >= right.clusterCount &&
    left.pageCount <= right.pageCount &&
    left.informationalSharePpm <= right.informationalSharePpm;
  const strictlyBetter =
    left.strictCommercialSessionsMilli > right.strictCommercialSessionsMilli ||
    left.relevantSessionsMilli > right.relevantSessionsMilli ||
    left.clusterCount > right.clusterCount ||
    left.pageCount < right.pageCount ||
    left.informationalSharePpm < right.informationalSharePpm;
  return noWorse && strictlyBetter;
}

function paretoFrontier(rows) {
  return rows.filter((candidate) => !rows.some((other) => other.id !== candidate.id && dominates(other, candidate)));
}

function strategyTieBreak(left, right) {
  return (
    right.strictCommercialSessionsMilli - left.strictCommercialSessionsMilli ||
    right.relevantSessionsMilli - left.relevantSessionsMilli ||
    right.clusterCount - left.clusterCount ||
    left.pageCount - right.pageCount ||
    compareStrings(left.id, right.id)
  );
}

function buildGapReport(winner, funnels) {
  return funnels.map((funnel) => {
    const requiredSessionsMilli = funnel.requiredSessions * MILLIS;
    return {
      funnelId: funnel.id,
      requiredSessions: funnel.requiredSessions,
      plannedSessions: funnel.plannedSessions,
      modeledRelevantSessionsMilli: winner.relevantSessionsMilli,
      sessionGapMilli: Math.max(0, requiredSessionsMilli - winner.relevantSessionsMilli),
      targetSupportedByCurrentSeedScenario: winner.relevantSessionsMilli >= requiredSessionsMilli,
    };
  });
}

export function runCommercialDemandTournament(rawScenario) {
  const source = structuredClone(rawScenario);
  const scenarioHash = sha256Canonical(source);
  const scenario = validateScenario(source);
  const researchSummary = summarizeResearch(scenario.opportunities, scenario.trafficAssumptions);
  const evaluatedStrategies = scenario.strategies.map((strategy) => evaluateStrategy(strategy, scenario.opportunities, scenario.trafficAssumptions));
  const eligible = evaluatedStrategies.filter((row) => row.eligible);
  if (eligible.length === 0) throw new Error("no eligible tournament strategy");
  const frontier = paretoFrontier(eligible).sort(strategyTieBreak);
  const winner = frontier[0];
  const targetGaps = buildGapReport(winner, scenario.funnels);
  const targetSupportVerdict = targetGaps.every((row) => row.targetSupportedByCurrentSeedScenario)
    ? "CURRENT_SEED_SCENARIO_MATHEMATICALLY_SUPPORTS_ALL_SESSION_TARGETS"
    : "EXPAND_VALIDATED_DEMAND_BEFORE_CLAIM";

  const unsigned = {
    schemaVersion: SCHEMA_VERSION,
    engineId: "WALLE_NEXUS_COMMERCIAL_DEMAND_TOURNAMENT_V1",
    status: "TOURNAMENT_COMPLETE",
    interpretation: "DETERMINISTIC_PLANNING_EXPERIMENT_NOT_RANK_TRAFFIC_LEAD_CLIENT_OR_REVENUE_FORECAST",
    scenarioId: scenario.scenarioId,
    siteId: scenario.siteId,
    scenarioSha256: scenarioHash,
    market: scenario.market,
    objective: scenario.objective,
    evidenceBoundary: {
      observedSearch: "FIRST_PARTY_OBSERVED",
      keywordResearch: "RESEARCH_ESTIMATE_NOT_FIRST_PARTY_OUTCOME",
      trafficAndFunnel: "EXPLICIT_PLANNING_ASSUMPTIONS",
      productionMutationAuthorized: false,
    },
    observedBaseline: {
      provider: scenario.observedSearch.provider,
      account: scenario.observedSearch.account,
      window: scenario.observedSearch.window,
      capturedAt: scenario.observedSearch.capturedAt,
      aggregate: scenario.observedSearch.aggregate,
      observedQueryRowCount: scenario.observedSearch.queryRows.length,
      querySuppressionBoundary: scenario.observedSearch.note,
    },
    research: {
      ...scenario.keywordResearchMeta,
      selectedRepresentativeQueryCount: scenario.opportunities.length,
      byIntent: researchSummary,
    },
    assumptions: scenario.trafficAssumptions,
    funnels: scenario.funnels,
    tournament: {
      evaluatedStrategies,
      paretoFrontierStrategyIds: frontier.map((row) => row.id),
      selectedStrategyId: winner.id,
      selectionPolicy: "PARETO_FRONTIER_THEN_STRICT_COMMERCIAL_THEN_RELEVANT_THEN_CLUSTER_BREADTH_THEN_FEWER_PAGES_THEN_STABLE_ID",
      selectedStrategy: winner,
    },
    targetAssessment: {
      targetSupportVerdict,
      targetGaps,
      boundary: "MIXED_INTENT_MODELED_SESSIONS_ARE_INCLUDED_ONLY_IN_RELEVANT_SCENARIO_CAPACITY_AND_ARE_NOT_PROVEN_COMMERCIAL_VISITS_OR_CLIENTS",
    },
    executionPlan: scenario.executionPlan,
    warnings: [...WARNINGS],
    decisionBoundary: "PLAN_ONLY_NO_AUTONOMOUS_SITE_CMS_ADS_DNS_VERCEL_OR_TENANT_MUTATION",
  };
  return Object.freeze({ ...unsigned, reportSha256: sha256Canonical(unsigned) });
}

export const __test = Object.freeze({ canonicalJson, sha256Canonical, validateScenario, dominates, paretoFrontier });
