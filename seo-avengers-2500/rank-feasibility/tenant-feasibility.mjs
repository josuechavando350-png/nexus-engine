import { readTenantControl } from "../control-plane/tenant-control.mjs";
import { readTenantEvidenceSnapshot } from "../evidence/tenant-evidence.mjs";
import { buildRankFeasibilityReport } from "./feasibility-engine.mjs";

function decision({
  siteId,
  controlGeneration,
  status,
  reason,
  evidenceManifestHash = null,
  report = null,
}) {
  return Object.freeze({
    siteId,
    controlGeneration,
    status,
    reason,
    evidenceManifestHash,
    report,
  });
}

export async function buildTenantRankFeasibility({
  controlRoot,
  evidenceRoot,
  siteId,
  assumptionProfile,
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

  if (!Array.isArray(evidence.datasets.search_performance_records)) {
    return decision({
      siteId,
      controlGeneration: evidence.controlGeneration,
      status: "INSUFFICIENT_DATA",
      reason: "REQUIRED_DATASETS_MISSING:search_performance_records",
      evidenceManifestHash: evidence.manifestHash,
    });
  }

  let report;
  try {
    report = buildRankFeasibilityReport({
      searchPerformanceRecords: evidence.datasets.search_performance_records,
      assumptionProfile,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown feasibility error";
    const insufficient = message.startsWith("INSUFFICIENT_DATA:");
    return decision({
      siteId,
      controlGeneration: evidence.controlGeneration,
      status: insufficient ? "INSUFFICIENT_DATA" : "BLOCKED",
      reason: insufficient ? message : `RANK_FEASIBILITY_INPUT_INVALID:${message}`,
      evidenceManifestHash: evidence.manifestHash,
    });
  }

  const controlAfter = await readTenantControl({ controlRoot, siteId });
  if (!controlAfter.authorized || !controlAfter.integrityOk || controlAfter.generation !== evidence.controlGeneration) {
    return decision({
      siteId,
      controlGeneration: controlAfter.generation,
      status: "STALE",
      reason: "CONTROL_CHANGED_DURING_RANK_FEASIBILITY",
      evidenceManifestHash: evidence.manifestHash,
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
      reason: "EVIDENCE_CHANGED_DURING_RANK_FEASIBILITY",
      evidenceManifestHash: evidence.manifestHash,
    });
  }

  return decision({
    siteId,
    controlGeneration: evidence.controlGeneration,
    status: "READY",
    reason: "RANK_FEASIBILITY_READY",
    evidenceManifestHash: evidence.manifestHash,
    report,
  });
}
