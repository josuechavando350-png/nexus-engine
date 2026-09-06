import { createHash } from "node:crypto";

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{3,127}$/u;
const SHA256 = /^sha256:[0-9a-f]{64}$/u;

export interface GeoBaseline {
  readonly geoId: string;
  readonly baselineOutcome: number;
}

export interface GeoHoldoutDesignInput {
  readonly experimentId: string;
  readonly seed: string;
  readonly holdoutFraction: number;
  readonly maxBaselineImbalance: number;
  readonly minGeosPerArm: number;
  readonly geos: readonly GeoBaseline[];
}

export interface GeoAssignment {
  readonly geoId: string;
  readonly arm: "TREATMENT" | "CONTROL";
  readonly baselineOutcome: number;
}

export interface GeoHoldoutDesign {
  readonly experimentId: string;
  readonly designVersion: 1;
  readonly status: "READY" | "REJECTED";
  readonly reason: "BALANCED" | "BASELINE_IMBALANCE" | "INSUFFICIENT_ARM_SIZE";
  readonly seedDigest: `sha256:${string}`;
  readonly holdoutFraction: number;
  readonly maxBaselineImbalance: number;
  readonly minGeosPerArm: number;
  readonly baselineImbalance: number | null;
  readonly assignments: readonly GeoAssignment[];
  readonly designDigest: `sha256:${string}`;
}

export interface GeoOutcome {
  readonly geoId: string;
  readonly baselineOutcome: number;
  readonly experimentOutcome: number;
}

export interface GeoHoldoutAnalysisInput {
  readonly design: GeoHoldoutDesign;
  readonly outcomes: readonly GeoOutcome[];
}

export interface GeoHoldoutAnalysis {
  readonly experimentId: string;
  readonly designDigest: `sha256:${string}`;
  readonly treatmentGeos: number;
  readonly controlGeos: number;
  readonly treatmentMeanDelta: number;
  readonly controlMeanDelta: number;
  readonly incrementalDelta: number;
  readonly standardError: number;
  readonly confidenceInterval95: readonly [number, number];
  readonly verdict: "POSITIVE" | "NEGATIVE" | "INCONCLUSIVE";
}

export class Cortex12Error extends Error {
  constructor(public readonly code: "INVALID_INPUT" | "DESIGN_REJECTED" | "INTEGRITY_FAILURE" | "INSUFFICIENT_SAMPLE", message: string) {
    super(message);
    this.name = "Cortex12Error";
  }
}

function number(value: unknown, label: string, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max) throw new Cortex12Error("INVALID_INPUT", `${label} is out of range`);
  return value;
}

function integer(value: unknown, label: string, min: number, max: number): number {
  const parsed = number(value, label, min, max);
  if (!Number.isSafeInteger(parsed)) throw new Cortex12Error("INVALID_INPUT", `${label} must be an integer`);
  return parsed;
}

function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`;
}

function digest(value: unknown): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(canonical(value), "utf8").digest("hex")}`;
}

function rank(seed: string, geoId: string): string {
  return createHash("sha256").update(`${seed}\0${geoId}`, "utf8").digest("hex");
}

function mean(values: readonly number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function variance(values: readonly number[]): number {
  if (values.length < 2) return 0;
  const avg = mean(values);
  return values.reduce((sum, value) => sum + (value - avg) ** 2, 0) / (values.length - 1);
}

function round(value: number): number {
  return Math.round((value + Number.EPSILON) * 1_000_000) / 1_000_000;
}

function plain(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) throw new Cortex12Error("INVALID_INPUT", `${label} must be a plain object`);
  return value as Record<string, unknown>;
}

function exactKeys(raw: Record<string, unknown>, expected: readonly string[], label: string): void {
  if (Object.keys(raw).sort().join(",") !== [...expected].sort().join(",")) throw new Cortex12Error("INVALID_INPUT", `${label} contains missing or unsupported fields`);
}

