import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SqliteOntologyTransactionStore } from "../sqlite-transaction-store";
import type { BusinessProfitabilityProvider, GoogleAdsBiddingGateway } from "./index";
import type { GoogleAdsCampaignSnapshot, GoogleAdsControlMutation, GoogleAdsMutationReceipt, GoogleAdsPortfolioSnapshot } from "./google-ads-rest";
import { createBiddingProductionRuntime, parseBiddingProductionConfig } from "./production-runtime";

const directories: string[] = [];
afterEach(() => {
  vi.useRealTimers();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("CORTEX bidding periodic scheduler", () => {
  it("fires the configured interval and applies one governed cycle", async () => {
    const now = Date.parse("2026-09-05T23:30:00.000Z");
    vi.useFakeTimers({ now });
    const directory = mkdtempSync(join(tmpdir(), "nexus-bidding-scheduler-"));
    directories.push(directory);
    const store = new SqliteOntologyTransactionStore(join(directory, "cortex.sqlite"));
    let budget = 10_000_000;
    let mutations = 0;
    const google: GoogleAdsBiddingGateway = {
      async getCampaignSnapshot(customerId, campaignId): Promise<GoogleAdsCampaignSnapshot> {
        return { customerId, campaignId, campaignResourceName: `customers/${customerId}/campaigns/${campaignId}`, campaignName: "Scheduler fixture", status: "ENABLED", budgetResourceName: `customers/${customerId}/campaignBudgets/2222222222`, budgetAmountMicros: budget, budgetExplicitlyShared: false, recommendedBudgetAmountMicros: null, biddingStrategyType: "OTHER", biddingStrategySystemStatus: "ELIGIBLE", portfolioBiddingStrategyResourceName: null, standardTargetCpaMicros: null, standardTargetRoas: null, costMicros: 2_000_000, conversions: 4, conversionValue: 8 };
      },
      async getPortfolioSnapshot(): Promise<GoogleAdsPortfolioSnapshot> { throw new Error("portfolio read not expected"); },
      async applyMutation(_customerId: string, action: GoogleAdsControlMutation): Promise<GoogleAdsMutationReceipt> {
        if (action.kind !== "CAMPAIGN_BUDGET" || action.expectedAmountMicros !== budget) throw new Error("unexpected scheduler mutation");
        budget = action.nextAmountMicros;
        mutations += 1;
        return { requestId: "scheduler-mutation-1", resourceName: action.resourceName, recoveredAlreadyApplied: false };
      },
    };
    const profitability: BusinessProfitabilityProvider = {
      async getProfitability(query) {
        return { ...query, revenueMicros: 12_000_000, grossProfitBeforeAdSpendMicros: 8_000_000, qualifiedConversions: 4, observedAt: new Date(Date.now()).toISOString(), sourceId: "scheduler-finance-fixture" };
      },
    };
    const config = parseBiddingProductionConfig({
      version: 1,
      scope: { tenantId: "tenant:bidding-scheduler", organizationId: "org:bidding-scheduler" },
      intervalMs: 300_000,
      policy: { policyId: "scheduler-policy", version: "v1", observationWindowDays: 14, reportingLagDays: 2, cooldownMs: 60_000, maxBusinessDataAgeMs: 3_600_000, minimumCostMicros: 1_000_000, minimumGoogleConversions: 1, increaseVolumeProfitToSpendRatio: 2, decreaseRiskProfitToSpendRatio: 0.8, budgetStepFraction: 0.1, targetStepFraction: 0.1, bidBoundStepFraction: 0.1, minBudgetMicros: 1_000_000, maxBudgetMicros: 100_000_000, minTargetCpaMicros: 100_000, maxTargetCpaMicros: 50_000_000, minTargetRoas: 0.1, maxTargetRoas: 20, minPortfolioCpcCeilingMicros: 10_000, maxPortfolioCpcCeilingMicros: 10_000_000, allowSharedBudgets: false, managePortfolioBidBounds: false, mode: "ACTIVE" },
      campaigns: [{ customerId: "1234567890", campaignId: "1111111111" }],
    });

    let resolveCycle!: () => void;
    const completed = new Promise<void>((resolve) => { resolveCycle = resolve; });
    const runtime = createBiddingProductionRuntime({ transactions: store, config, googleAds: google, profitability, apiToken: "scheduler-test-token-00000000000000000000000", onTelemetry: (event) => { if (event.operation === "CYCLE" && event.status === "OK" && event.trigger === "SCHEDULED") resolveCycle(); } });
    runtime.start(false);
    await vi.advanceTimersByTimeAsync(300_000);
    await completed;

    expect(mutations).toBe(1);
    expect(budget).toBe(11_000_000);

    await runtime.close();
    store.close();
  });
});
