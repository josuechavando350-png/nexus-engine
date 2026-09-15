import { readTenantControl } from "../control-plane/tenant-control.mjs";
import { readTenantEvidenceSnapshot } from "../evidence/tenant-evidence.mjs";
import { buildRankFeasibilityTrendCompetitionReport } from "./competition-engine.mjs";

const SHA256_RE = /^sha256:[0-9a-f]{64}$/;
const COMPETITION_PROVIDER = "NEXUS_COMPETITIVE_SNAPSHOT";

function decision({
  siteId,
  controlGeneration,
  status,
  reason,
  evidenceManifestHash = null,
  competitionProvenance = null,
  report = null,
}) {
  return Object.freeze({
    siteId,
    controlGeneration,
    status,
    reason,
    evidenceManifestHash,
    competitionProvenance,
    report,
  });
}

function competitionProvenanceFromEvidence(evidence) {
  const upstream = evidence.datasets.upstream_evidence;
  if (!Array.isArray(upstream)) return null;
  const matches = upstream.filter((row) => (
    row
    && typeof row === "object"
    && !Array.isArray(row)
    && row.dataset_key === "keyword_coverage_records"
  ));
  if (matches.length !== 1) return null;
  const row = matches[0];
  if (
    row.provider !== COMPETITION_PROVIDER
    || typeof row.source_authority !== "string"
    || !row.source_authority.trim()
    || typeof row.source_capture_sha256 !== "string"
    || !SHA256_RE.test(row.source_capture_sha256)
    || typeof row.records_sha256 !== "string"
    || !SHA256_RE.test(row.records_sha256)
    || typeof row.capture_id !== "string"
    || !row.capture_id.trim()
    || !Number.isSafeInteger(row.observed_at_unix_ms)
    || row.observed_at_unix_ms < 1
    || !Number.isSafeInteger(row.record_count)
    || row.record_count < 0
  ) {
    return null;
  }
  if (row.record_count !== evidence.datasets.keyword_coverage_records.length) return null;
  return Object.freeze({
    provider: row.provider,
    sourceAuthority: row.source_authority,
    sourceCaptureSha256: row.source_capture_sha256,
    normalizedRecordsSha256: row.records_sha256,
    captureId: row.capture_id,
    observedAtUnixMs: row.observed_at_unix_ms,
    recordCount: row.record_count,
  });
}

export async function buildTenantRankContextWithCompetition({
  controlRoot,
  evidenceRoot,
  siteId,
  feasibilityAssumptionProfile,
  trendAssumptionProfile,
  competitionAssumptionProfile,
}) {
  const evidence = await readTenantEvidenceSnapshot({ controlRoot, evidenceRoot, siteId });
  if (evidence.status !== "READY" || !evidence.integrityOk) {
    return decision({
      siteId: evidence.siteId,
      controlGeneration: evidence.controlGeneration,
      status: evidence.status,
      reason: evidence.reason,
      evidenceManifestHash: evidence.manifestHash,
    });
  }

  const requiredKeys = [
    "search_performance_records",
    "search_performance_history_records",
    "keyword_coverage_records",
    "upstream_evidence",
  ];
  const missing = requiredKeys.filter((key) => !Array.isArray(evidence.datasets[key]));
  if (missing.length > 0) {
    return decision({
      siteId,
      controlGeneration: evidence.controlGeneration,
      status: "INSUFFICIENT_DATA",
      reason: `REQUIRED_DATASETS_MISSING:${missing.join(",")}`,
      evidenceManifestHash: evidence.manifestHash,
    });
  }

  const empty = requiredKeys
    .filter((key) => key !== "upstream_evidence")
    .filter((key) => evidence.datasets[key].length === 0);
  if (empty.length > 0) {
    return decision({
      siteId,
      controlGeneration: evidence.controlGeneration,
      status: "INSUFFICIENT_DATA",
      reason: `REQUIRED_DATASETS_EMPTY:${empty.join(",")}`,
      evidenceManifestHash: evidence.manifestHash,
    });
  }

  const competitionProvenance = competitionProvenanceFromEvidence(evidence);
  if (competitionProvenance === null) {
    return decision({
      siteId,
      controlGeneration: evidence.controlGeneration,
      status: "BLOCKED",
      reason: "COMPETITION_PROVENANCE_INVALID_OR_MISSING",
      evidenceManifestHash: evidence.manifestHash,
    });
  }

  let report;
  try {
    report = buildRankFeasibilityTrendCompetitionReport({
      searchPerformanceRecords: evidence.datasets.search_performance_records,
      searchPerformanceHistoryRecords: evidence.datasets.search_performance_history_records,
      keywordCoverageRecords: evidence.datasets.keyword_coverage_records,
      feasibilityAssumptionProfile,
      trendAssumptionProfile,
      competitionAssumptionProfile,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown rank competition error";
    return decision({
      siteId,
      controlGeneration: evidence.controlGeneration,
      status: "BLOCKED",
      reason: `RANK_COMPETITION_INPUT_INVALID:${message}`,
      evidenceManifestHash: evidence.manifestHash,
      competitionProvenance,
    });
  }

  const controlAfter = await readTenantControl({ controlRoot, siteId });
  if (!controlAfter.authorized || !controlAfter.integrityOk || controlAfter.generation !== evidence.controlGeneration) {
    return decision({
      siteId,
      controlGeneration: controlAfter.generation,
      status: "STALE",
      reason: "CONTROL_CHANGED_DURING_RANK_COMPETITION",
      evidenceManifestHash: evidence.manifestHash,
      competitionProvenance,
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
      reason: "EVIDENCE_CHANGED_DURING_RANK_COMPETITION",
      evidenceManifestHash: evidence.manifestHash,
      competitionProvenance,
    });
  }

  return decision({
    siteId,
    controlGeneration: evidence.controlGeneration,
    status: "READY",
    reason: "RANK_COMPETITION_READY",
    evidenceManifestHash: evidence.manifestHash,
    competitionProvenance,
    report,
  });
}
