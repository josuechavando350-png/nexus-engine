import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { setTenantEnabled } from "../control-plane/tenant-control.mjs";
import { canonicalProviderRecordsSha256, publishAuthorizedProviderSnapshot } from "../evidence/authorized-provider-snapshot.mjs";
import { buildClientCohortEvidenceReport } from "../client-quality/cohort-engine.mjs";
import { buildTenantClientCohortEvidence } from "../client-quality/tenant-cohort.mjs";

const SITE_ID = "walle-client-cohort-probe";
const SOURCE_CAPTURE_SHA256 = `sha256:${createHash("sha256").update("synthetic privacy-safe cohort export").digest("hex")}`;
const MAPPING_SHA256 = `sha256:${createHash("sha256").update("synthetic explicit cohort mapping v1").digest("hex")}`;

const profile = Object.freeze({
  schema_version: 1,
  profile_id: "client-cohort-v1-test",
  provenance: "synthetic explicit cohort categories for deterministic tests",
  mapping_profile_id: "synthetic-cohort-mapping-v1",
  mapping_profile_sha256: MAPPING_SHA256,
  minimum_sessions: 100,
  minimum_leads: 10,
  service_categories: ["criminal-defense", "fraud-defense"],
  intents: ["urgent-help", "case-evaluation"],
  geographies: ["cdmx", "guadalajara"],
  urgencies: ["urgent", "standard"],
  ticket_bands: ["high", "mid"],
  sources: ["organic", "referral"],
});

function rows() {
  return [
    {
      service_category: "criminal-defense",
      service_category_basis: "OBSERVED",
      intent: "urgent-help",
      intent_basis: "CLASSIFIED",
      geography: "cdmx",
      geography_basis: "OBSERVED",
      urgency: "urgent",
      urgency_basis: "CLASSIFIED",
      ticket_band: "high",
      ticket_band_basis: "ESTIMATED",
      source_id: "organic",
      source_basis: "OBSERVED",
      sessions: 1000,
      leads: 100,
      signed_clients: 20,
      revenue_micros: 500_000_000_000,
      window_start_unix_ms: 1_000_000,
      window_end_unix_ms: 2_000_000,
    },
    {
      service_category: "fraud-defense",
      service_category_basis: "OBSERVED",
      intent: "case-evaluation",
      intent_basis: "OBSERVED",
      geography: "guadalajara",
      geography_basis: "OBSERVED",
      urgency: "standard",
      urgency_basis: "OBSERVED",
      ticket_band: "mid",
      ticket_band_basis: "CLASSIFIED",
      source_id: "referral",
      source_basis: "OBSERVED",
      sessions: 500,
      leads: 50,
      signed_clients: 5,
      revenue_micros: 75_000_000_000,
      window_start_unix_ms: 1_000_000,
      window_end_unix_ms: 2_000_000,
    },
    {
      service_category: "criminal-defense",
      service_category_basis: "OBSERVED",
      intent: "case-evaluation",
      intent_basis: "OBSERVED",
      geography: "cdmx",
      geography_basis: "OBSERVED",
      urgency: "standard",
      urgency_basis: "OBSERVED",
      ticket_band: "mid",
      ticket_band_basis: "OBSERVED",
      source_id: "organic",
      source_basis: "OBSERVED",
      sessions: 20,
      leads: 2,
      signed_clients: 0,
      revenue_micros: 0,
      window_start_unix_ms: 1_000_000,
      window_end_unix_ms: 2_000_000,
    },
  ];
}

function cohortDataset(records = rows()) {
  return {
    provider: "NEXUS_CRM",
    key: "client_cohort_records",
    records,
    records_sha256: canonicalProviderRecordsSha256(records),
    source_authority: "NEXUS_CRM_AGGREGATE_COHORT_EXPORT:V1",
    source_capture_sha256: SOURCE_CAPTURE_SHA256,
  };
}

function funnelDataset() {
  const records = [{ source_id: "organic", sessions: 1000, lead_conversion_ppm: 100_000, close_rate_ppm: 200_000, average_ticket_micros: 25_000_000_000 }];
  return {
    provider: "NEXUS_CRM",
    key: "revenue_funnel_records",
    records,
    records_sha256: canonicalProviderRecordsSha256(records),
  };
}

