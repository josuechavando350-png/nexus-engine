import { createHash } from "node:crypto";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { readSeoAvengers1200ProjectConfig } from "./seo-avengers-1200-config.mjs";

const AUTHORITY = "NEXUS_SEO_AVENGERS_1200_EXTENSION_V1";
const MAX_IMAGES = 10_000;
const MAX_SEARCH_PERFORMANCE_RECORDS = 50_000;
const MAX_KEYWORD_COVERAGE_RECORDS = 50_000;
const MAX_TRAFFIC_WINDOW_RECORDS = 10_000;
const MAX_TRAFFIC_SERIES_RECORDS = 10_000;
const MAX_REVENUE_FUNNEL_RECORDS = 10_000;
const MAX_REVENUE_ATTRIBUTION_RECORDS = 10_000;
const MAX_CONTENT_DOCUMENTS = 2_000;
const MAX_CONTENT_DECAY_RECORDS = 10_000;
const MAX_EXTERNAL_PAGES = 5_000;
const MAX_LOCAL_BUSINESS_RECORDS = 5_000;
const MAX_UPSTREAM_EVIDENCE = 1_200;
const MAX_LEGACY_MODULE_EVIDENCE = 200;
const JSON_KEY_RE = /^[A-Za-z0-9_.:-]+$/;

function assertJsonValue(value, path = "$") {
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number") {
    if (!Number.isFinite(value) || !Number.isSafeInteger(value)) {
      throw new TypeError(`${path} must contain only safe integers; floats/non-finite numbers are forbidden`);
    }
    return;
  }
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) assertJsonValue(value[index], `${path}[${index}]`);
    return;
  }
  if (typeof value === "object") {
    const proto = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) throw new TypeError(`${path} must be a plain JSON object`);
    for (const [key, child] of Object.entries(value)) {
      if (!JSON_KEY_RE.test(key)) throw new TypeError(`${path} contains a non-canonical object key`);
      assertJsonValue(child, `${path}.${key}`);
    }
    return;
  }
  throw new TypeError(`${path} contains a non-JSON value`);
}

function assertLegacyJsonValue(value, path = "$") {
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError(`${path} contains a non-finite number`);
    return;
  }
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) assertLegacyJsonValue(value[index], `${path}[${index}]`);
    return;
  }
  if (typeof value === "object") {
    const proto = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) throw new TypeError(`${path} must be a plain JSON object`);
    for (const [key, child] of Object.entries(value)) {
      if (!JSON_KEY_RE.test(key)) throw new TypeError(`${path} contains a non-canonical object key`);
      assertLegacyJsonValue(child, `${path}.${key}`);
    }
    return;
  }
  throw new TypeError(`${path} contains a non-JSON value`);
}

