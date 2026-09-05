import { describe, expect, it } from "vitest";
import { InMemoryOntologyTransactionStore } from "@nexus/ontology/transaction";
import {
  PeriodicGoogleAdsBiddingSupervisor,
  createBiddingSupervisorPolicy,
  type BusinessProfitabilityProvider,
  type BusinessProfitabilityQuery,
  type GoogleAdsBiddingGateway,
} from "./index";
import {
  GoogleAdsApiError,
  type GoogleAdsCampaignSnapshot,
  type GoogleAdsControlMutation,
  type GoogleAdsMutationReceipt,
  type GoogleAdsPortfolioSnapshot,
} from "./google-ads-rest";

const scope = Object.freeze({ tenantId: "tenant:rollback-safety", organizationId: "org:rollback-safety" });
const CUSTOMER_ID = "1234567890";
const CAMPAIGN_ID = "1111111111";
const CAMPAIGN_RESOURCE = `customers/${CUSTOMER_ID}/campaigns/${CAMPAIGN_ID}`;
const BUDGET_RESOURCE = `customers/${CUSTOMER_ID}/campaignBudgets/2222222222`;

function policy() {
  return createBiddingSupervisorPolicy({
    policyId: "rollback-safety-policy",
    version: "v1",
    observationWindowDays: 14,
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
    maxBudgetMicros: 500_000_000,
    minTargetCpaMicros: 100_000,
    maxTargetCpaMicros: 50_000_000,
    minTargetRoas: 0.1,
    maxTargetRoas: 20,
    minPortfolioCpcCeilingMicros: 10_000,
    maxPortfolioCpcCeilingMicros: 10_000_000,
    allowSharedBudgets: false,
    managePortfolioBidBounds: false,
    mode: "ACTIVE",
  });
}

class AmbiguousSecondMutationGateway implements GoogleAdsBiddingGateway {
  budgetMicros = 100_000_000;
  mutationCalls = 0;

  async getCampaignSnapshot(): Promise<GoogleAdsCampaignSnapshot> {
    return {
      customerId: CUSTOMER_ID,
      campaignId: CAMPAIGN_ID,
      campaignResourceName: CAMPAIGN_RESOURCE,
      campaignName: "Rollback safety fixture",
      status: "ENABLED",
      budgetResourceName: BUDGET_RESOURCE,
      budgetAmountMicros: this.budgetMicros,
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
  }

  async getPortfolioSnapshot(): Promise<GoogleAdsPortfolioSnapshot> {
    throw new Error("portfolio read not expected");
  }

  async applyMutation(_customerId: string, action: GoogleAdsControlMutation): Promise<GoogleAdsMutationReceipt> {
    this.mutationCalls += 1;
    if (action.kind !== "CAMPAIGN_BUDGET") throw new Error("campaign budget action expected");
    if (this.mutationCalls === 2) {
      throw new GoogleAdsApiError("AMBIGUOUS_MUTATION_OUTCOME", "injected ambiguous forward write");
    }
    if (this.budgetMicros !== action.expectedAmountMicros) throw new Error("unexpected remote budget precondition");
    this.budgetMicros = action.nextAmountMicros;
    return { requestId: `mutation-${this.mutationCalls}`, resourceName: action.resourceName, recoveredAlreadyApplied: false };
  }
}

describe("CORTEX bidding rollback safety", () => {
  it("never uses rollback to reconcile a forward PREPARED mutation", async () => {
    let now = Date.parse("2026-09-05T22:00:00.000Z");
    const gateway = new AmbiguousSecondMutationGateway();
    const profitability: BusinessProfitabilityProvider = {
      async getProfitability(query: BusinessProfitabilityQuery) {
        return {
          ...query,
          revenueMicros: 12_000_000,
          grossProfitBeforeAdSpendMicros: 8_000_000,
          qualifiedConversions: 4,
          observedAt: new Date(now).toISOString(),
          sourceId: "rollback-safety-finance",
        };
      },
    };
    const supervisor = new PeriodicGoogleAdsBiddingSupervisor(
      new InMemoryOntologyTransactionStore(),
      scope,
      policy(),
      gateway,
      profitability,
      () => now,
    );

    const applied = await supervisor.supervise({ runId: "forward-applied", customerId: CUSTOMER_ID, campaignId: CAMPAIGN_ID });
    expect(applied).toMatchObject({ status: "APPLIED", reason: "ACTION_APPLIED" });
    expect(gateway.budgetMicros).toBe(110_000_000);
    expect(gateway.mutationCalls).toBe(1);

    now += 120_000;
    await expect(supervisor.supervise({ runId: "forward-ambiguous", customerId: CUSTOMER_ID, campaignId: CAMPAIGN_ID }))
      .rejects.toMatchObject({ code: "REMOTE_FAILURE" });
    expect(gateway.budgetMicros).toBe(110_000_000);
    expect(gateway.mutationCalls).toBe(2);

    await expect(supervisor.rollbackLastMutation({ runId: "rollback-new-id", customerId: CUSTOMER_ID, campaignId: CAMPAIGN_ID }))
      .rejects.toMatchObject({ code: "POLICY_VIOLATION" });
    expect(gateway.mutationCalls).toBe(2);

    await expect(supervisor.rollbackLastMutation({ runId: "forward-ambiguous", customerId: CUSTOMER_ID, campaignId: CAMPAIGN_ID }))
      .rejects.toMatchObject({ code: "POLICY_VIOLATION" });
    expect(gateway.mutationCalls).toBe(2);
    expect(gateway.budgetMicros).toBe(110_000_000);
  });
});