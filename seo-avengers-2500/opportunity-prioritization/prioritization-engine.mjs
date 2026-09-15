import { createHash } from "node:crypto";
import { buildGrowthScenarioReport } from "../growth-scenario/scenario-engine.mjs";

const SCHEMA_VERSION = 1;
const ENGINE_ID = "WALLE_OPPORTUNITY_PRIORITIZATION_V2";
const MAX_HARD_CANDIDATES = 2_000;
const SHA256_RE = /^sha256:[0-9a-f]{64}$/;
const PROFILE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

const TARGET_SELECTION_POLICY = "HARDEST_UNACHIEVED_AT_OR_ABOVE_MINIMUM_FEASIBILITY";
const WITHIN_FRONTIER_TIE_BREAK_POLICY =
  "ECONOMIC_THEN_FEASIBILITY_THEN_MOMENTUM_THEN_COMPETITION_THEN_IDENTITY";

const TARGET_IDS_HARDEST_FIRST = Object.freeze(["TOP_1", "TOP_3", "TOP_10"]);
const SCENARIO_IDS = Object.freeze(["CONSERVATIVE", "BASE", "UPSIDE"]);
const ECONOMIC_OBJECTIVES = Object.freeze([
  "INCREMENTAL_CLIENTS_MILLI",
  "INCREMENTAL_REVENUE_MICROS",
]);

const FEASIBILITY_ORDINAL = Object.freeze({
  INSUFFICIENT_DATA: 0,
  LOW: 1,
  MEDIUM: 2,
  HIGH: 3,
});
const MOMENTUM_ORDINAL = Object.freeze({
  INSUFFICIENT_DATA: 0,
  DECLINING: 1,
  STABLE: 2,
  IMPROVING: 3,
});
const COMPETITION_ORDINAL = Object.freeze({
  INSUFFICIENT_DATA: 0,
  HIGH: 1,
  MEDIUM: 2,
  LOW: 3,
});

function compareStrings(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function canonicalJson(value) {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return JSON.stringify(typeof value === "string" ? value.normalize("NFC") : value);
  }
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) throw new TypeError("prioritization values must be safe integers");
    return String(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value)
      .map(([key, item]) => [key.normalize("NFC"), item])
      .sort(([left], [right]) => compareStrings(left, right));
    const seen = new Set();
    return `{${entries.map(([key, item]) => {
      if (seen.has(key)) throw new TypeError("normalized mapping key collision");
      seen.add(key);
      return `${JSON.stringify(key)}:${canonicalJson(item)}`;
    }).join(",")}}`;
  }
  throw new TypeError("prioritization values must be JSON-compatible");
}

function sha256Canonical(value) {
  return `sha256:${createHash("sha256").update(Buffer.from(canonicalJson(value), "utf8")).digest("hex")}`;
}

function exactKeys(value, expected, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  if (JSON.stringify(Object.keys(value).sort()) !== JSON.stringify([...expected].sort())) {
    throw new Error(`unexpected ${label} keys`);
  }
}

function stringValue(value, label, { pattern = null, maxBytes = 16_384 } = {}) {
  if (typeof value !== "string") throw new Error(`${label} must be a string`);
  const normalized = value.normalize("NFC");
  if (!normalized.trim()) throw new Error(`${label} must not be empty`);
  if (Buffer.byteLength(normalized, "utf8") > maxBytes) throw new Error(`${label} exceeds size limit`);
  if (pattern !== null && !pattern.test(normalized)) throw new Error(`${label} has invalid format`);
  return normalized;
}

