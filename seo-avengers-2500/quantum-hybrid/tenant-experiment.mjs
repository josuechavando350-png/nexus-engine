import { readTenantControl } from "../control-plane/tenant-control.mjs";
import { readTenantEvidenceSnapshot } from "../evidence/tenant-evidence.mjs";
import { buildTenantOptimizationProblem } from "../optimization-problem/tenant-problem.mjs";
import { buildQuantumHybridExperimentReport } from "./qaoa-experiment.mjs";

function decision({
  siteId,
  controlGeneration,
  status,
  reason,
  evidenceManifestHash = null,
  optimizationProblemReportSha256 = null,
  report = null,
}) {
  return Object.freeze({
    siteId,
    controlGeneration,
    status,
    reason,
    evidenceManifestHash,
    optimizationProblemReportSha256,
    report,
  });
}

export async function buildTenantQuantumHybridExperiment({
  controlRoot,
  evidenceRoot,
  siteId,
  feasibilityAssumptionProfile,
  trendAssumptionProfile,
  competitionAssumptionProfile,
  authorityAssumptionProfile,
  growthAssumptionProfile,
  prioritizationProfile,
  calibrationSnapshot,
  calibrationProfile,
  transitionSnapshot,
  transitionProfile,
  planningProfile,
  baselineProfile,
  experimentProfile,
}) {
  const upstream = await buildTenantOptimizationProblem({
    controlRoot,
    evidenceRoot,
    siteId,
    feasibilityAssumptionProfile,
    trendAssumptionProfile,
    competitionAssumptionProfile,
    authorityAssumptionProfile,
    growthAssumptionProfile,
    prioritizationProfile,
    calibrationSnapshot,
    calibrationProfile,
    transitionSnapshot,
    transitionProfile,
    planningProfile,
  });

  if (upstream.status !== "READY" || upstream.report === null) {
    return decision({
      siteId: upstream.siteId,
      controlGeneration: upstream.controlGeneration,
      status: upstream.status,
      reason: `OPTIMIZATION_PROBLEM_NOT_READY:${upstream.reason}`,
      evidenceManifestHash: upstream.evidenceManifestHash,
      optimizationProblemReportSha256: upstream.report?.reportSha256 ?? null,
    });
  }

  let report;
  try {
    report = buildQuantumHybridExperimentReport({
      optimizationProblemReport: upstream.report,
      baselineProfile,
      experimentProfile,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown quantum-hybrid experiment error";
    return decision({
      siteId,
      controlGeneration: upstream.controlGeneration,
      status: "BLOCKED",
      reason: `QUANTUM_HYBRID_EXPERIMENT_INVALID:${message}`,
      evidenceManifestHash: upstream.evidenceManifestHash,
      optimizationProblemReportSha256: upstream.report.reportSha256,
    });
  }

  const generation = upstream.controlGeneration;
  const manifestHash = upstream.evidenceManifestHash;
  const controlAfter = await readTenantControl({ controlRoot, siteId });
  if (!controlAfter.authorized || !controlAfter.integrityOk || controlAfter.generation !== generation) {
    return decision({
      siteId,
      controlGeneration: controlAfter.generation,
      status: "STALE",
      reason: "CONTROL_CHANGED_DURING_QUANTUM_HYBRID_EXPERIMENT",
      evidenceManifestHash: manifestHash,
      optimizationProblemReportSha256: upstream.report.reportSha256,
    });
  }

  const evidenceAfter = await readTenantEvidenceSnapshot({ controlRoot, evidenceRoot, siteId });
  if (
    evidenceAfter.status !== "READY"
    || !evidenceAfter.integrityOk
    || evidenceAfter.controlGeneration !== generation
    || evidenceAfter.manifestHash !== manifestHash
  ) {
    return decision({
      siteId,
      controlGeneration: evidenceAfter.controlGeneration,
      status: "STALE",
      reason: "EVIDENCE_CHANGED_DURING_QUANTUM_HYBRID_EXPERIMENT",
      evidenceManifestHash: manifestHash,
      optimizationProblemReportSha256: upstream.report.reportSha256,
    });
  }

  return decision({
    siteId,
    controlGeneration: generation,
    status: report.status === "EXPERIMENT_COMPLETE" ? "READY" : "INSUFFICIENT_DATA",
    reason: report.status === "EXPERIMENT_COMPLETE"
      ? "CONTROLLED_QAOA_SIMULATION_COMPLETE"
      : "CLASSICAL_BASELINE_NOT_PROVEN_FOR_COMPARISON",
    evidenceManifestHash: manifestHash,
    optimizationProblemReportSha256: upstream.report.reportSha256,
    report,
  });
}
