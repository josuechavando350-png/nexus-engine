# RMC-002 Certified Effective Source Contract

Status: implementation contract for dependency D02 from the Real Market Census CENSUS-0 DAG.

## Authority

Protocol/Fork Truth remains closed at:

- certified commit: `5b4a0cb778cb4370cd54eb6fcba765dc8d7cecdf`
- certified tree: `ef3498da528f85cdb9fdd82222d64773a557f853`

RMC-001 is already merged at `cea25577edfcaf89dc8fc8bf60ee04bc01d01a3d`.

This PR does not alter, copy-edit, or recertify Protocol/Fork Truth. It solves one integration defect found in CENSUS-0: certified protocol behavior is not represented by the immutable recovered source bytes alone. Several measured compatibility and semantic repairs were applied only to temporary copies during Protocol/Fork certification, and three missing components were accepted only as measured reimplementations.

## Purpose

RMC-002 defines one deterministic materialization procedure that turns the immutable certified Protocol/Fork inputs into the exact effective source bundle that later Census code is allowed to consume.

The output has two roots:

- `recovered-source/`: the immutable recovered workspace copied from the certified commit, then repaired only in the derived copy with PFT-COMPAT-001 through PFT-COMPAT-009 and the PFT-COMPAT-007 regression source;
- `reimplementation/`: PFT-SRC-001, PFT-SRC-002 and PFT-SRC-003 source trees, admitted only when their certified closeout contracts are CLOSED with zero unexplained mismatches.

A `MATERIALIZATION.json` receipt binds every input and the resulting content trees.

## Hard rules

1. All authoritative inputs are read from the certified Protocol/Fork commit, never from mutable working-tree bytes.
2. The certified tree must match exactly.
3. Every recovered-source/reimplementation tree is pinned by Git object identity.
4. Every compatibility overlay is pinned by Git blob identity and SHA-256.
5. The recovered dependency lock is pinned by Git blob identity and SHA-256.
6. Reimplementations are rejected unless their certified closeout contracts say CLOSED and unexplained_mismatches=0.
7. PFT-COMPAT-001 through PFT-COMPAT-009 must all be present exactly once as semantic repairs. The extra PFT-COMPAT-007 regression source is evidence/test material, not a tenth semantic repair.
8. Protocol/Fork input paths must have zero post-certification drift and zero local modifications.
9. Materialization must occur outside the repository. The immutable historical source stays byte-identical.
10. The output must be deterministic across independent temporary directories.
11. The materialized Rust workspace and admitted measured Rust reimplementations must compile/test against the pinned dependency universe.
12. Aave and V2 executor Solidity must compile/test with the exact certified Foundry/solc toolchains.
13. A malformed profile, wrong hash, wrong Git object, missing repair, open reimplementation, or unexpected source drift is a hard failure.
14. No RPC, market scan, signer, secret, capital, routing, price, P&L, or live execution is part of RMC-002.

## Why this exists

Without D02, a Census adapter could import `ci/nqc-protocol-fork/recovered-source` directly and silently lose certified repairs such as:

- exact Aave account accounting semantics from PFT-COMPAT-008;
- Aave flash-loan premium ceiling semantics from PFT-COMPAT-009;
- compatibility changes needed for the exact pinned Rust/REVM/compiler environment.

That would create two conflicting truths: Protocol/Fork would have certified one implementation while Census executed another. RMC-002 makes that state impossible by construction.

## Receipt semantics

`MATERIALIZATION.json` contains:

- certified commit/tree;
- recovered checkpoint;
- recovered source Git tree and manifest SHA-256;
- immutable recovered-source content-tree SHA-256;
- pinned lock Git blob and SHA-256;
- ordered overlay IDs, Git blobs, SHA-256 values, modes and order;
- effective recovered-source content-tree SHA-256;
- each measured reimplementation Git tree, content-tree SHA-256 and closeout binding;
- aggregate reimplementation tree SHA-256;
- exact toolchain pins;
- explicit truth boundaries.

The receipt is evidence of source derivation only. It is not Real Market Census evidence and cannot be used to claim market completeness, profitability, capital feasibility, Shadow readiness, Canary readiness, or production authority.

## Exit condition

D02 is closed only when exact-head CI proves:

- exact four-file PR scope;
- deterministic double materialization;
- fail-closed tamper detection;
- all PFT-COMPAT-001..009 applied;
- PFT-SRC-001/002/003 admitted only from CLOSED zero-mismatch closeouts;
- effective recovered Rust workspace compiles/tests;
- nqc-v2-state and nqc-aave-reconciler reimplementations compile/tests against the effective source;
- Aave executor and V2 executor compile/tests with pinned Foundry/solc;
- Protocol/Fork tracked inputs remain unchanged;
- no Census/economic claim is emitted.

Only after this may D03 consume the materialized source contract.
