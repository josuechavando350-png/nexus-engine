import { digestValue } from "@nexus/visual-algebra";
import type { VisualAlgebraTerm } from "@nexus/visual-algebra";
import { buildFiltrationComplex } from "./complex.js";
import { bottleneckDistance } from "./distance.js";
import { createTopologicalFingerprint } from "./fingerprint.js";
import { computePersistentHomology, validateFiltrationComplex, validatePersistenceDiagram } from "./homology.js";
import type { CertifiedSynthesisInput, CertifiedSynthesisResult, CertifiedSynthesisStatus, PersistenceDiagram, TopologyConstraint, TopologyConstraintEvaluation, TopologyReference } from "./types.js";

const CONSTRAINT_KINDS = new Set<string>([
  "min_bottleneck_distance", "max_bottleneck_distance",
  "min_total_persistence", "max_total_persistence",
  "min_cycle_count", "max_cycle_count",
  "min_component_count", "max_component_count",
]);

function validateConstraint(constraint: TopologyConstraint): void {
  if (!constraint.id.trim()) throw new Error("Topology constraint id cannot be empty");
  if (!Number.isFinite(constraint.value)) throw new Error(`Topology constraint ${constraint.id} requires a finite value`);
  if (!CONSTRAINT_KINDS.has(constraint.kind)) throw new Error(`Unsupported topology constraint kind: ${constraint.kind}`);
  if (constraint.severity !== "required" && constraint.severity !== "recommended") throw new Error(`Invalid severity for ${constraint.id}`);
  const count = constraint.kind.includes("component_count") || constraint.kind.includes("cycle_count");
  if (count && (!Number.isInteger(constraint.value) || constraint.value < 0)) throw new Error(`Count constraint ${constraint.id} requires a non-negative integer`);
  if (!count && constraint.value < 0) throw new Error(`Topology constraint ${constraint.id} cannot be negative`);
  const bottleneck = constraint.kind.includes("bottleneck_distance");
  if (constraint.dimension !== undefined && constraint.dimension !== 0 && constraint.dimension !== 1) throw new Error(`Constraint ${constraint.id} dimension must be 0 or 1`);
  if (!bottleneck && constraint.dimension !== undefined) throw new Error(`Constraint ${constraint.id} cannot specify dimension`);
}
function nearestReference(diagram: PersistenceDiagram, references: readonly TopologyReference[], dimension?: 0 | 1): { id: string; distance: number } | null {
  let nearest: { id: string; distance: number } | null = null;
  for (const reference of references) {
    const distance = bottleneckDistance(diagram, reference.diagram, dimension).distance;
    if (nearest === null || distance < nearest.distance || (distance === nearest.distance && reference.id.localeCompare(nearest.id) < 0)) nearest = { id: reference.id, distance };
  }
  return nearest;
}
function numeric(constraint: TopologyConstraint, actual: number, minimum: boolean): TopologyConstraintEvaluation {
  const pass = minimum ? actual >= constraint.value : actual <= constraint.value;
  return Object.freeze({ constraint, status: pass ? "PASS" : "FAIL", actual, expected: constraint.value,
    reason: `${constraint.kind}: actual=${actual}, ${minimum ? "minimum" : "maximum"}=${constraint.value}` });
}
function evaluate(constraint: TopologyConstraint, diagram: PersistenceDiagram, fingerprint: CertifiedSynthesisResult["fingerprint"], references: readonly TopologyReference[]): TopologyConstraintEvaluation {
  validateConstraint(constraint);
  switch (constraint.kind) {
    case "min_bottleneck_distance": case "max_bottleneck_distance": {
      const nearest = nearestReference(diagram, references, constraint.dimension);
      if (!nearest) return Object.freeze({ constraint, status: "NOT_TESTED", actual: null, expected: constraint.value, reason: "No reference persistence diagrams were supplied" });
      return numeric(constraint, nearest.distance, constraint.kind === "min_bottleneck_distance");
    }
    case "min_total_persistence": return numeric(constraint, fingerprint.totalPersistence, true);
    case "max_total_persistence": return numeric(constraint, fingerprint.totalPersistence, false);
    case "min_cycle_count": return numeric(constraint, fingerprint.cycleCount, true);
    case "max_cycle_count": return numeric(constraint, fingerprint.cycleCount, false);
    case "min_component_count": return numeric(constraint, fingerprint.componentCount, true);
    case "max_component_count": return numeric(constraint, fingerprint.componentCount, false);
  }
}
function statusOf(evaluations: readonly TopologyConstraintEvaluation[]): CertifiedSynthesisStatus {
  const required = evaluations.filter((item) => item.constraint.severity === "required");
  if (required.some((item) => item.status === "FAIL")) return "REJECTED";
  if (required.some((item) => item.status === "NOT_TESTED")) return "NOT_TESTED";
  return "CERTIFIED";
}
export function synthesizeCertified(input: CertifiedSynthesisInput): CertifiedSynthesisResult {
  if (!input.planId.trim()) throw new Error("planId cannot be empty"); if (!input.subject.trim()) throw new Error("subject cannot be empty");
  const references = Object.freeze([...(input.referenceDiagrams ?? [])]); const ids = new Set<string>();
  for (const reference of references) { if (!reference.id.trim()) throw new Error("Reference id cannot be empty"); if (ids.has(reference.id)) throw new Error(`Duplicate topology reference id: ${reference.id}`); ids.add(reference.id); }
  const complex = buildFiltrationComplex({ primitives: input.primitives, canvasBounds: input.canvasBounds,
    ...(input.sourceTermDigest !== undefined ? { sourceTermDigest: input.sourceTermDigest } : {}), ...(input.relations ? { relations: input.relations } : {}),
    ...(input.maxFiltration !== undefined ? { maxFiltration: input.maxFiltration } : {}), ...(input.maxHomologyDimension !== undefined ? { maxHomologyDimension: input.maxHomologyDimension } : {}) });
  const diagram = computePersistentHomology(complex); const fingerprint = createTopologicalFingerprint(diagram);
  const evaluations = Object.freeze((input.constraints ?? []).map((constraint) => evaluate(constraint, diagram, fingerprint, references)));
  const status = statusOf(evaluations); const nearest = nearestReference(diagram, references);
  const referenceSetDigest = digestValue(references.map((reference) => ({ id: reference.id, diagramDigest: reference.diagram.digest })).sort((a, b) => a.id.localeCompare(b.id)));
  const certificateBase = { authority: "NEXUS_TOPOLOGY_CERTIFICATE_V1" as const, version: 1 as const, planId: input.planId, subject: input.subject, status,
    ...(input.sourceTermDigest !== undefined ? { sourceTermDigest: input.sourceTermDigest } : {}), complexDigest: complex.digest, diagramDigest: diagram.digest,
    fingerprintDigest: fingerprint.digest, referenceSetDigest, evaluations };
  const certificate = Object.freeze({ ...certificateBase, certificateDigest: digestValue(certificateBase) });
  const result = Object.freeze({ status, complex, diagram, fingerprint, ...(nearest ? { nearestReferenceId: nearest.id, nearestBottleneckDistance: nearest.distance } : {}), evaluations, certificate });
  validateCertifiedSynthesisResult(result);
  return result;
}

