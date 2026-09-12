import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  appendTenantControl,
  authorizeTenantJob,
  readTenantControl,
  setTenantEnabled,
  setTenantKillSwitch,
} from "../control-plane/tenant-control.mjs";

async function withRoot(run) {
  const root = await mkdtemp(join(tmpdir(), "nexus-avengers-2500-control-"));
  try {
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("missing tenant is authoritative OFF", async () => withRoot(async (root) => {
  const state = await readTenantControl({ controlRoot: root, siteId: "nexus-bot-studio" });
  assert.equal(state.authorized, false);
  assert.equal(state.enabled, false);
  assert.equal(state.killSwitch, true);
  assert.equal(state.integrityOk, true);
  assert.equal(state.generation, 0);
  assert.equal(state.reason, "TENANT_MISSING");
}));

test("enable requires an explicit append and produces generation one", async () => withRoot(async (root) => {
  const state = await setTenantEnabled({
    controlRoot: root,
    siteId: "nexus-bot-studio",
    enabled: true,
    expectedGeneration: 0,
  });
  assert.equal(state.authorized, true);
  assert.equal(state.enabled, true);
  assert.equal(state.killSwitch, false);
  assert.equal(state.generation, 1);
  assert.match(state.stateHash, /^sha256:[0-9a-f]{64}$/);
  const hwm = JSON.parse(await readFile(join(root, "tenants", "nexus-bot-studio", ".hwm.json"), "utf8"));
  assert.equal(hwm.generation, 1);
  assert.equal(hwm.state_hash, state.stateHash);
  assert.match(hwm.hwm_hash, /^sha256:[0-9a-f]{64}$/);
}));

test("kill switch is independent and enable never clears it", async () => withRoot(async (root) => {
  let state = await setTenantKillSwitch({
    controlRoot: root,
    siteId: "nexus-bot-studio",
    active: true,
    expectedGeneration: 0,
  });
  assert.equal(state.enabled, false);
  assert.equal(state.killSwitch, true);
  assert.equal(state.authorized, false);

  state = await setTenantEnabled({
    controlRoot: root,
    siteId: "nexus-bot-studio",
    enabled: true,
    expectedGeneration: 1,
  });
  assert.equal(state.enabled, true);
  assert.equal(state.killSwitch, true);
  assert.equal(state.authorized, false);
  assert.equal(state.reason, "KILL_SWITCH_ACTIVE");

  state = await setTenantKillSwitch({
    controlRoot: root,
    siteId: "nexus-bot-studio",
    active: false,
    expectedGeneration: 2,
  });
  assert.equal(state.enabled, true);
  assert.equal(state.killSwitch, false);
  assert.equal(state.authorized, true);
}));

test("disable makes the tenant OFF without deleting audit history", async () => withRoot(async (root) => {
  await setTenantEnabled({ controlRoot: root, siteId: "cano-penal", enabled: true, expectedGeneration: 0 });
  const disabled = await setTenantEnabled({ controlRoot: root, siteId: "cano-penal", enabled: false, expectedGeneration: 1 });
  assert.equal(disabled.authorized, false);
  assert.equal(disabled.reason, "DISABLED");
  assert.equal(disabled.generation, 2);

  const tenantDir = join(root, "tenants", "cano-penal");
  assert.equal((await readFile(join(tenantDir, "00000000000000000001.json"), "utf8")).length > 0, true);
  assert.equal((await readFile(join(tenantDir, "00000000000000000002.json"), "utf8")).length > 0, true);
}));

test("generation conflict prevents stale control writes", async () => withRoot(async (root) => {
  await setTenantEnabled({ controlRoot: root, siteId: "nexus-bot-studio", enabled: true, expectedGeneration: 0 });
  await assert.rejects(
    appendTenantControl({
      controlRoot: root,
      siteId: "nexus-bot-studio",
      enabled: false,
      killSwitch: false,
      expectedGeneration: 0,
    }),
    /generation conflict/,
  );
}));

test("concurrent writers cannot both claim the same generation", async () => withRoot(async (root) => {
  await setTenantEnabled({ controlRoot: root, siteId: "nexus-bot-studio", enabled: true, expectedGeneration: 0 });
  const results = await Promise.allSettled([
    setTenantEnabled({ controlRoot: root, siteId: "nexus-bot-studio", enabled: false, expectedGeneration: 1 }),
    setTenantKillSwitch({ controlRoot: root, siteId: "nexus-bot-studio", active: true, expectedGeneration: 1 }),
  ]);
  assert.equal(results.filter((entry) => entry.status === "fulfilled").length, 1);
  assert.equal(results.filter((entry) => entry.status === "rejected").length, 1);
  const state = await readTenantControl({ controlRoot: root, siteId: "nexus-bot-studio" });
  assert.equal(state.integrityOk, true);
  assert.equal(state.generation, 2);
}));

test("any newer generation makes an older queued job stale", async () => withRoot(async (root) => {
  await setTenantEnabled({ controlRoot: root, siteId: "nexus-bot-studio", enabled: true, expectedGeneration: 0 });
  assert.deepEqual(
    await authorizeTenantJob({ controlRoot: root, siteId: "nexus-bot-studio", jobGeneration: 1 }),
    { authorized: true, reason: "AUTHORIZED", generation: 1 },
  );

  await appendTenantControl({
    controlRoot: root,
    siteId: "nexus-bot-studio",
    enabled: true,
    killSwitch: false,
    expectedGeneration: 1,
  });
  assert.deepEqual(
    await authorizeTenantJob({ controlRoot: root, siteId: "nexus-bot-studio", jobGeneration: 1 }),
    { authorized: false, reason: "STALE_GENERATION", generation: 2 },
  );
}));

test("disabled or killed tenant cannot authorize a job", async () => withRoot(async (root) => {
  await setTenantEnabled({ controlRoot: root, siteId: "cano-penal", enabled: true, expectedGeneration: 0 });
  await setTenantKillSwitch({ controlRoot: root, siteId: "cano-penal", active: true, expectedGeneration: 1 });
  const decision = await authorizeTenantJob({ controlRoot: root, siteId: "cano-penal", jobGeneration: 2 });
  assert.equal(decision.authorized, false);
  assert.equal(decision.reason, "KILL_SWITCH_ACTIVE");
}));

test("malformed latest state fails closed and blocks mutation", async () => withRoot(async (root) => {
  await setTenantEnabled({ controlRoot: root, siteId: "cano-penal", enabled: true, expectedGeneration: 0 });
  const path = join(root, "tenants", "cano-penal", "00000000000000000001.json");
  await writeFile(path, "{not-json\n", "utf8");
  const state = await readTenantControl({ controlRoot: root, siteId: "cano-penal" });
  assert.equal(state.authorized, false);
  assert.equal(state.integrityOk, false);
  assert.equal(state.reason, "STATE_INTEGRITY_FAILURE");
  await assert.rejects(
    setTenantEnabled({ controlRoot: root, siteId: "cano-penal", enabled: true, expectedGeneration: 1 }),
    /fail-closed/,
  );
}));

test("tampering with a historical state invalidates the whole tenant chain", async () => withRoot(async (root) => {
  await setTenantEnabled({ controlRoot: root, siteId: "nexus-bot-studio", enabled: true, expectedGeneration: 0 });
  await setTenantEnabled({ controlRoot: root, siteId: "nexus-bot-studio", enabled: false, expectedGeneration: 1 });
  const firstPath = join(root, "tenants", "nexus-bot-studio", "00000000000000000001.json");
  const first = JSON.parse(await readFile(firstPath, "utf8"));
  first.enabled = false;
  await writeFile(firstPath, `${JSON.stringify(first)}\n`, "utf8");
  const state = await readTenantControl({ controlRoot: root, siteId: "nexus-bot-studio" });
  assert.equal(state.authorized, false);
  assert.equal(state.integrityOk, false);
  assert.equal(state.reason, "STATE_INTEGRITY_FAILURE");
}));

test("tenant namespaces do not bleed into each other and path traversal is rejected", async () => withRoot(async (root) => {
  await setTenantEnabled({ controlRoot: root, siteId: "nexus-bot-studio", enabled: true, expectedGeneration: 0 });
  const cano = await readTenantControl({ controlRoot: root, siteId: "cano-penal" });
  assert.equal(cano.reason, "TENANT_MISSING");
  assert.equal(cano.authorized, false);

  const traversal = await readTenantControl({ controlRoot: root, siteId: "../nexus-bot-studio" });
  assert.equal(traversal.authorized, false);
  assert.equal(traversal.reason, "INVALID_SITE_ID");
}));

test("tail truncation cannot resurrect a killed tenant", async () => withRoot(async (root) => {
  await setTenantEnabled({ controlRoot: root, siteId: "cano-penal", enabled: true, expectedGeneration: 0 });
  await setTenantKillSwitch({ controlRoot: root, siteId: "cano-penal", active: true, expectedGeneration: 1 });
  const tenantDir = join(root, "tenants", "cano-penal");
  await rm(join(tenantDir, "00000000000000000002.json"));

  const state = await readTenantControl({ controlRoot: root, siteId: "cano-penal" });
  assert.equal(state.authorized, false);
  assert.equal(state.integrityOk, false);
  assert.equal(state.reason, "HWM_MISMATCH");
  const decision = await authorizeTenantJob({ controlRoot: root, siteId: "cano-penal", jobGeneration: 1 });
  assert.equal(decision.authorized, false);
  assert.equal(decision.reason, "HWM_MISMATCH");
  await assert.rejects(
    setTenantEnabled({ controlRoot: root, siteId: "cano-penal", enabled: true, expectedGeneration: 1 }),
    /fail-closed/,
  );
}));

test("missing high-water mark fails closed instead of trusting journal tail", async () => withRoot(async (root) => {
  await setTenantEnabled({ controlRoot: root, siteId: "nexus-bot-studio", enabled: true, expectedGeneration: 0 });
  const tenantDir = join(root, "tenants", "nexus-bot-studio");
  await rm(join(tenantDir, ".hwm.json"));

  const state = await readTenantControl({ controlRoot: root, siteId: "nexus-bot-studio" });
  assert.equal(state.authorized, false);
  assert.equal(state.integrityOk, false);
  assert.equal(state.reason, "HWM_MISSING");
  await assert.rejects(
    setTenantEnabled({ controlRoot: root, siteId: "nexus-bot-studio", enabled: false, expectedGeneration: 1 }),
    /fail-closed/,
  );
}));

test("high-water mark without journal fails closed and cannot be reinitialized", async () => withRoot(async (root) => {
  await setTenantEnabled({ controlRoot: root, siteId: "nexus-bot-studio", enabled: true, expectedGeneration: 0 });
  const tenantDir = join(root, "tenants", "nexus-bot-studio");
  await rm(join(tenantDir, "00000000000000000001.json"));

  const state = await readTenantControl({ controlRoot: root, siteId: "nexus-bot-studio" });
  assert.equal(state.authorized, false);
  assert.equal(state.integrityOk, false);
  assert.equal(state.reason, "HWM_WITHOUT_JOURNAL");
  await assert.rejects(
    setTenantEnabled({ controlRoot: root, siteId: "nexus-bot-studio", enabled: true, expectedGeneration: 0 }),
    /fail-closed/,
  );
}));
