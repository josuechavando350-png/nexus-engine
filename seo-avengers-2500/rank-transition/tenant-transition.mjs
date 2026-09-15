import { readTenantControl } from "../control-plane/tenant-control.mjs";
import { readTenantEvidenceSnapshot } from "../evidence/tenant-evidence.mjs";
import { buildTenantRankContextWithAuthority } from "../rank-feasibility/tenant-authority.mjs";
import { buildRankTransitionReport, validateRankTransitionSnapshot } from "./transition-engine.mjs";

function decision({
  siteId,
  controlGeneration,
  status,
  reason,
  evidenceManifestHash = null,
  rankContextReportSha256 = null,
  transitionSnapshotSha256 = null,
  report = null,
}) {
  return Object.freeze({
    siteId,
    controlGeneration,
    status,
    reason,
    evidenceManifestHash,
    rankContextReportSha256,
    transitionSnapshotSha256,
    report,
  });
}

function latestEvidenceObservedAtUnixMs(evidence) {
  const rows = evidence?.datasets?.upstream_evidence;
  if (!Array.isArray(rows)) return null;
  let latest = null;
  for (const row of rows) {
    const value = row?.observed_at_unix_ms;
    if (!Number.isSafeInteger(value) || value < 1) continue;
    if (latest === null || value > latest) latest = value;
  }
  return latest;
}

export async function buildTenantRankTransitionModel({
  controlRoot,
  evidenceRoot,
  siteId,
  feasibilityAssumptionProfile,
  trendAssumptionProfile,
  competitionAssumptionProfile,
  authorityAssumptionProfile,
  transitionProfile,
  transitionSnapshot,
}) {
  const base = await buildTenantRankContextWithAuthority({
    controlRoot,
    evidenceRoot,
    siteId,
    feasibilityAssumptionProfile,
    trendAssumptionProfile,
    competitionAssumptionProfile,
    authorityAssumptionProfile,
  });
  if (base.status !== "READY" || base.report === null) {
    return decision({
      siteId: base.siteId,
      controlGeneration: base.controlGeneration,
      status: base.status,
      reason: base.reason,
      evidenceManifestHash: base.evidenceManifestHash,
      rankContextReportSha256: base.report?.reportSha256 ?? null,
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
      reason: "EVIDENCE_CHANGED_BEFORE_RANK_TRANSITION",
      evidenceManifestHash: base.evidenceManifestHash,
      rankContextReportSha256: base.report.reportSha256,
    });
  }

  let validatedSnapshot;
  try {
    validatedSnapshot = validateRankTransitionSnapshot(transitionSnapshot, transitionProfile);
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown rank transition snapshot error";
    return decision({
      siteId,
      controlGeneration: evidence.controlGeneration,
      status: "BLOCKED",
      reason: `RANK_TRANSITION_SNAPSHOT_INVALID:${message}`,
      evidenceManifestHash: evidence.manifestHash,
      rankContextReportSha256: base.report.reportSha256,
    });
  }

  if (validatedSnapshot.siteId !== siteId) {
    return decision({
      siteId,
      controlGeneration: evidence.controlGeneration,
      status: "BLOCKED",
      reason: "RANK_TRANSITION_CROSS_TENANT_SNAPSHOT",
      evidenceManifestHash: evidence.manifestHash,
      rankContextReportSha256: base.report.reportSha256,
      transitionSnapshotSha256: validatedSnapshot.sha256,
    });
  }
  if (validatedSnapshot.controlGeneration !== evidence.controlGeneration) {
    return decision({
      siteId,
      controlGeneration: evidence.controlGeneration,
      status: "STALE",
      reason: "RANK_TRANSITION_CONTROL_GENERATION_STALE",
      evidenceManifestHash: evidence.manifestHash,
      rankContextReportSha256: base.report.reportSha256,
      transitionSnapshotSha256: validatedSnapshot.sha256,
    });
  }
  if (validatedSnapshot.evidenceManifestHash !== evidence.manifestHash) {
    return decision({
      siteId,
      controlGeneration: evidence.controlGeneration,
      status: "STALE",
      reason: "RANK_TRANSITION_EVIDENCE_MANIFEST_STALE",
      evidenceManifestHash: evidence.manifestHash,
      rankContextReportSha256: base.report.reportSha256,
      transitionSnapshotSha256: validatedSnapshot.sha256,
    });
  }

  const latestObservedAtUnixMs = latestEvidenceObservedAtUnixMs(evidence);
  if (latestObservedAtUnixMs === null) {
    return decision({
      siteId,
      controlGeneration: evidence.controlGeneration,
      status: "BLOCKED",
      reason: "CURRENT_EVIDENCE_OBSERVATION_TIME_MISSING",
      evidenceManifestHash: evidence.manifestHash,
      rankContextReportSha256: base.report.reportSha256,
      transitionSnapshotSha256: validatedSnapshot.sha256,
    });
  }
  if (validatedSnapshot.observedAtUnixMs > latestObservedAtUnixMs) {
    return decision({
      siteId,
      controlGeneration: evidence.controlGeneration,
      status: "BLOCKED",
      reason: "RANK_TRANSITION_HISTORY_NEWER_THAN_CURRENT_EVIDENCE",
      evidenceManifestHash: evidence.manifestHash,
      rankContextReportSha256: base.report.reportSha256,
      transitionSnapshotSha256: validatedSnapshot.sha256,
    });
  }

  let report;
  try {
    report = buildRankTransitionReport({
      rankAuthorityContextReport: base.report,
      transitionSnapshot,
      transitionProfile,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown rank transition error";
    return decision({
      siteId,
      controlGeneration: evidence.controlGeneration,
      status: "BLOCKED",
      reason: `RANK_TRANSITION_INPUT_INVALID:${message}`,
      evidenceManifestHash: evidence.manifestHash,
      rankContextReportSha256: base.report.reportSha256,
      transitionSnapshotSha256: validatedSnapshot.sha256,
    });
  }

  const controlAfter = await readTenantControl({ controlRoot, siteId });
  if (!controlAfter.authorized || !controlAfter.integrityOk || controlAfter.generation !== evidence.controlGeneration) {
    return decision({
      siteId,
      controlGeneration: controlAfter.generation,
      status: "STALE",
      reason: "CONTROL_CHANGED_DURING_RANK_TRANSITION",
      evidenceManifestHash: evidence.manifestHash,
      rankContextReportSha256: base.report.reportSha256,
      transitionSnapshotSha256: validatedSnapshot.sha256,
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
      reason: "EVIDENCE_CHANGED_DURING_RANK_TRANSITION",
      evidenceManifestHash: evidence.manifestHash,
      rankContextReportSha256: base.report.reportSha256,
      transitionSnapshotSha256: validatedSnapshot.sha256,
    });
  }

  return decision({
    siteId,
    controlGeneration: evidence.controlGeneration,
    status: report.status === "TRANSITION_READY" ? "READY" : "INSUFFICIENT_DATA",
    reason: report.status === "TRANSITION_READY" ? "RANK_TRANSITION_MODEL_READY" : "RANK_TRANSITION_SAMPLE_INSUFFICIENT",
    evidenceManifestHash: evidence.manifestHash,
    rankContextReportSha256: base.report.reportSha256,
    transitionSnapshotSha256: validatedSnapshot.sha256,
    report,
  });
}
