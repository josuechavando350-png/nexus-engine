# Originality Geodesics extension points

## Stable inputs

The canonical input point is derived from the complete `GeometricMetrics` vector and a Visual Algebra term digest. Higher layers must not substitute partial legacy projections as complete originality evidence.

## Reference roles

- `PROTECTED`: distance to these points is policy-enforced.
- `CONTEXT`: shapes the manifold but is not itself a protected target.
- `CANDIDATE`: never belongs to the frozen manifold; it is attached after manifold construction.

## Stable outputs

`OriginalityAssessment` exposes direct protected distance, geodesic protected distance, path witness, thresholds, status, candidate edges, manifold and deterministic assessment digest. `validateOriginalityAssessment()` rebuilds the manifold, candidate attachment and shortest-path result.

## Proof boundary

Proof-Carrying Experience may depend on this package and bind `assessmentDigest`. Originality Geodesics must never import the proof layer or Evidence.

## Measurement boundary

Measurement may project an assessment into samples. Originality Geodesics does not import Measurement.

## Counterfactual boundary

Counterfactual search accepts a finite list of caller-provided candidate points. It does not synthesize new metric vectors and does not assert that an arbitrary point in metric space corresponds to a realizable experience.
