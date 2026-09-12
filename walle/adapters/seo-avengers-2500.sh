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

for command_name in bash git grep python node sha256sum timeout; do
  command -v "$command_name" >/dev/null 2>&1 || {
    echo "WALLE_AVENGERS_ERROR=missing_required_command:$command_name" >&2
    exit 2
  }
done

cd "$ROOT"
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
for path in "$ORIGINAL_CATALOG" "$ORIGINAL_CONTRACT" "$ORIGINAL_VERIFIER"; do
  [[ -f "$path" ]] || {
    echo "WALLE_AVENGERS_ERROR=missing_original_m001_m200_source:$path" >&2
    exit 2
  }
done

TMP_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/walle-avengers.XXXXXX")"
trap 'rm -rf "$TMP_ROOT"' EXIT
STDOUT_FILE="$TMP_ROOT/stdout.log"
STDERR_FILE="$TMP_ROOT/stderr.log"

set +e
PYTHONDONTWRITEBYTECODE=1 timeout --signal=KILL 20m \
  bash "${CHAIN_PATHS[0]}" >"$STDOUT_FILE" 2>"$STDERR_FILE"
EXIT_CODE=$?
set -e

cat "$STDOUT_FILE"
if [[ -s "$STDERR_FILE" ]]; then
  cat "$STDERR_FILE" >&2
fi

HEAD_AFTER="$(git rev-parse HEAD)"
TREE_AFTER="$(git rev-parse 'HEAD^{tree}')"
STATUS_AFTER="$(git status --porcelain=v1 --untracked-files=all)"

if [[ "$HEAD_AFTER" != "$HEAD_BEFORE" || "$TREE_AFTER" != "$TREE_BEFORE" ]]; then
  echo "WALLE_AVENGERS_ERROR=source_identity_changed_during_verification" >&2
  exit 2
fi
if [[ -n "$STATUS_AFTER" ]]; then
  echo "WALLE_AVENGERS_ERROR=source_tree_changed_during_verification" >&2
  printf '%s\n' "$STATUS_AFTER" >&2
  exit 2
fi
if [[ "$EXIT_CODE" -eq 124 || "$EXIT_CODE" -eq 137 ]]; then
  echo "WALLE_AVENGERS_ERROR=verification_timeout" >&2
  exit 2
fi
if [[ "$EXIT_CODE" -ne 0 ]]; then
  echo "WALLE_AVENGERS_ERROR=verification_failed:$EXIT_CODE" >&2
  exit 2
fi

hash_file() {
  local path="$1"
  local digest
  digest="$(sha256sum "$path" | awk '{print $1}')"
  printf 'sha256:%s' "$digest"
}

printf 'WALLE_ENGINE=WALLE\n'
printf 'WALLE_WORKLOAD=seo-avengers-2500\n'
printf 'WALLE_SOURCE_HEAD=%s\n' "$HEAD_BEFORE"
printf 'WALLE_SOURCE_TREE=%s\n' "$TREE_BEFORE"
printf 'WALLE_AVENGERS_STATUS=VERIFIED_CHAIN\n'
printf 'WALLE_FULL_EXECUTION_CLAIM=false\n'
printf 'WALLE_FULL_EXECUTION_BLOCKER=M001_M200_ORIGINAL_SIDECAR_NOT_EXECUTED_BY_CHAINED_2500_VERIFIER\n'
printf 'WALLE_M001_M200_MODE=CONTRACT_PARITY_ONLY\n'
printf 'WALLE_M201_M2500_MODE=CHAINED_VERIFIER_EXECUTION\n'
printf 'WALLE_STDOUT_SHA256=%s\n' "$(hash_file "$STDOUT_FILE")"
printf 'WALLE_STDERR_SHA256=%s\n' "$(hash_file "$STDERR_FILE")"

for path in "${CHAIN_PATHS[@]}"; do
  printf 'WALLE_VERIFIER_SHA256[%s]=%s\n' "$path" "$(hash_file "$path")"
done
printf 'WALLE_ORIGINAL_M001_M200_CATALOG_SHA256=%s\n' "$(hash_file "$ORIGINAL_CATALOG")"
printf 'WALLE_ORIGINAL_M001_M200_CONTRACT_SHA256=%s\n' "$(hash_file "$ORIGINAL_CONTRACT")"
printf 'WALLE_ORIGINAL_M001_M200_VERIFIER_SHA256=%s\n' "$(hash_file "$ORIGINAL_VERIFIER")"
