# @nexus/topology

Deterministic persistent-homology and certified-topology layer for NEXUS.

The package consumes immutable geometry from `@nexus/visual-algebra`, builds a filtered flag/Vietoris-Rips complex over leaf primitive centers, computes persistent homology over GF(2), compares persistence diagrams with bottleneck distance, derives a topological fingerprint and evaluates machine-readable constraints.

## Pipeline

`VisualAlgebraTerm -> filtered complex -> H0/H1 persistence -> bottleneck/fingerprint -> certified synthesis`

## Filtration

Every leaf primitive becomes one vertex at its bounds center. Containers remain hierarchy and do not become vertices. Pairwise Euclidean center distance is normalized by the canvas diagonal. Vertices appear at filtration `0`; edges appear at normalized pair distance; triangles appear at the maximum filtration of their three edges. The implementation keeps the 2-skeleton because H1 deaths require triangles.

Optional explicit `TopologicalRelation` values may make an edge appear earlier via `min(geometricDistance, relationFiltration)`. With relations the result is a relationally augmented filtered flag complex rather than a pure Vietoris-Rips complex.

## Persistent homology

`computePersistentHomology()` performs standard boundary-matrix column reduction over GF(2). Simplices are ordered by filtration, then dimension, then canonical simplex id so faces precede cofaces at equal filtration. The engine intentionally supports H0 and H1 only; it does not claim H2 support.

Finite intervals carry birth, death and lifetime. Essential intervals carry `death: null` and `persistence: null`. Zero-persistence intervals are retained in the raw diagram because they are legitimate persistence pairings, although they do not count as positive cycles in the fingerprint.

Both complexes and diagrams are digest-checked before downstream computation. Missing faces, invalid filtrations and tampered digests are rejected rather than silently analyzed.

## Bottleneck distance

Finite persistence points use exact threshold search over an augmented bipartite matching problem, including diagonal matching. Pair cost is the L-infinity distance between birth/death coordinates; diagonal cost is half the interval lifetime. Essential classes cannot be matched to the diagonal: differing essential counts yield infinite distance, while equal counts are optimally paired by sorted birth times.

## Fingerprint

The topological fingerprint exposes component count, positive H1 cycle count, observed total/max persistence, normalized persistence entropy, and H0/H1 summaries. Essential intervals are clipped to the configured filtration limit only for finite summary statistics; the raw diagram keeps their death as `null`.

## Certified synthesis

`synthesizeCertified()` and `synthesizeTermCertified()` evaluate required/recommended constraints including bottleneck separation, total persistence, cycle count and component count. Required failure => `REJECTED`; required evidence that cannot be evaluated => `NOT_TESTED`; otherwise => `CERTIFIED`. Recommended failures remain evidence but do not reject by themselves.

Certificates bind plan/subject, Visual Algebra source digest when present, complex digest, diagram digest, fingerprint digest, an input-order-invariant reference-set digest, evaluations and final status. They contain no random id, timestamp or network-derived state.

## Determinism and scale

Vertex/simplex/reference ordering is canonical; digests use Visual Algebra canonical SHA-256. Identical semantic inputs produce identical complex, diagram, fingerprint and certificate digests. Complexity is O(n²) for edges, O(n³) for triangles, worst-case cubic persistence reduction in simplex count, plus repeated bipartite matching for bottleneck distance. This is intended for page-level geometry (tens to low hundreds of primitives), not million-point scientific datasets.

## Non-claims

Topology here is topology of the supplied NEXUS geometric representation, not rendered pixel topology. Text glyph contours, image segmentation, alpha masks, aesthetic quality, semantic meaning and legal originality are not inferred.
