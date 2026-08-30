import { describe, expect, test } from "vitest";
import { createTerm, digestValue } from "@nexus/visual-algebra";
import type { VisualAlgebraTerm } from "@nexus/visual-algebra";
import { buildComplexFromTerm } from "../index.js";

function forgedDigest(term: Omit<VisualAlgebraTerm, "digest">): string {
  return digestValue({
    authority: "NEXUS_VISUAL_ALGEBRA_TERM_V1",
    subject: term.subject,
    operation: term.operation,
    canvasBounds: term.canvasBounds,
    primitives: term.primitives,
    metrics: term.metrics,
    constraints: term.constraints,
    evaluations: term.evaluations,
  });
}

describe("Topology Visual Algebra trust boundary", () => {
  test("rejects attacker-recomputed term digest when metrics do not match geometry", () => {
    const genuine = createTerm({
      subject: "topology/forged-source",
      canvasBounds: { x: 0, y: 0, width: 100, height: 100 },
      primitives: [
        { id: "a", kind: "rectangle", bounds: { x: 0, y: 0, width: 10, height: 10 } },
        { id: "b", kind: "rectangle", bounds: { x: 80, y: 80, width: 10, height: 10 } },
      ],
    });
    const base: Omit<VisualAlgebraTerm, "digest"> = {
      ...genuine,
      metrics: Object.freeze({ ...genuine.metrics, continuity: 1 }),
    };
    const forged: VisualAlgebraTerm = Object.freeze({ ...base, digest: forgedDigest(base) });

    expect(() => buildComplexFromTerm(forged)).toThrow(/metrics do not match source geometry/);
  });
});
