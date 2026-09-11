#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

echo "[1/4] Python syntax"
python3 -m py_compile runtime/__init__.py runtime/seo_avengers_1200.py tests/test_runtime.py

echo "[2/4] Runtime unit/golden tests"
python3 -m unittest discover -s tests -v

echo "[3/4] 1200-slot honesty invariant"
python3 - <<'PY'
from runtime.seo_avengers_1200 import IMPLEMENTED_EXTENDED_MODULES, module_registry
registry = module_registry()
assert len(registry) == 1200
assert list(registry) == [f"M{i}" for i in range(1, 1201)]
assert all(not row["executable_here"] for row in registry.values() if row["status"] == "RESERVED")
assert IMPLEMENTED_EXTENDED_MODULES == frozenset({"M901", "M902", "M1001", "M1002", "M1101", "M1102"})
print("1200 contiguous slots; no reserved slot has an executable handler")
PY

echo "[4/4] Isolation invariant"
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
