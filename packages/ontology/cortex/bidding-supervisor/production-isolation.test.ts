import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SqliteOntologyTransactionStore } from "../sqlite-transaction-store";
import type { BusinessProfitabilityProvider, GoogleAdsBiddingGateway } from "./index";
import type { GoogleAdsCampaignSnapshot, GoogleAdsControlMutation, GoogleAdsMutationReceipt, GoogleAdsPortfolioSnapshot } from "./google-ads-rest";
import { createBiddingProductionRuntime, parseBiddingProductionConfig, type BiddingRuntimeTelemetryEvent } from "./production-runtime";

function productionConfig() {
  return parseBiddingProductionConfig({
    version: 1,
    scope: { tenantId: "tenant:bidding-isolation", organizationId: "org:bidding-isolation" },
    intervalMs: 300_000,
    policy: {
      policyId: "isolation-policy",
      version: "v1",
      observationWindowDays: 14,
      reportingLagDays: 2,
      cooldownMs: 60_000,
      maxBusinessDataAgeMs: 3_600_000,
      minimumCostMicros: 1_000_000,
      minimumGoogleConversions: 1,
      increaseVolumeProfitToSpendRatio: 2,
      decreaseRiskProfitToSpendRatio: 0.8,
      budgetStepFraction: 0.1,
      targetStepFraction: 0.1,
      bidBoundStepFraction: 0.1,
      minBudgetMicros: 1_000_000,
      maxBudgetMicros: 100_000_000,
      minTargetCpaMicros: 100_000,
      maxTargetCpaMicros: 50_000_000,
      minTargetRoas: 0.1,
      maxTargetRoas: 20,
      minPortfolioCpcCeilingMicros: 10_000,
      maxPortfolioCpcCeilingMicros: 10_000_000,
      allowSharedBudgets: false,
      managePortfolioBidBounds: false,
      mode: "ACTIVE",
    },
    campaigns: [
      { customerId: "1234567890", campaignId: "1111111111" },
      { customerId: "1234567890", campaignId: "2222222222" },
    ],
  });
}

describe("CORTEX bidding cycle campaign isolation", () => {
  it("continues supervising healthy campaigns after an unrelated campaign fails", async () => {
    const directory = mkdtempSync(join(tmpdir(), "nexus-bidding-isolation-"));
    const store = new SqliteOntologyTransactionStore(join(directory, "cortex.sqlite"));
    const now = Date.parse("2026-09-05T23:45:00.000Z");
    let secondBudget = 10_000_000;
    let mutations = 0;
    const telemetry: BiddingRuntimeTelemetryEvent[] = [];

    const google: GoogleAdsBiddingGateway = {
      async getCampaignSnapshot(customerId, campaignId): Promise<GoogleAdsCampaignSnapshot> {
        if (campaignId === "1111111111") throw new Error("campaign-one upstream unavailable");
        return {
          customerId,
          campaignId,
          campaignResourceName: `customers/${customerId}/campaigns/${campaignId}`,
          campaignName: "Healthy fixture",
          status: "ENABLED",
          budgetResourceName: `customers/${customerId}/campaignBudgets/3333333333`,
          budgetAmountMicros: secondBudget,
          budgetExplicitlyShared: false,
          recommendedBudgetAmountMicros: null,
          biddingStrategyType: "OTHER",
          biddingStrategySystemStatus: "ENABLED",
          portfolioBiddingStrategyResourceName: null,
          standardTargetCpaMicros: null,
          standardTargetRoas: null,
          costMicros: 2_000_000,
          conversions: 4,
          conversionValue: 8,
        };
      },
      async getPortfolioSnapshot(): Promise<GoogleAdsPortfolioSnapshot> { throw new Error("portfolio read not expected"); },
      async applyMutation(_customerId: string, action: GoogleAdsControlMutation): Promise<GoogleAdsMutationReceipt> {
        if (action.kind !== "CAMPAIGN_BUDGET" || action.expectedAmountMicros !== secondBudget) throw new Error("unexpected mutation");
        secondBudget = action.nextAmountMicros;
        mutations += 1;
        return { requestId: "healthy-mutation", resourceName: action.resourceName, recoveredAlreadyApplied: false };
      },
    };
    const profitability: BusinessProfitabilityProvider = {
      async getProfitability(query) {
        return { ...query, revenueMicros: 12_000_000, grossProfitBeforeAdSpendMicros: 8_000_000, qualifiedConversions: 4, observedAt: new Date(now).toISOString(), sourceId: "isolation-finance-fixture" };
      },
    };
    const runtime = createBiddingProductionRuntime({
      transactions: store,
      config: productionConfig(),
      googleAds: google,
      profitability,
      apiToken: "isolation-runtime-token-0000000000000000000000",
      now: () => now,
      onTelemetry: (event) => telemetry.push(event),
    });

    await expect(runtime.runOnce("MANUAL")).rejects.toThrow("campaign-one upstream unavailable");
    expect(mutations).toBe(1);
    expect(secondBudget).toBe(11_000_000);
    expect(telemetry).toEqual(expect.arrayContaining([
      expect.objectContaining({ operation: "CAMPAIGN", campaignId: "1111111111", status: "FAILED" }),
      expect.objectContaining({ operation: "CAMPAIGN", campaignId: "2222222222", status: "OK" }),
      expect.objectContaining({ operation: "CYCLE", status: "FAILED" }),
    ]));

    await runtime.close();
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });
});