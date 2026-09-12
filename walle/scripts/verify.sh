#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
CORE="$ROOT/walle/core"
VALID_SHA="sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
CARGO_TARGET_DIR="$(mktemp -d "${TMPDIR:-/tmp}/walle-core-target.XXXXXX")"
export CARGO_TARGET_DIR
trap 'rm -rf "$CARGO_TARGET_DIR"' EXIT

cd "$CORE"

echo "[WALLE 1/11] toolchain identity"
rustc --version
cargo --version

echo "[WALLE 2/11] locked metadata"
cargo metadata --locked --format-version 1 >/dev/null

echo "[WALLE 3/11] formatting"
cargo fmt --all -- --check

echo "[WALLE 4/11] compile all targets"
cargo check --locked --all-targets

echo "[WALLE 5/11] clippy deny warnings"
cargo clippy --locked --all-targets -- -D warnings

echo "[WALLE 6/11] unit tests"
cargo test --locked

echo "[WALLE 7/11] deterministic CLI smoke"
cargo run --quiet --locked -- doctor
cargo run --quiet --locked -- validate-sha "$VALID_SHA"
cargo run --quiet --locked -- plan seo-avengers-2500 "$VALID_SHA" CERTIFICATION
cargo run --quiet --locked -- transition EXECUTING VERIFYING

echo "[WALLE 8/11] hardware contract is exact and ambiguity stays unresolved"
HARDWARE_CONTRACT="$(cargo run --quiet --locked -- hardware-contract)"
printf '%s\n' "$HARDWARE_CONTRACT"
grep -Fq 'target_cpu_vendor_id=GenuineIntel' <<<"$HARDWARE_CONTRACT"
grep -Fq 'target_silicon_process=Intel 18A' <<<"$HARDWARE_CONTRACT"
grep -Fq 'target_installed_ram_bytes=2199023255552' <<<"$HARDWARE_CONTRACT"
grep -Fq 'operator_secondary_capacity_label=Gb' <<<"$HARDWARE_CONTRACT"
grep -Fq 'operator_secondary_capacity_bytes=2199023255552' <<<"$HARDWARE_CONTRACT"
grep -Fq 'operator_secondary_capacity_component=UNRESOLVED' <<<"$HARDWARE_CONTRACT"

echo "[WALLE 9/11] host attestation refuses unsupported hardware claims"
set +e
HOST_ATTEST="$(cargo run --quiet --locked -- host-attest 2>&1)"
HOST_ATTEST_CODE=$?
set -e
printf '%s\n' "$HOST_ATTEST"
if [[ "$HOST_ATTEST_CODE" -ne 2 ]]; then
  echo "WALLE verifier failure: host-attest unexpectedly certified generic host" >&2
  exit 1
fi
grep -Eq '^hardware_verdict=(BLOCKED|UNVERIFIED)$' <<<"$HOST_ATTEST"
if grep -Fq 'hardware_verdict=VERIFIED' <<<"$HOST_ATTEST"; then
  echo "WALLE verifier failure: unsupported hardware claim was promoted to VERIFIED" >&2
  exit 1
fi

echo "[WALLE 10/11] fail-closed CLI negatives"
if cargo run --quiet --locked -- validate-sha 'sha256:DEADBEEF' >/dev/null 2>&1; then
  echo "WALLE verifier failure: uppercase/short digest was accepted" >&2
  exit 1
fi
if cargo run --quiet --locked -- transition CERTIFIED EXECUTING >/dev/null 2>&1; then
  echo "WALLE verifier failure: terminal state transitioned back to execution" >&2
  exit 1
fi
if cargo run --quiet --locked -- plan '../escape' "$VALID_SHA" FAST >/dev/null 2>&1; then
  echo "WALLE verifier failure: unsafe workload id was accepted" >&2
  exit 1
fi

echo "[WALLE 11/11] real SEO Avengers verifier chain adapter"
cd "$ROOT"
bash walle/adapters/seo-avengers-2500.sh --expected-sha "$(git rev-parse HEAD)"

echo "WALLE connected verification: PASS"
