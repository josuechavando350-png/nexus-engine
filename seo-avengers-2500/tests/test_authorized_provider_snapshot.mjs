import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { setTenantEnabled, readTenantControl } from "../control-plane/tenant-control.mjs";
import { readTenantEvidenceSnapshot } from "../evidence/tenant-evidence.mjs";
import {
  canonicalProviderRecordsSha256,
  publishAuthorizedProviderSnapshot,
} from "../evidence/authorized-provider-snapshot.mjs";

const SITE_ID = "walle-real-data-probe";

async function setup() {
  const root = await mkdtemp(join(tmpdir(), "walle-provider-snapshot-"));
  const controlRoot = join(root, "control");
  const evidenceRoot = join(root, "evidence");
  await mkdir(controlRoot, { mode: 0o700 });
  await mkdir(evidenceRoot, { mode: 0o700 });
  await mkdir(join(evidenceRoot, "tenants"), { mode: 0o700 });
  const control = await setTenantEnabled({ controlRoot, siteId: SITE_ID, enabled: true, expectedGeneration: 0 });
  return { root, controlRoot, evidenceRoot, control };
}

function ds(provider, key, records) {
  return {
    provider,
    key,
    records,
    records_sha256: canonicalProviderRecordsSha256(records),
  };
}

function snapshot(generation, captureId = "capture-001", overrides = {}) {
  const datasets = [
    ds("GOOGLE_SEARCH_CONSOLE", "search_performance_records", [
      { query: "abogado penal cdmx", page_url: "/penal-cdmx", clicks: 8, impressions: 300, average_position_milli: 4500 },
      { query: "defensa penal urgente cdmx", page_url: "/penal-cdmx", clicks: 1, impressions: 140, average_position_milli: 9000 },
    ]),
    ds("GOOGLE_ANALYTICS_4", "traffic_window_records", [
      { entity_id: "/penal-cdmx", baseline_visits: 1000, current_visits: 1200, baseline_window_days: 28, current_window_days: 28 },
    ]),
    ds("GOOGLE_ANALYTICS_4", "traffic_series_records", [
      { entity_id: "/penal-cdmx", visits_series: [70, 75, 80, 84] },
    ]),
    ds("GOOGLE_BUSINESS_PROFILE", "local_business_records", [
      { source_id: "gbp", name: "Example Legal", address: "Reforma 100 CDMX", phone: "+52 55 1234 5678", latitude_e6: 19432600, longitude_e6: -99133200 },
    ]),
    ds("NEXUS_SITE_SNAPSHOT", "content_documents", [
      { document_id: "/penal-cdmx", text: "Defensa penal en Ciudad de Mexico. Informacion verificada del servicio y formas de contacto." },
    ]),
    ds("NEXUS_CRM", "revenue_funnel_records", [
      { source_id: "organic", sessions: 1200, lead_conversion_ppm: 80000, close_rate_ppm: 200000, average_ticket_micros: 25000000000 },
    ]),
  ];
  return {
    schema_version: 1,
    site_id: SITE_ID,
    control_generation: generation,
    capture_id: captureId,
    observed_at_unix_ms: 1_800_000_000_000,
    datasets,
    ...overrides,
  };
}

test("authorized provider snapshot publishes real-data contracts and reader revalidates them", async () => {
  const { controlRoot, evidenceRoot, control } = await setup();
  const before = await readTenantControl({ controlRoot, siteId: SITE_ID });
  const result = await publishAuthorizedProviderSnapshot({
    controlRoot,
    evidenceRoot,
    siteId: SITE_ID,
    snapshot: snapshot(control.generation),
  });
  assert.equal(result.status, "PUBLISHED");
  assert.equal(result.controlGeneration, 1);
  assert.equal(result.datasetCount, 7);

  const after = await readTenantControl({ controlRoot, siteId: SITE_ID });
  assert.equal(after.generation, before.generation);
  assert.equal(after.stateHash, before.stateHash);

  const evidence = await readTenantEvidenceSnapshot({ controlRoot, evidenceRoot, siteId: SITE_ID });
  assert.equal(evidence.status, "READY");
  assert.equal(evidence.datasets.search_performance_records.length, 2);
  assert.equal(evidence.datasets.traffic_window_records[0].current_visits, 1200);
  assert.equal(evidence.datasets.revenue_funnel_records[0].close_rate_ppm, 200000);
  assert.equal(evidence.datasets.upstream_evidence.length, 6);
  assert.deepEqual(
    evidence.datasets.upstream_evidence.map((row) => row.provider).sort(),
    ["GOOGLE_ANALYTICS_4", "GOOGLE_ANALYTICS_4", "GOOGLE_BUSINESS_PROFILE", "GOOGLE_SEARCH_CONSOLE", "NEXUS_CRM", "NEXUS_SITE_SNAPSHOT"].sort(),
  );
});

