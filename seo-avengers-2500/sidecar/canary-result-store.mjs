import { createHash } from "node:crypto";
import { lstat, mkdir, open, readFile, realpath } from "node:fs/promises";
import { join, resolve, sep } from "node:path";

export const CANARY_SITE_ID = "walle-production-canary";

const SCHEMA_VERSION = 1;
const PROOF_KIND = "WALLE_SEO_AVENGERS_2500_READONLY_CANARY";
const LOCAL_RECEIPT_COUNT = 1500;
const SHA256_RE = /^sha256:[0-9a-f]{64}$/;
const GIT_SHA_RE = /^[0-9a-f]{40}$/;
const RUN_ID_RE = /^canary-[a-z0-9][a-z0-9-]{0,62}$/;

function compareStrings(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function canonicalJson(value) {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return JSON.stringify(typeof value === "string" ? value.normalize("NFC") : value);
  }
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) throw new TypeError("canary values must use safe integers");
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
  throw new TypeError("canary values must be JSON-compatible");
}

function hashJson(value) {
  return `sha256:${createHash("sha256").update(canonicalJson(value), "utf8").digest("hex")}`;
}

function assertRunId(runId) {
  if (typeof runId !== "string" || !RUN_ID_RE.test(runId)) throw new Error("invalid canary runId");
  return runId;
}

function assertGitSha(value, label) {
  if (typeof value !== "string" || !GIT_SHA_RE.test(value)) throw new Error(`invalid ${label}`);
  return value;
}

function assertSha256(value, label) {
  if (typeof value !== "string" || !SHA256_RE.test(value)) throw new Error(`invalid ${label}`);
  return value;
}

function resultRootPath(resultRoot) {
  if (typeof resultRoot !== "string" || !resultRoot.trim()) throw new Error("resultRoot is required");
  return resolve(resultRoot);
}

