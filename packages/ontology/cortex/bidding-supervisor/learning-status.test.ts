import { describe, expect, it } from "vitest";
import { InMemoryOntologyTransactionStore } from "@nexus/ontology/transaction";
import {
  PeriodicGoogleAdsBiddingSupervisor,
  createBiddingSupervisorPolicy,
  type BusinessProfitabilityProvider,
  type BusinessProfitabilityQuery,
  type BusinessProfitabilitySnapshot,
  type GoogleAdsBiddingGateway,
} from "./index";
import {
  GoogleAdsApiError,
  GoogleAdsRestClient,
  type GoogleAdsCampaignSnapshot,
  type GoogleAdsControlMutation,
  type GoogleAdsMutationReceipt,
  type GoogleAdsPortfolioSnapshot,
} from "./google-ads-rest";

const scope = Object.freeze({ tenantId: "tenant-cortex", organizationId: "org-cortex", brandId: "brand-cortex" });
const CUSTOMER_ID = "1234567890";
const CAMPAIGN_ID = "1111111111";
const CAMPAIGN_RESOURCE = `customers/${CUSTOMER_ID}/campaigns/${CAMPAIGN_ID}`;
const BUDGET_RESOURCE = `customers/${CUSTOMER_ID}/campaignBudgets/2222222222`;
const NOW = Date.parse("2026-09-04T18:00:00.000Z");

function policy() {
  return createBiddingSupervisorPolicy({
    policyId: "ads-supervisor",
    version: "v1",
    observationWindowDays: 14,
    reportingLagDays: 1,
    cooldownMs: 3_600_000,
    maxBusinessDataAgeMs: 7_200_000,
    minimumCostMicros: 50_000_000,
    minimumGoogleConversions: 5,
    increaseVolumeProfitToSpendRatio: 1.5,
    decreaseRiskProfitToSpendRatio: 0.8,
    budgetStepFraction: 0.1,
    targetStepFraction: 0.1,
    bidBoundStepFraction: 0.1,
    minBudgetMicros: 10_000_000,
    maxBudgetMicros: 500_000_000,
    minTargetCpaMicros: 5_000_000,
    maxTargetCpaMicros: 200_000_000,
    minTargetRoas: 0.5,
    maxTargetRoas: 20,
    minPortfolioCpcCeilingMicros: 500_000,
    maxPortfolioCpcCeilingMicros: 50_000_000,
    allowSharedBudgets: false,
    managePortfolioBidBounds: true,
    mode: "ACTIVE",
    maxWriteRetries: 3,
  });
}

function campaign(status: string): GoogleAdsCampaignSnapshot {
  return Object.freeze({
    customerId: CUSTOMER_ID,
    campaignId: CAMPAIGN_ID,
    campaignResourceName: CAMPAIGN_RESOURCE,
    campaignName: "Search Brand",
    status: "ENABLED",
    budgetResourceName: BUDGET_RESOURCE,
    budgetAmountMicros: 100_000_000,
    budgetExplicitlyShared: false,
    recommendedBudgetAmountMicros: 150_000_000,
    biddingStrategyType: "MAXIMIZE_CONVERSIONS",
    biddingStrategySystemStatus: status,
    portfolioBiddingStrategyResourceName: null,
    standardTargetCpaMicros: 50_000_000,
    standardTargetRoas: null,
    costMicros: 100_000_000,
    conversions: 10,
    conversionValue: 1_000,
  });
}

class StatusGateway implements GoogleAdsBiddingGateway {
  status = "ENABLED";
  campaignReads = 0;
  mutationCalls = 0;
  nextMutationError: GoogleAdsApiError | null = null;
  nextRecovered = false;

  async getCampaignSnapshot(): Promise<GoogleAdsCampaignSnapshot> {
    this.campaignReads += 1;
    return campaign(this.status);
  }

  async getPortfolioSnapshot(): Promise<GoogleAdsPortfolioSnapshot> {
    throw new Error("portfolio read is not expected");
  }

  async applyMutation(_customerId: string, action: GoogleAdsControlMutation): Promise<GoogleAdsMutationReceipt> {
    this.mutationCalls += 1;
    if (this.nextMutationError) {
      const error = this.nextMutationError;
      this.nextMutationError = null;
      throw error;
    }
    const recovered = this.nextRecovered;
    this.nextRecovered = false;
    return Object.freeze({ requestId: recovered ? null : `request-${this.mutationCalls}`, resourceName: action.resourceName, recoveredAlreadyApplied: recovered });
  }
}

class BusinessProvider implements BusinessProfitabilityProvider {
  calls = 0;

  async getProfitability(query: BusinessProfitabilityQuery): Promise<BusinessProfitabilitySnapshot> {
    this.calls += 1;
    return Object.freeze({
      ...query,
      revenueMicros: 400_000_000,
      grossProfitBeforeAdSpendMicros: 200_000_000,
      qualifiedConversions: 10,
      observedAt: new Date(NOW).toISOString(),
      sourceId: "crm-campaign",
    });
  }
}

function supervisor(gateway: StatusGateway, business: BusinessProvider) {
  return new PeriodicGoogleAdsBiddingSupervisor(new InMemoryOntologyTransactionStore(), scope, policy(), gateway, business, () => NOW);
}

