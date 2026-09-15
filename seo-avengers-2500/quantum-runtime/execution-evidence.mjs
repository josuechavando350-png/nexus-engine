import {
  QUANTUM_CONTRACT_SCHEMA_VERSION as SCHEMA_VERSION,
  TOKEN_RE,
  bool,
  canonicalQuantumSha256,
  compareStrings,
  exactKeys,
  freeze,
  integer,
  nullableInteger,
  nullableSha,
  nullableText,
  nullableTimestamp,
  sha,
  text,
} from "./common.mjs";

const PHYSICAL_IDENTITY_FORBIDDEN_RE = /(simulator|statevector|mock|fake|fixture|test-only|test_provider|emulator)/i;
const RECEIPT_STATUSES = new Set(["SUCCEEDED", "FAILED", "CANCELLED"]);
const CALIBRATION_STATUSES = new Set(["CAPTURED", "PROVIDER_NOT_EXPOSED", "SIMULATOR_NOT_APPLICABLE"]);

export function validateCalibrationEvidence(evidence) {
  exactKeys(evidence, ["calibrationId", "capturedAt", "metadataSha256", "providerReportedAt", "status"], "CalibrationEvidence");
  if (!CALIBRATION_STATUSES.has(evidence.status)) throw new Error("unsupported calibration evidence status");
  const normalized = {
    status: evidence.status,
    calibrationId: nullableText(evidence.calibrationId, "calibrationId", { pattern: TOKEN_RE }),
    capturedAt: nullableTimestamp(evidence.capturedAt, "calibration capturedAt"),
    providerReportedAt: nullableTimestamp(evidence.providerReportedAt, "calibration providerReportedAt"),
    metadataSha256: nullableSha(evidence.metadataSha256, "calibration metadata hash"),
  };
  if (normalized.status === "CAPTURED") {
    if (!normalized.calibrationId || !normalized.capturedAt || !normalized.metadataSha256) throw new Error("captured calibration evidence is incomplete");
  } else if (normalized.status === "SIMULATOR_NOT_APPLICABLE") {
    if (normalized.calibrationId || normalized.capturedAt || normalized.providerReportedAt || normalized.metadataSha256) throw new Error("simulator calibration evidence must not fabricate hardware metadata");
  } else if (normalized.calibrationId || normalized.capturedAt || normalized.metadataSha256) {
    throw new Error("provider-not-exposed calibration must not fabricate calibration fields");
  }
  return freeze(normalized);
}

function normalizeHardwareIdentity(identity) {
  if (identity === null) return null;
  exactKeys(identity, ["capabilitiesSha256", "deviceId", "deviceType", "manufacturer", "topologySha256"], "hardwareIdentity");
  const normalized = {
    manufacturer: text(identity.manufacturer, "hardware manufacturer"),
    deviceId: text(identity.deviceId, "hardware deviceId", { pattern: TOKEN_RE }),
    deviceType: text(identity.deviceType, "hardware deviceType", { pattern: TOKEN_RE }),
    topologySha256: nullableSha(identity.topologySha256, "hardware topology hash"),
    capabilitiesSha256: nullableSha(identity.capabilitiesSha256, "hardware capabilities hash"),
  };
  if (normalized.deviceType !== "QPU") throw new Error("physical hardware identity must be QPU");
  if (PHYSICAL_IDENTITY_FORBIDDEN_RE.test(normalized.manufacturer) || PHYSICAL_IDENTITY_FORBIDDEN_RE.test(normalized.deviceId)) throw new Error("physical hardware identity cannot use simulator/mock/test identity");
  return freeze(normalized);
}

