import { describe, expect, test } from "vitest";
import {
  aspectConsistency,
  axialSymmetry,
  canonicalJson,
  compareGeometricFingerprints,
  computeGeometricMetrics,
  continuity,
  createGeometricFingerprint,
  createTerm,
  definePrimitive,
  digestValue,
  flattenPrimitives,
  fromLegacyStructure,
  geometricDistance,
  gridRegularity,
  intersectionArea,
  leafPrimitives,
  nest,
  overlap,
  packingDensity,
  primitiveArea,
  primitiveCenter,
  projectToStructureFields,
  rectangleUnionArea,
  sequence,
  structuralEntropy,
  termSatisfiesConstraints,
  unionBounds,
  whitespace,
} from "../index.js";
import type { Bounds, GeometricPrimitive } from "../index.js";

const canvas: Bounds = { x: 0, y: 0, width: 100, height: 100 };

const rectangle = (
  id: string,
  x: number,
  y: number,
  width: number,
  height: number,
): GeometricPrimitive => definePrimitive({ id, kind: "rectangle", bounds: { x, y, width, height } });

describe("primitives", () => {
  test("validates, freezes and measures primitives", () => {
    const primitive = rectangle("hero", 10, 20, 30, 40);
    expect(Object.isFrozen(primitive)).toBe(true);
    expect(primitiveArea(primitive)).toBe(1200);
    expect(primitiveCenter(primitive)).toEqual({ x: 25, y: 40 });
    expect(() => rectangle("bad", 0, 0, -1, 10)).toThrow(/negative/);
    expect(() => rectangle("nan", 0, 0, Number.NaN, 10)).toThrow(/finite/);
  });

  test("derives line and polygon geometry", () => {
    const line = definePrimitive({ id: "line", kind: "line", start: { x: 10, y: 5 }, end: { x: 30, y: 25 } });
    const polygon = definePrimitive({
      id: "poly",
      kind: "polygon",
      points: [{ x: 0, y: 0 }, { x: 20, y: 0 }, { x: 10, y: 10 }],
    });
    expect(line.bounds).toEqual({ x: 10, y: 5, width: 20, height: 20 });
    expect(polygon.bounds).toEqual({ x: 0, y: 0, width: 20, height: 10 });
    expect(primitiveArea(polygon)).toBe(100);
    expect(() => definePrimitive({ id: "bad-poly", kind: "polygon", points: [{ x: 0, y: 0 }, { x: 1, y: 1 }] })).toThrow(/three/);
  });

  test("computes intersections and union area without edge-touch false positives", () => {
    const a = rectangle("a", 0, 0, 20, 20);
    const b = rectangle("b", 10, 0, 20, 20);
    const c = rectangle("c", 20, 0, 20, 20);
    expect(intersectionArea(a, b)).toBe(200);
    expect(intersectionArea(a, c)).toBe(0);
    expect(rectangleUnionArea([{ x: 0, y: 0, width: 10, height: 10 }, { x: 5, y: 0, width: 10, height: 10 }])).toBe(150);
  });

  test("flattens nested containers deterministically", () => {
    const root = definePrimitive({
      id: "root",
      kind: "container",
      children: [
        { id: "a", kind: "rectangle", bounds: { x: 0, y: 0, width: 10, height: 10 } },
        { id: "nested", kind: "container", children: [{ id: "b", kind: "ellipse", bounds: { x: 20, y: 0, width: 10, height: 10 } }] },
      ],
    });
    expect(flattenPrimitives([root]).map((item) => item.id)).toEqual(["root", "a", "nested", "b"]);
    expect(leafPrimitives([root]).map((item) => item.id)).toEqual(["a", "b"]);
    expect(unionBounds(leafPrimitives([root]).map((item) => item.bounds))).toEqual({ x: 0, y: 0, width: 30, height: 10 });
  });

  test("rejects duplicate ids across nested trees", () => {
    expect(() => createTerm({
      subject: "dupes",
      primitives: [
        rectangle("same", 0, 0, 10, 10),
        { id: "group", kind: "container", children: [{ id: "same", kind: "text", bounds: { x: 20, y: 0, width: 10, height: 10 } }] },
      ],
    })).toThrow(/Duplicate primitive id/);
  });
});

