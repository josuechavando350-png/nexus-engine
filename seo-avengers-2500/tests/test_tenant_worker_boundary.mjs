import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const workerUrl = new URL("../sidecar/tenant-worker.mjs", import.meta.url);
const bridgeUrl = new URL("../sidecar/execute_suite.py", import.meta.url);

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