function normalizeReproducibilityMetadata(metadata) {
  exactKeys(metadata, ["adapterId", "adapterVersion", "compiler", "compilerVersion", "providerSdk", "providerSdkVersion", "seed"], "reproducibilityMetadata");
  return freeze({
    adapterId: text(metadata.adapterId, "reproducibility adapterId", { pattern: TOKEN_RE }),
    adapterVersion: text(metadata.adapterVersion, "reproducibility adapterVersion", { pattern: TOKEN_RE }),
    providerSdk: nullableText(metadata.providerSdk, "providerSdk"),
    providerSdkVersion: nullableText(metadata.providerSdkVersion, "providerSdkVersion"),
    compiler: nullableText(metadata.compiler, "compiler"),
    compilerVersion: nullableText(metadata.compilerVersion, "compilerVersion"),
    seed: nullableText(metadata.seed, "seed"),
  });
}

function normalizeTimestamps(timestamps, backendFamily) {
  exactKeys(timestamps, ["completedAt", "startedAt", "submittedAt"], "execution timestamps");
  const normalized = {
    submittedAt: nullableTimestamp(timestamps.submittedAt, "submittedAt"),
    startedAt: nullableTimestamp(timestamps.startedAt, "startedAt"),
    completedAt: nullableTimestamp(timestamps.completedAt, "completedAt"),
  };
  if (backendFamily === "PHYSICAL_QPU") {
    if (!normalized.submittedAt || !normalized.startedAt || !normalized.completedAt) throw new Error("physical QPU timestamps are required");
    if (Date.parse(normalized.startedAt) < Date.parse(normalized.submittedAt) || Date.parse(normalized.completedAt) < Date.parse(normalized.startedAt)) throw new Error("physical QPU timestamps out of order");
  } else if (normalized.submittedAt || normalized.startedAt || normalized.completedAt) {
    throw new Error("deterministic simulator receipt must not invent provider timestamps");
  }
  return freeze(normalized);
}

function normalizeTiming(timing) {
  exactKeys(timing, ["executionTimeMillis", "providerReportedTotalMillis", "queueTimeMillis"], "execution timing");
  return freeze({
    queueTimeMillis: nullableInteger(timing.queueTimeMillis, "queueTimeMillis"),
    executionTimeMillis: nullableInteger(timing.executionTimeMillis, "executionTimeMillis"),
    providerReportedTotalMillis: nullableInteger(timing.providerReportedTotalMillis, "providerReportedTotalMillis"),
  });
}

export function normalizeMeasurementCounts(counts, { logicalQubitCount, shotsCompleted, allowEmpty = false }) {
  if (!counts || typeof counts !== "object" || Array.isArray(counts)) throw new Error("measurementCounts must be object");
  const normalized = {};
  let total = 0;
  for (const key of Object.keys(counts).sort(compareStrings)) {
    if (!new RegExp(`^[01]{${logicalQubitCount}}$`).test(key)) throw new Error(`invalid measurement bitstring:${key}`);
    const value = integer(counts[key], `measurement count ${key}`, 1);
    normalized[key] = value;
    total += value;
    if (!Number.isSafeInteger(total)) throw new Error("measurement count total overflow");
  }
  if (!allowEmpty && Object.keys(normalized).length === 0) throw new Error("measurementCounts cannot be empty");
  if (total !== shotsCompleted) throw new Error("measurement count total does not equal shotsCompleted");
  return freeze(normalized);
}

export function buildResultDigest({ rawResultSha256, measurementCounts, shotsCompleted, jobId }) {
  return canonicalQuantumSha256({
    rawResultSha256: sha(rawResultSha256, "raw result hash"),
    measurementCounts,
    shotsCompleted: integer(shotsCompleted, "shotsCompleted"),
    jobId: text(jobId, "jobId", { pattern: TOKEN_RE }),
  });
}