async function syncDirectory(directory) {
  const handle = await open(directory, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function assertCanonicalDirectory(directory, label) {
  const info = await lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(`${label} must be a real directory`);
  const actual = await realpath(directory);
  if (actual !== resolve(directory)) throw new Error(`${label} must not traverse symlinks`);
}

async function ensureChildDirectory(parent, name, label) {
  const child = resolve(parent, name);
  const requiredPrefix = `${resolve(parent)}${sep}`;
  if (!child.startsWith(requiredPrefix)) throw new Error(`${label} escaped parent`);
  let created = false;
  try {
    await mkdir(child, { mode: 0o700 });
    created = true;
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
  }
  await assertCanonicalDirectory(child, label);
  if (created) await syncDirectory(parent);
  return child;
}

function validateReleasedResult(result) {
  if (!result || typeof result !== "object" || Array.isArray(result)) throw new Error("released result must be an object");
  if (result.siteId !== CANARY_SITE_ID) throw new Error("canary result site mismatch");
  if (result.status !== "RELEASED" || result.reason !== "RELEASED") throw new Error("canary result is not released");
  if (!Number.isSafeInteger(result.controlGeneration) || result.controlGeneration < 1) throw new Error("invalid control generation");
  assertSha256(result.evidenceManifestHash, "evidence manifest hash");
  assertSha256(result.configHash, "config hash");
  assertSha256(result.executionHash, "execution hash");
  assertSha256(result.terminalEvidenceHash, "terminal evidence hash");
  if (result.receiptCount !== LOCAL_RECEIPT_COUNT) throw new Error("unexpected local receipt count");
  if (!result.receipts || typeof result.receipts !== "object" || Array.isArray(result.receipts)) throw new Error("receipts must be an object");

  const keys = Object.keys(result.receipts);
  if (keys.length !== LOCAL_RECEIPT_COUNT) throw new Error("receipt cardinality mismatch");
  let findingCount = 0;
  let noFindingCount = 0;
  for (let number = 1001; number <= 2500; number += 1) {
    const moduleId = `M${number}`;
    const receipt = result.receipts[moduleId];
    if (!receipt || typeof receipt !== "object" || Array.isArray(receipt)) throw new Error(`missing receipt ${moduleId}`);
    if (receipt.module !== moduleId) throw new Error(`receipt module mismatch ${moduleId}`);
    if (receipt.execution_status !== "SUCCESS") throw new Error(`canary requires complete evidence ${moduleId}`);
    if (receipt.policy_status !== "SAFE_WHITE_HAT" || receipt.action_mode !== "OBSERVE_ONLY") {
      throw new Error(`unsafe receipt policy ${moduleId}`);
    }
    assertSha256(receipt.evidence_hash, `receipt evidence hash ${moduleId}`);
    if (receipt.finding_status === "FINDING") findingCount += 1;
    else if (receipt.finding_status === "NO_FINDING") noFindingCount += 1;
    else throw new Error(`unexpected finding status ${moduleId}`);
  }

  const terminal = result.receipts.M2500;
  if (terminal.finding_status !== "NO_FINDING") throw new Error("terminal M2500 finding blocks canary");
  if (!terminal.output || terminal.output.release_safe !== true || terminal.output.suite !== "SEO_AVENGERS_2500") {
    throw new Error("terminal M2500 release-safe contract missing");
  }
  if (terminal.output.strict_white_hat_only !== true || terminal.output.no_google_scraping !== true) {
    throw new Error("terminal M2500 white-hat contract missing");
  }
  if (terminal.evidence_hash !== result.terminalEvidenceHash) throw new Error("terminal evidence hash mismatch");
  return { findingCount, noFindingCount };
}

function buildProof({ runId, sourceRevision, sourceTree, result }) {
  assertRunId(runId);
  assertGitSha(sourceRevision, "source revision");
  assertGitSha(sourceTree, "source tree");
  const { findingCount, noFindingCount } = validateReleasedResult(result);
  const releasedResultHash = hashJson(result);
  const core = {
    schema_version: SCHEMA_VERSION,
    proof_kind: PROOF_KIND,
    run_id: runId,
    site_id: CANARY_SITE_ID,
    source_revision: sourceRevision,
    source_tree: sourceTree,
    control_generation: result.controlGeneration,
    evidence_manifest_hash: result.evidenceManifestHash,
    config_hash: result.configHash,
    execution_hash: result.executionHash,
    terminal_evidence_hash: result.terminalEvidenceHash,
    receipt_count: result.receiptCount,
    finding_count: findingCount,
    no_finding_count: noFindingCount,
    released_result_hash: releasedResultHash,
  };
  return Object.freeze({ ...core, proof_hash: hashJson(core), result });
}

function validateStoredProof(proof) {
  if (!proof || typeof proof !== "object" || Array.isArray(proof)) throw new Error("canary proof must be an object");
  const expectedKeys = [
    "config_hash", "control_generation", "evidence_manifest_hash", "execution_hash", "finding_count",
    "no_finding_count", "proof_hash", "proof_kind", "receipt_count", "released_result_hash", "result",
    "run_id", "schema_version", "site_id", "source_revision", "source_tree", "terminal_evidence_hash",
  ];
  if (JSON.stringify(Object.keys(proof).sort()) !== JSON.stringify(expectedKeys.sort())) throw new Error("unexpected canary proof keys");
  if (proof.schema_version !== SCHEMA_VERSION || proof.proof_kind !== PROOF_KIND || proof.site_id !== CANARY_SITE_ID) {
    throw new Error("canary proof identity mismatch");
  }
  assertRunId(proof.run_id);
  assertGitSha(proof.source_revision, "source revision");
  assertGitSha(proof.source_tree, "source tree");
  assertSha256(proof.proof_hash, "proof hash");
  assertSha256(proof.released_result_hash, "released result hash");
  const { findingCount, noFindingCount } = validateReleasedResult(proof.result);
  if (proof.control_generation !== proof.result.controlGeneration || proof.receipt_count !== proof.result.receiptCount) {
    throw new Error("canary proof result binding mismatch");
  }
  if (proof.evidence_manifest_hash !== proof.result.evidenceManifestHash || proof.config_hash !== proof.result.configHash) {
    throw new Error("canary proof input binding mismatch");
  }
  if (proof.execution_hash !== proof.result.executionHash || proof.terminal_evidence_hash !== proof.result.terminalEvidenceHash) {
    throw new Error("canary proof execution binding mismatch");
  }
  if (proof.finding_count !== findingCount || proof.no_finding_count !== noFindingCount) {
    throw new Error("canary proof finding counts mismatch");
  }
  if (hashJson(proof.result) !== proof.released_result_hash) throw new Error("released result hash mismatch");
  const core = { ...proof };
  delete core.proof_hash;
  delete core.result;
  if (hashJson(core) !== proof.proof_hash) throw new Error("canary proof hash mismatch");
  return proof;
}

function proofPath(siteDirectory, runId) {
  return join(siteDirectory, `${assertRunId(runId)}.json`);
}

export async function persistCanaryResult({ resultRoot, runId, sourceRevision, sourceTree, result }) {
  const root = resultRootPath(resultRoot);
  await assertCanonicalDirectory(root, "resultRoot");
  const namespace = await ensureChildDirectory(root, "canary-results", "canary result namespace");
  const siteDirectory = await ensureChildDirectory(namespace, CANARY_SITE_ID, "canary site result directory");
  const proof = buildProof({ runId, sourceRevision, sourceTree, result });
  const destination = proofPath(siteDirectory, runId);
  const handle = await open(destination, "wx", 0o600);
  try {
    await handle.writeFile(`${canonicalJson(proof)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  await syncDirectory(siteDirectory);
  return Object.freeze({ path: destination, proof });
}

export async function readCanaryResult({ resultRoot, runId }) {
  const root = resultRootPath(resultRoot);
  await assertCanonicalDirectory(root, "resultRoot");
  const namespace = resolve(root, "canary-results");
  await assertCanonicalDirectory(namespace, "canary result namespace");
  const siteDirectory = resolve(namespace, CANARY_SITE_ID);
  await assertCanonicalDirectory(siteDirectory, "canary site result directory");
  const path = proofPath(siteDirectory, runId);
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink()) throw new Error("canary proof must be a regular file");
  if (await realpath(path) !== resolve(path)) throw new Error("canary proof must not traverse symlinks");
  return validateStoredProof(JSON.parse(await readFile(path, "utf8")));
}
