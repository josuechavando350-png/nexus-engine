import assert from "node:assert/strict";
import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { CANARY_SITE_ID } from "../sidecar/canary-result-store.mjs";
import { runReadonlyCanary } from "../sidecar/readonly-canary.mjs";

const SHA = `sha256:${"d".repeat(64)}`;
const SOURCE_REVISION = "e".repeat(40);
const SOURCE_TREE = "f".repeat(40);

function releasedResult() {
  const receipts = {};
  for (let number = 1001; number <= 2500; number += 1) {
    const moduleId = `M${number}`;
    receipts[moduleId] = {
      module: moduleId,
      execution_status: "SUCCESS",
      finding_status: "NO_FINDING",
      policy_status: "SAFE_WHITE_HAT",
      action_mode: "OBSERVE_ONLY",
      evidence_hash: `sha256:${number.toString(16).padStart(64, "0")}`,
      output: {},
    };
  }
  receipts.M2500.output = {
    release_safe: true,
    suite: "SEO_AVENGERS_2500",
    strict_white_hat_only: true,
    no_google_scraping: true,
  };
  return {
    schemaVersion: 1,
    siteId: CANARY_SITE_ID,
    status: "RELEASED",
    reason: "RELEASED",
    controlGeneration: 3,
    evidenceManifestHash: SHA,
    configHash: SHA,
    executionHash: SHA,
    terminalEvidenceHash: receipts.M2500.evidence_hash,
    receiptCount: 1500,
    receipts,
  };
}

async function withRoot(t) {
  const root = await mkdtemp(join(tmpdir(), "walle-readonly-canary-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

test("canary runner fixes the tenant identity and persists only released complete evidence", async (t) => {
  const resultRoot = await withRoot(t);
  let observedSiteId = null;
  const result = await runReadonlyCanary({
    controlRoot: "/unused/control",
    evidenceRoot: "/unused/evidence",
    resultRoot,
    runId: "canary-runner-pass",
    sourceRevision: SOURCE_REVISION,
    sourceTree: SOURCE_TREE,
    executeJob: async ({ siteId }) => {
      observedSiteId = siteId;
      return releasedResult();
    },
  });
  assert.equal(observedSiteId, CANARY_SITE_ID);
  assert.equal(result.status, "CERTIFIED");
  assert.equal(result.reason, "LOCAL_M1001_M2500_RANGE_CERTIFIED");
  assert.equal(result.localReceiptCount, 1500);
  assert.equal(result.persisted, true);
  await access(result.resultFile);
});

test("OFF or blocked worker decisions are not persisted", async (t) => {
  const resultRoot = await withRoot(t);
  const result = await runReadonlyCanary({
    controlRoot: "/unused/control",
    evidenceRoot: "/unused/evidence",
    resultRoot,
    runId: "canary-off",
    sourceRevision: SOURCE_REVISION,
    sourceTree: SOURCE_TREE,
    executeJob: async () => ({
      siteId: CANARY_SITE_ID,
      status: "OFF",
      reason: "KILL_SWITCH_ACTIVE",
      controlGeneration: 4,
      evidenceManifestHash: null,
      configHash: SHA,
    }),
  });
  assert.equal(result.status, "OFF");
  assert.equal(result.persisted, false);
});

test("persistence failure blocks certification", async () => {
  const result = await runReadonlyCanary({
    controlRoot: "/unused/control",
    evidenceRoot: "/unused/evidence",
    resultRoot: "/unused/results",
    runId: "canary-persist-fails",
    sourceRevision: SOURCE_REVISION,
    sourceTree: SOURCE_TREE,
    executeJob: async () => releasedResult(),
    persistResult: async () => { throw new Error("disk unavailable"); },
  });
  assert.equal(result.status, "BLOCKED");
  assert.equal(result.reason, "RESULT_PERSISTENCE_FAILED");
  assert.equal(result.persisted, false);
});
