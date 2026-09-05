import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SqliteOntologyTransactionStore } from "../sqlite-transaction-store";
import type { BusinessProfitabilityProvider, BusinessProfitabilityQuery, GoogleAdsBiddingGateway } from "./index";
import type { GoogleAdsCampaignSnapshot, GoogleAdsControlMutation, GoogleAdsMutationReceipt, GoogleAdsPortfolioSnapshot } from "./google-ads-rest";
import { createBiddingProductionRuntime, parseBiddingProductionConfig, type BiddingProductionRuntime } from "./production-runtime";

const CUSTOMER_ID = "1234567890";
const CAMPAIGN_ID = "1111111111";
const TOKEN = "mid-flight-kill-test-token-000000000000000000000";
const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });

function config() {
  return parseBiddingProductionConfig({
    version: 1,
    scope: { tenantId: "tenant:mid-flight-kill", organizationId: "org:mid-flight-kill" },
    intervalMs: 300_000,
    policy: {
      policyId: "mid-flight-kill-policy",
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
    campaigns: [{ customerId: CUSTOMER_ID, campaignId: CAMPAIGN_ID }],
  });
}

function campaignSnapshot(customerId: string, campaignId: string, budgetMicros: number): GoogleAdsCampaignSnapshot {
  return {
    customerId,
    campaignId,
    campaignResourceName: `customers/${customerId}/campaigns/${campaignId}`,
    campaignName: "Mid-flight kill fixture",
    status: "ENABLED",
    budgetResourceName: `customers/${customerId}/campaignBudgets/2222222222`,
    budgetAmountMicros: budgetMicros,
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

async function listen(runtime: BiddingProductionRuntime): Promise<string> {
  await new Promise<void>((resolve, reject) => {
    runtime.server.once("error", reject);
    runtime.server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = runtime.server.address();
  if (!address || typeof address === "string") throw new Error("runtime did not expose a TCP address");
  return `http://127.0.0.1:${address.port}`;
}

describe("CORTEX bidding last-moment kill guard", () => {
  it("blocks a forward Google Ads mutation when KILLED arrives during remote preflight", async () => {
    const directory = mkdtempSync(join(tmpdir(), "nexus-bidding-mid-flight-kill-"));
    directories.push(directory);
    const store = new SqliteOntologyTransactionStore(join(directory, "cortex.sqlite"));
    let now = Date.parse("2026-09-05T23:55:00.000Z");
    let budgetMicros = 10_000_000;
    let campaignReads = 0;
    let mutations = 0;
    let releasePreflight!: () => void;
    let signalPreflight!: () => void;
    const preflightEntered = new Promise<void>((resolve) => { signalPreflight = resolve; });
    const preflightRelease = new Promise<void>((resolve) => { releasePreflight = resolve; });

    const google: GoogleAdsBiddingGateway = {
      async getCampaignSnapshot(customerId, campaignId): Promise<GoogleAdsCampaignSnapshot> {
        campaignReads += 1;
        if (campaignReads === 2) {
          signalPreflight();
          await preflightRelease;
        }
        return campaignSnapshot(customerId, campaignId, budgetMicros);
      },
      async getPortfolioSnapshot(): Promise<GoogleAdsPortfolioSnapshot> { throw new Error("portfolio read not expected"); },
      async applyMutation(_customerId: string, action: GoogleAdsControlMutation): Promise<GoogleAdsMutationReceipt> {
        mutations += 1;
        if (action.kind !== "CAMPAIGN_BUDGET") throw new Error("unexpected mutation kind");
        budgetMicros = action.nextAmountMicros;
        return { requestId: "must-never-be-issued", resourceName: action.resourceName, recoveredAlreadyApplied: false };
      },
    };
    const profitability: BusinessProfitabilityProvider = {
      async getProfitability(query: BusinessProfitabilityQuery) {
        return { ...query, revenueMicros: 12_000_000, grossProfitBeforeAdSpendMicros: 8_000_000, qualifiedConversions: 4, observedAt: new Date(now).toISOString(), sourceId: "mid-flight-finance-fixture" };
      },
    };
    const runtime = createBiddingProductionRuntime({ transactions: store, config: config(), googleAds: google, profitability, apiToken: TOKEN, now: () => now });
    const base = await listen(runtime);

    const cycle = runtime.runOnce("MANUAL");
    await preflightEntered;

    const killResponse = await fetch(`${base}/v1/bidding/control`, {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({ expectedRevision: 0, mode: "KILLED", reason: "operator emergency kill during Google preflight" }),
    });
    expect(killResponse.status).toBe(200);
    expect(await killResponse.json()).toMatchObject({ effectiveMode: "KILLED", state: { mode: "KILLED", revision: 1 } });

    releasePreflight();
    await expect(cycle).rejects.toMatchObject({ code: "REMOTE_FAILURE" });
    expect(mutations).toBe(0);
    expect(budgetMicros).toBe(10_000_000);

    now += 300_000;
    const killedCycle = await runtime.runOnce("SCHEDULED");
    expect(killedCycle[0]).toMatchObject({ status: "NOOP", reason: "KILL_SWITCH", mode: "KILLED" });
    expect(mutations).toBe(0);

    const controlResponse = await fetch(`${base}/v1/bidding/control`, { headers: { authorization: `Bearer ${TOKEN}` } });
    expect(controlResponse.status).toBe(200);
    expect(await controlResponse.json()).toMatchObject({ effectiveMode: "KILLED", state: { mode: "KILLED", revision: 1 } });

    await runtime.close();
    store.close();
  });
});