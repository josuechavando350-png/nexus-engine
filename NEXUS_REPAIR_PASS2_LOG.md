# NEXUS — REPAIR PASS 2 LOG

Date: 2026-08-13
Baseline: `NEXUS_V6_REPAIR_PASS1.zip`
Scope: source-level hardening before first available Rust compiler.

No Rust PASS is claimed. All fixes below were reviewed statically and the executable architecture gates were rerun after modification.

## Repairs

- **R014 — Memory identity collision**: `InMemoryMemoryStore::put` is now idempotent only for identical content. Reusing the same memory ID with different content is rejected instead of silently rewriting provenance/history.
- **R015 — Goal store stale overwrite**: the in-memory goal store rejects time-regressive updates and history truncation; identical replays remain idempotent.
- **R016 — Reasoning temporal/budget validity**: reasoning budgets require positive step/time bounds and reasoning-step timestamps cannot move backwards.
- **R017 — Agent/delegation validation**: agent IDs and positive step budgets are validated; delegations require a non-empty task code before capability-subset checks.
- **R018 — Authentication-context validation**: principal ID, organization, authn strength, session ID, and issuance/expiry ordering are validated. `is_valid_at` fails closed for malformed contexts.
- **R019 — Resource-record invariants**: resource references, positive versions, timestamp ordering, and checked version increments are enforced. The saturating increment path was removed.
- **R020 — Registry validation before persistence**: every `ResourceRecord` is validated before optimistic-concurrency logic and storage.
- **R021 — API request metadata validation**: request ID must be present, API version must equal the supported contract, and an optional idempotency key may not be empty.
- **R022 — Control-plane preflight hardening**: request/authentication metadata are validated before authorization. Denied-request audit failures are surfaced rather than silently discarded. Archive performs an explicit expected-version check before mutation.
- **R023 — Consensus index overflow**: deterministic consensus uses checked increment and fails instead of repeating `u64::MAX` forever.
- **R024 — Replication idempotency collision**: `ReplicaState` now records the content hash for each idempotency key. Same key + same content is duplicate; same key + different content is an integrity error.
- **R025 — Offline journal identity collision**: offline op IDs are bound to payload hashes. Reuse with different content is rejected.
- **R026 — Offline acknowledgement bounds**: acknowledgement cannot move backwards or jump beyond the highest known journal sequence; acknowledged entries are pruned from the pending map.
- **R027 — Placement request validation**: workload ID, CPU request, and memory request must be valid before scheduling. Anti-affinity remains fail-closed without placement-state support.
- **R028 — Distribution request validation**: distributed scheduling now explicitly rejects an empty request ID before placement/consensus.
- **R029 — Goal timestamp coherence**: `Goal::validate` rejects `updated_at < created_at`.
- **R030 — Plan-node contract hardening**: plan nodes require non-empty action/capability/policy context, positive timeout, finite bounded confidence, evidence, unique IDs, valid dependencies, and an acyclic graph.
- **R031 — World-fact validation**: fact IDs are required and confidence must be finite and in [0,1].
- **R032 — Evaluator output validation**: all evaluator scores must be finite and in [0,1] before an evaluation is returned.
- **R033 — Node descriptor validation**: node ID, region, zone, CPU, and memory capacity are validated on cluster upsert and re-enrollment.
- **R034 — Commit-proof validity**: a proof additionally requires non-zero log index and term, not only a mathematical majority.
- **R035 — Discovery registration validation**: service key, node, protocol, lease expiry, and authority are required before endpoint registration.
- **R036 — Federation grant validation**: trust domains and grant ID are required, domains must differ, explicit resource/action scopes are mandatory, and expiry is required. `allows` fails closed if the grant itself is malformed.
- **R037 — Fleet rollout ring uniqueness**: duplicate target rings are rejected in addition to existing health/concurrency validation.

## Regression coverage added/extended

Source-level unit tests were added or extended for:
- memory ID collision;
- stale goal-store update;
- reasoning time regression;
- replication idempotency collision;
- offline op collision and invalid acknowledgement.

These tests are PRESENT but NOT EXECUTED until a Rust toolchain becomes available.

## Technology-freshness repair rule

A separate `NEXUS_REPAIR_PASS2_TECH_DEBT.md` records adapter upgrade order. We deliberately did not combine source repairs with major dependency upgrades while no compiler exists.
