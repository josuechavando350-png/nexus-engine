#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TMP="$(mktemp -d)"
PY_PID=""
GO_PID=""
cleanup() {
  [[ -n "$GO_PID" ]] && kill "$GO_PID" 2>/dev/null || true
  [[ -n "$PY_PID" ]] && kill "$PY_PID" 2>/dev/null || true
  rm -rf "$TMP"
}
trap cleanup EXIT

need() { command -v "$1" >/dev/null 2>&1 || { echo "missing required command: $1" >&2; exit 2; }; }
need python
need node
need go
need curl

mkdir -p "$TMP/apps/nexus-bot-studio"
cat > "$TMP/apps/nexus-bot-studio/package.json" <<'JSON'
{
  "name":"@nexus/nexus-bot-studio",
  "nexus":{
    "clientProject":true,
    "siteId":"nexus-bot-studio",
    "canonicalOrigin":"https://nexusbotstudio.com",
    "CONFIG_SEO_AVENGERS_200":true
  }
}
JSON

export SEMANTIC_TEST_STUB=1
export SEMANTIC_SHARED_SECRET=local-semantic-secret
export NEXUS_SEO_VECTOR_DB="$TMP/nexus.sqlite3"
export NEXUS_SEO_VECTOR_EDGE_PUBLISH_URL=""
export REDIS_URL=""
PYTHONPATH="$ROOT/packages/Semantic-Python-NLP" \
  python -m uvicorn main:app --app-dir "$ROOT/packages/Semantic-Python-NLP" --host 127.0.0.1 --port 8000 >"$TMP/python.log" 2>&1 &
PY_PID=$!

for _ in $(seq 1 80); do
  curl -fsS http://127.0.0.1:8000/healthz >/dev/null 2>&1 && break
  sleep 0.1
done
if ! curl -fsS http://127.0.0.1:8000/healthz >/dev/null; then
  cat "$TMP/python.log" >&2
  exit 1
fi

export NEXUS_COMMANDER_ADDR=127.0.0.1:8788
export SEMANTIC_SERVICE_URL=http://127.0.0.1:8000
export NEXUS_SEO_OUTBOX_DIR="$TMP/.artifacts/seo-avengers-200/outbox"
# Build a disposable Commander binary so cleanup owns the actual server PID;
# `go run` would otherwise leave its compiled child alive after the shell exits.
(cd "$ROOT" && go build -o "$TMP/seo-avengers-commander" ./apps/nexus-commander-dashboard)
"$TMP/seo-avengers-commander" >"$TMP/commander.log" 2>&1 &
GO_PID=$!
for _ in $(seq 1 80); do
  curl -fsS http://127.0.0.1:8788/healthz >/dev/null 2>&1 && break
  sleep 0.1
done
if ! curl -fsS http://127.0.0.1:8788/healthz >/dev/null; then
  cat "$TMP/commander.log" >&2
  exit 1
fi

OUTBOX_MODULE="$ROOT/scripts/seo-avengers-200-outbox.mjs" TMP_ROOT="$TMP" node --input-type=module <<'NODE'
import { pathToFileURL } from "node:url";
const { enqueueSeoAvengersSection } = await import(pathToFileURL(process.env.OUTBOX_MODULE).href);
const result = await enqueueSeoAvengersSection({
  projectDir: `${process.env.TMP_ROOT}/apps/nexus-bot-studio`,
  route: "/",
  sectionId: "hero",
  locale: "es-MX",
  text: "Nexus Bot Studio crea agentes de inteligencia artificial y sitios web de alto rendimiento.",
  keyword: "agentes de IA",
  sourceRevision: "abcdef1234567890"
});
if (result.status !== "QUEUED") throw new Error(JSON.stringify(result));
console.log(result.inputHash);
NODE

for _ in $(seq 1 120); do
  if python - "$TMP/nexus.sqlite3" <<'PY'
