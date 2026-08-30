# @nexus/compositional-semantics

Deterministic contract verification for composed NEXUS experiences.

## Purpose

Motor 3 consumes explicit state derived from Visual Algebra, Topology or caller-supplied facts/metrics and verifies machine-readable semantic contracts. It does not execute arbitrary JavaScript, infer user intent or claim aesthetic correctness.

Pipeline:

`engine evidence -> SemanticState -> composition contracts/effects -> VERIFIED | REJECTED -> deterministic certificate`

## Semantic state

State is a flat deterministic namespace:
- `facts`: string/number/boolean/null
- `metrics`: finite numbers

State keys are sorted before hashing and every state carries a SHA-256 digest through the canonical hashing implementation from Visual Algebra. The Visual Algebra adapter recomputes and validates the source term digest; when both Visual Algebra and Topology evidence are present, the adapter uses Topology's cross-engine provenance verifier rather than trusting matching digest labels.

The state boundary rejects reserved prototype keys (`__proto__`, `prototype`, `constructor`) and bounds the combined fact/metric count. Internal mutation maps use null prototypes so semantic input cannot mutate JavaScript object prototypes.

## Formula language

Safe AST only. Supported operators:
- `true`, `false`
- `exists`
- `compare`: `eq`, `neq`, `lt`, `lte`, `gt`, `gte`
- `not`, `and`, `or`, `implies`

There is no `eval`, dynamic code generation, network lookup or timestamp dependency. Missing operands make comparisons false; numeric order comparisons require both values to be numbers. Formula depth is bounded at 128 and each formula is bounded to 4,096 AST nodes.

## Effects

Steps can set/delete facts and set/add/min/max metrics. Arithmetic effects require the metric to already exist and every numeric result must remain finite.

## Composition semantics

- `step`: apply effects, then check invariants and ensures.
- `sequence`: execute children in order; parent invariants are checked on the final state.
- `parallel`: execute children from the same input state, canonicalized by child id, then merge their writes. Identical concurrent writes are allowed; conflicting writes reject the composition.
- `nest`: execute children in order and check the parent invariant after every child transition. This intentionally detects transient invariant violations that a plain sequence can permit before the final state.

All nodes check `requires` before execution. Failed child verification aborts its enclosing composition.

## Determinism and replay integrity

Node IDs are globally unique. Parallel branch order is canonical. Contract rules are evaluated in rule-id order. Sequence/nest child order and step-effect order remain semantic and are preserved.

A `VerificationResult` carries the exact composition it claims to verify. `validateVerificationResult()` does not trust a caller-recomputed status, final-state digest, issue list, trace or certificate. It validates the carried composition and initial state, recomputes the canonical composition digest, deterministically re-executes the composition under the carried policy, and requires the replayed status/final state/issues/trace to match before rebuilding the certificate.

This closes the rehash-only attack where mutually consistent outer SHA-256 values could previously describe evidence that was never produced by the semantic executor. SHA-256 remains an integrity checksum, not an authority signature; signed authority/provenance belongs to higher evidence layers.

Certificates bind:
- plan/subject
- canonical composition digest
- initial/final state digests
- verification status
- verification policy digest (`maxDepth`, `failFast`)
- issue digest
- trace digest

No random IDs or current timestamps are included.

## Runtime budgets

The fixed fail-closed limits are:
- composition depth: 128
- composition nodes: 4,096
- contract rules: 8,192
- effects: 16,384
- formula depth: 128
- formula nodes per formula: 4,096
- combined semantic-state entries: 16,384

These are deterministic engine limits, not caller-controlled knobs, so a certificate cannot silently opt into an unbounded verification workload.

## Limits and non-claims

This package verifies the explicit formal model supplied to it. It does not prove business truth, legal truth, accessibility, originality, intent or visual quality beyond facts and metrics encoded in that model.
