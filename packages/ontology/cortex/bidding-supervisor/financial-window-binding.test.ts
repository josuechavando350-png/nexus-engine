import { describe, expect, it } from "vitest";
import { InMemoryOntologyTransactionStore } from "@nexus/ontology/transaction";
import type { BusinessProfitabilityProvider, GoogleAdsBiddingGateway } from "./index";
import type { GoogleAdsCampaignSnapshot, GoogleAdsControlMutation, GoogleAdsMutationReceipt, GoogleAdsPortfolioSnapshot } from "./google-ads-rest";
import { FinancialGuardedBiddingAdapters } from "./financial-guardrails";
import { RevenueGuardedBiddingAdapters } from "./revenue-guardrails";

const scope = { tenantId: "tenant:window-binding", organizationId: "org:window-binding" } as const;
const customerId = "1234567890";
const campaignId = "9876543210";
const budgetResourceName = `customers/${customerId}/campaignBudgets/4444444444`;
const windowA = { startMs: Date.parse("2026-08-24T00:00:00.000Z"), endMs: Date.parse("2026-08-31T00:00:00.000Z") };
const windowB = { start: "2026-08-25T00:00:00.000Z", end: "2026-09-01T00:00:00.000Z" };
const expansion: GoogleAdsControlMutation = { kind: "CAMPAIGN_BUDGET", resourceName: budgetResourceName, expectedAmountMicros: 10_000_000, nextAmountMicros: 11_000_000 };

function snapshot(): GoogleAdsCampaignSnapshot {
  return { customerId, campaignId, campaignResourceName: `customers/${customerId}/campaigns/${campaignId}`, campaignName: "Window Binding Campaign", status: "ENABLED", budgetResourceName, budgetAmountMicros: 10_000_000, budgetExplicitlyShared: false, recommendedBudgetAmountMicros: null, biddingStrategyType: "MAXIMIZE_CONVERSIONS", biddingStrategySystemStatus: "ELIGIBLE", portfolioBiddingStrategyResourceName: null, standardTargetCpaMicros: null, standardTargetRoas: null, costMicros: 2_000_000, conversions: 10, conversionValue: 20_000_000 };
}
function gateway(mutations: GoogleAdsControlMutation[]): GoogleAdsBiddingGateway {
  return { async getCampaignSnapshot() { return snapshot(); }, async getPortfolioSnapshot(): Promise<GoogleAdsPortfolioSnapshot> { throw new Error("portfolio read not expected"); }, async applyMutation(_customer: string, action: GoogleAdsControlMutation): Promise<GoogleAdsMutationReceipt> { mutations.push(action); return { requestId: "window-binding-mutation", resourceName: action.resourceName, recoveredAlreadyApplied: false }; } };
}
const profitability: BusinessProfitabilityProvider = { async getProfitability(query) { return { ...query, revenueMicros: 20_000_000, grossProfitBeforeAdSpendMicros: 8_000_000, qualifiedConversions: 10, observedAt: "2026-09-01T00:30:00.000Z", sourceId: "finance-ledger-v1" }; } };
function queryForWindowB() { return { customerId, scopeKind: "CAMPAIGN" as const, scopeId: campaignId, windowStart: windowB.start, windowEnd: windowB.end }; }
const revenuePolicy = { version: 1 as const, maxSnapshotAgeMs: 86_400_000, minimumRevenueMicros: 1, minimumProfitAfterAdSpendMicros: 1, minimumQualifiedConversions: 1, minimumRevenueToSpendRatio: 1, allowedSourceIds: ["finance-ledger-v1"] as const };

async function proveReject(guarded: { googleAds: GoogleAdsBiddingGateway; profitability: BusinessProfitabilityProvider }, mutations: GoogleAdsControlMutation[]) {
  await guarded.googleAds.getCampaignSnapshot(customerId, campaignId, windowA.startMs, windowA.endMs);
  await guarded.profitability.getProfitability(queryForWindowB());
  await expect(guarded.googleAds.applyMutation(customerId, expansion)).rejects.toMatchObject({ code: "POLICY_VIOLATION" });
  expect(mutations).toEqual([]);
}

describe("CORTEX #22 reporting-window binding", () => {
  it("rejects mixed-window revenue evidence", async () => {
    const mutations: GoogleAdsControlMutation[] = [];
    const guarded = new RevenueGuardedBiddingAdapters({ transactions: new InMemoryOntologyTransactionStore(), scope, campaigns: [{ customerId, campaignId }], googleAds: gateway(mutations), profitability, policy: revenuePolicy, now: () => Date.parse("2026-09-01T01:00:00.000Z") });
    await proveReject(guarded, mutations);
  });
  it("rejects mixed-window margin and CAC evidence", async () => {
    const mutations: GoogleAdsControlMutation[] = [];
    const guarded = new FinancialGuardedBiddingAdapters({ transactions: new InMemoryOntologyTransactionStore(), scope, campaigns: [{ customerId, campaignId }], googleAds: gateway(mutations), profitability, policy: { ...revenuePolicy, minimumGrossMarginRatio: 0.3, maximumCustomerAcquisitionCostMicros: 300_000 }, now: () => Date.parse("2026-09-01T01:00:00.000Z") });
    await proveReject(guarded, mutations);
  });
});
