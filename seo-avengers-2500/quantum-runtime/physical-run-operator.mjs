import { canonicalQuantumSha256, compareStrings, freeze, integer, text, TOKEN_RE } from "./common.mjs";
import { buildPhysicalQpuExperimentReport } from "./physical-experiment-protocol.mjs";

const ENGINE_ID = "WALLE_PHYSICAL_QPU_RUN_OPERATOR_V1";
const EXECUTE_AUTHORIZATION = "EXECUTE_PHYSICAL_QPU";
const PREPARE_ONLY = "PREPARE_ONLY";
const MAX_RUNS = 256;

function normalizeAuthorization(value) {
  if (value !== PREPARE_ONLY && value !== EXECUTE_AUTHORIZATION) {
    throw new Error(`executionAuthorization must be ${PREPARE_ONLY} or ${EXECUTE_AUTHORIZATION}`);
  }
  return value;
}

function assertPhysicalBackend(backend) {
  if (!backend || typeof backend !== "object" || typeof backend.execute !== "function") {
    throw new Error("physical backend with execute(request) is required");
  }
  const descriptor = backend.descriptor;
  if (!descriptor || descriptor.backendFamily !== "PHYSICAL_QPU" || descriptor.hardwareExecution !== true) {
    throw new Error("physical run operator requires PHYSICAL_QPU hardware backend");
  }
  text(descriptor.adapterId, "physical backend adapterId", { pattern: TOKEN_RE });
  text(descriptor.adapterVersion, "physical backend adapterVersion", { pattern: TOKEN_RE });
  return descriptor;
}

function unique(values) {
  return [...new Set(values)].sort(compareStrings);
}

function summarizeCompilationControls(executions) {
  const receipts = executions
    .map((execution) => execution.executionReceipt)
    .filter((receipt) => receipt?.status === "SUCCEEDED");

  if (receipts.length === 0) {
    return freeze({
      successfulReceiptCount: 0,
      transpiledCircuitSha256: null,
      compiler: null,
      compilerVersion: null,
      seed: null,
      topologySha256: null,
      capabilitiesSha256: null,
      stableTranspiledCircuit: false,
      stableCompilerIdentity: false,
      stableSeed: false,
      stableTopology: false,
      stableCapabilities: false,
      reasons: [],
    });
  }

  const transpiledDigests = unique(receipts.map((receipt) => receipt.transpiledCircuitSha256 ?? "<missing>"));
  const compilers = unique(receipts.map((receipt) => receipt.reproducibilityMetadata?.compiler ?? "<missing>"));
  const compilerVersions = unique(receipts.map((receipt) => receipt.reproducibilityMetadata?.compilerVersion ?? "<missing>"));
  const seeds = unique(receipts.map((receipt) => receipt.reproducibilityMetadata?.seed ?? "<missing>"));
  const topologies = unique(receipts.map((receipt) => receipt.hardwareIdentity?.topologySha256 ?? "<missing>"));
  const capabilities = unique(receipts.map((receipt) => receipt.hardwareIdentity?.capabilitiesSha256 ?? "<missing>"));

  const reasons = [];
  if (transpiledDigests.includes("<missing>")) reasons.push("TRANSPILED_CIRCUIT_DIGEST_MISSING");
  else if (transpiledDigests.length !== 1) reasons.push("TRANSPILED_CIRCUIT_DRIFT_ACROSS_RUNS");

  if (compilers.includes("<missing>") || compilerVersions.includes("<missing>")) reasons.push("COMPILER_IDENTITY_NOT_CAPTURED");
  else if (compilers.length !== 1 || compilerVersions.length !== 1) reasons.push("COMPILER_IDENTITY_DRIFT_ACROSS_RUNS");

  if (seeds.includes("<missing>")) reasons.push("TRANSPILER_SEED_NOT_CAPTURED");
  else if (seeds.length !== 1) reasons.push("TRANSPILER_SEED_DRIFT_ACROSS_RUNS");

  if (topologies.includes("<missing>")) reasons.push("BACKEND_TOPOLOGY_NOT_CAPTURED");
  else if (topologies.length !== 1) reasons.push("BACKEND_TOPOLOGY_DRIFT_ACROSS_RUNS");

  if (capabilities.includes("<missing>")) reasons.push("BACKEND_CAPABILITIES_NOT_CAPTURED");
  else if (capabilities.length !== 1) reasons.push("BACKEND_CAPABILITIES_DRIFT_ACROSS_RUNS");

  return freeze({
    successfulReceiptCount: receipts.length,
    transpiledCircuitSha256: transpiledDigests.length === 1 && transpiledDigests[0] !== "<missing>" ? transpiledDigests[0] : null,
    compiler: compilers.length === 1 && compilers[0] !== "<missing>" ? compilers[0] : null,
    compilerVersion: compilerVersions.length === 1 && compilerVersions[0] !== "<missing>" ? compilerVersions[0] : null,
    seed: seeds.length === 1 && seeds[0] !== "<missing>" ? seeds[0] : null,
    topologySha256: topologies.length === 1 && topologies[0] !== "<missing>" ? topologies[0] : null,
    capabilitiesSha256: capabilities.length === 1 && capabilities[0] !== "<missing>" ? capabilities[0] : null,
    stableTranspiledCircuit: transpiledDigests.length === 1 && !transpiledDigests.includes("<missing>"),
    stableCompilerIdentity: compilers.length === 1 && compilerVersions.length === 1 && !compilers.includes("<missing>") && !compilerVersions.includes("<missing>"),
    stableSeed: seeds.length === 1 && !seeds.includes("<missing>"),
    stableTopology: topologies.length === 1 && !topologies.includes("<missing>"),
    stableCapabilities: capabilities.length === 1 && !capabilities.includes("<missing>"),
    reasons: unique(reasons),
  });
}

