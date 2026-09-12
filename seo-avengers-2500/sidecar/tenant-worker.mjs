import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { readTenantControl } from "../control-plane/tenant-control.mjs";
import { readTenantEvidenceSnapshot } from "../evidence/tenant-evidence.mjs";

const SHA256_RE = /^sha256:[0-9a-f]{64}$/;
const LOCAL_RECEIPT_COUNT = 1500;
const FIRST_MODULE = "M1001";
const LAST_MODULE = "M2500";
const WORKER_SCHEMA_VERSION = 1;
const SUITE_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

function compareStrings(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function canonicalJson(value) {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return JSON.stringify(typeof value === "string" ? value.normalize("NFC") : value);
  }
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) throw new TypeError("sidecar values must use safe integers");
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
  throw new TypeError("sidecar values must be JSON-compatible");
}

function hashJson(value) {
  return `sha256:${createHash("sha256").update(canonicalJson(value), "utf8").digest("hex")}`;
}

function decision({ siteId, status, reason, controlGeneration = 0, evidenceManifestHash = null, configHash = null, extra = {} }) {
  return Object.freeze({
    schemaVersion: WORKER_SCHEMA_VERSION,
    siteId: typeof siteId === "string" ? siteId : "",
    status,
    reason,
    controlGeneration,
    evidenceManifestHash,
    configHash,
    ...extra,
  });
}

function controlStillMatches(control, generation) {
  return control.authorized === true && control.integrityOk === true && control.generation === generation;
}

function inspectExecutionEnvelope(execution) {
  if (!execution || typeof execution !== "object" || Array.isArray(execution)) {
    throw new Error("suite execution result must be an object");
  }
  if (execution.schema_version !== 1) throw new Error("unsupported suite execution schema");
  if (execution.receipt_count !== LOCAL_RECEIPT_COUNT) throw new Error("unexpected local receipt count");
  if (execution.first_module !== FIRST_MODULE || execution.last_module !== LAST_MODULE) {
    throw new Error("unexpected local receipt range");
  }
  if (!SHA256_RE.test(execution.execution_hash ?? "")) throw new Error("invalid execution hash");
  if (!SHA256_RE.test(execution.terminal_evidence_hash ?? "")) throw new Error("invalid terminal evidence hash");
  const receipts = execution.receipts;
  if (!receipts || typeof receipts !== "object" || Array.isArray(receipts)) throw new Error("receipts must be an object");
  const keys = Object.keys(receipts);
  if (keys.length !== LOCAL_RECEIPT_COUNT) throw new Error("receipt range cardinality mismatch");

  const allowedExecutionStatuses = new Set(["SUCCESS", "INSUFFICIENT_DATA", "ERROR"]);
  const allowedFindingStatuses = new Set(["FINDING", "NO_FINDING", "NOT_APPLICABLE"]);
  const executionStatusCounts = { SUCCESS: 0, INSUFFICIENT_DATA: 0, ERROR: 0 };
  const findingStatusCounts = { FINDING: 0, NO_FINDING: 0, NOT_APPLICABLE: 0 };

  for (let number = 1001; number <= 2500; number += 1) {
    const moduleId = `M${number}`;
    const receipt = receipts[moduleId];
    if (!receipt || typeof receipt !== "object" || Array.isArray(receipt)) throw new Error(`missing receipt ${moduleId}`);
    if (receipt.module !== moduleId) throw new Error(`receipt module mismatch ${moduleId}`);
    if (receipt.policy_status !== "SAFE_WHITE_HAT" || receipt.action_mode !== "OBSERVE_ONLY") {
      throw new Error(`unsafe receipt policy ${moduleId}`);
    }
    if (!SHA256_RE.test(receipt.evidence_hash ?? "")) throw new Error(`invalid receipt evidence hash ${moduleId}`);
    if (!allowedExecutionStatuses.has(receipt.execution_status)) throw new Error(`invalid execution status ${moduleId}`);
    if (!allowedFindingStatuses.has(receipt.finding_status)) throw new Error(`invalid finding status ${moduleId}`);
    executionStatusCounts[receipt.execution_status] += 1;
    findingStatusCounts[receipt.finding_status] += 1;
  }

  const terminal = receipts[LAST_MODULE];
  if (terminal.evidence_hash !== execution.terminal_evidence_hash) {
    throw new Error("terminal evidence hash mismatch");
  }
  const terminalStatus = Object.freeze({
    executionStatus: terminal.execution_status,
    findingStatus: terminal.finding_status,
    releaseSafe: terminal.output?.release_safe === true,
    suite: typeof terminal.output?.suite === "string" ? terminal.output.suite : null,
  });
  const releaseSafe = (
    terminalStatus.executionStatus === "SUCCESS"
    && terminalStatus.findingStatus === "NO_FINDING"
    && terminalStatus.releaseSafe === true
    && terminalStatus.suite === "SEO_AVENGERS_2500"
  );

  return Object.freeze({
    execution,
    executionStatusCounts: Object.freeze({ ...executionStatusCounts }),
    findingStatusCounts: Object.freeze({ ...findingStatusCounts }),
    terminalStatus,
    releaseSafe,
  });
}

