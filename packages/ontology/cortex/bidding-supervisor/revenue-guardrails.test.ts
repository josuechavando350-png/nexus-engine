import { describe, expect, it, vi } from "vitest";
import { InMemoryOntologyTransactionStore } from "@nexus/ontology/transaction";
import { PeriodicGoogleAdsBiddingSupervisor, createBiddingSupervisorPolicy, type BusinessProfitabilityProvider, type GoogleAdsBiddingGateway } from "./index";
import type { GoogleAdsCampaignSnapshot, GoogleAdsControlMutation, GoogleAdsMutationReceipt, GoogleAdsPortfolioSnapshot } from "./google-ads-rest";
import { RevenueGuardedBiddingAdapters } from "./revenue-guardrails";

const NOW = Date.parse("2026-09-07T05:00:00.000Z");
const scope = { tenantId: "tenant:revenue-guard", organizationId: "org:revenue-guard" } as const;
const campaigns = [{ customerId: "1234567890", campaignId: "9876543210" }] as const;
const policy = createBiddingSupervisorPolicy({
  policyId: "revenue-guard-policy",
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

function campaign(): GoogleAdsCampaignSnapshot {
  return {
    customerId: campaigns[0].customerId,
    campaignId: campaigns[0].campaignId,
    campaignResourceName: `customers/${campaigns[0].customerId}/campaigns/${campaigns[0].campaignId}`,
    campaignName: "Guarded Campaign",
    status: "ENABLED",
    budgetResourceName: `customers/${campaigns[0].customerId}/campaignBudgets/4444444444`,
    budgetAmountMicros: 10_000_000,
    budgetExplicitlyShared: false,
    recommendedBudgetAmountMicros: null,
    biddingStrategyType: "MAXIMIZE_CONVERSIONS",
    biddingStrategySystemStatus: "ENABLED",
    portfolioBiddingStrategyResourceName: null,
    standardTargetCpaMicros: null,
    standardTargetRoas: null,
    costMicros: 2_000_000,
    conversions: 10,
    conversionValue: 20_000_000,
  };
}

function baseGateway(mutations: GoogleAdsControlMutation[]): GoogleAdsBiddingGateway {
  return {
    async getCampaignSnapshot() { return campaign(); },
    async getPortfolioSnapshot(): Promise<GoogleAdsPortfolioSnapshot> { throw new Error("portfolio snapshot not expected"); },
    async applyMutation(_customerId: string, action: GoogleAdsControlMutation): Promise<GoogleAdsMutationReceipt> {
      mutations.push(action);
      return { requestId: `request-${mutations.length}`, resourceName: action.resourceName, recoveredAlreadyApplied: false };
    },
  };
}

function profitability(grossProfitBeforeAdSpendMicros: number, revenueMicros = grossProfitBeforeAdSpendMicros * 2): BusinessProfitabilityProvider {
  return {
    async getProfitability(query) {
      return {
        ...query,
        revenueMicros,
        grossProfitBeforeAdSpendMicros,
        qualifiedConversions: 8,
        observedAt: new Date(NOW).toISOString(),
        sourceId: "finance-ledger-v1",
      };
    },
  };
}

function guarded(store: InMemoryOntologyTransactionStore, gateway: GoogleAdsBiddingGateway, business: BusinessProfitabilityProvider, telemetry = vi.fn()) {
  return new RevenueGuardedBiddingAdapters({
    transactions: store,
    scope,
    campaigns,
    googleAds: gateway,
    profitability: business,
    policy: {
      version: 1,
      maxSnapshotAgeMs: 3_600_000,
      minimumRevenueMicros: 5_000_000,
      minimumProfitAfterAdSpendMicros: 1_000_000,
      minimumQualifiedConversions: 2,
      minimumRevenueToSpendRatio: 2,
      allowedSourceIds: ["finance-ledger-v1"],
    },
    now: () => NOW,
    onTelemetry: telemetry,
  });
}

describe("CORTEX #22 revenue guardrails", () => {
  it("allows a financially-qualified expansion at the final Google Ads mutation frontier", async () => {
    const store = new InMemoryOntologyTransactionStore();
    const mutations: GoogleAdsControlMutation[] = [];
    const adapters = guarded(store, baseGateway(mutations), profitability(8_000_000, 20_000_000));
    const supervisor = new PeriodicGoogleAdsBiddingSupervisor(store, scope, policy, adapters.googleAds, adapters.profitability, () => NOW);
    const result = await supervisor.supervise({ runId: "qualified-expansion-0001", customerId: campaigns[0].customerId, campaignId: campaigns[0].campaignId, mode: "ACTIVE" });
    expect(result.status).toBe("APPLIED");
    expect(result.direction).toBe("INCREASE_VOLUME");
    expect(mutations).toHaveLength(1);
    expect(mutations[0]).toMatchObject({ kind: "CAMPAIGN_BUDGET", expectedAmountMicros: 10_000_000, nextAmountMicros: 11_000_000 });
  });

  it("blocks expansion with zero downstream mutation when realized-revenue guardrails fail", async () => {
    const store = new InMemoryOntologyTransactionStore();
    const mutations: GoogleAdsControlMutation[] = [];
    const adapters = guarded(store, baseGateway(mutations), profitability(8_000_000, 1_000_000));
    const supervisor = new PeriodicGoogleAdsBiddingSupervisor(store, scope, policy, adapters.googleAds, adapters.profitability, () => NOW);
    await expect(supervisor.supervise({ runId: "blocked-expansion-0001", customerId: campaigns[0].customerId, campaignId: campaigns[0].campaignId, mode: "ACTIVE" })).rejects.toMatchObject({ code: "POLICY_VIOLATION" });
    expect(mutations).toEqual([]);
  });

  it("allows risk contraction even when revenue is poor", async () => {
    const store = new InMemoryOntologyTransactionStore();
    const mutations: GoogleAdsControlMutation[] = [];
    const adapters = guarded(store, baseGateway(mutations), profitability(1_000_000, 1_500_000));
    const supervisor = new PeriodicGoogleAdsBiddingSupervisor(store, scope, policy, adapters.googleAds, adapters.profitability, () => NOW);
    const result = await supervisor.supervise({ runId: "risk-contraction-0001", customerId: campaigns[0].customerId, campaignId: campaigns[0].campaignId, mode: "ACTIVE" });
    expect(result.status).toBe("APPLIED");
    expect(result.direction).toBe("DECREASE_RISK");
    expect(mutations[0]).toMatchObject({ kind: "CAMPAIGN_BUDGET", expectedAmountMicros: 10_000_000, nextAmountMicros: 9_000_000 });
  });

  it("permits the exact durable rollback of a risk contraction after recreating the guard wrapper", async () => {
    const store = new InMemoryOntologyTransactionStore();
    const mutations: GoogleAdsControlMutation[] = [];
    const gateway = baseGateway(mutations);
    const firstAdapters = guarded(store, gateway, profitability(1_000_000, 1_500_000));
    const first = new PeriodicGoogleAdsBiddingSupervisor(store, scope, policy, firstAdapters.googleAds, firstAdapters.profitability, () => NOW);
    await first.supervise({ runId: "contraction-before-restart", customerId: campaigns[0].customerId, campaignId: campaigns[0].campaignId, mode: "ACTIVE" });
    expect(mutations).toHaveLength(1);

    const telemetry = vi.fn();
    const restartedAdapters = guarded(store, gateway, profitability(1_000_000, 1_500_000), telemetry);
    const restarted = new PeriodicGoogleAdsBiddingSupervisor(store, scope, policy, restartedAdapters.googleAds, restartedAdapters.profitability, () => NOW + 1_000);
    const rollback = await restarted.rollbackLastMutation({ runId: "rollback-after-restart", customerId: campaigns[0].customerId, campaignId: campaigns[0].campaignId });
    expect(rollback.status).toBe("ROLLED_BACK");
    expect(mutations).toHaveLength(2);
    expect(mutations[1]).toMatchObject({ kind: "CAMPAIGN_BUDGET", expectedAmountMicros: 9_000_000, nextAmountMicros: 10_000_000 });
    expect(telemetry).toHaveBeenCalledWith(expect.objectContaining({ operation: "ROLLBACK_BYPASS", reason: "EXACT_DURABLE_ROLLBACK" }));
  });
});
