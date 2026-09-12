#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
SUITE="$ROOT/seo-avengers-2500"

bash "$ROOT/seo-avengers-1000/scripts/verify.sh"
python -m compileall -q "$SUITE/runtime" "$SUITE/tests"
(
  cd "$SUITE"
  python -m unittest discover -s tests -v
)
node --check "$SUITE/control-plane/tenant-control.mjs"
node --check "$SUITE/evidence/tenant-evidence.mjs"
node --check "$SUITE/scripts/seo-avengers-2500-control.mjs"
node --test \
  "$SUITE/tests/test_tenant_control.mjs" \
  "$SUITE/tests/test_tenant_control_strict.mjs" \
  "$SUITE/tests/test_tenant_control_paths.mjs" \
  "$SUITE/tests/test_tenant_evidence.mjs" \
  "$SUITE/tests/test_tenant_evidence_readonly.mjs"
python - <<'PY' "$SUITE"
import ast, pathlib, sys
suite=pathlib.Path(sys.argv[1])
runtime=suite/"runtime"
banned_exact={
    "requests","httpx","aiohttp","urllib.request","socket",
    "psycopg","psycopg2","asyncpg","redis","kafka","pika",
    "boto3","botocore","confluent_kafka","elasticsearch","opensearchpy","pymongo",
    "subprocess","multiprocessing","importlib","pathlib","shutil","tempfile","ctypes","os",
}
banned_prefixes=("google.cloud","azure.")
banned_calls={
    "time.time","time.monotonic","random.random","random.randint","random.randrange","uuid.uuid4",
    "eval","exec","compile","__import__","builtins.eval","builtins.exec","builtins.compile","builtins.__import__",
    "open","builtins.open","io.open","os.open","os.system","os.popen",
}

def banned_module(name):
    return name in banned_exact or any(name.startswith(prefix) for prefix in banned_prefixes)

def dotted_name(node):
    if isinstance(node,ast.Name):
        return node.id
    if isinstance(node,ast.Attribute):
        left=dotted_name(node.value)
        return f"{left}.{node.attr}" if left else node.attr
    return ""

paths=tuple(runtime.rglob("*.py"))
if not paths:
    raise SystemExit("no runtime Python files found")
for path in paths:
    tree=ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
    for node in ast.walk(tree):
        if isinstance(node,ast.Constant) and isinstance(node.value,float):
            raise SystemExit(f"float literal forbidden:{path}:{node.lineno}")
        if isinstance(node,ast.Import):
            for name in node.names:
                if banned_module(name.name):
                    raise SystemExit(f"external/side-effect module forbidden:{path}:{name.name}")
        if isinstance(node,ast.ImportFrom) and node.module and banned_module(node.module):
            raise SystemExit(f"external/side-effect module forbidden:{path}:{node.module}")
        if isinstance(node,ast.Pass):
            raise SystemExit(f"pass statement forbidden:{path}:{node.lineno}")
        if isinstance(node,ast.Call):
            call=dotted_name(node.func)
            if call in banned_calls:
                raise SystemExit(f"volatile/dynamic/filesystem call forbidden:{path}:{node.lineno}:{call}")
        if isinstance(node,ast.Subscript) and dotted_name(node.value)=="os.environ":
            raise SystemExit(f"environment dependency forbidden:{path}:{node.lineno}:os.environ")
print("seo-avengers-2500 final M1001-M2500 verification: PASS")
PY
