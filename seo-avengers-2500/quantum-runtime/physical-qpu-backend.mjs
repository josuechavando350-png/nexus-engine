import { QuantumBackendAdapter } from "./backend-adapter.mjs";
import {
  buildExecutionReceipt,
  normalizeMeasurementCounts,
  validateCircuitBinding,
  validateProblemBinding,
  validateQaoaExecutableCircuitIrAgainstProblem,
  validateQuantumProblemContract,
} from "./contracts.mjs";

const TOKEN_RE = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/;
const NON_PHYSICAL_RE = /(simulator|statevector|mock|fake|fixture|test-only|test_provider|emulator|unconfigured|required)/i;

function text(value, label) {
  if (typeof value !== "string") throw new Error(`${label} must be string`);
  const normalized = value.normalize("NFC").trim();
  if (!TOKEN_RE.test(normalized)) throw new Error(`${label} invalid`);
  return normalized;
}

function integer(value, label, min = 0, max = Number.MAX_SAFE_INTEGER) {
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new Error(`${label} must be integer in range`);
  return value;
}

function freeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) freeze(child);
  return Object.freeze(value);
}

function normalizeRequest(request) {
  if (!request || typeof request !== "object" || Array.isArray(request)) throw new Error("physical QPU request must be object");
  const keys = Object.keys(request).sort();
  const expected = ["circuitBinding", "circuitPayload", "optimizationProblemReport", "problemBinding", "problemContract", "shots"].sort();
  if (JSON.stringify(keys) !== JSON.stringify(expected)) throw new Error("unexpected physical QPU request keys");
  const problemBinding = validateProblemBinding(request.problemBinding);
  const problemContract = validateQuantumProblemContract(request.problemContract);
  if (problemContract.problemBindingSha256 !== problemBinding.bindingSha256) throw new Error("physical request problem contract/binding mismatch");
  const circuitBinding = validateCircuitBinding(request.circuitBinding);
  if (circuitBinding.problemBindingSha256 !== problemBinding.bindingSha256) throw new Error("physical request circuit/problem binding mismatch");
  const circuitPayload = validateQaoaExecutableCircuitIrAgainstProblem({
    ir: request.circuitPayload,
    optimizationProblemReport: request.optimizationProblemReport,
    problemBinding,
    problemContract,
  });
  if (circuitPayload.circuitSha256 !== circuitBinding.circuitSha256
    || circuitPayload.irKind !== circuitBinding.circuitFormat
    || circuitPayload.logicalQubitCount !== circuitBinding.logicalQubitCount
    || circuitPayload.parameterBindingSha256 !== circuitBinding.parameterBindingSha256
    || circuitPayload.measurementBitOrder !== circuitBinding.measurementBitOrder) {
    throw new Error("physical request circuit payload/binding mismatch");
  }
  const shots = integer(request.shots, "physical QPU shots", 1, 10_000_000);
  return freeze({ problemBinding, problemContract, circuitBinding, circuitPayload, shots });
}

function validateProviderEvidence(evidence, { provider, adapterId, adapterVersion, request }) {
  if (!evidence || typeof evidence !== "object" || Array.isArray(evidence)) throw new Error("provider evidence must be object");
  const required = [
    "backendDevice", "calibrationEvidence", "circuitSha256", "hardwareIdentity", "jobId", "measurementCounts",
    "optimizationModelSha256", "optimizationProblemReportSha256", "problemBindingSha256", "provider",
    "providerReceiptSha256", "rawResultSha256", "reproducibilityMetadata", "shotsCompleted", "shotsRequested", "status",
    "timing", "timestamps", "transpilationApplied", "transpiledCircuitSha256",
  ];
  const actual = Object.keys(evidence).sort();
  if (JSON.stringify(actual) !== JSON.stringify(required.sort())) throw new Error("unexpected provider evidence keys");
  const evidenceProvider = text(evidence.provider, "provider evidence provider");
  const backendDevice = text(evidence.backendDevice, "provider backend device");
  if (evidenceProvider !== provider) throw new Error("provider identity mismatch");
  if (NON_PHYSICAL_RE.test(evidenceProvider) || NON_PHYSICAL_RE.test(backendDevice)) throw new Error("provider evidence identifies non-physical backend");
  if (evidence.problemBindingSha256 !== request.problemBinding.bindingSha256) throw new Error("provider evidence problem binding mismatch");
  if (evidence.optimizationProblemReportSha256 !== request.problemBinding.optimizationProblemReportSha256
    || evidence.optimizationModelSha256 !== request.problemBinding.optimizationModelSha256) throw new Error("provider evidence optimization hash mismatch");
  if (evidence.circuitSha256 !== request.circuitPayload.circuitSha256
    || evidence.circuitSha256 !== request.circuitBinding.circuitSha256) throw new Error("provider evidence circuit binding mismatch");
  if (evidence.shotsRequested !== request.shots) throw new Error("provider evidence shot request mismatch");
  const shotsCompleted = integer(evidence.shotsCompleted, "provider shotsCompleted", 0, request.shots);
  normalizeMeasurementCounts(evidence.measurementCounts, {
    logicalQubitCount: request.circuitPayload.logicalQubitCount,
    shotsCompleted,
    allowEmpty: shotsCompleted === 0,
  });
  if (!evidence.reproducibilityMetadata || evidence.reproducibilityMetadata.adapterId !== adapterId
    || evidence.reproducibilityMetadata.adapterVersion !== adapterVersion) throw new Error("provider evidence adapter reproducibility identity mismatch");
  return evidence;
}