async function setup() {
  const root = await mkdtemp(join(tmpdir(), "walle-client-cohort-"));
  const controlRoot = join(root, "control");
  const evidenceRoot = join(root, "evidence");
  await mkdir(controlRoot, { mode: 0o700 });
  await mkdir(evidenceRoot, { mode: 0o700 });
  await mkdir(join(evidenceRoot, "tenants"), { mode: 0o700 });
  const control = await setTenantEnabled({ controlRoot, siteId: SITE_ID, enabled: true, expectedGeneration: 0 });
  return { root, controlRoot, evidenceRoot, control };
}

function snapshot(generation, datasets) {
  return {
    schema_version: 1,
    site_id: SITE_ID,
    control_generation: generation,
    capture_id: "client-cohort-capture-001",
    observed_at_unix_ms: 3_000_000,
    datasets,
  };
}

test("client cohort evidence computes aggregate observed outcomes without a magic quality score", () => {
  const report = buildClientCohortEvidenceReport({ clientCohortRecords: rows(), cohortProfile: profile });
  assert.equal(report.status, "COHORT_EVIDENCE_READY");
  assert.equal(report.engineId, "WALLE_CLIENT_QUALITY_COHORTS_V1");
  assert.equal(report.summary.inputCohortCount, 3);
  assert.equal(report.summary.eligibleCohortCount, 2);
  assert.equal(report.summary.suppressedCohortCount, 1);
  assert.equal(report.cohorts.length, 2);
  assert.equal(report.summary.eligibleTotals.sessions, 1500);
  assert.equal(report.summary.eligibleTotals.leads, 150);
  assert.equal(report.summary.eligibleTotals.signedClients, 25);
  assert.equal(report.summary.eligibleTotals.revenueMicros, 575_000_000_000);
  assert.equal(report.summary.eligibleMetrics.leadConversionPpm, 100_000);
  assert.equal(report.summary.eligibleMetrics.closeRatePpm, 166_667);
  assert.equal(report.summary.eligibleMetrics.signedClientRatePpm, 16_667);
  assert.equal(report.summary.eligibleMetrics.averageTicketMicros, 23_000_000_000);
  assert.equal("clientQualityScore" in report, false);
  assert.equal("score" in report.summary, false);
});

test("classified and estimated cohort dimensions remain explicitly labeled", () => {
  const report = buildClientCohortEvidenceReport({ clientCohortRecords: rows(), cohortProfile: profile });
  const criminal = report.cohorts.find((cohort) => cohort.dimensions.serviceCategory.value === "criminal-defense");
  assert.equal(criminal.dimensions.intent.basis, "CLASSIFIED");
  assert.equal(criminal.dimensions.urgency.basis, "CLASSIFIED");
  assert.equal(criminal.dimensions.ticketBand.basis, "ESTIMATED");
  assert.ok(report.warnings.includes("CLASSIFIED_OR_ESTIMATED_DIMENSIONS_ARE_NOT_OBSERVED"));
  assert.equal(report.mappingBoundary, "CLASSIFIED_AND_ESTIMATED_DIMENSIONS_ARE_NEVER_RELABELED_OBSERVED");
});

test("small cohorts are omitted and represented only by count plus digest", () => {
  const report = buildClientCohortEvidenceReport({ clientCohortRecords: rows(), cohortProfile: profile });
  assert.equal(report.summary.suppressedCohortCount, 1);
  assert.match(report.summary.suppressedRowsSha256, /^sha256:[0-9a-f]{64}$/);
  assert.equal(report.cohorts.some((cohort) => cohort.metrics.sessions === 20), false);
  assert.ok(report.warnings.includes("SMALL_COHORTS_SUPPRESSED_BY_EXPLICIT_PRIVACY_THRESHOLDS"));
});

test("raw PII-like extra fields fail closed at exact cohort schema", () => {
  const bad = rows();
  bad[0] = { ...bad[0], email: "person@example.test" };
  assert.throws(
    () => buildClientCohortEvidenceReport({ clientCohortRecords: bad, cohortProfile: profile }),
    /unexpected client cohort row 0 keys/,
  );
});

