import { describe, expect, test } from "vitest";
import { createTerm, digestValue } from "@nexus/visual-algebra";
import type { VisualAlgebraTerm } from "@nexus/visual-algebra";
import {
  createTopologicalFingerprint,
  synthesizeCertified,
  synthesizeTermCertified,
  validateCertifiedSynthesisAgainstTerm,
  validateCertifiedSynthesisResult,
  validateFiltrationComplex,
} from "../index.js";
import type {
  CertifiedSynthesisResult,
  FiltrationComplex,
  PersistenceDiagram,
  TopologyCertificate,
  TopologyConstraintEvaluation,
} from "../index.js";

const canvas = { x: 0, y: 0, width: 100, height: 100 } as const;
const point = (id: string, x: number, y: number) => ({
  id,
  kind: "rectangle" as const,
  bounds: { x, y, width: 0, height: 0 },
});

function visualDigest(term: Omit<VisualAlgebraTerm, "digest">): string {
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

function diagramWithIntervals(
  sourceComplexDigest: string,
  intervals: PersistenceDiagram["intervals"],
): PersistenceDiagram {
  const base = {
    authority: "NEXUS_PERSISTENCE_DIAGRAM_V1" as const,
    sourceComplexDigest,
    maxDimension: 1 as const,
    filtrationLimit: 1,
    intervals,
  };
  return Object.freeze({ ...base, digest: digestValue(base) });
}

function reissueCertificate(
  original: TopologyCertificate,
  changes: Partial<Omit<TopologyCertificate, "certificateDigest">>,
): TopologyCertificate {
  const { certificateDigest: _ignored, ...payload } = original;
  const next = { ...payload, ...changes };
  return Object.freeze({ ...next, certificateDigest: digestValue(next) });
}

describe("Topology integrity boundary", () => {
  test("rejects a rehashed complex whose simplices no longer follow canonical geometry", () => {
    const result = synthesizeCertified({
      planId: "complex-forge",
      subject: "audit/topology",
      primitives: [point("a", 0, 0), point("b", 50, 0)],
      canvasBounds: canvas,
    });
    const forgedSimplices = result.complex.simplices.map((simplex) => (
      simplex.dimension === 1 ? Object.freeze({ ...simplex, filtration: 0.01 }) : simplex
    ));
    const { digest: _ignored, ...complexPayload } = result.complex;
    const forgedBase = { ...complexPayload, simplices: Object.freeze(forgedSimplices) };
    const forged: FiltrationComplex = Object.freeze({ ...forgedBase, digest: digestValue(forgedBase) });

    expect(() => validateFiltrationComplex(forged)).toThrow(/simplices do not match canonical vertices\/relations/);
  });

  test("rejects a forged persistence diagram even when all outer topology hashes are recomputed", () => {
    const genuine = synthesizeCertified({
      planId: "diagram-forge",
      subject: "audit/topology",
      primitives: [point("a", 0, 0), point("b", 50, 0)],
      canvasBounds: canvas,
    });
    const forgedDiagram = diagramWithIntervals(genuine.complex.digest, []);
    const forgedFingerprint = createTopologicalFingerprint(forgedDiagram);
    const forgedCertificate = reissueCertificate(genuine.certificate, {
      diagramDigest: forgedDiagram.digest,
      fingerprintDigest: forgedFingerprint.digest,
    });
    const forged: CertifiedSynthesisResult = Object.freeze({
      ...genuine,
      diagram: forgedDiagram,
      fingerprint: forgedFingerprint,
      certificate: forgedCertificate,
    });

    expect(() => validateCertifiedSynthesisResult(forged)).toThrow(/diagram does not match the supplied filtration complex/);
  });

  test("recomputes constraint evaluations and status instead of trusting a rehashed certificate", () => {
    const genuine = synthesizeCertified({
      planId: "evaluation-forge",
      subject: "audit/topology",
      primitives: [point("a", 0, 0)],
      canvasBounds: canvas,
      constraints: [{ id: "none", kind: "max_component_count", value: 0, severity: "required" }],
    });
    expect(genuine.status).toBe("REJECTED");

    const original = genuine.evaluations[0]!;
    const forgedEvaluation: TopologyConstraintEvaluation = Object.freeze({
      ...original,
      status: "PASS",
      actual: 0,
      reason: "forged pass",
    });
    const forgedEvaluations = Object.freeze([forgedEvaluation]);
    const forgedCertificate = reissueCertificate(genuine.certificate, {
      status: "CERTIFIED",
      evaluations: forgedEvaluations,
    });
    const forged: CertifiedSynthesisResult = Object.freeze({
      ...genuine,
      status: "CERTIFIED",
      evaluations: forgedEvaluations,
      certificate: forgedCertificate,
    });

    expect(() => validateCertifiedSynthesisResult(forged)).toThrow(/evaluations do not match topology\/reference evidence/);
  });

  test("synthesizeTermCertified rejects a forged Visual Algebra term with an attacker-recomputed digest", () => {
    const genuine = createTerm({
      subject: "audit/term",
      canvasBounds: canvas,
      primitives: [point("a", 0, 0), point("b", 25, 0)],
    });
    const forgedBase: Omit<VisualAlgebraTerm, "digest"> = {
      ...genuine,
      metrics: Object.freeze({ ...genuine.metrics, continuity: 1 }),
    };
    const forged: VisualAlgebraTerm = Object.freeze({ ...forgedBase, digest: visualDigest(forgedBase) });

    expect(() => synthesizeTermCertified({ planId: "forged-term", term: forged })).toThrow(/metrics do not match source geometry/);
  });

  test("raw synthesis cannot manufacture Visual Algebra provenance", () => {
    const raw = synthesizeCertified({
      planId: "raw",
      subject: "audit/raw",
      primitives: [point("a", 0, 0)],
      canvasBounds: canvas,
    });
    expect(raw.complex.sourceTermDigest).toBeUndefined();
    expect(raw.certificate.sourceTermDigest).toBeUndefined();

    const term = createTerm({ subject: "audit/raw", canvasBounds: canvas, primitives: [point("a", 0, 0)] });
    expect(() => validateCertifiedSynthesisAgainstTerm(raw, term)).toThrow(/source term digest is not bound/);
  });

  test("term synthesis requires certificate subject to equal the term subject", () => {
    const term = createTerm({ subject: "audit/subject", canvasBounds: canvas, primitives: [point("a", 0, 0)] });
    expect(() => synthesizeTermCertified({ planId: "subject", subject: "other", term })).toThrow(/subject must match/);
  });

  test("carries reference diagrams so bottleneck evaluations can be independently recomputed", () => {
    const emptyReference = diagramWithIntervals("a".repeat(64), []);
    const result = synthesizeCertified({
      planId: "infinite-distance",
      subject: "audit/reference",
      primitives: [point("a", 0, 0)],
      canvasBounds: canvas,
      referenceDiagrams: [{ id: "empty", diagram: emptyReference }],
      constraints: [{ id: "separate", kind: "min_bottleneck_distance", value: 0.1, severity: "required" }],
    });

    expect(result.references).toHaveLength(1);
    expect(result.nearestReferenceId).toBe("empty");
    expect(result.nearestBottleneckInfinite).toBe(true);
    expect(result.nearestBottleneckDistance).toBeUndefined();
    expect(result.evaluations[0]).toMatchObject({ status: "PASS", actual: null, actualInfinite: true });
    expect(result.status).toBe("CERTIFIED");
    expect(() => validateCertifiedSynthesisResult(result)).not.toThrow();
  });
});
