import type { EvidenceEnvelope, MeasurementRun, MeasurementScope, MetricSample } from "../measurement/index";
import { canonicalJson, deterministicId } from "../measurement/index";
import type { BenchmarkExecution } from "../benchmark/index";

export type EvidenceSource = "CAPTURE" | "BENCHMARK" | "RUNTIME" | "MANUAL";
export type EvidenceIntegrity = "VERIFIED" | "UNVERIFIED" | "REJECTED";

export interface EvidenceRecord {
  recordId: string;
  runId: string;
  scope: MeasurementScope;
  source: EvidenceSource;
  sourceId: string;
  status: EvidenceEnvelope["status"];
  samples: readonly MetricSample[];
  capturedAt: string;
  integrity: EvidenceIntegrity;
  provenanceDigest: string;
  reason?: string;
}

export interface EvidenceBundle {
  bundleId: string;
  runId: string;
  scope: MeasurementScope;
  records: readonly EvidenceRecord[];
  createdAt: string;
  complete: boolean;
}

export class EvidencePipelineError extends Error {
  constructor(public readonly code: "INVALID_INPUT" | "SCOPE_MISMATCH" | "RUN_MISMATCH" | "DUPLICATE_SOURCE" | "INVALID_STATE" | "NON_FINITE_SAMPLE", message: string) {
    super(message);
    this.name = "EvidencePipelineError";
  }
}

function nonEmpty(value: string, field: string): void {
  if (!value.trim()) throw new EvidencePipelineError("INVALID_INPUT", `${field} must be non-empty`);
}

function assertScope(scope: MeasurementScope): void {
  nonEmpty(scope.tenantId, "tenantId");
  nonEmpty(scope.brandId, "brandId");
}

function assertIsoTimestamp(value: string, field: string): void {
  nonEmpty(value, field);
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) {
    throw new EvidencePipelineError("INVALID_INPUT", `${field} must be canonical ISO-8601 UTC`);
  }
}

function assertSamples(samples: readonly MetricSample[]): void {
  for (const sample of samples) {
    nonEmpty(sample.name, "sample.name");
    nonEmpty(sample.unit, "sample.unit");
    if (!Number.isFinite(sample.value)) throw new EvidencePipelineError("NON_FINITE_SAMPLE", `${sample.name} must be finite`);
  }
}

export function createEvidenceRecord(input: Omit<EvidenceRecord, "recordId" | "provenanceDigest">): EvidenceRecord {
  nonEmpty(input.runId, "runId");
  nonEmpty(input.sourceId, "sourceId");
  assertScope(input.scope);
  assertIsoTimestamp(input.capturedAt, "capturedAt");
  assertSamples(input.samples);
  if (input.status === "MEASURED" && input.samples.length === 0) {
    throw new EvidencePipelineError("INVALID_STATE", "MEASURED record requires samples");
  }
  if (input.status !== "MEASURED" && input.samples.length > 0) {
    throw new EvidencePipelineError("INVALID_STATE", `${input.status} record cannot contain samples`);
  }
  if (input.status !== "MEASURED" && !input.reason?.trim()) {
    throw new EvidencePipelineError("INVALID_STATE", `${input.status} record requires a reason`);
  }
  if (input.integrity === "REJECTED" && !input.reason?.trim()) {
    throw new EvidencePipelineError("INVALID_STATE", "REJECTED evidence requires a reason");
  }

  const provenanceDigest = deterministicId("prov", {
    runId: input.runId,
    scope: input.scope,
    source: input.source,
    sourceId: input.sourceId,
    status: input.status,
    samples: input.samples,
    capturedAt: input.capturedAt,
    integrity: input.integrity,
    reason: input.reason ?? null
  });
  const recordId = deterministicId("record", { provenanceDigest });
  return { recordId, provenanceDigest, ...input };
}

export function recordFromEnvelope(envelope: EvidenceEnvelope, source: EvidenceSource, sourceId: string, integrity: EvidenceIntegrity): EvidenceRecord {
  return createEvidenceRecord({
    runId: envelope.runId,
    scope: envelope.scope,
    source,
    sourceId,
    status: envelope.status,
    samples: envelope.samples,
    capturedAt: envelope.capturedAt,
    integrity,
    reason: envelope.reason
  });
}

export function recordFromBenchmark(run: MeasurementRun, execution: BenchmarkExecution, capturedAt: string): EvidenceRecord {
  if (execution.runId !== run.runId) throw new EvidencePipelineError("RUN_MISMATCH", "benchmark execution must belong to run");
  return createEvidenceRecord({
    runId: run.runId,
    scope: run.scope,
    source: "BENCHMARK",
    sourceId: execution.executionId,
    status: "MEASURED",
    samples: execution.aggregates,
    capturedAt,
    integrity: "VERIFIED"
  });
}

export function createEvidenceBundle(run: MeasurementRun, records: readonly EvidenceRecord[], createdAt: string, requiredSources: readonly EvidenceSource[] = []): EvidenceBundle {
  assertIsoTimestamp(createdAt, "createdAt");
  assertScope(run.scope);
  const seen = new Set<string>();
  for (const record of records) {
    if (record.runId !== run.runId) throw new EvidencePipelineError("RUN_MISMATCH", "all evidence records must belong to run");
    if (record.scope.tenantId !== run.scope.tenantId || record.scope.brandId !== run.scope.brandId) {
      throw new EvidencePipelineError("SCOPE_MISMATCH", "all evidence records must match run scope");
    }
    const sourceKey = `${record.source}\u0000${record.sourceId}`;
    if (seen.has(sourceKey)) throw new EvidencePipelineError("DUPLICATE_SOURCE", "duplicate evidence source identity");
    seen.add(sourceKey);
  }
  const availableSources = new Set(records.filter((record) => record.integrity === "VERIFIED" && record.status === "MEASURED").map((record) => record.source));
  const complete = requiredSources.every((source) => availableSources.has(source));
  const canonicalRecords = [...records].sort((a, b) => a.recordId.localeCompare(b.recordId));
  const bundleId = deterministicId("bundle", {
    runId: run.runId,
    scope: run.scope,
    records: canonicalRecords.map((record) => record.recordId),
    createdAt,
    requiredSources: [...requiredSources].sort()
  });
  return { bundleId, runId: run.runId, scope: run.scope, records: canonicalRecords, createdAt, complete };
}

export function verifyBundleDeterminism(bundle: EvidenceBundle): string {
  return canonicalJson({
    bundleId: bundle.bundleId,
    runId: bundle.runId,
    scope: bundle.scope,
    records: bundle.records.map(({ recordId, provenanceDigest }) => ({ recordId, provenanceDigest })),
    createdAt: bundle.createdAt,
    complete: bundle.complete
  });
}
