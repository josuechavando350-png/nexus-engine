import { describe, expect, it } from "vitest";
import { InMemoryOntologyTransactionStore } from "@nexus/ontology/transaction";
import {
  PeriodicGoogleAdsBiddingSupervisor,
  createBiddingSupervisorPolicy,
  type BusinessProfitabilityProvider,
  type GoogleAdsBiddingGateway,
} from "./index";
import type { GoogleAdsCampaignSnapshot, GoogleAdsControlMutation, GoogleAdsMutationReceipt, GoogleAdsPortfolioSnapshot } from "./google-ads-rest";
import { FinancialGuardedBiddingAdapters } from "./financial-guardrails";

const NOW = Date.parse("2026-09-07T05:00:00.000Z");
const scope = { tenantId: "tenant:financial-guard", organizationId: "org:financial-guard" } as const;
const customerId = "1234567890";
const campaignId = "9876543210";
const campaignSnapshot: GoogleAdsCampaignSnapshot = {
  customerId,
  campaignId,
  campaignResourceName: `customers/${customerId}/campaigns/${campaignId}`,
  campaignName: "Financial Guard Campaign",
  status: "ENABLED",
  budgetResourceName: `customers/${customerId}/campaignBudgets/4444444444`,
  budgetAmountMicros: 10_000_000,
  budgetExplicitlyShared: false,
  recommendedBudgetAmountMicros: null,
  biddingStrategyType: "MAXIMIZE_CONVERSIONS",
  biddingStrategySystemStatus: "ELIGIBLE",
  portfolioBiddingStrategyResourceName: null,
  standardTargetCpaMicros: null,
  standardTargetRoas: null,
  costMicros: 2_000_000,
  conversions: 10,
  conversionValue: 20_000_000,
};
const supervisorPolicy = createBiddingSupervisorPolicy({
  policyId: "financial-guard-policy",
  version: "v1",
  observationWindowDays: 7,
  reportingLagDays: 1,
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
  maxTargetRoas: 100,
  minPortfolioCpcCeilingMicros: 100_000,
  maxPortfolioCpcCeilingMicros: 50_000_000,
  allowSharedBudgets: false,
  managePortfolioBidBounds: false,
  mode: "ACTIVE",
});

function gateway(mutations: GoogleAdsControlMutation[]): GoogleAdsBiddingGateway {
  return {
    async getCampaignSnapshot() { return campaignSnapshot; },
    async getPortfolioSnapshot(): Promise<GoogleAdsPortfolioSnapshot> { throw new Error("portfolio snapshot not expected"); },
    async applyMutation(_customerId: string, action: GoogleAdsControlMutation): Promise<GoogleAdsMutationReceipt> {
      mutations.push(action);
      return { requestId: `request-${mutations.length}`, resourceName: action.resourceName, recoveredAlreadyApplied: false };
    },
  };
}

function business(revenueMicros: number, grossProfitMicros: number, qualifiedConversions: number): BusinessProfitabilityProvider {
  return {
    async getProfitability(query) {
      return { ...query, revenueMicros, grossProfitBeforeAdSpendMicros: grossProfitMicros, qualifiedConversions, observedAt: new Date(NOW).toISOString(), sourceId: "finance-ledger-v1" };
    },
  };
}

function adapters(store: InMemoryOntologyTransactionStore, mutations: GoogleAdsControlMutation[], profitability: BusinessProfitabilityProvider) {
  return new FinancialGuardedBiddingAdapters({
    transactions: store,
    scope,
    campaigns: [{ customerId, campaignId }],
    googleAds: gateway(mutations),
    profitability,
    policy: {
      version: 1,
      maxSnapshotAgeMs: 3_600_000,
      minimumRevenueMicros: 5_000_000,
      minimumProfitAfterAdSpendMicros: 1_000_000,
      minimumQualifiedConversions: 2,
      minimumRevenueToSpendRatio: 2,
      allowedSourceIds: ["finance-ledger-v1"],
      minimumGrossMarginRatio: 0.3,
      maximumCustomerAcquisitionCostMicros: 300_000,
    },
    now: () => NOW,
  });
}

async function run(profitability: BusinessProfitabilityProvider) {
  const store = new InMemoryOntologyTransactionStore();
  const mutations: GoogleAdsControlMutation[] = [];
  const guarded = adapters(store, mutations, profitability);
  const engine = new PeriodicGoogleAdsBiddingSupervisor(store, scope, supervisorPolicy, guarded.googleAds, guarded.profitability, () => NOW);
  return { result: engine.supervise({ runId: "financial-guard-run", customerId, campaignId, mode: "ACTIVE" }), mutations };
}

describe("CORTEX #22 complete financial guardrails", () => {
  it("blocks an otherwise profitable expansion when gross margin is below policy", async () => {
    const { result, mutations } = await run(business(20_000_000, 5_000_000, 10));
    await expect(result).rejects.toMatchObject({ code: "POLICY_VIOLATION" });
    expect(mutations).toEqual([]);
  });

  it("blocks an otherwise profitable expansion when target CAC is exceeded", async () => {
    const { result, mutations } = await run(business(20_000_000, 8_000_000, 4));
    await expect(result).rejects.toMatchObject({ code: "POLICY_VIOLATION" });
    expect(mutations).toEqual([]);
  });

  it("allows expansion only when revenue, profit, margin and CAC all pass", async () => {
    const { result, mutations } = await run(business(20_000_000, 8_000_000, 10));
    await expect(result).resolves.toMatchObject({ status: "APPLIED", direction: "INCREASE_VOLUME" });
    expect(mutations).toHaveLength(1);
    expect(mutations[0]).toMatchObject({ kind: "CAMPAIGN_BUDGET", expectedAmountMicros: 10_000_000, nextAmountMicros: 11_000_000 });
  });

  it("still permits risk contraction when CAC and margin are poor", async () => {
    const { result, mutations } = await run(business(1_500_000, 1_000_000, 1));
    await expect(result).resolves.toMatchObject({ status: "APPLIED", direction: "DECREASE_RISK" });
    expect(mutations).toHaveLength(1);
    expect(mutations[0]).toMatchObject({ kind: "CAMPAIGN_BUDGET", nextAmountMicros: 9_000_000 });
  });
});
