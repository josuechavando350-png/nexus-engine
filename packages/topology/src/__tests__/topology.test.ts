import { describe, expect, test } from "vitest";
import { createTerm, definePrimitive, digestValue } from "@nexus/visual-algebra";
import {
  bottleneckDistance,
  buildComplexFromTerm,
  buildFiltrationComplex,
  buildVietorisRipsComplex,
  computePersistentHomology,
  createTopologicalFingerprint,
  synthesizeCertified,
  synthesizeTermCertified,
  validatePersistenceDiagram,
} from "../index.js";
import type { PersistenceDiagram } from "../index.js";

const canvas = { x: 0, y: 0, width: 100, height: 100 } as const;
const point = (id: string, x: number, y: number) => definePrimitive({ id, kind: "rectangle", bounds: { x, y, width: 0, height: 0 } });

function fixtureDiagram(intervals: PersistenceDiagram["intervals"]): PersistenceDiagram {
  const base = {
    authority: "NEXUS_PERSISTENCE_DIAGRAM_V1" as const,
    sourceComplexDigest: "a".repeat(64),
    maxDimension: 1 as const,
    filtrationLimit: 1,
    intervals,
  };
  return { ...base, digest: digestValue(base) };
}

describe("filtered complex", () => {
  test("is deterministic and input-order invariant", () => {
    const a = point("a", 0, 0); const b = point("b", 20, 0); const c = point("c", 10, 10);
    const first = buildVietorisRipsComplex({ primitives: [a, b, c], canvasBounds: canvas });
    const second = buildVietorisRipsComplex({ primitives: [c, a, b], canvasBounds: canvas });
    expect(first.digest).toBe(second.digest);
    expect(first.vertices.map((vertex) => vertex.id)).toEqual(["a", "b", "c"]);
  });

  test("respects max filtration and permits explicit relations to appear earlier", () => {
    const noRelation = buildVietorisRipsComplex({ primitives: [point("a", 0, 0), point("b", 100, 100)], canvasBounds: canvas, maxFiltration: 0.2 });
    expect(noRelation.simplices.filter((simplex) => simplex.dimension === 1)).toHaveLength(0);

    const related = buildFiltrationComplex({
      primitives: [point("a", 0, 0), point("b", 100, 100)], canvasBounds: canvas, maxFiltration: 0.2,
      relations: [{ sourceId: "a", targetId: "b", filtration: 0.1 }],
    });
    const edge = related.simplices.find((simplex) => simplex.dimension === 1);
    expect(edge?.filtration).toBeCloseTo(0.1);
  });

  test("rejects invalid relations and degenerate canvas", () => {
    expect(() => buildFiltrationComplex({ primitives: [point("a", 0, 0)], canvasBounds: { x: 0, y: 0, width: 0, height: 100 } })).toThrow(/positive width and height/);
    expect(() => buildFiltrationComplex({ primitives: [point("a", 0, 0)], canvasBounds: canvas, relations: [{ sourceId: "a", targetId: "missing", filtration: 0.1 }] })).toThrow(/unknown primitive/);
    expect(() => buildFiltrationComplex({ primitives: [point("a", 0, 0)], canvasBounds: canvas, relations: [{ sourceId: "a", targetId: "a", filtration: 0.1 }] })).toThrow(/self-relations/);
  });

  test("retains Visual Algebra provenance", () => {
    const term = createTerm({ subject: "client/home", canvasBounds: canvas, primitives: [point("a", 0, 0), point("b", 10, 0)] });
    expect(buildComplexFromTerm(term).sourceTermDigest).toBe(term.digest);
  });
});

