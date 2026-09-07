import { canonicalJson, ontologyId, type OntologyScope } from "@nexus/ontology";
import type { JsonValue, OntologyTransactionPort } from "@nexus/ontology/transaction";
import {
  BiddingSupervisorError,
  type BusinessProfitabilityProvider,
  type BusinessProfitabilityQuery,
  type BusinessProfitabilitySnapshot,
  type GoogleAdsBiddingGateway,
} from "./index";
import type {
  GoogleAdsCampaignSnapshot,
  GoogleAdsControlMutation,
  GoogleAdsMutationReceipt,
  GoogleAdsPortfolioSnapshot,
} from "./google-ads-rest";
import {
  RevenueGuardedBiddingAdapters,
  type CreateRevenueGuardrailPolicyInput,
  type RevenueGuardrailCampaign,
  type RevenueGuardrailTelemetryEvent,
} from "./revenue-guardrails";

const STATE_PAYLOAD = "cortex.bidding.state.payload";

type ScopeKey = string;

export interface FinancialGuardrailPolicy extends CreateRevenueGuardrailPolicyInput {
  readonly minimumGrossMarginRatio: number;
  readonly maximumCustomerAcquisitionCostMicros: number;
}

export interface FinancialGuardrailTelemetryEvent extends RevenueGuardrailTelemetryEvent {
  readonly layer?: "REVENUE" | "MARGIN_CAC";
}

export interface FinancialGuardedBiddingAdaptersOptions {
  readonly transactions: OntologyTransactionPort;
  readonly scope: OntologyScope;
  readonly campaigns: readonly RevenueGuardrailCampaign[];
  readonly googleAds: GoogleAdsBiddingGateway;
  readonly profitability: BusinessProfitabilityProvider;
  readonly policy: FinancialGuardrailPolicy;
  readonly now?: () => number;
  readonly onTelemetry?: (event: FinancialGuardrailTelemetryEvent) => void;
  readonly onTelemetryError?: (error: unknown) => void;
}

interface ScopeEvidence {
  readonly business: BusinessProfitabilitySnapshot;
  readonly googleCostMicros: number;
}

function scopeKey(customerId: string, kind: BusinessProfitabilityQuery["scopeKind"], scopeId: string): ScopeKey {
  return `${customerId}\u0000${kind}\u0000${scopeId}`;
}

function finiteRatio(value: number, field: string): number {
  if (!Number.isFinite(value) || value < 0 || value > 1) throw new BiddingSupervisorError("INVALID_INPUT", `${field} must be within 0..1`);
  return value;
}

function positiveSafeInteger(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new BiddingSupervisorError("INVALID_INPUT", `${field} must be a positive safe integer`);
  return value;
}

export function createFinancialGuardrailPolicy(input: FinancialGuardrailPolicy): FinancialGuardrailPolicy {
  const base = new RevenueGuardedBiddingAdapters({
    transactions: {
      transact() { throw new Error("validation-only transaction port must not be used"); },
      getObject() { return undefined; },
      getRelationship() { return undefined; },
    },
    scope: { tenantId: "validation", organizationId: "validation" },
    campaigns: [{ customerId: "12345", campaignId: "12345" }],
    googleAds: {
      async getCampaignSnapshot() { throw new Error("validation-only gateway must not be used"); },
      async getPortfolioSnapshot() { throw new Error("validation-only gateway must not be used"); },
      async applyMutation() { throw new Error("validation-only gateway must not be used"); },
    },
    profitability: { async getProfitability() { throw new Error("validation-only provider must not be used"); } },
    policy: input,
  }).policy;
  return Object.freeze({
    ...base,
    minimumGrossMarginRatio: finiteRatio(input.minimumGrossMarginRatio, "minimumGrossMarginRatio"),
    maximumCustomerAcquisitionCostMicros: positiveSafeInteger(input.maximumCustomerAcquisitionCostMicros, "maximumCustomerAcquisitionCostMicros"),
  });
}

