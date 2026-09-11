#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SITE_ID="${1:-}"
[[ "$SITE_ID" =~ ^[a-z0-9][a-z0-9-]{0,79}$ ]] || { echo "usage: ./scripts/disable-capability.sh <site_id>" >&2; exit 2; }
EXTERNAL_JSON="$ROOT/apps/seo-avengers-reverse-proxy/external-clients.json"
DRY_RUN="${DRY_RUN:-0}"
DEPLOY_CLOUDFLARE="${DEPLOY_CLOUDFLARE:-1}"

if python3 - "$EXTERNAL_JSON" "$SITE_ID" <<'PY'
import json,sys
try: d=json.load(open(sys.argv[1],encoding='utf-8'))
except FileNotFoundError: raise SystemExit(1)
raise SystemExit(0 if any(isinstance(x,dict) and x.get('client_id')==sys.argv[2] for x in d) else 1)
PY
then
  python3 - "$EXTERNAL_JSON" "$SITE_ID" <<'PY'
import json,os,sys,tempfile
p,site=sys.argv[1:]
d=json.load(open(p,encoding='utf-8'))
for x in d:
    if isinstance(x,dict) and x.get('client_id')==site:
        x['CONFIG_SEO_AVENGERS_200']=False
fd,tmp=tempfile.mkstemp(prefix='.external-clients.',suffix='.json',dir=os.path.dirname(p))
try:
    with os.fdopen(fd,'w',encoding='utf-8') as f:
        json.dump(d,f,ensure_ascii=False,indent=2); f.write('\n'); f.flush(); os.fsync(f.fileno())
    os.replace(tmp,p)
finally:
    if os.path.exists(tmp): os.unlink(tmp)
PY
  echo "disabled external tenant $SITE_ID"
  if [[ "$DRY_RUN" == "1" ]]; then
    SEO_AVENGERS_KV_ID="${SEO_AVENGERS_KV_ID:-dry-run-kv}" node "$ROOT/scripts/generate-external-wrangler.mjs" >/dev/null
    echo "DRY_RUN=1: no Cloudflare change"
  elif [[ "$DEPLOY_CLOUDFLARE" == "1" ]]; then
    SKIP_BUILD=1 "$ROOT/scripts/deploy-external-proxy.sh"
  fi
  exit 0
fi

ENGINE="${NEXUS_ENGINE_ROOT:-}"
MANIFEST="${NEXUS_TENANT_MANIFEST:-}"
if [[ -z "$MANIFEST" ]]; then
  [[ -n "$ENGINE" ]] || { echo "NEXUS_ENGINE_ROOT or NEXUS_TENANT_MANIFEST is required for native Nexus tenants" >&2; exit 2; }
  MANIFEST="$ENGINE/apps/$SITE_ID/package.json"
fi
[[ -f "$MANIFEST" ]] || { echo "tenant not found: $SITE_ID" >&2; exit 2; }
python3 - "$MANIFEST" <<'PY'
import json,os,sys,tempfile
p=sys.argv[1]
d=json.load(open(p,encoding='utf-8'))
n=d.get('nexus') if isinstance(d.get('nexus'),dict) else {}
n['CONFIG_SEO_AVENGERS_200']=False
d['nexus']=n
fd,tmp=tempfile.mkstemp(prefix='.package.',suffix='.json',dir=os.path.dirname(p))
try:
    with os.fdopen(fd,'w',encoding='utf-8') as f:
        json.dump(d,f,ensure_ascii=False,indent=2); f.write('\n'); f.flush(); os.fsync(f.fileno())
    os.replace(tmp,p)
finally:
    if os.path.exists(tmp): os.unlink(tmp)
PY
echo "disabled native tenant $SITE_ID"
if [[ "$DRY_RUN" == "1" ]]; then
  echo "DRY_RUN=1: no Cloudflare change"
  exit 0
fi
if [[ "$DEPLOY_CLOUDFLARE" == "1" ]]; then
  command -v npx >/dev/null 2>&1 || { echo "npx is required" >&2; exit 3; }
  CONFIG_PATH="$(NEXUS_TENANT_MANIFEST="${NEXUS_TENANT_MANIFEST:-}" node "$ROOT/scripts/generate-native-gateway.mjs" "$SITE_ID" "$ENGINE")"
  (cd "$ROOT/apps/edge-cloudflare-gateway" && npx wrangler deploy --config "$CONFIG_PATH")
fi
