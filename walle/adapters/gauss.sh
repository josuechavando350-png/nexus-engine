#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

EVIDENCE_ROOT="${WALLE_GAUSS_EVIDENCE_ROOT:-$(mktemp -d "${TMPDIR:-/tmp}/walle-gauss.XXXXXX")}" 
mkdir -p "$EVIDENCE_ROOT"
REPORT="$EVIDENCE_ROOT/gauss-foundation-report.json"

BEFORE_HEAD="$(git rev-parse HEAD)"
BEFORE_TREE="$(git rev-parse HEAD^{tree})"
BEFORE_STATUS="$(git status --porcelain=v1 --untracked-files=all)"
if [[ -n "$BEFORE_STATUS" ]]; then
  echo "WALLE_GAUSS_ERROR=source_tree_not_clean" >&2
  exit 2
fi

while IFS= read -r file; do
  node --check "$file"
done < <(find gauss scripts/nexus-gauss.mjs seo-avengers-2500/quantum-runtime/gauss-ising-qaoa-simulator.mjs -type f -name '*.mjs' 2>/dev/null | sort)

node --test gauss/tests/foundation.test.mjs
node scripts/nexus-gauss.mjs gauss/fixtures/selftest-problem.json --out "$REPORT"

node --input-type=module - "$REPORT" <<'NODE'
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
const path = process.argv[2];
const bytes = await readFile(path);
const report = JSON.parse(bytes);
if (report.engineId !== "NEXUS_GAUSS_SCIENTIFIC_KERNEL_V1") throw new Error("unexpected GAUSS engine identity");
if (report.status !== "PASS") throw new Error("GAUSS report did not PASS");
if (report.registry?.targetLayerCount !== 800) throw new Error("GAUSS target layer count mismatch");
if (report.registry?.implementedLayerCount !== 20) throw new Error("GAUSS implemented layer count mismatch");
if (report.executedLayerCount !== 20 || report.failedLayerCount !== 0) throw new Error("GAUSS foundation layer execution mismatch");
if (report.quantumContribution?.engineId !== "NEXUS_QUANTUM" || report.quantumContribution?.status !== "EXECUTED") throw new Error("Nexus Quantum contribution missing");
if (report.quantumContribution?.simulation?.verdict !== "PASS") throw new Error("Quantum simulation did not PASS");
if (report.quantumContribution?.simulation?.hardwareExecution !== false) throw new Error("foundation proof must not claim hardware execution");
if (report.quantumContribution?.simulation?.quantumAdvantageClaimAllowed !== false) throw new Error("foundation proof must not claim quantum advantage");
if (!/^sha256:[0-9a-f]{64}$/u.test(report.reportSha256)) throw new Error("GAUSS report hash malformed");
const artifactSha256 = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
console.log(`WALLE_GAUSS_REPORT_SHA256=${artifactSha256}`);
NODE

AFTER_HEAD="$(git rev-parse HEAD)"
AFTER_TREE="$(git rev-parse HEAD^{tree})"
AFTER_STATUS="$(git status --porcelain=v1 --untracked-files=all)"
if [[ "$AFTER_HEAD" != "$BEFORE_HEAD" || "$AFTER_TREE" != "$BEFORE_TREE" || -n "$AFTER_STATUS" ]]; then
  echo "WALLE_GAUSS_ERROR=source_identity_changed" >&2
  exit 3
fi

printf 'WALLE_GAUSS_SOURCE_REVISION=%s\n' "$BEFORE_HEAD"
printf 'WALLE_GAUSS_SOURCE_TREE=%s\n' "$BEFORE_TREE"
printf 'WALLE_GAUSS_IMPLEMENTED_LAYERS=20\n'
printf 'WALLE_GAUSS_TARGET_LAYERS=800\n'
printf 'WALLE_GAUSS_QUANTUM_EXECUTED=true\n'
printf 'WALLE_GAUSS_PHYSICAL_QPU_EXECUTED=false\n'
printf 'WALLE_GAUSS_FOUNDATION_CLAIM=true\n'