function buildOperatorReport({ descriptor, authorization, requestedRuns, attemptedRuns, shots, experimentReport, compilationControls }) {
  const reasons = unique([
    ...experimentReport.reasons,
    ...compilationControls.reasons,
  ]);

  let verdict = experimentReport.verdict;
  let status = experimentReport.status;

  if (authorization === PREPARE_ONLY) {
    verdict = "NOT_TESTED";
    status = "PREPARED_PHYSICAL_QPU_RUN_NOT_AUTHORIZED_FOR_EXECUTION";
    if (!reasons.includes("PHYSICAL_QPU_EXECUTION_NOT_PERFORMED")) reasons.push("PHYSICAL_QPU_EXECUTION_NOT_PERFORMED");
  } else if (experimentReport.verdict === "PASS" && compilationControls.reasons.length > 0) {
    verdict = "INCONCLUSIVE";
    status = "PHYSICAL_QPU_RUNS_COMPARABLE_BUT_REPRODUCIBILITY_CONTROL_INCOMPLETE";
  }

  const unsigned = {
    schemaVersion: 1,
    engineId: ENGINE_ID,
    verdict,
    status,
    reasons: unique(reasons),
    executionAuthorization: authorization,
    requestedRunCount: requestedRuns,
    attemptedRunCount: attemptedRuns,
    requestedShotsPerRun: shots,
    backendAdapterId: descriptor.adapterId,
    backendAdapterVersion: descriptor.adapterVersion,
    physicalExperimentReportSha256: experimentReport.reportSha256,
    compilationControls,
    quantumAdvantageClaimAllowed: false,
    interpretation: verdict === "PASS"
      ? "PASS_CERTIFIES_CONTROLLED_REPEATED_PHYSICAL_QPU_EXECUTION_NOT_QUANTUM_ADVANTAGE"
      : verdict === "NOT_TESTED"
        ? "NOT_TESTED_NEVER_CERTIFIES_AS_SUCCESS"
        : verdict === "FAIL"
          ? "FAIL_BLOCKS_PHYSICAL_RUN_CERTIFICATION"
          : "INCONCLUSIVE_BLOCKS_QUANTUM_ADVANTAGE_OR_SUPERIORITY_CLAIMS",
  };
  return freeze({ ...unsigned, reportSha256: canonicalQuantumSha256(unsigned) });
}

export async function runPhysicalQpuExperiment({
  backend,
  optimizationProblemReport,
  baselineProfile,
  problemBinding,
  problemContract,
  circuitBinding,
  circuitPayload,
  shots,
  runCount = 5,
  executionAuthorization = PREPARE_ONLY,
}) {
  const descriptor = assertPhysicalBackend(backend);
  const requestedRuns = integer(runCount, "physical runCount", 2, MAX_RUNS);
  const normalizedShots = integer(shots, "physical shots", 1, 10_000_000);
  const authorization = normalizeAuthorization(executionAuthorization);

  const request = freeze({
    optimizationProblemReport,
    problemBinding,
    problemContract,
    circuitBinding,
    circuitPayload,
    shots: normalizedShots,
  });

  const executions = [];
  if (authorization === EXECUTE_AUTHORIZATION) {
    for (let index = 0; index < requestedRuns; index += 1) {
      const execution = await backend.execute(request);
      executions.push(execution);
      if (execution.verdict === "NOT_TESTED" || execution.verdict === "FAIL") break;
    }
  }

  const experimentReport = buildPhysicalQpuExperimentReport({
    optimizationProblemReport,
    baselineProfile,
    quantumExecutions: executions,
    minimumCompletedRuns: requestedRuns,
  });
  const compilationControls = summarizeCompilationControls(executions);
  const operatorReport = buildOperatorReport({
    descriptor,
    authorization,
    requestedRuns,
    attemptedRuns: executions.length,
    shots: normalizedShots,
    experimentReport,
    compilationControls,
  });

  return freeze({
    schemaVersion: 1,
    engineId: ENGINE_ID,
    executions,
    experimentReport,
    operatorReport,
  });
}

export const PHYSICAL_QPU_RUN_EXECUTION_AUTHORIZATION = EXECUTE_AUTHORIZATION;
export const PHYSICAL_QPU_RUN_PREPARE_ONLY = PREPARE_ONLY;
export const PhysicalQpuRunOperator = Object.freeze({ run: runPhysicalQpuExperiment });
