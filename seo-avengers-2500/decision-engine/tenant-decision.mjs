import { readTenantControl } from "../control-plane/tenant-control.mjs";
import { readTenantEvidenceSnapshot } from "../evidence/tenant-evidence.mjs";
import { buildTenantOpportunityPrioritization } from "../opportunity-prioritization/tenant-prioritization.mjs";
import { buildTenantOutcomeCalibration } from "../outcome-calibration/tenant-calibration.mjs";
import { buildTenantRankTransitionModel } from "../rank-transition/tenant-transition.mjs";
import { buildDecisionReport } from "./decision-engine.mjs";

function decision({
  siteId,
  controlGeneration,
  status,
  reason,
  evidenceManifestHash = null,
  prioritizationReportSha256 = null,
  rankTransitionReportSha256 = null,
  outcomeCalibrationReportSha256 = null,
  report = null,
}) {
  return Object.freeze({
    siteId,
    controlGeneration,
    status,
    reason,
    evidenceManifestHash,
    prioritizationReportSha256,
    rankTransitionReportSha256,
    outcomeCalibrationReportSha256,
    report,
  });
}

function acceptableEvidenceReport(result) {
  return (result.status === "READY" || result.status === "INSUFFICIENT_DATA") && result.report !== null;
}

export async function buildTenantDecisionReport({
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
}) {
  const prioritization = await buildTenantOpportunityPrioritization({
    controlRoot,
    evidenceRoot,
    siteId,
    feasibilityAssumptionProfile,
    trendAssumptionProfile,
    competitionAssumptionProfile,
    authorityAssumptionProfile,
    growthAssumptionProfile,
    prioritizationProfile,
  });
  if (prioritization.status !== "READY" || prioritization.report === null) {
    return decision({
      siteId: prioritization.siteId,
      controlGeneration: prioritization.controlGeneration,
      status: prioritization.status,
      reason: `PRIORITIZATION_NOT_READY:${prioritization.reason}`,
      evidenceManifestHash: prioritization.evidenceManifestHash,
      prioritizationReportSha256: prioritization.report?.reportSha256 ?? null,
    });
  }

  const calibration = await buildTenantOutcomeCalibration({
    controlRoot,
    evidenceRoot,
    siteId,
    calibrationSnapshot,
    calibrationProfile,
  });
  if (!acceptableEvidenceReport(calibration)) {
    return decision({
      siteId: calibration.siteId,
      controlGeneration: calibration.controlGeneration,
      status: calibration.status,
      reason: `CALIBRATION_NOT_AVAILABLE:${calibration.reason}`,
      evidenceManifestHash: calibration.evidenceManifestHash,
      prioritizationReportSha256: prioritization.report.reportSha256,
      outcomeCalibrationReportSha256: calibration.report?.reportSha256 ?? null,
    });
  }

  const transition = await buildTenantRankTransitionModel({
    controlRoot,
    evidenceRoot,
    siteId,
    feasibilityAssumptionProfile,
    trendAssumptionProfile,
    competitionAssumptionProfile,
    authorityAssumptionProfile,
    transitionProfile,
    transitionSnapshot,
  });
  if (!acceptableEvidenceReport(transition)) {
    return decision({
      siteId: transition.siteId,
      controlGeneration: transition.controlGeneration,
      status: transition.status,
      reason: `RANK_TRANSITION_NOT_AVAILABLE:${transition.reason}`,
      evidenceManifestHash: transition.evidenceManifestHash,
      prioritizationReportSha256: prioritization.report.reportSha256,
      rankTransitionReportSha256: transition.report?.reportSha256 ?? null,
      outcomeCalibrationReportSha256: calibration.report.reportSha256,
    });
  }

  const generation = prioritization.controlGeneration;
  const manifestHash = prioritization.evidenceManifestHash;
  if (
    calibration.controlGeneration !== generation
    || transition.controlGeneration !== generation
    || calibration.evidenceManifestHash !== manifestHash
    || transition.evidenceManifestHash !== manifestHash
  ) {
    return decision({
      siteId,
      controlGeneration: generation,
      status: "STALE",
      reason: "UPSTREAM_DECISION_INPUT_BINDINGS_DIVERGED",
      evidenceManifestHash: manifestHash,
      prioritizationReportSha256: prioritization.report.reportSha256,
      rankTransitionReportSha256: transition.report.reportSha256,
      outcomeCalibrationReportSha256: calibration.report.reportSha256,
    });
  }

  let report;
  try {
    report = buildDecisionReport({
      prioritizationReport: prioritization.report,
      rankTransitionReport: transition.report,
      outcomeCalibrationReport: calibration.report,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown decision engine error";
    return decision({
      siteId,
      controlGeneration: generation,
      status: "BLOCKED",
      reason: `DECISION_INPUT_INVALID:${message}`,
      evidenceManifestHash: manifestHash,
      prioritizationReportSha256: prioritization.report.reportSha256,
      rankTransitionReportSha256: transition.report.reportSha256,
      outcomeCalibrationReportSha256: calibration.report.reportSha256,
    });
  }

  const controlAfter = await readTenantControl({ controlRoot, siteId });
  if (!controlAfter.authorized || !controlAfter.integrityOk || controlAfter.generation !== generation) {
    return decision({
      siteId,
      controlGeneration: controlAfter.generation,
      status: "STALE",
      reason: "CONTROL_CHANGED_DURING_DECISION_ENGINE",
      evidenceManifestHash: manifestHash,
      prioritizationReportSha256: prioritization.report.reportSha256,
      rankTransitionReportSha256: transition.report.reportSha256,
      outcomeCalibrationReportSha256: calibration.report.reportSha256,
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
      reason: "EVIDENCE_CHANGED_DURING_DECISION_ENGINE",
      evidenceManifestHash: manifestHash,
      prioritizationReportSha256: prioritization.report.reportSha256,
      rankTransitionReportSha256: transition.report.reportSha256,
      outcomeCalibrationReportSha256: calibration.report.reportSha256,
    });
  }

  return decision({
    siteId,
    controlGeneration: generation,
    status: report.status === "DECISION_READY" ? "READY" : "INSUFFICIENT_DATA",
    reason: report.status === "DECISION_READY" ? "DECISION_REPORT_READY" : "DECISION_EVIDENCE_INSUFFICIENT",
    evidenceManifestHash: manifestHash,
    prioritizationReportSha256: prioritization.report.reportSha256,
    rankTransitionReportSha256: transition.report.reportSha256,
    outcomeCalibrationReportSha256: calibration.report.reportSha256,
    report,
  });
}
