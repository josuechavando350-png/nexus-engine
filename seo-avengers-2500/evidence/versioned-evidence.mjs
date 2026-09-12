import { createHash } from "node:crypto";
import { lstat, mkdir, open, readFile, readdir, realpath, rename, rm } from "node:fs/promises";
import { join, resolve, sep } from "node:path";

import { readTenantControl } from "../control-plane/tenant-control.mjs";

const SITE_ID_RE = /^[a-z0-9][a-z0-9-]{0,79}$/;
const SHA256_RE = /^sha256:[0-9a-f]{64}$/;
const SNAPSHOT_ID_RE = /^[0-9a-f]{64}$/;
const HEAD_SCHEMA_VERSION = 2;
const MANIFEST_SCHEMA_VERSION = 1;
const HEAD_FILENAME = "HEAD.json";
const HEAD_PENDING_FILENAME = ".HEAD.pending.json";
const SNAPSHOTS_DIRNAME = "snapshots";
const MANIFEST_FILENAME = "manifest.json";

export const VERSIONED_EVIDENCE_DATASET_KEYS = Object.freeze([
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

const ALLOWED_DATASET_SET = new Set(VERSIONED_EVIDENCE_DATASET_KEYS);

function compareStrings(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function canonicalEvidenceJson(value) {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return JSON.stringify(typeof value === "string" ? value.normalize("NFC") : value);
  }
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) throw new TypeError("evidence values must use safe integers");
    return String(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalEvidenceJson).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value)
      .map(([key, item]) => [key.normalize("NFC"), item])
      .sort(([left], [right]) => compareStrings(left, right));
    const seen = new Set();
    return `{${entries.map(([key, item]) => {
      if (seen.has(key)) throw new TypeError("normalized mapping key collision");
      seen.add(key);
      return `${JSON.stringify(key)}:${canonicalEvidenceJson(item)}`;
    }).join(",")}}`;
  }
  throw new TypeError("evidence values must be JSON-compatible");
}

function sha256Bytes(value) {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function assertSiteId(siteId) {
  if (typeof siteId !== "string" || !SITE_ID_RE.test(siteId)) throw new Error("invalid siteId");
  return siteId;
}

function assertGeneration(value) {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error("invalid control generation");
  return value;
}

function assertExactKeys(value, expected, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  if (JSON.stringify(Object.keys(value).sort()) !== JSON.stringify([...expected].sort())) {
    throw new Error(`unexpected ${label} keys`);
  }
}

function rootPath(evidenceRoot) {
  if (typeof evidenceRoot !== "string" || !evidenceRoot.trim()) throw new Error("evidenceRoot is required");
  return resolve(evidenceRoot);
}

function tenantPath(evidenceRoot, siteId) {
  const root = rootPath(evidenceRoot);
  const tenants = resolve(root, "tenants");
  const tenant = resolve(tenants, assertSiteId(siteId));
  if (!tenant.startsWith(`${tenants}${sep}`)) throw new Error("tenant evidence path escaped evidence root");
  return { root, tenants, tenant };
}

async function assertCanonicalDirectory(path, label) {
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(`${label} must be a real directory`);
  if (await realpath(path) !== resolve(path)) throw new Error(`${label} must not traverse symlinks`);
}

async function readCanonicalFile(path, label) {
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink()) throw new Error(`${label} must be a regular file`);
  if (await realpath(path) !== resolve(path)) throw new Error(`${label} must not traverse symlinks`);
  return readFile(path);
}

