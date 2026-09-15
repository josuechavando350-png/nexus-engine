import assert from "node:assert/strict";
import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { setTenantEnabled } from "../control-plane/tenant-control.mjs";
import {
  canonicalProviderRecordsSha256,
  publishAuthorizedProviderSnapshot,
} from "../evidence/authorized-provider-snapshot.mjs";
import { buildTenantRankFeasibilityWithTrend } from "../rank-feasibility/tenant-longitudinal.mjs";

const SITE_ID = "walle-rank-trend-empty-probe";

const feasibilityAssumptionProfile = Object.freeze({
  schema_version: 1,
  profile_id: "empty-feasibility-test",
  provenance: "synthetic test profile",
  minimum_impressions: 100,
  high_gap_milli: 5_000,
  medium_gap_milli: 10_000,
});

const trendAssumptionProfile = Object.freeze({
  schema_version: 1,
  profile_id: "empty-trend-test",
  provenance: "synthetic test profile",
  minimum_windows: 2,
  minimum_endpoint_impressions: 100,
  improving_delta_milli: 1_000,
  declining_delta_milli: 1_000,
});

function dataset(key, records) {
  return {
    provider: "GOOGLE_SEARCH_CONSOLE",
    key,
    records,
    records_sha256: canonicalProviderRecordsSha256(records),
  };
}

async function setup() {
  const root = await mkdtemp(join(tmpdir(), "walle-rank-trend-empty-"));
  const controlRoot = join(root, "control");
  const evidenceRoot = join(root, "evidence");
  await mkdir(controlRoot, { mode: 0o700 });
  await mkdir(evidenceRoot, { mode: 0o700 });
  await mkdir(join(evidenceRoot, "tenants"), { mode: 0o700 });
  const control = await setTenantEnabled({ controlRoot, siteId: SITE_ID, enabled: true, expectedGeneration: 0 });
  return { controlRoot, evidenceRoot, control };
}

test("present but empty history remains INSUFFICIENT_DATA rather than BLOCKED", async () => {
  const { controlRoot, evidenceRoot, control } = await setup();
  const current = [
    { query: "alpha", page_url: "/alpha", clicks: 2, impressions: 100, average_position_milli: 10_000 },
  ];
  await publishAuthorizedProviderSnapshot({
    controlRoot,
    evidenceRoot,
    siteId: SITE_ID,
    snapshot: {
      schema_version: 1,
      site_id: SITE_ID,
      control_generation: control.generation,
      capture_id: "empty-history-001",
      observed_at_unix_ms: 4_000_000,
      datasets: [
        dataset("search_performance_records", current),
        dataset("search_performance_history_records", []),
      ],
    },
  });
  const result = await buildTenantRankFeasibilityWithTrend({
    controlRoot,
    evidenceRoot,
    siteId: SITE_ID,
    feasibilityAssumptionProfile,
    trendAssumptionProfile,
  });
  assert.equal(result.status, "INSUFFICIENT_DATA");
  assert.equal(result.reason, "REQUIRED_DATASETS_EMPTY:search_performance_history_records");
  assert.equal(result.report, null);
});
