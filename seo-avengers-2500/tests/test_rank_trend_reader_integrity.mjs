import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { setTenantEnabled } from "../control-plane/tenant-control.mjs";
import {
  canonicalProviderRecordsSha256,
  publishAuthorizedProviderSnapshot,
} from "../evidence/authorized-provider-snapshot.mjs";
import { readTenantEvidenceSnapshot } from "../evidence/tenant-evidence.mjs";

const SITE_ID = "walle-rank-history-integrity-probe";

async function setup() {
  const root = await mkdtemp(join(tmpdir(), "walle-rank-history-integrity-"));
  const controlRoot = join(root, "control");
  const evidenceRoot = join(root, "evidence");
  await mkdir(controlRoot, { mode: 0o700 });
  await mkdir(evidenceRoot, { mode: 0o700 });
  await mkdir(join(evidenceRoot, "tenants"), { mode: 0o700 });
  const control = await setTenantEnabled({ controlRoot, siteId: SITE_ID, enabled: true, expectedGeneration: 0 });
  return { controlRoot, evidenceRoot, control };
}

function dataset(key, records) {
  return {
    provider: "GOOGLE_SEARCH_CONSOLE",
    key,
    records,
    records_sha256: canonicalProviderRecordsSha256(records),
  };
}

test("tenant reader rejects tampered Search Console history bytes", async () => {
  const { controlRoot, evidenceRoot, control } = await setup();
  const current = [
    { query: "alpha", page_url: "/alpha", clicks: 10, impressions: 200, average_position_milli: 8_000 },
  ];
  const history = [
    { query: "alpha", page_url: "/alpha", clicks: 4, impressions: 150, average_position_milli: 12_000, window_start_unix_ms: 1_000_000, window_end_unix_ms: 2_000_000 },
    { query: "alpha", page_url: "/alpha", clicks: 10, impressions: 200, average_position_milli: 8_000, window_start_unix_ms: 2_000_000, window_end_unix_ms: 3_000_000 },
  ];

  const published = await publishAuthorizedProviderSnapshot({
    controlRoot,
    evidenceRoot,
    siteId: SITE_ID,
    snapshot: {
      schema_version: 1,
      site_id: SITE_ID,
      control_generation: control.generation,
      capture_id: "history-integrity-001",
      observed_at_unix_ms: 4_000_000,
      datasets: [
        dataset("search_performance_records", current),
        dataset("search_performance_history_records", history),
      ],
    },
  });
  assert.equal(published.status, "PUBLISHED");

  const before = await readTenantEvidenceSnapshot({ controlRoot, evidenceRoot, siteId: SITE_ID });
  assert.equal(before.status, "READY");
  assert.equal(before.datasets.search_performance_history_records.length, 2);

  await writeFile(
    join(evidenceRoot, "tenants", SITE_ID, "search_performance_history_records.json"),
    `${JSON.stringify([{ ...history[0], clicks: 99 }])}\n`,
  );

  const after = await readTenantEvidenceSnapshot({ controlRoot, evidenceRoot, siteId: SITE_ID });
  assert.equal(after.status, "BLOCKED");
  assert.equal(after.integrityOk, false);
  assert.equal(after.reason, "EVIDENCE_DATASET_INVALID");
});
