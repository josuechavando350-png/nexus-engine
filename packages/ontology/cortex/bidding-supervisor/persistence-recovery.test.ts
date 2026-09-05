import { describe, expect, it } from "vitest";
import type { OntologyScope, ValidatedSchema } from "@nexus/ontology";
import {
  InMemoryOntologyTransactionStore,
  type ObjectRecord,
  type OntologyTransactionPort,
  type RelationshipRecord,
  type TransactionOperation,
  type TransactionResult,
} from "@nexus/ontology/transaction";
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

class FailFinalizeOnceStore implements OntologyTransactionPort {
  private transactionCount = 0;
  private failed = false;

  constructor(private readonly delegate = new InMemoryOntologyTransactionStore()) {}

  transact(scopeValue: OntologyScope, schema: ValidatedSchema, operations: readonly TransactionOperation[]): TransactionResult {
    this.transactionCount += 1;
    if (!this.failed && this.transactionCount === 2) {
      this.failed = true;
      throw new Error("injected local finalize failure");
    }
    return this.delegate.transact(scopeValue, schema, operations);
  }

  getObject(scopeValue: OntologyScope, id: string): ObjectRecord | undefined {
    return this.delegate.getObject(scopeValue, id);
  }

  getRelationship(scopeValue: OntologyScope, id: string): RelationshipRecord | undefined {
    return this.delegate.getRelationship(scopeValue, id);
  }
}

class PreflightGateway implements GoogleAdsBiddingGateway {
  campaignReads = 0;
  mutationCalls = 0;
  budgetAmountMicros = 100_000_000;

  async getCampaignSnapshot(): Promise<GoogleAdsCampaignSnapshot> {
    this.campaignReads += 1;
    return Object.freeze({
      customerId: CUSTOMER_ID,
      campaignId: CAMPAIGN_ID,
      campaignResourceName: CAMPAIGN_RESOURCE,
      campaignName: "Search Brand",
      status: "ENABLED",
      budgetResourceName: BUDGET_RESOURCE,
      budgetAmountMicros: this.budgetAmountMicros,
      budgetExplicitlyShared: false,
      recommendedBudgetAmountMicros: 150_000_000,
      biddingStrategyType: "OTHER",
      portfolioBiddingStrategyResourceName: null,
      standardTargetCpaMicros: null,
      standardTargetRoas: null,
      costMicros: 100_000_000,
      conversions: 10,
      conversionValue: 1_000,
    });
  }

  async getPortfolioSnapshot(): Promise<GoogleAdsPortfolioSnapshot> {
    throw new Error("portfolio read is not expected");
  }

  async applyMutation(_customerId: string, action: GoogleAdsControlMutation): Promise<GoogleAdsMutationReceipt> {
    this.mutationCalls += 1;
    if (action.kind !== "CAMPAIGN_BUDGET") throw new Error("budget action expected");
    if (this.budgetAmountMicros === action.nextAmountMicros) {
      return Object.freeze({ requestId: null, resourceName: action.resourceName, recoveredAlreadyApplied: true });
    }
    if (this.budgetAmountMicros !== action.expectedAmountMicros) {
      throw new GoogleAdsApiError("REMOTE_CONFLICT", "remote budget drifted");
    }
    this.budgetAmountMicros = action.nextAmountMicros;
    return Object.freeze({ requestId: "request-1", resourceName: action.resourceName, recoveredAlreadyApplied: false });
  }
}

class BusinessProvider implements BusinessProfitabilityProvider {
  async getProfitability(query: BusinessProfitabilityQuery): Promise<BusinessProfitabilitySnapshot> {
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

describe("bidding supervisor persistence recovery", () => {
  it("keeps the original run locked when Google applies but local finalization fails", async () => {
    const store = new FailFinalizeOnceStore();
    const gateway = new PreflightGateway();
    const supervisor = new PeriodicGoogleAdsBiddingSupervisor(store, scope, policy(), gateway, new BusinessProvider(), () => NOW);

    await expect(supervisor.supervise({ runId: "write-then-local-failure", customerId: CUSTOMER_ID, campaignId: CAMPAIGN_ID }))
      .rejects.toMatchObject({ code: "PERSISTENCE_FAILURE" });
    expect(gateway.budgetAmountMicros).toBe(110_000_000);
    expect(gateway.mutationCalls).toBe(1);
    const readsAfterRemoteWrite = gateway.campaignReads;

    const recovered = await supervisor.supervise({ runId: "must-not-replan", customerId: CUSTOMER_ID, campaignId: CAMPAIGN_ID });
    expect(recovered.runId).toBe("write-then-local-failure");
    expect(recovered.status).toBe("APPLIED");
    expect(recovered.reason).toBe("ACTION_RECOVERED");
    expect(gateway.campaignReads).toBe(readsAfterRemoteWrite);
    expect(gateway.mutationCalls).toBe(2);
  });

  it("never reactivates an OBSERVE_ONLY proposal on an ACTIVE replay", async () => {
    const gateway = new PreflightGateway();
    const supervisor = new PeriodicGoogleAdsBiddingSupervisor(new InMemoryOntologyTransactionStore(), scope, policy(), gateway, new BusinessProvider(), () => NOW);

    const observed = await supervisor.supervise({ runId: "observe-terminal", customerId: CUSTOMER_ID, campaignId: CAMPAIGN_ID, mode: "OBSERVE_ONLY" });
    expect(observed.status).toBe("NOOP");
    expect(observed.reason).toBe("OBSERVE_ONLY");
    expect(observed.action?.kind).toBe("CAMPAIGN_BUDGET");
    expect(gateway.mutationCalls).toBe(0);

    const replay = await supervisor.supervise({ runId: "observe-terminal", customerId: CUSTOMER_ID, campaignId: CAMPAIGN_ID, mode: "ACTIVE" });
    expect(replay.status).toBe("NOOP");
    expect(replay.reason).toBe("OBSERVE_ONLY");
    expect(gateway.mutationCalls).toBe(0);
  });
});
