#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

echo "[1/8] Python syntax"
python3 -m compileall -q runtime tests scripts

echo "[2/8] Runtime + promoted batches + 200-module mass lot + bridge + worker tests"
python3 -m unittest discover -s tests -v

echo "[3/8] Node/Python wire contract + legacy and mass-lot outbox transport"
node tests/test-outbox.mjs
node tests/test-mass-lot-outbox.mjs

echo "[4/8] 1200-slot honesty + exact 200-module promotion invariant"
python3 - <<'PY'
from runtime.catalog import BASE_IMPLEMENTED_EXTENDED_MODULES, IMPLEMENTED_EXTENDED_MODULES, PRE_GATE_MODULES, module_registry
from runtime.mass_lot_manifest import SOURCE_SPEC_SHA256
from runtime.mass_lot_runtime_manifest import RUNTIME_MASS_LOT_SOURCE_MODULES, RUNTIME_MASS_LOT_TARGET_MODULES, runtime_source_to_target_map

registry = module_registry()
assert len(registry) == 1200
assert list(registry) == [f"M{i}" for i in range(1, 1201)]
assert len(BASE_IMPLEMENTED_EXTENDED_MODULES) == 74
assert len(RUNTIME_MASS_LOT_TARGET_MODULES) == 200
assert len(RUNTIME_MASS_LOT_SOURCE_MODULES) == 200
assert RUNTIME_MASS_LOT_SOURCE_MODULES[0] == "M1201"
assert RUNTIME_MASS_LOT_SOURCE_MODULES[-1] == "M1400"
assert SOURCE_SPEC_SHA256 == "sha256:16dc5dd3c0834c1e3306add2bb79b00aac072fd5767ce352c31725d2d024e9d1"
assert runtime_source_to_target_map()["M1201"] == "M216"
assert runtime_source_to_target_map()["M1400"] == "M440"
assert IMPLEMENTED_EXTENDED_MODULES == BASE_IMPLEMENTED_EXTENDED_MODULES | RUNTIME_MASS_LOT_TARGET_MODULES
assert len(IMPLEMENTED_EXTENDED_MODULES) == 274
assert len(PRE_GATE_MODULES) == 272
assert sum(1 for row in registry.values() if row["status"] == "IMPLEMENTED_PRODUCTION") == 274
assert all(not row["executable_here"] for row in registry.values() if row["status"] == "RESERVED")
assert all(registry[module]["executable_here"] for module in RUNTIME_MASS_LOT_TARGET_MODULES)
for sentinel in ("M215", "M317", "M441"):
    assert registry[sentinel]["status"] == "RESERVED"
    assert registry[sentinel]["executable_here"] is False
print("1200 contiguous slots; 274 reviewed extended handlers; exactly 200 source-bound mass-lot modules promoted; remaining reserved slots non-executable")
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

echo "[6/8] Tenant switch + durable deterministic multi-dataset outbox"
node --input-type=module - <<'JS'
import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readSeoAvengers1200ProjectConfig } from "./scripts/seo-avengers-1200-config.mjs";
import { enqueueSeoAvengers1200Run } from "./scripts/seo-avengers-1200-outbox.mjs";

const repo = await mkdtemp(join(tmpdir(), "seo-avengers-1200-"));
const project = join(repo, "apps", "probe");
await mkdir(project, {recursive:true});
const datasetKeys = [
  "search_performance_records", "keyword_coverage_records", "traffic_window_records", "traffic_series_records",
  "revenue_funnel_records", "revenue_attribution_records", "content_documents", "content_decay_records",
  "external_pages", "local_business_records", "site_images_data", "edge_html_records", "semantic_text_records",
  "persistence_state_records", "edge_gateway_records", "search_intent_records", "cwv_edge_records",
  "canonicalization_records", "policy_audit_records", "upstream_evidence",
];
try {
  await writeFile(join(project, "package.json"), JSON.stringify({name:"probe", nexus:{CONFIG_SEO_AVENGERS_200:true, CONFIG_SEO_AVENGERS_1200:false}}));
  let cfg = await readSeoAvengers1200ProjectConfig(project);
  if (cfg.enabled !== false) throw new Error("extension enabled without explicit dual switch");

  await writeFile(join(project, "package.json"), JSON.stringify({name:"probe", nexus:{CONFIG_SEO_AVENGERS_200:true, CONFIG_SEO_AVENGERS_1200:true}}));
  cfg = await readSeoAvengers1200ProjectConfig(project);
  if (cfg.enabled !== true) throw new Error("explicit dual enable did not activate extension");

  const payload = {meta_telemetry:{server_cpu_utilization_percent:40, cloudflare_kv_latency_ms:900, active_pipeline_actions_pool:[]}};
  for (const key of datasetKeys) payload[key] = [];
  const queued = await enqueueSeoAvengers1200Run({projectDir:project, sourceRevision:"fixture-revision", payload, runtimeConfig:{m1102_max_failure_rate_ppm:50000}});
  if (queued.status !== "QUEUED") throw new Error(`outbox status was ${queued.status}`);
  const stored = JSON.parse(await readFile(queued.path, "utf8"));
  if (stored.input_hash !== stored.idempotency_key) throw new Error("outbox idempotency binding mismatch");
  for (const key of datasetKeys) if (!Array.isArray(stored.payload[key])) throw new Error(`${key} transport missing`);
  console.log("dual-switch and durable all-dataset outbox verified");
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

echo "SEO Avengers 1200 mass-lot verification complete."
