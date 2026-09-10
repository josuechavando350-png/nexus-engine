#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DRY_RUN="${DRY_RUN:-0}"
SKIP_BUILD="${SKIP_BUILD:-0}"
DEPLOY_CLOUDFLARE="${DEPLOY_CLOUDFLARE:-1}"
JSON="$ROOT/apps/seo-avengers-reverse-proxy/external-clients.json"
ACTIVE_COUNT="$(python3 - "$JSON" <<'PY'
import json,sys
d=json.load(open(sys.argv[1],encoding='utf-8'))
print(sum(1 for x in d if isinstance(x,dict) and x.get('CONFIG_SEO_AVENGERS_200') is True))
PY
)"

if [[ "$DRY_RUN" == "1" ]]; then
  if (( ACTIVE_COUNT > 0 )); then SEO_AVENGERS_KV_ID="${SEO_AVENGERS_KV_ID:-dry-run-kv}" node "$ROOT/scripts/generate-external-wrangler.mjs"; else node "$ROOT/scripts/generate-external-wrangler.mjs"; fi
  echo "DRY_RUN=1: generated external routes; no build/deploy"
  exit 0
fi

if (( ACTIVE_COUNT > 0 )) && [[ "$SKIP_BUILD" != "1" ]]; then
  command -v cargo >/dev/null 2>&1 || { echo "cargo is required" >&2; exit 3; }
  if command -v rustup >/dev/null 2>&1; then rustup target add wasm32-unknown-unknown >/dev/null; fi
  (cd "$ROOT" && cargo build --release --target wasm32-unknown-unknown -p seo-avengers-edge)
fi

[[ "$DEPLOY_CLOUDFLARE" == "1" ]] || { echo "external proxy config updated; Cloudflare deployment skipped"; exit 0; }
command -v npx >/dev/null 2>&1 || { echo "npx is required" >&2; exit 3; }

if (( ACTIVE_COUNT > 0 )); then
  [[ -n "${SEO_AVENGERS_KV_ID:-}" ]] || { echo "SEO_AVENGERS_KV_ID is required while external tenants are active" >&2; exit 4; }
  if [[ "${SKIP_TRANSFORMER_DEPLOY:-0}" != "1" ]]; then
    (cd "$ROOT/apps/edge-cloudflare-worker" && npx wrangler deploy)
  fi
  node "$ROOT/scripts/generate-external-wrangler.mjs"
else
  # Strong OFF state: generated config has zero routes, workers_dev=false,
  # no KV namespace and no transformer Service Binding.
  node "$ROOT/scripts/generate-external-wrangler.mjs"
fi

(cd "$ROOT/apps/seo-avengers-reverse-proxy" && npx wrangler deploy --config wrangler.generated.jsonc)
if (( ACTIVE_COUNT > 0 )); then
  if [[ -n "${NEXUS_SEO_EDGE_PUBLISH_TOKEN:-}" ]]; then
    printf '%s' "$NEXUS_SEO_EDGE_PUBLISH_TOKEN" | (cd "$ROOT/apps/seo-avengers-reverse-proxy" && npx wrangler secret put NEXUS_SEO_EDGE_PUBLISH_TOKEN --config wrangler.generated.jsonc)
  else
    echo "warning: NEXUS_SEO_EDGE_PUBLISH_TOKEN is unset; vector publishing will reject writes" >&2
  fi
fi
