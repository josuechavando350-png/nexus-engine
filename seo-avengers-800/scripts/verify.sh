#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

echo "[1/6] Verify existing audited M001-M600 runtime"
bash seo-avengers-600/scripts/verify.sh

echo "[2/6] Compile exact M601-M800 runtime"
python -m py_compile \
  seo-avengers-800/runtime/common.py \
  seo-avengers-800/runtime/foundation_specs.py \
  seo-avengers-800/runtime/final_specs.py \
  seo-avengers-800/runtime/foundation_evidence.py \
  seo-avengers-800/runtime/manifest.py \
  seo-avengers-800/runtime/semantic_bayes.py \
  seo-avengers-800/runtime/html_streaming.py \
  seo-avengers-800/runtime/runner.py \
  seo-avengers-800/runtime/catalog.py \
  seo-avengers-800/runtime/service.py \
  seo-avengers-800/tests/foundation_fixture.py \
  seo-avengers-800/tests/fixture.py \
  seo-avengers-800/tests/test_foundation_601_700.py \
  seo-avengers-800/tests/test_semantic_bayes.py \
  seo-avengers-800/tests/test_html_streaming.py \
  seo-avengers-800/tests/test_final_751_800.py \
  seo-avengers-800/tests/test_suite_800.py

echo "[3/6] Run exact 800 regression suites"
(
  cd seo-avengers-800
  python -m unittest discover -s tests -p 'test_*.py' -v
)

echo "[4/6] Prove exact M1601-M1800 -> M601-M800 mapping and 800 composition"
PYTHONPATH=seo-avengers-800 python - <<'PY'
from runtime.catalog import module_registry
from runtime.manifest import MODULE_SPECS, SOURCE_MODULES, TARGET_MODULES, source_to_target_map
assert TARGET_MODULES == tuple(f"M{i}" for i in range(601, 801))
assert SOURCE_MODULES == tuple(f"M{i}" for i in range(1601, 1801))
assert len(MODULE_SPECS) == 200
assert len({v["operation"] for v in MODULE_SPECS.values()}) == 200
assert len({v["source_module"] for v in MODULE_SPECS.values()}) == 200
mapping = source_to_target_map()
for source in SOURCE_MODULES:
    assert mapping[source] == f"M{int(source[1:]) - 1000}"
registry = module_registry()
assert tuple(registry) == tuple(f"M{i}" for i in range(1, 801))
assert "M801" not in registry
print("M001-M600 delegated audited runtime + M601-M800 exact new runtime = exactly 800")
PY

echo "[5/6] Reject fabricated providers/placeholders and client coupling in executable/test code"
if grep -RInE 'tusitio\.com|example\.com|SEO Avengers Suite|google_kg_mock|apps/cano-penal|delivery/cano-penal|authority_drainer|search_volume_emulat|stream_optimized_for_bot' \
  seo-avengers-800/runtime seo-avengers-800/tests; then
  echo "forbidden fabricated/coupled content found" >&2
  exit 1
fi

echo "[6/6] Reject floating-point and wall-clock deterministic runtime logic"
python - <<'PY'
import ast
from pathlib import Path

for path in Path("seo-avengers-800/runtime").glob("*.py"):
    tree = ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
    for node in ast.walk(tree):
        if isinstance(node, ast.Constant) and isinstance(node.value, float):
            raise SystemExit(f"float literal forbidden in runtime: {path}:{node.lineno}")
        if isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute):
            if isinstance(node.func.value, ast.Name) and node.func.value.id == "time":
                raise SystemExit(f"wall-clock call forbidden in deterministic runtime: {path}:{node.lineno}")
print("runtime contains no float literals or time.* calls")
PY

echo "SEO Avengers 800 verification complete."
