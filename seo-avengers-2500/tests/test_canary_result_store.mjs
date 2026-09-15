import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { CANARY_SITE_ID, persistCanaryResult, readCanaryResult } from "../sidecar/canary-result-store.mjs";

const SHA = `sha256:${"a".repeat(64)}`;
const SOURCE_REVISION = "b".repeat(40);
const SOURCE_TREE = "c".repeat(40);

function releasedResult({ insufficientModule = null, siteId = CANARY_SITE_ID } = {}) {
  const receipts = {};
  for (let number = 1001; number <= 2500; number += 1) {
    const moduleId = `M${number}`;
    receipts[moduleId] = {
      module: moduleId,
      execution_status: moduleId === insufficientModule ? "INSUFFICIENT_DATA" : "SUCCESS",
      finding_status: number % 10 === 0 ? "FINDING" : "NO_FINDING",
      policy_status: "SAFE_WHITE_HAT",
      action_mode: "OBSERVE_ONLY",
      evidence_hash: `sha256:${number.toString(16).padStart(64, "0")}`,
      output: {},
    };
  }
  receipts.M2500.finding_status = "NO_FINDING";
  receipts.M2500.output = {
    release_safe: true,
    suite: "SEO_AVENGERS_2500",
    strict_white_hat_only: true,
    no_google_scraping: true,
  };
  const terminalEvidenceHash = receipts.M2500.evidence_hash;
  return {
    schemaVersion: 1,
    siteId,
    status: "RELEASED",
    reason: "RELEASED",
    controlGeneration: 1,
    evidenceManifestHash: SHA,
    configHash: SHA,
    executionHash: SHA,
    terminalEvidenceHash,
    receiptCount: 1500,
    receipts,
  };
}

async function withRoot(t) {
  const root = await mkdtemp(join(tmpdir(), "walle-canary-store-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

test("released complete local range is persisted and reverified", async (t) => {
  const resultRoot = await withRoot(t);
  const stored = await persistCanaryResult({
    resultRoot,
    runId: "canary-store-pass",
    sourceRevision: SOURCE_REVISION,
    sourceTree: SOURCE_TREE,
    result: releasedResult(),
  });
  assert.match(stored.proof.proof_hash, /^sha256:[0-9a-f]{64}$/);
  assert.equal(stored.proof.receipt_count, 1500);
  assert.equal(stored.proof.finding_count + stored.proof.no_finding_count, 1500);
  const verified = await readCanaryResult({ resultRoot, runId: "canary-store-pass" });
  assert.equal(verified.proof_hash, stored.proof.proof_hash);
  assert.equal(verified.source_revision, SOURCE_REVISION);
});

test("same run id cannot overwrite an immutable canary proof", async (t) => {
  const resultRoot = await withRoot(t);
  const input = {
    resultRoot,
    runId: "canary-immutable",
    sourceRevision: SOURCE_REVISION,
    sourceTree: SOURCE_TREE,
    result: releasedResult(),
  };
  await persistCanaryResult(input);
  await assert.rejects(() => persistCanaryResult(input), /EEXIST|exist/i);
});

test("incomplete evidence cannot be promoted to a certified canary", async (t) => {
  const resultRoot = await withRoot(t);
  await assert.rejects(
    () => persistCanaryResult({
      resultRoot,
      runId: "canary-insufficient",
      sourceRevision: SOURCE_REVISION,
      sourceTree: SOURCE_TREE,
      result: releasedResult({ insufficientModule: "M1201" }),
    }),
    /complete evidence M1201/,
  );
});

test("result store is hard-bound to the synthetic canary tenant", async (t) => {
  const resultRoot = await withRoot(t);
  await assert.rejects(
    () => persistCanaryResult({
      resultRoot,
      runId: "canary-real-tenant-rejected",
      sourceRevision: SOURCE_REVISION,
      sourceTree: SOURCE_TREE,
      result: releasedResult({ siteId: "cano-penal" }),
    }),
    /site mismatch/,
  );
});

test("tampered persisted bytes fail verification", async (t) => {
  const resultRoot = await withRoot(t);
  const stored = await persistCanaryResult({
    resultRoot,
    runId: "canary-tamper",
    sourceRevision: SOURCE_REVISION,
    sourceTree: SOURCE_TREE,
    result: releasedResult(),
  });
  const parsed = JSON.parse(await readFile(stored.path, "utf8"));
  parsed.result.receipts.M1001.finding_status = "FINDING";
  await writeFile(stored.path, `${JSON.stringify(parsed)}\n`, "utf8");
  await assert.rejects(() => readCanaryResult({ resultRoot, runId: "canary-tamper" }), /hash mismatch|counts mismatch/);
});
