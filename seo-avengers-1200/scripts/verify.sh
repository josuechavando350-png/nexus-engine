#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

echo "[1/6] Python syntax"
python3 -m py_compile runtime/__init__.py runtime/seo_avengers_1200.py tests/test_runtime.py scripts/run.py

echo "[2/6] Runtime unit/golden tests"
python3 -m unittest discover -s tests -v

echo "[3/6] 1200-slot honesty invariant"
python3 - <<'PY'
from runtime.seo_avengers_1200 import IMPLEMENTED_EXTENDED_MODULES, module_registry
registry = module_registry()
assert len(registry) == 1200
assert list(registry) == [f"M{i}" for i in range(1, 1201)]
assert all(not row["executable_here"] for row in registry.values() if row["status"] == "RESERVED")
assert IMPLEMENTED_EXTENDED_MODULES == frozenset({"M901", "M902", "M1001", "M1002", "M1101", "M1102"})
print("1200 contiguous slots; no reserved slot has an executable handler")
PY

echo "[4/6] CLI deny-by-default boundary"
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

echo "[5/6] Tenant switch requires both Avengers 200 and 1200"
node --input-type=module - <<'JS'
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readSeoAvengers1200ProjectConfig } from "./engine-overlay/scripts/seo-avengers-1200-config.mjs";

const dir = await mkdtemp(join(tmpdir(), "seo-avengers-1200-"));
try {
  await writeFile(join(dir, "package.json"), JSON.stringify({name:"tenant-a", nexus:{CONFIG_SEO_AVENGERS_200:true, CONFIG_SEO_AVENGERS_1200:false}}));
  let cfg = await readSeoAvengers1200ProjectConfig(dir);
  if (cfg.enabled !== false) throw new Error("1200 extension enabled without its explicit switch");

  await writeFile(join(dir, "package.json"), JSON.stringify({name:"tenant-a", nexus:{CONFIG_SEO_AVENGERS_200:false, CONFIG_SEO_AVENGERS_1200:true}}));
  cfg = await readSeoAvengers1200ProjectConfig(dir);
  if (cfg.enabled !== false) throw new Error("1200 extension enabled without Avengers 200 base");

  await writeFile(join(dir, "package.json"), JSON.stringify({name:"tenant-a", nexus:{CONFIG_SEO_AVENGERS_200:true, CONFIG_SEO_AVENGERS_1200:true}}));
  cfg = await readSeoAvengers1200ProjectConfig(dir);
  if (cfg.enabled !== true) throw new Error("explicit dual enable did not activate extension");
  console.log("dual-switch extension gate verified");
} finally {
  await rm(dir, {recursive:true, force:true});
}
JS

echo "[6/6] Isolation invariant"
python3 - <<'PY'
from pathlib import Path
root = Path.cwd().resolve()
assert root.name == "seo-avengers-1200"
for path in root.rglob("*"):
    if path.is_file():
        text = path.read_text("utf-8", errors="ignore")
        assert "apps/cano-penal" not in text
print("seo-avengers-1200 is isolated; no cano-penal path references")
PY

echo "SEO Avengers 1200 isolated verification complete."
