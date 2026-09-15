import { createHash } from "node:crypto";
import { lstat, mkdir, mkdtemp, realpath, rename, rm, writeFile } from "node:fs/promises";
import { join, resolve, sep } from "node:path";

import { readTenantControl } from "../control-plane/tenant-control.mjs";

const SCHEMA_VERSION = 1;
const SITE_ID_RE = /^[a-z0-9][a-z0-9-]{0,79}$/;
const CAPTURE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const SOURCE_AUTHORITY_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SHA256_RE = /^sha256:[0-9a-f]{64}$/;
const MAX_RECORDS_PER_DATASET = 100_000;
const MAX_TEXT_BYTES = 2 * 1024 * 1024;
const PPM = 1_000_000;
const COMPETITION_PROVIDER = "NEXUS_COMPETITIVE_SNAPSHOT";

const PROVIDER_KEYS = Object.freeze({
  GOOGLE_SEARCH_CONSOLE: Object.freeze(["search_performance_history_records", "search_performance_records"]),
  GOOGLE_ANALYTICS_4: Object.freeze(["traffic_series_records", "traffic_window_records"]),
  GOOGLE_BUSINESS_PROFILE: Object.freeze(["local_business_records"]),
  NEXUS_SITE_SNAPSHOT: Object.freeze(["content_documents"]),
  NEXUS_CRM: Object.freeze(["revenue_funnel_records"]),
  [COMPETITION_PROVIDER]: Object.freeze(["keyword_coverage_records"]),
});

function compareStrings(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function canonicalJson(value) {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return JSON.stringify(typeof value === "string" ? value.normalize("NFC") : value);
  }
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) throw new TypeError("provider snapshot numbers must be safe integers");
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
  throw new TypeError("provider snapshot values must be JSON-compatible");
}

