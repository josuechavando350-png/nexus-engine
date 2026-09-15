#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
EXPECTED_SHA=""
if [[ "${1:-}" == "--expected-sha" ]]; then
  EXPECTED_SHA="${2:-}"
  [[ -n "$EXPECTED_SHA" ]] || { echo "missing value for --expected-sha" >&2; exit 64; }
  shift 2
fi
[[ "$#" -eq 0 ]] || { echo "unexpected arguments" >&2; exit 64; }

: "${WALLE_CANARY_CONTROL_ROOT:?WALLE_CANARY_CONTROL_ROOT is required}"
: "${WALLE_CANARY_EVIDENCE_ROOT:?WALLE_CANARY_EVIDENCE_ROOT is required}"
: "${WALLE_CANARY_RESULT_ROOT:?WALLE_CANARY_RESULT_ROOT is required}"
: "${WALLE_CANARY_RUN_ID:?WALLE_CANARY_RUN_ID is required}"

HEAD_SHA="$(git -C "$ROOT" rev-parse HEAD)"
TREE_SHA="$(git -C "$ROOT" rev-parse HEAD^{tree})"
if [[ -n "$EXPECTED_SHA" && "$HEAD_SHA" != "$EXPECTED_SHA" ]]; then
  echo "WALLE canary refusal: HEAD $HEAD_SHA != expected $EXPECTED_SHA" >&2
  exit 2
fi
if [[ -n "$(git -C "$ROOT" status --porcelain=v1 --untracked-files=all)" ]]; then
  echo "WALLE canary refusal: source tree is not pristine" >&2
  exit 2
fi

assert_outside_repo() {
  local candidate="$1"
  local resolved
  resolved="$(realpath "$candidate")"
  case "$resolved" in
    "$ROOT"|"$ROOT"/*)
      echo "WALLE canary refusal: runtime authority must live outside source tree: $resolved" >&2
      exit 2
      ;;
  esac
}

assert_outside_repo "$WALLE_CANARY_CONTROL_ROOT"
assert_outside_repo "$WALLE_CANARY_EVIDENCE_ROOT"
assert_outside_repo "$WALLE_CANARY_RESULT_ROOT"

ARGS=(
  --control-root "$WALLE_CANARY_CONTROL_ROOT"
  --evidence-root "$WALLE_CANARY_EVIDENCE_ROOT"
  --result-root "$WALLE_CANARY_RESULT_ROOT"
  --run-id "$WALLE_CANARY_RUN_ID"
  --source-revision "$HEAD_SHA"
  --source-tree "$TREE_SHA"
)
if [[ -n "${WALLE_CANARY_CONFIG:-}" ]]; then
  assert_outside_repo "$WALLE_CANARY_CONFIG"
  ARGS+=(--config "$WALLE_CANARY_CONFIG")
fi

python "$ROOT/seo-avengers-2500/scripts/google_search_safety.py" --repo-root "$ROOT" >/dev/null
CANARY_JSON="$(node "$ROOT/seo-avengers-2500/scripts/seo-avengers-2500-canary.mjs" "${ARGS[@]}")"
printf '%s\n' "$CANARY_JSON"

readarray -t CANARY_FIELDS < <(printf '%s' "$CANARY_JSON" | node -e '
let text="";
process.stdin.setEncoding("utf8");
process.stdin.on("data", chunk => text += chunk);
process.stdin.on("end", () => {
  const value=JSON.parse(text);
  console.log(value.status ?? "");
  console.log(value.proofHash ?? "");
  console.log(value.resultFile ?? "");
  console.log(value.localReceiptCount ?? "");
});
')
[[ "${CANARY_FIELDS[0]:-}" == "CERTIFIED" ]] || { echo "WALLE canary did not certify" >&2; exit 2; }
[[ "${CANARY_FIELDS[1]:-}" =~ ^sha256:[0-9a-f]{64}$ ]] || { echo "WALLE canary proof hash invalid" >&2; exit 2; }
[[ "${CANARY_FIELDS[3]:-}" == "1500" ]] || { echo "WALLE canary local receipt count invalid" >&2; exit 2; }
RESULT_FILE="${CANARY_FIELDS[2]:-}"
[[ -f "$RESULT_FILE" ]] || { echo "WALLE canary result file missing" >&2; exit 2; }

if [[ -n "$(git -C "$ROOT" status --porcelain=v1 --untracked-files=all)" ]]; then
  echo "WALLE canary refusal: source tree changed during execution" >&2
  exit 2
fi

printf 'WALLE_CANARY_SITE_ID=walle-production-canary\n'
printf 'WALLE_CANARY_SOURCE_HEAD=%s\n' "$HEAD_SHA"
printf 'WALLE_CANARY_SOURCE_TREE=%s\n' "$TREE_SHA"
printf 'WALLE_CANARY_LOCAL_RECEIPTS=1500\n'
printf 'WALLE_CANARY_PROOF_SHA256=%s\n' "${CANARY_FIELDS[1]}"
printf 'WALLE_CANARY_RESULT_FILE_SHA256=sha256:%s\n' "$(sha256sum "$RESULT_FILE" | awk '{print $1}')"
printf 'WALLE_CANARY_STATUS=LOCAL_RANGE_CERTIFIED\n'