describe("Google bidding strategy system status", () => {
  it("ingests campaign.bidding_strategy_system_status from the released REST surface", async () => {
    let query = "";
    const rest = new GoogleAdsRestClient({
      developerToken: "developer-token",
      accessTokenProvider: async () => "access-token",
      maxReadRetries: 0,
      fetchImpl: (async (_input: string | URL | Request, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body)) as { readonly query?: string };
        query = body.query ?? "";
        return new Response(JSON.stringify({
          results: [{
            campaign: {
              id: CAMPAIGN_ID,
              name: "Search Brand",
              resourceName: CAMPAIGN_RESOURCE,
              status: "ENABLED",
              campaignBudget: BUDGET_RESOURCE,
              biddingStrategyType: "MAXIMIZE_CONVERSIONS",
              biddingStrategySystemStatus: "LEARNING_BUDGET_CHANGE",
              maximizeConversions: { targetCpaMicros: "50000000" },
            },
            campaignBudget: { amountMicros: "100000000", explicitlyShared: false, recommendedBudgetAmountMicros: "150000000" },
            metrics: { costMicros: "100000000", conversions: 10, conversionsValue: 1000 },
          }],
        }), { status: 200, headers: { "content-type": "application/json" } });
      }) as typeof fetch,
    });

    const snapshot = await rest.getCampaignSnapshot(CUSTOMER_ID, CAMPAIGN_ID, Date.parse("2026-08-20T00:00:00.000Z"), Date.parse("2026-09-02T00:00:00.000Z"));
    expect(snapshot.biddingStrategySystemStatus).toBe("LEARNING_BUDGET_CHANGE");
    expect(query).toContain("campaign.bidding_strategy_system_status");
  });

  it.each([
    ["LEARNING_BUDGET_CHANGE", "BIDDING_STRATEGY_LEARNING"],
    ["LEARNING_SETTING_CHANGE", "BIDDING_STRATEGY_LEARNING"],
    ["MULTIPLE_LEARNING", "BIDDING_STRATEGY_LEARNING"],
    ["MISCONFIGURED_STRATEGY_TYPE", "BIDDING_STRATEGY_NOT_READY"],
    ["UNKNOWN", "BIDDING_STRATEGY_NOT_READY"],
    ["UNSPECIFIED", "BIDDING_STRATEGY_NOT_READY"],
  ] as const)("holds without business or mutation work for %s", async (status, expectedReason) => {
    const gateway = new StatusGateway();
    gateway.status = status;
    const business = new BusinessProvider();
    const result = await supervisor(gateway, business).supervise({ runId: `status-${status}`, customerId: CUSTOMER_ID, campaignId: CAMPAIGN_ID });

    expect(result.status).toBe("NOOP");
    expect(result.reason).toBe(expectedReason);
    expect(result.action).toBeNull();
    expect(gateway.campaignReads).toBe(1);
    expect(gateway.mutationCalls).toBe(0);
    expect(business.calls).toBe(0);
  });

  it("allows LIMITED states while still rechecking immediately before mutate", async () => {
    const gateway = new StatusGateway();
    gateway.status = "LIMITED_BY_BUDGET";
    const business = new BusinessProvider();
    const result = await supervisor(gateway, business).supervise({ runId: "limited-budget", customerId: CUSTOMER_ID, campaignId: CAMPAIGN_ID });

    expect(result.status).toBe("APPLIED");
    expect(result.action?.kind).toBe("CAMPAIGN_BUDGET");
    expect(gateway.campaignReads).toBe(2);
    expect(gateway.mutationCalls).toBe(1);
    expect(business.calls).toBe(1);
  });

  it("freezes an ambiguous PREPARED write if Google enters learning before recovery", async () => {
    const gateway = new StatusGateway();
    const business = new BusinessProvider();
    const engine = supervisor(gateway, business);
    gateway.nextMutationError = new GoogleAdsApiError("AMBIGUOUS_MUTATION_OUTCOME", "uncertain remote write");

    await expect(engine.supervise({ runId: "ambiguous-before-learning", customerId: CUSTOMER_ID, campaignId: CAMPAIGN_ID })).rejects.toMatchObject({ code: "REMOTE_FAILURE" });
    expect(gateway.mutationCalls).toBe(1);
    expect(business.calls).toBe(1);

    gateway.status = "LEARNING_SETTING_CHANGE";
    await expect(engine.supervise({ runId: "scheduler-during-learning", customerId: CUSTOMER_ID, campaignId: CAMPAIGN_ID })).rejects.toMatchObject({ code: "POLICY_VIOLATION" });
    expect(gateway.mutationCalls).toBe(1);
    expect(business.calls).toBe(1);

    gateway.status = "ENABLED";
    gateway.nextRecovered = true;
    const recovered = await engine.supervise({ runId: "scheduler-after-learning", customerId: CUSTOMER_ID, campaignId: CAMPAIGN_ID });
    expect(recovered.runId).toBe("ambiguous-before-learning");
    expect(recovered.status).toBe("APPLIED");
    expect(recovered.reason).toBe("ACTION_RECOVERED");
    expect(gateway.mutationCalls).toBe(2);
    expect(business.calls).toBe(1);
  });
});
