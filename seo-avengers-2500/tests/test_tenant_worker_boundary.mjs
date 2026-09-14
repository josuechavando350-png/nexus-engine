import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";

import "./test_canary_result_store.mjs";
import "./test_readonly_canary.mjs";
import "./test_readonly_canary_real.mjs";

const execFile = promisify(execFileCallback);
const workerUrl = new URL("../sidecar/tenant-worker.mjs", import.meta.url);
const bridgeUrl = new URL("../sidecar/execute_suite.py", import.meta.url);
const canaryRunnerUrl = new URL("../sidecar/readonly-canary.mjs", import.meta.url);
const canaryAdapterUrl = new URL("../../walle/adapters/seo-avengers-2500-canary.sh", import.meta.url);

test("sidecar worker has no client-app or network integration imports", async () => {
  const source = await readFile(workerUrl, "utf8");
  assert.doesNotMatch(source, /apps\//);
  assert.doesNotMatch(source, /node:http|node:https|node:net|node:dgram|node:tls/);
  assert.doesNotMatch(source, /node:fs\/promises|writeFile|appendFile|rename|mkdir/);
  assert.doesNotMatch(source, /vercel|cloudflare|googleapis|google-ads|searchconsole/i);
  assert.match(source, /readTenantControl/);
  assert.match(source, /readTenantEvidenceSnapshot/);
  assert.match(source, /shell:\s*false/);
});

test("Python bridge delegates to existing deterministic 2500 runner", async () => {
  const source = await readFile(bridgeUrl, "utf8");
  assert.match(source, /from runtime\.runner import run_batch_1001_2500/);
  assert.match(source, /run_batch_1001_2500\(payload, config\)/);
  assert.doesNotMatch(source, /requests|httpx|aiohttp|urllib\.request|socket|subprocess|os\.system/);
  assert.doesNotMatch(source, /google|vercel|cloudflare/i);
});

test("read-only canary is fixed to synthetic identity and adds no network/client integration", async () => {
  const source = await readFile(canaryRunnerUrl, "utf8");
  assert.match(source, /CANARY_SITE_ID/);
  assert.doesNotMatch(source, /apps\//);
  assert.doesNotMatch(source, /node:http|node:https|node:net|node:dgram|node:tls/);
  assert.doesNotMatch(source, /googleapis|google-ads|searchconsole|vercel|cloudflare/i);
});

test("WALLE canary adapter is shell-valid and exposes no caller-supplied tenant id", async () => {
  const path = fileURLToPath(canaryAdapterUrl);
  await execFile("bash", ["-n", path]);
  const source = await readFile(canaryAdapterUrl, "utf8");
  assert.doesNotMatch(source, /--site-id/);
  assert.match(source, /WALLE_CANARY_SITE_ID=walle-production-canary/);
  assert.match(source, /google_search_safety\.py/);
  assert.match(source, /status --porcelain=v1 --untracked-files=all/);
});