async function fsyncDirectory(path) {
  const handle = await open(path, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function writeExclusiveFile(path, bytes) {
  const handle = await open(path, "wx", 0o600);
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function validateDescriptors(value, siteId, controlGeneration) {
  assertExactKeys(value, ["control_generation", "datasets", "schema_version", "site_id"], "manifest");
  if (value.schema_version !== MANIFEST_SCHEMA_VERSION) throw new Error("unsupported evidence manifest schema");
  if (value.site_id !== siteId) throw new Error("cross-tenant evidence rejected");
  if (value.control_generation !== controlGeneration) throw new Error("stale evidence control generation");
  if (!Array.isArray(value.datasets)) throw new Error("manifest datasets must be an array");
  const seen = new Set();
  const descriptors = [];
  for (const item of value.datasets) {
    assertExactKeys(item, ["file", "key", "sha256"], "dataset descriptor");
    if (typeof item.key !== "string" || !ALLOWED_DATASET_SET.has(item.key)) throw new Error("unsupported dataset key");
    if (seen.has(item.key)) throw new Error("duplicate dataset key");
    seen.add(item.key);
    if (item.file !== `${item.key}.json`) throw new Error("dataset filename must match dataset key");
    if (typeof item.sha256 !== "string" || !SHA256_RE.test(item.sha256)) throw new Error("invalid dataset sha256");
    descriptors.push({ key: item.key, file: item.file, sha256: item.sha256 });
  }
  return descriptors.sort((left, right) => compareStrings(left.key, right.key));
}

function buildDecision({ siteId, controlGeneration, status, integrityOk, reason, manifestHash = null, datasets = {} }) {
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

function controlStillMatches(control, generation) {
  return control?.authorized === true && control?.integrityOk === true && control?.generation === generation;
}

function validateHead(value, siteId, generation) {
  assertExactKeys(value, ["control_generation", "manifest_sha256", "schema_version", "site_id", "snapshot_id"], "evidence head");
  if (value.schema_version !== HEAD_SCHEMA_VERSION) throw new Error("unsupported evidence head schema");
  if (value.site_id !== siteId) throw new Error("cross-tenant evidence head rejected");
  if (value.control_generation !== generation) throw new Error("stale evidence head generation");
  if (typeof value.snapshot_id !== "string" || !SNAPSHOT_ID_RE.test(value.snapshot_id)) throw new Error("invalid evidence snapshot id");
  if (typeof value.manifest_sha256 !== "string" || !SHA256_RE.test(value.manifest_sha256)) throw new Error("invalid manifest hash");
  if (`sha256:${value.snapshot_id}` !== value.manifest_sha256) throw new Error("snapshot id does not bind manifest hash");
  return value;
}

export async function readVersionedEvidenceSnapshot({ controlRoot, evidenceRoot, siteId, authorizedControl = null }) {
  const control = authorizedControl ?? await readTenantControl({ controlRoot, siteId });
  if (!control.authorized) return null;

  let paths;
  let tenantEntries;
  try {
    paths = tenantPath(evidenceRoot, siteId);
    await assertCanonicalDirectory(paths.root, "evidenceRoot");
    await assertCanonicalDirectory(paths.tenants, "evidence tenants root");
    try {
      await assertCanonicalDirectory(paths.tenant, "tenant evidence directory");
    } catch (error) {
      if (error?.code === "ENOENT") return null;
      throw error;
    }
    tenantEntries = await readdir(paths.tenant, { withFileTypes: true });
  } catch {
    return buildDecision({
      siteId,
      controlGeneration: control.generation,
      status: "BLOCKED",
      integrityOk: false,
      reason: "VERSIONED_EVIDENCE_ROOT_UNSAFE_OR_UNREADABLE",
    });
  }

  const names = new Set(tenantEntries.map((entry) => entry.name));
  const hasHead = names.has(HEAD_FILENAME);
  const hasSnapshots = names.has(SNAPSHOTS_DIRNAME);
  const hasPending = names.has(HEAD_PENDING_FILENAME);
  if (!hasHead && !hasSnapshots && !hasPending) return null;
  if (hasPending) {
    return buildDecision({
      siteId,
      controlGeneration: control.generation,
      status: "BLOCKED",
      integrityOk: false,
      reason: "EVIDENCE_PUBLICATION_INCOMPLETE",
    });
  }
  if (!hasHead || !hasSnapshots || names.size !== 2) {
    return buildDecision({
      siteId,
      controlGeneration: control.generation,
      status: "BLOCKED",
      integrityOk: false,
      reason: "VERSIONED_EVIDENCE_LAYOUT_INVALID",
    });
  }

  let headBytes;
  let head;
  let snapshotDirectory;
  let descriptors;
  let manifestHash;
  let datasets = {};
  try {
    const headEntry = tenantEntries.find((entry) => entry.name === HEAD_FILENAME);
    const snapshotsEntry = tenantEntries.find((entry) => entry.name === SNAPSHOTS_DIRNAME);
    if (!headEntry?.isFile() || !snapshotsEntry?.isDirectory()) throw new Error("invalid versioned evidence entry type");
    headBytes = await readCanonicalFile(join(paths.tenant, HEAD_FILENAME), "evidence head");
    head = validateHead(JSON.parse(headBytes.toString("utf8")), siteId, control.generation);

    const snapshotsDirectory = join(paths.tenant, SNAPSHOTS_DIRNAME);
    await assertCanonicalDirectory(snapshotsDirectory, "evidence snapshots directory");
    snapshotDirectory = resolve(snapshotsDirectory, head.snapshot_id);
    if (!snapshotDirectory.startsWith(`${resolve(snapshotsDirectory)}${sep}`)) throw new Error("snapshot path escaped snapshots root");
    await assertCanonicalDirectory(snapshotDirectory, "evidence snapshot directory");

    const snapshotEntries = await readdir(snapshotDirectory, { withFileTypes: true });
    if (!snapshotEntries.length || snapshotEntries.some((entry) => !entry.isFile())) throw new Error("snapshot contains non-file entries");
    const manifestEntry = snapshotEntries.find((entry) => entry.name === MANIFEST_FILENAME);
    if (!manifestEntry) throw new Error("snapshot manifest missing");
    const manifestBytes = await readCanonicalFile(join(snapshotDirectory, MANIFEST_FILENAME), "snapshot manifest");
    const manifest = JSON.parse(manifestBytes.toString("utf8"));
    descriptors = validateDescriptors(manifest, siteId, control.generation);
    const canonicalManifestBytes = Buffer.from(canonicalEvidenceJson({
      schema_version: manifest.schema_version,
      site_id: manifest.site_id,
      control_generation: manifest.control_generation,
      datasets: descriptors,
    }), "utf8");
    manifestHash = sha256Bytes(canonicalManifestBytes);
    if (manifestHash !== head.manifest_sha256) throw new Error("manifest hash does not match evidence head");

    const expectedFiles = new Set([MANIFEST_FILENAME, ...descriptors.map((item) => item.file)]);
    if (snapshotEntries.length !== expectedFiles.size || snapshotEntries.some((entry) => !expectedFiles.has(entry.name))) {
      throw new Error("unexpected or missing snapshot file");
    }
    for (const descriptor of descriptors) {
      const bytes = await readCanonicalFile(join(snapshotDirectory, descriptor.file), `dataset ${descriptor.key}`);
      if (sha256Bytes(bytes) !== descriptor.sha256) throw new Error("dataset digest mismatch");
      const parsed = JSON.parse(bytes.toString("utf8"));
      if (!Array.isArray(parsed)) throw new Error("dataset payload must be an array");
      canonicalEvidenceJson(parsed);
      datasets[descriptor.key] = parsed;
    }
  } catch {
    return buildDecision({
      siteId,
      controlGeneration: control.generation,
      status: "BLOCKED",
      integrityOk: false,
      reason: "VERSIONED_EVIDENCE_INTEGRITY_FAILURE",
    });
  }

  const controlAfterRead = await readTenantControl({ controlRoot, siteId });
  if (!controlStillMatches(controlAfterRead, control.generation)) {
    return buildDecision({
      siteId,
      controlGeneration: controlAfterRead.generation,
      status: "OFF",
      integrityOk: controlAfterRead.integrityOk,
      reason: controlAfterRead.authorized ? "STALE_CONTROL_GENERATION" : controlAfterRead.reason,
    });
  }

  try {
    const headAfter = await readCanonicalFile(join(paths.tenant, HEAD_FILENAME), "evidence head");
    if (sha256Bytes(headAfter) !== sha256Bytes(headBytes)) throw new Error("evidence head changed during read");
  } catch {
    return buildDecision({
      siteId,
      controlGeneration: control.generation,
      status: "BLOCKED",
      integrityOk: false,
      reason: "EVIDENCE_HEAD_CHANGED_DURING_READ",
    });
  }

  return buildDecision({
    siteId,
    controlGeneration: control.generation,
    status: "READY",
    integrityOk: true,
    reason: "READY",
    manifestHash,
    datasets,
  });
}

export async function publishVersionedEvidenceSnapshot({ evidenceRoot, siteId, controlGeneration, datasets }) {
  assertSiteId(siteId);
  assertGeneration(controlGeneration);
  if (!datasets || typeof datasets !== "object" || Array.isArray(datasets)) throw new TypeError("datasets must be an object");

  const datasetKeys = Object.keys(datasets).sort(compareStrings);
  for (const key of datasetKeys) {
    if (!ALLOWED_DATASET_SET.has(key)) throw new Error(`unsupported dataset key:${key}`);
    if (!Array.isArray(datasets[key])) throw new TypeError(`dataset ${key} must be an array`);
  }

  const paths = tenantPath(evidenceRoot, siteId);
  await assertCanonicalDirectory(paths.root, "evidenceRoot");
  await assertCanonicalDirectory(paths.tenants, "evidence tenants root");
  try {
    await mkdir(paths.tenant, { mode: 0o700 });
    await fsyncDirectory(paths.tenants);
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
  }
  await assertCanonicalDirectory(paths.tenant, "tenant evidence directory");

  const snapshotsDirectory = join(paths.tenant, SNAPSHOTS_DIRNAME);
  try {
    await mkdir(snapshotsDirectory, { mode: 0o700 });
    await fsyncDirectory(paths.tenant);
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
  }
  await assertCanonicalDirectory(snapshotsDirectory, "evidence snapshots directory");

  const descriptors = [];
  const encodedDatasets = new Map();
  for (const key of datasetKeys) {
    const bytes = Buffer.from(`${canonicalEvidenceJson(datasets[key])}\n`, "utf8");
    encodedDatasets.set(key, bytes);
    descriptors.push({ key, file: `${key}.json`, sha256: sha256Bytes(bytes) });
  }
  const manifest = {
    schema_version: MANIFEST_SCHEMA_VERSION,
    site_id: siteId,
    control_generation: controlGeneration,
    datasets: descriptors,
  };
  const manifestCanonical = Buffer.from(canonicalEvidenceJson(manifest), "utf8");
  const manifestHash = sha256Bytes(manifestCanonical);
  const snapshotId = manifestHash.slice("sha256:".length);
  const snapshotDirectory = join(snapshotsDirectory, snapshotId);
  const pendingSnapshotDirectory = join(snapshotsDirectory, `.pending-${snapshotId}`);

  let snapshotExists = false;
  try {
    await assertCanonicalDirectory(snapshotDirectory, "existing evidence snapshot directory");
    snapshotExists = true;
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }

  if (!snapshotExists) {
    await mkdir(pendingSnapshotDirectory, { mode: 0o700 });
    try {
      for (const descriptor of descriptors) {
        await writeExclusiveFile(join(pendingSnapshotDirectory, descriptor.file), encodedDatasets.get(descriptor.key));
      }
      await writeExclusiveFile(join(pendingSnapshotDirectory, MANIFEST_FILENAME), Buffer.from(`${canonicalEvidenceJson(manifest)}\n`, "utf8"));
      await fsyncDirectory(pendingSnapshotDirectory);
      await rename(pendingSnapshotDirectory, snapshotDirectory);
      await fsyncDirectory(snapshotsDirectory);
    } catch (error) {
      await rm(pendingSnapshotDirectory, { recursive: true, force: true });
      throw error;
    }
  }

  const head = {
    schema_version: HEAD_SCHEMA_VERSION,
    site_id: siteId,
    control_generation: controlGeneration,
    snapshot_id: snapshotId,
    manifest_sha256: manifestHash,
  };
  const pendingHeadPath = join(paths.tenant, HEAD_PENDING_FILENAME);
  const headPath = join(paths.tenant, HEAD_FILENAME);
  await writeExclusiveFile(pendingHeadPath, Buffer.from(`${canonicalEvidenceJson(head)}\n`, "utf8"));
  try {
    await rename(pendingHeadPath, headPath);
    await fsyncDirectory(paths.tenant);
  } catch (error) {
    await rm(pendingHeadPath, { force: true });
    throw error;
  }

  return Object.freeze({
    siteId,
    controlGeneration,
    snapshotId,
    manifestHash,
    datasetKeys: Object.freeze(datasetKeys),
  });
}