export function buildExecutionReceipt(input) {
  exactKeys(input, [
    "backendDevice", "backendFamily", "calibrationEvidence", "circuitSha256", "hardwareExecution", "hardwareIdentity",
    "jobId", "measurementCounts", "optimizationModelSha256", "optimizationProblemReportSha256", "problemBindingSha256",
    "provider", "providerReceiptSha256", "rawResultSha256", "reproducibilityMetadata", "shotsCompleted", "shotsRequested",
    "status", "timing", "timestamps", "transpilationApplied", "transpiledCircuitSha256",
  ], "ExecutionReceipt input");
  const backendFamily = text(input.backendFamily, "backendFamily", { pattern: TOKEN_RE });
  if (!["SIMULATOR", "PHYSICAL_QPU"].includes(backendFamily)) throw new Error("unsupported backendFamily");
  const hardwareExecution = bool(input.hardwareExecution, "hardwareExecution");
  if ((backendFamily === "PHYSICAL_QPU") !== hardwareExecution) throw new Error("hardwareExecution/backendFamily mismatch");
  const provider = text(input.provider, "provider", { pattern: TOKEN_RE });
  const backendDevice = text(input.backendDevice, "backendDevice", { pattern: TOKEN_RE });
  if (backendFamily === "PHYSICAL_QPU" && (PHYSICAL_IDENTITY_FORBIDDEN_RE.test(provider) || PHYSICAL_IDENTITY_FORBIDDEN_RE.test(backendDevice))) throw new Error("physical QPU receipt cannot use simulator/mock/test identity");
  const jobId = text(input.jobId, "jobId", { pattern: TOKEN_RE });
  const status = text(input.status, "execution status", { pattern: TOKEN_RE });
  if (!RECEIPT_STATUSES.has(status)) throw new Error("unsupported execution status");
  const shotsRequested = integer(input.shotsRequested, "shotsRequested");
  const shotsCompleted = integer(input.shotsCompleted, "shotsCompleted");
  const calibrationEvidence = validateCalibrationEvidence(input.calibrationEvidence);
  const transpilationApplied = bool(input.transpilationApplied, "transpilationApplied");
  const transpiledCircuitSha256 = nullableSha(input.transpiledCircuitSha256, "transpiled circuit hash");
  if (!transpilationApplied && transpiledCircuitSha256) throw new Error("transpiled circuit hash cannot exist when transpilation was not applied");
  const rawResultSha256 = sha(input.rawResultSha256, "raw result hash");
  const normalizedCounts = normalizeMeasurementCounts(input.measurementCounts, {
    logicalQubitCount: backendFamily === "SIMULATOR" ? 1 : Math.max(1, ...Object.keys(input.measurementCounts).map((key) => key.length)),
    shotsCompleted,
    allowEmpty: shotsCompleted === 0,
  });
  const hardwareIdentity = normalizeHardwareIdentity(input.hardwareIdentity);
  if (backendFamily === "PHYSICAL_QPU") {
    if (shotsRequested < 1 || shotsCompleted > shotsRequested) throw new Error("physical QPU shot counts invalid");
    if (status === "SUCCEEDED" && shotsCompleted < 1) throw new Error("successful physical QPU execution requires completed shots");
    if (!input.providerReceiptSha256 || !hardwareIdentity) throw new Error("physical QPU receipt requires provider receipt digest and hardware identity");
    if (calibrationEvidence.status === "SIMULATOR_NOT_APPLICABLE") throw new Error("physical QPU cannot use simulator calibration status");
  } else {
    if (shotsRequested !== 0 || shotsCompleted !== 0 || Object.keys(normalizedCounts).length !== 0) throw new Error("statevector simulator receipt must use zero shots and no measurement counts");
    if (input.providerReceiptSha256 !== null || hardwareIdentity !== null) throw new Error("simulator receipt must not fabricate provider receipt or hardware identity");
    if (calibrationEvidence.status !== "SIMULATOR_NOT_APPLICABLE") throw new Error("simulator calibration status invalid");
  }
  const unsigned = {
    schemaVersion: SCHEMA_VERSION,
    receiptKind: "NEXUS_QUANTUM_EXECUTION_RECEIPT_V1",
    backendFamily,
    hardwareExecution,
    provider,
    backendDevice,
    jobId,
    status,
    timestamps: normalizeTimestamps(input.timestamps, backendFamily),
    timing: normalizeTiming(input.timing),
    shotsRequested,
    shotsCompleted,
    problemBindingSha256: sha(input.problemBindingSha256, "receipt problem binding hash"),
    optimizationProblemReportSha256: sha(input.optimizationProblemReportSha256, "receipt optimization report hash"),
    optimizationModelSha256: sha(input.optimizationModelSha256, "receipt optimization model hash"),
    circuitSha256: sha(input.circuitSha256, "receipt circuit hash"),
    transpilationApplied,
    transpiledCircuitSha256,
    calibrationEvidence,
    rawResultSha256,
    measurementCounts: normalizedCounts,
    resultDigest: buildResultDigest({ rawResultSha256, measurementCounts: normalizedCounts, shotsCompleted, jobId }),
    hardwareIdentity,
    providerReceiptSha256: nullableSha(input.providerReceiptSha256, "provider receipt hash"),
    reproducibilityMetadata: normalizeReproducibilityMetadata(input.reproducibilityMetadata),
  };
  return freeze({ ...unsigned, receiptSha256: canonicalQuantumSha256(unsigned) });
}

