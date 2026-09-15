import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { compileQaoaExecutableCircuitToOpenQasm3 } from "../../qaoa-openqasm3-compiler.mjs";

const PROVIDER = "IBM_QUANTUM_COMPUTE";
const ENGINE_ID = "NEXUS_IBM_QUANTUM_QPU_PREFLIGHT_V1";
const BRIDGE_ID = "NEXUS_IBM_QUANTUM_QPU_PREFLIGHT_V1";
const DEFAULT_BRIDGE_PATH = fileURLToPath(new URL("./ibm-qpu-preflight.py", import.meta.url));
const MAX_BRIDGE_OUTPUT_BYTES = 64 * 1024 * 1024;
const MAX_TRANSPILER_SEED = 2_147_483_647;
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

function optionalTranspilerSeed(value) {
  if (value === null || value === undefined) return null;
  if (!Number.isSafeInteger(value) || value < 0 || value > MAX_TRANSPILER_SEED) {
    throw new Error(`IBM transpilerSeed must be integer between 0 and ${MAX_TRANSPILER_SEED}`);
  }
  return value;
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

function sanitizePreflightComponent(response) {
  return sha256Text(JSON.stringify({
    backendDevice: response.preflight.backendDevice,
    logicalQasm3Sha256: response.preflight.logicalQasm3Sha256,
    transpiledCircuitSha256: response.preflight.transpiledCircuitSha256,
    topologySha256: response.preflight.topologySha256,
    capabilitiesSha256: response.preflight.capabilitiesSha256,
    transpilerSeed: response.preflight.transpilerSeed,
  })).slice("sha256:".length);
}

async function writeContentAddressed(path, content) {
  await mkdir(dirname(path), { recursive: true });
  try {
    await writeFile(path, content, { encoding: "utf8", flag: "wx" });
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
    const existing = await readFile(path, "utf8");
    if (existing !== content) throw new Error(`content-addressed preflight evidence collision:${path}`, { cause: error });
  }
}

function validateResourceEstimate(value) {
  exactKeys(value, ["depth", "gateCount", "twoQubitGateCount"], "IBM preflight resource estimate");
  for (const field of ["depth", "gateCount", "twoQubitGateCount"]) {
    if (!Number.isSafeInteger(value[field]) || value[field] < 0) throw new Error(`IBM preflight ${field} must be non-negative safe integer`);
  }
  return value;
}

export function validateIbmPreflightResponse(response, { logicalCompilation, backendName, transpilerSeed = null }) {
  const expectedSeed = optionalTranspilerSeed(transpilerSeed);
  exactKeys(response, ["artifacts", "bridgeId", "preflight", "schemaVersion"], "IBM preflight response");
  if (response.schemaVersion !== 1 || response.bridgeId !== BRIDGE_ID) throw new Error("unsupported IBM preflight response");

  const preflight = response.preflight;
  exactKeys(preflight, [
    "backendDevice", "backendQubitCount", "capabilitiesSha256", "compiler", "compilerVersion", "logicalQasm3Sha256",
    "logicalQubitCount", "nativeOperationSetSatisfied", "operational", "pendingJobs", "physicalExecutionVerdict", "physicalQpu",
    "provider", "providerSdk", "providerSdkVersion", "qubitCapacitySufficient", "readiness", "reasons", "resourceEstimate",
    "statusMessage", "submissionAttempted", "topologySha256", "transpiledCircuitSha256", "transpilerSeed",
  ], "IBM preflight evidence");
  if (preflight.provider !== PROVIDER || preflight.backendDevice !== backendName) throw new Error("IBM preflight provider/backend identity mismatch");
  if (preflight.physicalQpu !== true) throw new Error("IBM preflight must identify physical QPU");
  if (preflight.submissionAttempted !== false) throw new Error("IBM preflight must never submit a physical job");
  if (preflight.physicalExecutionVerdict !== "NOT_TESTED") throw new Error("IBM preflight cannot promote physical execution verdict");
  if (!Array.isArray(preflight.reasons) || preflight.reasons.some((reason) => typeof reason !== "string" || !reason)) {
    throw new Error("IBM preflight reasons must be string array");
  }
  if (!["READY", "NOT_READY"].includes(preflight.readiness)) throw new Error("IBM preflight readiness invalid");
  for (const field of ["backendQubitCount", "logicalQubitCount", "pendingJobs"]) {
    if (!Number.isSafeInteger(preflight[field]) || preflight[field] < 0) throw new Error(`IBM preflight ${field} invalid`);
  }
  for (const field of ["operational", "qubitCapacitySufficient", "nativeOperationSetSatisfied"]) {
    if (typeof preflight[field] !== "boolean") throw new Error(`IBM preflight ${field} must be boolean`);
  }
  validateResourceEstimate(preflight.resourceEstimate);
  assertSha(preflight.logicalQasm3Sha256, "IBM preflight logical QASM digest");
  assertSha(preflight.transpiledCircuitSha256, "IBM preflight transpiled circuit digest");
  assertSha(preflight.topologySha256, "IBM preflight topology digest");
  assertSha(preflight.capabilitiesSha256, "IBM preflight capabilities digest");
  if (preflight.logicalQasm3Sha256 !== logicalCompilation.qasm3Sha256) throw new Error("IBM preflight logical QASM binding drift");
  const observedSeed = preflight.transpilerSeed ?? null;
  if (expectedSeed === null ? observedSeed !== null : observedSeed !== String(expectedSeed)) {
    throw new Error("IBM preflight transpiler seed binding mismatch");
  }

  const artifacts = response.artifacts;
  exactKeys(artifacts, [
    "capabilitiesJson", "capabilitiesSha256", "logicalQasm3", "logicalQasm3Sha256", "topologyJson", "topologySha256",
    "transpiledQasm3", "transpiledQasm3Sha256",
  ], "IBM preflight artifacts");
  assertTextDigest(artifacts.logicalQasm3, artifacts.logicalQasm3Sha256, "logical QASM3");
  assertTextDigest(artifacts.transpiledQasm3, artifacts.transpiledQasm3Sha256, "transpiled QASM3");
  assertTextDigest(artifacts.topologyJson, artifacts.topologySha256, "backend topology");
  assertTextDigest(artifacts.capabilitiesJson, artifacts.capabilitiesSha256, "backend capabilities");
  if (artifacts.logicalQasm3 !== logicalCompilation.qasm3 || artifacts.logicalQasm3Sha256 !== logicalCompilation.qasm3Sha256) {
    throw new Error("IBM preflight logical circuit artifact drift");
  }
  if (preflight.transpiledCircuitSha256 !== artifacts.transpiledQasm3Sha256
    || preflight.topologySha256 !== artifacts.topologySha256
    || preflight.capabilitiesSha256 !== artifacts.capabilitiesSha256) {
    throw new Error("IBM preflight artifact digest drift");
  }
  if (preflight.readiness === "READY") {
    if (!preflight.operational || !preflight.qubitCapacitySufficient || !preflight.nativeOperationSetSatisfied || preflight.statusMessage.toLowerCase() !== "active" || preflight.reasons.length !== 0) {
      throw new Error("IBM preflight READY contradicts evidence");
    }
  }
  return Object.freeze({ preflight: Object.freeze(preflight), artifacts: Object.freeze(artifacts) });
}

export async function runIbmQpuPreflightBridge({ request, apiKey, instanceCrn, pythonExecutable = "python3", bridgePath = DEFAULT_BRIDGE_PATH, timeoutMillis = 0, spawnImpl = spawn }) {
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
        finish(new Error(`IBM preflight bridge ${label} exceeded evidence bound`));
      }
      return next;
    };
    child.on("error", () => finish(new Error("IBM_QPU_PREFLIGHT_PROCESS_START_FAILED")));
    child.stdout.on("data", (chunk) => { stdout = append(stdout, chunk, "stdout"); });
    child.stderr.on("data", (chunk) => { stderr = append(stderr, chunk, "stderr"); });
    child.on("close", (code, signal) => {
      if (settled) return;
      if (code !== 0) {
        finish(new Error(`IBM_QPU_PREFLIGHT_PROCESS_FAILED:${code ?? "null"}:${signal ?? "none"}:${stderr.slice(0, 256)}`));
        return;
      }
      let parsed;
      try { parsed = JSON.parse(stdout); }
      catch { finish(new Error("IBM_QPU_PREFLIGHT_OUTPUT_NOT_JSON")); return; }
      finish(null, parsed);
    });
    if (timeoutMillis > 0) {
      timer = setTimeout(() => {
        child.kill("SIGKILL");
        finish(new Error("IBM_QPU_PREFLIGHT_TIMEOUT"));
      }, timeoutMillis);
      timer.unref?.();
    }
    child.stdin.end(JSON.stringify(request));
  });
}