function integerValue(value, label, minimum, maximum) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${label} must be an integer in range`);
  }
  return value;
}

function booleanValue(value, label) {
  if (typeof value !== "boolean") throw new Error(`${label} must be boolean`);
  return value;
}

function enumValue(value, allowed, label) {
  if (!allowed.includes(value)) throw new Error(`${label} has unsupported value`);
  return value;
}

function validateRevenueFunnelRecords(value) {
  if (!Array.isArray(value) || value.length < 1 || value.length > 100_000) {
    throw new Error("revenueFunnelRecords must contain 1..100000 rows");
  }
  const bySource = new Map();
  for (const [index, row] of value.entries()) {
    exactKeys(
      row,
      ["average_ticket_micros", "close_rate_ppm", "lead_conversion_ppm", "sessions", "source_id"],
      `funnel row ${index}`,
    );
    const normalized = Object.freeze({
      source_id: stringValue(row.source_id, `funnel source ${index}`, { maxBytes: 256 }),
      sessions: integerValue(row.sessions, `funnel sessions ${index}`, 0, 1_000_000_000_000),
      lead_conversion_ppm: integerValue(row.lead_conversion_ppm, `lead conversion ${index}`, 0, 1_000_000),
      close_rate_ppm: integerValue(row.close_rate_ppm, `close rate ${index}`, 0, 1_000_000),
      average_ticket_micros: integerValue(row.average_ticket_micros, `average ticket ${index}`, 0, 9_000_000_000_000_000),
    });
    const prior = bySource.get(normalized.source_id);
    if (prior !== undefined && canonicalJson(prior) !== canonicalJson(normalized)) {
      throw new Error(`conflicting funnel source ${normalized.source_id}`);
    }
    bySource.set(normalized.source_id, normalized);
  }
  const rows = Object.freeze([...bySource.values()].sort((left, right) => compareStrings(left.source_id, right.source_id)));
  return Object.freeze({ rows, sha256: sha256Canonical(rows) });
}

function validateGrowthAssumptionProfile(value) {
  exactKeys(
    value,
    ["click_to_session_ppm", "organic_funnel_source_ids", "profile_id", "provenance", "scenarios", "schema_version"],
    "growth assumption profile",
  );
  if (value.schema_version !== 1) throw new Error("unsupported growth assumption profile schema");
  const profileId = stringValue(value.profile_id, "growth profile_id", { pattern: PROFILE_ID_RE, maxBytes: 128 });
  const provenance = stringValue(value.provenance, "growth provenance", { maxBytes: 4_096 });
  const clickToSessionPpm = integerValue(value.click_to_session_ppm, "click_to_session_ppm", 0, 1_000_000);
  if (!Array.isArray(value.organic_funnel_source_ids) || value.organic_funnel_source_ids.length < 1 || value.organic_funnel_source_ids.length > 128) {
    throw new Error("organic_funnel_source_ids must contain 1..128 values");
  }
  const sourceIds = value.organic_funnel_source_ids.map((item, index) => (
    stringValue(item, `organic funnel source ${index}`, { maxBytes: 256 })
  ));
  if (new Set(sourceIds).size !== sourceIds.length) throw new Error("organic_funnel_source_ids must be unique");

  if (!Array.isArray(value.scenarios) || value.scenarios.length !== SCENARIO_IDS.length) {
    throw new Error("growth assumption profile must contain exactly three scenarios");
  }
  const byScenario = new Map();
  for (const [index, scenario] of value.scenarios.entries()) {
    exactKeys(scenario, ["scenario_id", "target_ctr_ppm"], `growth scenario ${index}`);
    const scenarioId = enumValue(scenario.scenario_id, SCENARIO_IDS, `growth scenario_id ${index}`);
    if (byScenario.has(scenarioId)) throw new Error(`duplicate growth scenario_id ${scenarioId}`);
    exactKeys(scenario.target_ctr_ppm, ["TOP_10", "TOP_3", "TOP_1"], `growth target_ctr_ppm ${scenarioId}`);
    const targetCtrPpm = Object.freeze({
      TOP_10: integerValue(scenario.target_ctr_ppm.TOP_10, `${scenarioId} TOP_10 ctr`, 0, 1_000_000),
      TOP_3: integerValue(scenario.target_ctr_ppm.TOP_3, `${scenarioId} TOP_3 ctr`, 0, 1_000_000),
      TOP_1: integerValue(scenario.target_ctr_ppm.TOP_1, `${scenarioId} TOP_1 ctr`, 0, 1_000_000),
    });
    if (!(targetCtrPpm.TOP_10 <= targetCtrPpm.TOP_3 && targetCtrPpm.TOP_3 <= targetCtrPpm.TOP_1)) {
      throw new Error(`${scenarioId} target CTR must be monotonic from TOP_10 to TOP_1`);
    }
    byScenario.set(scenarioId, targetCtrPpm);
  }
  for (const targetId of ["TOP_10", "TOP_3", "TOP_1"]) {
    if (!(
      byScenario.get("CONSERVATIVE")[targetId]
      <= byScenario.get("BASE")[targetId]
      && byScenario.get("BASE")[targetId]
      <= byScenario.get("UPSIDE")[targetId]
    )) {
      throw new Error(`${targetId} CTR must be monotonic from CONSERVATIVE to UPSIDE`);
    }
  }

  const normalized = Object.freeze({
    schema_version: 1,
    profile_id: profileId,
    provenance,
    click_to_session_ppm: clickToSessionPpm,
    organic_funnel_source_ids: Object.freeze([...sourceIds].sort(compareStrings)),
    scenarios: Object.freeze(SCENARIO_IDS.map((scenarioId) => Object.freeze({
      scenario_id: scenarioId,
      target_ctr_ppm: byScenario.get(scenarioId),
    }))),
  });
  return Object.freeze({ normalized, sha256: sha256Canonical(normalized) });
}

function validatePrioritizationProfile(value) {
  exactKeys(
    value,
    [
      "economic_objective",
      "max_results",
      "maximum_candidates",
      "minimum_feasibility_band",
      "profile_id",
      "provenance",
      "require_competition_evidence",
      "require_momentum_evidence",
      "require_positive_incremental_value",
      "scenario_id",
      "schema_version",
      "target_selection_policy",
      "within_frontier_tie_break_policy",
    ],
    "prioritization profile",
  );
  if (value.schema_version !== SCHEMA_VERSION) throw new Error("unsupported prioritization profile schema");

  const profileId = stringValue(value.profile_id, "profile_id", { pattern: PROFILE_ID_RE, maxBytes: 128 });
  const provenance = stringValue(value.provenance, "provenance", { maxBytes: 4_096 });
  const scenarioId = enumValue(value.scenario_id, SCENARIO_IDS, "scenario_id");
  const economicObjective = enumValue(value.economic_objective, ECONOMIC_OBJECTIVES, "economic_objective");
  const minimumFeasibilityBand = enumValue(
    value.minimum_feasibility_band,
    ["LOW", "MEDIUM", "HIGH"],
    "minimum_feasibility_band",
  );
  if (value.target_selection_policy !== TARGET_SELECTION_POLICY) {
    throw new Error("unsupported target_selection_policy");
  }
  if (value.within_frontier_tie_break_policy !== WITHIN_FRONTIER_TIE_BREAK_POLICY) {
    throw new Error("unsupported within_frontier_tie_break_policy");
  }
  const requireMomentumEvidence = booleanValue(value.require_momentum_evidence, "require_momentum_evidence");
  const requireCompetitionEvidence = booleanValue(value.require_competition_evidence, "require_competition_evidence");
  const requirePositiveIncrementalValue = booleanValue(
    value.require_positive_incremental_value,
    "require_positive_incremental_value",
  );
  const maximumCandidates = integerValue(value.maximum_candidates, "maximum_candidates", 1, MAX_HARD_CANDIDATES);
  const maxResults = integerValue(value.max_results, "max_results", 1, MAX_HARD_CANDIDATES);
  if (maxResults > maximumCandidates) throw new Error("max_results must not exceed maximum_candidates");

  const canonicalProfile = {
    schema_version: SCHEMA_VERSION,
    profile_id: profileId,
    provenance,
    scenario_id: scenarioId,
    economic_objective: economicObjective,
    minimum_feasibility_band: minimumFeasibilityBand,
    target_selection_policy: TARGET_SELECTION_POLICY,
    within_frontier_tie_break_policy: WITHIN_FRONTIER_TIE_BREAK_POLICY,
    require_momentum_evidence: requireMomentumEvidence,
    require_competition_evidence: requireCompetitionEvidence,
    require_positive_incremental_value: requirePositiveIncrementalValue,
    maximum_candidates: maximumCandidates,
    max_results: maxResults,
  };

  return Object.freeze({
    schemaVersion: SCHEMA_VERSION,
    profileId,
    provenance,
    scenarioId,
    economicObjective,
    minimumFeasibilityBand,
    targetSelectionPolicy: TARGET_SELECTION_POLICY,
    withinFrontierTieBreakPolicy: WITHIN_FRONTIER_TIE_BREAK_POLICY,
    requireMomentumEvidence,
    requireCompetitionEvidence,
    requirePositiveIncrementalValue,
    maximumCandidates,
    maxResults,
    sha256: sha256Canonical(canonicalProfile),
  });
}

function validateRankAuthorityReport(report) {
  if (!report || typeof report !== "object" || Array.isArray(report)) {
    throw new Error("rank authority report must be an object");
  }
  if (report.schemaVersion !== 1) throw new Error("rank authority report schema mismatch");
  if (report.engineId !== "WALLE_RANK_CONTEXT_AUTHORITY_V1") throw new Error("rank authority engine mismatch");
  if (report.status !== "RANK_CONTEXT_READY") throw new Error("rank authority report must be RANK_CONTEXT_READY");
  if (report.decisionBoundary !== "AUTHORITY_CONTEXT_ONLY_DOES_NOT_UPGRADE_OR_DOWNGRADE_FEASIBILITY_BAND") {
    throw new Error("rank authority decision boundary mismatch");
  }
  if (typeof report.reportSha256 !== "string" || !SHA256_RE.test(report.reportSha256)) {
    throw new Error("rank authority report hash invalid");
  }
  const { reportSha256, ...unsigned } = report;
  if (sha256Canonical(unsigned) !== reportSha256) throw new Error("rank authority report hash mismatch");
  if (!Array.isArray(report.opportunities) || report.opportunities.length < 1 || report.opportunities.length > 100_000) {
    throw new Error("rank authority opportunities invalid");
  }
  if (!report.authority || typeof report.authority !== "object" || Array.isArray(report.authority)) {
    throw new Error("rank authority context missing");
  }
  exactKeys(
    report.authority,
    ["authorityStrength", "componentAverages", "sourceAssessmentStatus", "status", "topicCount"],
    "rank authority context",
  );
  const authorityStrength = enumValue(
    report.authority.authorityStrength,
    ["WEAK", "MODERATE", "STRONG", "INSUFFICIENT_DATA"],
    "authorityStrength",
  );
  const authorityStatus = enumValue(report.authority.status, ["AUTHORITY_READY", "INSUFFICIENT_DATA"], "authority status");
  const sourceAssessmentStatus = enumValue(
    report.authority.sourceAssessmentStatus,
    ["READY", "NEEDS_WORK"],
    "authority sourceAssessmentStatus",
  );
  const topicCount = integerValue(report.authority.topicCount, "authority topicCount", 1, 100_000);
  exactKeys(
    report.authority.componentAverages,
    ["authorityPpm", "centralityPpm", "cohesionPpm", "coveragePpm", "intentCoveragePpm", "primaryEvidencePpm"],
    "authority component averages",
  );
  const componentAverages = Object.freeze(Object.fromEntries(
    Object.entries(report.authority.componentAverages).map(([key, value]) => [
      key,
      integerValue(value, `authority ${key}`, 0, 1_000_000),
    ]),
  ));

  const opportunities = Object.freeze(report.opportunities.map((opportunity, index) => validateOpportunity(opportunity, index)));
  return Object.freeze({
    reportSha256,
    authority: Object.freeze({
      status: authorityStatus,
      authorityStrength,
      topicCount,
      sourceAssessmentStatus,
      componentAverages,
    }),
    opportunities,
  });
}

function validateOpportunity(opportunity, index) {
  if (!opportunity || typeof opportunity !== "object" || Array.isArray(opportunity)) {
    throw new Error(`opportunity ${index} must be an object`);
  }
  if (Object.hasOwn(opportunity, "authority")) {
    throw new Error(`query-level authority is forbidden without explicit query-topic mapping:${index}`);
  }
  if (Object.hasOwn(opportunity, "priorityScorePpm")) {
    throw new Error(`weighted priority score input is forbidden:${index}`);
  }

  const query = stringValue(opportunity.query, `query ${index}`, { maxBytes: 4_096 });
  const pageUrl = stringValue(opportunity.pageUrl, `page ${index}`);
  const observed = opportunity.observed;
  if (!observed || typeof observed !== "object" || Array.isArray(observed)) throw new Error(`observed ${index} missing`);
  const clicks = integerValue(observed.clicks, `clicks ${index}`, 0, 1_000_000_000_000);
  const impressions = integerValue(observed.impressions, `impressions ${index}`, 0, 1_000_000_000_000);
  if (clicks > impressions) throw new Error(`clicks exceed impressions ${index}`);
  const averagePositionMilli = observed.averagePositionMilli === null
    ? null
    : integerValue(observed.averagePositionMilli, `average position ${index}`, 0, 1_000_000_000);

  if (!Array.isArray(opportunity.targets) || opportunity.targets.length !== 3) {
    throw new Error(`targets ${index} must contain exactly three rank targets`);
  }
  const seenTargets = new Set();
  const targets = Object.freeze(opportunity.targets.map((target, targetIndex) => {
    if (!target || typeof target !== "object" || Array.isArray(target)) throw new Error(`target ${index}:${targetIndex} invalid`);
    if (!TARGET_IDS_HARDEST_FIRST.includes(target.rankTarget) || seenTargets.has(target.rankTarget)) {
      throw new Error(`target ${index}:${targetIndex} invalid or duplicate`);
    }
    seenTargets.add(target.rankTarget);
    const targetPositionMaxMilli = integerValue(
      target.targetPositionMaxMilli,
      `target position ${index}:${targetIndex}`,
      0,
      1_000_000_000,
    );
    const targetObservedPositionMilli = target.observedPositionMilli === null
      ? null
      : integerValue(target.observedPositionMilli, `target observed position ${index}:${targetIndex}`, 0, 1_000_000_000);
    if (targetObservedPositionMilli !== averagePositionMilli) {
      throw new Error(`target observed position mismatch ${index}:${targetIndex}`);
    }
    const observedImpressions = integerValue(
      target.observedImpressions,
      `target observed impressions ${index}:${targetIndex}`,
      0,
      1_000_000_000_000,
    );
    if (observedImpressions !== impressions) throw new Error(`target observed impressions mismatch ${index}:${targetIndex}`);
    integerValue(target.minimumImpressions, `target minimum impressions ${index}:${targetIndex}`, 1, 1_000_000_000_000);
    const evidenceStatus = stringValue(target.evidenceStatus, `target evidence status ${index}:${targetIndex}`, { maxBytes: 128 });
    const feasibilityBand = target.feasibilityBand;
    if (feasibilityBand !== "ACHIEVED" && !Object.hasOwn(FEASIBILITY_ORDINAL, feasibilityBand)) {
      throw new Error(`unsupported feasibility band ${index}:${targetIndex}`);
    }
    const gapMilli = target.gapMilli === null
      ? null
      : integerValue(target.gapMilli, `gap ${index}:${targetIndex}`, 0, 1_000_000_000);
    if (feasibilityBand === "INSUFFICIENT_DATA") {
      if (evidenceStatus === "SUFFICIENT_FOR_RULE_EVALUATION") {
        throw new Error(`insufficient feasibility cannot claim sufficient evidence ${index}:${targetIndex}`);
      }
    } else if (evidenceStatus !== "SUFFICIENT_FOR_RULE_EVALUATION") {
      throw new Error(`evaluated feasibility requires sufficient evidence ${index}:${targetIndex}`);
    }
    if (averagePositionMilli === null) {
      if (gapMilli !== null || feasibilityBand !== "INSUFFICIENT_DATA") {
        throw new Error(`target gap semantics mismatch ${index}:${targetIndex}`);
      }
    } else {
      const expectedGap = Math.max(0, averagePositionMilli - targetPositionMaxMilli);
      if (gapMilli !== expectedGap) throw new Error(`target gap semantics mismatch ${index}:${targetIndex}`);
      if (gapMilli === 0 && feasibilityBand !== "ACHIEVED") {
        throw new Error(`achieved target must be explicit ${index}:${targetIndex}`);
      }
      if (gapMilli > 0 && feasibilityBand === "ACHIEVED") {
        throw new Error(`unachieved target cannot be ACHIEVED ${index}:${targetIndex}`);
      }
    }
    return Object.freeze({ rankTarget: target.rankTarget, targetPositionMaxMilli, feasibilityBand, gapMilli });
  }));

  const momentumBand = opportunity.momentum?.momentumBand;
  if (!Object.hasOwn(MOMENTUM_ORDINAL, momentumBand)) throw new Error(`unsupported momentum band ${index}`);
  const momentumEvidenceStatus = stringValue(
    opportunity.momentum?.evidenceStatus,
    `momentum evidence status ${index}`,
    { maxBytes: 128 },
  );
  if (momentumBand === "INSUFFICIENT_DATA") {
    if (momentumEvidenceStatus === "SUFFICIENT_FOR_TREND_EVALUATION") {
      throw new Error(`insufficient momentum cannot claim sufficient evidence ${index}`);
    }
  } else if (momentumEvidenceStatus !== "SUFFICIENT_FOR_TREND_EVALUATION") {
    throw new Error(`evaluated momentum requires sufficient evidence ${index}`);
  }

  const competitionBand = opportunity.competition?.competitionBand;
  if (!Object.hasOwn(COMPETITION_ORDINAL, competitionBand)) throw new Error(`unsupported competition band ${index}`);
  const competitionEvidenceStatus = stringValue(
    opportunity.competition?.evidenceStatus,
    `competition evidence status ${index}`,
    { maxBytes: 128 },
  );
  if (competitionBand === "INSUFFICIENT_DATA") {
    if (competitionEvidenceStatus === "SUFFICIENT_FOR_RULE_EVALUATION") {
      throw new Error(`insufficient competition cannot claim sufficient evidence ${index}`);
    }
  } else if (competitionEvidenceStatus !== "SUFFICIENT_FOR_RULE_EVALUATION") {
    throw new Error(`evaluated competition requires sufficient evidence ${index}`);
  }

  return Object.freeze({
    query,
    pageUrl,
    observed: Object.freeze({ clicks, impressions, averagePositionMilli }),
    targets,
    momentumBand,
    competitionBand,
  });
}

function selectTarget(opportunity, profile) {
  const minimumOrdinal = FEASIBILITY_ORDINAL[profile.minimumFeasibilityBand];
  for (const targetId of TARGET_IDS_HARDEST_FIRST) {
    const target = opportunity.targets.find((candidate) => candidate.rankTarget === targetId);
    if (target.feasibilityBand === "ACHIEVED" || target.feasibilityBand === "INSUFFICIENT_DATA") continue;
    if (FEASIBILITY_ORDINAL[target.feasibilityBand] >= minimumOrdinal) return target;
  }
  return null;
}

function economicObjectiveValue(incremental, objective) {
  if (objective === "INCREMENTAL_CLIENTS_MILLI") return incremental.clientsMilli;
  if (objective === "INCREMENTAL_REVENUE_MICROS") return incremental.revenueMicros;
  throw new Error("unsupported economic objective");
}

function dominates(left, right) {
  const keys = ["economicObjectiveValue", "feasibilityOrdinal", "momentumOrdinal", "competitionOrdinal"];
  let strictlyBetter = false;
  for (const key of keys) {
    if (left.objectiveVector[key] < right.objectiveVector[key]) return false;
    if (left.objectiveVector[key] > right.objectiveVector[key]) strictlyBetter = true;
  }
  return strictlyBetter;
}

function paretoStructure(candidates) {
  const dominated = Array.from({ length: candidates.length }, () => []);
  const dominationCounts = new Array(candidates.length).fill(0);
  for (let left = 0; left < candidates.length; left += 1) {
    for (let right = left + 1; right < candidates.length; right += 1) {
      if (dominates(candidates[left], candidates[right])) {
        dominated[left].push(right);
        dominationCounts[right] += 1;
      } else if (dominates(candidates[right], candidates[left])) {
        dominated[right].push(left);
        dominationCounts[left] += 1;
      }
    }
  }

  const originalDominationCounts = [...dominationCounts];
  const layers = new Array(candidates.length).fill(null);
  let frontier = dominationCounts
    .map((count, index) => ({ count, index }))
    .filter(({ count }) => count === 0)
    .map(({ index }) => index);
  let layer = 1;
  let assigned = 0;

  while (frontier.length > 0) {
    const next = [];
    for (const index of frontier) {
      if (layers[index] !== null) throw new Error("pareto candidate assigned twice");
      layers[index] = layer;
      assigned += 1;
      for (const dominatedIndex of dominated[index]) {
        dominationCounts[dominatedIndex] -= 1;
        if (dominationCounts[dominatedIndex] === 0) next.push(dominatedIndex);
      }
    }
    frontier = next;
    layer += 1;
  }
  if (assigned !== candidates.length) throw new Error("pareto frontier construction failed");
  return Object.freeze({
    layers: Object.freeze(layers),
    directDominatorCounts: Object.freeze(originalDominationCounts),
  });
}

function prioritySort(left, right) {
  if (left.paretoLayer !== right.paretoLayer) return left.paretoLayer - right.paretoLayer;
  for (const key of ["economicObjectiveValue", "feasibilityOrdinal", "momentumOrdinal", "competitionOrdinal"]) {
    const leftValue = left.objectiveVector[key];
    const rightValue = right.objectiveVector[key];
    if (leftValue !== rightValue) return leftValue < rightValue ? 1 : -1;
  }
  return compareStrings(left.query, right.query)
    || compareStrings(left.pageUrl, right.pageUrl)
    || compareStrings(left.selectedTarget.rankTarget, right.selectedTarget.rankTarget);
}

export function buildOpportunityPrioritizationReport({
  rankAuthorityReport,
  revenueFunnelRecords,
  growthAssumptionProfile,
  prioritizationProfile,
}) {
  const rank = validateRankAuthorityReport(rankAuthorityReport);
  const profile = validatePrioritizationProfile(prioritizationProfile);
  const funnelEvidence = validateRevenueFunnelRecords(revenueFunnelRecords);
  const growthProfile = validateGrowthAssumptionProfile(growthAssumptionProfile);
  if (rank.opportunities.length > profile.maximumCandidates) {
    throw new Error("rank opportunity count exceeds explicit maximum_candidates; no silent truncation allowed");
  }

  const ineligibleReasonCounts = {
    NO_ELIGIBLE_TARGET: 0,
    MOMENTUM_EVIDENCE_REQUIRED: 0,
    COMPETITION_EVIDENCE_REQUIRED: 0,
    NON_POSITIVE_INCREMENTAL_OBJECTIVE: 0,
  };
  const candidates = [];
  let growthAssumptionProfileSha256 = null;

  for (const opportunity of rank.opportunities) {
    const selectedTarget = selectTarget(opportunity, profile);
    if (selectedTarget === null || opportunity.observed.averagePositionMilli === null) {
      ineligibleReasonCounts.NO_ELIGIBLE_TARGET += 1;
      continue;
    }
    if (profile.requireMomentumEvidence && opportunity.momentumBand === "INSUFFICIENT_DATA") {
      ineligibleReasonCounts.MOMENTUM_EVIDENCE_REQUIRED += 1;
      continue;
    }
    if (profile.requireCompetitionEvidence && opportunity.competitionBand === "INSUFFICIENT_DATA") {
      ineligibleReasonCounts.COMPETITION_EVIDENCE_REQUIRED += 1;
      continue;
    }

    const growth = buildGrowthScenarioReport({
      searchPerformanceRecords: [{
        query: opportunity.query,
        page_url: opportunity.pageUrl,
        clicks: opportunity.observed.clicks,
        impressions: opportunity.observed.impressions,
        average_position_milli: opportunity.observed.averagePositionMilli,
      }],
      revenueFunnelRecords: funnelEvidence.rows,
      assumptionProfile: growthProfile.normalized,
    });
    if (growth.status !== "SCENARIO_READY" || growth.interpretation !== "BOUNDED_HYPOTHETICAL_NOT_FORECAST") {
      throw new Error("growth scenario report boundary mismatch");
    }
    if (growth.assumptionProfile.sha256 !== growthProfile.sha256) {
      throw new Error("growth assumption profile hash mismatch");
    }
    if (growthAssumptionProfileSha256 === null) {
      growthAssumptionProfileSha256 = growth.assumptionProfile.sha256;
    } else if (growthAssumptionProfileSha256 !== growth.assumptionProfile.sha256) {
      throw new Error("growth assumption profile hash drift");
    }

    const scenario = growth.scenarios.find((item) => item.scenarioId === profile.scenarioId);
    const targetScenario = scenario?.targets.find((item) => item.rankTarget === selectedTarget.rankTarget);
    if (!targetScenario) throw new Error("growth scenario target missing");

    const objectiveValue = economicObjectiveValue(targetScenario.incrementalVsModeledCurrent, profile.economicObjective);
    if (profile.requirePositiveIncrementalValue && objectiveValue <= 0) {
      ineligibleReasonCounts.NON_POSITIVE_INCREMENTAL_OBJECTIVE += 1;
      continue;
    }

    candidates.push(Object.freeze({
      query: opportunity.query,
      pageUrl: opportunity.pageUrl,
      selectedTarget: Object.freeze({
        rankTarget: selectedTarget.rankTarget,
        feasibilityBand: selectedTarget.feasibilityBand,
        gapMilli: selectedTarget.gapMilli,
      }),
      signals: Object.freeze({
        momentumBand: opportunity.momentumBand,
        competitionBand: opportunity.competitionBand,
      }),
      economicScenario: Object.freeze({
        scenarioId: profile.scenarioId,
        assumedCtrPpm: targetScenario.assumedCtrPpm,
        incrementalVsModeledCurrent: targetScenario.incrementalVsModeledCurrent,
      }),
      objective: Object.freeze({ id: profile.economicObjective, value: objectiveValue }),
      objectiveVector: Object.freeze({
        economicObjectiveValue: objectiveValue,
        feasibilityOrdinal: FEASIBILITY_ORDINAL[selectedTarget.feasibilityBand],
        momentumOrdinal: MOMENTUM_ORDINAL[opportunity.momentumBand],
        competitionOrdinal: COMPETITION_ORDINAL[opportunity.competitionBand],
      }),
    }));
  }

  if (candidates.length > MAX_HARD_CANDIDATES) throw new Error("eligible candidate count exceeds engine hard limit");
  const pareto = paretoStructure(candidates);
  const ranked = Object.freeze(candidates.map((candidate, index) => Object.freeze({
    ...candidate,
    paretoLayer: pareto.layers[index],
    paretoFrontier: pareto.layers[index] === 1,
    dominatedByCount: pareto.directDominatorCounts[index],
  })).sort(prioritySort).map((candidate, index) => Object.freeze({ ...candidate, priorityRank: index + 1 })));

  const returned = Object.freeze(ranked.slice(0, profile.maxResults));
  const status = ranked.length > 0 ? "PRIORITIZATION_READY" : "INSUFFICIENT_DATA";
  const unsigned = {
    schemaVersion: SCHEMA_VERSION,
    engineId: ENGINE_ID,
    status,
    interpretation: "DETERMINISTIC_MULTI_OBJECTIVE_PRIORITY_NOT_FORECAST_OR_PROBABILITY",
    rankAuthorityReportSha256: rank.reportSha256,
    growthAssumptionProfileSha256: growthAssumptionProfileSha256 ?? growthProfile.sha256,
    normalizedRevenueFunnelRecordsSha256: funnelEvidence.sha256,
    prioritizationProfile: profile,
    authorityContext: rank.authority,
    summary: Object.freeze({
      inputOpportunityCount: rank.opportunities.length,
      eligibleCandidateCount: ranked.length,
      paretoFrontierCount: ranked.filter((candidate) => candidate.paretoFrontier).length,
      paretoLayerCount: ranked.reduce((max, candidate) => Math.max(max, candidate.paretoLayer), 0),
      returnedCount: returned.length,
      truncatedByExplicitMaxResults: returned.length < ranked.length,
      ineligibleReasonCounts: Object.freeze(ineligibleReasonCounts),
      fullCandidateSetSha256: sha256Canonical(ranked),
      returnedSetSha256: sha256Canonical(returned),
    }),
    opportunities: returned,
    decisionBoundary: "NO_HIDDEN_WEIGHTED_SCORE_AUTHORITY_REMAINS_GLOBAL_CONTEXT_WITHOUT_QUERY_TOPIC_MAPPING",
    warnings: Object.freeze([
      "NO_RANK_GUARANTEE",
      "NO_PROBABILITY_CLAIM",
      "NO_TRAFFIC_GUARANTEE",
      "NO_LEAD_OR_REVENUE_GUARANTEE",
      "ECONOMIC_VALUES_ARE_BOUNDED_SCENARIOS_NOT_FORECASTS",
      "CLIENT_QUALITY_IS_NOT_SEGMENTED_BY_QUERY_IN_V2",
      "AUTHORITY_CONTEXT_IS_NOT_QUERY_MAPPED_AND_IS_NOT_A_PRIORITY_DIMENSION",
      "PARETO_FRONTIER_IS_MULTI_OBJECTIVE_DOMINANCE_NOT_SUCCESS_PROBABILITY",
      "WITHIN_FRONTIER_ORDER_IS_EXPLICIT_POLICY_NOT_WEIGHTED_SCORE",
      "NO_SILENT_INPUT_TRUNCATION",
    ]),
  };
  return Object.freeze({ ...unsigned, reportSha256: sha256Canonical(unsigned) });
}
