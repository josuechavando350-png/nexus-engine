export type FrictionDeviceClass = "MOBILE" | "DESKTOP";
export type FrictionRiskBand = "LOW" | "MEDIUM" | "HIGH";

export interface FrictionSnapshot {
  readonly schemaVersion: 1;
  readonly deviceClass: FrictionDeviceClass;
  readonly elapsedMs: number;
  readonly scrollDepthBps: number;
  readonly maxInteractionLatencyMs: number;
  readonly interactionCount: number;
  readonly validationErrorCount: number;
  readonly repeatedActionCount: number;
  readonly longTaskCount: number;
  readonly visibilityLossCount: number;
}

export interface FrictionProbabilityModel {
  readonly schemaVersion: 1;
  readonly modelId: string;
  readonly sourceDigest: `sha256:${string}`;
  readonly intercept: number;
  readonly coefficients: Readonly<{
    interactionLatency: number;
    validationErrorRatio: number;
    repeatedActionRatio: number;
    longTaskRate: number;
    visibilityLossRate: number;
    scrollDeficit: number;
    mobileIndicator: number;
  }>;
  readonly lowRiskMax: number;
  readonly mediumRiskMax: number;
}

export interface FrictionScore {
  readonly schemaVersion: 1;
  readonly estimator: "CONFIGURED_LOGISTIC_MODEL_V1";
  readonly modelId: string;
  readonly modelSourceDigest: `sha256:${string}`;
  readonly deviceClass: FrictionDeviceClass;
  readonly abandonmentProbability: number;
  readonly riskBand: FrictionRiskBand;
  readonly evidence: Readonly<{
    interactionLatency: number;
    validationErrorRatio: number;
    repeatedActionRatio: number;
    longTaskRate: number;
    visibilityLossRate: number;
    scrollDeficit: number;
  }>;
}

const SNAPSHOT_KEYS = [
  "deviceClass",
  "elapsedMs",
  "interactionCount",
  "longTaskCount",
  "maxInteractionLatencyMs",
  "repeatedActionCount",
  "schemaVersion",
  "scrollDepthBps",
  "validationErrorCount",
  "visibilityLossCount",
].sort().join(",");
const MODEL_KEYS = ["coefficients", "intercept", "lowRiskMax", "mediumRiskMax", "modelId", "schemaVersion", "sourceDigest"].sort().join(",");
const COEFFICIENT_KEYS = [
  "interactionLatency",
  "longTaskRate",
  "mobileIndicator",
  "repeatedActionRatio",
  "scrollDeficit",
  "validationErrorRatio",
  "visibilityLossRate",
].sort().join(",");
const MODEL_ID = /^[A-Za-z0-9](?:[A-Za-z0-9._:-]{0,127})$/u;
const SHA256 = /^sha256:[0-9a-f]{64}$/u;

function boundedInteger(value: unknown, label: string, min: number, max: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < min || (value as number) > max) throw new Error(`${label} must be an integer in ${min}..${max}`);
  return value as number;
}

function boundedNumber(value: unknown, label: string, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max) throw new Error(`${label} must be a finite number in ${min}..${max}`);
  return value;
}

function exactPlainObject(value: unknown, label: string, expectedKeys: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) throw new Error(`${label} must be a plain object`);
  const input = value as Record<string, unknown>;
  if (Object.keys(input).sort().join(",") !== expectedKeys) throw new Error(`${label} has unknown or missing fields`);
  return input;
}