export function createIbmPreflightFilesystemEvidenceSink({ rootDir }) {
  const root = resolve(requiredText(rootDir, "IBM preflight evidence rootDir"));
  return async ({ preflight, artifacts, request }) => {
    const response = { preflight, artifacts };
    const evidenceDir = join(root, sanitizePreflightComponent(response));
    const files = [
      ["logical.openqasm3", artifacts.logicalQasm3],
      ["transpiled.openqasm3", artifacts.transpiledQasm3],
      ["topology.json", artifacts.topologyJson],
      ["capabilities.json", artifacts.capabilitiesJson],
      ["request.json", `${JSON.stringify(request, null, 2)}\n`],
      ["preflight.json", `${JSON.stringify(preflight, null, 2)}\n`],
    ];
    for (const [name, content] of files) await writeContentAddressed(join(evidenceDir, name), content);
    return Object.freeze({ evidenceDir, preflightSha256: sha256Text(`${JSON.stringify(preflight, null, 2)}\n`) });
  };
}

function buildPreflightRequest({ physicalRequest, backendName, logicalCompilation, transpilerSeed }) {
  return Object.freeze({
    schemaVersion: 1,
    provider: PROVIDER,
    backendName,
    logicalQubitCount: physicalRequest.circuitPayload.logicalQubitCount,
    transpilerSeed,
    logicalCircuitArtifact: Object.freeze({
      format: "OPENQASM_3",
      qasm3: logicalCompilation.qasm3,
      qasm3Sha256: logicalCompilation.qasm3Sha256,
      sourceCircuitSha256: logicalCompilation.sourceCircuitSha256,
    }),
  });
}

