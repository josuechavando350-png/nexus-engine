#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
CORE="$ROOT/walle/core"
RUNTIME="$ROOT/walle/runtime-linux"
VALID_SHA="sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
VALID_RUN_ID="run-0123456789abcdef0123456789abcdef"
CARGO_TARGET_DIR="$(mktemp -d "${TMPDIR:-/tmp}/walle-target.XXXXXX")"
export CARGO_TARGET_DIR
trap 'rm -rf "$CARGO_TARGET_DIR"' EXIT

cd "$CORE"

echo "[WALLE 1/15] toolchain identity"
rustc --version
cargo --version

echo "[WALLE 2/15] locked core metadata"
cargo metadata --locked --format-version 1 >/dev/null

echo "[WALLE 3/15] core formatting"
cargo fmt --all -- --check

echo "[WALLE 4/15] compile core all targets"
cargo check --locked --all-targets

echo "[WALLE 5/15] core clippy deny warnings"
cargo clippy --locked --all-targets -- -D warnings

echo "[WALLE 6/15] core unit tests"
cargo test --locked

echo "[WALLE 7/15] deterministic CLI smoke"
cargo run --quiet --locked -- doctor
cargo run --quiet --locked -- validate-sha "$VALID_SHA"
cargo run --quiet --locked -- plan seo-avengers-2500 "$VALID_SHA" CERTIFICATION
cargo run --quiet --locked -- transition EXECUTING VERIFYING

echo "[WALLE 8/15] W1 execution capsule is canonical and fail-closed"
CAPSULE_ONE="$(cargo run --quiet --locked -- capsule-contract "$VALID_RUN_ID" seo-avengers-2500 "$VALID_SHA" CERTIFICATION)"
CAPSULE_TWO="$(cargo run --quiet --locked -- capsule-contract "$VALID_RUN_ID" seo-avengers-2500 "$VALID_SHA" CERTIFICATION)"
printf '%s\n' "$CAPSULE_ONE"
test "$CAPSULE_ONE" = "$CAPSULE_TWO"
grep -Fq '"schema_version":1' <<<"$CAPSULE_ONE"
grep -Fq '"network":"DENY_ALL"' <<<"$CAPSULE_ONE"
grep -Fq '"owner":"WALLE_CONTROL_PLANE"' <<<"$CAPSULE_ONE"
grep -Fq '"filesystem":"READ_ONLY_INPUTS"' <<<"$CAPSULE_ONE"
if cargo run --quiet --locked -- capsule-contract 'run-invalid' seo-avengers-2500 "$VALID_SHA" CERTIFICATION >/dev/null 2>&1; then
  echo "WALLE verifier failure: invalid run id was accepted by execution capsule" >&2
  exit 1
fi
if cargo run --quiet --locked -- capsule-contract "$VALID_RUN_ID" '../escape' "$VALID_SHA" CERTIFICATION >/dev/null 2>&1; then
  echo "WALLE verifier failure: unsafe workload id was accepted by execution capsule" >&2
  exit 1
fi

echo "[WALLE 9/15] W1 exit taxonomy cannot promote failures to success"
test "$(cargo run --quiet --locked -- classify-exit 0 true false false true)" = 'EXIT_CLASS=TIMED_OUT'
test "$(cargo run --quiet --locked -- classify-exit 0 false false true true)" = 'EXIT_CLASS=POLICY_VIOLATION'
test "$(cargo run --quiet --locked -- classify-exit 0 false false false false)" = 'EXIT_CLASS=MALFORMED_OUTPUT'
test "$(cargo run --quiet --locked -- classify-exit 9 false false false true)" = 'EXIT_CLASS=WORKLOAD_FAILURE'
test "$(cargo run --quiet --locked -- classify-exit NONE false false false true)" = 'EXIT_CLASS=INFRASTRUCTURE_ERROR'
test "$(cargo run --quiet --locked -- classify-exit 0 false false false true)" = 'EXIT_CLASS=SUCCESS'