function executionSummary(inspection) {
  return Object.freeze({
    executionHash: inspection.execution.execution_hash,
    terminalEvidenceHash: inspection.execution.terminal_evidence_hash,
    receiptCount: inspection.execution.receipt_count,
    executionStatusCounts: inspection.executionStatusCounts,
    findingStatusCounts: inspection.findingStatusCounts,
    terminalStatus: inspection.terminalStatus,
    receiptsSuppressed: true,
  });
}

export async function executeSuiteWithPython({ payload, config, pythonBin = "python", timeoutMs = 120000, maxOutputBytes = 64 * 1024 * 1024 }) {
  if (typeof pythonBin !== "string" || !pythonBin.trim()) throw new TypeError("pythonBin is required");
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) throw new TypeError("timeoutMs must be a positive integer");
  if (!Number.isSafeInteger(maxOutputBytes) || maxOutputBytes < 1024) throw new TypeError("maxOutputBytes must be an integer >= 1024");

  const request = JSON.stringify({ schema_version: 1, payload, config });
  return new Promise((resolve, reject) => {
    const child = spawn(pythonBin, ["-m", "sidecar.execute_suite"], {
      cwd: SUITE_ROOT,
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const stdout = [];
    const stderr = [];
    let outputBytes = 0;
    let stderrBytes = 0;
    let settled = false;

    const finish = (callback) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      callback();
    };

    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(() => reject(new Error("suite execution timed out")));
    }, timeoutMs);

    child.on("error", (error) => finish(() => reject(error)));
    child.stdout.on("data", (chunk) => {
      outputBytes += chunk.length;
      if (outputBytes > maxOutputBytes) {
        child.kill("SIGKILL");
        finish(() => reject(new Error("suite execution output exceeded limit")));
        return;
      }
      stdout.push(chunk);
    });
    child.stderr.on("data", (chunk) => {
      if (stderrBytes >= 65536) return;
      const remaining = 65536 - stderrBytes;
      const captured = chunk.subarray(0, remaining);
      stderr.push(captured);
      stderrBytes += captured.length;
    });
    child.on("close", (code) => finish(() => {
      const errorText = Buffer.concat(stderr).toString("utf8").trim();
      if (code !== 0) {
        reject(new Error(`suite execution failed${errorText ? `: ${errorText}` : ""}`));
        return;
      }
      try {
        resolve(JSON.parse(Buffer.concat(stdout).toString("utf8")));
      } catch {
        reject(new Error("suite execution returned invalid JSON"));
      }
    }));

    child.stdin.on("error", (error) => finish(() => reject(error)));
    child.stdin.end(request);
  });
}

