import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  readTenantControl,
  setTenantEnabled,
} from "../control-plane/tenant-control.mjs";

async function withRoot(run) {
  const root = await mkdtemp(join(tmpdir(), "nexus-avengers-2500-control-strict-"));
  try {
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("unexpected file in tenant journal fails closed", async () => withRoot(async (root) => {
  await setTenantEnabled({ controlRoot: root, siteId: "nexus-bot-studio", enabled: true, expectedGeneration: 0 });
  await writeFile(join(root, "tenants", "nexus-bot-studio", "unexpected.txt"), "x", "utf8");
  const state = await readTenantControl({ controlRoot: root, siteId: "nexus-bot-studio" });
  assert.equal(state.authorized, false);
  assert.equal(state.integrityOk, false);
  assert.equal(state.reason, "CONTROL_STORE_UNREADABLE");
}));

test("generation gap fails closed", async () => withRoot(async (root) => {
  const tenantDir = join(root, "tenants", "cano-penal");
  await mkdir(tenantDir, { recursive: true });
  await writeFile(join(tenantDir, "00000000000000000002.json"), "{}\n", "utf8");
  await writeFile(join(tenantDir, ".hwm.json"), "{}\n", "utf8");
  const state = await readTenantControl({ controlRoot: root, siteId: "cano-penal" });
  assert.equal(state.authorized, false);
  assert.equal(state.integrityOk, false);
  assert.equal(state.reason, "GENERATION_GAP");
}));

test("malformed boolean cannot be normalized into enabled state", async () => withRoot(async (root) => {
  await setTenantEnabled({ controlRoot: root, siteId: "cano-penal", enabled: true, expectedGeneration: 0 });
  const tenantDir = join(root, "tenants", "cano-penal");
  const path = join(tenantDir, "00000000000000000001.json");
  const record = JSON.parse(await readFile(path, "utf8"));
  record.enabled = "true";
  await writeFile(path, `${JSON.stringify(record)}\n`, "utf8");
  const state = await readTenantControl({ controlRoot: root, siteId: "cano-penal" });
  assert.equal(state.authorized, false);
  assert.equal(state.integrityOk, false);
  assert.equal(state.reason, "STATE_INTEGRITY_FAILURE");
}));

test("tampered high-water mark fails closed", async () => withRoot(async (root) => {
  await setTenantEnabled({ controlRoot: root, siteId: "nexus-bot-studio", enabled: true, expectedGeneration: 0 });
  const path = join(root, "tenants", "nexus-bot-studio", ".hwm.json");
  const hwm = JSON.parse(await readFile(path, "utf8"));
  hwm.generation = 2;
  await writeFile(path, `${JSON.stringify(hwm)}\n`, "utf8");
  const state = await readTenantControl({ controlRoot: root, siteId: "nexus-bot-studio" });
  assert.equal(state.authorized, false);
  assert.equal(state.integrityOk, false);
  assert.equal(state.reason, "HWM_INTEGRITY_FAILURE");
}));

test("interrupted high-water update marker fails closed", async () => withRoot(async (root) => {
  await setTenantEnabled({ controlRoot: root, siteId: "nexus-bot-studio", enabled: true, expectedGeneration: 0 });
  await writeFile(join(root, "tenants", "nexus-bot-studio", ".hwm.pending.json"), "{}\n", "utf8");
  const state = await readTenantControl({ controlRoot: root, siteId: "nexus-bot-studio" });
  assert.equal(state.authorized, false);
  assert.equal(state.integrityOk, false);
  assert.equal(state.reason, "CONTROL_STORE_UNREADABLE");
}));
