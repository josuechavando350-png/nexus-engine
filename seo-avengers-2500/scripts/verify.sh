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
banned={"requests","httpx","aiohttp","urllib.request","socket"}
banned_calls={"time.time","time.monotonic","random.random","random.randint","random.randrange","uuid.uuid4"}
for path in runtime.glob("*.py"):
    tree=ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
    for node in ast.walk(tree):
        if isinstance(node,ast.Constant) and isinstance(node.value,float):
            raise SystemExit(f"float literal forbidden:{path}:{node.lineno}")
        if isinstance(node,ast.Import):
            for name in node.names:
                if name.name in banned:
                    raise SystemExit(f"network client forbidden:{path}:{name.name}")
        if isinstance(node,ast.ImportFrom) and node.module in banned:
            raise SystemExit(f"network client forbidden:{path}:{node.module}")
        if isinstance(node,ast.Pass):
            raise SystemExit(f"pass statement forbidden:{path}:{node.lineno}")
        if isinstance(node,ast.Call) and isinstance(node.func,ast.Attribute) and isinstance(node.func.value,ast.Name):
            call=f"{node.func.value.id}.{node.func.attr}"
            if call in banned_calls:
                raise SystemExit(f"volatile call forbidden:{path}:{node.lineno}:{call}")
print("seo-avengers-2500 current M1001-M1400 verification: PASS")
PY
