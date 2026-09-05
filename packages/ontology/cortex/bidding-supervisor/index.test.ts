import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { InMemoryOntologyTransactionStore } from "@nexus/ontology/transaction";
import { SqliteOntologyTransactionStore } from "@nexus/ontology/cortex/sqlite-transaction-store";
import {
  BiddingSupervisorError,
  PeriodicGoogleAdsBiddingSupervisor,
  createBiddingSupervisorPolicy,
  type BiddingSupervisorPolicy,
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
const PORTFOLIO_RESOURCE = `customers/${CUSTOMER_ID}/biddingStrategies/3333333333`;

function policy(overrides: Partial<Parameters<typeof createBiddingSupervisorPolicy>[0]> = {}): BiddingSupervisorPolicy {
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
    ...overrides,
  });
}

function campaign(overrides: Partial<GoogleAdsCampaignSnapshot> = {}): GoogleAdsCampaignSnapshot {
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
    portfolioBiddingStrategyResourceName: null,
    standardTargetCpaMicros: 50_000_000,
    standardTargetRoas: null,
    costMicros: 100_000_000,
    conversions: 10,
    conversionValue: 1_000,
    ...overrides,
  });
}

function portfolio(overrides: Partial<GoogleAdsPortfolioSnapshot> = {}): GoogleAdsPortfolioSnapshot {
  return Object.freeze({
    customerId: CUSTOMER_ID,
    resourceName: PORTFOLIO_RESOURCE,
    strategyId: "3333333333",
    type: "TARGET_CPA",
    targetCpaMicros: 45_000_000,
    targetRoas: null,
    cpcBidCeilingMicros: 9_000_000,
    cpcBidFloorMicros: 1_000_000,
    costMicros: 300_000_000,
    conversions: 30,
    conversionValue: 3_000,
    ...overrides,
  });
}

class TestGateway implements GoogleAdsBiddingGateway {
  campaignSnapshot: GoogleAdsCampaignSnapshot;
  portfolioSnapshot: GoogleAdsPortfolioSnapshot | null;
  readonly mutations: GoogleAdsControlMutation[] = [];
  campaignReads = 0;
  portfolioReads = 0;
  nextMutationError: GoogleAdsApiError | null = null;
  nextRecovered = false;

  constructor(campaignSnapshot = campaign(), portfolioSnapshot: GoogleAdsPortfolioSnapshot | null = null) {
    this.campaignSnapshot = campaignSnapshot;
    this.portfolioSnapshot = portfolioSnapshot;
  }

  async getCampaignSnapshot(): Promise<GoogleAdsCampaignSnapshot> {
    this.campaignReads += 1;
    return this.campaignSnapshot;
  }

  async getPortfolioSnapshot(): Promise<GoogleAdsPortfolioSnapshot> {
    this.portfolioReads += 1;
    if (!this.portfolioSnapshot) throw new Error("portfolio snapshot not configured");
    return this.portfolioSnapshot;
  }

  async applyMutation(_customerId: string, action: GoogleAdsControlMutation): Promise<GoogleAdsMutationReceipt> {
    this.mutations.push(action);
    if (this.nextMutationError) {
      const error = this.nextMutationError;
      this.nextMutationError = null;
      throw error;
    }
    const recovered = this.nextRecovered;
    this.nextRecovered = false;
    this.applyLocally(action);
    return Object.freeze({ requestId: recovered ? null : `request-${this.mutations.length}`, resourceName: action.resourceName, recoveredAlreadyApplied: recovered });
  }

  private applyLocally(action: GoogleAdsControlMutation): void {
    if (action.kind === "CAMPAIGN_BUDGET") {
      this.campaignSnapshot = campaign({ ...this.campaignSnapshot, budgetAmountMicros: action.nextAmountMicros });
      return;
    }
    if (action.kind === "STANDARD_TARGET_CPA") {
      this.campaignSnapshot = campaign({ ...this.campaignSnapshot, standardTargetCpaMicros: action.nextTargetCpaMicros });
      return;
    }
    if (action.kind === "STANDARD_TARGET_ROAS") {
      this.campaignSnapshot = campaign({ ...this.campaignSnapshot, standardTargetRoas: action.nextTargetRoas });
      return;
    }
    if (!this.portfolioSnapshot) return;
    if (action.kind === "PORTFOLIO_TARGET_CPA") this.portfolioSnapshot = portfolio({ ...this.portfolioSnapshot, targetCpaMicros: action.nextTargetCpaMicros });
    else if (action.kind === "PORTFOLIO_TARGET_ROAS") this.portfolioSnapshot = portfolio({ ...this.portfolioSnapshot, targetRoas: action.nextTargetRoas });
    else this.portfolioSnapshot = portfolio({ ...this.portfolioSnapshot, cpcBidCeilingMicros: action.nextCeilingMicros, cpcBidFloorMicros: action.nextFloorMicros });
  }
}

