import { digestValue } from "@nexus/visual-algebra";
import { ORIGINALITY_METRICS } from "./constants.js";
import { MAX_ORIGINALITY_K_NEIGHBORS } from "./limits.js";
import type { CreateOriginalityPolicyInput, OriginalityPolicy, ResolvedMetricWeights } from "./types.js";

export function createOriginalityPolicy(input: CreateOriginalityPolicyInput): OriginalityPolicy {
  if (!Number.isInteger(input.kNeighbors) || input.kNeighbors < 1) {
    throw new Error("kNeighbors must be a positive integer");
  }
  if (input.kNeighbors > MAX_ORIGINALITY_K_NEIGHBORS) {
    throw new Error(`kNeighbors cannot exceed ${MAX_ORIGINALITY_K_NEIGHBORS}`);
  }
  if (!Number.isFinite(input.minimumProtectedDirect) || input.minimumProtectedDirect < 0 || input.minimumProtectedDirect > 1) {
    throw new Error("minimumProtectedDirect must be finite and normalized to [0,1]");
  }
  if (!Number.isFinite(input.minimumProtectedGeodesic) || input.minimumProtectedGeodesic < 0) {
    throw new Error("minimumProtectedGeodesic must be finite and non-negative");
  }

  let positiveWeights = 0;
  const weights = Object.fromEntries(
    ORIGINALITY_METRICS.map((metric) => {
      const weight = input.weights?.[metric] ?? 1;
      if (!Number.isFinite(weight) || weight < 0) {
        throw new Error(`Weight for ${metric} must be finite and non-negative`);
      }
      if (weight > 0) positiveWeights += 1;
      return [metric, weight];
    }),
  ) as ResolvedMetricWeights;

  if (!positiveWeights) throw new Error("At least one originality metric weight must be positive");

  const base = Object.freeze({
    authority: "NEXUS_ORIGINALITY_POLICY_V1" as const,
    version: 1 as const,
    kNeighbors: input.kNeighbors,
    minimumProtectedDirect: input.minimumProtectedDirect,
    minimumProtectedGeodesic: input.minimumProtectedGeodesic,
    weights: Object.freeze(weights),
  });

  return Object.freeze({ ...base, policyDigest: digestValue(base) });
}

export function validateOriginalityPolicy(policy: OriginalityPolicy): void {
  if (!policy || typeof policy !== "object") throw new Error("Originality policy must be an object");
  if (policy.authority !== "NEXUS_ORIGINALITY_POLICY_V1" || policy.version !== 1) {
    throw new Error("Unsupported originality policy authority/version");
  }
  const rebuilt = createOriginalityPolicy({
    kNeighbors: policy.kNeighbors,
    minimumProtectedDirect: policy.minimumProtectedDirect,
    minimumProtectedGeodesic: policy.minimumProtectedGeodesic,
    weights: policy.weights,
  });
  if (rebuilt.policyDigest !== policy.policyDigest || digestValue(rebuilt.weights) !== digestValue(policy.weights)) {
    throw new Error("Originality policy digest/canonicalization mismatch");
  }
}
