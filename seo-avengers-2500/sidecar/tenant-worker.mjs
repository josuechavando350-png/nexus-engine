import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { readTenantControl } from "../control-plane/tenant-control.mjs";
import { readTenantEvidenceSnapshot } from "../evidence/tenant-evidence.mjs";

const SHA256_RE = /^sha256:[0-9a-f]{64}$/;
const LOCAL_RECEIPT_COUNT = 1500;
const FIRST_MODULE = "M1001";
const LAST_MODULE = "M2500";
const WORKER_SCHEMA_VERSION = 1;
const BRIDGE_PATH = fileURLToPath(new URL("./execute_suite.py", import.meta.url));
const SUITE_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

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
      .sort(([left], [right]) => left.localeCompare(right));
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

function decision({ siteId, status, reason, controlGeneration = 0, evidenceManifestHash = null, configHash = null }) {
  return Object.freeze({
    schemaVersion: WORKER_SCHEMA_VERSION,
    siteId: typeof siteId === "string" ? siteId : "",
    status,
    reason,
    controlGeneration,
    evidenceManifestHash,
    configHash,
  });
}

function controlStillMatches(control, generation) {
  return control.authorized === true && control.integrityOk === true && control.generation === generation;
}

function validateExecutionEnvelope(execution) {
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
  for (let number = 1001; number <= 2500; number += 1) {
    const moduleId = `M${number}`;
    const receipt = receipts[moduleId];
    if (!receipt || typeof receipt !== "object" || Array.isArray(receipt)) throw new Error(`missing receipt ${moduleId}`);
    if (receipt.module !== moduleId) throw new Error(`receipt module mismatch ${moduleId}`);
    if (receipt.policy_status !== "SAFE_WHITE_HAT" || receipt.action_mode !== "OBSERVE_ONLY") {
      throw new Error(`unsafe receipt policy ${moduleId}`);
    }
    if (!SHA256_RE.test(receipt.evidence_hash ?? "")) throw new Error(`invalid receipt evidence hash ${moduleId}`);
    if (!new Set(["SUCCESS", "INSUFFICIENT_DATA"]).has(receipt.execution_status)) {
      throw new Error(`runtime error receipt ${moduleId}`);
    }
  }
  const terminal = receipts[LAST_MODULE];
  if (terminal.execution_status !== "SUCCESS" || terminal.finding_status !== "NO_FINDING") {
    throw new Error("terminal M2500 did not certify release");
  }
  if (terminal.evidence_hash !== execution.terminal_evidence_hash) {
    throw new Error("terminal evidence hash mismatch");
  }
  return execution;
}

export async function executeSuiteWithPython({ payload, config, pythonBin = "python3", timeoutMs = 120000, maxOutputBytes = 64 * 1024 * 1024 }) {
  if (typeof pythonBin !== "string" || !pythonBin.trim()) throw new TypeError("pythonBin is required");
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) throw new TypeError("timeoutMs must be a positive integer");
  if (!Number.isSafeInteger(maxOutputBytes) || maxOutputBytes < 1024) throw new TypeError("maxOutputBytes must be an integer >= 1024");

  const request = JSON.stringify({ schema_version: 1, payload, config });
  return new Promise((resolve, reject) => {
    const child = spawn(pythonBin, [BRIDGE_PATH], {
      cwd: SUITE_ROOT,
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const stdout = [];
    const stderr = [];
    let outputBytes = 0;
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
      if (stderr.reduce((total, item) => total + item.length, 0) < 65536) stderr.push(chunk);
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

  let execution;
  try {
    execution = validateExecutionEnvelope(await executeSuite({ payload: snapshot.datasets, config }));
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
    return decision({
      siteId,
      status: evidenceAfterExecution.status === "OFF" ? "OFF" : "STALE",
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
    receipts: Object.freeze(execution.receipts),
  });
}
