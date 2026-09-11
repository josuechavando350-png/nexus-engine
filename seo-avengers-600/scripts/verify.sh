#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

echo '[1/6] Existing Avengers 400 verifier'
bash seo-avengers-400/scripts/verify.sh

echo '[2/6] Avengers 600 Python syntax'
python -m py_compile seo-avengers-600/runtime/*.py seo-avengers-600/tests/*.py

echo '[3/6] Avengers 600 exact-suite tests'
(
  cd seo-avengers-600
  PYTHONPATH=. python -m unittest discover -s tests -p 'test_*.py' -v
)

echo '[4/6] Exact 600-module composition invariant'
PYTHONPATH=seo-avengers-600 python - <<'PY'
from runtime.catalog import module_registry
from runtime.manifest import MODULE_SPECS, source_to_target_map
r=module_registry()
assert list(r)==[f'M{i}' for i in range(1,601)]
assert len(r)==600 and 'M601' not in r
assert all(r[f'M{i}']['status']=='DELEGATED_PRODUCTION' and not r[f'M{i}']['executable_here'] for i in range(1,401))
assert all(r[f'M{i}']['status']=='IMPLEMENTED_PRODUCTION' and r[f'M{i}']['executable_here'] for i in range(401,601))
assert len(MODULE_SPECS)==200
assert len({s['operation'] for s in MODULE_SPECS.values()})==200
assert source_to_target_map()=={f'M{1401+i}':f'M{401+i}' for i in range(200)}
print('M001-M400 delegated audited runtime + M401-M600 new = exactly 600')
PY

echo '[5/6] No fake provider wiring or forbidden client coupling'
if grep -R -nE 'apps/cano-penal|delivery/cano-penal|google_kg_mock|tusitio\.com|SEO Avengers Suite' \
  seo-avengers-600/runtime seo-avengers-600/tests seo-avengers-600/README.md \
  --exclude-dir=__pycache__; then
  echo 'forbidden placeholder/client coupling detected' >&2
  exit 1
fi

echo '[6/6] Runtime source has no float literals or wall-clock timing'
if grep -R -nE 'time\.time|perf_counter|[0-9]+\.[0-9]+' seo-avengers-600/runtime --exclude-dir=__pycache__; then
  echo 'non-deterministic timing or float literal detected in runtime' >&2
  exit 1
fi

echo 'SEO Avengers 600 verification complete.'
