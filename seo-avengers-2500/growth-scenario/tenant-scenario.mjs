import { readTenantControl } from "../control-plane/tenant-control.mjs";
import { readTenantEvidenceSnapshot } from "../evidence/tenant-evidence.mjs";
import { buildGrowthScenarioReport } from "./scenario-engine.mjs";

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

function missingRequiredDatasets(evidence) {
  const missing = [];
  for (const key of ["search_performance_records", "revenue_funnel_records"]) {
    if (!Array.isArray(evidence.datasets[key])) missing.push(key);
  }
  return missing;
}

export async function buildTenantGrowthScenario({
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

  const missing = missingRequiredDatasets(evidence);
  if (missing.length > 0) {
    return decision({
      siteId,
      controlGeneration: evidence.controlGeneration,
      status: "INSUFFICIENT_DATA",
      reason: `REQUIRED_DATASETS_MISSING:${missing.join(",")}`,
      evidenceManifestHash: evidence.manifestHash,
    });
  }

  let report;
  try {
    report = buildGrowthScenarioReport({
      searchPerformanceRecords: evidence.datasets.search_performance_records,
      revenueFunnelRecords: evidence.datasets.revenue_funnel_records,
      assumptionProfile,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown scenario error";
    const insufficient = message.startsWith("INSUFFICIENT_DATA:");
    return decision({
      siteId,
      controlGeneration: evidence.controlGeneration,
      status: insufficient ? "INSUFFICIENT_DATA" : "BLOCKED",
      reason: insufficient ? message : `SCENARIO_INPUT_INVALID:${message}`,
      evidenceManifestHash: evidence.manifestHash,
    });
  }

  const controlAfter = await readTenantControl({ controlRoot, siteId });
  if (!controlAfter.authorized || !controlAfter.integrityOk || controlAfter.generation !== evidence.controlGeneration) {
    return decision({
      siteId,
      controlGeneration: controlAfter.generation,
      status: "STALE",
      reason: "CONTROL_CHANGED_DURING_SCENARIO",
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
      reason: "EVIDENCE_CHANGED_DURING_SCENARIO",
      evidenceManifestHash: evidence.manifestHash,
    });
  }

  return decision({
    siteId,
    controlGeneration: evidence.controlGeneration,
    status: "READY",
    reason: "SCENARIO_READY",
    evidenceManifestHash: evidence.manifestHash,
    report,
  });
}
