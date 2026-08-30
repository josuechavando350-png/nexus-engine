# HTTP/3 + QUIC + 103 Early Hints audit

Status: implementation candidate; exact-head CI required before merge.

## Scope

Capability 1/20 integrates a deterministic transport policy plus a real operational probe for HTTP/3 and RFC 8297 `103 Early Hints` evidence. Application code cannot force QUIC/UDP 443 on infrastructure that does not support it.

## Fail-closed invariants

- `PASS` requires an actually observed HTTP/3 connection, not HTTP/2 or HTTP/1.1 fallback.
- `PASS` requires an actually observed `103 Early Hints` response.
- Every configured early `Link` hint must be present in the observed 103 response.
- The final response must have a successful status.
- Tooling without usable HTTP/3 support is `UNAVAILABLE`, never `PASS`.
- Reachable tooling that times out, fails QUIC, negotiates the wrong protocol, or omits 103 is `FAIL`.
- Probe evidence is canonicalized, digest-bound, and replay-validated.
- Header control characters, malformed hosts, invalid hint semantics, and duplicate hints are rejected.
- 0-RTT remains disabled by default.

## Operational consumer

`scripts/verify-transport-http3.mjs` runs the real `curl --http3-only` probe path and emits structured `PASS`, `FAIL`, or `UNAVAILABLE` evidence. No synthetic network result is converted into live evidence.

## Workspace integrity

The package is a real pnpm workspace member. Its importer is committed in `pnpm-lock.yaml`; build validation must leave the tracked lockfile byte-stable rather than generating workspace metadata as a build side effect.

## Acceptance gates

1. Package lint/typecheck/tests/build and integration tests pass.
2. NEXUS Real Browser Capture Validation, NEXUS Full Validation, NEXUS H07 Clean-Room Operability Proof, and NEXUS Baseline Validation all pass on the same exact final head SHA.
3. Final diff remains scoped to Capability 1 plus its operational consumer and required workspace metadata.
4. No TODO/FIXME/placeholders, mock production network evidence, permissive fallback, or false PASS path remains.

## Non-claims

This capability verifies observed transport behavior from the probe environment. It does not prove that every user, CDN edge, network path, browser, or deployment region will negotiate HTTP/3 or receive the same interim response.