export function buildIbmPreflightRequestForContractTest({ physicalRequest, backendName, transpilerSeed = null }) {
  const logicalCompilation = compileQaoaExecutableCircuitToOpenQasm3(physicalRequest.circuitPayload);
  const request = buildPreflightRequest({
    physicalRequest,
    backendName: requiredText(backendName, "IBM Quantum backend name"),
    logicalCompilation,
    transpilerSeed: optionalTranspilerSeed(transpilerSeed),
  });
  return Object.freeze({ request, logicalCompilation });
}

export function createIbmQuantumComputePreflight({
  apiKey = null,
  instanceCrn = null,
  backendName = null,
  transpilerSeed = null,
  evidenceSink = null,
  pythonExecutable = "python3",
  bridgePath = DEFAULT_BRIDGE_PATH,
  timeoutMillis = 0,
  bridgeRunner = runIbmQpuPreflightBridge,
} = {}) {
  const token = optionalSecret(apiKey, "IBM Quantum API key");
  const crn = optionalSecret(instanceCrn, "IBM Quantum instance CRN");
  const backend = optionalSecret(backendName, "IBM Quantum backend name");
  const seed = optionalTranspilerSeed(transpilerSeed);
  const anyConfiguration = token !== null || crn !== null || backend !== null || seed !== null || evidenceSink !== null;
  const fullyConfigured = token !== null && crn !== null && backend !== null;
  if (anyConfiguration && !fullyConfigured) throw new Error("IBM QPU preflight requires apiKey, instanceCrn, and backendName together");
  if (evidenceSink !== null && typeof evidenceSink !== "function") throw new Error("IBM QPU preflight evidenceSink must be function");
  if (typeof bridgeRunner !== "function") throw new Error("IBM QPU preflight bridgeRunner must be function");

  return Object.freeze({
    engineId: ENGINE_ID,
    async run(physicalRequest) {
      if (!fullyConfigured) {
        return Object.freeze({
          schemaVersion: 1,
          engineId: ENGINE_ID,
          provider: PROVIDER,
          verdict: "NOT_TESTED",
          readiness: "NOT_CONFIGURED",
          reasons: Object.freeze(["IBM_QPU_PROVIDER_ACCESS_NOT_CONFIGURED"]),
          physicalExecutionVerdict: "NOT_TESTED",
          submissionAttempted: false,
          preflightEvidence: null,
        });
      }
      const logicalCompilation = compileQaoaExecutableCircuitToOpenQasm3(physicalRequest.circuitPayload);
      const request = buildPreflightRequest({ physicalRequest, backendName: backend, logicalCompilation, transpilerSeed: seed });
      let response;
      try {
        response = await bridgeRunner({ request, apiKey: token, instanceCrn: crn, pythonExecutable, bridgePath, timeoutMillis });
      } catch (error) {
        return Object.freeze({
          schemaVersion: 1,
          engineId: ENGINE_ID,
          provider: PROVIDER,
          verdict: "FAIL",
          readiness: "PREFLIGHT_ERROR",
          reasons: Object.freeze(["IBM_QPU_PREFLIGHT_BRIDGE_FAILED"]),
          physicalExecutionVerdict: "NOT_TESTED",
          submissionAttempted: false,
          preflightEvidence: null,
          errorCode: String(error?.message ?? "IBM_QPU_PREFLIGHT_BRIDGE_FAILED").slice(0, 256),
        });
      }
      const checked = validateIbmPreflightResponse(response, { logicalCompilation, backendName: backend, transpilerSeed: seed });
      if (evidenceSink) await evidenceSink({ preflight: checked.preflight, artifacts: checked.artifacts, request });
      return Object.freeze({
        schemaVersion: 1,
        engineId: ENGINE_ID,
        provider: PROVIDER,
        verdict: checked.preflight.readiness === "READY" ? "PASS" : "INCONCLUSIVE",
        readiness: checked.preflight.readiness,
        reasons: Object.freeze([...checked.preflight.reasons]),
        physicalExecutionVerdict: "NOT_TESTED",
        submissionAttempted: false,
        preflightEvidence: checked.preflight,
      });
    },
  });
}

export const IBM_QPU_PREFLIGHT_ENGINE_ID = ENGINE_ID;
export const IBM_QPU_PREFLIGHT_MAX_TRANSPILER_SEED = MAX_TRANSPILER_SEED;
