import { createHash } from "node:crypto";
import { lstat, readdir, readFile, realpath } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { readTenantControl } from "../control-plane/tenant-control.mjs";
import { readVersionedEvidenceSnapshot } from "./versioned-evidence.mjs";

const SCHEMA_VERSION = 1;
const SITE_ID_RE = /^[a-z0-9][a-z0-9-]{0,79}$/;
const SHA256_RE = /^sha256:[0-9a-f]{64}$/;
const MANIFEST_FILENAME = "manifest.json";

export const ALLOWED_DATASET_KEYS = Object.freeze([
  "canonicalization_records",
  "content_decay_records",
  "content_documents",
  "cwv_edge_records",
  "edge_gateway_records",
  "keyword_coverage_records",
  "local_business_records",
  "persistence_state_records",
  "policy_audit_records",
  "revenue_attribution_records",
  "revenue_funnel_records",
  "search_intent_records",
  "search_performance_records",
  "semantic_text_records",
  "traffic_series_records",
  "traffic_window_records",
  "upstream_evidence",
]);

const ALLOWED_DATASET_SET = new Set(ALLOWED_DATASET_KEYS);

function sha256Bytes(value) {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function canonicalJson(value) {
  if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) throw new TypeError("evidence numbers must be safe integers");
    return String(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const keys = Object.keys(value).sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  throw new TypeError("evidence values must be JSON-compatible");
}

function assertExactKeys(value, expected, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  if (JSON.stringify(Object.keys(value).sort()) !== JSON.stringify([...expected].sort())) {
    throw new Error(`unexpected ${label} keys`);
  }
}

function assertSiteId(siteId) {
  if (typeof siteId !== "string" || !SITE_ID_RE.test(siteId)) throw new Error("invalid siteId");
  return siteId;
}

function evidenceRootPath(evidenceRoot) {
  if (typeof evidenceRoot !== "string" || !evidenceRoot.trim()) throw new Error("evidenceRoot is required");
  return resolve(evidenceRoot);
}

function tenantEvidenceDirectory(evidenceRoot, siteId) {
  const root = evidenceRootPath(evidenceRoot);
  const directory = resolve(root, "tenants", assertSiteId(siteId));
  const requiredPrefix = `${resolve(root, "tenants")}${sep}`;
  if (!directory.startsWith(requiredPrefix)) throw new Error("tenant evidence path escaped evidence root");
  return directory;
}

async function assertCanonicalDirectory(directory, label) {
  const info = await lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(`${label} must be a real directory`);
  const actual = await realpath(directory);
  if (actual !== resolve(directory)) throw new Error(`${label} must not traverse symlinks`);
}

async function readCanonicalFile(path, label) {
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink()) throw new Error(`${label} must be a regular file`);
  const actual = await realpath(path);
  if (actual !== resolve(path)) throw new Error(`${label} must not traverse symlinks`);
  return readFile(path);
}

function validateManifest(value, siteId, controlGeneration) {
  assertExactKeys(value, ["control_generation", "datasets", "schema_version", "site_id"], "manifest");
  if (value.schema_version !== SCHEMA_VERSION) throw new Error("unsupported evidence schema version");
  if (value.site_id !== siteId) throw new Error("cross-tenant evidence rejected");
  if (!Number.isSafeInteger(value.control_generation) || value.control_generation < 1) {
    throw new Error("invalid evidence control generation");
  }
  if (value.control_generation !== controlGeneration) throw new Error("stale evidence control generation");
  if (!Array.isArray(value.datasets)) throw new Error("manifest datasets must be an array");

  const seen = new Set();
  const descriptors = [];
  for (const descriptor of value.datasets) {
    assertExactKeys(descriptor, ["file", "key", "sha256"], "dataset descriptor");
    if (typeof descriptor.key !== "string" || !ALLOWED_DATASET_SET.has(descriptor.key)) {
      throw new Error("unsupported dataset key");
    }
    if (seen.has(descriptor.key)) throw new Error("duplicate dataset key");
    seen.add(descriptor.key);
    const expectedFile = `${descriptor.key}.json`;
    if (descriptor.file !== expectedFile) throw new Error("dataset filename must match dataset key");
    if (typeof descriptor.sha256 !== "string" || !SHA256_RE.test(descriptor.sha256)) {
      throw new Error("invalid dataset sha256");
    }
    descriptors.push({ key: descriptor.key, file: descriptor.file, sha256: descriptor.sha256 });
  }
  return descriptors.sort((a, b) => a.key.localeCompare(b.key));
}

function decision({ siteId, controlGeneration, status, integrityOk, reason, manifestHash = null, datasets = {} }) {
  return Object.freeze({
    siteId,
    controlGeneration,
    status,
    integrityOk,
    reason,
    manifestHash,
    datasets: Object.freeze(datasets),
  });
}