class TestBusinessProvider implements BusinessProfitabilityProvider {
  calls = 0;
  campaignGrossProfitMicros = 200_000_000;
  portfolioGrossProfitMicros = 600_000_000;
  observedOffsetMs = 0;

  constructor(private readonly now: () => number) {}

  async getProfitability(query: BusinessProfitabilityQuery): Promise<BusinessProfitabilitySnapshot> {
    this.calls += 1;
    const gross = query.scopeKind === "CAMPAIGN" ? this.campaignGrossProfitMicros : this.portfolioGrossProfitMicros;
    return Object.freeze({
      ...query,
      revenueMicros: Math.min(Number.MAX_SAFE_INTEGER, gross * 2),
      grossProfitBeforeAdSpendMicros: gross,
      qualifiedConversions: 10,
      observedAt: new Date(this.now() + this.observedOffsetMs).toISOString(),
      sourceId: query.scopeKind === "CAMPAIGN" ? "crm-campaign" : "crm-portfolio",
    });
  }
}

function harness(options: {
  readonly store?: InMemoryOntologyTransactionStore | SqliteOntologyTransactionStore;
  readonly supervisorPolicy?: BiddingSupervisorPolicy;
  readonly gateway?: TestGateway;
  readonly nowMs?: number;
} = {}) {
  let now = options.nowMs ?? Date.parse("2026-09-04T18:00:00.000Z");
  const gateway = options.gateway ?? new TestGateway();
  const business = new TestBusinessProvider(() => now);
  const store = options.store ?? new InMemoryOntologyTransactionStore();
  const supervisor = new PeriodicGoogleAdsBiddingSupervisor(store, scope, options.supervisorPolicy ?? policy(), gateway, business, () => now);
  return {
    supervisor,
    gateway,
    business,
    store,
    now: () => now,
    advance(ms: number) { now += ms; },
  };
}

function runId(index: number): string {
  return `run-${String(index).padStart(4, "0")}`;
}

async function supervise(h: ReturnType<typeof harness>, id: string, mode?: "ACTIVE" | "OBSERVE_ONLY" | "KILLED") {
  return h.supervisor.supervise({ runId: id, customerId: CUSTOMER_ID, campaignId: CAMPAIGN_ID, mode });
}

