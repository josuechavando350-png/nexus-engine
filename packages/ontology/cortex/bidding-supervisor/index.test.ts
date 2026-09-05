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
    biddingStrategySystemStatus: "ENABLED",
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
  return { supervisor, gateway, business, store, now: () => now, advance(ms: number) { now += ms; } };
}

async function supervise(h: ReturnType<typeof harness>, runId: string, mode?: "ACTIVE" | "OBSERVE_ONLY" | "KILLED") {
  return h.supervisor.supervise({ runId, customerId: CUSTOMER_ID, campaignId: CAMPAIGN_ID, mode });
}

describe("PeriodicGoogleAdsBiddingSupervisor", () => {
  it("rejects unsafe policy configurations", () => {
    expect(() => policy({ decreaseRiskProfitToSpendRatio: 2, increaseVolumeProfitToSpendRatio: 1.5 })).toThrow(/threshold/);
    expect(() => policy({ budgetStepFraction: 0.3 })).toThrow(/budgetStepFraction/);
    expect(() => policy({ minTargetRoas: 0.001 })).toThrow(/ROAS/);
    expect(() => policy({ observationWindowDays: 91 })).toThrow(/observationWindowDays/);
  });

  it("changes one control per cycle, rotates controls, and enforces cooldown with exact integer steps", async () => {
    const h = harness();
    const first = await supervise(h, "profit-1");
    expect(first.status).toBe("APPLIED");
    expect(first.action?.kind).toBe("CAMPAIGN_BUDGET");
    if (first.action?.kind !== "CAMPAIGN_BUDGET") throw new Error("expected budget action");
    expect(first.action.nextAmountMicros).toBe(110_000_000);
    expect(h.gateway.mutations).toHaveLength(1);

    const cooldown = await supervise(h, "profit-2");
    expect(cooldown.status).toBe("NOOP");
    expect(cooldown.reason).toBe("COOLDOWN");
    expect(h.gateway.mutations).toHaveLength(1);

    h.advance(3_600_001);
    const second = await supervise(h, "profit-3");
    expect(second.action?.kind).toBe("STANDARD_TARGET_CPA");
    if (second.action?.kind !== "STANDARD_TARGET_CPA") throw new Error("expected tCPA action");
    expect(second.action.nextTargetCpaMicros).toBe(55_000_000);
    expect(h.gateway.mutations).toHaveLength(2);
  });

  it("uses aggregate portfolio profitability instead of campaign profitability for portfolio controls", async () => {
    const gateway = new TestGateway(campaign({ budgetExplicitlyShared: true, portfolioBiddingStrategyResourceName: PORTFOLIO_RESOURCE }), portfolio());
    const h = harness({ gateway });
    h.business.campaignGrossProfitMicros = 250_000_000;
    h.business.portfolioGrossProfitMicros = 150_000_000;
    const result = await supervise(h, "portfolio-risk");
    expect(result.action?.kind).toBe("PORTFOLIO_TARGET_CPA");
    expect(result.direction).toBe("DECREASE_RISK");
    expect(result.evidence?.sourceId).toBe("crm-portfolio");
    if (result.action?.kind !== "PORTFOLIO_TARGET_CPA") throw new Error("expected portfolio target CPA");
    expect(result.action.nextTargetCpaMicros).toBe(40_500_000);
  });

  it("blocks shared budgets unless explicitly allowed", async () => {
    const gateway = new TestGateway(campaign({ budgetExplicitlyShared: true, biddingStrategyType: "OTHER", standardTargetCpaMicros: null }));
    const h = harness({ gateway });
    const result = await supervise(h, "shared-block");
    expect(result.status).toBe("NOOP");
    expect(result.reason).toBe("SHARED_BUDGET_BLOCKED");
    expect(gateway.mutations).toHaveLength(0);
  });

  it("OBSERVE_ONLY records a proposal and KILLED performs no reads or writes", async () => {
    const observe = harness();
    const proposed = await supervise(observe, "observe", "OBSERVE_ONLY");
    expect(proposed.status).toBe("NOOP");
    expect(proposed.reason).toBe("OBSERVE_ONLY");
    expect(proposed.action?.kind).toBe("CAMPAIGN_BUDGET");
    expect(observe.gateway.mutations).toHaveLength(0);

    const killed = harness();
    const stopped = await supervise(killed, "kill", "KILLED");
    expect(stopped.status).toBe("NOOP");
    expect(stopped.reason).toBe("KILL_SWITCH");
    expect(killed.gateway.campaignReads).toBe(0);
    expect(killed.gateway.portfolioReads).toBe(0);
    expect(killed.gateway.mutations).toHaveLength(0);
    expect(killed.business.calls).toBe(0);
  });

  it("holds on stale business data or insufficient Google evidence", async () => {
    const stale = harness();
    stale.business.observedOffsetMs = -7_200_001;
    expect((await supervise(stale, "stale")).reason).toBe("STALE_BUSINESS_DATA");
    expect(stale.gateway.mutations).toHaveLength(0);

    const low = harness({ gateway: new TestGateway(campaign({ costMicros: 10_000_000, conversions: 1 })) });
    expect((await supervise(low, "low")).reason).toBe("INSUFFICIENT_EVIDENCE");
    expect(low.gateway.mutations).toHaveLength(0);
  });

  it("fails closed when a remote control starts outside the configured absolute bounds", async () => {
    const below = harness({ gateway: new TestGateway(campaign({ budgetAmountMicros: 1_000_000, biddingStrategyType: "OTHER", standardTargetCpaMicros: null })) });
    const result = await supervise(below, "outside-budget");
    expect(result.status).toBe("NOOP");
    expect(result.action).toBeNull();
    expect(below.gateway.mutations).toHaveLength(0);

    const invalidPortfolio = new TestGateway(
      campaign({ budgetExplicitlyShared: true, portfolioBiddingStrategyResourceName: PORTFOLIO_RESOURCE }),
      portfolio({ targetCpaMicros: null, cpcBidCeilingMicros: 5_000_000, cpcBidFloorMicros: 6_000_000 }),
    );
    const portfolioHarness = harness({ gateway: invalidPortfolio });
    const portfolioResult = await supervise(portfolioHarness, "invalid-portfolio-bounds");
    expect(portfolioResult.action).toBeNull();
    expect(invalidPortfolio.mutations).toHaveLength(0);
  });

  it("leaves ambiguous mutations PREPARED, freezes them under KILLED, and recovers without planning a second action", async () => {
    const h = harness();
    h.gateway.nextMutationError = new GoogleAdsApiError("AMBIGUOUS_MUTATION_OUTCOME", "network uncertainty");
    await expect(supervise(h, "ambiguous-original")).rejects.toMatchObject({ code: "REMOTE_FAILURE" });
    expect(h.gateway.mutations).toHaveLength(1);
    const reads = h.gateway.campaignReads;

    await expect(supervise(h, "kill-during-ambiguous", "KILLED")).rejects.toMatchObject({ code: "POLICY_VIOLATION" });
    expect(h.gateway.mutations).toHaveLength(1);
    expect(h.gateway.campaignReads).toBe(reads);

    h.gateway.nextRecovered = true;
    const recovered = await supervise(h, "different-scheduler-run");
    expect(recovered.runId).toBe("ambiguous-original");
    expect(recovered.status).toBe("APPLIED");
    expect(recovered.reason).toBe("ACTION_RECOVERED");
    expect(h.gateway.mutations).toHaveLength(2);
    expect(h.gateway.campaignReads).toBe(reads + 1);
  });

  it("keeps the in-flight campaign lock across policy-version rotation", async () => {
    const now = Date.parse("2026-09-04T18:00:00.000Z");
    const store = new InMemoryOntologyTransactionStore();
    const gateway = new TestGateway();
    const business = new TestBusinessProvider(() => now);
    const v1 = policy({ version: "v1" });
    const first = new PeriodicGoogleAdsBiddingSupervisor(store, scope, v1, gateway, business, () => now);
    gateway.nextMutationError = new GoogleAdsApiError("AMBIGUOUS_MUTATION_OUTCOME", "uncertain write");
    await expect(first.supervise({ runId: "policy-v1-pending", customerId: CUSTOMER_ID, campaignId: CAMPAIGN_ID })).rejects.toMatchObject({ code: "REMOTE_FAILURE" });
    const readsBeforeRotation = gateway.campaignReads;
    expect(business.calls).toBe(1);

    const v2 = policy({ version: "v2", budgetStepFraction: 0.2 });
    const second = new PeriodicGoogleAdsBiddingSupervisor(store, scope, v2, gateway, business, () => now);
    gateway.nextRecovered = true;
    const recovered = await second.supervise({ runId: "policy-v2-new-run", customerId: CUSTOMER_ID, campaignId: CAMPAIGN_ID });
    expect(recovered.runId).toBe("policy-v1-pending");
    expect(recovered.policyDigest).toBe(v1.digest);
    expect(recovered.reason).toBe("ACTION_RECOVERED");
    expect(gateway.campaignReads).toBe(readsBeforeRotation + 1);
    expect(gateway.mutations).toHaveLength(2);
    expect(business.calls).toBe(1);
  });

  it("releases the lock after a known remote conflict", async () => {
    const h = harness();
    h.gateway.nextMutationError = new GoogleAdsApiError("REMOTE_CONFLICT", "third-party drift");
    await expect(supervise(h, "conflict-1")).rejects.toMatchObject({ code: "REMOTE_FAILURE" });
    const next = await supervise(h, "conflict-2");
    expect(next.runId).toBe("conflict-2");
    expect(next.status).toBe("APPLIED");
    expect(h.gateway.mutations).toHaveLength(2);
  });

  it("allows immediate safety rollback despite the normal cooldown and clears rollback eligibility atomically", async () => {
    const h = harness();
    const applied = await supervise(h, "apply-before-rollback");
    expect(applied.action?.kind).toBe("CAMPAIGN_BUDGET");
    const rollback = await h.supervisor.rollbackLastMutation({ runId: "rollback-1", customerId: CUSTOMER_ID, campaignId: CAMPAIGN_ID });
    expect(rollback.status).toBe("ROLLED_BACK");
    expect(rollback.reason).toBe("ROLLBACK_APPLIED");
    if (rollback.action?.kind !== "CAMPAIGN_BUDGET") throw new Error("expected budget rollback");
    expect(rollback.action.expectedAmountMicros).toBe(110_000_000);
    expect(rollback.action.nextAmountMicros).toBe(100_000_000);
    expect(h.gateway.mutations).toHaveLength(2);
    await expect(h.supervisor.rollbackLastMutation({ runId: "rollback-2", customerId: CUSTOMER_ID, campaignId: CAMPAIGN_ID })).rejects.toBeInstanceOf(BiddingSupervisorError);
  });

  it("persists cooldown and state across a real SQLite restart", async () => {
    const directory = mkdtempSync(join(tmpdir(), "nexus-cortex-bidding-"));
    const path = join(directory, "cortex.sqlite");
    const gateway = new TestGateway();
    const now = Date.parse("2026-09-04T18:00:00.000Z");
    const business = new TestBusinessProvider(() => now);
    const p = policy();
    try {
      const firstStore = new SqliteOntologyTransactionStore(path);
      const first = new PeriodicGoogleAdsBiddingSupervisor(firstStore, scope, p, gateway, business, () => now);
      expect((await first.supervise({ runId: "sqlite-first", customerId: CUSTOMER_ID, campaignId: CAMPAIGN_ID })).status).toBe("APPLIED");
      firstStore.close();

      const secondStore = new SqliteOntologyTransactionStore(path);
      const second = new PeriodicGoogleAdsBiddingSupervisor(secondStore, scope, p, gateway, business, () => now);
      const result = await second.supervise({ runId: "sqlite-second", customerId: CUSTOMER_ID, campaignId: CAMPAIGN_ID });
      expect(result.status).toBe("NOOP");
      expect(result.reason).toBe("COOLDOWN");
      expect(gateway.mutations).toHaveLength(1);
      secondStore.close();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("survives 80 adversarial cycles without moving more than one lever or exceeding configured steps", async () => {
    const h = harness({ supervisorPolicy: policy({ cooldownMs: 60_000 }) });
    for (let index = 0; index < 80; index += 1) {
      h.business.campaignGrossProfitMicros = index % 4 < 2 ? 200_000_000 : 50_000_000;
      const beforeCount = h.gateway.mutations.length;
      const beforeBudget = h.gateway.campaignSnapshot.budgetAmountMicros;
      const beforeCpa = h.gateway.campaignSnapshot.standardTargetCpaMicros;
      const result = await supervise(h, `run-${String(index).padStart(4, "0")}`);
      expect(h.gateway.mutations.length - beforeCount).toBeLessThanOrEqual(1);
      if (result.action?.kind === "CAMPAIGN_BUDGET") {
        expect(Math.abs(result.action.nextAmountMicros - beforeBudget) / beforeBudget).toBeLessThanOrEqual(0.1);
        expect(result.action.nextAmountMicros).toBeGreaterThanOrEqual(10_000_000);
        expect(result.action.nextAmountMicros).toBeLessThanOrEqual(500_000_000);
      }
      if (result.action?.kind === "STANDARD_TARGET_CPA" && beforeCpa !== null) {
        expect(Math.abs(result.action.nextTargetCpaMicros - beforeCpa) / beforeCpa).toBeLessThanOrEqual(0.1);
        expect(result.action.nextTargetCpaMicros).toBeGreaterThanOrEqual(5_000_000);
        expect(result.action.nextTargetCpaMicros).toBeLessThanOrEqual(200_000_000);
      }
      h.advance(60_001);
    }
  });
});
