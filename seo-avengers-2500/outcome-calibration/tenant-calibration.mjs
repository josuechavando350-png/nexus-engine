import { readTenantControl } from "../control-plane/tenant-control.mjs";
import { readTenantEvidenceSnapshot } from "../evidence/tenant-evidence.mjs";
import {
  buildOutcomeCalibrationReport,
  validateOutcomeCalibrationSnapshot,
} from "./calibration-engine.mjs";

function decision({
  siteId,
  controlGeneration,
  status,
  reason,
  evidenceManifestHash = null,
  calibrationSnapshotSha256 = null,
  report = null,
}) {
  return Object.freeze({
    siteId,
    controlGeneration,
    status,
    reason,
    evidenceManifestHash,
    calibrationSnapshotSha256,
    report,
  });
}

export async function buildTenantOutcomeCalibration({
  controlRoot,
  evidenceRoot,
  siteId,
  calibrationSnapshot,
  calibrationProfile,
}) {
  const evidence = await readTenantEvidenceSnapshot({ controlRoot, evidenceRoot, siteId });
  if (evidence.status !== "READY" || !evidence.integrityOk) {
    return decision({
      siteId,
      controlGeneration: evidence.controlGeneration,
      status: evidence.status,
      reason: evidence.reason,
      evidenceManifestHash: evidence.manifestHash,
    });
  }

  let snapshot;
  let report;
  try {
    snapshot = validateOutcomeCalibrationSnapshot(calibrationSnapshot);
    if (snapshot.siteId !== siteId) throw new Error("calibration snapshot site_id mismatch");
    if (snapshot.controlGeneration !== evidence.controlGeneration) {
      return decision({
        siteId,
        controlGeneration: evidence.controlGeneration,
        status: "STALE",
        reason: "CALIBRATION_SNAPSHOT_CONTROL_GENERATION_STALE",
        evidenceManifestHash: evidence.manifestHash,
        calibrationSnapshotSha256: snapshot.sha256,
      });
    }
    if (snapshot.evidenceManifestHash !== evidence.manifestHash) {
      return decision({
        siteId,
        controlGeneration: evidence.controlGeneration,
        status: "STALE",
        reason: "CALIBRATION_SNAPSHOT_EVIDENCE_MANIFEST_STALE",
        evidenceManifestHash: evidence.manifestHash,
        calibrationSnapshotSha256: snapshot.sha256,
      });
    }
    if (snapshot.records.some((row) => row.windowEndUnixMs > snapshot.observedAtUnixMs)) {
      throw new Error("calibration snapshot cannot precede an observation window end");
    }
    report = buildOutcomeCalibrationReport({ calibrationSnapshot, calibrationProfile });
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown outcome calibration error";
    return decision({
      siteId,
      controlGeneration: evidence.controlGeneration,
      status: "BLOCKED",
      reason: `OUTCOME_CALIBRATION_INPUT_INVALID:${message}`,
      evidenceManifestHash: evidence.manifestHash,
      calibrationSnapshotSha256: snapshot?.sha256 ?? null,
    });
  }

  const controlAfter = await readTenantControl({ controlRoot, siteId });
  if (!controlAfter.authorized || !controlAfter.integrityOk || controlAfter.generation !== evidence.controlGeneration) {
    return decision({
      siteId,
      controlGeneration: controlAfter.generation,
      status: "STALE",
      reason: "CONTROL_CHANGED_DURING_OUTCOME_CALIBRATION",
      evidenceManifestHash: evidence.manifestHash,
      calibrationSnapshotSha256: snapshot.sha256,
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
      reason: "EVIDENCE_CHANGED_DURING_OUTCOME_CALIBRATION",
      evidenceManifestHash: evidence.manifestHash,
      calibrationSnapshotSha256: snapshot.sha256,
    });
  }

  return decision({
    siteId,
    controlGeneration: evidence.controlGeneration,
    status: report.status === "CALIBRATION_READY" ? "READY" : "INSUFFICIENT_DATA",
    reason: report.status === "CALIBRATION_READY"
      ? "OUTCOME_CALIBRATION_READY"
      : "OUTCOME_CALIBRATION_SAMPLE_INSUFFICIENT",
    evidenceManifestHash: evidence.manifestHash,
    calibrationSnapshotSha256: snapshot.sha256,
    report,
  });
}
