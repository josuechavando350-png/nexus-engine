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

export interface FrictionScore {
  readonly schemaVersion: 1;
  readonly estimator: "DETERMINISTIC_FRICTION_INDEX_V1";
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

const EXACT_KEYS = [
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

function boundedInteger(value: unknown, label: string, min: number, max: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < min || (value as number) > max) throw new Error(`${label} must be an integer in ${min}..${max}`);
  return value as number;
}

function unit(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function roundProbability(value: number): number {
  return Math.round(unit(value) * 10_000) / 10_000;
}

export function parseFrictionSnapshot(value: unknown): FrictionSnapshot {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) throw new Error("friction snapshot must be a plain object");
  const input = value as Record<string, unknown>;
  if (Object.keys(input).sort().join(",") !== EXACT_KEYS) throw new Error("friction snapshot has unknown or missing fields");
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

export function scoreFrictionAbandonment(snapshotInput: unknown): FrictionScore {
  const snapshot = parseFrictionSnapshot(snapshotInput);
  const interactions = Math.max(1, snapshot.interactionCount);
  const elapsedSeconds = Math.max(1, snapshot.elapsedMs / 1000);

  // INP-style friction: <=200 ms contributes no latency friction and >=500 ms saturates it.
  const interactionLatency = unit((snapshot.maxInteractionLatencyMs - 200) / 300);
  const validationErrorRatio = unit(snapshot.validationErrorCount / interactions);
  const repeatedActionRatio = unit(snapshot.repeatedActionCount / interactions);
  // Long Tasks are already browser-defined >=50 ms; normalize by observed session time rather than an invented identity/profile prior.
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
  const abandonmentProbability = roundProbability((
    interactionLatency + validationErrorRatio + repeatedActionRatio + longTaskRate + visibilityLossRate + scrollDeficit
  ) / 6);
  const riskBand: FrictionRiskBand = abandonmentProbability < 1 / 3 ? "LOW" : abandonmentProbability < 2 / 3 ? "MEDIUM" : "HIGH";

  return Object.freeze({
    schemaVersion: 1,
    estimator: "DETERMINISTIC_FRICTION_INDEX_V1",
    deviceClass: snapshot.deviceClass,
    abandonmentProbability,
    riskBand,
    evidence,
  });
}
