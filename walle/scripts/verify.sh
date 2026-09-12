#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
CORE="$ROOT/walle/core"
VALID_SHA="sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"

cd "$CORE"

echo "[WALLE 1/8] toolchain identity"
rustc --version
cargo --version

echo "[WALLE 2/8] locked metadata"
cargo metadata --locked --format-version 1 >/dev/null

echo "[WALLE 3/8] formatting"
cargo fmt --all -- --check

echo "[WALLE 4/8] compile all targets"
cargo check --locked --all-targets

echo "[WALLE 5/8] clippy deny warnings"
cargo clippy --locked --all-targets -- -D warnings

echo "[WALLE 6/8] unit tests"
cargo test --locked

echo "[WALLE 7/8] deterministic CLI smoke"
cargo run --quiet --locked -- doctor
cargo run --quiet --locked -- validate-sha "$VALID_SHA"
cargo run --quiet --locked -- plan seo-avengers-2500 "$VALID_SHA" CERTIFICATION
cargo run --quiet --locked -- transition EXECUTING VERIFYING

echo "[WALLE 8/8] fail-closed CLI negatives"
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

echo "WALLE foundation verification: PASS"