function reverse(action: GoogleAdsControlMutation): GoogleAdsControlMutation {
  if (action.kind === "CAMPAIGN_BUDGET") return { ...action, expectedAmountMicros: action.nextAmountMicros, nextAmountMicros: action.expectedAmountMicros };
  if (action.kind === "STANDARD_TARGET_CPA") return { ...action, expectedTargetCpaMicros: action.nextTargetCpaMicros, nextTargetCpaMicros: action.expectedTargetCpaMicros };
  if (action.kind === "STANDARD_TARGET_ROAS") return { ...action, expectedTargetRoas: action.nextTargetRoas, nextTargetRoas: action.expectedTargetRoas };
  if (action.kind === "PORTFOLIO_TARGET_CPA") return { ...action, expectedTargetCpaMicros: action.nextTargetCpaMicros, nextTargetCpaMicros: action.expectedTargetCpaMicros };
  if (action.kind === "PORTFOLIO_TARGET_ROAS") return { ...action, expectedTargetRoas: action.nextTargetRoas, nextTargetRoas: action.expectedTargetRoas };
  return {
    ...action,
    expectedCeilingMicros: action.nextCeilingMicros,
    nextCeilingMicros: action.expectedCeilingMicros,
    expectedFloorMicros: action.nextFloorMicros,
    nextFloorMicros: action.expectedFloorMicros,
  };
}

function expansion(action: GoogleAdsControlMutation): boolean {
  if (action.kind === "CAMPAIGN_BUDGET") return action.nextAmountMicros > action.expectedAmountMicros;
  if (action.kind === "STANDARD_TARGET_CPA" || action.kind === "PORTFOLIO_TARGET_CPA") return action.nextTargetCpaMicros > action.expectedTargetCpaMicros;
  if (action.kind === "STANDARD_TARGET_ROAS" || action.kind === "PORTFOLIO_TARGET_ROAS") return action.nextTargetRoas < action.expectedTargetRoas;
  const ceilingExpansion = action.nextCeilingMicros !== null && (action.expectedCeilingMicros === null || action.nextCeilingMicros > action.expectedCeilingMicros);
  const floorExpansion = action.nextFloorMicros !== null && (action.expectedFloorMicros === null || action.nextFloorMicros > action.expectedFloorMicros);
  return ceilingExpansion || floorExpansion;
}

function actionFromJson(value: JsonValue | undefined): GoogleAdsControlMutation | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as Readonly<Record<string, JsonValue>>;
  if (typeof raw.kind !== "string" || typeof raw.resourceName !== "string") return null;
  const n = (key: string): number | null => typeof raw[key] === "number" && Number.isFinite(raw[key]) ? raw[key] as number : null;
  const nullable = (key: string): number | null | undefined => raw[key] === null ? null : typeof raw[key] === "number" && Number.isFinite(raw[key]) ? raw[key] as number : undefined;
  if (raw.kind === "CAMPAIGN_BUDGET") { const a = n("expectedAmountMicros"); const b = n("nextAmountMicros"); return a === null || b === null ? null : { kind: raw.kind, resourceName: raw.resourceName, expectedAmountMicros: a, nextAmountMicros: b }; }
  if (raw.kind === "STANDARD_TARGET_CPA") { const a = n("expectedTargetCpaMicros"); const b = n("nextTargetCpaMicros"); return a === null || b === null ? null : { kind: raw.kind, resourceName: raw.resourceName, expectedTargetCpaMicros: a, nextTargetCpaMicros: b }; }
  if (raw.kind === "STANDARD_TARGET_ROAS") { const a = n("expectedTargetRoas"); const b = n("nextTargetRoas"); return a === null || b === null ? null : { kind: raw.kind, resourceName: raw.resourceName, expectedTargetRoas: a, nextTargetRoas: b }; }
  if (raw.kind === "PORTFOLIO_TARGET_CPA" && (raw.strategyType === "TARGET_CPA" || raw.strategyType === "MAXIMIZE_CONVERSIONS")) { const a = n("expectedTargetCpaMicros"); const b = n("nextTargetCpaMicros"); return a === null || b === null ? null : { kind: raw.kind, resourceName: raw.resourceName, strategyType: raw.strategyType, expectedTargetCpaMicros: a, nextTargetCpaMicros: b }; }
  if (raw.kind === "PORTFOLIO_TARGET_ROAS" && (raw.strategyType === "TARGET_ROAS" || raw.strategyType === "MAXIMIZE_CONVERSION_VALUE")) { const a = n("expectedTargetRoas"); const b = n("nextTargetRoas"); return a === null || b === null ? null : { kind: raw.kind, resourceName: raw.resourceName, strategyType: raw.strategyType, expectedTargetRoas: a, nextTargetRoas: b }; }
  if (raw.kind === "PORTFOLIO_BID_BOUNDS" && (raw.strategyType === "TARGET_CPA" || raw.strategyType === "MAXIMIZE_CONVERSIONS" || raw.strategyType === "TARGET_ROAS" || raw.strategyType === "MAXIMIZE_CONVERSION_VALUE")) {
    const expectedCeilingMicros = nullable("expectedCeilingMicros");
    const nextCeilingMicros = nullable("nextCeilingMicros");
    const expectedFloorMicros = nullable("expectedFloorMicros");
    const nextFloorMicros = nullable("nextFloorMicros");
    if ([expectedCeilingMicros, nextCeilingMicros, expectedFloorMicros, nextFloorMicros].some((item) => item === undefined)) return null;
    return { kind: raw.kind, resourceName: raw.resourceName, strategyType: raw.strategyType, expectedCeilingMicros: expectedCeilingMicros!, nextCeilingMicros: nextCeilingMicros!, expectedFloorMicros: expectedFloorMicros!, nextFloorMicros: nextFloorMicros! };
  }
  return null;
}

