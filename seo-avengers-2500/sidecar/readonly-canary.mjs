import { runTenantSidecarJob } from "./tenant-worker.mjs";
import { CANARY_SITE_ID, persistCanaryResult } from "./canary-result-store.mjs";

const SCHEMA_VERSION = 1;
const GIT_SHA_RE = /^[0-9a-f]{40}$/;

function assertGitSha(value, label) {
  if (typeof value !== "string" || !GIT_SHA_RE.test(value)) throw new Error(`invalid ${label}`);
  return value;
}

function decision({ status, reason, controlGeneration = 0, evidenceManifestHash = null, configHash = null }) {
  return Object.freeze({
    schemaVersion: SCHEMA_VERSION,
    siteId: CANARY_SITE_ID,
    status,
    reason,
    controlGeneration,
    evidenceManifestHash,
    configHash,
    persisted: false,
  });
}

export async function runReadonlyCanary({
  controlRoot,
  evidenceRoot,
  resultRoot,
  runId,
  sourceRevision,
  sourceTree,
  config = {},
  executeJob = runTenantSidecarJob,
  persistResult = persistCanaryResult,
}) {
  assertGitSha(sourceRevision, "source revision");
  assertGitSha(sourceTree, "source tree");

  let workerResult;
  try {
    workerResult = await executeJob({ controlRoot, evidenceRoot, siteId: CANARY_SITE_ID, config });
  } catch {
    return decision({ status: "BLOCKED", reason: "WORKER_FAILED" });
  }
  if (!workerResult || typeof workerResult !== "object" || Array.isArray(workerResult)) {
    return decision({ status: "BLOCKED", reason: "WORKER_RESULT_INVALID" });
  }
  if (workerResult.status !== "RELEASED") {
    return decision({
      status: typeof workerResult.status === "string" ? workerResult.status : "BLOCKED",
      reason: typeof workerResult.reason === "string" ? workerResult.reason : "WORKER_NOT_RELEASED",
      controlGeneration: Number.isSafeInteger(workerResult.controlGeneration) ? workerResult.controlGeneration : 0,
      evidenceManifestHash: workerResult.evidenceManifestHash ?? null,
      configHash: workerResult.configHash ?? null,
    });
  }

  let persisted;
  try {
    persisted = await persistResult({ resultRoot, runId, sourceRevision, sourceTree, result: workerResult });
  } catch {
    return decision({
      status: "BLOCKED",
      reason: "RESULT_PERSISTENCE_FAILED",
      controlGeneration: workerResult.controlGeneration,
      evidenceManifestHash: workerResult.evidenceManifestHash,
      configHash: workerResult.configHash,
    });
  }

  return Object.freeze({
    schemaVersion: SCHEMA_VERSION,
    siteId: CANARY_SITE_ID,
    status: "CERTIFIED",
    reason: "LOCAL_M1001_M2500_RANGE_CERTIFIED",
    controlGeneration: workerResult.controlGeneration,
    evidenceManifestHash: workerResult.evidenceManifestHash,
    configHash: workerResult.configHash,
    executionHash: workerResult.executionHash,
    terminalEvidenceHash: workerResult.terminalEvidenceHash,
    localReceiptCount: workerResult.receiptCount,
    findingCount: persisted.proof.finding_count,
    noFindingCount: persisted.proof.no_finding_count,
    proofHash: persisted.proof.proof_hash,
    resultFile: persisted.path,
    persisted: true,
  });
}
