# THIS BUILD — NEXUS V6 CONSOLIDATED REPO R1

Build ID: `NEXUS_V6_CONSOLIDATED_REPO_R1`

## Purpose

This is the first consolidated closeout repository for NEXUS V1→V6. It is based on the latest available repaired baseline: `NEXUS_V6_REPAIR_PASS2.zip`.

## What this build replaces

For the closeout workflow, use this build instead of the earlier V4/V5/V6 build-candidate ZIPs and Repair Pass 1/2 ZIPs. Historical reports and validation records are retained as evidence; they are not rewritten as if compiler gates had passed.

## Important truth state

- Static architecture gates had passed before consolidation.
- Rust compilation, Clippy, Rust tests, real optional adapters, full E2E and performance benchmarks have NOT yet been proven green in the prior local environment.
- This build therefore MUST NOT be called `V6 FINAL`.
- The purpose of GitHub CI is to obtain real compiler evidence and repair failures in order.

## Closeout order

`.github/workflows/closeout-stages.yml` runs:

1. V3 architecture and core compile
2. V3 optional adapters
3. V4 intelligence compile
4. V5 control plane compile
5. V6 distributed runtime compile
6. Full workspace fmt / Clippy / tests / release build

The jobs are chained deliberately. A later layer does not run until the earlier layer is green, keeping the repair signal narrow.

## Repository target

Canonical closeout repository: `josuechavando349-cmd/nexus-engine`.

## Naming rule

Every subsequent downloadable build must have a different filename. Never overwrite or reuse this R1 filename.