describe("eight geometric metrics", () => {
  test("regular grid scores above irregular placement", () => {
    const grid = [rectangle("g1", 0, 0, 20, 20), rectangle("g2", 50, 0, 20, 20), rectangle("g3", 0, 50, 20, 20), rectangle("g4", 50, 50, 20, 20)];
    const irregular = [rectangle("r1", 3, 7, 17, 13), rectangle("r2", 31, 18, 19, 11), rectangle("r3", 62, 47, 14, 20), rectangle("r4", 79, 73, 12, 9)];
    expect(gridRegularity(grid, canvas)).toBeGreaterThan(gridRegularity(irregular, canvas));
  });

  test("symmetric layout scores above asymmetric layout", () => {
    const symmetric = [rectangle("a", 10, 20, 20, 20), rectangle("b", 70, 20, 20, 20)];
    const asymmetric = [rectangle("c", 10, 20, 20, 20), rectangle("d", 55, 70, 30, 10)];
    expect(axialSymmetry(symmetric, canvas)).toBeCloseTo(1);
    expect(axialSymmetry(symmetric, canvas)).toBeGreaterThan(axialSymmetry(asymmetric, canvas));
  });

  test("whitespace and overlap use union area", () => {
    expect(whitespace([], canvas)).toBe(1);
    expect(whitespace([rectangle("half", 0, 0, 50, 100)], canvas)).toBeCloseTo(0.5);
    expect(overlap([rectangle("a", 0, 0, 20, 20), rectangle("b", 40, 0, 20, 20)], canvas)).toBe(0);
    expect(overlap([rectangle("c", 0, 0, 50, 50), rectangle("d", 25, 0, 50, 50)], canvas)).toBeGreaterThan(0);
  });

  test("continuity, entropy, aspect consistency and packing density react to structure", () => {
    const flowing = [rectangle("f1", 0, 0, 20, 20), rectangle("f2", 25, 0, 20, 20), rectangle("f3", 50, 0, 20, 20)];
    const scattered = [rectangle("s1", 0, 0, 20, 20), rectangle("s2", 75, 65, 20, 20), rectangle("s3", 10, 80, 10, 10)];
    expect(continuity(flowing, canvas)).toBeGreaterThan(continuity(scattered, canvas));

    const homogeneous = [rectangle("h1", 0, 0, 10, 10), rectangle("h2", 20, 0, 10, 10), rectangle("h3", 40, 0, 10, 10)];
    const heterogeneous = [
      rectangle("x1", 0, 0, 10, 10),
      definePrimitive({ id: "x2", kind: "ellipse", bounds: { x: 20, y: 0, width: 30, height: 10 } }),
      definePrimitive({ id: "x3", kind: "text", bounds: { x: 0, y: 30, width: 8, height: 30 } }),
    ];
    expect(structuralEntropy(homogeneous, canvas)).toBe(0);
    expect(structuralEntropy(heterogeneous, canvas)).toBeGreaterThan(0);

    expect(aspectConsistency([rectangle("q1", 0, 0, 20, 20), rectangle("q2", 30, 0, 40, 40)], canvas)).toBe(1);
    expect(aspectConsistency([rectangle("z1", 0, 0, 10, 100), rectangle("z2", 20, 0, 100, 10)], canvas)).toBeLessThan(1);

    const dense = [rectangle("d1", 0, 0, 50, 50), rectangle("d2", 50, 0, 50, 50)];
    const sparse = [rectangle("p1", 0, 0, 10, 10), rectangle("p2", 90, 90, 10, 10)];
    expect(packingDensity(dense, canvas)).toBeCloseTo(1);
    expect(packingDensity(dense, canvas)).toBeGreaterThan(packingDensity(sparse, canvas));
  });

  test("all eight metrics remain finite and normalized", () => {
    const metrics = computeGeometricMetrics([rectangle("a", 0, 0, 30, 30), rectangle("b", 20, 20, 40, 10)], canvas);
    expect(Object.keys(metrics).sort()).toEqual([
      "aspectConsistency", "axialSymmetry", "continuity", "gridRegularity",
      "overlap", "packingDensity", "structuralEntropy", "whitespace",
    ]);
    for (const value of Object.values(metrics)) {
      expect(Number.isFinite(value)).toBe(true);
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThanOrEqual(1);
    }
  });
});

