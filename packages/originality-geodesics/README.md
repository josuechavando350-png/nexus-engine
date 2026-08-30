# @nexus/originality-geodesics

Motor 5 measures structural separation in the eight-dimensional metric space produced by `@nexus/visual-algebra`. It builds a deterministic k-nearest-neighbor reference manifold, computes shortest paths, evaluates distance from protected references, and can evaluate caller-provided counterfactual candidates.

## Safety model

A candidate is `CLEAR` only when both conditions hold:

1. its direct weighted metric distance to every protected reference is at least `minimumProtectedDirect`; and
2. its shortest reachable graph-geodesic distance to protected references is at least `minimumProtectedGeodesic`.

A long or disconnected graph path can therefore never hide direct proximity. If the candidate cannot reach any protected reference through the frozen reference manifold, the result is `UNASSESSED`, never `CLEAR`. An exact protected metric match is always `TOO_CLOSE`, including when configured thresholds are zero.

## Integrity boundary

Motor 5 does not trust carried digests by themselves.

- points are rebuilt and require exactly the eight canonical Visual Algebra metrics;
- manifolds rebuild canonical points and kNN edges;
- assessments rerun direct and graph distance computation;
- counterfactual results replay every carried assessment and selection;
- public graph helpers validate canonical edge endpoints, weights and edge digests before using them;
- candidates created with `originalityPointFromTerm()` first pass `verifyVisualAlgebraTerm()`, which recomputes Visual Algebra metrics from source geometry.

A caller-created `OriginalityPoint` is a metric-space declaration. Its digest proves the declaration was not silently modified; it does **not** prove that the declared metrics came from a realizable layout.

## Frozen reference manifold

The manifold contains only `PROTECTED` and `CONTEXT` points. Candidate points are attached to their k nearest manifold points without modifying manifold-to-manifold edges. This prevents the set or ordering of candidates from changing the protected reference geometry.

kNN construction is deterministic:

- points are canonicalized by `pointId`;
- ties are broken by `pointId`;
- directed neighbor selections are converted to a canonical undirected union graph;
- edge weights use the complete eight-dimensional Visual Algebra metric vector;
- policy, points, edges, manifold and assessments have deterministic SHA-256 digests.

Assessment computes all protected-target shortest paths from one deterministic single-source traversal rather than rerunning Dijkstra independently for every protected point.

## Counterfactual search

`searchOriginalityCounterfactual()` is a **point-space** search. It assesses only caller-provided `OriginalityPoint` alternatives and chooses the smallest weighted metric displacement that reaches `CLEAR`, with `pointId` as the deterministic tie-breaker. Because a raw point may be a metric declaration, this API must not be described as proof that the selected counterfactual is realizable geometry.

For a term-backed counterfactual claim, use `searchVerifiedOriginalityCounterfactual()`. It accepts actual `VisualAlgebraTerm` values, verifies each term against source geometry, derives the candidate points itself, runs the same deterministic point-space search, and binds the source term digest, alternative term digests and point-search digest into `verifiedSearchDigest`. `validateVerifiedOriginalityCounterfactual()` replays that full term-backed path.

This still proves only that the supplied Visual Algebra terms are internally valid geometric terms and satisfy the configured Motor 5 separation policy. It does not prove design quality or legal originality.

## Explicit work budgets

The in-memory deterministic implementation fails closed above explicit budgets to prevent unbounded quadratic graph construction/search work:

- manifold points: `MAX_ORIGINALITY_MANIFOLD_POINTS`;
- k-neighbors: `MAX_ORIGINALITY_K_NEIGHBORS`;
- caller-provided counterfactual alternatives: `MAX_ORIGINALITY_COUNTERFACTUAL_ALTERNATIVES`;
- public geodesic node/edge counts: `MAX_ORIGINALITY_GEODESIC_NODES` and `MAX_ORIGINALITY_GEODESIC_EDGES`.

These are execution-safety limits, not mathematical claims about the ideal size of a reference corpus.

## Proof-Carrying Experience integration

Motor 5 sits between Visual Algebra and Proof-Carrying Experience:

`visual-algebra -> originality-geodesics -> proof-carrying-experience`

Proof-Carrying Experience carries the assessment and independently calls `validateOriginalityAssessment()` before accepting the structural originality-separation claim. A `CLEAR` assessment is necessary for the current complete proof; `TOO_CLOSE` and `UNASSESSED` fail closed.

## Complexity

For `n` manifold points, graph construction performs O(n²) pairwise metric comparisons and straightforward deterministic ranking. An assessment performs one deterministic single-source graph traversal after candidate attachment. Counterfactual search repeats a bounded assessment for each caller-provided alternative. The package favors auditability and stable ordering over asymptotically complex data structures at current NEXUS corpus sizes, with hard work budgets enforced at runtime.

## Non-claims

This motor does **not** prove legal originality, copyright non-infringement, plagiarism absence, aesthetic quality, semantic novelty, authorship, or independence of creation. Results are conditional on the selected Visual Algebra features, weights, k, thresholds and coverage of the reference set. Protected references are comparison data, not a legal database.
