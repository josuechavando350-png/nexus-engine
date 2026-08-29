import { digestValue } from "@nexus/visual-algebra";
import type { VisualAlgebraTerm } from "@nexus/visual-algebra";
import { buildFiltrationComplex } from "./complex.js";
import { bottleneckDistance } from "./distance.js";
import { createTopologicalFingerprint } from "./fingerprint.js";
import { computePersistentHomology } from "./homology.js";
import type { CertifiedSynthesisInput, CertifiedSynthesisResult, CertifiedSynthesisStatus, PersistenceDiagram, TopologyConstraint, TopologyConstraintEvaluation, TopologyReference } from "./types.js";

function validateConstraint(constraint: TopologyConstraint): void {
  if (!constraint.id.trim()) throw new Error("Topology constraint id cannot be empty");
  if (!Number.isFinite(constraint.value)) throw new Error(`Topology constraint ${constraint.id} requires a finite value`);
  if (constraint.severity !== "required" && constraint.severity !== "recommended") throw new Error(`Invalid severity for ${constraint.id}`);
  const count = constraint.kind.includes("component_count") || constraint.kind.includes("cycle_count");
  if (count && (!Number.isInteger(constraint.value) || constraint.value < 0)) throw new Error(`Count constraint ${constraint.id} requires a non-negative integer`);
  if (!count && constraint.value < 0) throw new Error(`Topology constraint ${constraint.id} cannot be negative`);
  const bottleneck = constraint.kind.includes("bottleneck_distance");
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
    ...(input.sourceTermDigest ? { sourceTermDigest: input.sourceTermDigest } : {}), ...(input.relations ? { relations: input.relations } : {}),
    ...(input.maxFiltration !== undefined ? { maxFiltration: input.maxFiltration } : {}), ...(input.maxHomologyDimension !== undefined ? { maxHomologyDimension: input.maxHomologyDimension } : {}) });
  const diagram = computePersistentHomology(complex); const fingerprint = createTopologicalFingerprint(diagram);
  const evaluations = Object.freeze((input.constraints ?? []).map((constraint) => evaluate(constraint, diagram, fingerprint, references)));
  const status = statusOf(evaluations); const nearest = nearestReference(diagram, references);
  const referenceSetDigest = digestValue(references.map((reference) => ({ id: reference.id, diagramDigest: reference.diagram.digest })).sort((a, b) => a.id.localeCompare(b.id)));
  const certificateBase = { authority: "NEXUS_TOPOLOGY_CERTIFICATE_V1" as const, version: 1 as const, planId: input.planId, subject: input.subject, status,
    ...(input.sourceTermDigest ? { sourceTermDigest: input.sourceTermDigest } : {}), complexDigest: complex.digest, diagramDigest: diagram.digest,
    fingerprintDigest: fingerprint.digest, referenceSetDigest, evaluations };
  const certificate = Object.freeze({ ...certificateBase, certificateDigest: digestValue(certificateBase) });
  return Object.freeze({ status, complex, diagram, fingerprint, ...(nearest ? { nearestReferenceId: nearest.id, nearestBottleneckDistance: nearest.distance } : {}), evaluations, certificate });
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