export async function readTenantEvidenceSnapshot({ controlRoot, evidenceRoot, siteId }) {
  const control = await readTenantControl({ controlRoot, siteId });
  if (!control.authorized) {
    return decision({
      siteId: typeof siteId === "string" ? siteId : "",
      controlGeneration: control.generation,
      status: "OFF",
      integrityOk: control.integrityOk,
      reason: control.reason,
    });
  }

  const versioned = await readVersionedEvidenceSnapshot({
    controlRoot,
    evidenceRoot,
    siteId,
    authorizedControl: control,
  });
  if (versioned !== null) return versioned;

  let root;
  let tenantsRoot;
  let directory;
  try {
    root = evidenceRootPath(evidenceRoot);
    await assertCanonicalDirectory(root, "evidenceRoot");
    tenantsRoot = resolve(root, "tenants");
    await assertCanonicalDirectory(tenantsRoot, "evidence tenants root");
    directory = tenantEvidenceDirectory(evidenceRoot, siteId);
    try {
      await assertCanonicalDirectory(directory, "tenant evidence directory");
    } catch (error) {
      if (error?.code === "ENOENT") {
        return decision({
          siteId,
          controlGeneration: control.generation,
          status: "INSUFFICIENT_DATA",
          integrityOk: true,
          reason: "EVIDENCE_MISSING",
        });
      }
      throw error;
    }
  } catch {
    return decision({
      siteId,
      controlGeneration: control.generation,
      status: "BLOCKED",
      integrityOk: false,
      reason: "EVIDENCE_ROOT_UNSAFE_OR_UNREADABLE",
    });
  }

  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    return decision({
      siteId,
      controlGeneration: control.generation,
      status: "BLOCKED",
      integrityOk: false,
      reason: "EVIDENCE_STORE_UNREADABLE",
    });
  }

  if (entries.length === 0) {
    return decision({
      siteId,
      controlGeneration: control.generation,
      status: "INSUFFICIENT_DATA",
      integrityOk: true,
      reason: "EVIDENCE_MISSING",
    });
  }

  let manifestBytes;
  let manifest;
  let descriptors;
  try {
    const manifestEntry = entries.find((entry) => entry.name === MANIFEST_FILENAME);
    if (!manifestEntry || !manifestEntry.isFile()) throw new Error("manifest missing or not a regular file");
    for (const entry of entries) {
      if (!entry.isFile()) throw new Error("unexpected non-file evidence entry");
    }
    manifestBytes = await readCanonicalFile(join(directory, MANIFEST_FILENAME), "evidence manifest");
    manifest = JSON.parse(manifestBytes.toString("utf8"));
    descriptors = validateManifest(manifest, siteId, control.generation);
    const expectedFiles = new Set([MANIFEST_FILENAME, ...descriptors.map((item) => item.file)]);
    if (entries.length !== expectedFiles.size || entries.some((entry) => !expectedFiles.has(entry.name))) {
      throw new Error("unexpected or missing evidence file");
    }
  } catch {
    return decision({
      siteId,
      controlGeneration: control.generation,
      status: "BLOCKED",
      integrityOk: false,
      reason: "EVIDENCE_MANIFEST_INVALID",
    });
  }

  const datasets = {};
  try {
    for (const descriptor of descriptors) {
      const bytes = await readCanonicalFile(join(directory, descriptor.file), `dataset ${descriptor.key}`);
      if (sha256Bytes(bytes) !== descriptor.sha256) throw new Error("dataset digest mismatch");
      const parsed = JSON.parse(bytes.toString("utf8"));
      if (!Array.isArray(parsed)) throw new Error("dataset payload must be an array");
      datasets[descriptor.key] = parsed;
    }
  } catch {
    return decision({
      siteId,
      controlGeneration: control.generation,
      status: "BLOCKED",
      integrityOk: false,
      reason: "EVIDENCE_DATASET_INVALID",
    });
  }

  const controlAfterRead = await readTenantControl({ controlRoot, siteId });
  if (!controlAfterRead.authorized || controlAfterRead.generation !== control.generation) {
    return decision({
      siteId,
      controlGeneration: controlAfterRead.generation,
      status: "OFF",
      integrityOk: controlAfterRead.integrityOk,
      reason: controlAfterRead.authorized ? "STALE_CONTROL_GENERATION" : controlAfterRead.reason,
    });
  }

  const canonicalManifest = {
    schema_version: manifest.schema_version,
    site_id: manifest.site_id,
    control_generation: manifest.control_generation,
    datasets: descriptors,
  };
  return decision({
    siteId,
    controlGeneration: control.generation,
    status: "READY",
    integrityOk: true,
    reason: "READY",
    manifestHash: sha256Bytes(Buffer.from(canonicalJson(canonicalManifest), "utf8")),
    datasets,
  });
}
