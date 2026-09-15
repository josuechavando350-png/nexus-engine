import { readTenantControl } from "../control-plane/tenant-control.mjs";
import { canonicalProviderRecordsSha256 } from "../evidence/authorized-provider-snapshot.mjs";
import { readTenantEvidenceSnapshot } from "../evidence/tenant-evidence.mjs";
import { buildClientCohortEvidenceReport } from "./cohort-engine.mjs";

const PROVIDER = "NEXUS_CRM";
const DATASET_KEY = "client_cohort_records";
const SOURCE_ID = `${PROVIDER}:${DATASET_KEY}`;

function decision({
  siteId,
  controlGeneration,
  status,
  reason,
  evidenceManifestHash = null,
  cohortProvenance = null,
  report = null,
}) {
  return Object.freeze({
    siteId,
    controlGeneration,
    status,
    reason,
    evidenceManifestHash,
    cohortProvenance,
    report,
  });
}

function cohortProvenanceFromEvidence(evidence) {
  const rows = evidence.datasets.upstream_evidence;
  if (!Array.isArray(rows)) throw new Error("client cohort upstream_evidence missing");
  const matches = rows.filter((row) => row?.source_id === SOURCE_ID);
  if (matches.length !== 1) throw new Error("client cohort provenance must contain exactly one source record");
  const row = matches[0];
  const expectedKeys = [
    "capture_id",
    "dataset_key",
    "observed_at_unix_ms",
    "provider",
    "record_count",
    "records_sha256",
    "source_authority",
    "source_capture_sha256",
    "source_id",
  ].sort();
  if (!row || typeof row !== "object" || Array.isArray(row) || JSON.stringify(Object.keys(row).sort()) !== JSON.stringify(expectedKeys)) {
    throw new Error("client cohort provenance has unexpected schema");
  }
  if (row.provider !== PROVIDER || row.dataset_key !== DATASET_KEY || row.source_id !== SOURCE_ID) {
    throw new Error("client cohort provenance identity mismatch");
  }
  if (!Number.isSafeInteger(row.record_count) || row.record_count < 1) throw new Error("client cohort provenance record_count invalid");
  if (typeof row.records_sha256 !== "string" || !/^sha256:[0-9a-f]{64}$/.test(row.records_sha256)) {
    throw new Error("client cohort provenance records_sha256 invalid");
  }
  if (typeof row.source_authority !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(row.source_authority)) {
    throw new Error("client cohort source_authority invalid");
  }
  if (typeof row.source_capture_sha256 !== "string" || !/^sha256:[0-9a-f]{64}$/.test(row.source_capture_sha256)) {
    throw new Error("client cohort source_capture_sha256 invalid");
  }
  if (typeof row.capture_id !== "string" || !row.capture_id.trim()) throw new Error("client cohort capture_id invalid");
  if (!Number.isSafeInteger(row.observed_at_unix_ms) || row.observed_at_unix_ms < 1) {
    throw new Error("client cohort observed_at_unix_ms invalid");
  }
  return row;
}

export async function buildTenantClientCohortEvidence({ controlRoot, evidenceRoot, siteId, cohortProfile }) {
  const evidence = await readTenantEvidenceSnapshot({ controlRoot, evidenceRoot, siteId });
  if (evidence.status !== "READY" || !evidence.integrityOk) {
    return decision({
      siteId,
      controlGeneration: evidence.controlGeneration,
      status: evidence.status,
      reason: evidence.reason,
      evidenceManifestHash: evidence.manifestHash,
    });
  }

  const records = evidence.datasets[DATASET_KEY];
  if (!Array.isArray(records)) {
    return decision({
      siteId,
      controlGeneration: evidence.controlGeneration,
      status: "INSUFFICIENT_DATA",
      reason: `REQUIRED_DATASETS_MISSING:${DATASET_KEY}`,
      evidenceManifestHash: evidence.manifestHash,
    });
  }
  if (records.length === 0) {
    return decision({
      siteId,
      controlGeneration: evidence.controlGeneration,
      status: "INSUFFICIENT_DATA",
      reason: `REQUIRED_DATASETS_EMPTY:${DATASET_KEY}`,
      evidenceManifestHash: evidence.manifestHash,
    });
  }

  let provenance;
  let report;
  try {
    provenance = cohortProvenanceFromEvidence(evidence);
    const normalizedRecordsSha256 = canonicalProviderRecordsSha256(records);
    if (provenance.record_count !== records.length || provenance.records_sha256 !== normalizedRecordsSha256) {
      throw new Error("client cohort provenance does not match evidence bytes");
    }
    report = buildClientCohortEvidenceReport({ clientCohortRecords: records, cohortProfile });
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown client cohort error";
    return decision({
      siteId,
      controlGeneration: evidence.controlGeneration,
      status: "BLOCKED",
      reason: `CLIENT_COHORT_INPUT_INVALID:${message}`,
      evidenceManifestHash: evidence.manifestHash,
    });
  }

  const controlAfter = await readTenantControl({ controlRoot, siteId });
  if (!controlAfter.authorized || !controlAfter.integrityOk || controlAfter.generation !== evidence.controlGeneration) {
    return decision({
      siteId,
      controlGeneration: controlAfter.generation,
      status: "STALE",
      reason: "CONTROL_CHANGED_DURING_CLIENT_COHORT_EVIDENCE",
      evidenceManifestHash: evidence.manifestHash,
      cohortProvenance: provenance,
    });
  }

  const evidenceAfter = await readTenantEvidenceSnapshot({ controlRoot, evidenceRoot, siteId });
  if (
    evidenceAfter.status !== "READY"
    || !evidenceAfter.integrityOk
    || evidenceAfter.controlGeneration !== evidence.controlGeneration
    || evidenceAfter.manifestHash !== evidence.manifestHash
  ) {
    return decision({
      siteId,
      controlGeneration: evidenceAfter.controlGeneration,
      status: "STALE",
      reason: "EVIDENCE_CHANGED_DURING_CLIENT_COHORT_EVIDENCE",
      evidenceManifestHash: evidence.manifestHash,
      cohortProvenance: provenance,
    });
  }

  return decision({
    siteId,
    controlGeneration: evidence.controlGeneration,
    status: report.status === "COHORT_EVIDENCE_READY" ? "READY" : "INSUFFICIENT_DATA",
    reason: report.status === "COHORT_EVIDENCE_READY" ? "CLIENT_COHORT_EVIDENCE_READY" : "CLIENT_COHORT_SAMPLE_INSUFFICIENT",
    evidenceManifestHash: evidence.manifestHash,
    cohortProvenance: Object.freeze({
      sourceAuthority: provenance.source_authority,
      sourceCaptureSha256: provenance.source_capture_sha256,
      captureId: provenance.capture_id,
      observedAtUnixMs: provenance.observed_at_unix_ms,
      recordCount: provenance.record_count,
      recordsSha256: provenance.records_sha256,
    }),
    report,
  });
}
