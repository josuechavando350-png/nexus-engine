# NEXUS — REPAIR PASS 2 — TECHNOLOGY DEBT / COMPILER HANDOFF

Date: 2026-08-13

This file is intentionally conservative. It records technology work that should NOT be mixed into source-level repairs until a Rust compiler is available.

## Current hard blocker

The active environment has no `cargo`, `rustc`, or `rust-analyzer`. Shell network/DNS egress cannot install them. Therefore feature-gated adapters and all Rust tests remain NOT TESTED.

## Adapter versions currently declared by the workspace

- `rdkafka = 0.36`
- `neo4rs = 0.8`
- `wasmtime = 27`
- `ed25519-dalek = 2`
- `tokio = 1`

These declarations are inherited from the V3 candidate. They have NOT been upgraded in Repair Pass 2 because a major dependency migration without a compiler would deliberately increase uncertainty.

## Freshness review performed during Repair Pass 2

Primary-source review on 2026-08-13 found:

- rust-rdkafka stable line is newer than the current 0.36 pin (0.39.0 was published in 2026).
- Tokio has newer stable/LTS releases than the minimum implied by the workspace declaration.
- Wasmtime has moved far beyond 27.x. Current RustSec advisories show actively maintained patched release lines in the 40s. The V3 Wasmtime adapter therefore requires a deliberate upgrade/compatibility pass before production use even if the old line is not affected by every recent advisory.
- neo4rs 0.8 remains a stable published line; 0.9 is currently represented by release candidates, so do not jump to an RC merely to appear newer.
- ed25519-dalek 2.x remains the correct major family; exact resolved version must be frozen in Cargo.lock and audited.

## Required order once cargo exists

1. Generate `Cargo.lock` from the existing manifests without changing versions.
2. `cargo check --workspace --all-targets` on default features.
3. Repair compile errors V3 -> V4 -> V5 -> V6.
4. Compile each feature-gated adapter at its currently declared version.
5. Record the exact working baseline commit.
6. Only then open dependency-upgrade commits one adapter at a time:
   - Wasmtime first (security-sensitive sandbox boundary)
   - rdkafka
   - Tokio/MSRV/toolchain policy
   - neo4rs only if stable release/benefit justifies it
   - ed25519-dalek exact patch/minor
7. For every upgrade run compile, tests, adapter integration test, security audit, and benchmark before proceeding to the next dependency.

## Rule

Do not combine a Rust edition migration, MSRV bump, Wasmtime major upgrade, Kafka adapter upgrade, and application compile fixes in one patch. That destroys causal debugging and makes rollback/due-diligence evidence weaker.
