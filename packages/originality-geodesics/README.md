# @nexus/originality-geodesics

Motor 5 measures structural separation in the eight-dimensional metric space produced by `@nexus/visual-algebra`. It builds a deterministic k-nearest-neighbor reference manifold, computes shortest paths with Dijkstra, evaluates distance from protected references, and searches only caller-provided counterfactual candidates.

## Safety model

A candidate is `CLEAR` only when both conditions hold:

1. its direct weighted metric distance to every protected reference is at least `minimumProtectedDirect`; and
2. its shortest reachable graph-geodesic distance to protected references is at least `minimumProtectedGeodesic`.

A long or disconnected graph path can therefore never hide direct proximity. If the candidate cannot reach any protected reference through the frozen reference manifold, the result is `UNASSESSED`, never `CLEAR`.

## Frozen reference manifold

The manifold contains only `PROTECTED` and `CONTEXT` points. Candidate points are attached to their k nearest manifold points without modifying manifold-to-manifold edges. This prevents the set or ordering of candidates from changing the protected reference geometry.

kNN construction is deterministic:

- points are canonicalized by `pointId`;
- ties are broken by `pointId`;
- directed neighbor selections are converted to a canonical undirected union graph;
- edge weights use the complete eight-dimensional Visual Algebra metric vector;
- policy, points, edges, manifold and assessments have deterministic SHA-256 digests.

## Counterfactual search

`searchOriginalityCounterfactual()` does not invent geometry or layouts. It assesses only caller-provided, realizable candidate points and chooses the smallest weighted metric displacement that reaches `CLEAR`, with `pointId` as the deterministic tie-breaker.

## Proof-Carrying Experience integration

Motor 5 is intended to sit between Visual Algebra and Proof-Carrying Experience:

`visual-algebra -> originality-geodesics -> proof-carrying-experience`

A proof layer may carry the assessment digest and independently call `validateOriginalityAssessment()` before accepting the originality claim.

## Complexity

For `n` manifold points, graph construction performs O(n²) pairwise metric comparisons and O(n² log n) straightforward ranking. Dijkstra uses a deterministic O(V² + E) implementation. This package intentionally favors auditability and stable ordering over asymptotically complex data structures at current NEXUS corpus sizes.

## Non-claims

This motor does **not** prove legal originality, copyright non-infringement, plagiarism absence, aesthetic quality, semantic novelty, authorship, or independence of creation. Results are conditional on the selected Visual Algebra features, weights, k, thresholds and coverage of the reference set. Protected references are comparison data, not a legal database.
