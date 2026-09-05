import {
  createAdContextPolicy,
  evaluateAdContext,
  type AdContextDecision,
  type AdContextMode,
} from "@nexus/core/cortex/ad-context-edge-workers";

export const AD_CONTEXT_HEADERS = Object.freeze({
  experience: "x-nexus-ad-experience",
  channel: "x-nexus-ad-channel",
  reason: "x-nexus-ad-reason",
  applied: "x-nexus-ad-applied",
} as const);

export const DEFAULT_AD_EXPERIENCE = "default";
export const PAID_SEARCH_AD_EXPERIENCE = "paid-search";

export function adContextModeFromEnvironment(value: string | undefined): AdContextMode {
  const normalized = value?.trim().toUpperCase();
  if (!normalized) return "ACTIVE";
  if (normalized === "ACTIVE" || normalized === "OBSERVE_ONLY" || normalized === "KILLED") return normalized;
  return "KILLED";
}

export function resolveCanoAdContext(url: URL | string, modeValue?: string): AdContextDecision {
  const mode = adContextModeFromEnvironment(modeValue);
  const policy = createAdContextPolicy({
    policyId: "cano-paid-landing-v1",
    mode,
    defaultExperienceId: DEFAULT_AD_EXPERIENCE,
    paidSearchExperienceId: PAID_SEARCH_AD_EXPERIENCE,
    allowedExperienceIds: [DEFAULT_AD_EXPERIENCE, PAID_SEARCH_AD_EXPERIENCE],
    maxQueryBytes: 4_096,
    maxValueLength: 256,
  });
  return evaluateAdContext(url, policy);
}
