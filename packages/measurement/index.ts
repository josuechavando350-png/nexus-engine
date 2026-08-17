import { createHash } from "node:crypto";

export type EvidenceStatus = "MEASURED" | "MISSING" | "UNSUPPORTED" | "FAILED";

export interface MeasurementScope { tenantId: string; brandId: string; }
export interface WorkloadDefinition { id: string; version: string; scope: MeasurementScope; name: string; parameters: Readonly<Record<string, string | number | boolean>>; }
export interface EnvironmentDescriptor { os: string; architecture: string; runtime: string; runtimeVersion: string; deviceClass: string; gpu?: string; browser?: string; browserVersion?: string; }
export interface MeasurementRun { runId: string; workloadId: string; workloadVersion: string; workloadDigest: string; environmentDigest: string; scope: MeasurementScope; startedAt: string; }
export interface MetricSample { name: string; unit: string; value: number; }
export interface EvidenceEnvelope { evidenceId: string; runId: string; scope: MeasurementScope; status: EvidenceStatus; samples: readonly MetricSample[]; capturedAt: string; reason?: string; }

export class MeasurementValidationError extends Error {
  constructor(public readonly code: "INVALID_SCOPE" | "INVALID_INPUT" | "NON_FINITE_SAMPLE" | "SCOPE_MISMATCH" | "INVALID_EVIDENCE_STATE", message: string) { super(message); this.name = "MeasurementValidationError"; }
}

function assertNonEmpty(value: string, field: string): void { if (value.trim().length === 0) throw new MeasurementValidationError("INVALID_INPUT", `${field} must be non-empty`); }
function assertCanonicalUtcTimestamp(value: string, field: string): void {
  assertNonEmpty(value, field);
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== value) throw new MeasurementValidationError("INVALID_INPUT", `${field} must be a canonical ISO-8601 UTC timestamp`);
}
export function assertScope(scope: MeasurementScope): void { if (!scope.tenantId.trim() || !scope.brandId.trim()) throw new MeasurementValidationError("INVALID_SCOPE", "tenantId and brandId are required"); }

function normalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalize);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, normalize(item)]));
  return value;
}
export function canonicalJson(value: unknown): string { return JSON.stringify(normalize(value)); }
export function deterministicId(prefix: string, value: unknown): string { return `${prefix}_${createHash("sha256").update(canonicalJson(value), "utf8").digest("hex")}`; }
export function workloadDigest(workload: WorkloadDefinition): string { validateWorkload(workload); return deterministicId("wrk", workload); }
export function environmentDigest(environment: EnvironmentDescriptor): string { validateEnvironment(environment); return deterministicId("env", environment); }

export type CreateMeasurementRunInput = Omit<MeasurementRun, "runId" | "workloadId" | "workloadVersion" | "workloadDigest" | "environmentDigest"> & {
  workload: WorkloadDefinition;
  environment: EnvironmentDescriptor;
};

export function createRun(input: CreateMeasurementRunInput): MeasurementRun {
  validateWorkload(input.workload); validateEnvironment(input.environment); assertScope(input.scope);
  if (input.scope.tenantId !== input.workload.scope.tenantId || input.scope.brandId !== input.workload.scope.brandId) throw new MeasurementValidationError("SCOPE_MISMATCH", "run scope must match workload scope");
  assertCanonicalUtcTimestamp(input.startedAt, "startedAt");
  const wDigest = workloadDigest(input.workload); const eDigest = environmentDigest(input.environment);
  const runId = deterministicId("run", { workloadDigest: wDigest, environmentDigest: eDigest, scope: input.scope, startedAt: input.startedAt });
  return { runId, workloadId: input.workload.id, workloadVersion: input.workload.version, workloadDigest: wDigest, environmentDigest: eDigest, scope: input.scope, startedAt: input.startedAt };
}

export function createEvidence(input: Omit<EvidenceEnvelope, "evidenceId">): EvidenceEnvelope {
  assertScope(input.scope); assertNonEmpty(input.runId, "runId"); assertCanonicalUtcTimestamp(input.capturedAt, "capturedAt");
  for (const sample of input.samples) { assertNonEmpty(sample.name, "sample.name"); assertNonEmpty(sample.unit, "sample.unit"); if (!Number.isFinite(sample.value)) throw new MeasurementValidationError("NON_FINITE_SAMPLE", `${sample.name} must be finite`); }
  if (input.status === "MEASURED" && input.samples.length === 0) throw new MeasurementValidationError("INVALID_EVIDENCE_STATE", "MEASURED evidence requires at least one sample");
  if (input.status !== "MEASURED" && input.samples.length > 0) throw new MeasurementValidationError("INVALID_EVIDENCE_STATE", `${input.status} evidence cannot contain samples`);
  if (input.status !== "MEASURED" && !input.reason?.trim()) throw new MeasurementValidationError("INVALID_EVIDENCE_STATE", `${input.status} evidence requires a reason`);
  return { evidenceId: deterministicId("evd", input), ...input };
}
export function assertEvidenceBelongsToRun(evidence: EvidenceEnvelope, run: MeasurementRun): void { if (evidence.runId !== run.runId || evidence.scope.tenantId !== run.scope.tenantId || evidence.scope.brandId !== run.scope.brandId) throw new MeasurementValidationError("SCOPE_MISMATCH", "evidence must belong to the same run and scope"); }
export function validateWorkload(workload: WorkloadDefinition): void { assertNonEmpty(workload.id, "workload.id"); assertNonEmpty(workload.version, "workload.version"); assertNonEmpty(workload.name, "workload.name"); assertScope(workload.scope); for (const [key, value] of Object.entries(workload.parameters)) { assertNonEmpty(key, "workload.parameters key"); if (typeof value === "number" && !Number.isFinite(value)) throw new MeasurementValidationError("NON_FINITE_SAMPLE", `${key} must be finite`); } }
export function validateEnvironment(environment: EnvironmentDescriptor): void { for (const [field, value] of Object.entries({ os: environment.os, architecture: environment.architecture, runtime: environment.runtime, runtimeVersion: environment.runtimeVersion, deviceClass: environment.deviceClass })) assertNonEmpty(value, `environment.${field}`); }
