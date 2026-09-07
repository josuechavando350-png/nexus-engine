import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { designGeoHoldout, type GeoHoldoutDesign, type GeoHoldoutDesignInput, type GeoOutcome } from "./index";
import { SqliteGeoExperimentRegistry, type GeoExperimentRecord } from "./registry";

export type GeoCapabilityGateReason = "POWER_SUFFICIENT" | "DESIGN_REJECTED" | "BASELINE_VOLUME_INSUFFICIENT" | "BASELINE_VARIANCE_UNINFORMATIVE" | "POWER_INSUFFICIENT";

export interface GeoCapabilityGateInput {
  readonly design: GeoHoldoutDesignInput;
  readonly minimumDetectableRelativeLift: number;
  readonly targetPower: number;
  readonly alpha: number;
  readonly varianceInflation: number;
  readonly minimumBaselineTotal: number;
}

export interface GeoCapabilityGateResult {
  readonly experimentId: string;
  readonly designDigest: `sha256:${string}`;
  readonly status: "ALLOWED" | "BLOCKED";
  readonly reason: GeoCapabilityGateReason;
  readonly treatmentGeos: number;
  readonly controlGeos: number;
  readonly baselineMean: number;
  readonly baselineStandardDeviation: number;
  readonly baselineTotal: number;
  readonly minimumDetectableRelativeLift: number;
  readonly minimumDetectableAbsoluteLift: number;
  readonly targetPower: number;
  readonly achievedPower: number;
  readonly alpha: number;
  readonly varianceInflation: number;
  readonly gateDigest: `sha256:${string}`;
}

export class GeoCapabilityGateError extends Error {
  constructor(public readonly code: "INVALID_INPUT" | "CAPABILITY_BLOCKED" | "CONFLICT" | "INTEGRITY_FAILURE", message: string) {
    super(message);
    this.name = "GeoCapabilityGateError";
  }
}

function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`;
}

function digest(value: unknown): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(canonical(value), "utf8").digest("hex")}`;
}

function bounded(value: number, label: string, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max) throw new GeoCapabilityGateError("INVALID_INPUT", `${label} must be within ${min}..${max}`);
  return value;
}

function mean(values: readonly number[]): number { return values.reduce((sum, value) => sum + value, 0) / values.length; }
function variance(values: readonly number[]): number {
  if (values.length < 2) return 0;
  const avg = mean(values);
  return values.reduce((sum, value) => sum + (value - avg) ** 2, 0) / (values.length - 1);
}
function round(value: number): number { return Math.round((value + Number.EPSILON) * 1_000_000) / 1_000_000; }

// Abramowitz-Stegun approximation, sufficient for capability gating and fully deterministic.
function normalCdf(x: number): number {
  const sign = x < 0 ? -1 : 1;
  const z = Math.abs(x) / Math.sqrt(2);
  const t = 1 / (1 + 0.3275911 * z);
  const erf = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-z * z);
  return 0.5 * (1 + sign * erf);
}