function parseDesignInput(value: unknown): GeoHoldoutDesignInput {
  const raw = plain(value, "design input");
  exactKeys(raw, ["experimentId", "seed", "holdoutFraction", "maxBaselineImbalance", "minGeosPerArm", "geos"], "design contract");
  if (typeof raw.experimentId !== "string" || !ID.test(raw.experimentId)) throw new Cortex12Error("INVALID_INPUT", "experimentId is malformed");
  if (typeof raw.seed !== "string" || raw.seed.length < 16 || raw.seed.length > 256) throw new Cortex12Error("INVALID_INPUT", "seed must contain 16-256 characters");
  const holdoutFraction = number(raw.holdoutFraction, "holdoutFraction", 0.1, 0.5);
  const maxBaselineImbalance = number(raw.maxBaselineImbalance, "maxBaselineImbalance", 0, 1);
  const minGeosPerArm = integer(raw.minGeosPerArm, "minGeosPerArm", 3, 250);
  if (!Array.isArray(raw.geos) || raw.geos.length < 8 || raw.geos.length > 500) throw new Cortex12Error("INVALID_INPUT", "geos must contain 8-500 entries");
  const seen = new Set<string>();
  const geos = raw.geos.map((item): GeoBaseline => {
    const row = plain(item, "geo baseline");
    exactKeys(row, ["baselineOutcome", "geoId"], "geo baseline contract");
    if (typeof row.geoId !== "string" || !ID.test(row.geoId) || seen.has(row.geoId)) throw new Cortex12Error("INVALID_INPUT", "geoId is malformed or duplicated");
    seen.add(row.geoId);
    return Object.freeze({ geoId: row.geoId, baselineOutcome: number(row.baselineOutcome, "baselineOutcome", 0, 1e15) });
  });
  return Object.freeze({ experimentId: raw.experimentId, seed: raw.seed, holdoutFraction, maxBaselineImbalance, minGeosPerArm, geos: Object.freeze(geos) });
}

export function designGeoHoldout(value: unknown): GeoHoldoutDesign {
  const input = parseDesignInput(value);
  const sorted = [...input.geos].sort((a, b) => a.baselineOutcome - b.baselineOutcome || a.geoId.localeCompare(b.geoId));
  const desiredControls = Math.max(1, Math.min(sorted.length - 1, Math.round(sorted.length * input.holdoutFraction)));
  const controlIds = new Set<string>();
  for (let stratumIndex = 0; stratumIndex < desiredControls; stratumIndex += 1) {
    const start = Math.floor((stratumIndex * sorted.length) / desiredControls);
    const end = Math.floor(((stratumIndex + 1) * sorted.length) / desiredControls);
    const stratum = sorted.slice(start, end);
    const selected = [...stratum].sort((a, b) => rank(input.seed, a.geoId).localeCompare(rank(input.seed, b.geoId)))[0];
    if (!selected) throw new Cortex12Error("INTEGRITY_FAILURE", "stratified assignment produced an empty stratum");
    controlIds.add(selected.geoId);
  }
  const assignments = sorted.map((geo): GeoAssignment => Object.freeze({ geoId: geo.geoId, arm: controlIds.has(geo.geoId) ? "CONTROL" : "TREATMENT", baselineOutcome: geo.baselineOutcome })).sort((a, b) => a.geoId.localeCompare(b.geoId));
  const controls = assignments.filter((item) => item.arm === "CONTROL");
  const treatment = assignments.filter((item) => item.arm === "TREATMENT");
  const common = {
    experimentId: input.experimentId,
    designVersion: 1 as const,
    seedDigest: digest({ seed: input.seed }),
    holdoutFraction: input.holdoutFraction,
    maxBaselineImbalance: input.maxBaselineImbalance,
    minGeosPerArm: input.minGeosPerArm,
    assignments: Object.freeze(assignments),
  };
  if (controls.length < input.minGeosPerArm || treatment.length < input.minGeosPerArm) {
    const base = { ...common, status: "REJECTED" as const, reason: "INSUFFICIENT_ARM_SIZE" as const, baselineImbalance: null };
    return Object.freeze({ ...base, designDigest: digest(base) });
  }
  const overall = Math.max(1e-9, mean(assignments.map((item) => item.baselineOutcome)));
  const imbalance = Math.abs(mean(treatment.map((item) => item.baselineOutcome)) - mean(controls.map((item) => item.baselineOutcome))) / overall;
  const base = {
    ...common,
    status: imbalance <= input.maxBaselineImbalance ? "READY" as const : "REJECTED" as const,
    reason: imbalance <= input.maxBaselineImbalance ? "BALANCED" as const : "BASELINE_IMBALANCE" as const,
    baselineImbalance: round(imbalance),
  };
  return Object.freeze({ ...base, designDigest: digest(base) });
}