test("same control generation can receive a newer coherent observation snapshot", async () => {
  const { controlRoot, evidenceRoot, control } = await setup();
  await publishAuthorizedProviderSnapshot({ controlRoot, evidenceRoot, siteId: SITE_ID, snapshot: snapshot(control.generation) });
  const next = snapshot(control.generation, "capture-002");
  next.datasets[0].records[0].clicks = 12;
  next.datasets[0].records_sha256 = canonicalProviderRecordsSha256(next.datasets[0].records);
  const result = await publishAuthorizedProviderSnapshot({ controlRoot, evidenceRoot, siteId: SITE_ID, snapshot: next });
  assert.equal(result.status, "PUBLISHED");
  const evidence = await readTenantEvidenceSnapshot({ controlRoot, evidenceRoot, siteId: SITE_ID });
  assert.equal(evidence.status, "READY");
  assert.equal(evidence.datasets.search_performance_records[0].clicks, 12);
  assert.equal(evidence.datasets.upstream_evidence.find((row) => row.dataset_key === "search_performance_records").capture_id, "capture-002");
});

test("provider digest mismatch fails before evidence is published", async () => {
  const { controlRoot, evidenceRoot, control } = await setup();
  const bad = snapshot(control.generation);
  bad.datasets[0].records_sha256 = `sha256:${"0".repeat(64)}`;
  await assert.rejects(
    publishAuthorizedProviderSnapshot({ controlRoot, evidenceRoot, siteId: SITE_ID, snapshot: bad }),
    /digest mismatch/,
  );
  const evidence = await readTenantEvidenceSnapshot({ controlRoot, evidenceRoot, siteId: SITE_ID });
  assert.equal(evidence.status, "INSUFFICIENT_DATA");
});

test("stale control generation cannot publish provider evidence", async () => {
  const { controlRoot, evidenceRoot, control } = await setup();
  await assert.rejects(
    publishAuthorizedProviderSnapshot({ controlRoot, evidenceRoot, siteId: SITE_ID, snapshot: snapshot(control.generation + 1) }),
    /stale provider snapshot control generation/,
  );
});

test("provider-dataset mismatch and credential-shaped extra fields fail closed", async () => {
  const { controlRoot, evidenceRoot, control } = await setup();
  const mismatch = snapshot(control.generation);
  mismatch.datasets[0] = ds("GOOGLE_ANALYTICS_4", "search_performance_records", mismatch.datasets[0].records);
  await assert.rejects(
    publishAuthorizedProviderSnapshot({ controlRoot, evidenceRoot, siteId: SITE_ID, snapshot: mismatch }),
    /not authorized for dataset key/,
  );

  const secretLeak = snapshot(control.generation);
  secretLeak.datasets[0].records[0].access_token = "forbidden";
  secretLeak.datasets[0].records_sha256 = canonicalProviderRecordsSha256(secretLeak.datasets[0].records);
  await assert.rejects(
    publishAuthorizedProviderSnapshot({ controlRoot, evidenceRoot, siteId: SITE_ID, snapshot: secretLeak }),
    /unexpected search performance row 0 keys/,
  );
});

test("floating-point provider values are rejected instead of silently rounded", async () => {
  const { controlRoot, evidenceRoot, control } = await setup();
  const bad = snapshot(control.generation);
  bad.datasets[0].records[0].average_position_milli = 4.5;
  assert.throws(() => canonicalProviderRecordsSha256(bad.datasets[0].records), /safe integers/);
});

test("symlinked tenant evidence destination is rejected by publisher", async () => {
  const { controlRoot, evidenceRoot, control, root } = await setup();
  const outside = join(root, "outside");
  await mkdir(outside);
  await symlink(outside, join(evidenceRoot, "tenants", SITE_ID));
  await assert.rejects(
    publishAuthorizedProviderSnapshot({ controlRoot, evidenceRoot, siteId: SITE_ID, snapshot: snapshot(control.generation) }),
    /existing tenant evidence directory must be a real directory/,
  );
});
