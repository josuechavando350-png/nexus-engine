import { createHash } from "node:crypto";

const SCHEMA_VERSION = 1;
const PPM = 1_000_000;
const MILLI = 1_000;
const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER);
const PROFILE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const SCENARIO_IDS = Object.freeze(["CONSERVATIVE", "BASE", "UPSIDE"]);
const RANK_TARGETS = Object.freeze([
  Object.freeze({ id: "TOP_10", targetPositionMaxMilli: 10_000 }),
  Object.freeze({ id: "TOP_3", targetPositionMaxMilli: 3_000 }),
  Object.freeze({ id: "TOP_1", targetPositionMaxMilli: 1_000 }),
]);

function compareStrings(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function canonicalJson(value) {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return JSON.stringify(typeof value === "string" ? value.normalize("NFC") : value);
  }
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) throw new TypeError("scenario values must be safe integers");
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
  throw new TypeError("scenario values must be JSON-compatible");
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

function toSafeNumber(value, label) {
  if (value < 0n || value > MAX_SAFE) throw new Error(`${label} exceeds safe integer range`);
  return Number(value);
}

function mulDivFloor(values, divisor, label) {
  let numerator = 1n;
  for (const value of values) {
    if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${label} input must be a non-negative safe integer`);
    numerator *= BigInt(value);
  }
  const denominator = BigInt(divisor);
  if (denominator <= 0n) throw new Error(`${label} divisor must be positive`);
  return toSafeNumber(numerator / denominator, label);
}

function validateSearchRows(value) {
  if (!Array.isArray(value) || value.length < 1 || value.length > 100_000) {
    throw new Error("searchPerformanceRecords must contain 1..100000 rows");
  }
  return value.map((row, index) => {
    exactKeys(row, ["average_position_milli", "clicks", "impressions", "page_url", "query"], `search row ${index}`);
    const clicks = integerValue(row.clicks, `search clicks ${index}`, 0, 1_000_000_000_000);
    const impressions = integerValue(row.impressions, `search impressions ${index}`, 0, 1_000_000_000_000);
    if (clicks > impressions) throw new Error(`search clicks exceed impressions ${index}`);
    return Object.freeze({
      query: stringValue(row.query, `search query ${index}`, { maxBytes: 4096 }),
      pageUrl: stringValue(row.page_url, `search page ${index}`),
      clicks,
      impressions,
      averagePositionMilli: integerValue(row.average_position_milli, `average position ${index}`, 0, 1_000_000_000),
    });
  });
}

function validateFunnelRows(value) {
  if (!Array.isArray(value) || value.length < 1 || value.length > 100_000) {
    throw new Error("revenueFunnelRecords must contain 1..100000 rows");
  }
  const bySource = new Map();
  for (const [index, row] of value.entries()) {
    exactKeys(row, ["average_ticket_micros", "close_rate_ppm", "lead_conversion_ppm", "sessions", "source_id"], `funnel row ${index}`);
    const normalized = Object.freeze({
      sourceId: stringValue(row.source_id, `funnel source ${index}`, { maxBytes: 256 }),
      sessions: integerValue(row.sessions, `funnel sessions ${index}`, 0, 1_000_000_000_000),
      leadConversionPpm: integerValue(row.lead_conversion_ppm, `lead conversion ${index}`, 0, PPM),
      closeRatePpm: integerValue(row.close_rate_ppm, `close rate ${index}`, 0, PPM),
      averageTicketMicros: integerValue(row.average_ticket_micros, `average ticket ${index}`, 0, 9_000_000_000_000_000),
    });
    const prior = bySource.get(normalized.sourceId);
    if (prior && canonicalJson(prior) !== canonicalJson(normalized)) {
      throw new Error(`conflicting funnel source ${normalized.sourceId}`);
    }
    bySource.set(normalized.sourceId, normalized);
  }
  return [...bySource.values()].sort((left, right) => compareStrings(left.sourceId, right.sourceId));
}

function validateAssumptionProfile(value) {
  exactKeys(
    value,
    ["click_to_session_ppm", "organic_funnel_source_ids", "profile_id", "provenance", "scenarios", "schema_version"],
    "assumption profile",
  );
  if (value.schema_version !== SCHEMA_VERSION) throw new Error("unsupported assumption profile schema");
  const profileId = stringValue(value.profile_id, "profile_id", { pattern: PROFILE_ID_RE, maxBytes: 128 });
  const provenance = stringValue(value.provenance, "provenance", { maxBytes: 4096 });
  const clickToSessionPpm = integerValue(value.click_to_session_ppm, "click_to_session_ppm", 0, PPM);
  if (!Array.isArray(value.organic_funnel_source_ids) || value.organic_funnel_source_ids.length < 1 || value.organic_funnel_source_ids.length > 128) {
    throw new Error("organic_funnel_source_ids must contain 1..128 values");
  }
  const sourceIds = value.organic_funnel_source_ids.map((item, index) => stringValue(item, `organic funnel source ${index}`, { maxBytes: 256 }));
  if (new Set(sourceIds).size !== sourceIds.length) throw new Error("organic_funnel_source_ids must be unique");

  if (!Array.isArray(value.scenarios) || value.scenarios.length !== SCENARIO_IDS.length) {
    throw new Error("assumption profile must contain exactly three scenarios");
  }
  const scenariosById = new Map();
  for (const [index, scenario] of value.scenarios.entries()) {
    exactKeys(scenario, ["scenario_id", "target_ctr_ppm"], `scenario ${index}`);
    if (!SCENARIO_IDS.includes(scenario.scenario_id)) throw new Error(`unsupported scenario_id ${scenario.scenario_id}`);
    if (scenariosById.has(scenario.scenario_id)) throw new Error(`duplicate scenario_id ${scenario.scenario_id}`);
    exactKeys(scenario.target_ctr_ppm, RANK_TARGETS.map((target) => target.id), `target_ctr_ppm ${scenario.scenario_id}`);
    const targets = {};
    let priorCtr = -1;
    for (const target of RANK_TARGETS) {
      const ctr = integerValue(scenario.target_ctr_ppm[target.id], `${scenario.scenario_id} ${target.id} ctr`, 0, PPM);
      if (ctr < priorCtr) throw new Error(`${scenario.scenario_id} target CTR must be monotonic from TOP_10 to TOP_1`);
      priorCtr = ctr;
      targets[target.id] = ctr;
    }
    scenariosById.set(scenario.scenario_id, Object.freeze({ scenarioId: scenario.scenario_id, targetCtrPpm: Object.freeze(targets) }));
  }
  for (const target of RANK_TARGETS) {
    let priorCtr = -1;
    for (const scenarioId of SCENARIO_IDS) {
      const ctr = scenariosById.get(scenarioId).targetCtrPpm[target.id];
      if (ctr < priorCtr) throw new Error(`${target.id} CTR must be monotonic from CONSERVATIVE to UPSIDE`);
      priorCtr = ctr;
    }
  }

  const orderedSourceIds = [...sourceIds].sort(compareStrings);
  const orderedScenarios = SCENARIO_IDS.map((scenarioId) => scenariosById.get(scenarioId));
  const canonicalProfile = {
    schema_version: SCHEMA_VERSION,
    profile_id: profileId,
    provenance,
    click_to_session_ppm: clickToSessionPpm,
    organic_funnel_source_ids: orderedSourceIds,
    scenarios: orderedScenarios.map((scenario) => ({
      scenario_id: scenario.scenarioId,
      target_ctr_ppm: scenario.targetCtrPpm,
    })),
  };
  return Object.freeze({
    schemaVersion: SCHEMA_VERSION,
    profileId,
    provenance,
    clickToSessionPpm,
    organicFunnelSourceIds: Object.freeze(orderedSourceIds),
    scenarios: Object.freeze(orderedScenarios),
    sha256: sha256Canonical(canonicalProfile),
  });
}

function aggregateSearch(rows) {
  const impressionsBig = rows.reduce((sum, row) => sum + BigInt(row.impressions), 0n);
  const clicksBig = rows.reduce((sum, row) => sum + BigInt(row.clicks), 0n);
  if (impressionsBig <= 0n) throw new Error("INSUFFICIENT_DATA:search_impressions_empty");
  const impressions = toSafeNumber(impressionsBig, "search impressions aggregate");
  const clicks = toSafeNumber(clicksBig, "search clicks aggregate");
  const weightedPositionNumerator = rows.reduce(
    (sum, row) => sum + BigInt(row.averagePositionMilli) * BigInt(row.impressions),
    0n,
  );
  const ctrPpm = toSafeNumber((clicksBig * BigInt(PPM)) / impressionsBig, "observed ctr");
  const weightedPositionMilli = toSafeNumber(weightedPositionNumerator / impressionsBig, "weighted position");
  return Object.freeze({
    queryCount: new Set(rows.map((row) => row.query)).size,
    pageCount: new Set(rows.map((row) => row.pageUrl)).size,
    impressions,
    clicks,
    ctrPpm,
    impressionWeightedPositionMilli: weightedPositionMilli,
  });
}

function aggregateFunnel(rows, sourceIds) {
  const wanted = new Set(sourceIds);
  const selected = rows.filter((row) => wanted.has(row.sourceId));
  if (selected.length < 1) throw new Error("INSUFFICIENT_DATA:organic_funnel_rows_missing");

  const sessionsBig = selected.reduce((sum, row) => sum + BigInt(row.sessions), 0n);
  if (sessionsBig <= 0n) throw new Error("INSUFFICIENT_DATA:organic_funnel_sessions_empty");
  const sessions = toSafeNumber(sessionsBig, "funnel sessions aggregate");
  const leadWeight = selected.reduce(
    (sum, row) => sum + BigInt(row.sessions) * BigInt(row.leadConversionPpm),
    0n,
  );
  const leadConversionPpm = toSafeNumber(leadWeight / sessionsBig, "weighted lead conversion");
  const closeWeight = selected.reduce(
    (sum, row) => sum + BigInt(row.sessions) * BigInt(row.leadConversionPpm) * BigInt(row.closeRatePpm),
    0n,
  );
  const closeRatePpm = leadWeight > 0n
    ? toSafeNumber(closeWeight / leadWeight, "weighted close rate")
    : 0;
  const ticketWeight = selected.reduce(
    (sum, row) => sum
      + BigInt(row.sessions)
      * BigInt(row.leadConversionPpm)
      * BigInt(row.closeRatePpm)
      * BigInt(row.averageTicketMicros),
    0n,
  );
  const averageTicketMicros = closeWeight > 0n
    ? toSafeNumber(ticketWeight / closeWeight, "weighted ticket")
    : 0;
  const composedConversionPpm = mulDivFloor([leadConversionPpm, closeRatePpm], PPM, "composed conversion");
  return Object.freeze({
    sourceIds: Object.freeze(selected.map((row) => row.sourceId).sort(compareStrings)),
    sessions,
    leadConversionPpm,
    closeRatePpm,
    composedConversionPpm,
    averageTicketMicros,
  });
}

function modelCounts({ clicksMilli, clickToSessionPpm, funnel }) {
  const sessionsMilli = mulDivFloor([clicksMilli, clickToSessionPpm], PPM, "modeled sessions");
  const leadsMilli = mulDivFloor([sessionsMilli, funnel.leadConversionPpm], PPM, "modeled leads");
  const clientsMilli = mulDivFloor([leadsMilli, funnel.closeRatePpm], PPM, "modeled clients");
  const revenueMicros = mulDivFloor([clientsMilli, funnel.averageTicketMicros], MILLI, "modeled revenue");
  return Object.freeze({ clicksMilli, sessionsMilli, leadsMilli, clientsMilli, revenueMicros });
}

function subtractCounts(projected, baseline) {
  const result = {};
  for (const key of ["clicksMilli", "sessionsMilli", "leadsMilli", "clientsMilli", "revenueMicros"]) {
    result[key] = Math.max(0, projected[key] - baseline[key]);
  }
  return Object.freeze(result);
}

export function buildGrowthScenarioReport({ searchPerformanceRecords, revenueFunnelRecords, assumptionProfile }) {
  const searchRows = validateSearchRows(searchPerformanceRecords);
  const funnelRows = validateFunnelRows(revenueFunnelRecords);
  const profile = validateAssumptionProfile(assumptionProfile);
  const observedSearch = aggregateSearch(searchRows);
  const observedFunnel = aggregateFunnel(funnelRows, profile.organicFunnelSourceIds);

  const modeledCurrent = modelCounts({
    clicksMilli: observedSearch.clicks * MILLI,
    clickToSessionPpm: profile.clickToSessionPpm,
    funnel: observedFunnel,
  });

  const scenarios = profile.scenarios.map((scenario) => Object.freeze({
    scenarioId: scenario.scenarioId,
    targets: Object.freeze(RANK_TARGETS.map((target) => {
      const assumedCtrPpm = scenario.targetCtrPpm[target.id];
      const projectedClicksMilli = mulDivFloor(
        [observedSearch.impressions, assumedCtrPpm, MILLI],
        PPM,
        `${scenario.scenarioId} ${target.id} projected clicks`,
      );
      const projected = modelCounts({
        clicksMilli: projectedClicksMilli,
        clickToSessionPpm: profile.clickToSessionPpm,
        funnel: observedFunnel,
      });
      return Object.freeze({
        rankTarget: target.id,
        targetPositionMaxMilli: target.targetPositionMaxMilli,
        assumedCtrPpm,
        projected,
        incrementalVsModeledCurrent: subtractCounts(projected, modeledCurrent),
      });
    })),
  }));

  return Object.freeze({
    schemaVersion: SCHEMA_VERSION,
    engineId: "WALLE_GROWTH_SCENARIO_V1",
    status: "SCENARIO_READY",
    interpretation: "BOUNDED_HYPOTHETICAL_NOT_FORECAST",
    warnings: Object.freeze([
      "NO_RANK_GUARANTEE",
      "NO_TRAFFIC_GUARANTEE",
      "NO_LEAD_OR_REVENUE_GUARANTEE",
      "CTR_ASSUMPTIONS_ARE_NOT_GOOGLE_CONSTANTS",
      "CLIENT_QUALITY_REQUIRES_SEGMENTED_FIRST_PARTY_FUNNEL_EVIDENCE",
    ]),
    assumptionProfile: Object.freeze({
      profileId: profile.profileId,
      provenance: profile.provenance,
      sha256: profile.sha256,
      clickToSessionPpm: profile.clickToSessionPpm,
      organicFunnelSourceIds: profile.organicFunnelSourceIds,
    }),
    observed: Object.freeze({ search: observedSearch, funnel: observedFunnel }),
    modeledCurrent,
    scenarios: Object.freeze(scenarios),
  });
}
