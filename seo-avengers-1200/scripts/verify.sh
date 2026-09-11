#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

echo "[1/8] Python syntax"
python3 -m py_compile runtime/__init__.py runtime/catalog.py runtime/seo_avengers_1200.py runtime/batch_201_502.py runtime/batch_601_802.py runtime/wire.py runtime/legacy_bridge.py runtime/service.py tests/test_runtime.py tests/test_batch_201_502.py tests/test_batch_601_802.py tests/test_gateway_edges.py tests/test_outbox_worker.py tests/test_legacy_bridge.py scripts/run.py scripts/process-outbox.py

echo "[2/8] Runtime + promoted batches + bridge + worker unit/golden tests"
python3 -m unittest discover -s tests -v

echo "[3/8] Node/Python outbox wire contract + lazy bypass"
node tests/test-outbox.mjs

echo "[4/8] 1200-slot honesty invariant"
python3 - <<'PY'
from runtime.catalog import IMPLEMENTED_EXTENDED_MODULES, PRE_GATE_MODULES, module_registry
expected = frozenset({
    "M201", "M202", "M301", "M302", "M401", "M402", "M501", "M502",
    "M601", "M602", "M701", "M702", "M801", "M802",
    "M901", "M902", "M1001", "M1002", "M1101", "M1102",
})
registry = module_registry()
assert len(registry) == 1200
assert list(registry) == [f"M{i}" for i in range(1, 1201)]
assert IMPLEMENTED_EXTENDED_MODULES == expected
assert len(PRE_GATE_MODULES) == 18
assert all(not row["executable_here"] for row in registry.values() if row["status"] == "RESERVED")
assert sum(1 for row in registry.values() if row["status"] == "IMPLEMENTED_PRODUCTION") == 20
print("1200 contiguous slots; exactly 20 reviewed extended handlers; reserved slots remain non-executable")
PY

echo "[5/8] CLI deny-by-default boundary"
CLI_OUTPUT="$(printf '%s' '{"payload":{},"config":{}}' | python3 scripts/run.py)"
python3 - "$CLI_OUTPUT" <<'PY'
import json, sys
result=json.loads(sys.argv[1])
assert result["suite"] == "SEO_AVENGERS_1200"
assert result["enabled"] is False
assert result["bypassed"] is True
assert result["modules_executed"] == 0
print("CLI is deny-by-default")
PY

echo "[6/8] Tenant switch + durable deterministic outbox"
node --input-type=module - <<'JS'
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readSeoAvengers1200ProjectConfig } from "./scripts/seo-avengers-1200-config.mjs";
import { enqueueSeoAvengers1200Run } from "./scripts/seo-avengers-1200-outbox.mjs";

const repo = await mkdtemp(join(tmpdir(), "seo-avengers-1200-"));
const project = join(repo, "apps", "probe");
await import("node:fs/promises").then(({mkdir}) => mkdir(project, {recursive:true}));
try {
  await writeFile(join(project, "package.json"), JSON.stringify({name:"probe", nexus:{CONFIG_SEO_AVENGERS_200:true, CONFIG_SEO_AVENGERS_1200:false}}));
  let cfg = await readSeoAvengers1200ProjectConfig(project);
  if (cfg.enabled !== false) throw new Error("extension enabled without explicit dual switch");

  await writeFile(join(project, "package.json"), JSON.stringify({name:"probe", nexus:{CONFIG_SEO_AVENGERS_200:true, CONFIG_SEO_AVENGERS_1200:true}}));
  cfg = await readSeoAvengers1200ProjectConfig(project);
  if (cfg.enabled !== true) throw new Error("explicit dual enable did not activate extension");

  const queued = await enqueueSeoAvengers1200Run({
    projectDir: project,
    sourceRevision: "fixture-revision",
    payload: {
      meta_telemetry: {server_cpu_utilization_percent:40, cloudflare_kv_latency_ms:900, active_pipeline_actions_pool:[]},
      site_images_data: [],
      search_performance_records: [],
      keyword_coverage_records: [],
      traffic_window_records: [],
      traffic_series_records: [],
      revenue_funnel_records: [],
      revenue_attribution_records: [],
      content_documents: [],
      content_decay_records: [],
      external_pages: [],
      local_business_records: [],
      upstream_evidence: [],
    },
    runtimeConfig: {m1102_max_failure_rate_ppm:50000},
  });
  if (queued.status !== "QUEUED") throw new Error(`outbox status was ${queued.status}`);
  const stored = JSON.parse(await readFile(queued.path, "utf8"));
  if (stored.input_hash !== stored.idempotency_key) throw new Error("outbox idempotency binding mismatch");
  for (const key of ["search_performance_records", "keyword_coverage_records", "traffic_window_records", "traffic_series_records", "revenue_funnel_records", "revenue_attribution_records", "content_documents", "local_business_records"]) {
    if (!Array.isArray(stored.payload[key])) throw new Error(`${key} transport missing`);
  }
  console.log("dual-switch and durable multi-dataset outbox verified");
} finally {
  await rm(repo, {recursive:true, force:true});
}
JS

echo "[7/8] Native-wrapper syntax and import-target paths"
node --check engine-overlay/scripts/nexus-client-pipeline-seo-avengers-1200.mjs
python3 - <<'PY'
from pathlib import Path
wrapper = Path("engine-overlay/scripts/nexus-client-pipeline-seo-avengers-1200.mjs").resolve()
base = wrapper.parent
required = [
    (base / "../../../scripts/nexus-client-pipeline.mjs").resolve(),
    (base / "../../../seo-avengers-200/scripts/seo-avengers-200-outbox.mjs").resolve(),
    (base / "../../scripts/seo-avengers-1200-outbox.mjs").resolve(),
]
for path in required:
    assert path.is_file(), path
print("wrapper parses and all direct import targets exist")
PY

echo "[8/8] Isolation invariant"
python3 - <<'PY'
from pathlib import Path
root = Path.cwd().resolve()
assert root.name == "seo-avengers-1200"
for path in root.rglob("*"):
    if not path.is_file() or path.suffix not in {".py", ".mjs"}:
        continue
    text = path.read_text("utf-8", errors="strict")
    forbidden = "apps" + "/" + "cano-penal"
    assert forbidden not in text, path
print("seo-avengers-1200 Python/Node executable source has no client-app path dependency")
PY

echo "SEO Avengers 1200 expanded-batch verification complete."
