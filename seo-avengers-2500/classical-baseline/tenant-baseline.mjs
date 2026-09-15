import { readTenantControl } from "../control-plane/tenant-control.mjs";
import { readTenantEvidenceSnapshot } from "../evidence/tenant-evidence.mjs";
import { buildTenantOptimizationProblem } from "../optimization-problem/tenant-problem.mjs";
import { buildClassicalBaselineReport } from "./baseline-solver.mjs";

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

export async function buildTenantClassicalBaseline({
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
    report = buildClassicalBaselineReport({ optimizationProblemReport: upstream.report, baselineProfile });
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown classical baseline error";
    return decision({
      siteId,
      controlGeneration: upstream.controlGeneration,
      status: "BLOCKED",
      reason: `CLASSICAL_BASELINE_INPUT_INVALID:${message}`,
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
      reason: "CONTROL_CHANGED_DURING_CLASSICAL_BASELINE",
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
      reason: "EVIDENCE_CHANGED_DURING_CLASSICAL_BASELINE",
      evidenceManifestHash: manifestHash,
      optimizationProblemReportSha256: upstream.report.reportSha256,
    });
  }

  if (report.status !== "OPTIMAL" || !report.solution.optimalityProven) {
    return decision({
      siteId,
      controlGeneration: generation,
      status: "INSUFFICIENT_DATA",
      reason: "CLASSICAL_BASELINE_NOT_PROVEN_OPTIMAL",
      evidenceManifestHash: manifestHash,
      optimizationProblemReportSha256: upstream.report.reportSha256,
      report,
    });
  }

  return decision({
    siteId,
    controlGeneration: generation,
    status: "READY",
    reason: "CLASSICAL_BASELINE_OPTIMAL",
    evidenceManifestHash: manifestHash,
    optimizationProblemReportSha256: upstream.report.reportSha256,
    report,
  });
}
