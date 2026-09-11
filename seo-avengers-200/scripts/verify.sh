#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

if command -v go >/dev/null 2>&1; then
  echo "[1/12] Go tests"
  GOTOOLCHAIN=local go test ./packages/Core-Go-Backend/... ./apps/nexus-commander-dashboard/...
else
  echo "[1/12] SKIP Go: toolchain not installed"
fi

echo "[2/12] Python syntax"
python3 -m py_compile packages/Semantic-Python-NLP/main.py packages/Semantic-Python-NLP/bert_embeddings.py packages/Semantic-Python-NLP/tests/test_vectors.py

echo "[3/12] Python semantic/vector tests"
if command -v pytest >/dev/null 2>&1; then
  PYTHONPATH="$ROOT/packages/Semantic-Python-NLP" SEMANTIC_TEST_STUB=1 \
    pytest -q packages/Semantic-Python-NLP/tests/test_vectors.py
else
  echo "[3/12] SKIP Python tests: pytest not installed"
fi

if command -v cargo >/dev/null 2>&1; then
  echo "[4/12] Rust format/check"
  cargo fmt --all -- --check
  if command -v rustup >/dev/null 2>&1; then rustup target add wasm32-unknown-unknown >/dev/null; fi
  cargo check --target wasm32-unknown-unknown -p seo-avengers-edge
else
  echo "[4/12] SKIP Rust: cargo not installed"
fi

if command -v tsc >/dev/null 2>&1; then
  echo "[5/12] TypeScript checks"
  tsc -p apps/edge-cloudflare-gateway/tsconfig.json --noEmit
  tsc -p apps/seo-avengers-reverse-proxy/tsconfig.json --noEmit
  STUB="$(mktemp --suffix=.d.ts)"
  trap 'rm -f "$STUB"' EXIT
  cat > "$STUB" <<'TS'
declare module "web-vitals" {
  type M = {name:"CLS"|"INP"|"LCP"|"FCP"|"TTFB";value:number;rating:"good"|"needs-improvement"|"poor";id:string;navigationType:string};
  export const onCLS:(cb:(m:M)=>void)=>void;
  export const onINP:(cb:(m:M)=>void)=>void;
  export const onLCP:(cb:(m:M)=>void)=>void;
  export const onFCP:(cb:(m:M)=>void)=>void;
  export const onTTFB:(cb:(m:M)=>void)=>void;
}
TS
  tsc --noEmit --strict --target ES2022 --module ESNext --moduleResolution Bundler --lib DOM,ES2022 \
    packages/Telemetry-Nexus-Cortex/src/index.ts packages/Telemetry-Nexus-Cortex/src/ingest.ts "$STUB"
else
  echo "[5/12] SKIP TypeScript: tsc not installed"
fi

echo "[6/12] Native outbox lazy bypass creates no artifacts"
node --experimental-strip-types scripts/test-native-outbox-disabled.mjs

echo "[7/12] Engine overlay fail-closed switch"
node engine-overlay/tests/seo-avengers-200-switch.test.mjs

echo "[8/12] Native gateway deny-by-default / 100ms edge fail-open"
node --experimental-strip-types scripts/test-edge-gateway.mjs

echo "[9/12] External reverse proxy lazy-bypass / 4ms edge fail-open"
node --experimental-strip-types scripts/test-external-reverse-proxy.mjs

echo "[10/12] External route generation"
SEO_AVENGERS_KV_ID=verification-kv node scripts/generate-external-wrangler.mjs >/dev/null
python3 - <<'PY'
import json
from pathlib import Path
from urllib.parse import urlparse
clients=json.loads(Path('apps/seo-avengers-reverse-proxy/external-clients.json').read_text())
config=json.loads(Path('apps/seo-avengers-reverse-proxy/wrangler.generated.jsonc').read_text())
expected=[]
for x in clients:
    if x.get('CONFIG_SEO_AVENGERS_200') is True:
        u=x['incoming_domain'].replace('://','https://',1) if x['incoming_domain'].startswith('://') else x['incoming_domain']
        if '://' not in u: u='https://'+u
        p=urlparse(u)
        expected.append(f'{p.scheme}://{p.netloc}/*')
assert config['routes']==expected, (config['routes'], expected)
if not expected:
    assert config['workers_dev'] is False
    assert 'kv_namespaces' not in config
    assert 'services' not in config
print(f'enabled external routes only: {len(expected)}')
PY

echo "[11/12] Catalog cardinality + source-contract parity"
python3 - <<'PY'
import json
from pathlib import Path
catalog=json.loads(Path('packages/Core-Go-Backend/module-catalog.json').read_text())
source=json.loads(Path('contracts/SEO_Avengers_200_Pure_Engine.source.json').read_text())
contracts=source['Module_Catalog_Contracts']['modules']
assert len(catalog)==200, len(catalog)
assert [x['id'] for x in catalog] == list(range(1,201))
assert source['Module_Catalog_Contracts']['global_switch']['CONFIG_SEO_AVENGERS_200'] is False
for item in catalog:
    expected=contracts[f"module_{item['id']:03d}"]
    assert item['request_path_blocking'] is False
    for key in ('request_path_blocking','execution_layer','category','contract_type','fail_safe_status'):
        assert item.get(key)==expected.get(key), (item['id'], key, item.get(key), expected.get(key))
    assert item.get('determinism_contract')
print('200 modules OK; M001-M200 exact source contract metadata preserved')
PY

echo "[12/12] Checked-in activation state is globally OFF"
python3 - <<'PY'
import json
from pathlib import Path
clients=json.loads(Path('apps/seo-avengers-reverse-proxy/external-clients.json').read_text())
assert all(x.get('CONFIG_SEO_AVENGERS_200') is not True for x in clients)
print('no external tenant is enabled in source control; native activation requires explicit per-project true')
PY

echo "Verification complete. Rust requires cargo + wasm32 target for the Rust gate."
