# V6 Final Repair Map

Purpose: make the final compiler/debug pass mechanical and low-token.

## First repair the inherited baseline
Run V3 -> V4 -> V5 compilation in dependency order. Do not diagnose V6 errors until lower layers compile.

## V6 compile order
1. `nexus-cluster`
2. `nexus-consensus`
3. `nexus-replication`
4. `nexus-discovery`
5. `nexus-federation`
6. `nexus-offline`
7. `nexus-mesh`
8. `nexus-fleet`
9. `nexus-update`
10. `nexus-placement`
11. `nexus-distributed`
12. `clusterd`
13. `distributed-factory`

## Likely mechanical hotspots
- trait object error conversion around poisoned locks;
- derive coverage needed for ordered map/set keys;
- integer conversion/overflow warnings in placement scoring;
- temporary references in demo composition;
- clippy style warnings caused by compact source formatting;
- inherited workspace dependency/API drift from V3 adapters.

## Required command sequence
`cargo fmt --all --check`
`cargo check --workspace`
`cargo clippy --workspace --all-targets --all-features -- -D warnings`
`cargo test --workspace --all-features`
`cargo build --workspace --release --all-features`
`cargo audit`
`cargo deny check`

Then run V3/V4/V5/V6 architecture gates, demos, fault tests, benchmarks and JS/TS gates.

## Rust migration isolation
Do not migrate edition/toolchain before baseline errors are understood. Once current workspace is green, create one isolated commit for upgrading MSRV/toolchain and one later commit for edition migration if justified by source compatibility and benchmarks.