describe("algebra and deterministic digests", () => {
  test("same semantic input gets the same canonical JSON and digest", () => {
    expect(canonicalJson({ b: 2, a: 1 })).toBe(canonicalJson({ a: 1, b: 2 }));
    expect(digestValue({ b: 2, a: 1 })).toBe(digestValue({ a: 1, b: 2 }));
    expect(() => canonicalJson({ invalid: undefined })).toThrow(/undefined/);
    expect(() => canonicalJson(Number.POSITIVE_INFINITY)).toThrow(/non-finite/);
  });

  test("createTerm is deterministic and constraints are structured", () => {
    const input = {
      subject: "client-x",
      canvasBounds: canvas,
      primitives: [rectangle("a", 0, 0, 50, 100)],
      constraints: [{ id: "white-range", metric: "whitespace" as const, min: 0.4, max: 0.6 }],
    };
    const first = createTerm(input);
    const second = createTerm(input);
    expect(first.digest).toBe(second.digest);
    expect(first.evaluations[0]).toMatchObject({ pass: true, actual: 0.5 });
    expect(termSatisfiesConstraints(first)).toBe(true);
  });

  test("sequence and nest preserve caller geometry instead of inventing coordinates", () => {
    const left = createTerm({ subject: "left", primitives: [rectangle("a", 0, 0, 10, 10)] });
    const right = createTerm({ subject: "right", primitives: [rectangle("b", 20, 0, 10, 10)] });
    const combined = sequence({ subject: "combined", terms: [left, right], canvasBounds: canvas });
    expect(combined.primitives.map((primitive) => primitive.id)).toEqual(["a", "b"]);

    const nested = nest({
      subject: "nested",
      container: { id: "container", kind: "container", bounds: canvas, children: [] },
      terms: [left],
      canvasBounds: canvas,
    });
    expect(leafPrimitives(nested.primitives)[0]?.bounds).toEqual(left.primitives[0]?.bounds);
  });
});

describe("distance and fingerprint bridges", () => {
  test("distance satisfies identity, symmetry and weights", () => {
    const zero = { gridRegularity: 0, axialSymmetry: 0, whitespace: 0, continuity: 0, overlap: 0, structuralEntropy: 0, aspectConsistency: 0, packingDensity: 0 };
    const changed = { ...zero, whitespace: 1 };
    expect(geometricDistance(zero, zero).distance).toBe(0);
    expect(geometricDistance(zero, changed).distance).toBeCloseTo(geometricDistance(changed, zero).distance);
    expect(geometricDistance(zero, changed, {
      gridRegularity: 0, axialSymmetry: 0, continuity: 0, overlap: 0,
      structuralEntropy: 0, aspectConsistency: 0, packingDensity: 0, whitespace: 1,
    }).distance).toBe(1);
    expect(() => geometricDistance(zero, changed, { whitespace: -1 })).toThrow(/non-negative/);
  });

  test("projects measured structure and compares fingerprints", () => {
    const term = createTerm({ subject: "fp", primitives: [rectangle("a", 0, 0, 20, 20)], canvasBounds: canvas });
    const structure = projectToStructureFields(term.metrics);
    expect(structure.symmetry).toBe(term.metrics.axialSymmetry);
    const fingerprint = createGeometricFingerprint(term);
    expect(fingerprint.authority).toBe("NEXUS_VISUAL_ALGEBRA_V1");
    expect(compareGeometricFingerprints(fingerprint, fingerprint)).toBe(1);
  });

  test("legacy bridge never invents unavailable metrics or geometry", () => {
    const legacy = fromLegacyStructure({ gridRegularity: 0.7, symmetry: 0.6 });
    expect(legacy.metrics.gridRegularity).toBe(0.7);
    expect(legacy.metrics.axialSymmetry).toBe(0.6);
    expect(legacy.metrics.structuralEntropy).toBeUndefined();
    expect(legacy.unavailableMetrics).toContain("packingDensity");
    expect(legacy.warnings.join(" ")).toMatch(/No geometric primitives/);
  });
});
