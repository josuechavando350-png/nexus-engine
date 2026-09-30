#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 4 ]]; then
  echo "usage: $0 <d08-dir> <d09-dir> <authority-lock.json> <output-dir>" >&2
  exit 64
fi

D08_DIR="$1"
D09_DIR="$2"
AUTHORITY_LOCK="$3"
OUTPUT_DIR="$4"

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd -- "$SCRIPT_DIR/../.." && pwd)"
CENSUS_ROOT="$REPO_ROOT/nqc-census"

for path in \
  "$D08_DIR/market-state-manifest.jsonl" \
  "$D08_DIR/token-admission.jsonl" \
  "$D08_DIR/pool-and-factory-facts.json" \
  "$D08_DIR/evidence-manifest.json" \
  "$D09_DIR/account-manifest.jsonl" \
  "$D09_DIR/account-summary.json" \
  "$D09_DIR/evidence-manifest.json" \
  "$AUTHORITY_LOCK"
do
  test -f "$path"
done

if ! git -C "$REPO_ROOT" diff --quiet -- || ! git -C "$REPO_ROOT" diff --cached --quiet --; then
  echo "tracked working tree must be clean for exact-head certification" >&2
  exit 65
fi

EXACT_HEAD="$(git -C "$REPO_ROOT" rev-parse HEAD)"
EXACT_TREE="$(git -C "$REPO_ROOT" rev-parse 'HEAD^{tree}')"

if [[ -d "$OUTPUT_DIR" ]] && find "$OUTPUT_DIR" -mindepth 1 -print -quit | grep -q .; then
  echo "output directory must be absent or empty: $OUTPUT_DIR" >&2
  exit 66
fi
mkdir -p "$OUTPUT_DIR"

(
  cd "$CENSUS_ROOT"
  cargo run --release --locked -p nqc-census-capital --bin nqc-rmc011-capital-build -- \
    --d08-dir "$D08_DIR" \
    --d09-dir "$D09_DIR" \
    --authority-lock "$AUTHORITY_LOCK" \
    --output-dir "$OUTPUT_DIR" \
    --code-commit "$EXACT_HEAD" \
    --code-tree "$EXACT_TREE"
)

(
  cd "$CENSUS_ROOT"
  cargo run --release --locked -p nqc-census-capital --bin nqc-rmc011-upstream-replay-verify -- \
    --capital-dir "$OUTPUT_DIR" \
    --d08-dir "$D08_DIR" \
    --d09-dir "$D09_DIR" \
    --authority-lock "$OUTPUT_DIR/capital-upstream-authority-lock.json" \
    --closeout "$OUTPUT_DIR/capital-real-source-closeout.json" \
    --expected-code-commit "$EXACT_HEAD" \
    --expected-code-tree "$EXACT_TREE"
)

EXPECTED_FILES=(
  capital-sources.jsonl
  capital-requirements.jsonl
  capital-feasibility.jsonl
  capital-rejection-ledger.jsonl
  capital-census-summary.json
  capital-upstream-authority.json
  capital-evidence-manifest.json
  capital-upstream-authority-lock.json
  capital-real-source-closeout.json
)

for name in "${EXPECTED_FILES[@]}"; do
  test -f "$OUTPUT_DIR/$name"
done

(
  cd "$OUTPUT_DIR"
  sha256sum "${EXPECTED_FILES[@]}" > capital-archive.sha256
  sha256sum -c capital-archive.sha256
)

echo "RMC_011_EXACT_HEAD=$EXACT_HEAD"
echo "RMC_011_EXACT_TREE=$EXACT_TREE"
echo "RMC_011_REAL_SOURCE_ARCHIVE=PASS"
