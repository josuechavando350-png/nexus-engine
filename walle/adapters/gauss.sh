#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

EVIDENCE_ROOT="${WALLE_GAUSS_EVIDENCE_ROOT:-$(mktemp -d "${TMPDIR:-/tmp}/walle-gauss.XXXXXX")}"
mkdir -p "$EVIDENCE_ROOT"
REPORT="$EVIDENCE_ROOT/gauss-foundation-report.json"
DETERMINANT_REPORT="$EVIDENCE_ROOT/gauss-exact-integer-determinant-report.json"
EXACT_REPORT="$EVIDENCE_ROOT/gauss-exact-linear-report.json"
BENCHMARK_REPORT="$EVIDENCE_ROOT/gauss-exact-kernels-benchmark.json"

BEFORE_HEAD="$(git rev-parse HEAD)"
BEFORE_TREE="$(git rev-parse HEAD^{tree})"
BEFORE_STATUS="$(git status --porcelain=v1 --untracked-files=all)"
if [[ -n "$BEFORE_STATUS" ]]; then
  echo "WALLE_GAUSS_ERROR=source_tree_not_clean" >&2
  exit 2
fi

while IFS= read -r file; do
  node --check "$file"
done < <(find gauss scripts/nexus-gauss.mjs walle/gauss-evidence-verify.mjs walle/gauss-exact-evidence-verify.mjs walle/gauss-integer-determinant-evidence-verify.mjs seo-avengers-2500/quantum-runtime/gauss-ising-qaoa-simulator.mjs -type f -name '*.mjs' | sort)

node --test gauss/tests/*.test.mjs
node scripts/nexus-gauss.mjs gauss/fixtures/selftest-problem.json --out "$REPORT"
node walle/gauss-evidence-verify.mjs "$REPORT"
node scripts/nexus-gauss.mjs gauss/fixtures/exact-integer-determinant-problem.json --out "$DETERMINANT_REPORT"
node walle/gauss-integer-determinant-evidence-verify.mjs gauss/fixtures/exact-integer-determinant-problem.json "$DETERMINANT_REPORT"
node scripts/nexus-gauss.mjs gauss/fixtures/exact-linear-problem.json --out "$EXACT_REPORT"
node walle/gauss-exact-evidence-verify.mjs gauss/fixtures/exact-linear-problem.json "$EXACT_REPORT"
node gauss/benchmarks/exact-kernels.mjs --out "$BENCHMARK_REPORT"

AFTER_HEAD="$(git rev-parse HEAD)"
AFTER_TREE="$(git rev-parse HEAD^{tree})"
AFTER_STATUS="$(git status --porcelain=v1 --untracked-files=all)"
if [[ "$AFTER_HEAD" != "$BEFORE_HEAD" || "$AFTER_TREE" != "$BEFORE_TREE" || -n "$AFTER_STATUS" ]]; then
  echo "WALLE_GAUSS_ERROR=source_identity_changed" >&2
  exit 3
fi

printf 'WALLE_GAUSS_SOURCE_REVISION=%s\n' "$BEFORE_HEAD"
printf 'WALLE_GAUSS_SOURCE_TREE=%s\n' "$BEFORE_TREE"
printf 'WALLE_GAUSS_TARGET_LAYERS=800\n'
printf 'WALLE_GAUSS_QUANTUM_EXECUTED=true\n'
printf 'WALLE_GAUSS_PHYSICAL_QPU_EXECUTED=false\n'
printf 'WALLE_GAUSS_INTEGER_DETERMINANT_VERIFIED=true\n'
printf 'WALLE_GAUSS_EXACT_RATIONAL_VERIFIED=true\n'
printf 'WALLE_GAUSS_EXACT_BENCHMARK_RECORDED=true\n'
printf 'WALLE_GAUSS_FOUNDATION_CLAIM=true\n'