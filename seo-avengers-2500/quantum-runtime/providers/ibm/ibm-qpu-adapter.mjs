import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { PhysicalQPUBackend } from "../../physical-qpu-backend.mjs";
import { compileQaoaExecutableCircuitToOpenQasm3 } from "../../qaoa-openqasm3-compiler.mjs";

const PROVIDER = "IBM_QUANTUM_COMPUTE";
const ADAPTER_ID = "NEXUS_IBM_QUANTUM_COMPUTE_QPU_ADAPTER_V1";
const ADAPTER_VERSION = "1.0.0";
const BRIDGE_ID = "NEXUS_IBM_QUANTUM_QISKIT_BRIDGE_V1";
const DEFAULT_BRIDGE_PATH = fileURLToPath(new URL("./ibm-qpu-bridge.py", import.meta.url));
const MAX_BRIDGE_OUTPUT_BYTES = 64 * 1024 * 1024;
const SHA_RE = /^sha256:[0-9a-f]{64}$/;

function sha256Text(value) {
  if (typeof value !== "string") throw new TypeError("hash input must be string");
  return `sha256:${createHash("sha256").update(Buffer.from(value, "utf8")).digest("hex")}`;
}

function requiredText(value, label) {
  if (typeof value !== "string" || !value.normalize("NFC").trim()) throw new Error(`${label} is required`);
  return value.normalize("NFC").trim();
}

function optionalSecret(value, label) {
  if (value === null || value === undefined || value === "") return null;
  return requiredText(value, label);
}