export function verifyGeoHoldoutDesign(value: unknown): GeoHoldoutDesign {
  const raw = plain(value, "geo holdout design");
  exactKeys(raw, ["experimentId", "designVersion", "status", "reason", "seedDigest", "holdoutFraction", "maxBaselineImbalance", "minGeosPerArm", "baselineImbalance", "assignments", "designDigest"], "geo holdout design");
  if (typeof raw.experimentId !== "string" || !ID.test(raw.experimentId) || raw.designVersion !== 1) throw new Cortex12Error("INTEGRITY_FAILURE", "stored design identity is invalid");
  if (!(raw.status === "READY" || raw.status === "REJECTED") || !(raw.reason === "BALANCED" || raw.reason === "BASELINE_IMBALANCE" || raw.reason === "INSUFFICIENT_ARM_SIZE") || (raw.status === "READY") !== (raw.reason === "BALANCED")) throw new Cortex12Error("INTEGRITY_FAILURE", "stored design status is invalid");
  if (typeof raw.seedDigest !== "string" || !SHA256.test(raw.seedDigest) || typeof raw.designDigest !== "string" || !SHA256.test(raw.designDigest)) throw new Cortex12Error("INTEGRITY_FAILURE", "stored design digest is invalid");
  const holdoutFraction = number(raw.holdoutFraction, "holdoutFraction", 0.1, 0.5);
  const maxBaselineImbalance = number(raw.maxBaselineImbalance, "maxBaselineImbalance", 0, 1);
  const minGeosPerArm = integer(raw.minGeosPerArm, "minGeosPerArm", 3, 250);
  const baselineImbalance = raw.baselineImbalance === null ? null : number(raw.baselineImbalance, "baselineImbalance", 0, 500);
  if (!Array.isArray(raw.assignments) || raw.assignments.length < 8 || raw.assignments.length > 500) throw new Cortex12Error("INTEGRITY_FAILURE", "stored assignments are invalid");
  const seen = new Set<string>();
  const assignments = raw.assignments.map((item): GeoAssignment => {
    const row = plain(item, "geo assignment");
    exactKeys(row, ["arm", "baselineOutcome", "geoId"], "geo assignment");
    if (typeof row.geoId !== "string" || !ID.test(row.geoId) || seen.has(row.geoId) || !(row.arm === "TREATMENT" || row.arm === "CONTROL")) throw new Cortex12Error("INTEGRITY_FAILURE", "stored geo assignment is invalid");
    seen.add(row.geoId);
    return Object.freeze({ geoId: row.geoId, arm: row.arm, baselineOutcome: number(row.baselineOutcome, "baselineOutcome", 0, 1e15) });
  });
  const treatmentCount = assignments.filter((assignment) => assignment.arm === "TREATMENT").length;
  const controlCount = assignments.length - treatmentCount;
  const expectedControls = Math.max(1, Math.min(assignments.length - 1, Math.round(assignments.length * holdoutFraction)));
  if (controlCount !== expectedControls) throw new Cortex12Error("INTEGRITY_FAILURE", "stored design does not honor its preregistered holdout fraction");
  const insufficient = treatmentCount < minGeosPerArm || controlCount < minGeosPerArm;
  if ((raw.reason === "INSUFFICIENT_ARM_SIZE") !== insufficient || (raw.reason === "INSUFFICIENT_ARM_SIZE") !== (baselineImbalance === null)) throw new Cortex12Error("INTEGRITY_FAILURE", "stored design sample-size status is inconsistent");
  if (!insufficient && baselineImbalance === null) throw new Cortex12Error("INTEGRITY_FAILURE", "stored baseline imbalance is missing");
  if (raw.reason === "BALANCED" && baselineImbalance !== null && baselineImbalance > maxBaselineImbalance) throw new Cortex12Error("INTEGRITY_FAILURE", "stored balanced design exceeds its imbalance threshold");
  if (raw.reason === "BASELINE_IMBALANCE" && baselineImbalance !== null && baselineImbalance <= maxBaselineImbalance) throw new Cortex12Error("INTEGRITY_FAILURE", "stored rejected design does not exceed its imbalance threshold");
  const base = {
    experimentId: raw.experimentId,
    designVersion: 1 as const,
    status: raw.status,
    reason: raw.reason,
    seedDigest: raw.seedDigest as `sha256:${string}`,
    holdoutFraction,
    maxBaselineImbalance,
    minGeosPerArm,
    baselineImbalance,
    assignments: Object.freeze(assignments),
  };
  if (digest(base) !== raw.designDigest) throw new Cortex12Error("INTEGRITY_FAILURE", "design digest mismatch");
  return Object.freeze({ ...base, designDigest: raw.designDigest as `sha256:${string}` });
}