describe("persistent homology over GF(2)", () => {
  test("one point produces one essential H0 class", () => {
    const diagram = computePersistentHomology(buildVietorisRipsComplex({ primitives: [point("a", 0, 0)], canvasBounds: canvas }));
    expect(diagram.intervals).toEqual([expect.objectContaining({ dimension: 0, birth: 0, death: null })]);
  });

  test("two points merge to one essential component", () => {
    const diagram = computePersistentHomology(buildVietorisRipsComplex({ primitives: [point("a", 0, 0), point("b", 50, 0)], canvasBounds: canvas }));
    const h0 = diagram.intervals.filter((interval) => interval.dimension === 0);
    expect(h0).toHaveLength(2);
    expect(h0.filter((interval) => interval.death === null)).toHaveLength(1);
    expect(h0.filter((interval) => interval.death !== null)).toHaveLength(1);
  });

  test("square has one positive H1 class born on sides and killed by filling triangles", () => {
    const diagram = computePersistentHomology(buildVietorisRipsComplex({
      primitives: [point("a", 0, 0), point("b", 1, 0), point("c", 1, 1), point("d", 0, 1)],
      canvasBounds: { x: 0, y: 0, width: 1, height: 1 },
    }));
    const positiveH1 = diagram.intervals.filter((interval) => interval.dimension === 1 && (interval.persistence ?? 0) > 1e-10);
    expect(positiveH1).toHaveLength(1);
    expect(positiveH1[0]?.birth).toBeCloseTo(1 / Math.sqrt(2));
    expect(positiveH1[0]?.death).toBeCloseTo(1);
  });

  test("filled triangle creates no positive-lifetime H1 class", () => {
    const diagram = computePersistentHomology(buildVietorisRipsComplex({
      primitives: [point("a", 0, 0), point("b", 1, 0), point("c", 0.5, Math.sqrt(3) / 2)],
      canvasBounds: { x: 0, y: 0, width: 1, height: 1 },
    }));
    expect(diagram.intervals.filter((interval) => interval.dimension === 1 && (interval.persistence ?? 0) > 1e-10)).toHaveLength(0);
  });

  test("rejects tampered complex and diagram digests", () => {
    const complex = buildVietorisRipsComplex({ primitives: [point("a", 0, 0)], canvasBounds: canvas });
    expect(() => computePersistentHomology({ ...complex, digest: "0".repeat(64) })).toThrow(/digest mismatch/);
    const diagram = computePersistentHomology(complex);
    expect(() => validatePersistenceDiagram({ ...diagram, digest: "0".repeat(64) })).toThrow(/digest mismatch/);
  });
});

describe("bottleneck distance", () => {
  test("has identity and symmetry", () => {
    const left = fixtureDiagram([{ dimension: 1, birth: 0, death: 0.4, birthSimplexId: "a", deathSimplexId: "ad", persistence: 0.4 }]);
    const right = fixtureDiagram([{ dimension: 1, birth: 0, death: 0.6, birthSimplexId: "b", deathSimplexId: "bd", persistence: 0.6 }]);
    expect(bottleneckDistance(left, left, 1).distance).toBe(0);
    expect(bottleneckDistance(left, right, 1).distance).toBeCloseTo(bottleneckDistance(right, left, 1).distance);
    expect(bottleneckDistance(left, right, 1).distance).toBeCloseTo(0.2);
  });

  test("matches finite classes to diagonal", () => {
    const left = fixtureDiagram([{ dimension: 1, birth: 0, death: 0.4, birthSimplexId: "a", deathSimplexId: "ad", persistence: 0.4 }]);
    expect(bottleneckDistance(left, fixtureDiagram([]), 1).distance).toBeCloseTo(0.2);
  });

  test("essential class count mismatch is infinite", () => {
    const left = fixtureDiagram([{ dimension: 0, birth: 0, death: null, birthSimplexId: "a", persistence: null }]);
    expect(bottleneckDistance(left, fixtureDiagram([]), 0).distance).toBe(Number.POSITIVE_INFINITY);
  });
});

