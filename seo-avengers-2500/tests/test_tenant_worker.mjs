import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { setTenantEnabled, setTenantKillSwitch } from "../control-plane/tenant-control.mjs";
import { runTenantSidecarJob } from "../sidecar/tenant-worker.mjs";

function sha256(bytes) {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

async function setup(t, siteId = "alpha") {
  const controlRoot = await mkdtemp(join(tmpdir(), "avengers-control-"));
  const evidenceRoot = await mkdtemp(join(tmpdir(), "avengers-evidence-"));
  await mkdir(join(evidenceRoot, "tenants"), { mode: 0o700 });
  t.after(async () => {
    await rm(controlRoot, { recursive: true, force: true });
    await rm(evidenceRoot, { recursive: true, force: true });
  });
  const state = await setTenantEnabled({ controlRoot, siteId, enabled: true, expectedGeneration: 0 });
  return { controlRoot, evidenceRoot, siteId, generation: state.generation };
}

async function writeSnapshot(ctx, datasets = { content_documents: [{ document_id: "/", text: "alpha" }] }) {
  const directory = join(ctx.evidenceRoot, "tenants", ctx.siteId);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const descriptors = [];
  for (const key of Object.keys(datasets).sort()) {
    const bytes = Buffer.from(`${JSON.stringify(datasets[key])}\n`, "utf8");
    const file = `${key}.json`;
    await writeFile(join(directory, file), bytes, { mode: 0o600 });
    descriptors.push({ key, file, sha256: sha256(bytes) });
  }
  const manifest = {
    schema_version: 1,
    site_id: ctx.siteId,
    control_generation: ctx.generation,
    datasets: descriptors,
  };
  await writeFile(join(directory, "manifest.json"), `${JSON.stringify(manifest)}\n`, { mode: 0o600 });
}

function successfulExecution() {
  const evidenceHash = `sha256:${"a".repeat(64)}`;
  const receipts = {};
  for (let number = 1001; number <= 2500; number += 1) {
    const module = `M${number}`;
    receipts[module] = {
      module,
      policy_status: "SAFE_WHITE_HAT",
      action_mode: "OBSERVE_ONLY",
      execution_status: "SUCCESS",
      finding_status: "NO_FINDING",
      evidence_hash: evidenceHash,
      output: {},
    };
  }
  receipts.M2500.output = { release_safe: true, suite: "SEO_AVENGERS_2500" };
  return {
    schema_version: 1,
    receipt_count: 1500,
    first_module: "M1001",
    last_module: "M2500",
    execution_hash: `sha256:${"b".repeat(64)}`,
    terminal_evidence_hash: evidenceHash,
    receipts,
  };
}

test("authorized stable tenant releases exact sidecar result", async (t) => {
  const ctx = await setup(t);
  await writeSnapshot(ctx);
  let calls = 0;
  const result = await runTenantSidecarJob({
    ...ctx,
    config: {},
    executeSuite: async () => {
      calls += 1;
      return successfulExecution();
    },
  });
  assert.equal(calls, 1);
  assert.equal(result.status, "RELEASED");
  assert.equal(result.controlGeneration, 1);
  assert.equal(result.receiptCount, 1500);
  assert.equal(Object.keys(result.receipts).length, 1500);
  assert.match(result.evidenceManifestHash, /^sha256:[0-9a-f]{64}$/);
  assert.match(result.configHash, /^sha256:[0-9a-f]{64}$/);
});

test("disabled tenant never executes suite", async (t) => {
  const ctx = await setup(t);
  await writeSnapshot(ctx);
  await setTenantEnabled({ controlRoot: ctx.controlRoot, siteId: ctx.siteId, enabled: false, expectedGeneration: 1 });
  let calls = 0;
  const result = await runTenantSidecarJob({
    ...ctx,
    executeSuite: async () => {
      calls += 1;
      return successfulExecution();
    },
  });
  assert.equal(calls, 0);
  assert.equal(result.status, "OFF");
  assert.equal(result.reason, "DISABLED");
  assert.equal("receipts" in result, false);
});

test("missing evidence never executes suite", async (t) => {
  const ctx = await setup(t);
  let calls = 0;
  const result = await runTenantSidecarJob({
    ...ctx,
    executeSuite: async () => {
      calls += 1;
      return successfulExecution();
    },
  });
  assert.equal(calls, 0);
  assert.equal(result.status, "INSUFFICIENT_DATA");
  assert.equal(result.reason, "EVIDENCE_MISSING");
});

test("kill switch activated during execution suppresses receipts", async (t) => {
  const ctx = await setup(t);
  await writeSnapshot(ctx);
  const result = await runTenantSidecarJob({
    ...ctx,
    executeSuite: async () => {
      await setTenantKillSwitch({ controlRoot: ctx.controlRoot, siteId: ctx.siteId, active: true, expectedGeneration: 1 });
      return successfulExecution();
    },
  });
  assert.equal(result.status, "OFF");
  assert.equal(result.reason, "KILL_SWITCH_ACTIVE");
  assert.equal(result.controlGeneration, 2);
  assert.equal("receipts" in result, false);
});

test("generation movement during execution suppresses stale job", async (t) => {
  const ctx = await setup(t);
  await writeSnapshot(ctx);
  const result = await runTenantSidecarJob({
    ...ctx,
    executeSuite: async () => {
      await setTenantEnabled({ controlRoot: ctx.controlRoot, siteId: ctx.siteId, enabled: true, expectedGeneration: 1 });
      return successfulExecution();
    },
  });
  assert.equal(result.status, "OFF");
  assert.equal(result.reason, "STALE_CONTROL_GENERATION");
  assert.equal(result.controlGeneration, 2);
  assert.equal("receipts" in result, false);
});

test("evidence replacement during execution is STALE and suppressed", async (t) => {
  const ctx = await setup(t);
  await writeSnapshot(ctx, { content_documents: [{ document_id: "/", text: "before" }] });
  const result = await runTenantSidecarJob({
    ...ctx,
    executeSuite: async () => {
      await writeSnapshot(ctx, { content_documents: [{ document_id: "/", text: "after" }] });
      return successfulExecution();
    },
  });
  assert.equal(result.status, "STALE");
  assert.equal(result.reason, "EVIDENCE_CHANGED_DURING_EXECUTION");
  assert.equal("receipts" in result, false);
});

test("runtime execution error is fail-closed and suppresses receipts", async (t) => {
  const ctx = await setup(t);
  await writeSnapshot(ctx);
  const result = await runTenantSidecarJob({
    ...ctx,
    executeSuite: async () => {
      throw new Error("boom");
    },
  });
  assert.equal(result.status, "BLOCKED");
  assert.equal(result.reason, "SUITE_EXECUTION_FAILED");
  assert.equal("receipts" in result, false);
});

test("ERROR receipt cannot be released", async (t) => {
  const ctx = await setup(t);
  await writeSnapshot(ctx);
  const execution = successfulExecution();
  execution.receipts.M1777.execution_status = "ERROR";
  const result = await runTenantSidecarJob({ ...ctx, executeSuite: async () => execution });
  assert.equal(result.status, "BLOCKED");
  assert.equal(result.reason, "SUITE_EXECUTION_FAILED");
  assert.equal("receipts" in result, false);
});

test("M2500 without release-safe certification cannot be released", async (t) => {
  const ctx = await setup(t);
  await writeSnapshot(ctx);
  const execution = successfulExecution();
  execution.receipts.M2500.output.release_safe = false;
  const result = await runTenantSidecarJob({ ...ctx, executeSuite: async () => execution });
  assert.equal(result.status, "BLOCKED");
  assert.equal(result.reason, "SUITE_EXECUTION_FAILED");
  assert.equal("receipts" in result, false);
});

test("non-integer configuration is blocked before evidence execution", async (t) => {
  const ctx = await setup(t);
  await writeSnapshot(ctx);
  let calls = 0;
  const result = await runTenantSidecarJob({
    ...ctx,
    config: { bad: 1.5 },
    executeSuite: async () => {
      calls += 1;
      return successfulExecution();
    },
  });
  assert.equal(calls, 0);
  assert.equal(result.status, "BLOCKED");
  assert.equal(result.reason, "CONFIG_INVALID");
});
