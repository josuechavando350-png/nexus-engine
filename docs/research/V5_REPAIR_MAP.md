# V5 Repair Map — make compiler failures cheap to fix

This build candidate was produced without a Rust toolchain in the execution environment. Therefore compile status is unknown.

## First repair order
1. `cd runtime && cargo fmt --all --check`
2. `cargo check --workspace`
3. Fix V5 crates **one at a time**, in this order: control-model → identity → authz → registry → secrets-v5 → cost → alerts → audit-v5 → api-contracts → sdk → control-plane → controld.
4. `cargo clippy --workspace --all-targets --all-features -- -D warnings`
5. `cargo test --workspace`
6. Run `node scripts/v3-architecture-gates.mjs`, `v4-architecture-gates.mjs`, `v5-architecture-gates.mjs` after every fix batch.

## Likely compile hotspots
- deriving `Ord` on nested resource identifiers;
- trait-object Send/Sync bounds;
- borrow/move behavior in `ControlPlane::execute` match arms;
- workspace member/dependency spelling;
- pre-existing V3/V4 compile errors, which may surface before V5.

## Rule
Do not “fix” a compile error by weakening tenant isolation, audit, idempotency, optimistic concurrency, SecretRef semantics, or the V3/V4 execution safety boundary. Prefer local type/signature fixes.