export class FinancialGuardedBiddingAdapters {
  readonly googleAds: GoogleAdsBiddingGateway;
  readonly profitability: BusinessProfitabilityProvider;
  readonly policy: FinancialGuardrailPolicy;
  private readonly evidence = new Map<ScopeKey, ScopeEvidence>();
  private readonly resourceScope = new Map<string, ScopeKey>();
  private readonly inner: RevenueGuardedBiddingAdapters;

  constructor(private readonly options: FinancialGuardedBiddingAdaptersOptions) {
    this.policy = createFinancialGuardrailPolicy(options.policy);
    const observedGoogleAds: GoogleAdsBiddingGateway = Object.freeze({
      getCampaignSnapshot: async (customerId: string, campaignId: string, startMs: number, endMs: number): Promise<GoogleAdsCampaignSnapshot> => {
        const snapshot = await options.googleAds.getCampaignSnapshot(customerId, campaignId, startMs, endMs);
        const key = scopeKey(customerId, "CAMPAIGN", campaignId);
        this.resourceScope.set(snapshot.campaignResourceName, key);
        this.resourceScope.set(snapshot.budgetResourceName, key);
        const current = this.evidence.get(key);
        if (current) this.evidence.set(key, Object.freeze({ ...current, googleCostMicros: snapshot.costMicros }));
        return snapshot;
      },
      getPortfolioSnapshot: async (customerId: string, resourceName: string, startMs: number, endMs: number): Promise<GoogleAdsPortfolioSnapshot> => {
        const snapshot = await options.googleAds.getPortfolioSnapshot(customerId, resourceName, startMs, endMs);
        const key = scopeKey(customerId, "BIDDING_STRATEGY", snapshot.strategyId);
        this.resourceScope.set(snapshot.resourceName, key);
        const current = this.evidence.get(key);
        if (current) this.evidence.set(key, Object.freeze({ ...current, googleCostMicros: snapshot.costMicros }));
        return snapshot;
      },
      applyMutation: (customerId: string, action: GoogleAdsControlMutation) => options.googleAds.applyMutation(customerId, action),
    });
    const observedProfitability: BusinessProfitabilityProvider = Object.freeze({
      getProfitability: async (query: BusinessProfitabilityQuery): Promise<BusinessProfitabilitySnapshot> => {
        const business = await options.profitability.getProfitability(query);
        const key = scopeKey(query.customerId, query.scopeKind, query.scopeId);
        const current = this.evidence.get(key);
        this.evidence.set(key, Object.freeze({ business, googleCostMicros: current?.googleCostMicros ?? -1 }));
        return business;
      },
    });
    this.inner = new RevenueGuardedBiddingAdapters({
      transactions: options.transactions,
      scope: options.scope,
      campaigns: options.campaigns,
      googleAds: observedGoogleAds,
      profitability: observedProfitability,
      policy: this.policy,
      now: options.now,
      onTelemetry: (event) => this.emit({ ...event, layer: "REVENUE" }),
      onTelemetryError: options.onTelemetryError,
    });
    this.profitability = this.inner.profitability;
    this.googleAds = Object.freeze({
      getCampaignSnapshot: (customerId: string, campaignId: string, startMs: number, endMs: number) => this.inner.googleAds.getCampaignSnapshot(customerId, campaignId, startMs, endMs),
      getPortfolioSnapshot: (customerId: string, resourceName: string, startMs: number, endMs: number) => this.inner.googleAds.getPortfolioSnapshot(customerId, resourceName, startMs, endMs),
      applyMutation: (customerId: string, action: GoogleAdsControlMutation) => this.applyMutation(customerId, action),
    });
  }