function canonicalJson(value) {
  assertJsonValue(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function canonicalLegacyJson(value) {
  assertLegacyJsonValue(value);
  if (Array.isArray(value)) return `[${value.map(canonicalLegacyJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalLegacyJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function wireBytes(value) {
  if (value === null) return Buffer.from("n;", "ascii");
  if (typeof value === "boolean") return Buffer.from(value ? "b1;" : "b0;", "ascii");
  if (typeof value === "number") return Buffer.from(`i${value};`, "ascii");
  if (typeof value === "string") {
    const bytes = Buffer.from(value, "utf8");
    return Buffer.concat([Buffer.from(`s${bytes.length}:`, "ascii"), bytes]);
  }
  if (Array.isArray(value)) {
    const parts = [Buffer.from(`a${value.length}[`, "ascii")];
    for (const item of value) parts.push(wireBytes(item));
    parts.push(Buffer.from("]", "ascii"));
    return Buffer.concat(parts);
  }
  const keys = Object.keys(value).sort();
  const parts = [Buffer.from(`o${keys.length}{`, "ascii")];
  for (const key of keys) {
    parts.push(wireBytes(key));
    parts.push(wireBytes(value[key]));
  }
  parts.push(Buffer.from("}", "ascii"));
  return Buffer.concat(parts);
}

function sha256(value) {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

export function envelopeHashV1(value) {
  assertJsonValue(value);
  return sha256(wireBytes(value));
}

function assertSegment(value, label) {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/.test(value)) {
    throw new Error(`${label} is invalid`);
  }
  return value;
}

function repositoryRootFromProject(projectDir) {
  const absolute = resolve(projectDir);
  const slash = process.platform === "win32" ? "\\" : "/";
  const marker = `${slash}apps${slash}`;
  const index = absolute.lastIndexOf(marker);
  if (index <= 0) throw new Error("project directory is not under repository apps/");
  return absolute.slice(0, index);
}

function boundedArray(value, label, maxItems) {
  const resolved = value ?? [];
  if (!Array.isArray(resolved) || resolved.length > maxItems) {
    throw new TypeError(`${label} must be an array with at most ${maxItems} entries`);
  }
  return resolved;
}

function validateExtensionPayload(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError("extension payload must be an object");
  const metaTelemetry = value.meta_telemetry ?? {};
  if (!metaTelemetry || typeof metaTelemetry !== "object" || Array.isArray(metaTelemetry)) {
    throw new TypeError("meta_telemetry must be an object");
  }

  const siteImagesData = boundedArray(value.site_images_data, "site_images_data", MAX_IMAGES);
  const searchPerformanceRecords = boundedArray(value.search_performance_records, "search_performance_records", MAX_SEARCH_PERFORMANCE_RECORDS);
  const keywordCoverageRecords = boundedArray(value.keyword_coverage_records, "keyword_coverage_records", MAX_KEYWORD_COVERAGE_RECORDS);
  const trafficWindowRecords = boundedArray(value.traffic_window_records, "traffic_window_records", MAX_TRAFFIC_WINDOW_RECORDS);
  const trafficSeriesRecords = boundedArray(value.traffic_series_records, "traffic_series_records", MAX_TRAFFIC_SERIES_RECORDS);
  const revenueFunnelRecords = boundedArray(value.revenue_funnel_records, "revenue_funnel_records", MAX_REVENUE_FUNNEL_RECORDS);
  const revenueAttributionRecords = boundedArray(value.revenue_attribution_records, "revenue_attribution_records", MAX_REVENUE_ATTRIBUTION_RECORDS);
  const contentDocuments = boundedArray(value.content_documents, "content_documents", MAX_CONTENT_DOCUMENTS);
  const contentDecayRecords = boundedArray(value.content_decay_records, "content_decay_records", MAX_CONTENT_DECAY_RECORDS);
  const externalPages = boundedArray(value.external_pages, "external_pages", MAX_EXTERNAL_PAGES);
  const localBusinessRecords = boundedArray(value.local_business_records, "local_business_records", MAX_LOCAL_BUSINESS_RECORDS);
  const upstreamEvidence = boundedArray(value.upstream_evidence, "upstream_evidence", MAX_UPSTREAM_EVIDENCE);
  const legacyEvidence = value.seo_avengers_200_module_evidence;

  let legacyEvidenceJson = null;
  if (legacyEvidence !== undefined && legacyEvidence !== null) {
    if (typeof legacyEvidence !== "object" || Array.isArray(legacyEvidence)) {
      throw new TypeError("seo_avengers_200_module_evidence must be an object");
    }
    if (Object.keys(legacyEvidence).length > MAX_LEGACY_MODULE_EVIDENCE) {
      throw new TypeError(`seo_avengers_200_module_evidence may contain at most ${MAX_LEGACY_MODULE_EVIDENCE} records`);
    }
    legacyEvidenceJson = canonicalLegacyJson(legacyEvidence);
  }

  const normalized = {
    meta_telemetry: metaTelemetry,
    site_images_data: siteImagesData,
    search_performance_records: searchPerformanceRecords,
    keyword_coverage_records: keywordCoverageRecords,
    traffic_window_records: trafficWindowRecords,
    traffic_series_records: trafficSeriesRecords,
    revenue_funnel_records: revenueFunnelRecords,
    revenue_attribution_records: revenueAttributionRecords,
    content_documents: contentDocuments,
    content_decay_records: contentDecayRecords,
    external_pages: externalPages,
    local_business_records: localBusinessRecords,
    upstream_evidence: upstreamEvidence,
    seo_avengers_200_module_evidence_json: legacyEvidenceJson,
  };
  assertJsonValue(normalized);
  return normalized;
}

function validateRuntimeConfig(value) {
  if (value === undefined || value === null) return {};
  if (typeof value !== "object" || Array.isArray(value)) throw new TypeError("runtimeConfig must be an object");
  assertJsonValue(value);
  return value;
}

export function buildSeoAvengers1200Envelope(input) {
  const payload = validateExtensionPayload(input.payload);
  const runtimeConfig = validateRuntimeConfig(input.runtimeConfig);
  const core = Object.freeze({
    authority: AUTHORITY,
    schema_version: 1,
    site_id: assertSegment(input.siteId, "siteId"),
    source_revision: assertSegment(input.sourceRevision, "sourceRevision"),
    payload,
    runtime_config: runtimeConfig,
  });
  const inputHash = envelopeHashV1(core);
  return Object.freeze({ ...core, input_hash: inputHash, idempotency_key: inputHash });
}

export async function enqueueSeoAvengers1200Run(input) {
  try {
    const projectDir = resolve(input.projectDir);
    const config = await readSeoAvengers1200ProjectConfig(projectDir);
    if (!config.enabled || !config.siteId) return Object.freeze({ status: "DISABLED" });
    if (!input.payload) return Object.freeze({ status: "SKIPPED_NO_EXTENSION_INPUT" });

    const envelope = buildSeoAvengers1200Envelope({
      siteId: config.siteId,
      sourceRevision: input.sourceRevision,
      payload: input.payload,
      runtimeConfig: input.runtimeConfig,
    });

    const root = repositoryRootFromProject(projectDir);
    const outboxDir = join(root, ".artifacts", "seo-avengers-1200", "outbox");
    await mkdir(outboxDir, { recursive: true });
    const basename = `${envelope.input_hash.slice("sha256:".length)}.json`;
    const destination = join(outboxDir, basename);
    const temporary = join(outboxDir, `.${basename}.${process.pid}.tmp`);
    const bytes = `${canonicalJson(envelope)}\n`;
    await writeFile(temporary, bytes, { encoding: "utf8", flag: "wx" });
    await rename(temporary, destination).catch(async (error) => {
      if (error?.code === "EEXIST" || error?.code === "ENOTEMPTY") return;
      throw error;
    });
    return Object.freeze({ status: "QUEUED", inputHash: envelope.input_hash, path: destination });
  } catch (error) {
    return Object.freeze({
      status: "SKIPPED_ERROR",
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
