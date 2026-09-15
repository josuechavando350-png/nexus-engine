import { createHash } from "node:crypto";

import { readTenantControl } from "../control-plane/tenant-control.mjs";
import { readTenantEvidenceSnapshot } from "../evidence/tenant-evidence.mjs";
import { attachAuthorityContext, buildTopicalAuthorityEvidenceReport } from "./authority-engine.mjs";
import { buildTenantRankContextWithCompetition } from "./tenant-competition.mjs";

const SHA256_RE = /^sha256:[0-9a-f]{64}$/;
const SOURCE_AUTHORITY_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const AUTHORITY_PROVIDER = "NEXUS_AUTHORITY_SNAPSHOT";

function compareStrings(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function canonicalJson(value) {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return JSON.stringify(typeof value === "string" ? value.normalize("NFC") : value);
  }
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) throw new TypeError("authority provenance values must be safe integers");
    return String(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value)
      .map(([key, item]) => [key.normalize("NFC"), item])
      .sort(([left], [right]) => compareStrings(left, right));
    const seen = new Set();
    return `{${entries.map(([key, item]) => {
      if (seen.has(key)) throw new TypeError("normalized mapping key collision");
      seen.add(key);
      return `${JSON.stringify(key)}:${canonicalJson(item)}`;
    }).join(",")}}`;
  }
  throw new TypeError("authority provenance values must be JSON-compatible");
}

function canonicalRecordsSha256(records) {
  return `sha256:${createHash("sha256").update(Buffer.from(canonicalJson(records), "utf8")).digest("hex")}`;
}

function decision({
  siteId,
  controlGeneration,
  status,
  reason,
  evidenceManifestHash = null,
  competitionProvenance = null,
  authorityProvenance = null,
  report = null,
}) {
  return Object.freeze({
    siteId,
    controlGeneration,
    status,
    reason,
    evidenceManifestHash,
    competitionProvenance,
    authorityProvenance,
    report,
  });
}

function authorityProvenanceFromEvidence(evidence) {
  const upstream = evidence.datasets.upstream_evidence;
  const records = evidence.datasets.topical_authority_records;
  if (!Array.isArray(upstream) || !Array.isArray(records)) return null;
  const matches = upstream.filter((row) => (
    row
    && typeof row === "object"
    && !Array.isArray(row)
    && row.dataset_key === "topical_authority_records"
  ));
  if (matches.length !== 1) return null;
  const row = matches[0];
  if (
    row.provider !== AUTHORITY_PROVIDER
    || typeof row.source_authority !== "string"
    || !SOURCE_AUTHORITY_RE.test(row.source_authority)
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
  if (row.record_count !== records.length) return null;
  if (canonicalRecordsSha256(records) !== row.records_sha256) return null;
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

export async function buildTenantRankContextWithAuthority({
  controlRoot,
  evidenceRoot,
  siteId,
  feasibilityAssumptionProfile,
  trendAssumptionProfile,
  competitionAssumptionProfile,
  authorityAssumptionProfile,
}) {
  const base = await buildTenantRankContextWithCompetition({
    controlRoot,
    evidenceRoot,
    siteId,
    feasibilityAssumptionProfile,
    trendAssumptionProfile,
    competitionAssumptionProfile,
  });
  if (base.status !== "READY" || base.report === null) {
    return decision({
      siteId: base.siteId,
      controlGeneration: base.controlGeneration,
      status: base.status,
      reason: base.reason,
      evidenceManifestHash: base.evidenceManifestHash,
      competitionProvenance: base.competitionProvenance,
    });
  }

  const evidence = await readTenantEvidenceSnapshot({ controlRoot, evidenceRoot, siteId });
  if (
    evidence.status !== "READY"
    || !evidence.integrityOk
    || evidence.controlGeneration !== base.controlGeneration
    || evidence.manifestHash !== base.evidenceManifestHash
  ) {
    return decision({
      siteId,
      controlGeneration: evidence.controlGeneration,
      status: "STALE",
      reason: "EVIDENCE_CHANGED_BEFORE_AUTHORITY_CONTEXT",
      evidenceManifestHash: base.evidenceManifestHash,
      competitionProvenance: base.competitionProvenance,
    });
  }

  if (!Array.isArray(evidence.datasets.topical_authority_records)) {
    return decision({
      siteId,
      controlGeneration: evidence.controlGeneration,
      status: "INSUFFICIENT_DATA",
      reason: "REQUIRED_DATASETS_MISSING:topical_authority_records",
      evidenceManifestHash: evidence.manifestHash,
      competitionProvenance: base.competitionProvenance,
    });
  }
  if (evidence.datasets.topical_authority_records.length === 0) {
    return decision({
      siteId,
      controlGeneration: evidence.controlGeneration,
      status: "INSUFFICIENT_DATA",
      reason: "REQUIRED_DATASETS_EMPTY:topical_authority_records",
      evidenceManifestHash: evidence.manifestHash,
      competitionProvenance: base.competitionProvenance,
    });
  }

  const authorityProvenance = authorityProvenanceFromEvidence(evidence);
  if (authorityProvenance === null) {
    return decision({
      siteId,
      controlGeneration: evidence.controlGeneration,
      status: "BLOCKED",
      reason: "AUTHORITY_PROVENANCE_INVALID_OR_MISSING",
      evidenceManifestHash: evidence.manifestHash,
      competitionProvenance: base.competitionProvenance,
    });
  }

  let report;
  try {
    const authorityReport = buildTopicalAuthorityEvidenceReport({
      topicalAuthorityRecords: evidence.datasets.topical_authority_records,
      authorityAssumptionProfile,
    });
    report = attachAuthorityContext({ rankCompetitionReport: base.report, authorityReport });
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown rank authority error";
    return decision({
      siteId,
      controlGeneration: evidence.controlGeneration,
      status: "BLOCKED",
      reason: `RANK_AUTHORITY_INPUT_INVALID:${message}`,
      evidenceManifestHash: evidence.manifestHash,
      competitionProvenance: base.competitionProvenance,
      authorityProvenance,
    });
  }

  const controlAfter = await readTenantControl({ controlRoot, siteId });
  if (!controlAfter.authorized || !controlAfter.integrityOk || controlAfter.generation !== evidence.controlGeneration) {
    return decision({
      siteId,
      controlGeneration: controlAfter.generation,
      status: "STALE",
      reason: "CONTROL_CHANGED_DURING_RANK_AUTHORITY",
      evidenceManifestHash: evidence.manifestHash,
      competitionProvenance: base.competitionProvenance,
      authorityProvenance,
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
      reason: "EVIDENCE_CHANGED_DURING_RANK_AUTHORITY",
      evidenceManifestHash: evidence.manifestHash,
      competitionProvenance: base.competitionProvenance,
      authorityProvenance,
    });
  }

  return decision({
    siteId,
    controlGeneration: evidence.controlGeneration,
    status: "READY",
    reason: "RANK_AUTHORITY_CONTEXT_READY",
    evidenceManifestHash: evidence.manifestHash,
    competitionProvenance: base.competitionProvenance,
    authorityProvenance,
    report,
  });
}
