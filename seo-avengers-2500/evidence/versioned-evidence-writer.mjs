import { createHash } from "node:crypto";
import { lstat, mkdir, open, readFile, readdir, realpath, rename, rm } from "node:fs/promises";
import { join, resolve, sep } from "node:path";

const SITE_ID_RE = /^[a-z0-9][a-z0-9-]{0,79}$/;
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

async function verifyExistingSnapshot({ snapshotDirectory, manifest, descriptors, encodedDatasets }) {
  await assertCanonicalDirectory(snapshotDirectory, "existing evidence snapshot directory");
  const entries = await readdir(snapshotDirectory, { withFileTypes: true });
  const expectedFiles = new Set([MANIFEST_FILENAME, ...descriptors.map((item) => item.file)]);
  if (entries.length !== expectedFiles.size || entries.some((entry) => !entry.isFile() || !expectedFiles.has(entry.name))) {
    throw new Error("existing snapshot layout mismatch");
  }
  const manifestBytes = await readCanonicalFile(join(snapshotDirectory, MANIFEST_FILENAME), "existing snapshot manifest");
  const parsedManifest = JSON.parse(manifestBytes.toString("utf8"));
  if (canonicalEvidenceJson(parsedManifest) !== canonicalEvidenceJson(manifest)) {
    throw new Error("existing snapshot manifest mismatch");
  }
  for (const descriptor of descriptors) {
    const bytes = await readCanonicalFile(join(snapshotDirectory, descriptor.file), `existing dataset ${descriptor.key}`);
    if (sha256Bytes(bytes) !== descriptor.sha256 || !bytes.equals(encodedDatasets.get(descriptor.key))) {
      throw new Error(`existing snapshot dataset mismatch:${descriptor.key}`);
    }
  }
}

export async function publishVersionedEvidenceSnapshot({ evidenceRoot, siteId, controlGeneration, datasets }) {
  assertSiteId(siteId);
  assertGeneration(controlGeneration);
  if (!datasets || typeof datasets !== "object" || Array.isArray(datasets)) throw new TypeError("datasets must be an object");

  const datasetKeys = Object.keys(datasets).sort(compareStrings);
  if (datasetKeys.length === 0) throw new Error("at least one evidence dataset is required");
  for (const key of datasetKeys) {
    if (!ALLOWED_DATASET_SET.has(key)) throw new Error(`unsupported dataset key:${key}`);
    if (!Array.isArray(datasets[key])) throw new TypeError(`dataset ${key} must be an array`);
    canonicalEvidenceJson(datasets[key]);
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

  const initialEntries = await readdir(paths.tenant, { withFileTypes: true });
  const allowedExisting = new Set([HEAD_FILENAME, SNAPSHOTS_DIRNAME]);
  if (initialEntries.some((entry) => !allowedExisting.has(entry.name))) {
    throw new Error("tenant evidence directory contains incompatible or incomplete publication state");
  }
  const existingHead = initialEntries.find((entry) => entry.name === HEAD_FILENAME);
  if (existingHead && !existingHead.isFile()) throw new Error("existing evidence HEAD must be a regular file");
  const existingSnapshots = initialEntries.find((entry) => entry.name === SNAPSHOTS_DIRNAME);
  if (existingSnapshots && !existingSnapshots.isDirectory()) throw new Error("existing snapshots entry must be a directory");

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
  const manifestHash = sha256Bytes(Buffer.from(canonicalEvidenceJson(manifest), "utf8"));
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

  if (snapshotExists) {
    await verifyExistingSnapshot({ snapshotDirectory, manifest, descriptors, encodedDatasets });
  } else {
    await mkdir(pendingSnapshotDirectory, { mode: 0o700 });
    try {
      for (const descriptor of descriptors) {
        await writeExclusiveFile(join(pendingSnapshotDirectory, descriptor.file), encodedDatasets.get(descriptor.key));
      }
      await writeExclusiveFile(
        join(pendingSnapshotDirectory, MANIFEST_FILENAME),
        Buffer.from(`${canonicalEvidenceJson(manifest)}\n`, "utf8"),
      );
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