function inverseNormal(p: number): number {
  if (!(p > 0 && p < 1)) throw new GeoCapabilityGateError("INVALID_INPUT", "normal quantile p must be within (0,1)");
  // Peter J. Acklam rational approximation.
  const a = [-39.69683028665376, 220.9460984245205, -275.9285104469687, 138.357751867269, -30.66479806614716, 2.506628277459239];
  const b = [-54.47609879822406, 161.5858368580409, -155.6989798598866, 66.80131188771972, -13.28068155288572];
  const c = [-0.007784894002430293, -0.3223964580411365, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
  const d = [0.007784695709041462, 0.3224671290700398, 2.445134137142996, 3.754408661907416];
  const plow = 0.02425;
  const phigh = 1 - plow;
  if (p < plow) {
    const q = Math.sqrt(-2 * Math.log(p));
    return (((((c[0]! * q + c[1]!) * q + c[2]!) * q + c[3]!) * q + c[4]!) * q + c[5]!) / ((((d[0]! * q + d[1]!) * q + d[2]!) * q + d[3]!) * q + 1);
  }
  if (p > phigh) {
    const q = Math.sqrt(-2 * Math.log(1 - p));
    return -(((((c[0]! * q + c[1]!) * q + c[2]!) * q + c[3]!) * q + c[4]!) * q + c[5]!) / ((((d[0]! * q + d[1]!) * q + d[2]!) * q + d[3]!) * q + 1);
  }
  const q = p - 0.5;
  const r = q * q;
  return (((((a[0]! * r + a[1]!) * r + a[2]!) * r + a[3]!) * r + a[4]!) * r + a[5]!) * q / (((((b[0]! * r + b[1]!) * r + b[2]!) * r + b[3]!) * r + b[4]!) * r + 1);
}

export function evaluateGeoCapabilityGate(input: GeoCapabilityGateInput): GeoCapabilityGateResult {
  if (!input || typeof input !== "object") throw new GeoCapabilityGateError("INVALID_INPUT", "capability gate input is required");
  const minimumDetectableRelativeLift = bounded(input.minimumDetectableRelativeLift, "minimumDetectableRelativeLift", 0.001, 2);
  const targetPower = bounded(input.targetPower, "targetPower", 0.5, 0.999);
  const alpha = bounded(input.alpha, "alpha", 0.001, 0.2);
  const varianceInflation = bounded(input.varianceInflation, "varianceInflation", 1, 10);
  const minimumBaselineTotal = bounded(input.minimumBaselineTotal, "minimumBaselineTotal", 0, 1e18);
  const design = designGeoHoldout(input.design);
  const treatment = design.assignments.filter((item) => item.arm === "TREATMENT");
  const control = design.assignments.filter((item) => item.arm === "CONTROL");
  const values = design.assignments.map((item) => item.baselineOutcome);
  const baselineMean = values.length ? mean(values) : 0;
  const baselineTotal = values.reduce((sum, value) => sum + value, 0);
  const baselineStandardDeviation = Math.sqrt(variance(values));
  const absoluteLift = baselineMean * minimumDetectableRelativeLift;
  let achievedPower = 0;
  if (design.status === "READY" && baselineStandardDeviation > 0 && treatment.length > 0 && control.length > 0) {
    const standardError = baselineStandardDeviation * Math.sqrt(varianceInflation) * Math.sqrt(1 / treatment.length + 1 / control.length);
    const nonCentrality = standardError > 0 ? absoluteLift / standardError : 0;
    const zAlpha = inverseNormal(1 - alpha / 2);
    achievedPower = 1 - normalCdf(zAlpha - nonCentrality) + normalCdf(-zAlpha - nonCentrality);
  }
  let reason: GeoCapabilityGateReason;
  if (design.status !== "READY") reason = "DESIGN_REJECTED";
  else if (baselineTotal < minimumBaselineTotal) reason = "BASELINE_VOLUME_INSUFFICIENT";
  else if (!(baselineStandardDeviation > 0) || !(baselineMean > 0)) reason = "BASELINE_VARIANCE_UNINFORMATIVE";
  else if (achievedPower < targetPower) reason = "POWER_INSUFFICIENT";
  else reason = "POWER_SUFFICIENT";
  const base = {
    experimentId: design.experimentId,
    designDigest: design.designDigest,
    status: reason === "POWER_SUFFICIENT" ? "ALLOWED" as const : "BLOCKED" as const,
    reason,
    treatmentGeos: treatment.length,
    controlGeos: control.length,
    baselineMean: round(baselineMean),
    baselineStandardDeviation: round(baselineStandardDeviation),
    baselineTotal: round(baselineTotal),
    minimumDetectableRelativeLift,
    minimumDetectableAbsoluteLift: round(absoluteLift),
    targetPower,
    achievedPower: round(Math.max(0, Math.min(1, achievedPower))),
    alpha,
    varianceInflation,
  };
  return Object.freeze({ ...base, gateDigest: digest(base) });
}

export class SqliteGeoCapabilityGateStore {
  private readonly db: DatabaseSync;
  constructor(databasePath: string, private readonly now: () => number = Date.now) {
    if (!databasePath) throw new GeoCapabilityGateError("INVALID_INPUT", "databasePath is required");
    this.db = new DatabaseSync(databasePath);
    this.db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;");
    this.db.exec(`CREATE TABLE IF NOT EXISTS cortex32_capability_gate(
      experiment_id TEXT PRIMARY KEY,
      design_digest TEXT NOT NULL,
      gate_digest TEXT NOT NULL,
      result_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    );`);
  }
  close(): void { this.db.close(); }
  record(result: GeoCapabilityGateResult): GeoCapabilityGateResult {
    const row = this.db.prepare("SELECT result_json FROM cortex32_capability_gate WHERE experiment_id=?").get(result.experimentId) as { result_json?: unknown } | undefined;
    if (row) {
      const existing = JSON.parse(String(row.result_json)) as GeoCapabilityGateResult;
      if (existing.gateDigest !== result.gateDigest) throw new GeoCapabilityGateError("CONFLICT", "experimentId is already bound to a different capability gate");
      return existing;
    }
    this.db.prepare("INSERT INTO cortex32_capability_gate(experiment_id,design_digest,gate_digest,result_json,created_at) VALUES(?,?,?,?,?)").run(result.experimentId, result.designDigest, result.gateDigest, JSON.stringify(result), new Date(this.now()).toISOString());
    return result;
  }
  get(experimentId: string): GeoCapabilityGateResult | undefined {
    const row = this.db.prepare("SELECT result_json FROM cortex32_capability_gate WHERE experiment_id=?").get(experimentId) as { result_json?: unknown } | undefined;
    return row?.result_json ? JSON.parse(String(row.result_json)) as GeoCapabilityGateResult : undefined;
  }
}

export class CapabilityGatedGeoExperimentRegistry {
  constructor(private readonly base: SqliteGeoExperimentRegistry, private readonly gates: SqliteGeoCapabilityGateStore) {}
  register(input: GeoCapabilityGateInput): { readonly gate: GeoCapabilityGateResult; readonly experiment: GeoExperimentRecord } {
    const gate = this.gates.record(evaluateGeoCapabilityGate(input));
    if (gate.status !== "ALLOWED") throw new GeoCapabilityGateError("CAPABILITY_BLOCKED", `geo experiment capability blocked: ${gate.reason}`);
    const experiment = this.base.registerDesign(input.design);
    if (experiment.design.designDigest !== gate.designDigest) throw new GeoCapabilityGateError("INTEGRITY_FAILURE", "registered design differs from capability-gated design");
    return Object.freeze({ gate, experiment });
  }
  get(experimentId: string): GeoExperimentRecord | undefined { return this.base.get(experimentId); }
  analyze(experimentId: string, outcomes: readonly GeoOutcome[]): GeoExperimentRecord { return this.base.analyze(experimentId, outcomes); }
}
