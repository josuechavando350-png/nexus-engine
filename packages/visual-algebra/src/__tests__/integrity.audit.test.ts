import { describe, expect, test } from "vitest";
import {
  canonicalJson,
  createGeometricFingerprint,
  createTerm,
  digestValue,
  sequence,
  verifyVisualAlgebraTerm,
} from "../index.js";
import type { VisualAlgebraTerm } from "../index.js";

function forgeDigest(term: Omit<VisualAlgebraTerm, "digest">): string {
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

describe("Visual Algebra integrity boundary", () => {
  test("accepts a genuine engine-issued term", () => {
    const term = createTerm({
      subject: "integrity/genuine",
      canvasBounds: { x: 0, y: 0, width: 100, height: 100 },
      primitives: [{ id: "hero", kind: "rectangle", bounds: { x: 0, y: 0, width: 50, height: 100 } }],
      constraints: [{ id: "whitespace", metric: "whitespace", min: 0.49, max: 0.51 }],
    });
    expect(() => verifyVisualAlgebraTerm(term)).not.toThrow();
    expect(() => createGeometricFingerprint(term)).not.toThrow();
  });

  test("rejects forged metrics even when the attacker recomputes the outer digest", () => {
    const genuine = createTerm({
      subject: "integrity/forged-metrics",
      canvasBounds: { x: 0, y: 0, width: 100, height: 100 },
      primitives: [{ id: "hero", kind: "rectangle", bounds: { x: 0, y: 0, width: 50, height: 100 } }],
    });
    const base: Omit<VisualAlgebraTerm, "digest"> = {
      ...genuine,
      metrics: Object.freeze({ ...genuine.metrics, whitespace: 0 }),
    };
    const forged = Object.freeze({ ...base, digest: forgeDigest(base) });

    expect(() => verifyVisualAlgebraTerm(forged)).toThrow(/metrics do not match source geometry/);
    expect(() => createGeometricFingerprint(forged)).toThrow(/metrics do not match source geometry/);
    expect(() => sequence({ subject: "integrity/sequence", terms: [forged] })).toThrow(/metrics do not match source geometry/);
  });

  test("rejects forged constraint evaluations even with a matching forged digest", () => {
    const genuine = createTerm({
      subject: "integrity/forged-evaluation",
      primitives: [{ id: "box", kind: "rectangle", bounds: { x: 0, y: 0, width: 10, height: 10 } }],
      constraints: [{ id: "overlap", metric: "overlap", min: 0.5 }],
    });
    const base: Omit<VisualAlgebraTerm, "digest"> = {
      ...genuine,
      evaluations: Object.freeze(genuine.evaluations.map((evaluation) => Object.freeze({ ...evaluation, pass: true }))),
    };
    const forged = Object.freeze({ ...base, digest: forgeDigest(base) });
    expect(() => verifyVisualAlgebraTerm(forged)).toThrow(/constraint evaluations do not match metrics/);
  });

  test("rejects non-canonical primitive geometry even when digested consistently", () => {
    const genuine = createTerm({
      subject: "integrity/line",
      primitives: [{ id: "line", kind: "line", start: { x: 0, y: 0 }, end: { x: 10, y: 10 } }],
    });
    const forgedPrimitive = Object.freeze({
      ...genuine.primitives[0]!,
      bounds: Object.freeze({ x: 0, y: 0, width: 999, height: 999 }),
    });
    const base: Omit<VisualAlgebraTerm, "digest"> = {
      ...genuine,
      primitives: Object.freeze([forgedPrimitive]),
    };
    const forged = Object.freeze({ ...base, digest: forgeDigest(base) });
    expect(() => verifyVisualAlgebraTerm(forged)).toThrow(/primitive normalization mismatch/);
  });

  test("canonical hashing fails closed on cyclic input", () => {
    const cyclic: { self?: unknown } = {};
    cyclic.self = cyclic;
    expect(() => canonicalJson(cyclic)).toThrow(/cyclic/);
  });
});
