import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { readTenantControl, setTenantEnabled } from "../control-plane/tenant-control.mjs";

async function cleanup(t, ...paths) {
  t.after(async () => {
    for (const path of paths) await rm(path, { recursive: true, force: true });
  });
}

test("read path rejects symlinked tenant directory", async (t) => {
  const controlRoot = await mkdtemp(join(tmpdir(), "avengers-control-"));
  const outside = await mkdtemp(join(tmpdir(), "avengers-control-outside-"));
  await cleanup(t, controlRoot, outside);
  await mkdir(join(controlRoot, "tenants"));
  await symlink(outside, join(controlRoot, "tenants", "alpha"), "dir");

  const state = await readTenantControl({ controlRoot, siteId: "alpha" });
  assert.equal(state.authorized, false);
  assert.equal(state.integrityOk, false);
  assert.equal(state.reason, "CONTROL_STORE_UNREADABLE");
});

test("read path rejects symlinked control root", async (t) => {
  const parent = await mkdtemp(join(tmpdir(), "avengers-control-parent-"));
  const actual = await mkdtemp(join(tmpdir(), "avengers-control-actual-"));
  await cleanup(t, parent, actual);
  const alias = join(parent, "control-alias");
  await symlink(actual, alias, "dir");

  const state = await readTenantControl({ controlRoot: alias, siteId: "alpha" });
  assert.equal(state.authorized, false);
  assert.equal(state.integrityOk, false);
  assert.equal(state.reason, "CONTROL_STORE_UNREADABLE");
});

test("write path rejects symlinked control root", async (t) => {
  const parent = await mkdtemp(join(tmpdir(), "avengers-control-parent-"));
  const actual = await mkdtemp(join(tmpdir(), "avengers-control-actual-"));
  await cleanup(t, parent, actual);
  const alias = join(parent, "control-alias");
  await symlink(actual, alias, "dir");

  await assert.rejects(
    setTenantEnabled({ controlRoot: alias, siteId: "alpha", enabled: true, expectedGeneration: 0 }),
    /fail-closed|directory|symlink|unreadable/i,
  );
});

test("generation file symlink is rejected on read", async (t) => {
  const controlRoot = await mkdtemp(join(tmpdir(), "avengers-control-"));
  const outside = await mkdtemp(join(tmpdir(), "avengers-control-outside-"));
  await cleanup(t, controlRoot, outside);
  const tenantDir = join(controlRoot, "tenants", "alpha");
  await mkdir(tenantDir, { recursive: true });
  const target = join(outside, "00000000000000000001.json");
  await writeFile(target, "{}\n");
  await symlink(target, join(tenantDir, "00000000000000000001.json"));
  await writeFile(join(tenantDir, ".hwm.json"), "{}\n");

  const state = await readTenantControl({ controlRoot, siteId: "alpha" });
  assert.equal(state.authorized, false);
  assert.equal(state.integrityOk, false);
  assert.equal(state.reason, "CONTROL_STORE_UNREADABLE");
});