test("hash-bound mapping profile rejects undeclared cohort categories", () => {
  const bad = rows();
  bad[0] = { ...bad[0], geography: "monterrey" };
  assert.throws(
    () => buildClientCohortEvidenceReport({ clientCohortRecords: bad, cohortProfile: profile }),
    /outside hash-bound mapping profile/,
  );
});

test("conflicting duplicate cohort evidence fails closed", () => {
  const duplicate = { ...rows()[0], signed_clients: 19, revenue_micros: 475_000_000_000 };
  assert.throws(
    () => buildClientCohortEvidenceReport({ clientCohortRecords: [...rows(), duplicate], cohortProfile: profile }),
    /conflicting duplicate client cohort/,
  );
});

test("mixed observation windows fail closed", () => {
  const bad = rows();
  bad[1] = { ...bad[1], window_start_unix_ms: 2_000_000, window_end_unix_ms: 3_000_000 };
  assert.throws(
    () => buildClientCohortEvidenceReport({ clientCohortRecords: bad, cohortProfile: profile }),
    /share one observation window/,
  );
});

test("report is deterministic across input row ordering", () => {
  const forward = buildClientCohortEvidenceReport({ clientCohortRecords: rows(), cohortProfile: profile });
  const reverse = buildClientCohortEvidenceReport({ clientCohortRecords: [...rows()].reverse(), cohortProfile: profile });
  assert.equal(forward.reportSha256, reverse.reportSha256);
  assert.deepEqual(forward.cohorts, reverse.cohorts);
});

test("all cohorts below explicit privacy thresholds produce insufficient data without row leakage", () => {
  const small = rows().map((row) => ({ ...row, sessions: 20, leads: 2, signed_clients: 0, revenue_micros: 0 }));
  const report = buildClientCohortEvidenceReport({ clientCohortRecords: small, cohortProfile: profile });
  assert.equal(report.status, "INSUFFICIENT_DATA");
  assert.equal(report.cohorts.length, 0);
  assert.equal(report.summary.suppressedCohortCount, 3);
});

test("authorized CRM cohort publication requires provenance and tenant wrapper revalidates it", async () => {
  const { controlRoot, evidenceRoot, control } = await setup();
  const published = await publishAuthorizedProviderSnapshot({
    controlRoot,
    evidenceRoot,
    siteId: SITE_ID,
    snapshot: snapshot(control.generation, [cohortDataset()]),
  });
  assert.equal(published.status, "PUBLISHED");

  const result = await buildTenantClientCohortEvidence({ controlRoot, evidenceRoot, siteId: SITE_ID, cohortProfile: profile });
  assert.equal(result.status, "READY");
  assert.equal(result.reason, "CLIENT_COHORT_EVIDENCE_READY");
  assert.equal(result.report.status, "COHORT_EVIDENCE_READY");
  assert.equal(result.cohortProvenance.sourceAuthority, "NEXUS_CRM_AGGREGATE_COHORT_EXPORT:V1");
  assert.equal(result.cohortProvenance.recordsSha256, canonicalProviderRecordsSha256(rows()));
});

test("client cohort publication without provenance fails closed", async () => {
  const { controlRoot, evidenceRoot, control } = await setup();
  const dataset = cohortDataset();
  delete dataset.source_authority;
  delete dataset.source_capture_sha256;
  await assert.rejects(
    publishAuthorizedProviderSnapshot({
      controlRoot,
      evidenceRoot,
      siteId: SITE_ID,
      snapshot: snapshot(control.generation, [dataset]),
    }),
    /unexpected provider dataset keys/,
  );
});

test("tenant cohort layer reports missing cohort evidence instead of fabricating it", async () => {
  const { controlRoot, evidenceRoot, control } = await setup();
  await publishAuthorizedProviderSnapshot({
    controlRoot,
    evidenceRoot,
    siteId: SITE_ID,
    snapshot: snapshot(control.generation, [funnelDataset()]),
  });
  const result = await buildTenantClientCohortEvidence({ controlRoot, evidenceRoot, siteId: SITE_ID, cohortProfile: profile });
  assert.equal(result.status, "INSUFFICIENT_DATA");
  assert.equal(result.reason, "REQUIRED_DATASETS_MISSING:client_cohort_records");
  assert.equal(result.report, null);
});
