import { describe, expect, it } from "vitest";
import { analyzePricingIntelligence, capturePublicPricing, createControlledPricingObservation, verifyPricingIntelligence } from "./pricing-intelligence";

const scope = { tenantId:"tenant-a", organizationId:"org-a", brandId:"brand-a" } as const;
const now = "2026-08-31T13:45:00.000Z";
const bodyDigest = "a".repeat(64);
const lookup = async () => [{ address:"93.184.216.34", family:4 }];

describe("pricing intelligence", () => {
  it("captures bounded public-price evidence through controlled transport and marks it synthetic", async () => {
    const observation = await capturePublicPricing("https://example.com/pricing", now, { scope, lookup, fetchImpl: async () => new Response("<main>Plan USD 12.50 and $9</main>",{status:200}) });
    expect(observation.authority).toBe("CONTROLLED_TEST");
    expect(observation.quotes.map((q)=>[q.currency,q.amountMinor])).toEqual([["USD",900],["USD",1250]]);
    const report = analyzePricingIntelligence(scope,"subject",observation);
    expect(report.evidenceState).toBe("SYNTHETIC");
    expect(report.nonClaim).toBe("PUBLIC_PRICE_OBSERVATION_NOT_TRANSACTION_MARKET_PRICE_OR_BUSINESS_OUTCOME");
    expect(verifyPricingIntelligence(scope,"subject",observation,report)).toBe(true);
  });

  it("rejects cross-tenant replay and tampering", () => {
    const observation = createControlledPricingObservation({ scope, url:"https://example.com/", finalUrl:"https://example.com/", observedAt:now, quotes:[{amountMinor:1000,currency:"USD",evidence:"USD 10"}], bodyDigest });
    const report = analyzePricingIntelligence(scope,"subject",observation);
    expect(()=>analyzePricingIntelligence({ ...scope, tenantId:"tenant-b" },"subject",observation)).toThrow(/scope mismatch/u);
    expect(verifyPricingIntelligence(scope,"subject",observation,{ ...report, sourceDigest:"b".repeat(64) })).toBe(false);
    expect(()=>analyzePricingIntelligence(scope,"subject",{ ...observation, bodyDigest:"b".repeat(64) })).toThrow(/replay mismatch/u);
  });

  it("does not accept forged public authority", () => {
    const controlled = createControlledPricingObservation({ scope, url:"https://example.com/", finalUrl:"https://example.com/", observedAt:now, quotes:[], bodyDigest });
    const forgedCore = { ...controlled, authority:"PUBLIC_HTTP_CAPTURE" as const };
    expect(()=>analyzePricingIntelligence(scope,"subject",forgedCore)).toThrow();
  });

  it("enforces timeout/body/quote bounds and cancellation", async () => {
    await expect(capturePublicPricing("https://example.com/",now,{scope,lookup,timeoutMs:99,fetchImpl:async()=>new Response("ok")})).rejects.toThrow(/timeoutMs/u);
    const controller = new AbortController(); controller.abort(new Error("cancelled"));
    await expect(capturePublicPricing("https://example.com/",now,{scope,lookup,signal:controller.signal,fetchImpl:async()=>new Response("ok")})).rejects.toThrow(/cancelled/u);
    expect(()=>createControlledPricingObservation({scope,url:"https://example.com/",finalUrl:"https://example.com/",observedAt:now,quotes:[{amountMinor:-1,currency:"USD",evidence:"bad"}],bodyDigest})).toThrow(/amountMinor/u);
  });
});