export async function runTenantSidecarJob({ controlRoot, evidenceRoot, siteId, config = {}, executeSuite = executeSuiteWithPython }) {
  let configHash;
  try {
    configHash = hashJson(config);
  } catch {
    return decision({ siteId, status: "BLOCKED", reason: "CONFIG_INVALID" });
  }

  const snapshot = await readTenantEvidenceSnapshot({ controlRoot, evidenceRoot, siteId });
  if (snapshot.status !== "READY") {
    return decision({
      siteId,
      status: snapshot.status,
      reason: snapshot.reason,
      controlGeneration: snapshot.controlGeneration,
      evidenceManifestHash: snapshot.manifestHash,
      configHash,
    });
  }

  const generation = snapshot.controlGeneration;
  const preExecutionControl = await readTenantControl({ controlRoot, siteId });
  if (!controlStillMatches(preExecutionControl, generation)) {
    return decision({
      siteId,
      status: "OFF",
      reason: preExecutionControl.authorized ? "STALE_CONTROL_GENERATION" : preExecutionControl.reason,
      controlGeneration: preExecutionControl.generation,
      evidenceManifestHash: snapshot.manifestHash,
      configHash,
    });
  }

  let inspection;
  try {
    inspection = inspectExecutionEnvelope(await executeSuite({ payload: snapshot.datasets, config }));
  } catch {
    return decision({
      siteId,
      status: "BLOCKED",
      reason: "SUITE_EXECUTION_FAILED",
      controlGeneration: generation,
      evidenceManifestHash: snapshot.manifestHash,
      configHash,
    });
  }

  const postExecutionControl = await readTenantControl({ controlRoot, siteId });
  if (!controlStillMatches(postExecutionControl, generation)) {
    return decision({
      siteId,
      status: "OFF",
      reason: postExecutionControl.authorized ? "STALE_CONTROL_GENERATION" : postExecutionControl.reason,
      controlGeneration: postExecutionControl.generation,
      evidenceManifestHash: snapshot.manifestHash,
      configHash,
    });
  }

  const evidenceAfterExecution = await readTenantEvidenceSnapshot({ controlRoot, evidenceRoot, siteId });
  if (evidenceAfterExecution.status !== "READY") {
    const postEvidenceStatus = evidenceAfterExecution.status === "OFF"
      ? "OFF"
      : evidenceAfterExecution.status === "INSUFFICIENT_DATA"
        ? "STALE"
        : "BLOCKED";
    return decision({
      siteId,
      status: postEvidenceStatus,
      reason: evidenceAfterExecution.reason,
      controlGeneration: evidenceAfterExecution.controlGeneration,
      evidenceManifestHash: snapshot.manifestHash,
      configHash,
    });
  }
  if (evidenceAfterExecution.controlGeneration !== generation || evidenceAfterExecution.manifestHash !== snapshot.manifestHash) {
    return decision({
      siteId,
      status: "STALE",
      reason: "EVIDENCE_CHANGED_DURING_EXECUTION",
      controlGeneration: evidenceAfterExecution.controlGeneration,
      evidenceManifestHash: snapshot.manifestHash,
      configHash,
    });
  }

  const finalControl = await readTenantControl({ controlRoot, siteId });
  if (!controlStillMatches(finalControl, generation)) {
    return decision({
      siteId,
      status: "OFF",
      reason: finalControl.authorized ? "STALE_CONTROL_GENERATION" : finalControl.reason,
      controlGeneration: finalControl.generation,
      evidenceManifestHash: snapshot.manifestHash,
      configHash,
    });
  }

  if (inspection.executionStatusCounts.ERROR > 0) {
    return decision({
      siteId,
      status: "BLOCKED",
      reason: "SUITE_EXECUTION_FAILED",
      controlGeneration: generation,
      evidenceManifestHash: snapshot.manifestHash,
      configHash,
      extra: executionSummary(inspection),
    });
  }

  if (!inspection.releaseSafe) {
    return decision({
      siteId,
      status: "BLOCKED",
      reason: "SUITE_NOT_RELEASE_SAFE",
      controlGeneration: generation,
      evidenceManifestHash: snapshot.manifestHash,
      configHash,
      extra: executionSummary(inspection),
    });
  }

  const execution = inspection.execution;
  return Object.freeze({
    schemaVersion: WORKER_SCHEMA_VERSION,
    siteId,
    status: "RELEASED",
    reason: "RELEASED",
    controlGeneration: generation,
    evidenceManifestHash: snapshot.manifestHash,
    configHash,
    executionHash: execution.execution_hash,
    terminalEvidenceHash: execution.terminal_evidence_hash,
    receiptCount: execution.receipt_count,
    executionStatusCounts: inspection.executionStatusCounts,
    findingStatusCounts: inspection.findingStatusCounts,
    terminalStatus: inspection.terminalStatus,
    receipts: Object.freeze(execution.receipts),
  });
}
