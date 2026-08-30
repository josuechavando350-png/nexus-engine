# Originality Geodesics + Counterfactuals audit

Status: candidate certification; CI pending.

## Scope

Fresh Motor 5 integrity/certification review after the Proof-Carrying Experience trust-boundary merge.

## Findings

1. **Counterfactual realizability was overstated.** `searchOriginalityCounterfactual()` accepted arbitrary `OriginalityPoint` metric declarations. Those points are useful for deterministic point-space analysis, but a digest does not prove that their metric vector was derived from a realizable Visual Algebra term.
2. **The public graph helper trusted edge weights without checking `edgeDigest`.** Internal assessment edges were rebuilt, but direct callers of `shortestGeodesicPath()` could pass a structurally forged `OriginalityEdge`.
3. **Geometric metric objects were not shape-canonical.** The eight required values were checked, but extra keys were retained and hashed even though distance computation ignored them, allowing multiple point digests for the same effective eight-dimensional geometry.
4. **Work was unbounded.** Manifold construction is quadratic and counterfactual search repeats assessments; there were no explicit corpus, neighborhood, graph or alternative-count budgets.
5. **Assessment reran Dijkstra separately for every protected point.** This multiplied deterministic graph work unnecessarily and amplified the unbounded-work issue.

## Hardening implemented

- raw point metrics must be a plain object containing exactly the eight canonical Visual Algebra metrics;
- `validateOriginalityEdge()` rebuilds endpoints/weight/digest, and public geodesic helpers reject forged or duplicate edges;
- `shortestGeodesicPaths()` performs one deterministic single-source traversal for all protected targets; assessment now uses that path;
- explicit fail-closed limits bound manifold points, k-neighbors, counterfactual alternatives and public graph node/edge counts;
- `searchOriginalityCounterfactual()` is documented as point-space analysis only;
- `searchVerifiedOriginalityCounterfactual()` accepts actual `VisualAlgebraTerm` values, verifies them against source geometry, derives candidate points internally and binds term digests plus the point-search digest;
- `validateVerifiedOriginalityCounterfactual()` independently replays the term-backed counterfactual path;
- null/object guards were added to major public validation boundaries.

## Adversarial coverage

The audit suite covers:

- extra/ignored metric dimensions;
- forged edge digests;
- deterministic multi-target shortest paths;
- work-budget overflow;
- term-backed counterfactual replay;
- forged Visual Algebra metrics in a supposedly term-backed alternative.

## Direct consumers

- `packages/measurement/originality-geodesics.ts` calls `validateOriginalityAssessment()` before projecting metrics.
- Proof-Carrying Experience validates the carried Motor 5 assessment and requires `CLEAR` for the originality-separation claim; `TOO_CLOSE` and `UNASSESSED` remain fail-closed.

## Acceptance gates

1. Package typecheck/test/build and direct-consumer tests must pass.
2. Exact final head must pass NEXUS Real Browser Capture Validation, NEXUS Full Validation, NEXUS H07 Clean-Room Operability Proof and NEXUS Baseline Validation.
3. Final PR diff must remain scoped to Motor 5 and direct integration surface.
4. Merge only after all gates are green on the same head SHA.

## Limits / non-claims

No result from this motor is a legal originality, copyright, plagiarism, authorship, aesthetic-quality, semantic-novelty or independent-creation determination. A `CLEAR` result remains conditional on the supplied reference corpus, Visual Algebra feature space, weights, k and thresholds.
