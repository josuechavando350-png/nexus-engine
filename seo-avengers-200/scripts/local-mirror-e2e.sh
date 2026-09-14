#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TMP="$(mktemp -d)"
PY_PID=""
GO_PID=""
SITE_ID="${WALLE_M200_SITE_ID:-walle-proof-probe}"
SOURCE_REVISION="${WALLE_SOURCE_REVISION:-abcdef1234567890}"
EVIDENCE_OUTPUT="${WALLE_M200_EVIDENCE_OUTPUT:-}"
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

if [[ ! "$SITE_ID" =~ ^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$ ]]; then
  echo "invalid controlled site id" >&2
  exit 2
fi
if [[ ! "$SOURCE_REVISION" =~ ^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$ ]]; then
  echo "invalid source revision" >&2
  exit 2
fi
if [[ -n "$EVIDENCE_OUTPUT" ]]; then
  case "$EVIDENCE_OUTPUT" in
    "$ROOT"|"$ROOT"/*)
      echo "M001-M200 evidence output must be outside the source tree" >&2
      exit 2
      ;;
  esac
fi

PROJECT_DIR="$TMP/apps/$SITE_ID"
mkdir -p "$PROJECT_DIR"
cat > "$PROJECT_DIR/package.json" <<JSON
{
  "name":"@nexus/$SITE_ID",
  "nexus":{
    "clientProject":true,
    "siteId":"$SITE_ID",
    "canonicalOrigin":"https://walle-proof.invalid",
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

OUTBOX_MODULE="$ROOT/scripts/seo-avengers-200-outbox.mjs" TMP_ROOT="$TMP" PROJECT_DIR="$PROJECT_DIR" SOURCE_REVISION="$SOURCE_REVISION" node --input-type=module <<'NODE'
import { pathToFileURL } from "node:url";
const { enqueueSeoAvengersSection } = await import(pathToFileURL(process.env.OUTBOX_MODULE).href);
const result = await enqueueSeoAvengersSection({
  projectDir: process.env.PROJECT_DIR,
  route: "/",
  sectionId: "hero",
  locale: "es-MX",
  text: "Walle controlled SEO Avengers proof input.",
  keyword: "controlled proof",
  sourceRevision: process.env.SOURCE_REVISION
});
if (result.status !== "QUEUED") throw new Error(JSON.stringify(result));
console.log(result.inputHash);
NODE

for _ in $(seq 1 120); do
  if python - "$TMP/nexus.sqlite3" "$SITE_ID" <<'PY'
import sqlite3, sys
try:
    db=sqlite3.connect(sys.argv[1])
    row=db.execute("select count(*) from seo_vectors where site_id=? and route='/' and section_id='hero'", (sys.argv[2],)).fetchone()
    raise SystemExit(0 if row and row[0] == 1 else 1)
except sqlite3.Error:
    raise SystemExit(1)
PY
  then break; fi
  sleep 0.1
done

python - "$TMP/nexus.sqlite3" "$SITE_ID" <<'PY'
import json, sqlite3, sys
con=sqlite3.connect(sys.argv[1])
row=con.execute("select site_id,route,section_id,input_hash,output_hash,vector_profile_json,module_evidence_json from seo_vectors where site_id=?", (sys.argv[2],)).fetchone()
assert row and row[0:3] == (sys.argv[2],'/', 'hero'), row
assert row[3].startswith('sha256:') and row[4].startswith('sha256:'), row
profile=json.loads(row[5]); evidence=json.loads(row[6])
assert profile['model']=='nexus-feature-hash-v1', profile
assert len(evidence)==58, len(evidence)
assert all(k in evidence for k in ['M51','M100','M151','M158'])
print('outbox -> Go -> Python -> seo_vectors + NLP/vector evidence: PASS')
PY

node --experimental-strip-types "$ROOT/scripts/test-edge-gateway.mjs"
node --experimental-strip-types "$ROOT/scripts/test-external-reverse-proxy.mjs"

python - "$TMP/activation-request.json" "$SITE_ID" <<'PY'
import json, sys
json.dump({"jsonrpc":"2.0","id":1,"method":"seo.client.activation","params":{"site_id":sys.argv[2],"enabled":True}}, open(sys.argv[1], 'w'))
PY
curl -fsS -X POST http://127.0.0.1:8788/rpc \
  -H 'content-type: application/json' \
  --data-binary @"$TMP/activation-request.json" \
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

python - "$TMP/dispatch-request.json" "$SITE_ID" "$SOURCE_REVISION" <<'PY'
import json, sys
request={
  "jsonrpc":"2.0","id":2,"method":"seo.suite200.dispatch",
  "params":{
    "site_id":sys.argv[2],"enabled":True,"source_revision":sys.argv[3],
    "input_hash":"sha256:" + "a"*64,
    "payload":{"route":"/","content_digest":"sha256:" + "b"*64}
  }
}
json.dump(request, open(sys.argv[1], 'w'))
PY
curl -fsS -X POST http://127.0.0.1:8788/rpc \
  -H 'content-type: application/json' \
  --data-binary @"$TMP/dispatch-request.json" \
  > "$TMP/dispatch.json"
python - "$TMP/dispatch.json" "$TMP/status-request.json" <<'PY'
import json, sys
r=json.load(open(sys.argv[1]))
receipt=r['result']
assert receipt['submitted']==200 and receipt['bypassed'] is False, receipt
assert set(map(int, receipt['job_ids'])) == set(range(1,201)), receipt['job_ids']
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

if [[ -n "$EVIDENCE_OUTPUT" ]]; then
  mkdir -p "$TMP/job-results"
  python - "$TMP/dispatch.json" "$TMP/job-requests" <<'PY'
import json, pathlib, sys
receipt=json.load(open(sys.argv[1]))['result']
out=pathlib.Path(sys.argv[2]); out.mkdir(parents=True, exist_ok=True)
for raw_id, job_id in sorted(receipt['job_ids'].items(), key=lambda item:int(item[0])):
    module_id=int(raw_id)
    request={"jsonrpc":"2.0","id":1000+module_id,"method":"seo.job.get","params":{"job_id":job_id}}
    (out/f"{module_id:03d}.json").write_text(json.dumps(request,separators=(',',':')), encoding='utf-8')
PY
  for module_id in $(seq 1 200); do
    curl -fsS -X POST http://127.0.0.1:8788/rpc \
      -H 'content-type: application/json' \
      --data-binary @"$TMP/job-requests/$(printf '%03d' "$module_id").json" \
      > "$TMP/job-results/$(printf '%03d' "$module_id").json"
  done
  python - "$TMP/dispatch.json" "$TMP/job-results" "$EVIDENCE_OUTPUT" "$SOURCE_REVISION" <<'PY'
import json, pathlib, re, sys
sha_re=re.compile(r'^sha256:[0-9a-f]{64}$')
dispatch=json.load(open(sys.argv[1]))['result']
job_root=pathlib.Path(sys.argv[2])
out_path=pathlib.Path(sys.argv[3])
source_revision=sys.argv[4]
receipts={}
for module_id in range(1,201):
    response=json.loads((job_root/f"{module_id:03d}.json").read_text(encoding='utf-8'))
    result=response.get('result') or {}
    assert result.get('status') == 'complete', (module_id, response)
    job=result.get('job') or {}
    expected_job_id=dispatch['job_ids'][str(module_id)]
    assert job.get('job_id') == expected_job_id, (module_id, job)
    assert job.get('module_id') == module_id, (module_id, job)
    assert not job.get('error'), (module_id, job.get('error'))
    assert sha_re.fullmatch(str(job.get('output_hash',''))), (module_id, job.get('output_hash'))
    evidence=job.get('payload')
    assert isinstance(evidence, dict), (module_id, evidence)
    assert evidence.get('module_id') == module_id, (module_id, evidence)
    assert evidence.get('source_revision') == source_revision, (module_id, evidence)
    assert sha_re.fullmatch(str(evidence.get('evidence_hash',''))), (module_id, evidence.get('evidence_hash'))
    receipts[f'M{module_id}']={
      'job_id':job['job_id'],
      'module_id':module_id,
      'output_hash':job['output_hash'],
      'error':job.get('error',''),
      'evidence':evidence,
    }
assert len(receipts)==200 and set(receipts)=={f'M{i}' for i in range(1,201)}
out={
  'schema_version':1,
  'source_revision':source_revision,
  'receipt_count':200,
  'receipts':receipts,
}
out_path.parent.mkdir(parents=True, exist_ok=True)
out_path.write_text(json.dumps(out,sort_keys=True,separators=(',',':'))+'\n', encoding='utf-8')
print(f'exported 200 module receipts to {out_path}')
PY
fi

echo "LOCAL MIRROR SEO AVENGERS 200: PASS"
