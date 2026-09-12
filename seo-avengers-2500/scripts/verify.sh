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
python - <<'PY' "$SUITE"
import ast, pathlib, sys
suite=pathlib.Path(sys.argv[1])
runtime=suite/"runtime"
banned_exact={
    "requests","httpx","aiohttp","urllib.request","socket",
    "psycopg","psycopg2","asyncpg","redis","kafka","pika",
    "boto3","botocore","confluent_kafka","elasticsearch","opensearchpy","pymongo",
}
banned_prefixes=("google.cloud","azure.")
banned_calls={"time.time","time.monotonic","random.random","random.randint","random.randrange","uuid.uuid4"}

def banned_module(name):
    return name in banned_exact or any(name.startswith(prefix) for prefix in banned_prefixes)

def dotted_name(node):
    if isinstance(node,ast.Name):
        return node.id
    if isinstance(node,ast.Attribute):
        left=dotted_name(node.value)
        return f"{left}.{node.attr}" if left else node.attr
    return ""

for path in runtime.glob("*.py"):
    tree=ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
    for node in ast.walk(tree):
        if isinstance(node,ast.Constant) and isinstance(node.value,float):
            raise SystemExit(f"float literal forbidden:{path}:{node.lineno}")
        if isinstance(node,ast.Import):
            for name in node.names:
                if banned_module(name.name):
                    raise SystemExit(f"external infrastructure client forbidden:{path}:{name.name}")
        if isinstance(node,ast.ImportFrom) and node.module and banned_module(node.module):
            raise SystemExit(f"external infrastructure client forbidden:{path}:{node.module}")
        if isinstance(node,ast.Pass):
            raise SystemExit(f"pass statement forbidden:{path}:{node.lineno}")
        if isinstance(node,ast.Call):
            call=dotted_name(node.func)
            if call in banned_calls:
                raise SystemExit(f"volatile call forbidden:{path}:{node.lineno}:{call}")
            if call=="os.getenv":
                raise SystemExit(f"new environment dependency forbidden:{path}:{node.lineno}:{call}")
        if isinstance(node,ast.Subscript) and dotted_name(node.value)=="os.environ":
            raise SystemExit(f"new environment dependency forbidden:{path}:{node.lineno}:os.environ")
print("seo-avengers-2500 current M1001-M2200 verification: PASS")
PY