function sha256Bytes(value) {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

export function canonicalProviderRecordsSha256(records) {
  return sha256Bytes(Buffer.from(canonicalJson(records), "utf8"));
}

function assertExactKeys(value, expected, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  if (JSON.stringify(Object.keys(value).sort()) !== JSON.stringify([...expected].sort())) {
    throw new Error(`unexpected ${label} keys`);
  }
}

function requireString(value, label, { maxBytes = 8192 } = {}) {
  if (typeof value !== "string") throw new Error(`${label} must be a string`);
  const normalized = value.normalize("NFC");
  if (!normalized.trim()) throw new Error(`${label} must not be empty`);
  if (Buffer.byteLength(normalized, "utf8") > maxBytes) throw new Error(`${label} exceeds size limit`);
  return normalized;
}

function requireInteger(value, label, minimum, maximum) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${label} must be an integer in range`);
  }
  return value;
}

function validateSearchPerformance(rows) {
  for (const [index, row] of rows.entries()) {
    assertExactKeys(row, ["average_position_milli", "clicks", "impressions", "page_url", "query"], `search performance row ${index}`);
    requireString(row.query, `search query ${index}`, { maxBytes: 4096 });
    requireString(row.page_url, `search page ${index}`, { maxBytes: 16384 });
    const clicks = requireInteger(row.clicks, `search clicks ${index}`, 0, 1_000_000_000_000);
    const impressions = requireInteger(row.impressions, `search impressions ${index}`, 0, 1_000_000_000_000);
    if (clicks > impressions) throw new Error(`search clicks exceed impressions ${index}`);
    requireInteger(row.average_position_milli, `search average position ${index}`, 0, 1_000_000_000);
  }
}

function validateSearchPerformanceHistory(rows) {
  for (const [index, row] of rows.entries()) {
    assertExactKeys(
      row,
      [
        "average_position_milli",
        "clicks",
        "impressions",
        "page_url",
        "query",
        "window_end_unix_ms",
        "window_start_unix_ms",
      ],
      `search performance history row ${index}`,
    );
    requireString(row.query, `search history query ${index}`, { maxBytes: 4096 });
    requireString(row.page_url, `search history page ${index}`, { maxBytes: 16384 });
    const clicks = requireInteger(row.clicks, `search history clicks ${index}`, 0, 1_000_000_000_000);
    const impressions = requireInteger(row.impressions, `search history impressions ${index}`, 0, 1_000_000_000_000);
    if (clicks > impressions) throw new Error(`search history clicks exceed impressions ${index}`);
    requireInteger(row.average_position_milli, `search history average position ${index}`, 0, 1_000_000_000);
    const start = requireInteger(row.window_start_unix_ms, `search history window start ${index}`, 1, Number.MAX_SAFE_INTEGER);
    const end = requireInteger(row.window_end_unix_ms, `search history window end ${index}`, 1, Number.MAX_SAFE_INTEGER);
    if (end <= start) throw new Error(`search history window must be half-open and positive ${index}`);
  }
}

function validateKeywordCoverage(rows) {
  for (const [index, row] of rows.entries()) {
    assertExactKeys(
      row,
      ["competitor_ranked_count", "keyword", "search_volume", "site_ranked"],
      `keyword coverage row ${index}`,
    );
    requireString(row.keyword, `competition keyword ${index}`, { maxBytes: 4096 });
    if (typeof row.site_ranked !== "boolean") throw new Error(`competition site_ranked ${index} must be boolean`);
    requireInteger(row.competitor_ranked_count, `competition ranked count ${index}`, 0, 100_000);
    requireInteger(row.search_volume, `competition search volume ${index}`, 0, 1_000_000_000_000);
  }
}

function validateTrafficWindows(rows) {
  for (const [index, row] of rows.entries()) {
    assertExactKeys(row, ["baseline_visits", "baseline_window_days", "current_visits", "current_window_days", "entity_id"], `traffic window row ${index}`);
    requireString(row.entity_id, `traffic entity ${index}`, { maxBytes: 16384 });
    requireInteger(row.baseline_visits, `baseline visits ${index}`, 0, 1_000_000_000_000);
    requireInteger(row.current_visits, `current visits ${index}`, 0, 1_000_000_000_000);
    requireInteger(row.baseline_window_days, `baseline window days ${index}`, 1, 3660);
    requireInteger(row.current_window_days, `current window days ${index}`, 1, 3660);
  }
}

function validateTrafficSeries(rows) {
  for (const [index, row] of rows.entries()) {
    assertExactKeys(row, ["entity_id", "visits_series"], `traffic series row ${index}`);
    requireString(row.entity_id, `traffic series entity ${index}`, { maxBytes: 16384 });
    if (!Array.isArray(row.visits_series) || row.visits_series.length < 1 || row.visits_series.length > 3660) {
      throw new Error(`traffic series ${index} must contain 1..3660 observations`);
    }
    row.visits_series.forEach((value, position) => requireInteger(value, `traffic series ${index}:${position}`, 0, 1_000_000_000_000));
  }
}

function validateLocalBusiness(rows) {
  for (const [index, row] of rows.entries()) {
    assertExactKeys(row, ["address", "latitude_e6", "longitude_e6", "name", "phone", "source_id"], `local business row ${index}`);
    requireString(row.source_id, `local source ${index}`, { maxBytes: 256 });
    requireString(row.name, `local name ${index}`, { maxBytes: 4096 });
    requireString(row.address, `local address ${index}`, { maxBytes: 8192 });
    requireString(row.phone, `local phone ${index}`, { maxBytes: 256 });
    requireInteger(row.latitude_e6, `local latitude ${index}`, -90_000_000, 90_000_000);
    requireInteger(row.longitude_e6, `local longitude ${index}`, -180_000_000, 180_000_000);
  }
}

function validateContentDocuments(rows) {
  for (const [index, row] of rows.entries()) {
    assertExactKeys(row, ["document_id", "text"], `content document ${index}`);
    requireString(row.document_id, `document id ${index}`, { maxBytes: 16384 });
    requireString(row.text, `document text ${index}`, { maxBytes: MAX_TEXT_BYTES });
  }
}

function validateRevenueFunnel(rows) {
  for (const [index, row] of rows.entries()) {
    assertExactKeys(row, ["average_ticket_micros", "close_rate_ppm", "lead_conversion_ppm", "sessions", "source_id"], `revenue funnel row ${index}`);
    requireString(row.source_id, `funnel source ${index}`, { maxBytes: 256 });
    requireInteger(row.sessions, `funnel sessions ${index}`, 0, 1_000_000_000_000);
    requireInteger(row.lead_conversion_ppm, `lead conversion ${index}`, 0, PPM);
    requireInteger(row.close_rate_ppm, `close rate ${index}`, 0, PPM);
    requireInteger(row.average_ticket_micros, `average ticket ${index}`, 0, 9_000_000_000_000_000);
  }
}

const VALIDATORS = Object.freeze({
  search_performance_records: validateSearchPerformance,
  search_performance_history_records: validateSearchPerformanceHistory,
  keyword_coverage_records: validateKeywordCoverage,
  traffic_window_records: validateTrafficWindows,
  traffic_series_records: validateTrafficSeries,
  local_business_records: validateLocalBusiness,
  content_documents: validateContentDocuments,
  revenue_funnel_records: validateRevenueFunnel,
});

function validateDataset(dataset) {
  if (!dataset || typeof dataset !== "object" || Array.isArray(dataset)) throw new Error("provider dataset must be an object");
  const competition = dataset.provider === COMPETITION_PROVIDER;
  assertExactKeys(
    dataset,
    competition
      ? ["key", "provider", "records", "records_sha256", "source_authority", "source_capture_sha256"]
      : ["key", "provider", "records", "records_sha256"],
    "provider dataset",
  );
  if (typeof dataset.provider !== "string" || !(dataset.provider in PROVIDER_KEYS)) throw new Error("unsupported provider");
  if (typeof dataset.key !== "string" || !PROVIDER_KEYS[dataset.provider].includes(dataset.key)) {
    throw new Error("provider is not authorized for dataset key");
  }
  if (!Array.isArray(dataset.records) || dataset.records.length > MAX_RECORDS_PER_DATASET) {
    throw new Error("provider dataset records must be a bounded array");
  }
  if (typeof dataset.records_sha256 !== "string" || !SHA256_RE.test(dataset.records_sha256)) {
    throw new Error("invalid provider records sha256");
  }
  if (canonicalProviderRecordsSha256(dataset.records) !== dataset.records_sha256) {
    throw new Error("provider records digest mismatch");
  }
  VALIDATORS[dataset.key](dataset.records);

  let sourceAuthority = null;
  let sourceCaptureSha256 = null;
  if (competition) {
    sourceAuthority = requireString(dataset.source_authority, "competition source_authority", { maxBytes: 128 });
    if (!SOURCE_AUTHORITY_RE.test(sourceAuthority)) throw new Error("competition source_authority has invalid format");
    if (typeof dataset.source_capture_sha256 !== "string" || !SHA256_RE.test(dataset.source_capture_sha256)) {
      throw new Error("invalid competition source_capture_sha256");
    }
    sourceCaptureSha256 = dataset.source_capture_sha256;
  }

  return {
    provider: dataset.provider,
    key: dataset.key,
    records: dataset.records,
    recordsSha256: dataset.records_sha256,
    sourceAuthority,
    sourceCaptureSha256,
  };
}

function validateSnapshot(snapshot, siteId, generation) {
  assertExactKeys(snapshot, ["capture_id", "control_generation", "datasets", "observed_at_unix_ms", "schema_version", "site_id"], "provider snapshot");
  if (snapshot.schema_version !== SCHEMA_VERSION) throw new Error("unsupported provider snapshot schema");
  if (snapshot.site_id !== siteId) throw new Error("cross-tenant provider snapshot rejected");
  if (snapshot.control_generation !== generation) throw new Error("stale provider snapshot control generation");
  if (typeof snapshot.capture_id !== "string" || !CAPTURE_ID_RE.test(snapshot.capture_id)) throw new Error("invalid capture id");
  requireInteger(snapshot.observed_at_unix_ms, "observed_at_unix_ms", 1, Number.MAX_SAFE_INTEGER);
  if (!Array.isArray(snapshot.datasets) || snapshot.datasets.length < 1 || snapshot.datasets.length > 16) {
    throw new Error("provider snapshot datasets must contain 1..16 entries");
  }
  const seen = new Set();
  const datasets = snapshot.datasets.map(validateDataset).sort((left, right) => compareStrings(left.key, right.key));
  for (const dataset of datasets) {
    if (seen.has(dataset.key)) throw new Error("duplicate provider dataset key");
    seen.add(dataset.key);
  }
  return datasets;
}

function rootPath(evidenceRoot) {
  if (typeof evidenceRoot !== "string" || !evidenceRoot.trim()) throw new Error("evidenceRoot is required");
  return resolve(evidenceRoot);
}

function tenantPath(evidenceRoot, siteId) {
  if (typeof siteId !== "string" || !SITE_ID_RE.test(siteId)) throw new Error("invalid siteId");
  const root = rootPath(evidenceRoot);
  const tenantsRoot = resolve(root, "tenants");
  const target = resolve(tenantsRoot, siteId);
  if (!target.startsWith(`${tenantsRoot}${sep}`)) throw new Error("tenant evidence path escaped evidence root");
  return target;
}

async function assertCanonicalDirectory(directory, label) {
  const info = await lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(`${label} must be a real directory`);
  const actual = await realpath(directory);
  if (actual !== resolve(directory)) throw new Error(`${label} must not traverse symlinks`);
}

async function targetExists(target) {
  try {
    await lstat(target);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

async function writeCanonicalFile(path, value) {
  const bytes = Buffer.from(`${canonicalJson(value)}\n`, "utf8");
  await writeFile(path, bytes, { flag: "wx", mode: 0o600 });
  return { sha256: sha256Bytes(bytes) };
}

export async function publishAuthorizedProviderSnapshot({ controlRoot, evidenceRoot, siteId, snapshot }) {
  if (typeof siteId !== "string" || !SITE_ID_RE.test(siteId)) throw new Error("invalid siteId");
  const control = await readTenantControl({ controlRoot, siteId });
  if (!control.authorized || !control.integrityOk) throw new Error(`tenant is not authorized: ${control.reason}`);

  const datasets = validateSnapshot(snapshot, siteId, control.generation);
  const root = rootPath(evidenceRoot);
  const tenantsRoot = resolve(root, "tenants");
  await assertCanonicalDirectory(root, "evidenceRoot");
  await assertCanonicalDirectory(tenantsRoot, "evidence tenants root");

  const lockDirectory = join(root, `.provider-lock-${siteId}`);
  try {
    await mkdir(lockDirectory, { mode: 0o700 });
  } catch (error) {
    if (error?.code === "EEXIST") throw new Error("provider publication already locked");
    throw error;
  }

  let stagingRoot = null;
  let previousMoved = false;
  let published = false;
  try {
    stagingRoot = await mkdtemp(join(root, ".provider-staging-"));
    const stagedTenant = join(stagingRoot, "tenant");
    const previousTenant = join(stagingRoot, "previous");
    await mkdir(stagedTenant, { mode: 0o700 });

    const descriptors = [];
    const provenance = [];
    for (const dataset of datasets) {
      const file = `${dataset.key}.json`;
      const written = await writeCanonicalFile(join(stagedTenant, file), dataset.records);
      descriptors.push({ key: dataset.key, file, sha256: written.sha256 });
      const provenanceRecord = {
        source_id: `${dataset.provider}:${dataset.key}`,
        provider: dataset.provider,
        dataset_key: dataset.key,
        capture_id: snapshot.capture_id,
        observed_at_unix_ms: snapshot.observed_at_unix_ms,
        record_count: dataset.records.length,
        records_sha256: dataset.recordsSha256,
      };
      if (dataset.sourceAuthority !== null) {
        provenanceRecord.source_authority = dataset.sourceAuthority;
        provenanceRecord.source_capture_sha256 = dataset.sourceCaptureSha256;
      }
      provenance.push(provenanceRecord);
    }

    const upstreamFile = "upstream_evidence.json";
    const upstream = await writeCanonicalFile(join(stagedTenant, upstreamFile), provenance);
    descriptors.push({ key: "upstream_evidence", file: upstreamFile, sha256: upstream.sha256 });
    descriptors.sort((left, right) => compareStrings(left.key, right.key));

    const manifest = {
      schema_version: SCHEMA_VERSION,
      site_id: siteId,
      control_generation: control.generation,
      datasets: descriptors,
    };
    await writeCanonicalFile(join(stagedTenant, "manifest.json"), manifest);

    const beforePublish = await readTenantControl({ controlRoot, siteId });
    if (!beforePublish.authorized || !beforePublish.integrityOk || beforePublish.generation !== control.generation) {
      throw new Error("control changed before provider snapshot publication");
    }

    const target = tenantPath(evidenceRoot, siteId);
    if (await targetExists(target)) {
      await assertCanonicalDirectory(target, "existing tenant evidence directory");
      await rename(target, previousTenant);
      previousMoved = true;
    }
    try {
      await rename(stagedTenant, target);
      published = true;
    } catch (error) {
      if (previousMoved) {
        await rename(previousTenant, target);
        previousMoved = false;
      }
      throw error;
    }

    if (previousMoved) {
      await rm(previousTenant, { recursive: true, force: true });
      previousMoved = false;
    }

    const afterPublish = await readTenantControl({ controlRoot, siteId });
    const manifestHash = sha256Bytes(Buffer.from(canonicalJson(manifest), "utf8"));
    if (!afterPublish.authorized || !afterPublish.integrityOk || afterPublish.generation !== control.generation) {
      return Object.freeze({
        schemaVersion: SCHEMA_VERSION,
        siteId,
        status: "STALE",
        reason: "CONTROL_CHANGED_AFTER_PUBLICATION",
        controlGeneration: afterPublish.generation,
        captureId: snapshot.capture_id,
        manifestHash,
      });
    }
    return Object.freeze({
      schemaVersion: SCHEMA_VERSION,
      siteId,
      status: "PUBLISHED",
      reason: "PUBLISHED",
      controlGeneration: control.generation,
      captureId: snapshot.capture_id,
      manifestHash,
      datasetCount: descriptors.length,
    });
  } finally {
    if (!published && previousMoved && stagingRoot !== null) {
      const target = tenantPath(evidenceRoot, siteId);
      const previousTenant = join(stagingRoot, "previous");
      if (!(await targetExists(target)) && await targetExists(previousTenant)) await rename(previousTenant, target);
    }
    if (stagingRoot !== null) await rm(stagingRoot, { recursive: true, force: true });
    await rm(lockDirectory, { recursive: true, force: true });
  }
}