function tCritical95(df: number): number {
  const table: readonly [number, number][] = [[1, 12.706], [2, 4.303], [3, 3.182], [4, 2.776], [5, 2.571], [6, 2.447], [8, 2.306], [10, 2.228], [12, 2.179], [15, 2.131], [20, 2.086], [30, 2.042], [60, 2], [1e9, 1.96]];
  for (const [threshold, critical] of table) if (df <= threshold) return critical;
  return 1.96;
}

export function analyzeGeoHoldout(value: unknown): GeoHoldoutAnalysis {
  const raw = plain(value, "analysis input");
  exactKeys(raw, ["design", "outcomes"], "analysis contract");
  const design = verifyGeoHoldoutDesign(raw.design);
  if (design.status !== "READY") throw new Cortex12Error("DESIGN_REJECTED", "only READY designs can be analyzed");
  if (!Array.isArray(raw.outcomes) || raw.outcomes.length !== design.assignments.length) throw new Cortex12Error("INVALID_INPUT", "outcomes must cover every assigned geo exactly once");
  const assignmentByGeo = new Map(design.assignments.map((item) => [item.geoId, item]));
  const seen = new Set<string>();
  const deltas = { TREATMENT: [] as number[], CONTROL: [] as number[] };
  for (const item of raw.outcomes) {
    const row = plain(item, "geo outcome");
    exactKeys(row, ["baselineOutcome", "experimentOutcome", "geoId"], "geo outcome contract");
    if (typeof row.geoId !== "string" || seen.has(row.geoId)) throw new Cortex12Error("INVALID_INPUT", "geo outcome is duplicated");
    seen.add(row.geoId);
    const assignment = assignmentByGeo.get(row.geoId);
    if (!assignment) throw new Cortex12Error("INTEGRITY_FAILURE", "outcome contains an unassigned geo");
    const baseline = number(row.baselineOutcome, "baselineOutcome", 0, 1e15);
    const experiment = number(row.experimentOutcome, "experimentOutcome", 0, 1e15);
    if (Math.abs(baseline - assignment.baselineOutcome) > 1e-9) throw new Cortex12Error("INTEGRITY_FAILURE", "baseline outcome changed after randomization");
    deltas[assignment.arm].push(experiment - baseline);
  }
  if (deltas.TREATMENT.length < design.minGeosPerArm || deltas.CONTROL.length < design.minGeosPerArm) throw new Cortex12Error("INSUFFICIENT_SAMPLE", "preregistered minimum geos per arm was not reached");
  const treatmentMean = mean(deltas.TREATMENT);
  const controlMean = mean(deltas.CONTROL);
  const vT = variance(deltas.TREATMENT);
  const vC = variance(deltas.CONTROL);
  const a = vT / deltas.TREATMENT.length;
  const b = vC / deltas.CONTROL.length;
  const standardError = Math.sqrt(a + b);
  const denominator = a ** 2 / Math.max(1, deltas.TREATMENT.length - 1) + b ** 2 / Math.max(1, deltas.CONTROL.length - 1);
  const df = denominator > 0 ? (a + b) ** 2 / denominator : 1e9;
  const critical = tCritical95(df);
  const incremental = treatmentMean - controlMean;
  const low = incremental - critical * standardError;
  const high = incremental + critical * standardError;
  return Object.freeze({
    experimentId: design.experimentId,
    designDigest: design.designDigest,
    treatmentGeos: deltas.TREATMENT.length,
    controlGeos: deltas.CONTROL.length,
    treatmentMeanDelta: round(treatmentMean),
    controlMeanDelta: round(controlMean),
    incrementalDelta: round(incremental),
    standardError: round(standardError),
    confidenceInterval95: Object.freeze([round(low), round(high)] as const),
    verdict: low > 0 ? "POSITIVE" : high < 0 ? "NEGATIVE" : "INCONCLUSIVE",
  });
}
