#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

echo "[1/6] Verify existing audited M001-M600 runtime"
bash seo-avengers-600/scripts/verify.sh

echo "[2/6] Compile implemented M601-M750 slices"
python -m py_compile \
  seo-avengers-800/runtime/common.py \
  seo-avengers-800/runtime/foundation_specs.py \
  seo-avengers-800/runtime/foundation_evidence.py \
  seo-avengers-800/runtime/manifest.py \
  seo-avengers-800/runtime/semantic_bayes.py \
  seo-avengers-800/runtime/html_streaming.py \
  seo-avengers-800/runtime/runner.py \
  seo-avengers-800/tests/foundation_fixture.py \
  seo-avengers-800/tests/fixture.py \
  seo-avengers-800/tests/test_foundation_601_700.py \
  seo-avengers-800/tests/test_semantic_bayes.py \
  seo-avengers-800/tests/test_html_streaming.py

echo "[3/6] Run implemented regression suites"
(
  cd seo-avengers-800
  python -m unittest discover -s tests -p 'test_*.py' -v
)

echo "[4/6] Prove exact M1601-M1750 -> M601-M750 mapping"
PYTHONPATH=seo-avengers-800 python - <<'PY'
from runtime.manifest import MODULE_SPECS, SOURCE_MODULES, TARGET_MODULES, source_to_target_map
assert TARGET_MODULES == tuple(f"M{i}" for i in range(601, 751))
assert SOURCE_MODULES == tuple(f"M{i}" for i in range(1601, 1751))
assert len(MODULE_SPECS) == 150
assert len({v["operation"] for v in MODULE_SPECS.values()}) == 150
assert len({v["source_module"] for v in MODULE_SPECS.values()}) == 150
mapping = source_to_target_map()
assert mapping["M1601"] == "M601"
assert mapping["M1700"] == "M700"
assert mapping["M1701"] == "M701"
assert mapping["M1725"] == "M725"
assert mapping["M1726"] == "M726"
assert mapping["M1750"] == "M750"
print("exact implemented batch: M1601-M1750 -> M601-M750")
PY

echo "[5/6] Reject fabricated providers/placeholders and client coupling in executable/test code"
if grep -RInE 'tusitio\.com|example\.com|SEO Avengers Suite|google_kg_mock|apps/cano-penal|delivery/cano-penal|authority_drainer|search_volume_emulat' \
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
