import { createHash } from "node:crypto";

const SCHEMA_VERSION = 1;
const ENGINE_ID = "WALLE_CLIENT_QUALITY_COHORTS_V1";
const PPM = 1_000_000;
const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER);
const PROFILE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SHA256_RE = /^sha256:[0-9a-f]{64}$/;
const BASIS_VALUES = Object.freeze(["OBSERVED", "CLASSIFIED", "ESTIMATED"]);

function compareStrings(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function canonicalJson(value) {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return JSON.stringify(typeof value === "string" ? value.normalize("NFC") : value);
  }
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) throw new TypeError("client cohort values must be safe integers");
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
  throw new TypeError("client cohort values must be JSON-compatible");
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

function stringValue(value, label, { maxBytes = 4096, pattern = null } = {}) {
  if (typeof value !== "string") throw new Error(`${label} must be a string`);
  const normalized = value.normalize("NFC").trim();
  if (!normalized) throw new Error(`${label} must not be empty`);
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

function basisValue(value, label) {
  if (!BASIS_VALUES.includes(value)) throw new Error(`${label} has invalid evidence basis`);
  return value;
}

function toSafeNumber(value, label) {
  if (value < 0n || value > MAX_SAFE) throw new Error(`${label} exceeds safe integer range`);
  return Number(value);
}

function roundedRatio(numerator, denominator, scale, label) {
  if (!Number.isSafeInteger(numerator) || numerator < 0) throw new Error(`${label} numerator must be a non-negative safe integer`);
  if (!Number.isSafeInteger(denominator) || denominator <= 0) throw new Error(`${label} denominator must be a positive safe integer`);
  const num = BigInt(numerator) * BigInt(scale);
  const den = BigInt(denominator);
  return toSafeNumber((num + (den / 2n)) / den, label);
}

function roundedAverage(total, count, label) {
  if (!Number.isSafeInteger(total) || total < 0) throw new Error(`${label} total must be a non-negative safe integer`);
  if (!Number.isSafeInteger(count) || count <= 0) throw new Error(`${label} count must be positive`);
  return toSafeNumber((BigInt(total) + (BigInt(count) / 2n)) / BigInt(count), label);
}

function normalizeAllowedValues(value, label) {
  if (!Array.isArray(value) || value.length < 1 || value.length > 10_000) {
    throw new Error(`${label} must contain 1..10000 values`);
  }
  const normalized = value.map((item, index) => stringValue(item, `${label}[${index}]`, { maxBytes: 512 })).sort(compareStrings);
  if (new Set(normalized).size !== normalized.length) throw new Error(`${label} must be unique`);
  return Object.freeze(normalized);
}

function validateProfile(value) {
  exactKeys(
    value,
    [
      "geographies",
      "intents",
      "mapping_profile_id",
      "mapping_profile_sha256",
      "minimum_leads",
      "minimum_sessions",
      "profile_id",
      "provenance",
      "schema_version",
      "service_categories",
      "sources",
      "ticket_bands",
      "urgencies",
    ],
    "client cohort profile",
  );
  if (value.schema_version !== SCHEMA_VERSION) throw new Error("unsupported client cohort profile schema");
  const profileId = stringValue(value.profile_id, "profile_id", { maxBytes: 128, pattern: PROFILE_ID_RE });
  const provenance = stringValue(value.provenance, "provenance", { maxBytes: 4096 });
  const mappingProfileId = stringValue(value.mapping_profile_id, "mapping_profile_id", { maxBytes: 128, pattern: PROFILE_ID_RE });
  if (typeof value.mapping_profile_sha256 !== "string" || !SHA256_RE.test(value.mapping_profile_sha256)) {
    throw new Error("mapping_profile_sha256 must be sha256:<64 lowercase hex>");
  }
  const minimumSessions = integerValue(value.minimum_sessions, "minimum_sessions", 1, 1_000_000_000_000);
  const minimumLeads = integerValue(value.minimum_leads, "minimum_leads", 1, 1_000_000_000_000);
  if (minimumLeads > minimumSessions) throw new Error("minimum_leads must not exceed minimum_sessions");
  const canonicalProfile = {
    schema_version: SCHEMA_VERSION,
    profile_id: profileId,
    provenance,
    mapping_profile_id: mappingProfileId,
    mapping_profile_sha256: value.mapping_profile_sha256,
    minimum_sessions: minimumSessions,
    minimum_leads: minimumLeads,
    service_categories: normalizeAllowedValues(value.service_categories, "service_categories"),
    intents: normalizeAllowedValues(value.intents, "intents"),
    geographies: normalizeAllowedValues(value.geographies, "geographies"),
    urgencies: normalizeAllowedValues(value.urgencies, "urgencies"),
    ticket_bands: normalizeAllowedValues(value.ticket_bands, "ticket_bands"),
    sources: normalizeAllowedValues(value.sources, "sources"),
  };
  return Object.freeze({
    schemaVersion: SCHEMA_VERSION,
    profileId,
    provenance,
    mappingProfileId,
    mappingProfileSha256: value.mapping_profile_sha256,
    minimumSessions,
    minimumLeads,
    serviceCategories: canonicalProfile.service_categories,
    intents: canonicalProfile.intents,
    geographies: canonicalProfile.geographies,
    urgencies: canonicalProfile.urgencies,
    ticketBands: canonicalProfile.ticket_bands,
    sources: canonicalProfile.sources,
    sha256: sha256Canonical(canonicalProfile),
  });
}

function validateRow(row, index) {
  exactKeys(
    row,
    [
      "geography",
      "geography_basis",
      "intent",
      "intent_basis",
      "leads",
      "revenue_micros",
      "service_category",
      "service_category_basis",
      "sessions",
      "signed_clients",
      "source_basis",
      "source_id",
      "ticket_band",
      "ticket_band_basis",
      "urgency",
      "urgency_basis",
      "window_end_unix_ms",
      "window_start_unix_ms",
    ],
    `client cohort row ${index}`,
  );
  const sessions = integerValue(row.sessions, `sessions ${index}`, 0, 1_000_000_000_000);
  const leads = integerValue(row.leads, `leads ${index}`, 0, 1_000_000_000_000);
  const signedClients = integerValue(row.signed_clients, `signed_clients ${index}`, 0, 1_000_000_000_000);
  if (leads > sessions) throw new Error(`client cohort leads exceed sessions ${index}`);
  if (signedClients > leads) throw new Error(`client cohort signed_clients exceed leads ${index}`);
  const revenueMicros = integerValue(row.revenue_micros, `revenue_micros ${index}`, 0, Number.MAX_SAFE_INTEGER);
  if (signedClients === 0 && revenueMicros !== 0) throw new Error(`client cohort revenue requires at least one signed client ${index}`);
  const windowStartUnixMs = integerValue(row.window_start_unix_ms, `window start ${index}`, 1, Number.MAX_SAFE_INTEGER);
  const windowEndUnixMs = integerValue(row.window_end_unix_ms, `window end ${index}`, 1, Number.MAX_SAFE_INTEGER);
  if (windowEndUnixMs <= windowStartUnixMs) throw new Error(`client cohort window must be positive ${index}`);
  return Object.freeze({
    serviceCategory: stringValue(row.service_category, `service_category ${index}`, { maxBytes: 512 }),
    serviceCategoryBasis: basisValue(row.service_category_basis, `service_category_basis ${index}`),
    intent: stringValue(row.intent, `intent ${index}`, { maxBytes: 512 }),
    intentBasis: basisValue(row.intent_basis, `intent_basis ${index}`),
    geography: stringValue(row.geography, `geography ${index}`, { maxBytes: 512 }),
    geographyBasis: basisValue(row.geography_basis, `geography_basis ${index}`),
    urgency: stringValue(row.urgency, `urgency ${index}`, { maxBytes: 512 }),
    urgencyBasis: basisValue(row.urgency_basis, `urgency_basis ${index}`),
    ticketBand: stringValue(row.ticket_band, `ticket_band ${index}`, { maxBytes: 512 }),
    ticketBandBasis: basisValue(row.ticket_band_basis, `ticket_band_basis ${index}`),
    sourceId: stringValue(row.source_id, `source_id ${index}`, { maxBytes: 512 }),
    sourceBasis: basisValue(row.source_basis, `source_basis ${index}`),
    sessions,
    leads,
    signedClients,
    revenueMicros,
    windowStartUnixMs,
    windowEndUnixMs,
  });
}

function identity(row) {
  return {
    serviceCategory: row.serviceCategory,
    intent: row.intent,
    geography: row.geography,
    urgency: row.urgency,
    ticketBand: row.ticketBand,
    sourceId: row.sourceId,
    windowStartUnixMs: row.windowStartUnixMs,
    windowEndUnixMs: row.windowEndUnixMs,
  };
}

function rowSort(left, right) {
  return compareStrings(sha256Canonical(identity(left)), sha256Canonical(identity(right)));
}

function normalizeRows(value) {
  if (!Array.isArray(value) || value.length < 1 || value.length > 100_000) {
    throw new Error("clientCohortRecords must contain 1..100000 rows");
  }
  const registry = new Map();
  let window = null;
  for (const [index, raw] of value.entries()) {
    const row = validateRow(raw, index);
    const currentWindow = `${row.windowStartUnixMs}:${row.windowEndUnixMs}`;
    if (window === null) window = currentWindow;
    if (currentWindow !== window) throw new Error("client cohort rows must share one observation window");
    const key = sha256Canonical(identity(row));
    const prior = registry.get(key);
    if (prior !== undefined && canonicalJson(prior) !== canonicalJson(row)) {
      throw new Error(`conflicting duplicate client cohort:${key}`);
    }
    registry.set(key, row);
  }
  return Object.freeze([...registry.values()].sort(rowSort));
}

function ensureAllowed(rows, profile) {
  const allow = {
    serviceCategory: new Set(profile.serviceCategories),
    intent: new Set(profile.intents),
    geography: new Set(profile.geographies),
    urgency: new Set(profile.urgencies),
    ticketBand: new Set(profile.ticketBands),
    sourceId: new Set(profile.sources),
  };
  for (const row of rows) {
    for (const [field, set] of Object.entries(allow)) {
      if (!set.has(row[field])) throw new Error(`client cohort ${field} is outside hash-bound mapping profile:${row[field]}`);
    }
  }
}

function basisSummary(rows) {
  const summary = {
    serviceCategory: { OBSERVED: 0, CLASSIFIED: 0, ESTIMATED: 0 },
    intent: { OBSERVED: 0, CLASSIFIED: 0, ESTIMATED: 0 },
    geography: { OBSERVED: 0, CLASSIFIED: 0, ESTIMATED: 0 },
    urgency: { OBSERVED: 0, CLASSIFIED: 0, ESTIMATED: 0 },
    ticketBand: { OBSERVED: 0, CLASSIFIED: 0, ESTIMATED: 0 },
    source: { OBSERVED: 0, CLASSIFIED: 0, ESTIMATED: 0 },
  };
  for (const row of rows) {
    summary.serviceCategory[row.serviceCategoryBasis] += 1;
    summary.intent[row.intentBasis] += 1;
    summary.geography[row.geographyBasis] += 1;
    summary.urgency[row.urgencyBasis] += 1;
    summary.ticketBand[row.ticketBandBasis] += 1;
    summary.source[row.sourceBasis] += 1;
  }
  return Object.freeze(Object.fromEntries(Object.entries(summary).map(([key, value]) => [key, Object.freeze(value)])));
}

function aggregateTotals(rows) {
  let sessions = 0n;
  let leads = 0n;
  let signedClients = 0n;
  let revenueMicros = 0n;
  for (const row of rows) {
    sessions += BigInt(row.sessions);
    leads += BigInt(row.leads);
    signedClients += BigInt(row.signedClients);
    revenueMicros += BigInt(row.revenueMicros);
  }
  return Object.freeze({
    sessions: toSafeNumber(sessions, "total sessions"),
    leads: toSafeNumber(leads, "total leads"),
    signedClients: toSafeNumber(signedClients, "total signed clients"),
    revenueMicros: toSafeNumber(revenueMicros, "total revenue micros"),
  });
}

function metricsFor(row) {
  const leadConversionPpm = row.sessions > 0 ? roundedRatio(row.leads, row.sessions, PPM, "lead conversion ppm") : 0;
  const closeRatePpm = row.leads > 0 ? roundedRatio(row.signedClients, row.leads, PPM, "close rate ppm") : 0;
  const signedClientRatePpm = row.sessions > 0 ? roundedRatio(row.signedClients, row.sessions, PPM, "signed client rate ppm") : 0;
  const averageTicketMicros = row.signedClients > 0 ? roundedAverage(row.revenueMicros, row.signedClients, "average ticket micros") : null;
  const revenuePerLeadMicros = row.leads > 0 ? roundedAverage(row.revenueMicros, row.leads, "revenue per lead micros") : 0;
  return Object.freeze({
    sessions: row.sessions,
    leads: row.leads,
    signedClients: row.signedClients,
    revenueMicros: row.revenueMicros,
    leadConversionPpm,
    closeRatePpm,
    signedClientRatePpm,
    averageTicketMicros,
    revenuePerLeadMicros,
  });
}

function publicCohort(row) {
  const dimensions = Object.freeze({
    serviceCategory: Object.freeze({ value: row.serviceCategory, basis: row.serviceCategoryBasis }),
    intent: Object.freeze({ value: row.intent, basis: row.intentBasis }),
    geography: Object.freeze({ value: row.geography, basis: row.geographyBasis }),
    urgency: Object.freeze({ value: row.urgency, basis: row.urgencyBasis }),
    ticketBand: Object.freeze({ value: row.ticketBand, basis: row.ticketBandBasis }),
    source: Object.freeze({ value: row.sourceId, basis: row.sourceBasis }),
  });
  return Object.freeze({
    cohortId: sha256Canonical(identity(row)),
    window: Object.freeze({ startUnixMs: row.windowStartUnixMs, endUnixMs: row.windowEndUnixMs }),
    dimensions,
    metrics: metricsFor(row),
    interpretation: "AGGREGATE_COHORT_OUTCOMES_NOT_INDIVIDUAL_CLIENT_RECORDS",
  });
}

export function buildClientCohortEvidenceReport({ clientCohortRecords, cohortProfile }) {
  const profile = validateProfile(cohortProfile);
  const rows = normalizeRows(clientCohortRecords);
  ensureAllowed(rows, profile);
  const eligible = [];
  const suppressed = [];
  for (const row of rows) {
    if (row.sessions < profile.minimumSessions || row.leads < profile.minimumLeads) suppressed.push(row);
    else eligible.push(row);
  }
  const basis = basisSummary(rows);
  const hasModeledBasis = Object.values(basis).some((counts) => counts.CLASSIFIED > 0 || counts.ESTIMATED > 0);
  const totals = aggregateTotals(eligible);
  const summaryMetrics = eligible.length === 0
    ? Object.freeze({ leadConversionPpm: null, closeRatePpm: null, signedClientRatePpm: null, averageTicketMicros: null, revenuePerLeadMicros: null })
    : Object.freeze({
      leadConversionPpm: totals.sessions > 0 ? roundedRatio(totals.leads, totals.sessions, PPM, "overall lead conversion ppm") : 0,
      closeRatePpm: totals.leads > 0 ? roundedRatio(totals.signedClients, totals.leads, PPM, "overall close rate ppm") : 0,
      signedClientRatePpm: totals.sessions > 0 ? roundedRatio(totals.signedClients, totals.sessions, PPM, "overall signed client rate ppm") : 0,
      averageTicketMicros: totals.signedClients > 0 ? roundedAverage(totals.revenueMicros, totals.signedClients, "overall average ticket micros") : null,
      revenuePerLeadMicros: totals.leads > 0 ? roundedAverage(totals.revenueMicros, totals.leads, "overall revenue per lead micros") : 0,
    });
  const warnings = [
    "NO_RAW_PII_ACCEPTED_BY_SCHEMA",
    "AGGREGATE_COHORT_EVIDENCE_NOT_INDIVIDUAL_CLIENT_DATA",
    "NO_QUERY_LEVEL_ATTRIBUTION_CLAIM",
    "NO_CAUSAL_SEO_LIFT_CLAIM",
    "CLIENT_COHORT_EVIDENCE_DOES_NOT_CHANGE_RANK_FEASIBILITY_OR_OPPORTUNITY_PRIORITY",
  ];
  if (hasModeledBasis) warnings.push("CLASSIFIED_OR_ESTIMATED_DIMENSIONS_ARE_NOT_OBSERVED");
  if (suppressed.length > 0) warnings.push("SMALL_COHORTS_SUPPRESSED_BY_EXPLICIT_PRIVACY_THRESHOLDS");
  const unsigned = {
    schemaVersion: SCHEMA_VERSION,
    engineId: ENGINE_ID,
    status: eligible.length > 0 ? "COHORT_EVIDENCE_READY" : "INSUFFICIENT_DATA",
    interpretation: "PRIVACY_SAFE_AGGREGATE_CLIENT_COHORT_OUTCOME_EVIDENCE_NOT_QUERY_CAUSALITY",
    cohortProfile: profile,
    mappingBoundary: "CLASSIFIED_AND_ESTIMATED_DIMENSIONS_ARE_NEVER_RELABELED_OBSERVED",
    decisionBoundary: "CLIENT_COHORT_EVIDENCE_REMAINS_CONTEXT_UNTIL_EXPLICIT_ATTRIBUTION_MAPPING_EXISTS",
    summary: Object.freeze({
      inputCohortCount: rows.length,
      eligibleCohortCount: eligible.length,
      suppressedCohortCount: suppressed.length,
      eligibleTotals: totals,
      eligibleMetrics: summaryMetrics,
      basisCounts: basis,
      suppressedRowsSha256: sha256Canonical(suppressed),
      eligibleRowsSha256: sha256Canonical(eligible),
    }),
    cohorts: Object.freeze(eligible.map(publicCohort)),
    warnings: Object.freeze(warnings),
  };
  return Object.freeze({ ...unsigned, reportSha256: sha256Canonical(unsigned) });
}
