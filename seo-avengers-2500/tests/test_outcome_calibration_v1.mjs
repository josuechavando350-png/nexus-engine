import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { setTenantEnabled } from "../control-plane/tenant-control.mjs";
import { readTenantEvidenceSnapshot } from "../evidence/tenant-evidence.mjs";
import { canonicalProviderRecordsSha256, publishAuthorizedProviderSnapshot } from "../evidence/authorized-provider-snapshot.mjs";
import {
  buildOutcomeCalibrationReport,
  canonicalCalibrationRecordsSha256,
  validateOutcomeCalibrationSnapshot,
} from "../outcome-calibration/calibration-engine.mjs";
import { buildTenantOutcomeCalibration } from "../outcome-calibration/tenant-calibration.mjs";

const SITE_ID = "walle-outcome-calibration-probe";
const SOURCE_AUTHORITY = "WALLE_GROWTH_ATTRIBUTION_CALIBRATION_EXPORT_V1";
const SOURCE_CAPTURE_SHA256 = hash("synthetic calibration export capture");
const PROFILE = Object.freeze({
  schema_version: 1,
  profile_id: "outcome-calibration-v1-test",
  provenance: "synthetic deterministic first-party outcome calibration fixture",
  minimum_records: 2,
  minimum_attribution_completeness_ppm: 900_000,
});

