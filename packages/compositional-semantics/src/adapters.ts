import { verifyVisualAlgebraTerm } from "@nexus/visual-algebra";
import type { VisualAlgebraTerm } from "@nexus/visual-algebra";
import type { CertifiedSynthesisResult } from "@nexus/topology";
import {
  validateCertifiedSynthesisAgainstTerm,
  validateCertifiedSynthesisResult,
} from "@nexus/topology";
import { createSemanticState, mergeSemanticStates } from "./state.js";
import type { SemanticState, SemanticValue } from "./types.js";

export function semanticStateFromVisualAlgebra(term: VisualAlgebraTerm): SemanticState {
  verifyVisualAlgebraTerm(term);
  const metrics = Object.fromEntries(Object.entries(term.metrics).map(([name, value]) => [`visual.${name}`, value]));
  return createSemanticState({
    facts: {
      "visual.subject": term.subject,
      "visual.operation": term.operation,
      "visual.termDigest": term.digest,
      "visual.constraintsSatisfied": term.evaluations.every((evaluation) => evaluation.pass),
    },
    metrics,
  });
}

export function semanticStateFromTopology(result: CertifiedSynthesisResult): SemanticState {
  validateCertifiedSynthesisResult(result);
  const facts: Record<string, SemanticValue> = {
    "topology.status": result.status,
    "topology.certificateDigest": result.certificate.certificateDigest,
    "topology.diagramDigest": result.diagram.digest,
    "topology.fingerprintDigest": result.fingerprint.digest,
  };
  if (result.certificate.sourceTermDigest) facts["topology.sourceTermDigest"] = result.certificate.sourceTermDigest;
  if (result.nearestReferenceId) facts["topology.nearestReferenceId"] = result.nearestReferenceId;
  if (result.nearestBottleneckInfinite === true) facts["topology.nearestBottleneckInfinite"] = true;

  const metrics: Record<string, number> = {
    "topology.componentCount": result.fingerprint.componentCount,
    "topology.cycleCount": result.fingerprint.cycleCount,
    "topology.totalPersistence": result.fingerprint.totalPersistence,
    "topology.maxPersistence": result.fingerprint.maxPersistence,
    "topology.entropy": result.fingerprint.entropy,
    "topology.H0.entropy": result.fingerprint.H0.entropy,
    "topology.H1.entropy": result.fingerprint.H1.entropy,
  };
  if (result.nearestBottleneckDistance !== undefined) {
    metrics["topology.nearestBottleneckDistance"] = result.nearestBottleneckDistance;
  }
  return createSemanticState({ facts, metrics });
}

export function semanticStateFromEngines(input: {
  readonly visual?: VisualAlgebraTerm;
  readonly topology?: CertifiedSynthesisResult;
  readonly additional?: SemanticState;
}): SemanticState {
  const states: SemanticState[] = [];
  if (input.visual) states.push(semanticStateFromVisualAlgebra(input.visual));
  if (input.topology) {
    if (input.visual) validateCertifiedSynthesisAgainstTerm(input.topology, input.visual);
    else validateCertifiedSynthesisResult(input.topology);
    states.push(semanticStateFromTopology(input.topology));
  }
  if (input.additional) states.push(input.additional);
  return mergeSemanticStates(states);
}
