import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import {
  createIbmQuantumComputePreflight,
  validateIbmPreflightResponse,
} from "../quantum-runtime/providers/ibm/ibm-qpu-preflight.mjs";

function sha256Text(value) {
  return `sha256:${createHash("sha256").update(Buffer.from(value, "utf8")).digest("hex")}`;
}

function logicalCompilation() {
  const qasm3 = "OPENQASM 3.0;\nqubit[1] q;\nbit[1] c;\nc[0] = measure q[0];";
  return {
    qasm3,
    qasm3Sha256: sha256Text(qasm3),
    sourceCircuitSha256: sha256Text("source-circuit"),
  };
}

function readyResponse({ seed = "1337", readiness = "READY", statusMessage = "active", reasons = [], submissionAttempted = false } = {}) {
  const logical = logicalCompilation();
  const transpiledQasm3 = `${logical.qasm3}\n// seeded ISA fixture`;
  const topologyJson = JSON.stringify({ backend: "ibm_contract_qpu", edges: [[0, 1]] });
  const capabilitiesJson = JSON.stringify({ backend: "ibm_contract_qpu", numQubits: 127, operationNames: ["measure", "rz", "sx", "x", "cz"] });
  return {
    schemaVersion: 1,
    bridgeId: "NEXUS_IBM_QUANTUM_QPU_PREFLIGHT_V1",
    preflight: {
      provider: "IBM_QUANTUM_COMPUTE",
      backendDevice: "ibm_contract_qpu",
      physicalQpu: true,
      operational: true,
      statusMessage,
      pendingJobs: 4,
      logicalQubitCount: 1,
      backendQubitCount: 127,
      qubitCapacitySufficient: true,
      nativeOperationSetSatisfied: true,
      transpilerSeed: seed,
      logicalQasm3Sha256: logical.qasm3Sha256,
      transpiledCircuitSha256: sha256Text(transpiledQasm3),
      topologySha256: sha256Text(topologyJson),
      capabilitiesSha256: sha256Text(capabilitiesJson),
      resourceEstimate: { gateCount: 8, twoQubitGateCount: 1, depth: 5 },
      providerSdk: "qiskit-ibm-runtime",
      providerSdkVersion: "0.49.0",
      compiler: "qiskit.generate_preset_pass_manager",
      compilerVersion: "2.5.2",
      readiness,
      reasons,
      submissionAttempted,
      physicalExecutionVerdict: "NOT_TESTED",
    },
    artifacts: {
      logicalQasm3: logical.qasm3,
      logicalQasm3Sha256: logical.qasm3Sha256,
      transpiledQasm3,
      transpiledQasm3Sha256: sha256Text(transpiledQasm3),
      topologyJson,
      topologySha256: sha256Text(topologyJson),
      capabilitiesJson,
      capabilitiesSha256: sha256Text(capabilitiesJson),
    },
  };
}

test("unconfigured IBM preflight stays blocked without invoking provider bridge", async () => {
  let calls = 0;
  const preflight = createIbmQuantumComputePreflight({
    bridgeRunner: async () => { calls += 1; throw new Error("must not run"); },
  });
  const report = await preflight.run(null);
  assert.equal(report.verdict, "NOT_TESTED");
  assert.equal(report.physicalExecutionVerdict, "NOT_TESTED");
  assert.equal(report.submissionAttempted, false);
  assert.equal(calls, 0);
});

test("ready IBM preflight evidence is accepted without promoting hardware execution", () => {
  const logical = logicalCompilation();
  const checked = validateIbmPreflightResponse(readyResponse(), {
    logicalCompilation: logical,
    backendName: "ibm_contract_qpu",
    transpilerSeed: 1337,
  });
  assert.equal(checked.preflight.readiness, "READY");
  assert.equal(checked.preflight.submissionAttempted, false);
  assert.equal(checked.preflight.physicalExecutionVerdict, "NOT_TESTED");
  assert.equal(checked.preflight.resourceEstimate.twoQubitGateCount, 1);
});

test("preflight rejects any response claiming that a physical submission occurred", () => {
  const response = readyResponse({ submissionAttempted: true });
  assert.throws(
    () => validateIbmPreflightResponse(response, {
      logicalCompilation: logicalCompilation(),
      backendName: "ibm_contract_qpu",
      transpilerSeed: 1337,
    }),
    /must never submit a physical job/,
  );
});

test("preflight rejects optimistic READY evidence when backend status is not active", () => {
  const response = readyResponse({ statusMessage: "internal" });
  assert.throws(
    () => validateIbmPreflightResponse(response, {
      logicalCompilation: logicalCompilation(),
      backendName: "ibm_contract_qpu",
      transpilerSeed: 1337,
    }),
    /READY contradicts evidence/,
  );
});

test("preflight rejects seed and artifact digest drift", () => {
  const response = readyResponse();
  assert.throws(
    () => validateIbmPreflightResponse(response, {
      logicalCompilation: logicalCompilation(),
      backendName: "ibm_contract_qpu",
      transpilerSeed: 42,
    }),
    /transpiler seed binding mismatch/,
  );
  const tampered = readyResponse();
  tampered.artifacts.transpiledQasm3 += "\n// tampered";
  assert.throws(
    () => validateIbmPreflightResponse(tampered, {
      logicalCompilation: logicalCompilation(),
      backendName: "ibm_contract_qpu",
      transpilerSeed: 1337,
    }),
    /artifact digest mismatch/,
  );
});

test("partial provider configuration fails closed", () => {
  assert.throws(
    () => createIbmQuantumComputePreflight({ apiKey: "secret" }),
    /requires apiKey, instanceCrn, and backendName together/,
  );
});
