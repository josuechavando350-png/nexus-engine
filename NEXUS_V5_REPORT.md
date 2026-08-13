# NEXUS V5 — Control Plane — BUILD CANDIDATE REPORT
Date: 2026-08-13
Baseline: `NEXUS_V4_BUILD_CANDIDATE.zip`
Status: BUILD CANDIDATE — NOT CLOSED

## Added
11 Rust crates + `controld` service + TypeScript control SDK contracts + V5 architecture/security/research docs + static architecture gates.

Core path: authenticate → authorize → optimistic mutation → audit. Resource and action vocabulary is provider-neutral. Secrets are references/leases, never generic API plaintext. Control commands cannot replace V3/V4 physical safety paths.

## Not claimed
Rust compile/tests/clippy/fmt, durable storage, real identity provider, OpenFGA/Cedar/OPA adapter, Vault adapter, HTTP/gRPC server, benchmark figures, distributed HA, final visual console.

The visual console is intentionally deferred until the mandatory human Art Direction approval step instead of generating a generic admin dashboard.
