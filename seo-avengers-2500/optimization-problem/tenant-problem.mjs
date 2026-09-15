import { readTenantControl } from "../control-plane/tenant-control.mjs";
import { buildTenantDecisionReport } from "../decision-engine/tenant-decision.mjs";
import { readTenantEvidenceSnapshot } from "../evidence/tenant-evidence.mjs";
import { buildOptimizationProblemReport } from "./problem-builder.mjs";

function decision({
  siteId,
  controlGeneration,
  status,
  reason,
  evidenceManifestHash = null,
  decisionReportSha256 = null,
  report = null,
}) {
  return Object.freeze({
    siteId,
    controlGeneration,
    status,
    reason,
    evidenceManifestHash,
    decisionReportSha256,
    report,
  });
}

export async function buildTenantOptimizationProblem({
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
}) {
  const upstream = await buildTenantDecisionReport({
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
  });
  if (upstream.status !== "READY" || upstream.report === null) {
    return decision({
      siteId: upstream.siteId,
      controlGeneration: upstream.controlGeneration,
      status: upstream.status,
      reason: `DECISION_NOT_READY:${upstream.reason}`,
      evidenceManifestHash: upstream.evidenceManifestHash,
      decisionReportSha256: upstream.report?.reportSha256 ?? null,
    });
  }

  let report;
  try {
    report = buildOptimizationProblemReport({ decisionReport: upstream.report, planningProfile });
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown optimization problem error";
    return decision({
      siteId,
      controlGeneration: upstream.controlGeneration,
      status: "BLOCKED",
      reason: `OPTIMIZATION_PROBLEM_INPUT_INVALID:${message}`,
      evidenceManifestHash: upstream.evidenceManifestHash,
      decisionReportSha256: upstream.report.reportSha256,
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
      reason: "CONTROL_CHANGED_DURING_OPTIMIZATION_PROBLEM_BUILD",
      evidenceManifestHash: manifestHash,
      decisionReportSha256: upstream.report.reportSha256,
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
      reason: "EVIDENCE_CHANGED_DURING_OPTIMIZATION_PROBLEM_BUILD",
      evidenceManifestHash: manifestHash,
      decisionReportSha256: upstream.report.reportSha256,
    });
  }

  return decision({
    siteId,
    controlGeneration: generation,
    status: "READY",
    reason: "OPTIMIZATION_PROBLEM_READY",
    evidenceManifestHash: manifestHash,
    decisionReportSha256: upstream.report.reportSha256,
    report,
  });
}
