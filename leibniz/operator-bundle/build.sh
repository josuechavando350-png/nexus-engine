#!/usr/bin/env bash
# Distribution boundary, not an authentication or OS sandbox. Run with the
# exact locally built guarded_append example, never arbitrary downloaded code.
set -euo pipefail
umask 077
if [[ $# -ne 2 ]]; then
  echo 'usage: bash build.sh PATH_TO_GUARDED_APPEND NEW_OUTPUT_DIRECTORY' >&2
  exit 2
fi
binary=$1
output=$2
if [[ $(basename -- "$binary") != guarded_append || ! -f "$binary" || -L "$binary" || ! -x "$binary" ]]; then
  echo 'expected a regular executable named guarded_append (no symlink)' >&2
  exit 1
fi
if [[ -e "$output" || -L "$output" ]]; then
  echo 'bundle destination must not exist' >&2
  exit 1
fi
mkdir -m 700 -- "$output"
install -m 0700 -- "$binary" "$output/guarded_append"
cat > "$output/README.txt" <<'EOF'
LEIBNIZ operator-only bundle (Linux)
Only guarded_append can append checkpoints from this distribution. It requires
both exact current checkpoint and policy witnesses and independently supplied
pins. It cannot create, authenticate or publish either witness or pin; the
caller-provided UTC time is not trusted. This bundle does not prevent an
operator or attacker from executing other copies of legacy binaries elsewhere.
Never use an old witness/policy; fetch the latest from an independently
protected authenticated authority for each request. This is not proof of
production issuer authentication, append atomicity or external monotonicity.
Usage: guarded_append STATE STATE_PIN STATE_HEAD BATCH BATCH_PIN SEQUENCE
       POLICY POLICY_PIN POLICY_HEAD AS_OF_UTC_MS NEW_STATE
The destination must be new. No customer data, credentials or private policy
files are packaged. SHA256SUMS documents bytes, not an issuer signature.
EOF
(
  cd -- "$output"
  sha256sum guarded_append README.txt > SHA256SUMS
  chmod 0600 README.txt SHA256SUMS
)
