import { readTenantControl } from "../control-plane/tenant-control.mjs";
import { readTenantEvidenceSnapshot } from "../evidence/tenant-evidence.mjs";
import { buildRankFeasibilityWithTrendReport } from "./longitudinal-engine.mjs";

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

export async function buildTenantRankFeasibilityWithTrend({
  controlRoot,
  evidenceRoot,
  siteId,
  feasibilityAssumptionProfile,
  trendAssumptionProfile,
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

  const missing = [];
  if (!Array.isArray(evidence.datasets.search_performance_records)) missing.push("search_performance_records");
  if (!Array.isArray(evidence.datasets.search_performance_history_records)) missing.push("search_performance_history_records");
  if (missing.length > 0) {
    return decision({
      siteId,
      controlGeneration: evidence.controlGeneration,
      status: "INSUFFICIENT_DATA",
      reason: `REQUIRED_DATASETS_MISSING:${missing.join(",")}`,
      evidenceManifestHash: evidence.manifestHash,
    });
  }

  const empty = [];
  if (evidence.datasets.search_performance_records.length === 0) empty.push("search_performance_records");
  if (evidence.datasets.search_performance_history_records.length === 0) empty.push("search_performance_history_records");
  if (empty.length > 0) {
    return decision({
      siteId,
      controlGeneration: evidence.controlGeneration,
      status: "INSUFFICIENT_DATA",
      reason: `REQUIRED_DATASETS_EMPTY:${empty.join(",")}`,
      evidenceManifestHash: evidence.manifestHash,
    });
  }

  let report;
  try {
    report = buildRankFeasibilityWithTrendReport({
      searchPerformanceRecords: evidence.datasets.search_performance_records,
      searchPerformanceHistoryRecords: evidence.datasets.search_performance_history_records,
      feasibilityAssumptionProfile,
      trendAssumptionProfile,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown longitudinal feasibility error";
    return decision({
      siteId,
      controlGeneration: evidence.controlGeneration,
      status: "BLOCKED",
      reason: `RANK_FEASIBILITY_TREND_INPUT_INVALID:${message}`,
      evidenceManifestHash: evidence.manifestHash,
    });
  }

  const controlAfter = await readTenantControl({ controlRoot, siteId });
  if (!controlAfter.authorized || !controlAfter.integrityOk || controlAfter.generation !== evidence.controlGeneration) {
    return decision({
      siteId,
      controlGeneration: controlAfter.generation,
      status: "STALE",
      reason: "CONTROL_CHANGED_DURING_RANK_FEASIBILITY_TREND",
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
      reason: "EVIDENCE_CHANGED_DURING_RANK_FEASIBILITY_TREND",
      evidenceManifestHash: evidence.manifestHash,
    });
  }

  return decision({
    siteId,
    controlGeneration: evidence.controlGeneration,
    status: "READY",
    reason: "RANK_FEASIBILITY_TREND_READY",
    evidenceManifestHash: evidence.manifestHash,
    report,
  });
}
