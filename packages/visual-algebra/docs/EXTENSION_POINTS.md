# Visual Algebra extension points

This document defines the stable boundaries intended for downstream NEXUS engines. The purpose is to prevent higher layers from reaching into implementation details or creating circular dependencies.

## Primitive geometry boundary

Downstream consumers may depend on `Point`, `Bounds`, `GeometricPrimitive`, `PrimitiveKind`, `flattenPrimitives()`, `leafPrimitives()`, `primitiveCenter()` and `primitiveArea()`.

They must not assume browser DOM nodes, React components or CSS classes exist. Geometry is expressed only in caller-provided coordinates and downstream consumers must not mutate primitives.

## Metric boundary

Stable metric names:

- gridRegularity
- axialSymmetry
- whitespace
- continuity
- overlap
- structuralEntropy
- aspectConsistency
- packingDensity

All engine-produced values are finite and normalized to `[0,1]`. A future incompatible semantic change to an existing metric requires a versioned authority rather than silently reinterpreting historical values.

## VisualAlgebraTerm boundary

A term exposes subject, operation, canvas bounds, immutable primitive forest, eight metrics, constraints, evaluations and deterministic digest. Higher engines should consume this public result rather than recomputing hidden Visual Algebra state.

## Fingerprint boundary

`projectToStructureFields()` is a compatibility projection for the five structural fields planned for the NEXUS fingerprint family. There is currently no `StyleFingerprintV2` contract on `main`, so Visual Algebra intentionally does not fabricate or own that higher-level type.

When a canonical style fingerprint is added, the owning higher-level package should consume this projection or add a compile-time adapter. Visual Algebra must remain independent of that owner.

## Legacy boundary

`fromLegacyStructure()` explicitly represents partial historical knowledge. Consumers must inspect `availableMetrics` and `unavailableMetrics`. A legacy structure projection is not source geometry and must not be used as if primitives had been reconstructed.

## Existing Measurement integration

The repository's `@nexus/measurement` package is the first live consumer. It may convert a `VisualAlgebraTerm` into metric/evidence samples. Dependency direction is:

`@nexus/measurement -> @nexus/visual-algebra`

Visual Algebra must never import Measurement.

## Engine 2 — topology

Expected inputs: immutable primitives, leaf centers/bounds/kinds/hierarchy and term digest. Topological outputs should reference the source term digest. Dependency direction: `topology -> visual-algebra`.

## Engine 3 — compositional semantics

Expected inputs may include `GeometricMetrics`, structure projection and constraint evaluations. Semantic contracts may expose these as facts, but Visual Algebra remains unaware of semantic formula types.

## Engine 4 — proof-carrying experience

Proof evidence may carry term digest, geometric fingerprint, constraint evaluations and geometry-backed metrics. Proof Carrying Experience hashes and verifies that evidence; Visual Algebra does not import the proof layer.

## Engine 5 — originality geodesics

Expected inputs include the complete eight-dimensional metric vector and deterministic fingerprints/digests. Originality owns its own weights, reference sets, geodesic policy and thresholds. Visual Algebra does not decide originality.

## Deterministic encoding

`canonicalJson()` and `digestValue()` are public deterministic evidence primitives. Inputs intended to retain the same digest must not inject timestamps, random identifiers or unstable ordering.

## Dependency rule

The intended direction is:

`geometry -> visual algebra -> topology / semantics / measurement / originality -> proof carrying`

Do not invert that chain.