describe("fingerprint and certified synthesis", () => {
  test("summarizes topology deterministically", () => {
    const diagram = computePersistentHomology(buildVietorisRipsComplex({ primitives: [point("a", 0, 0), point("b", 10, 0)], canvasBounds: canvas }));
    const first = createTopologicalFingerprint(diagram); const second = createTopologicalFingerprint(diagram);
    expect(first.digest).toBe(second.digest);
    expect(first.componentCount).toBe(1);
    expect(first.authority).toBe("NEXUS_TOPOLOGICAL_FINGERPRINT_V1");
  });

  test("certifies, rejects and reports untestable required constraints", () => {
    const primitives = [point("a", 0, 0), point("b", 20, 0)];
    expect(synthesizeCertified({ planId: "ok", subject: "candidate", primitives, canvasBounds: canvas,
      constraints: [{ id: "connected", kind: "max_component_count", value: 1, severity: "required" }] }).status).toBe("CERTIFIED");
    expect(synthesizeCertified({ planId: "reject", subject: "candidate", primitives, canvasBounds: canvas,
      constraints: [{ id: "cycles", kind: "min_cycle_count", value: 1, severity: "required" }] }).status).toBe("REJECTED");
    expect(synthesizeCertified({ planId: "unknown", subject: "candidate", primitives, canvasBounds: canvas,
      constraints: [{ id: "distance", kind: "min_bottleneck_distance", value: 0.1, severity: "required" }] }).status).toBe("NOT_TESTED");
  });

  test("identical protected topology fails a required minimum bottleneck distance", () => {
    const primitives = [point("a", 0, 0), point("b", 20, 0)];
    const reference = computePersistentHomology(buildVietorisRipsComplex({ primitives, canvasBounds: canvas }));
    const result = synthesizeCertified({ planId: "originality", subject: "candidate", primitives, canvasBounds: canvas,
      referenceDiagrams: [{ id: "protected", diagram: reference }],
      constraints: [{ id: "distance", kind: "min_bottleneck_distance", value: 0.1, severity: "required" }] });
    expect(result.nearestBottleneckDistance).toBe(0);
    expect(result.status).toBe("REJECTED");
  });

  test("reference-set digest and certificate are independent of reference input order", () => {
    const candidate = [point("a", 0, 0), point("b", 20, 0)];
    const refA = computePersistentHomology(buildVietorisRipsComplex({ primitives: [point("x", 0, 0)], canvasBounds: canvas }));
    const refB = computePersistentHomology(buildVietorisRipsComplex({ primitives: [point("x", 0, 0), point("y", 40, 0)], canvasBounds: canvas }));
    const common = { planId: "stable", subject: "candidate", primitives: candidate, canvasBounds: canvas } as const;
    const first = synthesizeCertified({ ...common, referenceDiagrams: [{ id: "a", diagram: refA }, { id: "b", diagram: refB }] });
    const second = synthesizeCertified({ ...common, referenceDiagrams: [{ id: "b", diagram: refB }, { id: "a", diagram: refA }] });
    expect(first.certificate.referenceSetDigest).toBe(second.certificate.referenceSetDigest);
    expect(first.certificate.certificateDigest).toBe(second.certificate.certificateDigest);
  });

  test("integrates directly from VisualAlgebraTerm and preserves its digest", () => {
    const term = createTerm({ subject: "client/home", canvasBounds: canvas, primitives: [point("a", 0, 0), point("b", 20, 0)] });
    const result = synthesizeTermCertified({ planId: "term", term, constraints: [{ id: "components", kind: "max_component_count", value: 1, severity: "required" }] });
    expect(result.complex.sourceTermDigest).toBe(term.digest);
    expect(result.certificate.sourceTermDigest).toBe(term.digest);
    expect(result.status).toBe("CERTIFIED");
  });

  test("requires integer count constraints", () => {
    expect(() => synthesizeCertified({ planId: "bad", subject: "candidate", primitives: [point("a", 0, 0)], canvasBounds: canvas,
      constraints: [{ id: "count", kind: "max_component_count", value: 1.5, severity: "required" }] })).toThrow(/non-negative integer/);
  });
});
