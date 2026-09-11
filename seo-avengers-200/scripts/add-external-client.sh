#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
JSON="$ROOT/apps/seo-avengers-reverse-proxy/external-clients.json"

usage() {
  cat >&2 <<'EOF'
usage: ./scripts/add-external-client.sh <client_id> <incoming_domain> <target_origin> [true|false] [--no-deploy]
example: ./scripts/add-external-client.sh despacho-acme https://acme.com https://origin.acme-host.com true
EOF
  exit 2
}

[[ $# -ge 3 && $# -le 5 ]] || usage
CLIENT_ID="$1"
INCOMING="$2"
TARGET="$3"
ENABLED="${4:-true}"
NO_DEPLOY="${5:-}"
[[ "$ENABLED" == "true" || "$ENABLED" == "false" ]] || { echo "enabled must be true or false" >&2; exit 2; }
[[ "$NO_DEPLOY" == "" || "$NO_DEPLOY" == "--no-deploy" ]] || usage

python3 - "$JSON" "$CLIENT_ID" "$INCOMING" "$TARGET" "$ENABLED" <<'PY'
import json, os, re, sys, tempfile
from urllib.parse import urlparse
path, client_id, incoming, target, enabled = sys.argv[1:]
if not re.fullmatch(r"[a-z0-9][a-z0-9-]{0,79}", client_id):
    raise SystemExit("invalid client_id")

def origin(value: str, label: str) -> str:
    value=value.strip()
    if value.startswith('://'):
        value='https'+value
    elif '://' not in value:
        value='https://'+value
    u=urlparse(value)
    if u.scheme != 'https' or not u.hostname or u.username or u.password or (u.path not in ('','/')) or u.query or u.fragment:
        raise SystemExit(f"{label} must be an HTTPS origin with no path/query/credentials")
    port=f":{u.port}" if u.port else ""
    return f"https://{u.hostname.lower()}{port}"

incoming=origin(incoming, 'incoming_domain')
target=origin(target, 'target_origin')
try:
    data=json.load(open(path, encoding='utf-8'))
except FileNotFoundError:
    data=[]
if not isinstance(data, list):
    raise SystemExit('external-clients.json must contain an array')
record={
    'client_id': client_id,
    'incoming_domain': incoming,
    'target_origin': target,
    'CONFIG_SEO_AVENGERS_200': enabled == 'true',
}
replaced=False
for i,item in enumerate(data):
    if isinstance(item,dict) and item.get('client_id') == client_id:
        data[i]=record; replaced=True; break
if not replaced:
    data.append(record)
# Reject two client IDs owning the same inbound host.
hosts={}
for item in data:
    host=urlparse(origin(item.get('incoming_domain',''), 'incoming_domain')).netloc.lower()
    if host in hosts and hosts[host] != item.get('client_id'):
        raise SystemExit(f"incoming domain {host} already belongs to {hosts[host]}")
    hosts[host]=item.get('client_id')
data.sort(key=lambda x: x['client_id'])
fd,tmp=tempfile.mkstemp(prefix='.external-clients.', suffix='.json', dir=os.path.dirname(path))
try:
    with os.fdopen(fd,'w',encoding='utf-8') as f:
        json.dump(data,f,ensure_ascii=False,indent=2); f.write('\n'); f.flush(); os.fsync(f.fileno())
    os.replace(tmp,path)
finally:
    if os.path.exists(tmp): os.unlink(tmp)
print(('updated' if replaced else 'added') + f" {client_id}: {incoming} -> {target}, enabled={enabled}")
PY

if [[ "$NO_DEPLOY" != "--no-deploy" ]]; then
  exec "$ROOT/scripts/deploy-external-proxy.sh"
fi
