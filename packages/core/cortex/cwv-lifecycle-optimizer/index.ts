export type CwvLifecycleState = "NORMAL" | "PRESSURE" | "PAUSED";

export interface CwvLifecycleSample {
  readonly visibility: "VISIBLE" | "HIDDEN";
  readonly lcpMs: number | null;
  readonly cls: number;
  readonly inpMs: number | null;
  readonly recentLongTaskMs: number;
}

export interface CwvLifecycleThresholds {
  readonly lcpPressureMs: number;
  readonly clsPressure: number;
  readonly inpPressureMs: number;
  readonly longTaskPressureMs: number;
}

export interface CwvLifecycleDecision {
  readonly state: CwvLifecycleState;
  readonly reasons: readonly ("HIDDEN" | "LCP" | "CLS" | "INP" | "LONG_TASK")[];
  readonly shouldSuspendSpeculation: boolean;
}

export const DEFAULT_CWV_LIFECYCLE_THRESHOLDS: CwvLifecycleThresholds = Object.freeze({
  lcpPressureMs: 2_500,
  clsPressure: 0.1,
  inpPressureMs: 200,
  longTaskPressureMs: 250,
});

function finite(value: unknown, label: string, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max) throw new TypeError(`${label} is out of range`);
  return value;
}

function nullableMetric(value: unknown, label: string, max: number): number | null {
  return value === null ? null : finite(value, label, 0, max);
}

export function evaluateCwvLifecycle(
  sampleInput: CwvLifecycleSample,
  thresholdsInput: CwvLifecycleThresholds = DEFAULT_CWV_LIFECYCLE_THRESHOLDS,
): CwvLifecycleDecision {
  if (!sampleInput || typeof sampleInput !== "object" || Array.isArray(sampleInput) || Object.keys(sampleInput).sort().join(",") !== "cls,inpMs,lcpMs,recentLongTaskMs,visibility") throw new TypeError("CWV sample contract is invalid");
  if (!(sampleInput.visibility === "VISIBLE" || sampleInput.visibility === "HIDDEN")) throw new TypeError("visibility is invalid");
  const sample = {
    visibility: sampleInput.visibility,
    lcpMs: nullableMetric(sampleInput.lcpMs, "lcpMs", 600_000),
    cls: finite(sampleInput.cls, "cls", 0, 100),
    inpMs: nullableMetric(sampleInput.inpMs, "inpMs", 60_000),
    recentLongTaskMs: finite(sampleInput.recentLongTaskMs, "recentLongTaskMs", 0, 60_000),
  } as const;
  const thresholds = {
    lcpPressureMs: finite(thresholdsInput.lcpPressureMs, "lcpPressureMs", 100, 60_000),
    clsPressure: finite(thresholdsInput.clsPressure, "clsPressure", 0.001, 10),
    inpPressureMs: finite(thresholdsInput.inpPressureMs, "inpPressureMs", 10, 10_000),
    longTaskPressureMs: finite(thresholdsInput.longTaskPressureMs, "longTaskPressureMs", 50, 10_000),
  } as const;
  if (sample.visibility === "HIDDEN") return Object.freeze({ state: "PAUSED", reasons: Object.freeze(["HIDDEN"] as const), shouldSuspendSpeculation: true });
  const reasons: ("LCP" | "CLS" | "INP" | "LONG_TASK")[] = [];
  if (sample.lcpMs !== null && sample.lcpMs > thresholds.lcpPressureMs) reasons.push("LCP");
  if (sample.cls > thresholds.clsPressure) reasons.push("CLS");
  if (sample.inpMs !== null && sample.inpMs > thresholds.inpPressureMs) reasons.push("INP");
  if (sample.recentLongTaskMs > thresholds.longTaskPressureMs) reasons.push("LONG_TASK");
  return Object.freeze({ state: reasons.length ? "PRESSURE" : "NORMAL", reasons: Object.freeze(reasons), shouldSuspendSpeculation: reasons.length > 0 });
}
