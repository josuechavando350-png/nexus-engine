import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { setTenantEnabled } from "../control-plane/tenant-control.mjs";
import { canonicalProviderRecordsSha256, publishAuthorizedProviderSnapshot } from "../evidence/authorized-provider-snapshot.mjs";
import { assertTournamentTenantSnapshotBinding } from "../commercial-demand/tenant-snapshot-binding.mjs";

const scenario = JSON.parse(await readFile(fileURLToPath(new URL("../commercial-demand/nexus-commercial-demand-v2.json", import.meta.url)), "utf8"));
const manifest = JSON.parse(await readFile(fileURLToPath(new URL("../commercial-demand/nexus-commercial-demand-v2.tenant-manifest.json", import.meta.url)), "utf8"));
const clone = (value) => structuredClone(value);
const searchRows = (hostname = "nexusbotstudio.com") => [{
  query: "servicios de software",
  page_url: `https://${hostname}/`,
  clicks: scenario.observedSearch.aggregate.clicks,
  impressions: scenario.observedSearch.aggregate.impressions,
  average_position_milli: scenario.observedSearch.aggregate.averagePositionMilli,
}];

async function setup(t, rows = searchRows(), { publish = true } = {}) {
  const root = await mkdtemp(join(tmpdir(), "nexus-tournament-tenant-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const controlRoot = join(root, "control");
  const evidenceRoot = join(root, "evidence");
  await mkdir(controlRoot, { mode: 0o700 });
  await mkdir(evidenceRoot, { mode: 0o700 });
  await mkdir(join(evidenceRoot, "tenants"), { mode: 0o700 });
  const control = await setTenantEnabled({ controlRoot, siteId: manifest.siteId, enabled: true, expectedGeneration: 0 });
  if (publish) {
    const result = await publishAuthorizedProviderSnapshot({
      controlRoot,
      evidenceRoot,
      siteId: manifest.siteId,
      snapshot: {
        schema_version: 1,
        site_id: manifest.siteId,
        control_generation: control.generation,
        capture_id: "tournament-search-fixture-001",
        observed_at_unix_ms: 1_789_750_000_000,
        datasets: [{
          provider: "GOOGLE_SEARCH_CONSOLE",
          key: "search_performance_records",
          records: rows,
          records_sha256: canonicalProviderRecordsSha256(rows),
        }],
      },
    });
    assert.equal(result.status, "PUBLISHED");
  }
  return { controlRoot, evidenceRoot, scenario: clone(scenario), manifest: clone(manifest) };
}

test("custom tournament binds source-row counts, domain and tenant-controlled snapshot hash", async (t) => {
  const input = await setup(t);
  const proof = await assertTournamentTenantSnapshotBinding(input);
  assert.equal(proof.siteId, "nexus-bot-studio");
  assert.match(proof.evidenceManifestHash, /^sha256:[a-f0-9]{64}$/);
  assert.equal(proof.evidenceStatus, "TENANT_SNAPSHOT_BOUND_PROVIDER_OWNERSHIP_NOT_VERIFIED");
  assert.equal(proof.salesClaimStatus, "NOT_VALIDATED_FOR_SALES_CLAIMS");
});

test("reject custom scenario when tenant has no first-party evidence", async (t) => {
  const input = await setup(t, [], { publish: false });
  await assert.rejects(assertTournamentTenantSnapshotBinding(input), /TENANT_EVIDENCE_NOT_READY:INSUFFICIENT_DATA/);
});

test("reject empty Search Console dataset rather than invent zero traffic", async (t) => {
  const input = await setup(t, []);
  await assert.rejects(assertTournamentTenantSnapshotBinding(input), /INSUFFICIENT_DATA:SEARCH_PERFORMANCE_RECORDS_MISSING/);
});

test("reject GSC rows from a foreign domain even inside the tenant's storage", async (t) => {
  const input = await setup(t, searchRows("canopenal.com"));
  await assert.rejects(assertTournamentTenantSnapshotBinding(input), /CROSS_TENANT_SEARCH_PAGE_HOST_MISMATCH/);
});

test("reject scenario aggregate borrowed or edited independently from bound records", async (t) => {
  const input = await setup(t);
  input.scenario.observedSearch.aggregate.clicks += 1;
  await assert.rejects(assertTournamentTenantSnapshotBinding(input), /CROSS_TENANT_SEARCH_AGGREGATE_MISMATCH/);
});

test("reject custom scenario without control and evidence roots", async () => {
  await assert.rejects(
    assertTournamentTenantSnapshotBinding({ scenario, manifest }),
    /CUSTOM_SCENARIO_REQUIRES_TENANT_CONTROL_AND_EVIDENCE_ROOTS/,
  );
});