function exactKeys(value, expected, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be object`);
  if (JSON.stringify(Object.keys(value).sort()) !== JSON.stringify([...expected].sort())) throw new Error(`unexpected ${label} keys`);
}

function assertSha(value, label) {
  if (typeof value !== "string" || !SHA_RE.test(value)) throw new Error(`${label} must be sha256 digest`);
  return value;
}

function assertTextDigest(text, digest, label) {
  if (typeof text !== "string") throw new Error(`${label} artifact must be string`);
  if (sha256Text(text) !== assertSha(digest, `${label} digest`)) throw new Error(`${label} artifact digest mismatch`);
}

function sanitizeJobComponent(jobId) {
  return sha256Text(requiredText(jobId, "IBM jobId")).slice("sha256:".length);
}

async function writeContentAddressed(path, content) {
  await mkdir(dirname(path), { recursive: true });
  try {
    await writeFile(path, content, { encoding: "utf8", flag: "wx" });
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
    const existing = await readFile(path, "utf8");
    if (existing !== content) throw new Error(`content-addressed evidence collision:${path}`, { cause: error });
  }
}

export function validateIbmBridgeResponse(response, { logicalCompilation, adapterId = ADAPTER_ID, backendName }) {
  exactKeys(response, ["artifacts", "bridgeId", "evidence", "schemaVersion"], "IBM bridge response");
  if (response.schemaVersion !== 1 || response.bridgeId !== BRIDGE_ID) throw new Error("unsupported IBM bridge response");
  const evidence = response.evidence;
  exactKeys(evidence, [
    "backendDevice", "calibrationEvidence", "circuitSha256", "hardwareIdentity", "jobId", "measurementCounts",
    "optimizationModelSha256", "optimizationProblemReportSha256", "problemBindingSha256", "provider",
    "providerReceiptSha256", "rawResultSha256", "reproducibilityMetadata", "shotsCompleted", "shotsRequested", "status",
    "timing", "timestamps", "transpilationApplied", "transpiledCircuitSha256",
  ], "IBM provider evidence");
  if (evidence.provider !== PROVIDER) throw new Error("IBM bridge provider identity mismatch");
  if (evidence.backendDevice !== backendName) throw new Error("IBM bridge backend identity mismatch");
  if (evidence.reproducibilityMetadata?.adapterId !== adapterId
    || evidence.reproducibilityMetadata?.adapterVersion !== ADAPTER_VERSION) throw new Error("IBM bridge adapter reproducibility mismatch");
  if (evidence.transpilationApplied !== true || !evidence.transpiledCircuitSha256) throw new Error("IBM bridge must preserve ISA transpilation digest");

  const artifacts = response.artifacts;
  exactKeys(artifacts, [
    "calibrationJson", "calibrationSha256", "capabilitiesJson", "capabilitiesSha256", "logicalQasm3", "logicalQasm3Sha256",
    "metricsJson", "providerReceiptJson", "providerReceiptSha256", "rawResultJson", "rawResultSha256", "topologyJson",
    "topologySha256", "transpiledQasm3", "transpiledQasm3Sha256",
  ], "IBM bridge artifacts");
  assertTextDigest(artifacts.logicalQasm3, artifacts.logicalQasm3Sha256, "logical QASM3");
  if (artifacts.logicalQasm3 !== logicalCompilation.qasm3 || artifacts.logicalQasm3Sha256 !== logicalCompilation.qasm3Sha256) {
    throw new Error("IBM bridge logical circuit artifact drift");
  }
  assertTextDigest(artifacts.transpiledQasm3, artifacts.transpiledQasm3Sha256, "transpiled QASM3");
  assertTextDigest(artifacts.rawResultJson, artifacts.rawResultSha256, "raw result");
  assertTextDigest(artifacts.providerReceiptJson, artifacts.providerReceiptSha256, "provider receipt");
  assertTextDigest(artifacts.topologyJson, artifacts.topologySha256, "backend topology");
  assertTextDigest(artifacts.capabilitiesJson, artifacts.capabilitiesSha256, "backend capabilities");
  if (evidence.transpiledCircuitSha256 !== artifacts.transpiledQasm3Sha256) throw new Error("IBM transpiled circuit digest drift");
  if (evidence.rawResultSha256 !== artifacts.rawResultSha256) throw new Error("IBM raw result digest drift");
  if (evidence.providerReceiptSha256 !== artifacts.providerReceiptSha256) throw new Error("IBM provider receipt digest drift");
  if (evidence.hardwareIdentity?.topologySha256 !== artifacts.topologySha256
    || evidence.hardwareIdentity?.capabilitiesSha256 !== artifacts.capabilitiesSha256) {
    throw new Error("IBM hardware evidence digest drift");
  }
  if (evidence.calibrationEvidence?.status === "CAPTURED") {
    if (typeof artifacts.calibrationJson !== "string") throw new Error("captured IBM calibration bytes missing");
    assertTextDigest(artifacts.calibrationJson, artifacts.calibrationSha256, "calibration");
    if (evidence.calibrationEvidence.metadataSha256 !== artifacts.calibrationSha256) throw new Error("IBM calibration digest drift");
  } else if (artifacts.calibrationJson !== null) {
    if (typeof artifacts.calibrationJson !== "string") throw new Error("IBM calibration artifact invalid");
    assertTextDigest(artifacts.calibrationJson, artifacts.calibrationSha256, "calibration");
  } else if (artifacts.calibrationSha256 !== null) {
    throw new Error("IBM calibration digest without artifact");
  }
  if (typeof artifacts.metricsJson !== "string" || !artifacts.metricsJson) throw new Error("IBM provider metrics artifact missing");
  return Object.freeze({ evidence, artifacts });
}

export async function runIbmQpuBridge({ request, apiKey, instanceCrn, pythonExecutable = "python3", bridgePath = DEFAULT_BRIDGE_PATH, timeoutMillis = 0, spawnImpl = spawn }) {
  const executable = requiredText(pythonExecutable, "pythonExecutable");
  const path = requiredText(bridgePath, "bridgePath");
  const token = requiredText(apiKey, "IBM Quantum API key");
  const crn = requiredText(instanceCrn, "IBM Quantum instance CRN");
  if (!Number.isSafeInteger(timeoutMillis) || timeoutMillis < 0) throw new Error("timeoutMillis must be a non-negative safe integer");
  if (typeof spawnImpl !== "function") throw new Error("spawnImpl must be function");

  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawnImpl(executable, [path], {
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        ...process.env,
        NEXUS_IBM_QUANTUM_API_KEY: token,
        NEXUS_IBM_QUANTUM_INSTANCE_CRN: crn,
      },
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    let timer = null;

    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (error) rejectPromise(error); else resolvePromise(value);
    };
    const append = (current, chunk, label) => {
      const next = current + Buffer.from(chunk).toString("utf8");
      if (Buffer.byteLength(next, "utf8") > MAX_BRIDGE_OUTPUT_BYTES) {
        child.kill("SIGKILL");
        finish(new Error(`IBM bridge ${label} exceeded evidence bound`));
      }
      return next;
    };

    child.on("error", () => finish(new Error("IBM_QPU_BRIDGE_PROCESS_START_FAILED")));
    child.stdout.on("data", (chunk) => { stdout = append(stdout, chunk, "stdout"); });
    child.stderr.on("data", (chunk) => { stderr = append(stderr, chunk, "stderr"); });
    child.on("close", (code, signal) => {
      if (settled) return;
      if (code !== 0) {
        finish(new Error(`IBM_QPU_BRIDGE_PROCESS_FAILED:${code ?? "null"}:${signal ?? "none"}:${stderr.slice(0, 256)}`));
        return;
      }
      let parsed;
      try { parsed = JSON.parse(stdout); }
      catch { finish(new Error("IBM_QPU_BRIDGE_OUTPUT_NOT_JSON")); return; }
      finish(null, parsed);
    });
    if (timeoutMillis > 0) {
      timer = setTimeout(() => {
        child.kill("SIGKILL");
        finish(new Error("IBM_QPU_BRIDGE_TIMEOUT"));
      }, timeoutMillis);
      timer.unref?.();
    }
    child.stdin.end(JSON.stringify(request));
  });
}

export function createIbmFilesystemEvidenceSink({ rootDir }) {
  const root = resolve(requiredText(rootDir, "IBM evidence rootDir"));
  return async ({ evidence, artifacts }) => {
    const jobDir = join(root, sanitizeJobComponent(evidence.jobId));
    const files = [
      ["logical.openqasm3", artifacts.logicalQasm3],
      ["transpiled.openqasm3", artifacts.transpiledQasm3],
      ["raw-result.json", artifacts.rawResultJson],
      ["provider-receipt.json", artifacts.providerReceiptJson],
      ["metrics.json", artifacts.metricsJson],
      ["topology.json", artifacts.topologyJson],
      ["capabilities.json", artifacts.capabilitiesJson],
    ];
    if (artifacts.calibrationJson !== null) files.push(["calibration.json", artifacts.calibrationJson]);
    for (const [name, content] of files) await writeContentAddressed(join(jobDir, name), content);
    const manifest = JSON.stringify({
      schemaVersion: 1,
      provider: PROVIDER,
      backendDevice: evidence.backendDevice,
      jobId: evidence.jobId,
      circuitSha256: evidence.circuitSha256,
      transpiledCircuitSha256: evidence.transpiledCircuitSha256,
      rawResultSha256: evidence.rawResultSha256,
      providerReceiptSha256: evidence.providerReceiptSha256,
      calibrationMetadataSha256: evidence.calibrationEvidence?.metadataSha256 ?? null,
      topologySha256: evidence.hardwareIdentity?.topologySha256 ?? null,
      capabilitiesSha256: evidence.hardwareIdentity?.capabilitiesSha256 ?? null,
    }, null, 2) + "\n";
    await writeContentAddressed(join(jobDir, "manifest.json"), manifest);
    return Object.freeze({ jobDir, manifestSha256: sha256Text(manifest) });
  };
}

function buildBridgeRequest({ physicalRequest, backendName, logicalCompilation }) {
  return Object.freeze({
    schemaVersion: 1,
    provider: PROVIDER,
    adapterId: ADAPTER_ID,
    adapterVersion: ADAPTER_VERSION,
    backendName,
    shots: physicalRequest.shots,
    logicalQubitCount: physicalRequest.circuitPayload.logicalQubitCount,
    measurementBitOrder: physicalRequest.circuitPayload.measurementBitOrder,
    problemBindingSha256: physicalRequest.problemBinding.bindingSha256,
    optimizationProblemReportSha256: physicalRequest.problemBinding.optimizationProblemReportSha256,
    optimizationModelSha256: physicalRequest.problemBinding.optimizationModelSha256,
    circuitSha256: physicalRequest.circuitPayload.circuitSha256,
    logicalCircuitArtifact: Object.freeze({
      format: "OPENQASM_3",
      compilerId: logicalCompilation.compilerId,
      compilationSha256: logicalCompilation.compilationSha256,
      qasm3: logicalCompilation.qasm3,
      qasm3Sha256: logicalCompilation.qasm3Sha256,
      sourceCircuitSha256: logicalCompilation.sourceCircuitSha256,
    }),
  });
}

export function createIbmQuantumComputeBackend({
  apiKey = null,
  instanceCrn = null,
  backendName = null,
  evidenceSink = null,
  pythonExecutable = "python3",
  bridgePath = DEFAULT_BRIDGE_PATH,
  timeoutMillis = 0,
  bridgeRunner = runIbmQpuBridge,
} = {}) {
  const token = optionalSecret(apiKey, "IBM Quantum API key");
  const crn = optionalSecret(instanceCrn, "IBM Quantum instance CRN");
  const backend = optionalSecret(backendName, "IBM Quantum backend name");
  const anyConfiguration = token !== null || crn !== null || backend !== null || evidenceSink !== null;
  const fullyConfigured = token !== null && crn !== null && backend !== null && typeof evidenceSink === "function";
  if (anyConfiguration && !fullyConfigured) {
    throw new Error("IBM physical QPU configuration requires apiKey, instanceCrn, backendName, and evidenceSink together");
  }
  if (typeof bridgeRunner !== "function") throw new Error("bridgeRunner must be function");

  const executor = !fullyConfigured ? null : async (physicalRequest) => {
    const logicalCompilation = compileQaoaExecutableCircuitToOpenQasm3(physicalRequest.circuitPayload);
    const request = buildBridgeRequest({ physicalRequest, backendName: backend, logicalCompilation });
    const response = await bridgeRunner({
      request,
      apiKey: token,
      instanceCrn: crn,
      pythonExecutable,
      bridgePath,
      timeoutMillis,
    });
    const checked = validateIbmBridgeResponse(response, { logicalCompilation, backendName: backend });
    await evidenceSink({ evidence: checked.evidence, artifacts: checked.artifacts, bridgeRequest: request });
    return checked.evidence;
  };

  return new PhysicalQPUBackend({
    provider: PROVIDER,
    adapterId: ADAPTER_ID,
    adapterVersion: ADAPTER_VERSION,
    executor,
  });
}

export function buildIbmBridgeRequestForContractTest({ physicalRequest, backendName }) {
  const logicalCompilation = compileQaoaExecutableCircuitToOpenQasm3(physicalRequest.circuitPayload);
  return Object.freeze({ request: buildBridgeRequest({ physicalRequest, backendName, logicalCompilation }), logicalCompilation });
}

export const IBM_QUANTUM_COMPUTE_PROVIDER = PROVIDER;
export const IBM_QUANTUM_COMPUTE_ADAPTER_ID = ADAPTER_ID;
export const IBM_QUANTUM_COMPUTE_ADAPTER_VERSION = ADAPTER_VERSION;
export const IBM_QPU_BRIDGE_PATH = DEFAULT_BRIDGE_PATH;