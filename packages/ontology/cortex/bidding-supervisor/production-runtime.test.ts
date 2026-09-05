import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SqliteOntologyTransactionStore } from "../sqlite-transaction-store";
import type {
  BusinessProfitabilityProvider,
  BusinessProfitabilityQuery,
  GoogleAdsBiddingGateway,
} from "./index";
import type {
  GoogleAdsCampaignSnapshot,
  GoogleAdsControlMutation,
  GoogleAdsMutationReceipt,
  GoogleAdsPortfolioSnapshot,
} from "./google-ads-rest";
import {
  createBiddingProductionRuntime,
  parseBiddingProductionConfig,
  type BiddingProductionRuntime,
  type BiddingRuntimeTelemetryEvent,
} from "./production-runtime";

const CUSTOMER_ID = "1234567890";
const CAMPAIGN_ID = "1111111111";
const TOKEN = "bidding-runtime-test-token-000000000000000000000";
const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });

function config() {
  return parseBiddingProductionConfig({
    version: 1,
    scope: { tenantId: "tenant:bidding-production", organizationId: "org:bidding-production" },
    intervalMs: 300_000,
    policy: {
      policyId: "production-bidding-v1",
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

class FakeGoogleAds implements GoogleAdsBiddingGateway {
  budgetMicros = 10_000_000;
  campaignReads = 0;
  portfolioReads = 0;
  mutations = 0;
  async getCampaignSnapshot(customerId: string, campaignId: string): Promise<GoogleAdsCampaignSnapshot> {
    this.campaignReads += 1;
    return {
      customerId,
      campaignId,
      campaignResourceName: `customers/${customerId}/campaigns/${campaignId}`,
      campaignName: "Production fixture",
      status: "ENABLED",
      budgetResourceName: `customers/${customerId}/campaignBudgets/2222222222`,
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
    this.portfolioReads += 1;
    throw new Error("portfolio snapshot is not expected in this fixture");
  }
  async applyMutation(_customerId: string, action: GoogleAdsControlMutation): Promise<GoogleAdsMutationReceipt> {
    this.mutations += 1;
    if (action.kind !== "CAMPAIGN_BUDGET") throw new Error("only campaign budget is expected in this fixture");
    if (this.budgetMicros !== action.expectedAmountMicros) throw new Error("fixture detected a remote precondition mismatch");
    this.budgetMicros = action.nextAmountMicros;
    return { requestId: `mutation-${this.mutations}`, resourceName: action.resourceName, recoveredAlreadyApplied: false };
  }
}

class FakeProfitability implements BusinessProfitabilityProvider {
  calls = 0;
  constructor(private readonly now: () => number) {}
  async getProfitability(query: BusinessProfitabilityQuery) {
    this.calls += 1;
    return Object.freeze({
      ...query,
      revenueMicros: 12_000_000,
      grossProfitBeforeAdSpendMicros: 8_000_000,
      qualifiedConversions: 4,
      observedAt: new Date(this.now()).toISOString(),
      sourceId: "finance-ledger-fixture",
    });
  }
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

async function api(base: string, path: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set("authorization", `Bearer ${TOKEN}`);
  if (init.body !== undefined) headers.set("content-type", "application/json");
  return fetch(`${base}${path}`, { ...init, headers });
}

describe("CORTEX bidding production runtime", () => {
  it("persists active mutation, kill state and explicit rollback across SQLite restart", async () => {
    const directory = mkdtempSync(join(tmpdir(), "nexus-bidding-production-"));
    directories.push(directory);
    const dbPath = join(directory, "cortex.sqlite");
    let now = Date.parse("2026-09-05T22:30:00.000Z");
    const google = new FakeGoogleAds();
    const profitability = new FakeProfitability(() => now);
    const telemetry: BiddingRuntimeTelemetryEvent[] = [];

    let store = new SqliteOntologyTransactionStore(dbPath);
    let runtime = createBiddingProductionRuntime({ transactions: store, config: config(), googleAds: google, profitability, apiToken: TOKEN, now: () => now, onTelemetry: (event) => telemetry.push(event) });
    let base = await listen(runtime);

    const first = await runtime.runOnce("MANUAL");
    expect(first).toHaveLength(1);
    expect(first[0]).toMatchObject({ status: "APPLIED", reason: "ACTION_APPLIED", action: { kind: "CAMPAIGN_BUDGET", expectedAmountMicros: 10_000_000, nextAmountMicros: 11_000_000 } });
    expect(google.budgetMicros).toBe(11_000_000);
    expect(google.mutations).toBe(1);

    const unauthorized = await fetch(`${base}/v1/bidding/control`);
    expect(unauthorized.status).toBe(401);

    const kill = await api(base, "/v1/bidding/control", { method: "POST", body: JSON.stringify({ expectedRevision: 0, mode: "KILLED", reason: "emergency stop for production investigation" }) });
    expect(kill.status).toBe(200);
    expect(await kill.json()).toMatchObject({ state: { mode: "KILLED", revision: 1 } });

    now += 300_000;
    const readsBeforeKillCycle = google.campaignReads;
    const profitabilityBeforeKillCycle = profitability.calls;
    const killed = await runtime.runOnce("SCHEDULED");
    expect(killed[0]).toMatchObject({ status: "NOOP", reason: "KILL_SWITCH", mode: "KILLED" });
    expect(google.campaignReads).toBe(readsBeforeKillCycle);
    expect(profitability.calls).toBe(profitabilityBeforeKillCycle);
    expect(google.mutations).toBe(1);

    await runtime.close();
    store.close();

    store = new SqliteOntologyTransactionStore(dbPath);
    runtime = createBiddingProductionRuntime({ transactions: store, config: config(), googleAds: google, profitability, apiToken: TOKEN, now: () => now, onTelemetry: (event) => telemetry.push(event) });
    base = await listen(runtime);

    const persistedControl = await api(base, "/v1/bidding/control");
    expect(persistedControl.status).toBe(200);
    expect(await persistedControl.json()).toMatchObject({ state: { mode: "KILLED", revision: 1 }, history: [{ fromMode: "ACTIVE", toMode: "KILLED", targetRevision: 1 }] });

    now += 1_000;
    const rollback = await api(base, `/v1/bidding/customers/${CUSTOMER_ID}/campaigns/${CAMPAIGN_ID}/rollback`, { method: "POST" });
    expect(rollback.status).toBe(200);
    expect(await rollback.json()).toMatchObject({ status: "ROLLED_BACK", reason: "ROLLBACK_APPLIED" });
    expect(google.budgetMicros).toBe(10_000_000);
    expect(google.mutations).toBe(2);

    expect(JSON.stringify(telemetry)).not.toContain(TOKEN);
    expect(JSON.stringify(telemetry)).not.toContain("grossProfitBeforeAdSpendMicros");

    await runtime.close();
    store.close();
  });

  it("coalesces adversarial concurrent cycles into one remote mutation", async () => {
    const directory = mkdtempSync(join(tmpdir(), "nexus-bidding-concurrent-"));
    directories.push(directory);
    const store = new SqliteOntologyTransactionStore(join(directory, "cortex.sqlite"));
    const now = Date.parse("2026-09-05T23:00:00.000Z");
    const google = new FakeGoogleAds();
    const profitability = new FakeProfitability(() => now);
    const telemetry: BiddingRuntimeTelemetryEvent[] = [];
    const runtime = createBiddingProductionRuntime({ transactions: store, config: config(), googleAds: google, profitability, apiToken: TOKEN, now: () => now, onTelemetry: (event) => telemetry.push(event) });

    const results = await Promise.all(Array.from({ length: 20 }, () => runtime.runOnce("MANUAL")));
    expect(results.every((batch) => batch[0]?.status === "APPLIED")).toBe(true);
    expect(google.mutations).toBe(1);
    expect(google.campaignReads).toBe(2);
    expect(telemetry.filter((event) => event.operation === "CYCLE" && event.status === "SKIPPED")).toHaveLength(19);

    await runtime.close();
    store.close();
  });

  it("rejects unknown configuration fields", () => {
    expect(() => parseBiddingProductionConfig({ ...config(), unexpected: true })).toThrow(/unknown field unexpected/i);
  });
});