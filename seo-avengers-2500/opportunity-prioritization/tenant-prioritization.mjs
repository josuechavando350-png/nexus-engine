import { createHash } from "node:crypto";

import { readTenantControl } from "../control-plane/tenant-control.mjs";
import { readTenantEvidenceSnapshot } from "../evidence/tenant-evidence.mjs";
import { buildTenantRankContextWithAuthority } from "../rank-feasibility/tenant-authority.mjs";
import { buildOpportunityPrioritizationReport } from "./prioritization-engine.mjs";

const REVENUE_PROVIDER = "NEXUS_CRM";
const SHA256_RE = /^sha256:[0-9a-f]{64}$/;

function compareStrings(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function canonicalJson(value) {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return JSON.stringify(typeof value === "string" ? value.normalize("NFC") : value);
  }
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) throw new TypeError("prioritization provenance values must be safe integers");
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
  throw new TypeError("prioritization provenance values must be JSON-compatible");
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
  revenueFunnelProvenance = null,
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
    revenueFunnelProvenance,
    report,
  });
}

function revenueFunnelProvenanceFromEvidence(evidence) {
  const upstream = evidence.datasets.upstream_evidence;
  const records = evidence.datasets.revenue_funnel_records;
  if (!Array.isArray(upstream) || !Array.isArray(records)) return null;
  const matches = upstream.filter((row) => (
    row
    && typeof row === "object"
    && !Array.isArray(row)
    && row.dataset_key === "revenue_funnel_records"
  ));
  if (matches.length !== 1) return null;
  const row = matches[0];
  if (
    row.provider !== REVENUE_PROVIDER
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
    captureId: row.capture_id,
    observedAtUnixMs: row.observed_at_unix_ms,
    recordCount: row.record_count,
    normalizedRecordsSha256: row.records_sha256,
  });
}

export async function buildTenantOpportunityPrioritization({
  controlRoot,
  evidenceRoot,
  siteId,
  feasibilityAssumptionProfile,
  trendAssumptionProfile,
  competitionAssumptionProfile,
  authorityAssumptionProfile,
  growthAssumptionProfile,
  prioritizationProfile,
}) {
  const rank = await buildTenantRankContextWithAuthority({
    controlRoot,
    evidenceRoot,
    siteId,
    feasibilityAssumptionProfile,
    trendAssumptionProfile,
    competitionAssumptionProfile,
    authorityAssumptionProfile,
  });
  if (rank.status !== "READY" || rank.report === null) {
    return decision({
      siteId: rank.siteId,
      controlGeneration: rank.controlGeneration,
      status: rank.status,
      reason: rank.reason,
      evidenceManifestHash: rank.evidenceManifestHash,
      competitionProvenance: rank.competitionProvenance,
      authorityProvenance: rank.authorityProvenance,
    });
  }

  const evidence = await readTenantEvidenceSnapshot({ controlRoot, evidenceRoot, siteId });
  if (
    evidence.status !== "READY"
    || !evidence.integrityOk
    || evidence.controlGeneration !== rank.controlGeneration
    || evidence.manifestHash !== rank.evidenceManifestHash
  ) {
    return decision({
      siteId,
      controlGeneration: evidence.controlGeneration,
      status: "STALE",
      reason: "EVIDENCE_CHANGED_BEFORE_OPPORTUNITY_PRIORITIZATION",
      evidenceManifestHash: rank.evidenceManifestHash,
      competitionProvenance: rank.competitionProvenance,
      authorityProvenance: rank.authorityProvenance,
    });
  }

  if (!Array.isArray(evidence.datasets.revenue_funnel_records)) {
    return decision({
      siteId,
      controlGeneration: evidence.controlGeneration,
      status: "INSUFFICIENT_DATA",
      reason: "REQUIRED_DATASETS_MISSING:revenue_funnel_records",
      evidenceManifestHash: evidence.manifestHash,
      competitionProvenance: rank.competitionProvenance,
      authorityProvenance: rank.authorityProvenance,
    });
  }
  if (evidence.datasets.revenue_funnel_records.length === 0) {
    return decision({
      siteId,
      controlGeneration: evidence.controlGeneration,
      status: "INSUFFICIENT_DATA",
      reason: "REQUIRED_DATASETS_EMPTY:revenue_funnel_records",
      evidenceManifestHash: evidence.manifestHash,
      competitionProvenance: rank.competitionProvenance,
      authorityProvenance: rank.authorityProvenance,
    });
  }

  const revenueFunnelProvenance = revenueFunnelProvenanceFromEvidence(evidence);
  if (revenueFunnelProvenance === null) {
    return decision({
      siteId,
      controlGeneration: evidence.controlGeneration,
      status: "BLOCKED",
      reason: "REVENUE_FUNNEL_PROVENANCE_INVALID_OR_MISSING",
      evidenceManifestHash: evidence.manifestHash,
      competitionProvenance: rank.competitionProvenance,
      authorityProvenance: rank.authorityProvenance,
    });
  }

  let report;
  try {
    report = buildOpportunityPrioritizationReport({
      rankAuthorityReport: rank.report,
      revenueFunnelRecords: evidence.datasets.revenue_funnel_records,
      growthAssumptionProfile,
      prioritizationProfile,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown opportunity prioritization error";
    return decision({
      siteId,
      controlGeneration: evidence.controlGeneration,
      status: "BLOCKED",
      reason: `OPPORTUNITY_PRIORITIZATION_INPUT_INVALID:${message}`,
      evidenceManifestHash: evidence.manifestHash,
      competitionProvenance: rank.competitionProvenance,
      authorityProvenance: rank.authorityProvenance,
      revenueFunnelProvenance,
    });
  }

  const controlAfter = await readTenantControl({ controlRoot, siteId });
  if (!controlAfter.authorized || !controlAfter.integrityOk || controlAfter.generation !== evidence.controlGeneration) {
    return decision({
      siteId,
      controlGeneration: controlAfter.generation,
      status: "STALE",
      reason: "CONTROL_CHANGED_DURING_OPPORTUNITY_PRIORITIZATION",
      evidenceManifestHash: evidence.manifestHash,
      competitionProvenance: rank.competitionProvenance,
      authorityProvenance: rank.authorityProvenance,
      revenueFunnelProvenance,
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
      reason: "EVIDENCE_CHANGED_DURING_OPPORTUNITY_PRIORITIZATION",
      evidenceManifestHash: evidence.manifestHash,
      competitionProvenance: rank.competitionProvenance,
      authorityProvenance: rank.authorityProvenance,
      revenueFunnelProvenance,
    });
  }

  return decision({
    siteId,
    controlGeneration: evidence.controlGeneration,
    status: report.status === "PRIORITIZATION_READY" ? "READY" : "INSUFFICIENT_DATA",
    reason: report.status === "PRIORITIZATION_READY"
      ? "OPPORTUNITY_PRIORITIZATION_READY"
      : "NO_ELIGIBLE_OPPORTUNITIES",
    evidenceManifestHash: evidence.manifestHash,
    competitionProvenance: rank.competitionProvenance,
    authorityProvenance: rank.authorityProvenance,
    revenueFunnelProvenance,
    report,
  });
}
