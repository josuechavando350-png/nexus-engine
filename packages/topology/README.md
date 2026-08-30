# @nexus/topology

Deterministic persistent-homology and certified-topology layer for NEXUS.

The package consumes immutable geometry from `@nexus/visual-algebra`, builds a filtered flag/Vietoris-Rips complex over leaf primitive centers, computes persistent homology over GF(2), compares persistence diagrams with bottleneck distance, derives a topological fingerprint and evaluates machine-readable constraints.

## Pipeline

`VisualAlgebraTerm -> filtered complex -> H0/H1 persistence -> bottleneck/fingerprint -> certified synthesis`

## Filtration

Every leaf primitive becomes one vertex at its bounds center. Containers remain hierarchy and do not become vertices. Pairwise Euclidean center distance is normalized by the canvas diagonal. Vertices appear at filtration `0`; edges appear at normalized pair distance; triangles appear at the maximum filtration of their three edges. The implementation keeps the 2-skeleton because H1 deaths require triangles.

Optional explicit `TopologicalRelation` values may make an edge appear earlier via `min(geometricDistance, relationFiltration)`. With relations the result is a relationally augmented filtered flag complex rather than a pure Vietoris-Rips complex.

Relations are normalized into a canonical undirected set: endpoints are sorted, duplicate pairs collapse to their earliest filtration, and the final list is stably ordered. The exact canonical relation set is carried inside the complex so a verifier can reconstruct the expected edges and triangles instead of trusting a caller-supplied simplex list.

## Persistent homology

`computePersistentHomology()` performs standard boundary-matrix column reduction over GF(2). Simplices are ordered by filtration, then dimension, then canonical simplex id so faces precede cofaces at equal filtration. The engine intentionally supports H0 and H1 only; it does not claim H2 support.

Finite intervals carry birth, death and lifetime. Essential intervals carry `death: null` and `persistence: null`. Zero-persistence intervals are retained in the raw diagram because they are legitimate persistence pairings, although they do not count as positive cycles in the fingerprint.

Complex validation now reconstructs the complete canonical flag complex from its vertices, canvas, normalized relations and filtration policy. A caller cannot insert/remove an edge or triangle, alter its filtration and simply recompute the outer SHA-256. Certified-result validation then recomputes the persistence diagram from that complex and recomputes the fingerprint from the resulting diagram.

## Bottleneck distance

Finite persistence points use exact threshold search over an augmented bipartite matching problem, including diagonal matching. Pair cost is the L-infinity distance between birth/death coordinates; diagonal cost is half the interval lifetime. Essential classes cannot be matched to the diagonal: differing essential counts yield infinite distance, while equal counts are optimally paired by sorted birth times.

Infinite bottleneck evidence is represented canonically in certified results (`actualInfinite: true` / `nearestBottleneckInfinite: true`) instead of placing JavaScript `Infinity` inside hashed JSON evidence.

## Fingerprint

The topological fingerprint exposes component count, positive H1 cycle count, observed total/max persistence, normalized persistence entropy, and H0/H1 summaries. Essential intervals are clipped to the configured filtration limit only for finite summary statistics; the raw diagram keeps their death as `null`.

`validateTopologicalFingerprint()` checks authority, digest lineage, count/summary invariants and finite normalized statistics. Fingerprint comparison validates both operands before computing similarity.

## Certified synthesis

`synthesizeCertified()` evaluates topology over raw geometry. It deliberately does **not** manufacture a Visual Algebra `sourceTermDigest`: raw geometry by itself cannot prove that it came from a specific Visual Algebra term.

`synthesizeTermCertified()` is the provenance-bearing entry point. It first executes `verifyVisualAlgebraTerm()`, requires the certificate subject to equal the term subject, and builds the complex from the verified term. `validateCertifiedSynthesisAgainstTerm()` independently rebuilds that complex from the carried Visual Algebra geometry and rejects a topology result whose points/relations/filtration do not match the term even if outer hashes were recomputed.

Required/recommended constraints include bottleneck separation, total persistence, cycle count and component count. Required failure => `REJECTED`; required evidence that cannot be evaluated => `NOT_TESTED`; otherwise => `CERTIFIED`. Recommended failures remain evidence but do not reject by themselves.

Certified results carry the canonical reference diagrams used for bottleneck constraints. Validation re-runs each constraint against those references, recomputes nearest-reference evidence and final status, verifies the reference-set digest, then verifies the certificate digest. This prevents a caller from changing a PASS/FAIL/NOT_TESTED result and merely rehashing the certificate.

Certificates bind plan/subject, Visual Algebra source digest when legitimately present, complex digest, diagram digest, fingerprint digest, the canonical reference-set digest, evaluations and final status. They contain no random id, timestamp or network-derived state.

## Downstream trust boundary

`@nexus/measurement` validates the complete certified result before projecting metrics. When Compositional Semantics has both Visual Algebra and Topology evidence, it uses `validateCertifiedSynthesisAgainstTerm()` rather than accepting matching digest labels alone. Proof-Carrying Experience uses the same cross-engine verifier before topology can participate in a formal experience proof.

A SHA-256 digest is an integrity checksum, not an authority signature. The topology layer proves deterministic consistency of the supplied geometry/reference evidence and configured constraints. Higher signed-evidence layers are responsible for authority/provenance outside this deterministic computation.

## Determinism and scale

Vertex/simplex/reference ordering is canonical; digests use Visual Algebra canonical SHA-256. Identical semantic inputs produce identical complex, diagram, fingerprint and certificate digests. Complexity is O(n²) for edges, O(n³) for triangles, worst-case cubic persistence reduction in simplex count, plus repeated bipartite matching for bottleneck distance. This is intended for page-level geometry (tens to low hundreds of primitives), not million-point scientific datasets.

## Non-claims

Topology here is topology of the supplied NEXUS geometric representation, not rendered pixel topology. Text glyph contours, image segmentation, alpha masks, aesthetic quality, semantic meaning and legal originality are not inferred. A `CERTIFIED` result means the verified topology satisfies the constraints that were actually supplied; it does not prove that an external policy supplied every constraint a product ought to require.
