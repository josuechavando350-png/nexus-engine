import { createHash } from "node:crypto";
import type { GeoBaseline, GeoHoldoutAnalysis, GeoHoldoutDesign, GeoOutcome } from "../../geo-holdout/index.js";
import type { GeoExperimentRecord } from "../../geo-holdout/registry.js";

const CUSTOMER_ID = /^\d{10}$/u;
const EXPERIMENT_KEY = /^[A-Za-z0-9][A-Za-z0-9._-]{3,79}$/u;

export const SEO_GEO_INCREMENTALITY_POLICY_VERSION = "seo12-geo-incrementality-v1" as const;

export interface SeoGeoIncrementalityIdentity {
  readonly strategy: 12;
  readonly provider: "CORTEX_GEO_HOLDOUT_INCREMENTALITY";
  readonly engine: "CORTEX_12_GEO_HOLDOUT";
  readonly operatorWebsiteOrigin: string;
  readonly googleAdsCustomerId: string;
  readonly scopeDigest: `sha256:${string}`;
}

export interface SeoGeoIncrementalityPolicyInput {
  readonly operatorWebsiteOrigin: string;
  readonly googleAdsCustomerId: string;
}

export interface SeoGeoIncrementalityPolicy extends SeoGeoIncrementalityIdentity {
  readonly policyVersion: typeof SEO_GEO_INCREMENTALITY_POLICY_VERSION;
}

export interface SeoGeoIncrementalityDesignRequest {
  readonly experimentKey: string;
  readonly operatorWebsiteOrigin: string;
  readonly googleAdsCustomerId: string;
  readonly seed: string;
  readonly holdoutFraction: number;
  readonly maxBaselineImbalance: number;
  readonly minGeosPerArm: number;
  readonly geos: readonly GeoBaseline[];
}

export interface SeoGeoIncrementalityAnalysisRequest {
  readonly experimentKey: string;
  readonly operatorWebsiteOrigin: string;
  readonly googleAdsCustomerId: string;
  readonly outcomes: readonly GeoOutcome[];
}

export interface SeoGeoIncrementalityRegistration {
  readonly experimentKey: string;
  readonly experimentId: string;
  readonly scopeDigest: `sha256:${string}`;
  readonly design: GeoHoldoutDesign;
}

export type SeoGeoIncrementalityGate = "ALLOW_OPTIMIZATION" | "HOLD" | "BLOCK_REGRESSION";

export interface SeoGeoIncrementalityDecision {
  readonly experimentKey: string;
  readonly experimentId: string;
  readonly scopeDigest: `sha256:${string}`;
  readonly analysis: GeoHoldoutAnalysis;
  readonly gate: SeoGeoIncrementalityGate;
}

export interface GeoHoldoutExperimentRegistryPort {
  registerDesign(input: unknown): GeoExperimentRecord;
  analyze(experimentId: string, outcomes: readonly GeoOutcome[]): GeoExperimentRecord;
  get(experimentId: string): GeoExperimentRecord | undefined;
}

export class SeoGeoIncrementalityError extends Error {
  constructor(
    public readonly code: "INVALID_CONFIG" | "SCOPE_MISMATCH" | "INCOMPLETE_ANALYSIS" | "INTEGRITY_FAILURE",
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "SeoGeoIncrementalityError";
  }
}

function canonicalOrigin(value: string): string {
  let url: URL;
  try { url = new URL(value); }
  catch { throw new SeoGeoIncrementalityError("INVALID_CONFIG", "operatorWebsiteOrigin must be an absolute HTTPS origin"); }
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || url.pathname !== "/") {
    throw new SeoGeoIncrementalityError("INVALID_CONFIG", "operatorWebsiteOrigin must be a canonical HTTPS origin");
  }
  return url.origin;
}

function sha256(value: string): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`;
}

export function createSeoGeoIncrementalityPolicy(input: SeoGeoIncrementalityPolicyInput): SeoGeoIncrementalityPolicy {
  if (!input || typeof input !== "object") throw new SeoGeoIncrementalityError("INVALID_CONFIG", "SEO #12 policy is required");
  const operatorWebsiteOrigin = canonicalOrigin(input.operatorWebsiteOrigin);
  const googleAdsCustomerId = input.googleAdsCustomerId?.trim();
  if (!CUSTOMER_ID.test(googleAdsCustomerId)) throw new SeoGeoIncrementalityError("INVALID_CONFIG", "googleAdsCustomerId must contain exactly 10 digits");
  const scopeDigest = sha256(`${SEO_GEO_INCREMENTALITY_POLICY_VERSION}\0${operatorWebsiteOrigin}\0${googleAdsCustomerId}`);
  return Object.freeze({
    strategy: 12 as const,
    provider: "CORTEX_GEO_HOLDOUT_INCREMENTALITY" as const,
    engine: "CORTEX_12_GEO_HOLDOUT" as const,
    operatorWebsiteOrigin,
    googleAdsCustomerId,
    scopeDigest,
    policyVersion: SEO_GEO_INCREMENTALITY_POLICY_VERSION,
  });
}

export function validateSeoGeoExperimentKey(value: unknown): string {
  if (typeof value !== "string" || !EXPERIMENT_KEY.test(value)) throw new SeoGeoIncrementalityError("INVALID_CONFIG", "experimentKey must be 4-80 safe identifier characters");
  return value;
}

export function scopedSeoGeoExperimentId(policy: SeoGeoIncrementalityPolicy, experimentKey: string): string {
  const key = validateSeoGeoExperimentKey(experimentKey);
  return `seo12:${policy.scopeDigest.slice(7, 23)}:${key}`;
}