export function validateExecutionReceipt(receipt) {
  exactKeys(receipt, [
    "backendDevice", "backendFamily", "calibrationEvidence", "circuitSha256", "hardwareExecution", "hardwareIdentity", "jobId",
    "measurementCounts", "optimizationModelSha256", "optimizationProblemReportSha256", "problemBindingSha256", "provider",
    "providerReceiptSha256", "rawResultSha256", "receiptKind", "receiptSha256", "reproducibilityMetadata", "resultDigest",
    "schemaVersion", "shotsCompleted", "shotsRequested", "status", "timing", "timestamps", "transpilationApplied", "transpiledCircuitSha256",
  ], "ExecutionReceipt");
  if (receipt.schemaVersion !== SCHEMA_VERSION || receipt.receiptKind !== "NEXUS_QUANTUM_EXECUTION_RECEIPT_V1") throw new Error("unsupported ExecutionReceipt schema");
  const rebuilt = buildExecutionReceipt({
    backendFamily: receipt.backendFamily, hardwareExecution: receipt.hardwareExecution, provider: receipt.provider,
    backendDevice: receipt.backendDevice, jobId: receipt.jobId, status: receipt.status, timestamps: receipt.timestamps,
    timing: receipt.timing, shotsRequested: receipt.shotsRequested, shotsCompleted: receipt.shotsCompleted,
    problemBindingSha256: receipt.problemBindingSha256, optimizationProblemReportSha256: receipt.optimizationProblemReportSha256,
    optimizationModelSha256: receipt.optimizationModelSha256, circuitSha256: receipt.circuitSha256,
    transpilationApplied: receipt.transpilationApplied, transpiledCircuitSha256: receipt.transpiledCircuitSha256,
    calibrationEvidence: receipt.calibrationEvidence, rawResultSha256: receipt.rawResultSha256,
    measurementCounts: receipt.measurementCounts, hardwareIdentity: receipt.hardwareIdentity,
    providerReceiptSha256: receipt.providerReceiptSha256, reproducibilityMetadata: receipt.reproducibilityMetadata,
  });
  if (rebuilt.resultDigest !== sha(receipt.resultDigest, "resultDigest")) throw new Error("ResultDigest mismatch");
  if (rebuilt.receiptSha256 !== sha(receipt.receiptSha256, "receiptSha256")) throw new Error("ExecutionReceipt hash mismatch");
  return rebuilt;
}

export const CalibrationEvidence = Object.freeze({ validate: validateCalibrationEvidence });
export const ResultDigest = Object.freeze({ build: buildResultDigest });
export const ExecutionReceipt = Object.freeze({ build: buildExecutionReceipt, validate: validateExecutionReceipt });
