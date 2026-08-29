import { digestValue, geometricDistance } from "@nexus/visual-algebra";
import { assessOriginality, validateOriginalityAssessment } from "./assessment.js";
import { validateOriginalityManifold } from "./manifold.js";
import { compareStableStrings } from "./order.js";
import { validateOriginalityPoint } from "./point.js";
import type { CounterfactualSearchResult, SearchOriginalityCounterfactualInput } from "./types.js";

export function searchOriginalityCounterfactual(input: SearchOriginalityCounterfactualInput): CounterfactualSearchResult {
  validateOriginalityManifold(input.manifold);
  validateOriginalityPoint(input.source);
  if (input.source.role !== "CANDIDATE") throw new Error("Counterfactual source must be CANDIDATE");

  const sourceAssessment = assessOriginality({ candidate: input.source, manifold: input.manifold });
  const seen = new Set<string>([input.source.pointId]);
  const alternatives = [...input.alternatives].sort((a, b) => compareStableStrings(a.pointId, b.pointId));
  const evaluations = alternatives.map((candidate) => {
    validateOriginalityPoint(candidate);
    if (candidate.role !== "CANDIDATE") throw new Error("Counterfactual alternatives must be CANDIDATE points");
    if (candidate.subject !== input.source.subject) throw new Error("Counterfactual alternatives must share the source subject");
    if (seen.has(candidate.pointId)) throw new Error(`Duplicate counterfactual candidate pointId ${candidate.pointId}`);
    seen.add(candidate.pointId);
    const assessment = assessOriginality({ candidate, manifold: input.manifold });
    const displacement = geometricDistance(input.source.metrics, candidate.metrics, input.manifold.policy.weights).distance;
    return Object.freeze({ candidate, assessment, displacement });
  });

  let status: CounterfactualSearchResult["status"];
  let chosenPointId: string | null = null;
  let chosenDisplacement: number | null = null;
  if (sourceAssessment.status === "CLEAR") {
    status = "ALREADY_CLEAR";
  } else {
    const viable = evaluations
      .filter((entry) => entry.assessment.status === "CLEAR")
      .sort((left, right) => left.displacement - right.displacement || compareStableStrings(left.candidate.pointId, right.candidate.pointId));
    if (viable.length) {
      status = "FOUND";
      chosenPointId = viable[0]!.candidate.pointId;
      chosenDisplacement = viable[0]!.displacement;
    } else {
      status = "NOT_FOUND";
    }
  }

  const base = Object.freeze({
    authority: "NEXUS_ORIGINALITY_COUNTERFACTUAL_V1" as const,
    version: 1 as const,
    sourceAssessment,
    evaluations: Object.freeze(evaluations),
    status,
    chosenPointId,
    chosenDisplacement,
  });
  const searchDigest = digestValue({
    authority: base.authority,
    version: base.version,
    sourceAssessmentDigest: sourceAssessment.assessmentDigest,
    evaluations: evaluations.map((entry) => ({
      pointDigest: entry.candidate.pointDigest,
      assessmentDigest: entry.assessment.assessmentDigest,
      displacement: entry.displacement,
    })),
    status,
    chosenPointId,
    chosenDisplacement,
  });
  return Object.freeze({ ...base, searchDigest });
}

export function validateOriginalityCounterfactual(result: CounterfactualSearchResult): void {
  if (result.authority !== "NEXUS_ORIGINALITY_COUNTERFACTUAL_V1" || result.version !== 1) {
    throw new Error("Unsupported originality counterfactual authority/version");
  }
  validateOriginalityAssessment(result.sourceAssessment);
  const rebuilt = searchOriginalityCounterfactual({
    source: result.sourceAssessment.candidate,
    alternatives: result.evaluations.map((entry) => entry.candidate),
    manifold: result.sourceAssessment.manifold,
  });
  if (rebuilt.searchDigest !== result.searchDigest || digestValue(rebuilt) !== digestValue(result)) {
    throw new Error("Originality counterfactual digest or selection mismatch");
  }
}
