# @nexus/visual-algebra

Deterministic geometric analysis for NEXUS experiences.

`@nexus/visual-algebra` converts explicit page geometry into a testable structural representation. It does not claim to judge aesthetic quality, semantic correctness, accessibility or originality by itself; it produces geometric evidence that higher NEXUS layers can consume.

## Capabilities

- rectangle, ellipse, line, polygon, text, image and nested container primitives
- finite-geometry validation and stable primitive identity
- bounds, centers, areas, intersections and exact union area for axis-aligned layout bounds
- deterministic flattening and leaf extraction
- eight normalized geometric metrics
- algebraic terms (`createTerm`, `sequence`, `nest`)
- structured min/max/range constraints
- weighted geometric distance and similarity
- geometry-backed fingerprint projection
- conservative legacy structure adapter
- deterministic canonical JSON + SHA-256 term digests

## Metrics

All engine-generated metrics are finite values in `[0,1]`.

### gridRegularity
Measures repeated alignment of left/center/right and top/center/bottom anchors. Peers within 1% of the smaller canvas dimension count as aligned.

### axialSymmetry
Reflects primitive centers around horizontal and vertical canvas axes and compares same-kind position and size. The stronger axis is returned. This is geometric axial symmetry, not semantic symmetry.

### whitespace
Fraction of the supplied canvas not occupied by the union of leaf layout bounds. Union area prevents overlapping elements from being counted twice.

### continuity
For each leaf: 60% nearest-neighbor proximity + 40% strongest X/Y center alignment. It measures geometric flow, not reading-order semantics.

### overlap
Redundant occupied footprint: `1 - unionArea / summedArea`. Separated elements score zero; repeated use of the same region raises the score.

### structuralEntropy
Normalized Shannon entropy over deterministic signatures made from primitive kind, relative-area bucket and aspect bucket.

### aspectConsistency
Consistency of log aspect ratios using `1 / (1 + standardDeviation)`. Log space makes reciprocal ratios symmetric around 1:1.

### packingDensity
Union occupied area divided by the tight content envelope area. Unlike whitespace, it is not page-canvas-relative.

## Geometry limitations

Metrics operate on explicit layout geometry. For ellipses, polygons, text and images, whitespace/overlap use axis-aligned layout bounds rather than raster alpha, glyph contours or image segmentation. Callers should supply the real viewport/canvas when page-relative whitespace matters.

## Algebra

`createTerm()` creates an atomic immutable term. `sequence()` combines complete primitive forests without moving them. `nest()` changes hierarchy by placing child term primitives under an explicit container; it does not invent coordinate transforms.

Every term carries its source geometry, eight metrics, constraint evaluations and a deterministic SHA-256 digest.

## Constraints

Constraints support a minimum, maximum or closed range on any known metric. Evaluation returns the original constraint, actual value, expected bounds, pass/fail and reason; it never collapses evidence to an unexplained boolean.

## Distance

`geometricDistance(a, b, weights)` is weighted normalized Euclidean distance over all eight dimensions:

`sqrt(sum(weight * delta^2) / sum(weight))`

It has identity and symmetry for the same weights. All supplied metrics must be finite and normalized; all weights must be finite/non-negative and at least one weight must be positive.

## Fingerprint projection

`projectToStructureFields()` maps measured geometry to:

```ts
{
  gridRegularity,
  symmetry: axialSymmetry,
  overlap,
  whitespace,
  continuity
}
```

The current NEXUS repository does **not** contain a canonical `StyleFingerprintV2`; this package therefore exposes a structural compatibility surface without pretending an absent contract already exists. When such a canonical contract is introduced, integration should bind to it from the higher-level owner without creating a dependency cycle.

## Legacy structures

`fromLegacyStructure()` carries only fields actually present in historical structure data. It never synthesizes primitives or guesses structural entropy, aspect consistency or packing density. Unknown metrics are reported in `unavailableMetrics`.

## Measurement integration

The live repository integration is owned by `@nexus/measurement`, which consumes a `VisualAlgebraTerm` and converts all eight metrics plus constraint status into deterministic `MetricSample` evidence. Dependency direction remains:

`measurement -> visual-algebra`

not the reverse.

## Determinism

Engine outputs do not depend on random UUIDs, `Math.random()`, wall-clock time, network state or unstable object-key ordering. Canonical hashing rejects undefined values, non-finite numbers and unsupported/non-plain objects instead of silently omitting them.

## Complexity

- flattening/basic geometry: O(n)
- rectangle union: worst-case O(n² log n)
- grid regularity: O(n²)
- axial symmetry: O(n²)
- continuity: O(n²)

The intended scale is page-level geometry (tens to hundreds of primitives), not scientific million-point clouds.

## Explicit non-claims

Visual Algebra does not prove aesthetic quality, semantic correctness, accessibility, legal originality or user intent. Those belong to higher NEXUS layers.
