import { digestValue } from "@nexus/visual-algebra";
import { searchOriginalityCounterfactual } from "./counterfactual.js";
import { compareStableStrings } from "./order.js";
import { originalityPointFromTerm } from "./point.js";
import type {
  SearchVerifiedOriginalityCounterfactualInput,
  VerifiedCounterfactualTermInput,
  VerifiedOriginalityCounterfactualResult,
} from "./types.js";

function canonicalTermInputs(inputs: readonly VerifiedCounterfactualTermInput[]): readonly VerifiedCounterfactualTermInput[] {
  return Object.freeze(
    [...inputs]
      .sort((a, b) => compareStableStrings(a.pointId, b.pointId))
      .map((input) => Object.freeze({ pointId: input.pointId, term: input.term })),
  );
}

export function searchVerifiedOriginalityCounterfactual(
  input: SearchVerifiedOriginalityCounterfactualInput,
): VerifiedOriginalityCounterfactualResult {
  const source = Object.freeze({ pointId: input.source.pointId, term: input.source.term });
  const alternatives = canonicalTermInputs(input.alternatives);
  const sourcePoint = originalityPointFromTerm({ pointId: source.pointId, role: "CANDIDATE", term: source.term });
  const alternativePoints = alternatives.map((alternative) => originalityPointFromTerm({
    pointId: alternative.pointId,
    role: "CANDIDATE",
    term: alternative.term,
  }));
  const pointSearch = searchOriginalityCounterfactual({
    source: sourcePoint,
    alternatives: alternativePoints,
    manifold: input.manifold,
  });
  const base = Object.freeze({
    authority: "NEXUS_ORIGINALITY_VERIFIED_COUNTERFACTUAL_V1" as const,
    version: 1 as const,
    source,
    alternatives,
    pointSearch,
  });
  const verifiedSearchDigest = digestValue({
    authority: base.authority,
    version: base.version,
    source: { pointId: source.pointId, termDigest: source.term.digest },
    alternatives: alternatives.map((alternative) => ({
      pointId: alternative.pointId,
      termDigest: alternative.term.digest,
    })),
    pointSearchDigest: pointSearch.searchDigest,
  });
  return Object.freeze({ ...base, verifiedSearchDigest });
}

export function validateVerifiedOriginalityCounterfactual(result: VerifiedOriginalityCounterfactualResult): void {
  if (!result || typeof result !== "object") throw new Error("Verified originality counterfactual result must be an object");
  if (result.authority !== "NEXUS_ORIGINALITY_VERIFIED_COUNTERFACTUAL_V1" || result.version !== 1) {
    throw new Error("Unsupported verified originality counterfactual authority/version");
  }
  const rebuilt = searchVerifiedOriginalityCounterfactual({
    source: result.source,
    alternatives: result.alternatives,
    manifold: result.pointSearch.sourceAssessment.manifold,
  });
  if (rebuilt.verifiedSearchDigest !== result.verifiedSearchDigest || digestValue(rebuilt) !== digestValue(result)) {
    throw new Error("Verified originality counterfactual digest or term-backed replay mismatch");
  }
}