echo "[WALLE 10/15] W2 microVM host preflight reports only proven capabilities"
set +e
ISOLATION_PREFLIGHT="$(cargo run --quiet --locked -- isolation-host-preflight 2>&1)"
ISOLATION_PREFLIGHT_CODE=$?
set -e
printf '%s\n' "$ISOLATION_PREFLIGHT"
grep -Fq 'isolation_backend_target=FIRECRACKER_MICROVM' <<<"$ISOLATION_PREFLIGHT"
case "$ISOLATION_PREFLIGHT_CODE" in
  0)
    grep -Fq 'isolation_host_verdict=READY' <<<"$ISOLATION_PREFLIGHT"
    grep -Fq 'linux_verified=true' <<<"$ISOLATION_PREFLIGHT"
    grep -Fq 'x86_64_verified=true' <<<"$ISOLATION_PREFLIGHT"
    grep -Fq 'privileged_supervisor_verified=true' <<<"$ISOLATION_PREFLIGHT"
    grep -Fq 'kvm_verified=true' <<<"$ISOLATION_PREFLIGHT"
    grep -Fq 'cgroup_v2_verified=true' <<<"$ISOLATION_PREFLIGHT"
    grep -Fq 'cgroup_controllers_verified=true' <<<"$ISOLATION_PREFLIGHT"
    grep -Fq 'seccomp_verified=true' <<<"$ISOLATION_PREFLIGHT"
    ;;
  2)
    grep -Fq 'isolation_host_verdict=UNAVAILABLE' <<<"$ISOLATION_PREFLIGHT"
    ;;
  *)
    echo "WALLE verifier failure: isolation-host-preflight returned unexpected code $ISOLATION_PREFLIGHT_CODE" >&2
    exit 1
    ;;
esac
if grep -Fq 'isolation_host_verdict=READY' <<<"$ISOLATION_PREFLIGHT" && grep -Eq '=false$' <<<"$ISOLATION_PREFLIGHT"; then
  echo "WALLE verifier failure: microVM host was marked READY with an unverified prerequisite" >&2
  exit 1
fi

echo "[WALLE 11/15] hardware contract is exact and ambiguity stays unresolved"
HARDWARE_CONTRACT="$(cargo run --quiet --locked -- hardware-contract)"
printf '%s\n' "$HARDWARE_CONTRACT"
grep -Fq 'target_cpu_vendor_id=GenuineIntel' <<<"$HARDWARE_CONTRACT"
grep -Fq 'target_silicon_process=Intel 18A' <<<"$HARDWARE_CONTRACT"
grep -Fq 'target_installed_ram_bytes=2199023255552' <<<"$HARDWARE_CONTRACT"
grep -Fq 'operator_secondary_capacity_label=Gb' <<<"$HARDWARE_CONTRACT"
grep -Fq 'operator_secondary_capacity_bytes=2199023255552' <<<"$HARDWARE_CONTRACT"
grep -Fq 'operator_secondary_capacity_component=UNRESOLVED' <<<"$HARDWARE_CONTRACT"

echo "[WALLE 12/15] host attestation refuses unsupported hardware claims"
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

echo "[WALLE 13/15] fail-closed CLI negatives"
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
if cargo run --quiet --locked -- classify-exit 0 TRUE false false true >/dev/null 2>&1; then
  echo "WALLE verifier failure: non-canonical boolean was accepted" >&2
  exit 1
fi

echo "[WALLE 14/15] Linux runtime identity/isolation primitives"
cargo metadata --manifest-path "$RUNTIME/Cargo.toml" --locked --format-version 1 >/dev/null
cargo fmt --manifest-path "$RUNTIME/Cargo.toml" --all -- --check
cargo check --manifest-path "$RUNTIME/Cargo.toml" --locked --all-targets
cargo clippy --manifest-path "$RUNTIME/Cargo.toml" --locked --all-targets -- -D warnings
cargo test --manifest-path "$RUNTIME/Cargo.toml" --locked

echo "[WALLE 15/15] real SEO Avengers verifier chain adapter"
cd "$ROOT"
bash walle/adapters/seo-avengers-2500.sh --expected-sha "$(git rev-parse HEAD)"

echo "WALLE connected verification: PASS"
