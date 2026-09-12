#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

if [ ! -x seo-avengers-800/scripts/verify.sh ] && [ ! -f seo-avengers-800/scripts/verify.sh ]; then
  echo "required seo-avengers-800 verifier is missing" >&2
  exit 1
fi

echo "[1/7] Verify existing audited M001-M800 runtime"
bash seo-avengers-800/scripts/verify.sh

echo "[2/7] Compile exact M801-M1000 runtime and tests"
python -m py_compile \
  seo-avengers-1000/runtime/*.py \
  seo-avengers-1000/tests/*.py

echo "[3/7] Run exact M801-M1000 regression suites"
(
  cd seo-avengers-1000
  python -m unittest discover -s tests -p 'test_*.py' -v
)

echo "[4/7] Prove exact M1801-M2000 -> M801-M1000 mapping and exact catalog"
PYTHONPATH=seo-avengers-1000 python - <<'PY'
from runtime.catalog import module_registry
from runtime.manifest import MODULE_SPECS, SOURCE_MODULES, TARGET_MODULES, source_to_target_map

expected_targets = tuple(f"M{i}" for i in range(801, 1001))
expected_sources = tuple(f"M{i}" for i in range(1801, 2001))
if TARGET_MODULES != expected_targets:
    raise RuntimeError("target range drift")
if SOURCE_MODULES != expected_sources:
    raise RuntimeError("source range drift")
if tuple(MODULE_SPECS) != expected_targets:
    raise RuntimeError("manifest ordering drift")
if len(MODULE_SPECS) != 200:
    raise RuntimeError("manifest cardinality drift")
if len({spec["operation"] for spec in MODULE_SPECS.values()}) != 200:
    raise RuntimeError("operation collision")
mapping = source_to_target_map()
for source in expected_sources:
    if mapping[source] != f"M{int(source[1:]) - 1000}":
        raise RuntimeError(f"source map drift:{source}")
registry = module_registry()
if tuple(registry) != tuple(f"M{i}" for i in range(1, 1001)):
    raise RuntimeError("catalog range drift")
if "M1001" in registry:
    raise RuntimeError("M1001 forbidden")
for number in range(1, 801):
    entry = registry[f"M{number}"]
    if entry["status"] != "DELEGATED_PRODUCTION":
        raise RuntimeError(f"delegated status drift:M{number}")
    if entry["delegated_runtime"] != "seo-avengers-800":
        raise RuntimeError(f"delegated runtime drift:M{number}")
for number in range(801, 1001):
    if registry[f"M{number}"]["status"] != "IMPLEMENTED_PRODUCTION":
        raise RuntimeError(f"implemented status drift:M{number}")
print("M001-M800 delegated audited runtime + M801-M1000 exact new runtime = exactly 1000")
PY

echo "[5/7] Reject fabricated providers/placeholders/client coupling and side-effect clients"
if grep -RInE 'tusitio\.com|example\.com|PLACEHOLDER|TODO|FIXME|google_kg_mock|search_volume_emulat|authority_drainer|apps/cano-penal|delivery/cano-penal|psycopg|asyncpg|requests\.|urllib\.request|subprocess\.|socket\.|VACUUM|INSERT[[:space:]]+INTO|UPDATE[[:space:]]+[^ ]+[[:space:]]+SET|DELETE[[:space:]]+FROM' \
  seo-avengers-1000/runtime seo-avengers-1000/tests; then
  echo "forbidden fabricated/coupled/side-effect content found" >&2
  exit 1
fi

echo "[6/7] Reject floats, wall clock, randomness, asserts, and runtime side effects"
python - <<'PY'
import ast
from pathlib import Path

for path in Path("seo-avengers-1000/runtime").glob("*.py"):
    tree = ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
    for node in ast.walk(tree):
        if isinstance(node, ast.Constant) and isinstance(node.value, float):
            raise SystemExit(f"float literal forbidden in runtime: {path}:{node.lineno}")
        if isinstance(node, ast.Assert):
            raise SystemExit(f"assert forbidden in fail-closed runtime: {path}:{node.lineno}")
        if isinstance(node, ast.Call):
            func = node.func
            if isinstance(func, ast.Attribute) and isinstance(func.value, ast.Name):
                if func.value.id == "time":
                    raise SystemExit(f"wall-clock call forbidden: {path}:{node.lineno}")
                if func.value.id == "random":
                    raise SystemExit(f"random call forbidden: {path}:{node.lineno}")
            if isinstance(func, ast.Name) and func.id in {"open", "exec", "eval", "__import__"}:
                raise SystemExit(f"runtime side-effect/dynamic call forbidden: {path}:{node.lineno}")
print("runtime deterministic/static checks passed")
PY

echo "[7/7] Prove deny-by-default and exact 200-module execution"
PYTHONPATH=seo-avengers-1000:seo-avengers-1000/tests python - <<'PY'
from fixture import full_payload
from runtime.service import execute_avengers_1000

disabled = execute_avengers_1000(full_payload(), {})
if disabled["executed_new_modules"] != 0 or disabled["receipts"]:
    raise RuntimeError("deny-by-default drift")
enabled = execute_avengers_1000(full_payload(), {"CONFIG_SEO_AVENGERS_1000": True})
if enabled["executed_new_modules"] != 200:
    raise RuntimeError("enabled execution cardinality drift")
if any(receipt["execution_status"] != "SUCCESS" for receipt in enabled["receipts"].values()):
    raise RuntimeError("typed fixture execution drift")
print("deny-by-default and exact 200-module execution verified")
PY

echo "SEO Avengers 1000 verification complete."