export function physicalReceiptLimitations(receipt) {
  const limitations = [];
  if (receipt.calibrationEvidence.status !== "CAPTURED") limitations.push("CALIBRATION_METADATA_NOT_CAPTURED");
  if (!receipt.hardwareIdentity?.capabilitiesSha256) limitations.push("BACKEND_CAPABILITY_SNAPSHOT_NOT_CAPTURED");
  if (receipt.timing.queueTimeMillis === null || receipt.timing.executionTimeMillis === null) limitations.push("QUEUE_OR_EXECUTION_TIME_NOT_SEPARATED");
  if (receipt.transpilationApplied && !receipt.transpiledCircuitSha256) limitations.push("TRANSPILED_CIRCUIT_NOT_CAPTURED");
  return Object.freeze(limitations);
}

export class PhysicalQPUBackend extends QuantumBackendAdapter {
  constructor({ provider, adapterId, adapterVersion = "1.0.0", executor = null }) {
    const normalizedProvider = text(provider, "physical QPU provider");
    const normalizedAdapterId = text(adapterId, "physical QPU adapterId");
    const normalizedAdapterVersion = text(adapterVersion, "physical QPU adapterVersion");
    if (executor !== null && typeof executor !== "function") throw new Error("physical QPU executor must be function or null");
    if (executor && NON_PHYSICAL_RE.test(normalizedProvider)) throw new Error("configured physical QPU executor requires a real provider identity");

    super({
      adapterId: normalizedAdapterId,
      adapterVersion: normalizedAdapterVersion,
      backendFamily: "PHYSICAL_QPU",
      hardwareExecution: true,
      execute: async (request) => {
        const normalizedRequest = normalizeRequest(request);
        if (!executor) {
          return freeze({
            schemaVersion: 1, backendAdapterId: normalizedAdapterId, backendFamily: "PHYSICAL_QPU", verdict: "NOT_TESTED",
            reasonCodes: ["PHYSICAL_QPU_PROVIDER_EXECUTOR_NOT_CONFIGURED"], problemBinding: normalizedRequest.problemBinding,
            problemContract: normalizedRequest.problemContract, circuitBinding: normalizedRequest.circuitBinding,
            circuitPayload: normalizedRequest.circuitPayload, executionReceipt: null, candidate: null,
          });
        }

        let evidence;
        try {
          evidence = await executor(freeze({
            schemaVersion: 1,
            provider: normalizedProvider,
            problemBinding: normalizedRequest.problemBinding,
            problemContract: normalizedRequest.problemContract,
            circuitBinding: normalizedRequest.circuitBinding,
            circuitPayload: normalizedRequest.circuitPayload,
            shots: normalizedRequest.shots,
          }));
        } catch (error) {
          return freeze({
            schemaVersion: 1, backendAdapterId: normalizedAdapterId, backendFamily: "PHYSICAL_QPU", verdict: "FAIL",
            reasonCodes: ["PHYSICAL_QPU_PROVIDER_EXECUTION_ERROR"], problemBinding: normalizedRequest.problemBinding,
            problemContract: normalizedRequest.problemContract, circuitBinding: normalizedRequest.circuitBinding,
            circuitPayload: normalizedRequest.circuitPayload, executionReceipt: null, candidate: null,
          });
        }

        let checked;
        try {
          checked = validateProviderEvidence(evidence, {
            provider: normalizedProvider,
            adapterId: normalizedAdapterId,
            adapterVersion: normalizedAdapterVersion,
            request: normalizedRequest,
          });
        } catch (error) {
          return freeze({
            schemaVersion: 1, backendAdapterId: normalizedAdapterId, backendFamily: "PHYSICAL_QPU", verdict: "FAIL",
            reasonCodes: ["PHYSICAL_QPU_PROVIDER_EVIDENCE_INVALID"], problemBinding: normalizedRequest.problemBinding,
            problemContract: normalizedRequest.problemContract, circuitBinding: normalizedRequest.circuitBinding,
            circuitPayload: normalizedRequest.circuitPayload, executionReceipt: null, candidate: null,
          });
        }

        let receipt;
        try {
          receipt = buildExecutionReceipt({
            backendFamily: "PHYSICAL_QPU",
            hardwareExecution: true,
            provider: checked.provider,
            backendDevice: checked.backendDevice,
            jobId: checked.jobId,
            status: checked.status,
            timestamps: checked.timestamps,
            timing: checked.timing,
            shotsRequested: checked.shotsRequested,
            shotsCompleted: checked.shotsCompleted,
            problemBindingSha256: checked.problemBindingSha256,
            optimizationProblemReportSha256: checked.optimizationProblemReportSha256,
            optimizationModelSha256: checked.optimizationModelSha256,
            circuitSha256: checked.circuitSha256,
            transpilationApplied: checked.transpilationApplied,
            transpiledCircuitSha256: checked.transpiledCircuitSha256,
            calibrationEvidence: checked.calibrationEvidence,
            rawResultSha256: checked.rawResultSha256,
            measurementCounts: checked.measurementCounts,
            hardwareIdentity: checked.hardwareIdentity,
            providerReceiptSha256: checked.providerReceiptSha256,
            reproducibilityMetadata: checked.reproducibilityMetadata,
          });
        } catch (error) {
          return freeze({
            schemaVersion: 1, backendAdapterId: normalizedAdapterId, backendFamily: "PHYSICAL_QPU", verdict: "FAIL",
            reasonCodes: ["PHYSICAL_QPU_PROVIDER_EVIDENCE_INVALID"], problemBinding: normalizedRequest.problemBinding,
            problemContract: normalizedRequest.problemContract, circuitBinding: normalizedRequest.circuitBinding,
            circuitPayload: normalizedRequest.circuitPayload, executionReceipt: null, candidate: null,
          });
        }

        if (receipt.status !== "SUCCEEDED") {
          return freeze({
            schemaVersion: 1, backendAdapterId: normalizedAdapterId, backendFamily: "PHYSICAL_QPU", verdict: "FAIL",
            reasonCodes: [`PHYSICAL_QPU_${receipt.status}`], problemBinding: normalizedRequest.problemBinding,
            problemContract: normalizedRequest.problemContract, circuitBinding: normalizedRequest.circuitBinding,
            circuitPayload: normalizedRequest.circuitPayload, executionReceipt: receipt, candidate: null,
          });
        }

        const limitations = physicalReceiptLimitations(receipt);
        return freeze({
          schemaVersion: 1,
          backendAdapterId: normalizedAdapterId,
          backendFamily: "PHYSICAL_QPU",
          verdict: limitations.length ? "INCONCLUSIVE" : "PASS",
          reasonCodes: limitations.length ? [...limitations] : ["PHYSICAL_QPU_EXECUTION_RECEIPT_VERIFIED"],
          problemBinding: normalizedRequest.problemBinding,
          problemContract: normalizedRequest.problemContract,
          circuitBinding: normalizedRequest.circuitBinding,
          circuitPayload: normalizedRequest.circuitPayload,
          executionReceipt: receipt,
          candidate: null,
        });
      },
    });
  }
}

export function validatePhysicalProviderEvidenceForContractTest(evidence, context) { return validateProviderEvidence(evidence, context); }
