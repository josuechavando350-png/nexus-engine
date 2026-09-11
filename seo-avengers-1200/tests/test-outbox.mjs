import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  buildSeoAvengers1200Envelope,
  enqueueSeoAvengers1200Run,
} from "../scripts/seo-avengers-1200-outbox.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const SUITE_ROOT = resolve(HERE, "..");

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

const tempRoot = await mkdtemp(join(tmpdir(), "seo-avengers-1200-node-"));
const projectDir = join(tempRoot, "apps", "probe");
await import("node:fs/promises").then(({ mkdir }) => mkdir(projectDir, { recursive: true }));

try {
  const payload = {
    meta_telemetry: {
      server_cpu_utilization_percent: 40,
      cloudflare_kv_latency_ms: 900,
      active_pipeline_actions_pool: [],
      locale_probe: "México — señal ñ",
    },
    site_images_data: [],
    upstream_evidence: [],
  };
  const runtimeConfig = {
    m901_max_safe_cpu_percent: 80,
    m901_max_safe_kv_latency_ms: 150,
    m901_kv_saturation_latency_ms: 1000,
  };

  await writeFile(
    join(projectDir, "package.json"),
    JSON.stringify({
      name: "probe",
      nexus: {
        CONFIG_SEO_AVENGERS_200: true,
        CONFIG_SEO_AVENGERS_1200: false,
      },
    }),
  );

  const disabled = await enqueueSeoAvengers1200Run({
    projectDir,
    sourceRevision: "fixture-revision",
    payload,
    runtimeConfig,
  });
  assert.equal(disabled.status, "DISABLED");
  assert.equal(await exists(join(tempRoot, ".artifacts", "seo-avengers-1200")), false);

  const envelope = buildSeoAvengers1200Envelope({
    siteId: "probe",
    sourceRevision: "fixture-revision",
    payload,
    runtimeConfig,
  });
  const core = {
    authority: envelope.authority,
    schema_version: envelope.schema_version,
    site_id: envelope.site_id,
    source_revision: envelope.source_revision,
    payload: envelope.payload,
    runtime_config: envelope.runtime_config,
  };

  const python = spawnSync(
    "python3",
    [
      "-c",
      "import json,sys; from runtime.wire import envelope_hash_v1; print(envelope_hash_v1(json.load(sys.stdin)))",
    ],
    {
      cwd: SUITE_ROOT,
      input: JSON.stringify(core),
      encoding: "utf8",
    },
  );
  assert.equal(python.status, 0, python.stderr);
  assert.equal(python.stdout.trim(), envelope.input_hash);

  await writeFile(
    join(projectDir, "package.json"),
    JSON.stringify({
      name: "probe",
      nexus: {
        CONFIG_SEO_AVENGERS_200: true,
        CONFIG_SEO_AVENGERS_1200: true,
      },
    }),
  );

  const queued = await enqueueSeoAvengers1200Run({
    projectDir,
    sourceRevision: "fixture-revision",
    payload,
    runtimeConfig,
  });
  assert.equal(queued.status, "QUEUED");
  assert.equal(queued.inputHash, envelope.input_hash);

  const persisted = JSON.parse(await readFile(queued.path, "utf8"));
  assert.equal(persisted.input_hash, envelope.input_hash);
  assert.equal(persisted.idempotency_key, envelope.input_hash);
  assert.equal(persisted.payload.meta_telemetry.locale_probe, "México — señal ñ");

  console.log("SEO Avengers 1200 outbox lazy bypass + Node/Python wire hash verified");
} finally {
  await rm(tempRoot, { recursive: true, force: true });
}
