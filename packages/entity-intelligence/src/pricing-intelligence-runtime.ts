import { validateCompetitiveScope, type CompetitiveScope } from "./competitive-intelligence";
import { analyzePricingIntelligence, capturePublicPricing, type PricingReport } from "./pricing-intelligence";

export interface PricingRuntimeRequest { readonly scope: CompetitiveScope; readonly subjectId: string; readonly observedAt: string; readonly url: string; readonly timeoutMs?: number }

export async function runPricingIntelligence(request: PricingRuntimeRequest, signal?: AbortSignal): Promise<PricingReport> {
  if (!request || typeof request !== "object") throw new Error("pricing runtime request must be an object");
  const scope = validateCompetitiveScope(request.scope);
  const observation = await capturePublicPricing(request.url, request.observedAt, { scope, timeoutMs: request.timeoutMs, signal });
  return analyzePricingIntelligence(scope, request.subjectId, observation);
}
