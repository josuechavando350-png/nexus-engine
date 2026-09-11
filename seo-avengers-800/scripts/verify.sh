#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

echo "[1/6] Verify existing audited M001-M600 runtime"
bash seo-avengers-600/scripts/verify.sh

echo "[2/6] Compile implemented M701-M750 slices"
python -m py_compile \
  seo-avengers-800/runtime/common.py \
  seo-avengers-800/runtime/manifest.py \
  seo-avengers-800/runtime/semantic_bayes.py \
  seo-avengers-800/runtime/html_streaming.py \
  seo-avengers-800/runtime/runner.py \
  seo-avengers-800/tests/fixture.py \
  seo-avengers-800/tests/test_semantic_bayes.py \
  seo-avengers-800/tests/test_html_streaming.py

echo "[3/6] Run implemented regression suites"
(
  cd seo-avengers-800
  python -m unittest discover -s tests -p 'test_*.py' -v
)

echo "[4/6] Prove exact M1701-M1750 -> M701-M750 mapping"
PYTHONPATH=seo-avengers-800 python - <<'PY'
from runtime.manifest import (
    HTML_SOURCE_MODULES,
    HTML_TARGET_MODULES,
    MODULE_SPECS,
    SEMANTIC_SOURCE_MODULES,
    SEMANTIC_TARGET_MODULES,
    SOURCE_MODULES,
    TARGET_MODULES,
    source_to_target_map,
)

assert SEMANTIC_TARGET_MODULES == tuple(f"M{i}" for i in range(701, 726))
assert SEMANTIC_SOURCE_MODULES == tuple(f"M{i}" for i in range(1701, 1726))
assert HTML_TARGET_MODULES == tuple(f"M{i}" for i in range(726, 751))
assert HTML_SOURCE_MODULES == tuple(f"M{i}" for i in range(1726, 1751))
assert TARGET_MODULES == tuple(f"M{i}" for i in range(701, 751))
assert SOURCE_MODULES == tuple(f"M{i}" for i in range(1701, 1751))
assert len(MODULE_SPECS) == 50
assert len({v["operation"] for v in MODULE_SPECS.values()}) == 50
mapping = source_to_target_map()
assert mapping["M1701"] == "M701"
assert mapping["M1725"] == "M725"
assert mapping["M1726"] == "M726"
assert mapping["M1750"] == "M750"
print("exact implemented slices: M1701-M1750 -> M701-M750")
PY

echo "[5/6] Reject fabricated providers/placeholders and client coupling in executable/test code"
if grep -RInE 'tusitio\.com|example\.com|SEO Avengers Suite|google_kg_mock|apps/cano-penal|delivery/cano-penal' \
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