describe("PeriodicGoogleAdsBiddingSupervisor", () => {
  it("rejects unsafe policy configurations before any remote work", () => {
    expect(() => policy({ decreaseRiskProfitToSpendRatio: 2, increaseVolumeProfitToSpendRatio: 1.5 })).toThrow(/threshold/);
    expect(() => policy({ budgetStepFraction: 0.3 })).toThrow(/budgetStepFraction/);
    expect(() => policy({ minTargetRoas: 0.001 })).toThrow(/ROAS/);
    expect(() => policy({ observationWindowDays: 91 })).toThrow(/observationWindowDays/);
  });

  it("changes one control per cycle, rotates controls, and enforces cooldown", async () => {
    const h = harness();
    const first = await supervise(h, "profit-1");
    expect(first.status).toBe("APPLIED");
    expect(first.action?.kind).toBe("CAMPAIGN_BUDGET");
    expect(h.gateway.mutations).toHaveLength(1);
    if (first.action?.kind !== "CAMPAIGN_BUDGET") throw new Error("expected budget action");
    expect(first.action.nextAmountMicros).toBe(110_000_001);

    const cooldown = await supervise(h, "profit-2");
    expect(cooldown.status).toBe("NOOP");
    expect(cooldown.reason).toBe("COOLDOWN");
    expect(h.gateway.mutations).toHaveLength(1);

    h.advance(3_600_001);
    const second = await supervise(h, "profit-3");
    expect(second.status).toBe("APPLIED");
    expect(second.action?.kind).toBe("STANDARD_TARGET_CPA");
    expect(h.gateway.mutations).toHaveLength(2);
    if (second.action?.kind !== "STANDARD_TARGET_CPA") throw new Error("expected tCPA action");
    expect(second.action.nextTargetCpaMicros).toBe(55_000_001);
  });

  it("tightens spend and tCPA direction when business profitability is below the risk threshold", async () => {
    const h = harness();
    h.business.campaignGrossProfitMicros = 50_000_000;
    const first = await supervise(h, "risk-1");
    expect(first.direction).toBe("DECREASE_RISK");
    expect(first.action?.kind).toBe("CAMPAIGN_BUDGET");
    if (first.action?.kind !== "CAMPAIGN_BUDGET") throw new Error("expected budget action");
    expect(first.action.nextAmountMicros).toBe(90_000_000);
    h.advance(3_600_001);
    const second = await supervise(h, "risk-2");
    expect(second.action?.kind).toBe("STANDARD_TARGET_CPA");
    if (second.action?.kind !== "STANDARD_TARGET_CPA") throw new Error("expected tCPA action");
    expect(second.action.nextTargetCpaMicros).toBe(45_000_000);
  });

  it("uses aggregate portfolio profitability for portfolio controls instead of campaign profitability", async () => {
    const gateway = new TestGateway(campaign({ budgetExplicitlyShared: true, portfolioBiddingStrategyResourceName: PORTFOLIO_RESOURCE }), portfolio());
    const h = harness({ gateway });
    h.business.campaignGrossProfitMicros = 250_000_000;
    h.business.portfolioGrossProfitMicros = 150_000_000;
    const result = await supervise(h, "portfolio-risk");
    expect(result.action?.kind).toBe("PORTFOLIO_TARGET_CPA");
    expect(result.direction).toBe("DECREASE_RISK");
    expect(result.evidence?.sourceId).toBe("crm-portfolio");
    if (result.action?.kind !== "PORTFOLIO_TARGET_CPA") throw new Error("expected portfolio tCPA action");
    expect(result.action.nextTargetCpaMicros).toBe(40_500_000);
  });

  it("blocks shared budget mutation unless explicitly allowed", async () => {
    const gateway = new TestGateway(campaign({ budgetExplicitlyShared: true, biddingStrategyType: "OTHER", standardTargetCpaMicros: null }));
    const h = harness({ gateway });
    const result = await supervise(h, "shared-block");
    expect(result.status).toBe("NOOP");
    expect(result.reason).toBe("SHARED_BUDGET_BLOCKED");
    expect(gateway.mutations).toHaveLength(0);
  });

  it("OBSERVE_ONLY records the proposed action without mutating Google", async () => {
    const h = harness();
    const result = await supervise(h, "observe", "OBSERVE_ONLY");
    expect(result.status).toBe("NOOP");
    expect(result.reason).toBe("OBSERVE_ONLY");
    expect(result.action?.kind).toBe("CAMPAIGN_BUDGET");
    expect(h.gateway.mutations).toHaveLength(0);
  });

  it("KILLED performs no Google or business reads and no mutations", async () => {
    const h = harness();
    const result = await supervise(h, "kill", "KILLED");
    expect(result.status).toBe("NOOP");
    expect(result.reason).toBe("KILL_SWITCH");
    expect(h.gateway.campaignReads).toBe(0);
    expect(h.gateway.portfolioReads).toBe(0);
    expect(h.gateway.mutations).toHaveLength(0);
    expect(h.business.calls).toBe(0);
  });

  it("holds when business data is stale or Google evidence is insufficient", async () => {
    const stale = harness();
    stale.business.observedOffsetMs = -7_200_001;
    const staleResult = await supervise(stale, "stale");
    expect(staleResult.status).toBe("NOOP");
    expect(staleResult.reason).toBe("STALE_BUSINESS_DATA");
    expect(stale.gateway.mutations).toHaveLength(0);

    const low = harness({ gateway: new TestGateway(campaign({ costMicros: 10_000_000, conversions: 1 })) });
    const lowResult = await supervise(low, "low-data");
    expect(lowResult.status).toBe("NOOP");
    expect(lowResult.reason).toBe("INSUFFICIENT_EVIDENCE");
    expect(low.gateway.mutations).toHaveLength(0);
  });

  it("leaves ambiguous mutations PREPARED and recovers them without planning a second action", async () => {
    const h = harness();
    h.gateway.nextMutationError = new GoogleAdsApiError("AMBIGUOUS_MUTATION_OUTCOME", "network uncertainty");
    await expect(supervise(h, "ambiguous-original")).rejects.toMatchObject({ code: "REMOTE_FAILURE" });
    expect(h.gateway.mutations).toHaveLength(1);
    const readsAfterAmbiguous = h.gateway.campaignReads;

    await expect(supervise(h, "kill-during-ambiguous", "KILLED")).rejects.toMatchObject({ code: "POLICY_VIOLATION" });
    expect(h.gateway.mutations).toHaveLength(1);
    expect(h.gateway.campaignReads).toBe(readsAfterAmbiguous);

    h.gateway.nextRecovered = true;
    const recovered = await supervise(h, "different-scheduler-run");
    expect(recovered.runId).toBe("ambiguous-original");
    expect(recovered.status).toBe("APPLIED");
    expect(recovered.reason).toBe("ACTION_RECOVERED");
    expect(h.gateway.mutations).toHaveLength(2);
    expect(h.gateway.campaignReads).toBe(readsAfterAmbiguous);
  });

  it("releases the local lock on a known remote conflict so a later run can proceed", async () => {
    const h = harness();
    h.gateway.nextMutationError = new GoogleAdsApiError("REMOTE_CONFLICT", "third-party changed value");
    await expect(supervise(h, "conflict-1")).rejects.toMatchObject({ code: "REMOTE_FAILURE" });
    expect(h.gateway.mutations).toHaveLength(1);
    const next = await supervise(h, "conflict-2");
    expect(next.runId).toBe("conflict-2");
    expect(next.status).toBe("APPLIED");
    expect(h.gateway.mutations).toHaveLength(2);
  });

  it("rolls back only the last certified absolute mutation and clears rollback eligibility atomically", async () => {
    const h = harness();
    const applied = await supervise(h, "apply-before-rollback");
    expect(applied.action?.kind).toBe("CAMPAIGN_BUDGET");
    const rollback = await h.supervisor.rollbackLastMutation({ runId: "rollback-1", customerId: CUSTOMER_ID, campaignId: CAMPAIGN_ID });
    expect(rollback.status).toBe("ROLLED_BACK");
    expect(rollback.reason).toBe("ROLLBACK_APPLIED");
    if (rollback.action?.kind !== "CAMPAIGN_BUDGET") throw new Error("expected budget rollback");
    expect(rollback.action.expectedAmountMicros).toBe(110_000_001);
    expect(rollback.action.nextAmountMicros).toBe(100_000_000);
    expect(h.gateway.mutations).toHaveLength(2);
    await expect(h.supervisor.rollbackLastMutation({ runId: "rollback-2", customerId: CUSTOMER_ID, campaignId: CAMPAIGN_ID })).rejects.toBeInstanceOf(BiddingSupervisorError);
  });

  it("persists cooldown and applied-action state across a real SQLite restart", async () => {
    const directory = mkdtempSync(join(tmpdir(), "nexus-cortex-bidding-"));
    const path = join(directory, "cortex.sqlite");
    const gateway = new TestGateway();
    let now = Date.parse("2026-09-04T18:00:00.000Z");
    const business = new TestBusinessProvider(() => now);
    const supervisorPolicy = policy();
    try {
      const firstStore = new SqliteOntologyTransactionStore(path);
      const firstSupervisor = new PeriodicGoogleAdsBiddingSupervisor(firstStore, scope, supervisorPolicy, gateway, business, () => now);
      const first = await firstSupervisor.supervise({ runId: "sqlite-first", customerId: CUSTOMER_ID, campaignId: CAMPAIGN_ID });
      expect(first.status).toBe("APPLIED");
      firstStore.close();

      const secondStore = new SqliteOntologyTransactionStore(path);
      const secondSupervisor = new PeriodicGoogleAdsBiddingSupervisor(secondStore, scope, supervisorPolicy, gateway, business, () => now);
      const second = await secondSupervisor.supervise({ runId: "sqlite-second", customerId: CUSTOMER_ID, campaignId: CAMPAIGN_ID });
      expect(second.status).toBe("NOOP");
      expect(second.reason).toBe("COOLDOWN");
      expect(gateway.mutations).toHaveLength(1);
      secondStore.close();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("survives an adversarial multi-cycle sequence without moving more than one lever or exceeding step bounds", async () => {
    const h = harness({ supervisorPolicy: policy({ cooldownMs: 60_000 }) });
    for (let index = 0; index < 80; index += 1) {
      h.business.campaignGrossProfitMicros = index % 4 < 2 ? 200_000_000 : 50_000_000;
      const beforeCount = h.gateway.mutations.length;
      const beforeBudget = h.gateway.campaignSnapshot.budgetAmountMicros;
      const beforeCpa = h.gateway.campaignSnapshot.standardTargetCpaMicros;
      const result = await supervise(h, runId(index));
      expect(h.gateway.mutations.length - beforeCount).toBeLessThanOrEqual(1);
      if (result.action?.kind === "CAMPAIGN_BUDGET") {
        const relative = Math.abs(result.action.nextAmountMicros - beforeBudget) / beforeBudget;
        expect(relative).toBeLessThanOrEqual(0.100001);
        expect(result.action.nextAmountMicros).toBeGreaterThanOrEqual(10_000_000);
        expect(result.action.nextAmountMicros).toBeLessThanOrEqual(500_000_000);
      }
      if (result.action?.kind === "STANDARD_TARGET_CPA" && beforeCpa !== null) {
        const relative = Math.abs(result.action.nextTargetCpaMicros - beforeCpa) / beforeCpa;
        expect(relative).toBeLessThanOrEqual(0.100001);
        expect(result.action.nextTargetCpaMicros).toBeGreaterThanOrEqual(5_000_000);
        expect(result.action.nextTargetCpaMicros).toBeLessThanOrEqual(200_000_000);
      }
      h.advance(60_001);
    }
  });
});
