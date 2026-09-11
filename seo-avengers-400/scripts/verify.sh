#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

echo '[1/5] Original Avengers M001-M200 verification'
bash seo-avengers-200/scripts/verify.sh

echo '[2/5] Avengers 400 Python syntax'
python -m py_compile seo-avengers-400/runtime/*.py seo-avengers-400/tests/*.py

echo '[3/5] Avengers 400 exact-suite tests'
(
  cd seo-avengers-400
  python -m unittest discover -s tests -p 'test_*.py' -v
)

echo '[4/5] Exact 400-module composition invariant'
PYTHONPATH=seo-avengers-400 python - <<'PY'
from runtime.catalog import module_registry
from runtime.mass_lot_runtime_manifest import RUNTIME_MASS_LOT_SPECS, runtime_source_to_target_map
r=module_registry()
assert list(r)==[f'M{i}' for i in range(1,401)]
assert len(r)==400 and 'M401' not in r
assert all(r[f'M{i}']['status']=='DELEGATED_PRODUCTION' and not r[f'M{i}']['executable_here'] for i in range(1,201))
assert all(r[f'M{i}']['status']=='IMPLEMENTED_PRODUCTION' and r[f'M{i}']['executable_here'] for i in range(201,401))
assert set(RUNTIME_MASS_LOT_SPECS)=={f'M{i}' for i in range(201,401)}
assert runtime_source_to_target_map()=={f'M{1201+i}':f'M{201+i}' for i in range(200)}
print('M001-M200 original sidecar + M201-M400 new source-bound algorithms = exactly 400')
PY

echo '[5/5] Isolation invariant'
if grep -R -nE 'apps/cano-penal|delivery/cano-penal' seo-avengers-400 --exclude-dir=__pycache__; then
  echo 'seo-avengers-400 must not depend on cano-penal paths' >&2
  exit 1
fi

echo 'SEO Avengers 400 verification complete.'
