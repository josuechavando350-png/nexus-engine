import {
  personalizeAdContext,
  type AdPersonalizationDecision,
  type AdPersonalizationPolicy,
} from "./personalization.js";

export interface SeoProfessionalCamaleonAdapter {
  resolve(input: URL | string): AdPersonalizationDecision;
}

export function createSeoProfessionalCamaleonAdapter(
  policy: AdPersonalizationPolicy,
): SeoProfessionalCamaleonAdapter {
  if (!policy || typeof policy !== "object") throw new TypeError("ad personalization policy is required");
  return Object.freeze({
    resolve(input: URL | string): AdPersonalizationDecision {
      return personalizeAdContext(input, policy);
    },
  });
}
