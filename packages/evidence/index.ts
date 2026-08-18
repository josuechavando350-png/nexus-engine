import { createHash, sign as cryptoSign, verify as cryptoVerify, type KeyLike } from "node:crypto";
import type { EvidenceEnvelope, MeasurementRun, MeasurementScope, MetricSample } from "../measurement/index";
import { canonicalJson, deterministicId } from "../measurement/index";
import type { BenchmarkExecution } from "../benchmark/index";

export type EvidenceSource = "CAPTURE" | "BENCHMARK" | "RUNTIME" | "MANUAL" | "QUALITY";
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
  requiredSources: readonly EvidenceSource[];
  createdAt: string;
  complete: boolean;
}

export interface SignedEvidenceBundle {
  schemaVersion: 1;
  algorithm: "Ed25519";
  keyId: string;
  payloadDigest: string;
  signature: string;
  bundle: EvidenceBundle;
}

export class EvidencePipelineError extends Error {
  constructor(public readonly code: "INVALID_INPUT" | "SCOPE_MISMATCH" | "RUN_MISMATCH" | "DUPLICATE_SOURCE" | "INVALID_STATE" | "NON_FINITE_SAMPLE" | "INTEGRITY_MISMATCH" | "SIGNATURE_INVALID", message: string) {
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
  const canonicalRequiredSources = [...new Set(requiredSources)].sort();
  const availableSources = new Set(records.filter((record) => record.integrity === "VERIFIED" && record.status === "MEASURED").map((record) => record.source));
  const complete = canonicalRequiredSources.every((source) => availableSources.has(source));
  const canonicalRecords = [...records].sort((a, b) => a.recordId.localeCompare(b.recordId));
  const bundleId = deterministicId("bundle", {
    runId: run.runId,
    scope: run.scope,
    records: canonicalRecords.map((record) => record.recordId),
    createdAt,
    requiredSources: canonicalRequiredSources
  });
  return { bundleId, runId: run.runId, scope: run.scope, records: canonicalRecords, requiredSources: canonicalRequiredSources, createdAt, complete };
}

export function verifyBundleDeterminism(bundle: EvidenceBundle): string {
  return canonicalJson({
    bundleId: bundle.bundleId,
    runId: bundle.runId,
    scope: bundle.scope,
    records: bundle.records.map(({ recordId, provenanceDigest }) => ({ recordId, provenanceDigest })),
    requiredSources: bundle.requiredSources,
    createdAt: bundle.createdAt,
    complete: bundle.complete
  });
}

function assertBundleIntegrity(bundle: EvidenceBundle): void {
  nonEmpty(bundle.bundleId, "bundleId");
  nonEmpty(bundle.runId, "runId");
  assertScope(bundle.scope);
  assertIsoTimestamp(bundle.createdAt, "createdAt");

  const expectedOrder = [...bundle.records].sort((a, b) => a.recordId.localeCompare(b.recordId));
  if (expectedOrder.some((record, index) => record.recordId !== bundle.records[index]?.recordId)) {
    throw new EvidencePipelineError("INTEGRITY_MISMATCH", "bundle records are not in canonical order");
  }
  const canonicalRequiredSources = [...new Set(bundle.requiredSources)].sort();
  if (canonicalRequiredSources.length !== bundle.requiredSources.length || canonicalRequiredSources.some((source, index) => source !== bundle.requiredSources[index])) {
    throw new EvidencePipelineError("INTEGRITY_MISMATCH", "bundle requiredSources are not canonical");
  }

  const seen = new Set<string>();
  for (const record of bundle.records) {
    if (record.runId !== bundle.runId) throw new EvidencePipelineError("RUN_MISMATCH", "signed bundle record run mismatch");
    if (record.scope.tenantId !== bundle.scope.tenantId || record.scope.brandId !== bundle.scope.brandId) {
      throw new EvidencePipelineError("SCOPE_MISMATCH", "signed bundle record scope mismatch");
    }
    const sourceKey = `${record.source}\u0000${record.sourceId}`;
    if (seen.has(sourceKey)) throw new EvidencePipelineError("DUPLICATE_SOURCE", "duplicate evidence source identity");
    seen.add(sourceKey);

    const rebuilt = createEvidenceRecord({
      runId: record.runId,
      scope: record.scope,
      source: record.source,
      sourceId: record.sourceId,
      status: record.status,
      samples: record.samples,
      capturedAt: record.capturedAt,
      integrity: record.integrity,
      reason: record.reason
    });
    if (rebuilt.recordId !== record.recordId || rebuilt.provenanceDigest !== record.provenanceDigest) {
      throw new EvidencePipelineError("INTEGRITY_MISMATCH", `evidence record ${record.recordId} failed provenance verification`);
    }
  }

  const availableSources = new Set(bundle.records.filter((record) => record.integrity === "VERIFIED" && record.status === "MEASURED").map((record) => record.source));
  const expectedComplete = bundle.requiredSources.every((source) => availableSources.has(source));
  if (expectedComplete !== bundle.complete) throw new EvidencePipelineError("INTEGRITY_MISMATCH", "bundle completeness flag is inconsistent with evidence");

  const expectedBundleId = deterministicId("bundle", {
    runId: bundle.runId,
    scope: bundle.scope,
    records: bundle.records.map((record) => record.recordId),
    createdAt: bundle.createdAt,
    requiredSources: bundle.requiredSources
  });
  if (expectedBundleId !== bundle.bundleId) throw new EvidencePipelineError("INTEGRITY_MISMATCH", "bundleId failed deterministic verification");
}

function signingPayload(bundle: EvidenceBundle): string {
  assertBundleIntegrity(bundle);
  return canonicalJson({ schemaVersion: 1, purpose: "NEXUS_EVIDENCE_BUNDLE", bundle });
}

function digestPayload(payload: string): string {
  return `sha256:${createHash("sha256").update(payload, "utf8").digest("hex")}`;
}

export function signEvidenceBundle(bundle: EvidenceBundle, keyId: string, privateKey: KeyLike): SignedEvidenceBundle {
  nonEmpty(keyId, "keyId");
  const payload = signingPayload(bundle);
  const signature = cryptoSign(null, Buffer.from(payload, "utf8"), privateKey).toString("base64");
  return Object.freeze({
    schemaVersion: 1,
    algorithm: "Ed25519",
    keyId: keyId.trim(),
    payloadDigest: digestPayload(payload),
    signature,
    bundle
  });
}

export function verifySignedEvidenceBundle(signed: SignedEvidenceBundle, publicKey: KeyLike): true {
  if (signed.schemaVersion !== 1 || signed.algorithm !== "Ed25519") {
    throw new EvidencePipelineError("SIGNATURE_INVALID", "unsupported evidence signature envelope");
  }
  nonEmpty(signed.keyId, "keyId");
  nonEmpty(signed.signature, "signature");
  const payload = signingPayload(signed.bundle);
  if (digestPayload(payload) !== signed.payloadDigest) {
    throw new EvidencePipelineError("INTEGRITY_MISMATCH", "signed evidence payload digest mismatch");
  }
  let signature: Buffer;
  try {
    signature = Buffer.from(signed.signature, "base64");
  } catch {
    throw new EvidencePipelineError("SIGNATURE_INVALID", "evidence signature is not valid base64");
  }
  if (!signature.length || !cryptoVerify(null, Buffer.from(payload, "utf8"), publicKey, signature)) {
    throw new EvidencePipelineError("SIGNATURE_INVALID", "evidence signature verification failed");
  }
  return true;
}
