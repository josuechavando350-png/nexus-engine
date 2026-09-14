#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
EXPECTED_SHA=""

usage() {
  echo "usage: seo-avengers-2500.sh [--expected-sha <git-sha>]" >&2
}

while (($#)); do
  case "$1" in
    --expected-sha)
      if (($# < 2)); then
        usage
        exit 64
      fi
      EXPECTED_SHA="$2"
      shift 2
      ;;
    *)
      usage
      exit 64
      ;;
  esac
done

for command_name in awk bash curl git go grep node python sha256sum timeout; do
  command -v "$command_name" >/dev/null 2>&1 || {
    echo "WALLE_AVENGERS_ERROR=missing_required_command:$command_name" >&2
    exit 2
  }
done

cd "$ROOT"
WALLE_PYTHON="$(command -v python)"
HEAD_BEFORE="$(git rev-parse HEAD)"
TREE_BEFORE="$(git rev-parse 'HEAD^{tree}')"
STATUS_BEFORE="$(git status --porcelain=v1 --untracked-files=all)"

if [[ -n "$STATUS_BEFORE" ]]; then
  echo "WALLE_AVENGERS_ERROR=source_tree_not_clean" >&2
  exit 2
fi
if [[ -n "$EXPECTED_SHA" && "$HEAD_BEFORE" != "$EXPECTED_SHA" ]]; then
  echo "WALLE_AVENGERS_ERROR=source_sha_mismatch" >&2
  echo "WALLE_EXPECTED_SHA=$EXPECTED_SHA" >&2
  echo "WALLE_OBSERVED_SHA=$HEAD_BEFORE" >&2
  exit 2
fi

CHAIN_PATHS=(
  "seo-avengers-2500/scripts/verify.sh"
  "seo-avengers-1000/scripts/verify.sh"
  "seo-avengers-800/scripts/verify.sh"
  "seo-avengers-600/scripts/verify.sh"
  "seo-avengers-400/scripts/verify.sh"
)
CHAIN_REFERENCES=(
  "seo-avengers-1000/scripts/verify.sh"
  "seo-avengers-800/scripts/verify.sh"
  "seo-avengers-600/scripts/verify.sh"
  "seo-avengers-400/scripts/verify.sh"
)

for path in "${CHAIN_PATHS[@]}"; do
  [[ -f "$path" ]] || {
    echo "WALLE_AVENGERS_ERROR=missing_verifier:$path" >&2
    exit 2
  }
done
for index in 0 1 2 3; do
  parent="${CHAIN_PATHS[$index]}"
  child="${CHAIN_REFERENCES[$index]}"
  grep -Fq "$child" "$parent" || {
    echo "WALLE_AVENGERS_ERROR=disconnected_verifier:$parent:$child" >&2
    exit 2
  }
done

ORIGINAL_CATALOG="seo-avengers-200/packages/Core-Go-Backend/module-catalog.json"
ORIGINAL_CONTRACT="seo-avengers-200/contracts/SEO_Avengers_200_Pure_Engine.source.json"
ORIGINAL_VERIFIER="seo-avengers-200/scripts/verify.sh"
ORIGINAL_E2E="seo-avengers-200/scripts/local-mirror-e2e.sh"
PROOF_RUNNER="walle/scripts/seo_avengers_2500_proof.py"
for path in "$ORIGINAL_CATALOG" "$ORIGINAL_CONTRACT" "$ORIGINAL_VERIFIER" "$ORIGINAL_E2E" "$PROOF_RUNNER"; do
  [[ -f "$path" ]] || {
    echo "WALLE_AVENGERS_ERROR=missing_execution_proof_component:$path" >&2
    exit 2
  }
done

TMP_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/walle-avengers.XXXXXX")"
trap 'rm -rf "$TMP_ROOT"' EXIT
CHAIN_STDOUT_FILE="$TMP_ROOT/chain.stdout.log"
CHAIN_STDERR_FILE="$TMP_ROOT/chain.stderr.log"
M200_STDOUT_FILE="$TMP_ROOT/m001-m200.stdout.log"
M200_STDERR_FILE="$TMP_ROOT/m001-m200.stderr.log"
PROOF_STDOUT_FILE="$TMP_ROOT/proof.stdout.log"
PROOF_STDERR_FILE="$TMP_ROOT/proof.stderr.log"
GATE_EVIDENCE_FILE="$TMP_ROOT/verifier-gates.json"
PYCACHE_ROOT="$TMP_ROOT/pycache"
mkdir -p "$PYCACHE_ROOT"

PYTHONDONTWRITEBYTECODE=1 PYTHONPYCACHEPREFIX="$PYCACHE_ROOT" \
  "$WALLE_PYTHON" -m unittest -v walle/tests/test_seo_avengers_2500_proof.py

EVIDENCE_ROOT="${WALLE_AVENGERS_EVIDENCE_ROOT:-${TMPDIR:-/tmp}/walle-avengers-evidence.${HEAD_BEFORE}.$$}"
if [[ -e "$EVIDENCE_ROOT" ]]; then
  echo "WALLE_AVENGERS_ERROR=evidence_root_already_exists:$EVIDENCE_ROOT" >&2
  exit 2
fi
case "$(cd "$(dirname "$EVIDENCE_ROOT")" 2>/dev/null && pwd -P)/$(basename "$EVIDENCE_ROOT")" in
  "$ROOT"|"$ROOT"/*)
    echo "WALLE_AVENGERS_ERROR=evidence_root_inside_source_tree" >&2
    exit 2
    ;;
esac

hash_file() {
  local path="$1"
  local digest
  digest="$(sha256sum "$path" | awk '{print $1}')"
  printf 'sha256:%s' "$digest"
}

set +e
PYTHONDONTWRITEBYTECODE=1 PYTHONPYCACHEPREFIX="$PYCACHE_ROOT" \
  timeout --signal=KILL 20m bash "${CHAIN_PATHS[0]}" \
  >"$CHAIN_STDOUT_FILE" 2>"$CHAIN_STDERR_FILE"
CHAIN_EXIT_CODE=$?
set -e
cat "$CHAIN_STDOUT_FILE"
[[ ! -s "$CHAIN_STDERR_FILE" ]] || cat "$CHAIN_STDERR_FILE" >&2
if [[ "$CHAIN_EXIT_CODE" -eq 124 || "$CHAIN_EXIT_CODE" -eq 137 ]]; then
  echo "WALLE_AVENGERS_ERROR=verification_timeout:m201_m2500" >&2
  exit 2
fi
if [[ "$CHAIN_EXIT_CODE" -ne 0 ]]; then
  echo "WALLE_AVENGERS_ERROR=verification_failed:m201_m2500:$CHAIN_EXIT_CODE" >&2
  exit 2
fi
if grep -Eiq '(^|[[:space:]])SKIP(PED)?([[:space:]:]|$)' "$CHAIN_STDOUT_FILE" "$CHAIN_STDERR_FILE"; then
  echo "WALLE_AVENGERS_ERROR=skip_detected:m201_m2500" >&2
  exit 2
fi

M200_PATH="$PATH"
if [[ -n "${WALLE_M200_PYTHON_DIR:-}" ]]; then
  [[ -x "$WALLE_M200_PYTHON_DIR/python3" ]] || {
    echo "WALLE_AVENGERS_ERROR=missing_m001_m200_python_runtime" >&2
    exit 2
  }
  M200_PATH="$WALLE_M200_PYTHON_DIR:$PATH"
fi
set +e
PATH="$M200_PATH" PYTHONDONTWRITEBYTECODE=1 PYTHONPYCACHEPREFIX="$PYCACHE_ROOT" \
  timeout --signal=KILL 10m bash "$ORIGINAL_VERIFIER" \
  >"$M200_STDOUT_FILE" 2>"$M200_STDERR_FILE"
M200_EXIT_CODE=$?
set -e
cat "$M200_STDOUT_FILE"
[[ ! -s "$M200_STDERR_FILE" ]] || cat "$M200_STDERR_FILE" >&2
if [[ "$M200_EXIT_CODE" -eq 124 || "$M200_EXIT_CODE" -eq 137 ]]; then
  echo "WALLE_AVENGERS_ERROR=verification_timeout:m001_m200" >&2
  exit 2
fi
if [[ "$M200_EXIT_CODE" -ne 0 ]]; then
  echo "WALLE_AVENGERS_ERROR=verification_failed:m001_m200:$M200_EXIT_CODE" >&2
  exit 2
fi
if grep -Eiq '(^|[[:space:]])SKIP(PED)?([[:space:]:]|$)' "$M200_STDOUT_FILE" "$M200_STDERR_FILE"; then
  echo "WALLE_AVENGERS_ERROR=skip_detected:m001_m200" >&2
  exit 2
fi

HEAD_AFTER_VERIFY="$(git rev-parse HEAD)"
TREE_AFTER_VERIFY="$(git rev-parse 'HEAD^{tree}')"
STATUS_AFTER_VERIFY="$(git status --porcelain=v1 --untracked-files=all)"
if [[ "$HEAD_AFTER_VERIFY" != "$HEAD_BEFORE" || "$TREE_AFTER_VERIFY" != "$TREE_BEFORE" ]]; then
  echo "WALLE_AVENGERS_ERROR=source_identity_changed_during_verification" >&2
  exit 2
fi
if [[ -n "$STATUS_AFTER_VERIFY" ]]; then
  echo "WALLE_AVENGERS_ERROR=source_tree_changed_during_verification" >&2
  printf '%s\n' "$STATUS_AFTER_VERIFY" >&2
  exit 2
fi

"$WALLE_PYTHON" - "$GATE_EVIDENCE_FILE" "$HEAD_BEFORE" "$TREE_BEFORE" \
  "$CHAIN_STDOUT_FILE" "$CHAIN_STDERR_FILE" "$(hash_file "$CHAIN_STDOUT_FILE")" "$(hash_file "$CHAIN_STDERR_FILE")" \
  "$M200_STDOUT_FILE" "$M200_STDERR_FILE" "$(hash_file "$M200_STDOUT_FILE")" "$(hash_file "$M200_STDERR_FILE")" <<'PY'
import json, sys
(
    output, source_revision, source_tree,
    chain_stdout, chain_stderr, chain_stdout_sha, chain_stderr_sha,
    m200_stdout, m200_stderr, m200_stdout_sha, m200_stderr_sha,
) = sys.argv[1:]
value = {
    "schema_version": 1,
    "source_revision": source_revision,
    "source_tree": source_tree,
    "gates": [
        {
            "name": "CHAINED_VERIFIER_M201_M2500",
            "exit_code": 0,
            "skip_detected": False,
            "stdout_path": chain_stdout,
            "stderr_path": chain_stderr,
            "stdout_sha256": chain_stdout_sha,
            "stderr_sha256": chain_stderr_sha,
        },
        {
            "name": "ORIGINAL_VERIFIER_M001_M200",
            "exit_code": 0,
            "skip_detected": False,
            "stdout_path": m200_stdout,
            "stderr_path": m200_stderr,
            "stdout_sha256": m200_stdout_sha,
            "stderr_sha256": m200_stderr_sha,
        },
    ],
}
with open(output, "w", encoding="utf-8") as handle:
    json.dump(value, handle, sort_keys=True, separators=(",", ":"))
    handle.write("\n")
PY

set +e
PATH="$M200_PATH" PYTHONDONTWRITEBYTECODE=1 PYTHONPYCACHEPREFIX="$PYCACHE_ROOT" \
  "$WALLE_PYTHON" "$PROOF_RUNNER" execute \
    --repo-root "$ROOT" \
    --source-revision "$HEAD_BEFORE" \
    --source-tree "$TREE_BEFORE" \
    --evidence-root "$EVIDENCE_ROOT" \
    --gate-evidence "$GATE_EVIDENCE_FILE" \
    >"$PROOF_STDOUT_FILE" 2>"$PROOF_STDERR_FILE"
PROOF_EXIT_CODE=$?
set -e
cat "$PROOF_STDOUT_FILE"
[[ ! -s "$PROOF_STDERR_FILE" ]] || cat "$PROOF_STDERR_FILE" >&2

HEAD_AFTER="$(git rev-parse HEAD)"
TREE_AFTER="$(git rev-parse 'HEAD^{tree}')"
STATUS_AFTER="$(git status --porcelain=v1 --untracked-files=all)"
if [[ "$HEAD_AFTER" != "$HEAD_BEFORE" || "$TREE_AFTER" != "$TREE_BEFORE" ]]; then
  echo "WALLE_AVENGERS_ERROR=source_identity_changed_during_execution_proof" >&2
  exit 2
fi
if [[ -n "$STATUS_AFTER" ]]; then
  echo "WALLE_AVENGERS_ERROR=source_tree_changed_during_execution_proof" >&2
  printf '%s\n' "$STATUS_AFTER" >&2
  exit 2
fi

if [[ -d "$EVIDENCE_ROOT" ]]; then
  chmod -R a-w "$EVIDENCE_ROOT"
fi
if [[ "$PROOF_EXIT_CODE" -ne 0 ]]; then
  echo "WALLE_AVENGERS_ERROR=full_execution_proof_failed:$PROOF_EXIT_CODE" >&2
  echo "WALLE_EVIDENCE_ROOT=$EVIDENCE_ROOT" >&2
  exit 2
fi
if ! grep -Fxq 'WALLE_FULL_EXECUTION_CLAIM=true' "$PROOF_STDOUT_FILE"; then
  echo "WALLE_AVENGERS_ERROR=claim_missing_after_successful_proof" >&2
  exit 2
fi

printf 'WALLE_AVENGERS_STATUS=FULL_EXECUTION_PROVEN\n'
printf 'WALLE_EVIDENCE_ROOT=%s\n' "$EVIDENCE_ROOT"
printf 'WALLE_CHAIN_STDOUT_SHA256=%s\n' "$(hash_file "$CHAIN_STDOUT_FILE")"
printf 'WALLE_CHAIN_STDERR_SHA256=%s\n' "$(hash_file "$CHAIN_STDERR_FILE")"
printf 'WALLE_M001_M200_STDOUT_SHA256=%s\n' "$(hash_file "$M200_STDOUT_FILE")"
printf 'WALLE_M001_M200_STDERR_SHA256=%s\n' "$(hash_file "$M200_STDERR_FILE")"
for path in "${CHAIN_PATHS[@]}"; do
  printf 'WALLE_VERIFIER_SHA256[%s]=%s\n' "$path" "$(hash_file "$path")"
done
printf 'WALLE_ORIGINAL_M001_M200_CATALOG_SHA256=%s\n' "$(hash_file "$ORIGINAL_CATALOG")"
printf 'WALLE_ORIGINAL_M001_M200_CONTRACT_SHA256=%s\n' "$(hash_file "$ORIGINAL_CONTRACT")"
printf 'WALLE_ORIGINAL_M001_M200_VERIFIER_SHA256=%s\n' "$(hash_file "$ORIGINAL_VERIFIER")"
printf 'WALLE_ORIGINAL_M001_M200_E2E_SHA256=%s\n' "$(hash_file "$ORIGINAL_E2E")"
printf 'WALLE_EXECUTION_PROOF_RUNNER_SHA256=%s\n' "$(hash_file "$PROOF_RUNNER")"
