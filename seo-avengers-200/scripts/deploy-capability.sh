#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SITE_ID="${1:-}"
[[ "$SITE_ID" =~ ^[a-z0-9][a-z0-9-]{0,79}$ ]] || { echo "usage: ./scripts/deploy-capability.sh <site_id>" >&2; exit 2; }
DRY_RUN="${DRY_RUN:-0}"
SKIP_BUILD="${SKIP_BUILD:-0}"
DEPLOY_CLOUDFLARE="${DEPLOY_CLOUDFLARE:-1}"
EXTERNAL_JSON="$ROOT/apps/seo-avengers-reverse-proxy/external-clients.json"

is_external() {
  python3 - "$EXTERNAL_JSON" "$SITE_ID" <<'PY'
import json,sys
try: data=json.load(open(sys.argv[1],encoding='utf-8'))
except FileNotFoundError: raise SystemExit(1)
raise SystemExit(0 if any(isinstance(x,dict) and x.get('client_id')==sys.argv[2] for x in data) else 1)
PY
}

enable_external_only() {
  python3 - "$EXTERNAL_JSON" "$SITE_ID" <<'PY'
import json,os,sys,tempfile
p,site=sys.argv[1:]
data=json.load(open(p,encoding='utf-8'))
found=False
for item in data:
    if isinstance(item,dict) and item.get('client_id')==site:
        item['CONFIG_SEO_AVENGERS_200']=True; found=True; break
if not found: raise SystemExit(f'external client not found: {site}')
fd,tmp=tempfile.mkstemp(prefix='.external-clients.',suffix='.json',dir=os.path.dirname(p))
try:
    with os.fdopen(fd,'w',encoding='utf-8') as f:
        json.dump(data,f,ensure_ascii=False,indent=2); f.write('\n'); f.flush(); os.fsync(f.fileno())
    os.replace(tmp,p)
finally:
    if os.path.exists(tmp): os.unlink(tmp)
PY
}

enable_native_only() {
  local engine="${NEXUS_ENGINE_ROOT:-}"
  local manifest="${NEXUS_TENANT_MANIFEST:-}"
  if [[ -z "$manifest" ]]; then
    [[ -n "$engine" ]] || { echo "NEXUS_ENGINE_ROOT or NEXUS_TENANT_MANIFEST is required for native Nexus tenants" >&2; exit 2; }
    manifest="$engine/apps/$SITE_ID/package.json"
  fi
  [[ -f "$manifest" ]] || { echo "native tenant manifest not found: $manifest" >&2; exit 2; }
  python3 - "$manifest" "$SITE_ID" "${NEXUS_CANONICAL_ORIGIN:-}" <<'PY'
import json,os,sys,tempfile
p,site,canonical=sys.argv[1:]
data=json.load(open(p,encoding='utf-8'))
nexus=data.get('nexus')
if not isinstance(nexus,dict): nexus={}
# Do not mutate any other tenant or workspace file. This target manifest is the authority.
nexus['CONFIG_SEO_AVENGERS_200']=True
nexus.setdefault('siteId',site)
if canonical:
    from urllib.parse import urlparse
    u=urlparse(canonical)
    if u.scheme!='https' or not u.hostname or (u.path not in ('','/')) or u.query or u.fragment:
        raise SystemExit('NEXUS_CANONICAL_ORIGIN must be an HTTPS origin')
    nexus['canonicalOrigin']=f'https://{u.netloc}'
data['nexus']=nexus
fd,tmp=tempfile.mkstemp(prefix='.package.',suffix='.json',dir=os.path.dirname(p))
try:
    with os.fdopen(fd,'w',encoding='utf-8') as f:
        json.dump(data,f,ensure_ascii=False,indent=2); f.write('\n'); f.flush(); os.fsync(f.fileno())
    os.replace(tmp,p)
finally:
    if os.path.exists(tmp): os.unlink(tmp)
print(f'enabled native tenant {site} in {p}')
PY
}

compile_transformer() {
  [[ "$SKIP_BUILD" == "1" ]] && { echo "SKIP_BUILD=1: skipping wasm compilation"; return; }
  command -v cargo >/dev/null 2>&1 || { echo "cargo is required" >&2; exit 3; }
  if command -v rustup >/dev/null 2>&1; then rustup target add wasm32-unknown-unknown >/dev/null; fi
  (cd "$ROOT" && cargo build --release --target wasm32-unknown-unknown -p seo-avengers-edge)
}

deploy_transformer() {
  [[ "$DEPLOY_CLOUDFLARE" == "1" ]] || return
  command -v npx >/dev/null 2>&1 || { echo "npx is required for Cloudflare deployment" >&2; exit 3; }
  (cd "$ROOT/apps/edge-cloudflare-worker" && npx wrangler deploy)
}

if is_external; then
  MODE=external
  enable_external_only
  echo "tenant=$SITE_ID mode=external CONFIG_SEO_AVENGERS_200=true"
else
  MODE=native
  enable_native_only
  echo "tenant=$SITE_ID mode=native CONFIG_SEO_AVENGERS_200=true"
fi

if [[ "$DRY_RUN" == "1" ]]; then
  echo "DRY_RUN=1: tenant state updated locally; skipping build/deploy"
  exit 0
fi

compile_transformer
deploy_transformer

if [[ "$DEPLOY_CLOUDFLARE" != "1" ]]; then
  echo "DEPLOY_CLOUDFLARE=0: activation + wasm build complete; Cloudflare not changed"
  exit 0
fi

[[ -n "${SEO_AVENGERS_KV_ID:-}" ]] || { echo "SEO_AVENGERS_KV_ID is required for gateway deployment" >&2; exit 4; }

if [[ "$MODE" == "external" ]]; then
  # Transformer is already deployed above; sync the shared reverse proxy without rebuilding it.
  SKIP_BUILD=1 SKIP_TRANSFORMER_DEPLOY=1 "$ROOT/scripts/deploy-external-proxy.sh"
else
  ENGINE="${NEXUS_ENGINE_ROOT:-}"
  CONFIG_PATH="$(SEO_AVENGERS_KV_ID="$SEO_AVENGERS_KV_ID" CLOUDFLARE_ACCOUNT_ID="${CLOUDFLARE_ACCOUNT_ID:-}" NEXUS_TENANT_MANIFEST="${NEXUS_TENANT_MANIFEST:-}" node "$ROOT/scripts/generate-native-gateway.mjs" "$SITE_ID" "$ENGINE")"
  (cd "$ROOT/apps/edge-cloudflare-gateway" && npx wrangler deploy --config "$CONFIG_PATH")
  if [[ -n "${NEXUS_SEO_EDGE_PUBLISH_TOKEN:-}" ]]; then
    printf '%s' "$NEXUS_SEO_EDGE_PUBLISH_TOKEN" | (cd "$ROOT/apps/edge-cloudflare-gateway" && npx wrangler secret put NEXUS_SEO_EDGE_PUBLISH_TOKEN --config "$CONFIG_PATH")
  else
    echo "warning: NEXUS_SEO_EDGE_PUBLISH_TOKEN is unset; vector publishing endpoint will reject all writes" >&2
  fi
fi

echo "SEO AVENGERS 200 deployed for tenant $SITE_ID only. Other tenant flags/routes were not enabled."
