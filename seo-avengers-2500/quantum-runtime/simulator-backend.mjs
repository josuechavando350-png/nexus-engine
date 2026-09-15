import { QuantumBackendAdapter } from "./backend-adapter.mjs";
import {
  buildCircuitBinding,
  buildExecutionReceipt,
  buildProblemBinding,
  buildQaoaExecutableCircuitIr,
  buildQuantumProblemContract,
} from "./contracts.mjs";
import { buildQuantumHybridExperimentReport } from "../quantum-hybrid/qaoa-experiment.mjs";

const ADAPTER_ID = "NEXUS_STATEVECTOR_QAOA_ADAPTER_V1";
const ADAPTER_VERSION = "1.0.0";

function freeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) freeze(child);
  return Object.freeze(value);
}

async function executeSimulator(request) {
  if (!request || typeof request !== "object" || Array.isArray(request)) throw new Error("simulator request must be object");
  const { optimizationProblemReport, baselineProfile, experimentProfile } = request;
  const problemBinding = buildProblemBinding(optimizationProblemReport);
  const problemContract = buildQuantumProblemContract(optimizationProblemReport);
  if (problemContract.problemBindingSha256 !== problemBinding.bindingSha256) throw new Error("simulator problem contract/binding mismatch");
  const report = buildQuantumHybridExperimentReport({ optimizationProblemReport, baselineProfile, experimentProfile });
  if (report.optimizationProblemReportSha256 !== problemBinding.optimizationProblemReportSha256
    || report.optimizationModelSha256 !== problemBinding.optimizationModelSha256) throw new Error("simulator report/problem binding mismatch");

  const selectedParameters = report.experimentProfile.parameterSets.find((row) => row.parameterSetId === report.quantumHybridCandidate.selectedParameterSetId);
  if (!selectedParameters) throw new Error("simulator selected parameter set missing from validated experiment profile");
  const circuitPayload = buildQaoaExecutableCircuitIr({
    optimizationProblemReport,
    problemBinding,
    problemContract,
    parameterSetId: selectedParameters.parameterSetId,
    gammaMicroradians: selectedParameters.gammaMicroradians,
    betaMicroradians: selectedParameters.betaMicroradians,
  });
  if (circuitPayload.logicalQubitCount !== report.quantumHybridCandidate.qubitCount) throw new Error("simulator QAOA IR qubit count mismatch");
  const circuitBinding = buildCircuitBinding({
    problemBinding,
    circuitId: `qaoa:${report.experimentProfile.profileId}:${selectedParameters.parameterSetId}`,
    circuitFormat: circuitPayload.irKind,
    logicalQubitCount: circuitPayload.logicalQubitCount,
    circuitSha256: circuitPayload.circuitSha256,
    parameterBindingSha256: circuitPayload.parameterBindingSha256,
    measurementBitOrder: circuitPayload.measurementBitOrder,
  });

  const receipt = buildExecutionReceipt({
    backendFamily: "SIMULATOR",
    hardwareExecution: false,
    provider: "NEXUS_INTERNAL",
    backendDevice: "STATEVECTOR_QAOA_SIMULATOR",
    jobId: `sim:${report.reportSha256}`,
    status: "SUCCEEDED",
    timestamps: { submittedAt: null, startedAt: null, completedAt: null },
    timing: { queueTimeMillis: null, executionTimeMillis: null, providerReportedTotalMillis: null },
    shotsRequested: 0,
    shotsCompleted: 0,
    problemBindingSha256: problemBinding.bindingSha256,
    optimizationProblemReportSha256: problemBinding.optimizationProblemReportSha256,
    optimizationModelSha256: problemBinding.optimizationModelSha256,
    circuitSha256: circuitBinding.circuitSha256,
    transpilationApplied: false,
    transpiledCircuitSha256: null,
    calibrationEvidence: {
      status: "SIMULATOR_NOT_APPLICABLE",
      calibrationId: null,
      capturedAt: null,
      providerReportedAt: null,
      metadataSha256: null,
    },
    rawResultSha256: report.reportSha256,
    measurementCounts: {},
    hardwareIdentity: null,
    providerReceiptSha256: null,
    reproducibilityMetadata: {
      adapterId: ADAPTER_ID,
      adapterVersion: ADAPTER_VERSION,
      providerSdk: null,
      providerSdkVersion: null,
      compiler: "WALLE_QUANTUM_HYBRID_EXPERIMENT_V1",
      compilerVersion: "1",
      seed: null,
    },
  });

  return freeze({
    schemaVersion: 1,
    backendAdapterId: ADAPTER_ID,
    backendFamily: "SIMULATOR",
    verdict: "PASS",
    reasonCodes: ["SIMULATOR_EXECUTION_VERIFIED", "NO_PHYSICAL_QPU_CLAIM"],
    problemBinding,
    problemContract,
    circuitBinding,
    circuitPayload,
    executionReceipt: receipt,
    candidate: {
      objectiveValueDecimal: report.quantumHybridCandidate.objectiveValueDecimal,
      selectedDecisionIds: report.quantumHybridCandidate.selectedDecisionIds,
      selectedSetSha256: report.quantumHybridCandidate.selectedSetSha256,
      resourceUsage: report.quantumHybridCandidate.resourceUsage,
      feasible: report.quantumHybridCandidate.feasible,
      sourceReportSha256: report.reportSha256,
      classicalReferenceReportSha256: report.classicalBaselineReportSha256,
      simulatorQuantumAdvantageClaimAllowed: report.comparison.quantumAdvantageClaimAllowed,
      simulatorQuantumAdvantageVerdict: report.comparison.quantumAdvantageVerdict,
    },
  });
}

export class SimulatorBackend extends QuantumBackendAdapter {
  constructor() {
    super({ adapterId: ADAPTER_ID, adapterVersion: ADAPTER_VERSION, backendFamily: "SIMULATOR", hardwareExecution: false, execute: executeSimulator });
  }
}

export const SIMULATOR_BACKEND_ADAPTER_ID = ADAPTER_ID;
