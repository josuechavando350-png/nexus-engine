#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
SUITE="$ROOT/seo-avengers-2500"

bash "$ROOT/seo-avengers-1000/scripts/verify.sh"
python -m compileall -q "$SUITE/runtime" "$SUITE/sidecar" "$SUITE/tests"
(
  cd "$SUITE"
  python -m unittest discover -s tests -v
)
node --check "$SUITE/control-plane/tenant-control.mjs"
node --check "$SUITE/evidence/tenant-evidence.mjs"
node --check "$SUITE/evidence/authorized-provider-snapshot.mjs"
node --check "$SUITE/growth-scenario/scenario-engine.mjs"
node --check "$SUITE/growth-scenario/tenant-scenario.mjs"
node --check "$SUITE/rank-feasibility/feasibility-engine.mjs"
node --check "$SUITE/rank-feasibility/tenant-feasibility.mjs"
node --check "$SUITE/rank-feasibility/longitudinal-engine.mjs"
node --check "$SUITE/rank-feasibility/tenant-longitudinal.mjs"
node --check "$SUITE/rank-feasibility/competition-engine.mjs"
node --check "$SUITE/rank-feasibility/tenant-competition.mjs"
node --check "$SUITE/rank-feasibility/authority-engine.mjs"
node --check "$SUITE/rank-feasibility/tenant-authority.mjs"
node --check "$SUITE/opportunity-prioritization/prioritization-engine.mjs"
node --check "$SUITE/opportunity-prioritization/tenant-prioritization.mjs"
node --check "$SUITE/client-quality/cohort-engine.mjs"
node --check "$SUITE/client-quality/tenant-cohort.mjs"
node --check "$SUITE/outcome-calibration/calibration-engine.mjs"
node --check "$SUITE/outcome-calibration/tenant-calibration.mjs"
node --check "$SUITE/rank-transition/transition-engine.mjs"
node --check "$SUITE/rank-transition/tenant-transition.mjs"
node --check "$SUITE/decision-engine/decision-engine.mjs"
node --check "$SUITE/decision-engine/tenant-decision.mjs"
node --check "$SUITE/sidecar/tenant-worker.mjs"
node --check "$SUITE/scripts/seo-avengers-2500-control.mjs"
node --check "$SUITE/scripts/seo-avengers-2500-sidecar.mjs"
node --test \
  "$SUITE/tests/test_tenant_control.mjs" \
  "$SUITE/tests/test_tenant_control_strict.mjs" \
  "$SUITE/tests/test_tenant_control_paths.mjs" \
  "$SUITE/tests/test_tenant_evidence.mjs" \
  "$SUITE/tests/test_tenant_evidence_readonly.mjs" \
  "$SUITE/tests/test_tenant_worker.mjs" \
  "$SUITE/tests/test_tenant_worker_boundary.mjs" \
  "$SUITE/tests/test_growth_scenario_engine.mjs" \
  "$SUITE/tests/test_rank_feasibility_engine.mjs" \
  "$SUITE/tests/test_rank_trend_engine.mjs" \
  "$SUITE/tests/test_rank_trend_empty_semantics.mjs" \
  "$SUITE/tests/test_rank_trend_reader_integrity.mjs" \
  "$SUITE/tests/test_rank_competition_engine.mjs" \
  "$SUITE/tests/test_rank_authority_engine.mjs" \
  "$SUITE/tests/test_opportunity_prioritization_v2.mjs" \
  "$SUITE/tests/test_client_quality_cohorts_v1.mjs" \
  "$SUITE/tests/test_outcome_calibration_v1.mjs" \
  "$SUITE/tests/test_rank_transition_v1.mjs" \
  "$SUITE/tests/test_decision_engine_v1.mjs"
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

# M201-M1000 are deterministic evaluators fed by controlled/authorized input.
# They must not grow a hidden direct-network execution path (including a future
# Google Search scraper) while still being certified through the chained verifier.
python - <<'PY' "$ROOT"
import ast
from pathlib import Path
import sys

root = Path(sys.argv[1])
runtime_roots = tuple(root / name / "runtime" for name in (
    "seo-avengers-400",
    "seo-avengers-600",
    "seo-avengers-800",
    "seo-avengers-1000",
))
banned_modules = {
    "requests", "httpx", "aiohttp", "urllib.request", "socket", "http.client",
    "subprocess", "selenium", "playwright", "pyppeteer",
}
banned_calls = {"os.system", "os.popen", "subprocess.run", "subprocess.Popen", "subprocess.call"}

def dotted_name(node):
    if isinstance(node, ast.Name):
        return node.id
    if isinstance(node, ast.Attribute):
        left = dotted_name(node.value)
        return f"{left}.{node.attr}" if left else node.attr
    return ""

def forbidden_import(module, aliases=()):
    if module in banned_modules:
        return module
    if module == "urllib" and any(alias.name == "request" for alias in aliases):
        return "urllib.request"
    if module == "http" and any(alias.name == "client" for alias in aliases):
        return "http.client"
    return None

files = tuple(path for runtime_root in runtime_roots for path in runtime_root.rglob("*.py"))
if not files:
    raise SystemExit("M201-M1000 runtime sources missing")
for path in files:
    tree = ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            for alias in node.names:
                if alias.name in banned_modules:
                    raise SystemExit(f"direct-network module forbidden:{path}:{node.lineno}:{alias.name}")
        elif isinstance(node, ast.ImportFrom) and node.module:
            forbidden = forbidden_import(node.module, node.names)
            if forbidden:
                raise SystemExit(f"direct-network module forbidden:{path}:{node.lineno}:{forbidden}")
        elif isinstance(node, ast.Call):
            call = dotted_name(node.func)
            if call in banned_calls:
                raise SystemExit(f"network/process escape forbidden:{path}:{node.lineno}:{call}")
print("seo-avengers M201-M1000 direct-network boundary: PASS")
PY

# One policy gate spans the complete Avengers execution surface. This is part of
# the chained verifier consumed by WALLE, so a policy regression prevents the
# 2,500-module full-execution claim rather than merely producing a warning.
python "$SUITE/scripts/google_search_safety.py" --repo-root "$ROOT"