export function validateCertifiedSynthesisResult(result: CertifiedSynthesisResult): void {
  if (result.status !== "CERTIFIED" && result.status !== "REJECTED" && result.status !== "NOT_TESTED") throw new Error("Invalid certified synthesis status");
  validateFiltrationComplex(result.complex);
  validatePersistenceDiagram(result.diagram);
  if (result.diagram.sourceComplexDigest !== result.complex.digest) throw new Error("Diagram is not bound to the supplied complex");

  const { digest: fingerprintDigest, ...fingerprintPayload } = result.fingerprint;
  if (digestValue(fingerprintPayload) !== fingerprintDigest) throw new Error("Topological fingerprint digest mismatch");
  const expectedFingerprint = createTopologicalFingerprint(result.diagram);
  if (expectedFingerprint.digest !== fingerprintDigest || result.fingerprint.sourceComplexDigest !== result.complex.digest || result.fingerprint.sourceDiagramDigest !== result.diagram.digest) {
    throw new Error("Topological fingerprint is not bound to the supplied diagram/complex");
  }

  const certificate = result.certificate;
  if (certificate.authority !== "NEXUS_TOPOLOGY_CERTIFICATE_V1" || certificate.version !== 1) throw new Error("Unsupported topology certificate authority/version");
  if (!certificate.planId.trim() || !certificate.subject.trim()) throw new Error("Topology certificate planId/subject cannot be empty");
  if (certificate.status !== result.status) throw new Error("Topology certificate status mismatch");
  if (certificate.complexDigest !== result.complex.digest || certificate.diagramDigest !== result.diagram.digest || certificate.fingerprintDigest !== result.fingerprint.digest) {
    throw new Error("Topology certificate digest linkage mismatch");
  }
  if ((certificate.sourceTermDigest ?? null) !== (result.complex.sourceTermDigest ?? null)) throw new Error("Topology certificate source term linkage mismatch");
  if (digestValue(certificate.evaluations) !== digestValue(result.evaluations)) throw new Error("Topology certificate evaluations mismatch");
  const { certificateDigest, ...certificatePayload } = certificate;
  if (digestValue(certificatePayload) !== certificateDigest) throw new Error("Topology certificate digest mismatch");
}

export function synthesizeTermCertified(input: {
  readonly planId: string; readonly subject?: string; readonly term: VisualAlgebraTerm;
  readonly relations?: CertifiedSynthesisInput["relations"]; readonly referenceDiagrams?: readonly TopologyReference[];
  readonly constraints?: readonly TopologyConstraint[]; readonly maxFiltration?: number; readonly maxHomologyDimension?: 0 | 1;
}): CertifiedSynthesisResult {
  return synthesizeCertified({ planId: input.planId, subject: input.subject ?? input.term.subject, primitives: input.term.primitives,
    canvasBounds: input.term.canvasBounds, sourceTermDigest: input.term.digest, ...(input.relations ? { relations: input.relations } : {}),
    ...(input.referenceDiagrams ? { referenceDiagrams: input.referenceDiagrams } : {}), ...(input.constraints ? { constraints: input.constraints } : {}),
    ...(input.maxFiltration !== undefined ? { maxFiltration: input.maxFiltration } : {}), ...(input.maxHomologyDimension !== undefined ? { maxHomologyDimension: input.maxHomologyDimension } : {}) });
}
