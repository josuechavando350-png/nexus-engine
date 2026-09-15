import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFile as execFileCallback } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";

import { setTenantEnabled, setTenantKillSwitch } from "../control-plane/tenant-control.mjs";
import { ALLOWED_DATASET_KEYS } from "../evidence/tenant-evidence.mjs";
import { CANARY_SITE_ID, readCanaryResult } from "../sidecar/canary-result-store.mjs";
import { runReadonlyCanary } from "../sidecar/readonly-canary.mjs";

const execFile = promisify(execFileCallback);
const SUITE_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const SOURCE_REVISION = "1".repeat(40);
const SOURCE_TREE = "2".repeat(40);

function sha256Bytes(bytes) {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

async function loadControlledFixture() {
  const { stdout } = await execFile("python", ["tests/canary_fixture.py"], {
    cwd: SUITE_ROOT,
    maxBuffer: 64 * 1024 * 1024,
  });
  return JSON.parse(stdout);
}

async function publishEvidence({ evidenceRoot, controlGeneration, payload }) {
  const tenantDirectory = join(evidenceRoot, "tenants", CANARY_SITE_ID);
  await mkdir(tenantDirectory, { recursive: true, mode: 0o700 });
  const descriptors = [];
  for (const key of ALLOWED_DATASET_KEYS) {
    if (!(key in payload)) continue;
    assert.ok(Array.isArray(payload[key]), `${key} must remain a record array`);
    const bytes = Buffer.from(`${JSON.stringify(payload[key])}\n`, "utf8");
    const file = `${key}.json`;
    await writeFile(join(tenantDirectory, file), bytes, { mode: 0o600 });
    descriptors.push({ key, file, sha256: sha256Bytes(bytes) });
  }
  assert.ok(descriptors.length > 0);
  const manifest = {
    schema_version: 1,
    site_id: CANARY_SITE_ID,
    control_generation: controlGeneration,
    datasets: descriptors,
  };
  await writeFile(join(tenantDirectory, "manifest.json"), `${JSON.stringify(manifest)}\n`, { mode: 0o600 });
}

test("real local sidecar canary certifies complete evidence and hot-disable stops the next run", { timeout: 180000 }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "walle-production-canary-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const controlRoot = join(root, "control");
  const evidenceRoot = join(root, "evidence");
  const resultRoot = join(root, "results");
  await mkdir(controlRoot, { mode: 0o700 });
  await mkdir(evidenceRoot, { mode: 0o700 });
  await mkdir(resultRoot, { mode: 0o700 });

  const enabled = await setTenantEnabled({
    controlRoot,
    siteId: CANARY_SITE_ID,
    enabled: true,
    expectedGeneration: 0,
  });
  assert.equal(enabled.authorized, true);
  assert.equal(enabled.generation, 1);

  const { payload, config } = await loadControlledFixture();
  await publishEvidence({ evidenceRoot, controlGeneration: enabled.generation, payload });

  const certified = await runReadonlyCanary({
    controlRoot,
    evidenceRoot,
    resultRoot,
    runId: "canary-ci-real-sidecar",
    sourceRevision: SOURCE_REVISION,
    sourceTree: SOURCE_TREE,
    config,
  });
  assert.equal(certified.status, "CERTIFIED");
  assert.equal(certified.siteId, CANARY_SITE_ID);
  assert.equal(certified.localReceiptCount, 1500);
  assert.equal(certified.findingCount + certified.noFindingCount, 1500);
  const proof = await readCanaryResult({ resultRoot, runId: "canary-ci-real-sidecar" });
  assert.equal(proof.source_revision, SOURCE_REVISION);
  assert.equal(proof.receipt_count, 1500);

  const killed = await setTenantKillSwitch({
    controlRoot,
    siteId: CANARY_SITE_ID,
    active: true,
    expectedGeneration: 1,
  });
  assert.equal(killed.authorized, false);
  assert.equal(killed.reason, "KILL_SWITCH_ACTIVE");

  const stopped = await runReadonlyCanary({
    controlRoot,
    evidenceRoot,
    resultRoot,
    runId: "canary-ci-after-kill",
    sourceRevision: SOURCE_REVISION,
    sourceTree: SOURCE_TREE,
    config,
  });
  assert.equal(stopped.status, "OFF");
  assert.equal(stopped.reason, "KILL_SWITCH_ACTIVE");
  assert.equal(stopped.persisted, false);
});