  private emit(event: FinancialGuardrailTelemetryEvent): void {
    try { this.options.onTelemetry?.(Object.freeze(event)); }
    catch (error) { try { this.options.onTelemetryError?.(error); } catch { /* telemetry cannot alter bidding semantics */ } }
  }

  private durableRollback(customerId: string, action: GoogleAdsControlMutation): boolean {
    for (const campaign of this.options.campaigns) {
      if (campaign.customerId !== customerId) continue;
      const stateId = ontologyId("cortex-bidding-state-v2", { scope: this.options.scope, customerId: campaign.customerId, campaignId: campaign.campaignId });
      const record = this.options.transactions.getObject(this.options.scope, stateId);
      const payload = record?.properties[STATE_PAYLOAD];
      if (!payload || typeof payload !== "object" || Array.isArray(payload)) continue;
      const last = actionFromJson((payload as Readonly<Record<string, JsonValue>>).lastAppliedAction);
      if (last && canonicalJson(reverse(last)) === canonicalJson(action)) return true;
    }
    return false;
  }

  private assertMarginAndCac(customerId: string, action: GoogleAdsControlMutation): void {
    const key = this.resourceScope.get(action.resourceName);
    if (!key) throw new BiddingSupervisorError("POLICY_VIOLATION", "financial guardrail has no verified campaign/strategy scope");
    const evidence = this.evidence.get(key);
    if (!evidence || evidence.googleCostMicros < 0) throw new BiddingSupervisorError("POLICY_VIOLATION", "financial guardrail lacks complete cost and profitability evidence");
    const revenue = evidence.business.revenueMicros;
    const grossProfit = evidence.business.grossProfitBeforeAdSpendMicros;
    const grossMarginRatio = revenue > 0 ? grossProfit / revenue : 0;
    if (!Number.isFinite(grossMarginRatio) || grossMarginRatio < this.policy.minimumGrossMarginRatio) {
      throw new BiddingSupervisorError("POLICY_VIOLATION", "financial guardrail minimum gross-margin ratio is not met");
    }
    const qualified = evidence.business.qualifiedConversions;
    const cacMicros = qualified > 0 ? evidence.googleCostMicros / qualified : Number.POSITIVE_INFINITY;
    if (!Number.isFinite(cacMicros) || cacMicros > this.policy.maximumCustomerAcquisitionCostMicros) {
      throw new BiddingSupervisorError("POLICY_VIOLATION", "financial guardrail target CAC is exceeded");
    }
  }

  private applyMutation(customerId: string, action: GoogleAdsControlMutation): Promise<GoogleAdsMutationReceipt> {
    if (!expansion(action) || this.durableRollback(customerId, action)) return this.inner.googleAds.applyMutation(customerId, action);
    try {
      this.assertMarginAndCac(customerId, action);
    } catch (error) {
      this.emit({ operation: "BLOCK", customerId, resourceName: action.resourceName, actionKind: action.kind, reason: error instanceof Error ? error.message : "MARGIN_CAC_GUARD_FAILED", layer: "MARGIN_CAC" });
      throw error;
    }
    this.emit({ operation: "ALLOW", customerId, resourceName: action.resourceName, actionKind: action.kind, reason: "MARGIN_CAC_GUARD_PASSED", layer: "MARGIN_CAC" });
    return this.inner.googleAds.applyMutation(customerId, action);
  }
}
