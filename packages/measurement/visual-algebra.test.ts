import { describe, expect, test } from "vitest";
import { createTerm, definePrimitive, digestValue } from "@nexus/visual-algebra";
import type { VisualAlgebraTerm } from "@nexus/visual-algebra";
import { projectVisualAlgebraMeasurement } from "./visual-algebra.js";

describe("visual algebra measurement integration", () => {
  test("projects all eight measured dimensions with source provenance", () => {
    const term = createTerm({
      subject: "client/home",
      canvasBounds: { x: 0, y: 0, width: 100, height: 100 },
      primitives: [
        definePrimitive({
          id: "hero",
          kind: "rectangle",
          bounds: { x: 10, y: 10, width: 40, height: 40 },
        }),
      ],
      constraints: [{ id: "overlap", metric: "overlap", max: 0 }],
    });

    const projection = projectVisualAlgebraMeasurement(term);

    expect(projection.authority).toBe("NEXUS_VISUAL_ALGEBRA_MEASUREMENT_V1");
    expect(projection.subject).toBe(term.subject);
    expect(projection.termDigest).toBe(term.digest);
    expect(projection.samples).toHaveLength(8);
    expect(projection.samples.map((sample) => sample.name).sort()).toEqual([
      "visual_algebra.aspectConsistency",
      "visual_algebra.axialSymmetry",
      "visual_algebra.continuity",
      "visual_algebra.gridRegularity",
      "visual_algebra.overlap",
      "visual_algebra.packingDensity",
      "visual_algebra.structuralEntropy",
      "visual_algebra.whitespace",
    ]);
    expect(projection.samples.every((sample) => sample.unit === "ratio")).toBe(true);
    expect(projection.constraintsPassed).toBe(true);
    expect(projection.constraintEvaluations).toEqual(term.evaluations);
  });

  test("fails closed when metrics are forged and the outer digest is recomputed", () => {
    const genuine = createTerm({
      subject: "client/forged",
      canvasBounds: { x: 0, y: 0, width: 100, height: 100 },
      primitives: [{ id: "half", kind: "rectangle", bounds: { x: 0, y: 0, width: 50, height: 100 } }],
    });
    const base: Omit<VisualAlgebraTerm, "digest"> = {
      ...genuine,
      metrics: Object.freeze({ ...genuine.metrics, whitespace: 0 }),
    };
    const forged = Object.freeze({
      ...base,
      digest: digestValue({
        authority: "NEXUS_VISUAL_ALGEBRA_TERM_V1",
        subject: base.subject,
        operation: base.operation,
        canvasBounds: base.canvasBounds,
        primitives: base.primitives,
        metrics: base.metrics,
        constraints: base.constraints,
        evaluations: base.evaluations,
      }),
    });

    expect(() => projectVisualAlgebraMeasurement(forged)).toThrow(/metrics do not match source geometry/);
  });
});
