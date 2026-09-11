#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

echo '[1/5] Original Avengers M001-M200 catalog/source parity'
python - <<'PY'
import json
from pathlib import Path
base=Path('seo-avengers-200')
catalog=json.loads((base/'packages/Core-Go-Backend/module-catalog.json').read_text())
source=json.loads((base/'contracts/SEO_Avengers_200_Pure_Engine.source.json').read_text())
contracts=source['Module_Catalog_Contracts']['modules']
assert len(catalog)==200
assert [x['id'] for x in catalog]==list(range(1,201))
assert len(contracts)==200
by_id={int(x['id']):x for x in contracts}
assert set(by_id)==set(range(1,201))
for item in catalog:
    assert int(item['id']) in by_id
print('original seo-avengers-200 preserves exact M001-M200 catalog/source contract')
PY

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