import sqlite3, sys
try:
    db=sqlite3.connect(sys.argv[1])
    row=db.execute("select count(*) from seo_vectors where site_id='nexus-bot-studio' and route='/' and section_id='hero'").fetchone()
    raise SystemExit(0 if row and row[0] == 1 else 1)
except sqlite3.Error:
    raise SystemExit(1)
PY
  then break; fi
  sleep 0.1
done

python - "$TMP/nexus.sqlite3" <<'PY'
import json, sqlite3, sys
con=sqlite3.connect(sys.argv[1])
row=con.execute("select site_id,route,section_id,input_hash,output_hash,vector_profile_json,module_evidence_json from seo_vectors").fetchone()
assert row and row[0:3] == ('nexus-bot-studio','/','hero'), row
assert row[3].startswith('sha256:') and row[4].startswith('sha256:'), row
profile=json.loads(row[5]); evidence=json.loads(row[6])
assert profile['model']=='nexus-feature-hash-v1', profile
assert len(evidence)==58, len(evidence)
assert all(k in evidence for k in ['M51','M100','M151','M158'])
print('outbox -> Go -> Python -> seo_vectors + NLP/vector evidence: PASS')
PY

node --experimental-strip-types "$ROOT/scripts/test-edge-gateway.mjs"
node --experimental-strip-types "$ROOT/scripts/test-external-reverse-proxy.mjs"

curl -fsS -X POST http://127.0.0.1:8788/rpc \
  -H 'content-type: application/json' \
  --data '{"jsonrpc":"2.0","id":1,"method":"seo.client.activation","params":{"site_id":"nexus-bot-studio","enabled":true}}' \
  > "$TMP/activation.json"
python - "$TMP/activation.json" <<'PY'
import json, sys
r=json.load(open(sys.argv[1]))
mods=r['result']['modules']
assert r['result']['enabled'] is True and r['result']['module_count'] == 200 and len(mods)==200
assert [m['id'] for m in mods] == list(range(1,201))
assert all(m['state'] in {'ON','GATED','ADVISORY'} for m in mods)
print('200/200 module contracts switched through Commander: PASS')
PY

curl -fsS -X POST http://127.0.0.1:8788/rpc \
  -H 'content-type: application/json' \
  --data '{"jsonrpc":"2.0","id":2,"method":"seo.suite200.dispatch","params":{"site_id":"nexus-bot-studio","enabled":true,"source_revision":"abcdef1234567890","input_hash":"sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","payload":{"route":"/","content_digest":"sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"}}}' \
  > "$TMP/dispatch.json"
python - "$TMP/dispatch.json" "$TMP/status-request.json" <<'PY'
import json, sys
r=json.load(open(sys.argv[1]))
receipt=r['result']
assert receipt['submitted']==200 and receipt['bypassed'] is False, receipt
job_ids=list(receipt['job_ids'].values())
assert len(job_ids)==200 and len(set(job_ids))==200
request={"jsonrpc":"2.0","id":3,"method":"seo.suite200.status","params":{"job_ids":job_ids}}
json.dump(request,open(sys.argv[2],'w'))
PY

for _ in $(seq 1 160); do
  curl -fsS -X POST http://127.0.0.1:8788/rpc -H 'content-type: application/json' --data-binary @"$TMP/status-request.json" > "$TMP/status.json"
  if python - "$TMP/status.json" <<'PY'
import json,sys
r=json.load(open(sys.argv[1]))['result']
raise SystemExit(0 if r['complete']==200 else 1)
PY
  then break; fi
  sleep 0.05
done
python - "$TMP/status.json" <<'PY'
import json,sys
r=json.load(open(sys.argv[1]))['result']
assert r['submitted']==200 and r['complete']==200 and r['failed']==0, r
print('200 simultaneous async contract jobs completed with deterministic evidence: PASS')
PY

echo "LOCAL MIRROR SEO AVENGERS 200: PASS"