function unit(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function roundProbability(value: number): number {
  return Math.round(unit(value) * 10_000) / 10_000;
}

export function parseFrictionSnapshot(value: unknown): FrictionSnapshot {
  const input = exactPlainObject(value, "friction snapshot", SNAPSHOT_KEYS);
  if (input.schemaVersion !== 1) throw new Error("friction snapshot schemaVersion must be 1");
  if (!(input.deviceClass === "MOBILE" || input.deviceClass === "DESKTOP")) throw new Error("friction snapshot deviceClass is invalid");
  return Object.freeze({
    schemaVersion: 1,
    deviceClass: input.deviceClass,
    elapsedMs: boundedInteger(input.elapsedMs, "elapsedMs", 0, 1_800_000),
    scrollDepthBps: boundedInteger(input.scrollDepthBps, "scrollDepthBps", 0, 10_000),
    maxInteractionLatencyMs: boundedInteger(input.maxInteractionLatencyMs, "maxInteractionLatencyMs", 0, 10_000),
    interactionCount: boundedInteger(input.interactionCount, "interactionCount", 0, 500),
    validationErrorCount: boundedInteger(input.validationErrorCount, "validationErrorCount", 0, 100),
    repeatedActionCount: boundedInteger(input.repeatedActionCount, "repeatedActionCount", 0, 100),
    longTaskCount: boundedInteger(input.longTaskCount, "longTaskCount", 0, 500),
    visibilityLossCount: boundedInteger(input.visibilityLossCount, "visibilityLossCount", 0, 100),
  });
}

export function parseFrictionProbabilityModel(value: unknown): FrictionProbabilityModel {
  const input = exactPlainObject(value, "friction probability model", MODEL_KEYS);
  if (input.schemaVersion !== 1) throw new Error("friction probability model schemaVersion must be 1");
  if (typeof input.modelId !== "string" || !MODEL_ID.test(input.modelId)) throw new Error("friction probability modelId is invalid");
  if (typeof input.sourceDigest !== "string" || !SHA256.test(input.sourceDigest)) throw new Error("friction probability sourceDigest is invalid");
  const coefficientInput = exactPlainObject(input.coefficients, "friction probability coefficients", COEFFICIENT_KEYS);
  const lowRiskMax = boundedNumber(input.lowRiskMax, "lowRiskMax", 0.0001, 0.9998);
  const mediumRiskMax = boundedNumber(input.mediumRiskMax, "mediumRiskMax", 0.0002, 0.9999);
  if (mediumRiskMax <= lowRiskMax) throw new Error("mediumRiskMax must be greater than lowRiskMax");
  const coefficients = Object.freeze({
    interactionLatency: boundedNumber(coefficientInput.interactionLatency, "interactionLatency coefficient", -32, 32),
    validationErrorRatio: boundedNumber(coefficientInput.validationErrorRatio, "validationErrorRatio coefficient", -32, 32),
    repeatedActionRatio: boundedNumber(coefficientInput.repeatedActionRatio, "repeatedActionRatio coefficient", -32, 32),
    longTaskRate: boundedNumber(coefficientInput.longTaskRate, "longTaskRate coefficient", -32, 32),
    visibilityLossRate: boundedNumber(coefficientInput.visibilityLossRate, "visibilityLossRate coefficient", -32, 32),
    scrollDeficit: boundedNumber(coefficientInput.scrollDeficit, "scrollDeficit coefficient", -32, 32),
    mobileIndicator: boundedNumber(coefficientInput.mobileIndicator, "mobileIndicator coefficient", -32, 32),
  });
  return Object.freeze({
    schemaVersion: 1,
    modelId: input.modelId,
    sourceDigest: input.sourceDigest as `sha256:${string}`,
    intercept: boundedNumber(input.intercept, "intercept", -32, 32),
    coefficients,
    lowRiskMax,
    mediumRiskMax,
  });
}

export function scoreFrictionAbandonment(snapshotInput: unknown, modelInput: unknown): FrictionScore {
  const snapshot = parseFrictionSnapshot(snapshotInput);
  const model = parseFrictionProbabilityModel(modelInput);
  const interactions = Math.max(1, snapshot.interactionCount);
  const elapsedSeconds = Math.max(1, snapshot.elapsedMs / 1000);

  const interactionLatency = unit((snapshot.maxInteractionLatencyMs - 200) / 300);
  const validationErrorRatio = unit(snapshot.validationErrorCount / interactions);
  const repeatedActionRatio = unit(snapshot.repeatedActionCount / interactions);
  const longTaskRate = unit(snapshot.longTaskCount / Math.max(1, elapsedSeconds / 10));
  const visibilityLossRate = unit(snapshot.visibilityLossCount / Math.max(1, elapsedSeconds / 30));
  const scrollDeficit = unit(1 - snapshot.scrollDepthBps / 10_000);

  const evidence = Object.freeze({
    interactionLatency: roundProbability(interactionLatency),
    validationErrorRatio: roundProbability(validationErrorRatio),
    repeatedActionRatio: roundProbability(repeatedActionRatio),
    longTaskRate: roundProbability(longTaskRate),
    visibilityLossRate: roundProbability(visibilityLossRate),
    scrollDeficit: roundProbability(scrollDeficit),
  });
  const linear = model.intercept
    + model.coefficients.interactionLatency * interactionLatency
    + model.coefficients.validationErrorRatio * validationErrorRatio
    + model.coefficients.repeatedActionRatio * repeatedActionRatio
    + model.coefficients.longTaskRate * longTaskRate
    + model.coefficients.visibilityLossRate * visibilityLossRate
    + model.coefficients.scrollDeficit * scrollDeficit
    + model.coefficients.mobileIndicator * (snapshot.deviceClass === "MOBILE" ? 1 : 0);
  const abandonmentProbability = roundProbability(1 / (1 + Math.exp(-linear)));
  const riskBand: FrictionRiskBand = abandonmentProbability < model.lowRiskMax
    ? "LOW"
    : abandonmentProbability < model.mediumRiskMax
      ? "MEDIUM"
      : "HIGH";

  return Object.freeze({
    schemaVersion: 1,
    estimator: "CONFIGURED_LOGISTIC_MODEL_V1",
    modelId: model.modelId,
    modelSourceDigest: model.sourceDigest,
    deviceClass: snapshot.deviceClass,
    abandonmentProbability,
    riskBand,
    evidence,
  });
}