function hash(value) {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function record(id, overrides = {}) {
  const ordinal = Number(id.replace(/\D/g, "")) || 1;
  return {
    calibration_id: id,
    scenario_id: ordinal % 2 === 0 ? "UPSIDE" : "BASE",
    rank_target: ordinal % 2 === 0 ? "TOP_3" : "TOP_10",
    scenario_report_sha256: hash(`scenario-report-${id}`),
    scenario_assumption_profile_sha256: hash(`scenario-profile-${id}`),
    feasibility_report_sha256: hash(`feasibility-${id}`),
    decision_report_sha256: hash(`decision-${id}`),
    action_receipt_sha256: hash(`action-${id}`),
    growth_attribution_receipt_sha256: hash(`growth-attribution-${id}`),
    client_cohort_report_sha256: hash(`client-cohort-${id}`),
    prediction_created_at_unix_ms: 1_000_000 + ordinal,
    action_executed_at_unix_ms: 2_000_000 + ordinal,
    window_start_unix_ms: 3_000_000 + ordinal,
    window_end_unix_ms: 4_000_000 + ordinal,
    observation_complete: true,
    attribution_completeness_ppm: 950_000,
    modeled_lead_conversion_ppm: 200_000,
    observed_lead_conversion_ppm: ordinal % 2 === 0 ? 160_000 : 240_000,
    modeled_close_rate_ppm: 250_000,
    observed_close_rate_ppm: ordinal % 2 === 0 ? 300_000 : 200_000,
    modeled_average_ticket_micros: 10_000_000_000,
    observed_average_ticket_micros: ordinal % 2 === 0 ? 8_000_000_000 : 12_000_000_000,
    ...overrides,
  };
}

function records() {
  return [record("cal-001"), record("cal-002")];
}

function snapshot({
  rows = records(),
  controlGeneration = 1,
  evidenceManifestHash = hash("synthetic evidence manifest"),
  observedAtUnixMs = 5_000_000,
  sourceAuthority = SOURCE_AUTHORITY,
  recordsSha256 = canonicalCalibrationRecordsSha256(rows),
} = {}) {
  return {
    schema_version: 1,
    site_id: SITE_ID,
    control_generation: controlGeneration,
    evidence_manifest_hash: evidenceManifestHash,
    capture_id: "outcome-calibration-capture-001",
    observed_at_unix_ms: observedAtUnixMs,
    source_authority: sourceAuthority,
    source_capture_sha256: SOURCE_CAPTURE_SHA256,
    records_sha256: recordsSha256,
    records: rows,
  };
}

function build(rows = records(), profile = PROFILE) {
  return buildOutcomeCalibrationReport({ calibrationSnapshot: snapshot({ rows }), calibrationProfile: profile });
}

async function setupTenant() {
  const root = await mkdtemp(join(tmpdir(), "walle-outcome-calibration-"));
  const controlRoot = join(root, "control");
  const evidenceRoot = join(root, "evidence");
  await mkdir(controlRoot, { mode: 0o700 });
  await mkdir(evidenceRoot, { mode: 0o700 });
  await mkdir(join(evidenceRoot, "tenants"), { mode: 0o700 });
  const control = await setTenantEnabled({ controlRoot, siteId: SITE_ID, enabled: true, expectedGeneration: 0 });
  const funnelRecords = [
    {
      source_id: "synthetic-organic",
      sessions: 1000,
      lead_conversion_ppm: 200_000,
      close_rate_ppm: 250_000,
      average_ticket_micros: 10_000_000_000,
    },
  ];
  const published = await publishAuthorizedProviderSnapshot({
    controlRoot,
    evidenceRoot,
    siteId: SITE_ID,
    snapshot: {
      schema_version: 1,
      site_id: SITE_ID,
      control_generation: control.generation,
      capture_id: "outcome-calibration-evidence-001",
      observed_at_unix_ms: 4_500_000,
      datasets: [
        {
          provider: "NEXUS_CRM",
          key: "revenue_funnel_records",
          records: funnelRecords,
          records_sha256: canonicalProviderRecordsSha256(funnelRecords),
        },
      ],
    },
  });
  assert.equal(published.status, "PUBLISHED");
  const evidence = await readTenantEvidenceSnapshot({ controlRoot, evidenceRoot, siteId: SITE_ID });
  assert.equal(evidence.status, "READY");
  return { controlRoot, evidenceRoot, control, evidence };
}

test("empirical calibration uses deterministic integer descriptive errors without a magic score", () => {
  const report = build();
  assert.equal(report.status, "CALIBRATION_READY");
  assert.equal(report.engineId, "WALLE_OUTCOME_CALIBRATION_V1");
  assert.equal(report.summary.inputRecordCount, 2);
  assert.equal(report.summary.acceptedRecordCount, 2);
  assert.equal(report.summary.excludedRecordCount, 0);
  assert.deepEqual(report.summary.empiricalBands.leadConversionPpm, {
    sampleCount: 2,
    meanSignedError: 0,
    meanAbsoluteError: 40_000,
    p50AbsoluteError: 40_000,
    p90AbsoluteError: 40_000,
    maxAbsoluteError: 40_000,
  });
  assert.deepEqual(report.summary.empiricalBands.closeRatePpm, {
    sampleCount: 2,
    meanSignedError: 0,
    meanAbsoluteError: 50_000,
    p50AbsoluteError: 50_000,
    p90AbsoluteError: 50_000,
    maxAbsoluteError: 50_000,
  });
  assert.deepEqual(report.summary.empiricalBands.averageTicketMicros, {
    sampleCount: 2,
    meanSignedError: 0,
    meanAbsoluteError: 2_000_000_000,
    p50AbsoluteError: 2_000_000_000,
    p90AbsoluteError: 2_000_000_000,
    maxAbsoluteError: 2_000_000_000,
  });
  assert.equal(JSON.stringify(report).includes("accuracyScore"), false);
  assert.equal(JSON.stringify(report).includes("successProbability"), false);
});

test("global sample can be ready while scenario-specific bands remain insufficient", () => {
  const report = build();
  assert.equal(report.summary.empiricalBands.status, "CALIBRATION_READY");
  assert.equal(report.summary.byScenario.BASE.status, "INSUFFICIENT_DATA");
  assert.equal(report.summary.byScenario.UPSIDE.status, "INSUFFICIENT_DATA");
  assert.equal(report.summary.byScenario.CONSERVATIVE.status, "INSUFFICIENT_DATA");
});

test("incomplete and weakly attributed observations are excluded explicitly", () => {
  const rows = [
    ...records(),
    record("cal-003", { observation_complete: false }),
    record("cal-004", { attribution_completeness_ppm: 899_999 }),
  ];
  const report = build(rows);
  assert.equal(report.status, "CALIBRATION_READY");
  assert.equal(report.summary.acceptedRecordCount, 2);
  assert.equal(report.summary.excludedRecordCount, 2);
  assert.deepEqual(report.excludedRecords, [
    { calibrationId: "cal-003", reason: "OBSERVATION_WINDOW_INCOMPLETE" },
    { calibrationId: "cal-004", reason: "ATTRIBUTION_COMPLETENESS_BELOW_PROFILE" },
  ]);
});

test("insufficient accepted sample never pretends calibration readiness", () => {
  const rows = [record("cal-001"), record("cal-002", { observation_complete: false })];
  const report = build(rows);
  assert.equal(report.status, "INSUFFICIENT_DATA");
  assert.equal(report.summary.acceptedRecordCount, 1);
  assert.equal(report.summary.empiricalBands.leadConversionPpm, null);
  assert.equal(report.summary.empiricalBands.closeRatePpm, null);
});

test("calibration remains descriptive and refuses count, revenue, causal, and rank-probability claims", () => {
  const report = build();
  assert.equal(
    report.interpretation,
    "EMPIRICAL_MODEL_COMPONENT_ERROR_NOT_CAUSAL_LIFT_OR_FORECAST_ACCURACY_GUARANTEE",
  );
  assert.equal(
    report.countCalibrationBoundary,
    "ABSOLUTE_CLIENT_AND_REVENUE_COUNT_CALIBRATION_DEFERRED_UNTIL_EXPLICIT_SCENARIO_HORIZON_EXISTS",
  );
  assert.ok(report.warnings.includes("NO_CAUSAL_SEO_LIFT_CLAIM"));
  assert.ok(report.warnings.includes("NO_RANK_PROBABILITY_CLAIM"));
  assert.ok(report.warnings.includes("NO_FUTURE_CLIENT_COUNT_GUARANTEE"));
  assert.ok(report.warnings.includes("NO_FUTURE_REVENUE_GUARANTEE"));
});

test("records and report hashes are deterministic across input ordering", () => {
  const forwardRows = records();
  const reverseRows = [...forwardRows].reverse();
  assert.equal(canonicalCalibrationRecordsSha256(forwardRows), canonicalCalibrationRecordsSha256(reverseRows));
  const forward = buildOutcomeCalibrationReport({ calibrationSnapshot: snapshot({ rows: forwardRows }), calibrationProfile: PROFILE });
  const reverse = buildOutcomeCalibrationReport({ calibrationSnapshot: snapshot({ rows: reverseRows }), calibrationProfile: PROFILE });
  assert.equal(forward.reportSha256, reverse.reportSha256);
  assert.deepEqual(forward.acceptedRecords, reverse.acceptedRecords);
});

test("profile policy is hash-bound and changes the report identity", () => {
  const a = build();
  const changedProfile = { ...PROFILE, minimum_attribution_completeness_ppm: 940_000 };
  const b = build(records(), changedProfile);
  assert.notEqual(a.calibrationProfile.sha256, b.calibrationProfile.sha256);
  assert.notEqual(a.reportSha256, b.reportSha256);
});

test("snapshot exact schema, source authority, and records digest fail closed", () => {
  assert.throws(
    () => validateOutcomeCalibrationSnapshot({ ...snapshot(), unexpected: true }),
    /unexpected calibration snapshot keys/,
  );
  assert.throws(
    () => validateOutcomeCalibrationSnapshot(snapshot({ sourceAuthority: "UNAUTHORIZED_EXPORT" })),
    /source_authority is not authorized/,
  );
  assert.throws(
    () => validateOutcomeCalibrationSnapshot(snapshot({ recordsSha256: hash("wrong-record-set") })),
    /records_sha256 mismatch/,
  );
});

test("chronology is enforced before calibration", () => {
  const bad = [record("cal-001", { prediction_created_at_unix_ms: 3_500_000 })];
  assert.throws(() => canonicalCalibrationRecordsSha256(bad), /prediction must precede action/);
  const badWindow = [record("cal-001", { window_start_unix_ms: 4_500_000, window_end_unix_ms: 4_000_000 })];
  assert.throws(() => canonicalCalibrationRecordsSha256(badWindow), /observation window must be positive/);
});

test("duplicate calibration IDs and action receipts cannot inflate the empirical sample", () => {
  assert.throws(
    () => canonicalCalibrationRecordsSha256([record("cal-001"), record("cal-001", { action_receipt_sha256: hash("other-action") })]),
    /duplicate calibration_id/,
  );
  assert.throws(
    () => canonicalCalibrationRecordsSha256([record("cal-001"), record("cal-002", { action_receipt_sha256: hash("action-cal-001") })]),
    /duplicate action_receipt_sha256/,
  );
});

test("tenant calibration binds current control generation and evidence manifest", async () => {
  const { controlRoot, evidenceRoot, control, evidence } = await setupTenant();
  const calibrationSnapshot = snapshot({
    controlGeneration: control.generation,
    evidenceManifestHash: evidence.manifestHash,
  });
  const result = await buildTenantOutcomeCalibration({
    controlRoot,
    evidenceRoot,
    siteId: SITE_ID,
    calibrationSnapshot,
    calibrationProfile: PROFILE,
  });
  assert.equal(result.status, "READY");
  assert.equal(result.reason, "OUTCOME_CALIBRATION_READY");
  assert.equal(result.evidenceManifestHash, evidence.manifestHash);
  assert.equal(result.report.status, "CALIBRATION_READY");
  assert.match(result.calibrationSnapshotSha256, /^sha256:[0-9a-f]{64}$/);
});

test("tenant calibration reports stale control generation instead of using mismatched history", async () => {
  const { controlRoot, evidenceRoot, control, evidence } = await setupTenant();
  const calibrationSnapshot = snapshot({
    controlGeneration: control.generation + 1,
    evidenceManifestHash: evidence.manifestHash,
  });
  const result = await buildTenantOutcomeCalibration({
    controlRoot,
    evidenceRoot,
    siteId: SITE_ID,
    calibrationSnapshot,
    calibrationProfile: PROFILE,
  });
  assert.equal(result.status, "STALE");
  assert.equal(result.reason, "CALIBRATION_SNAPSHOT_CONTROL_GENERATION_STALE");
  assert.equal(result.report, null);
});

test("tenant calibration reports stale evidence manifest instead of silently rebinding it", async () => {
  const { controlRoot, evidenceRoot, control } = await setupTenant();
  const calibrationSnapshot = snapshot({
    controlGeneration: control.generation,
    evidenceManifestHash: hash("different-evidence-manifest"),
  });
  const result = await buildTenantOutcomeCalibration({
    controlRoot,
    evidenceRoot,
    siteId: SITE_ID,
    calibrationSnapshot,
    calibrationProfile: PROFILE,
  });
  assert.equal(result.status, "STALE");
  assert.equal(result.reason, "CALIBRATION_SNAPSHOT_EVIDENCE_MANIFEST_STALE");
  assert.equal(result.report, null);
});

test("tenant calibration rejects snapshots captured before their observation windows end", async () => {
  const { controlRoot, evidenceRoot, control, evidence } = await setupTenant();
  const calibrationSnapshot = snapshot({
    controlGeneration: control.generation,
    evidenceManifestHash: evidence.manifestHash,
    observedAtUnixMs: 3_500_000,
  });
  const result = await buildTenantOutcomeCalibration({
    controlRoot,
    evidenceRoot,
    siteId: SITE_ID,
    calibrationSnapshot,
    calibrationProfile: PROFILE,
  });
  assert.equal(result.status, "BLOCKED");
  assert.match(result.reason, /^OUTCOME_CALIBRATION_INPUT_INVALID:/);
  assert.match(result.reason, /cannot precede an observation window end/);
});

test("production calibration sources have no direct network, process, publish, or tenant-control mutation authority", async () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const sources = await Promise.all([
    readFile(join(here, "..", "outcome-calibration", "calibration-engine.mjs"), "utf8"),
    readFile(join(here, "..", "outcome-calibration", "tenant-calibration.mjs"), "utf8"),
  ]);
  const joined = sources.join("\n");
  for (const forbidden of [
    /from ["']node:http(?:s)?["']/,
    /from ["']node:net["']/,
    /from ["']node:child_process["']/,
    /\bfetch\s*\(/,
    /\bsetTenantEnabled\b/,
    /\bpublishAuthorizedProviderSnapshot\b/,
    /\bgoogle(?:\.com|apis|search)\b/i,
  ]) {
    assert.equal(forbidden.test(joined), false, `forbidden production capability matched ${forbidden}`);
  }
});
