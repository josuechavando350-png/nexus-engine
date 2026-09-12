import type { GeoHoldoutAnalysis, GeoOutcome } from "../../geo-holdout/index.js";
import type { GeoExperimentRecord } from "../../geo-holdout/registry.js";
import {
  type GeoHoldoutExperimentRegistryPort,
  type SeoGeoIncrementalityAnalysisRequest,
  type SeoGeoIncrementalityDecision,
  type SeoGeoIncrementalityDesignRequest,
  type SeoGeoIncrementalityIdentity,
  type SeoGeoIncrementalityPolicy,
  type SeoGeoIncrementalityRegistration,
  SeoGeoIncrementalityError,
  scopedSeoGeoExperimentId,
  validateSeoGeoExperimentKey,
} from "./contracts.js";

function exactScope(
  policy: SeoGeoIncrementalityPolicy,
  operatorWebsiteOrigin: string,
  googleAdsCustomerId: string,
): void {
  let url: URL;
  try { url = new URL(operatorWebsiteOrigin); }
  catch { throw new SeoGeoIncrementalityError("SCOPE_MISMATCH", "request operator origin is invalid"); }
  const customerId = typeof googleAdsCustomerId === "string" ? googleAdsCustomerId.trim() : "";
  if (
    url.protocol !== "https:"
    || url.username
    || url.password
    || url.search
    || url.hash
    || url.pathname !== "/"
    || url.origin !== policy.operatorWebsiteOrigin
    || customerId !== policy.googleAdsCustomerId
  ) {
    throw new SeoGeoIncrementalityError("SCOPE_MISMATCH", "geo incrementality request does not match the configured operator/customer scope");
  }
}

function gateFor(analysis: GeoHoldoutAnalysis): SeoGeoIncrementalityDecision["gate"] {
  if (analysis.verdict === "POSITIVE") return "ALLOW_OPTIMIZATION";
  if (analysis.verdict === "NEGATIVE") return "BLOCK_REGRESSION";
  return "HOLD";
}

function requireAnalysis(record: GeoExperimentRecord): GeoHoldoutAnalysis {
  if (!record.analysis) throw new SeoGeoIncrementalityError("INCOMPLETE_ANALYSIS", "geo experiment has no committed analysis");
  if (record.analysis.experimentId !== record.design.experimentId || record.analysis.designDigest !== record.design.designDigest) {
    throw new SeoGeoIncrementalityError("INTEGRITY_FAILURE", "geo experiment analysis is not bound to its committed design");
  }
  return record.analysis;
}

export class SeoGeoIncrementalityRuntime {
  private readonly policy: SeoGeoIncrementalityPolicy;
  private readonly registry: GeoHoldoutExperimentRegistryPort;

  constructor(input: { readonly policy: SeoGeoIncrementalityPolicy; readonly registry: GeoHoldoutExperimentRegistryPort }) {
    if (!input || typeof input !== "object" || !input.policy || !input.registry) throw new SeoGeoIncrementalityError("INVALID_CONFIG", "SEO #12 runtime dependencies are required");
    for (const method of ["registerDesign", "analyze", "get"] as const) {
      if (typeof (input.registry as unknown as Record<string, unknown>)[method] !== "function") throw new SeoGeoIncrementalityError("INVALID_CONFIG", `registry.${method} is required`);
    }
    if (input.policy.strategy !== 12 || input.policy.provider !== "CORTEX_GEO_HOLDOUT_INCREMENTALITY" || input.policy.engine !== "CORTEX_12_GEO_HOLDOUT") {
      throw new SeoGeoIncrementalityError("INVALID_CONFIG", "SEO #12 policy identity is invalid");
    }
    this.policy = input.policy;
    this.registry = input.registry;
  }

  identity(): SeoGeoIncrementalityIdentity {
    const { strategy, provider, engine, operatorWebsiteOrigin, googleAdsCustomerId, scopeDigest } = this.policy;
    return Object.freeze({ strategy, provider, engine, operatorWebsiteOrigin, googleAdsCustomerId, scopeDigest });
  }

  registerDesign(input: SeoGeoIncrementalityDesignRequest): SeoGeoIncrementalityRegistration {
    if (!input || typeof input !== "object") throw new SeoGeoIncrementalityError("INVALID_CONFIG", "geo incrementality design request is required");
    exactScope(this.policy, input.operatorWebsiteOrigin, input.googleAdsCustomerId);
    const experimentKey = validateSeoGeoExperimentKey(input.experimentKey);
    const experimentId = scopedSeoGeoExperimentId(this.policy, experimentKey);
    const record = this.registry.registerDesign({
      experimentId,
      seed: input.seed,
      holdoutFraction: input.holdoutFraction,
      maxBaselineImbalance: input.maxBaselineImbalance,
      minGeosPerArm: input.minGeosPerArm,
      geos: input.geos,
    });
    if (record.experimentId !== experimentId || record.design.experimentId !== experimentId) throw new SeoGeoIncrementalityError("INTEGRITY_FAILURE", "registry returned a design outside the SEO #12 scope");
    return Object.freeze({ experimentKey, experimentId, scopeDigest: this.policy.scopeDigest, design: record.design });
  }

  analyze(input: SeoGeoIncrementalityAnalysisRequest): SeoGeoIncrementalityDecision {
    if (!input || typeof input !== "object") throw new SeoGeoIncrementalityError("INVALID_CONFIG", "geo incrementality analysis request is required");
    exactScope(this.policy, input.operatorWebsiteOrigin, input.googleAdsCustomerId);
    const experimentKey = validateSeoGeoExperimentKey(input.experimentKey);
    const experimentId = scopedSeoGeoExperimentId(this.policy, experimentKey);
    const existing = this.registry.get(experimentId);
    if (!existing) throw new SeoGeoIncrementalityError("INCOMPLETE_ANALYSIS", "geo experiment is not registered for this SEO #12 scope");
    if (existing.design.experimentId !== experimentId) throw new SeoGeoIncrementalityError("INTEGRITY_FAILURE", "registered geo design scope is corrupt");
    const committed = this.registry.analyze(experimentId, input.outcomes as readonly GeoOutcome[]);
    const analysis = requireAnalysis(committed);
    return Object.freeze({ experimentKey, experimentId, scopeDigest: this.policy.scopeDigest, analysis, gate: gateFor(analysis) });
  }
}
