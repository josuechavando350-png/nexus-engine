import { canonicalJson, ontologyId, type OntologyScope } from "@nexus/ontology";
import type { JsonValue, OntologyTransactionPort } from "@nexus/ontology/transaction";
import { BiddingSupervisorError, type BusinessProfitabilityProvider, type BusinessProfitabilityQuery, type BusinessProfitabilitySnapshot, type GoogleAdsBiddingGateway } from "./index";
import type { GoogleAdsCampaignSnapshot, GoogleAdsControlMutation, GoogleAdsMutationReceipt, GoogleAdsPortfolioSnapshot } from "./google-ads-rest";

const ID = /^[A-Za-z0-9](?:[A-Za-z0-9._:-]{0,127})$/u;
const STATE_PAYLOAD = "cortex.bidding.state.payload";

export interface RevenueGuardrailPolicy {
  readonly version: 1;
  readonly maxSnapshotAgeMs: number;
  readonly minimumRevenueMicros: number;
  readonly minimumProfitAfterAdSpendMicros: number;
  readonly minimumQualifiedConversions: number;
  readonly minimumRevenueToSpendRatio: number;
  readonly allowedSourceIds: readonly string[];
}

export type CreateRevenueGuardrailPolicyInput = RevenueGuardrailPolicy;
export interface RevenueGuardrailCampaign { readonly customerId: string; readonly campaignId: string }
export interface RevenueGuardrailTelemetryEvent {
  readonly operation: "ALLOW" | "BLOCK" | "ROLLBACK_BYPASS";
  readonly customerId: string;
  readonly resourceName: string;
  readonly actionKind: GoogleAdsControlMutation["kind"];
  readonly reason: string;
}

export interface RevenueGuardedBiddingAdaptersOptions {
  readonly transactions: OntologyTransactionPort;
  readonly scope: OntologyScope;
  readonly campaigns: readonly RevenueGuardrailCampaign[];
  readonly googleAds: GoogleAdsBiddingGateway;
  readonly profitability: BusinessProfitabilityProvider;
  readonly policy: CreateRevenueGuardrailPolicyInput;
  readonly now?: () => number;
  readonly onTelemetry?: (event: RevenueGuardrailTelemetryEvent) => void;
  readonly onTelemetryError?: (error: unknown) => void;
}

interface ScopeEvidence {
  readonly snapshot: BusinessProfitabilitySnapshot;
  readonly googleCostMicros: number;
}

type ScopeKey = string;

function nonNegativeSafeInteger(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new BiddingSupervisorError("INVALID_INPUT", `${field} must be a non-negative safe integer`);
  return value;
}
function nonNegativeNumber(value: number, field: string): number {
  if (!Number.isFinite(value) || value < 0) throw new BiddingSupervisorError("INVALID_INPUT", `${field} must be finite and non-negative`);
  return value;
}
function positiveSafeInteger(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new BiddingSupervisorError("INVALID_INPUT", `${field} must be a positive safe integer`);
  return value;
}
function sourceIds(values: readonly string[]): readonly string[] {
  if (!Array.isArray(values) || values.length < 1 || values.length > 32) throw new BiddingSupervisorError("INVALID_INPUT", "allowedSourceIds must contain 1..32 items");
  const normalized = values.map((value) => {
    if (typeof value !== "string" || !ID.test(value.trim())) throw new BiddingSupervisorError("INVALID_INPUT", "allowedSourceIds contains a malformed identifier");
    return value.trim();
  });
  if (new Set(normalized).size !== normalized.length) throw new BiddingSupervisorError("INVALID_INPUT", "allowedSourceIds must be unique");
  return Object.freeze(normalized);
}

export function createRevenueGuardrailPolicy(input: CreateRevenueGuardrailPolicyInput): RevenueGuardrailPolicy {
  if (input.version !== 1) throw new BiddingSupervisorError("INVALID_INPUT", "revenue guardrail policy version must be 1");
  const maxSnapshotAgeMs = positiveSafeInteger(input.maxSnapshotAgeMs, "maxSnapshotAgeMs");
  if (maxSnapshotAgeMs > 86_400_000) throw new BiddingSupervisorError("INVALID_INPUT", "maxSnapshotAgeMs must be at most 86400000");
  return Object.freeze({
    version: 1,
    maxSnapshotAgeMs,
    minimumRevenueMicros: nonNegativeSafeInteger(input.minimumRevenueMicros, "minimumRevenueMicros"),
    minimumProfitAfterAdSpendMicros: nonNegativeSafeInteger(input.minimumProfitAfterAdSpendMicros, "minimumProfitAfterAdSpendMicros"),
    minimumQualifiedConversions: nonNegativeNumber(input.minimumQualifiedConversions, "minimumQualifiedConversions"),
    minimumRevenueToSpendRatio: nonNegativeNumber(input.minimumRevenueToSpendRatio, "minimumRevenueToSpendRatio"),
    allowedSourceIds: sourceIds(input.allowedSourceIds),
  });
}

function scopeKey(customerId: string, kind: BusinessProfitabilityQuery["scopeKind"], scopeId: string, startMs: number, endMs: number): ScopeKey {
  return `${customerId}\u0000${kind}\u0000${scopeId}\u0000${startMs}\u0000${endMs}`;
}

function canonicalUtc(value: string, field: string): number {
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== value) throw new BiddingSupervisorError("INTEGRITY_FAILURE", `${field} must be canonical UTC`);
  return parsed.getTime();
}

function reverse(action: GoogleAdsControlMutation): GoogleAdsControlMutation {
  if (action.kind === "CAMPAIGN_BUDGET") return { ...action, expectedAmountMicros: action.nextAmountMicros, nextAmountMicros: action.expectedAmountMicros };
  if (action.kind === "STANDARD_TARGET_CPA") return { ...action, expectedTargetCpaMicros: action.nextTargetCpaMicros, nextTargetCpaMicros: action.expectedTargetCpaMicros };
  if (action.kind === "STANDARD_TARGET_ROAS") return { ...action, expectedTargetRoas: action.nextTargetRoas, nextTargetRoas: action.expectedTargetRoas };
  if (action.kind === "PORTFOLIO_TARGET_CPA") return { ...action, expectedTargetCpaMicros: action.nextTargetCpaMicros, nextTargetCpaMicros: action.expectedTargetCpaMicros };
  if (action.kind === "PORTFOLIO_TARGET_ROAS") return { ...action, expectedTargetRoas: action.nextTargetRoas, nextTargetRoas: action.expectedTargetRoas };
  return { ...action, expectedCeilingMicros: action.nextCeilingMicros, nextCeilingMicros: action.expectedCeilingMicros, expectedFloorMicros: action.nextFloorMicros, nextFloorMicros: action.expectedFloorMicros };
}

function actionFromJson(value: JsonValue | undefined): GoogleAdsControlMutation | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as Readonly<Record<string, JsonValue>>;
  if (typeof raw.kind !== "string" || typeof raw.resourceName !== "string") return null;
  const number = (key: string): number | null => typeof raw[key] === "number" && Number.isFinite(raw[key]) ? raw[key] as number : null;
  if (raw.kind === "CAMPAIGN_BUDGET") { const a = number("expectedAmountMicros"); const b = number("nextAmountMicros"); return a === null || b === null ? null : { kind: raw.kind, resourceName: raw.resourceName, expectedAmountMicros: a, nextAmountMicros: b }; }
  if (raw.kind === "STANDARD_TARGET_CPA") { const a = number("expectedTargetCpaMicros"); const b = number("nextTargetCpaMicros"); return a === null || b === null ? null : { kind: raw.kind, resourceName: raw.resourceName, expectedTargetCpaMicros: a, nextTargetCpaMicros: b }; }
  if (raw.kind === "STANDARD_TARGET_ROAS") { const a = number("expectedTargetRoas"); const b = number("nextTargetRoas"); return a === null || b === null ? null : { kind: raw.kind, resourceName: raw.resourceName, expectedTargetRoas: a, nextTargetRoas: b }; }
  if (raw.kind === "PORTFOLIO_TARGET_CPA" && (raw.strategyType === "TARGET_CPA" || raw.strategyType === "MAXIMIZE_CONVERSIONS")) { const a = number("expectedTargetCpaMicros"); const b = number("nextTargetCpaMicros"); return a === null || b === null ? null : { kind: raw.kind, resourceName: raw.resourceName, strategyType: raw.strategyType, expectedTargetCpaMicros: a, nextTargetCpaMicros: b }; }
  if (raw.kind === "PORTFOLIO_TARGET_ROAS" && (raw.strategyType === "TARGET_ROAS" || raw.strategyType === "MAXIMIZE_CONVERSION_VALUE")) { const a = number("expectedTargetRoas"); const b = number("nextTargetRoas"); return a === null || b === null ? null : { kind: raw.kind, resourceName: raw.resourceName, strategyType: raw.strategyType, expectedTargetRoas: a, nextTargetRoas: b }; }
  if (raw.kind === "PORTFOLIO_BID_BOUNDS" && (raw.strategyType === "TARGET_CPA" || raw.strategyType === "MAXIMIZE_CONVERSIONS" || raw.strategyType === "TARGET_ROAS" || raw.strategyType === "MAXIMIZE_CONVERSION_VALUE")) {
    const nullable = (key: string): number | null | undefined => raw[key] === null ? null : typeof raw[key] === "number" && Number.isFinite(raw[key]) ? raw[key] as number : undefined;
    const expectedCeilingMicros = nullable("expectedCeilingMicros"); const nextCeilingMicros = nullable("nextCeilingMicros"); const expectedFloorMicros = nullable("expectedFloorMicros"); const nextFloorMicros = nullable("nextFloorMicros");
    if ([expectedCeilingMicros, nextCeilingMicros, expectedFloorMicros, nextFloorMicros].some((item) => item === undefined)) return null;
    return { kind: raw.kind, resourceName: raw.resourceName, strategyType: raw.strategyType, expectedCeilingMicros: expectedCeilingMicros!, nextCeilingMicros: nextCeilingMicros!, expectedFloorMicros: expectedFloorMicros!, nextFloorMicros: nextFloorMicros! };
  }
  return null;
}

function expansion(action: GoogleAdsControlMutation): boolean {
  if (action.kind === "CAMPAIGN_BUDGET") return action.nextAmountMicros > action.expectedAmountMicros;
  if (action.kind === "STANDARD_TARGET_CPA" || action.kind === "PORTFOLIO_TARGET_CPA") return action.nextTargetCpaMicros > action.expectedTargetCpaMicros;
  if (action.kind === "STANDARD_TARGET_ROAS" || action.kind === "PORTFOLIO_TARGET_ROAS") return action.nextTargetRoas < action.expectedTargetRoas;
  const ceilingExpansion = action.nextCeilingMicros !== null && (action.expectedCeilingMicros === null || action.nextCeilingMicros > action.expectedCeilingMicros);
  const floorExpansion = action.nextFloorMicros !== null && (action.expectedFloorMicros === null || action.nextFloorMicros > action.expectedFloorMicros);
  return ceilingExpansion || floorExpansion;
}

export class RevenueGuardedBiddingAdapters {
  readonly googleAds: GoogleAdsBiddingGateway;
  readonly profitability: BusinessProfitabilityProvider;
  readonly policy: RevenueGuardrailPolicy;
  private readonly resourceScope = new Map<string, ScopeKey>();
  private readonly evidence = new Map<ScopeKey, ScopeEvidence>();
  private readonly costByScope = new Map<ScopeKey, number>();
  private readonly now: () => number;

  constructor(private readonly options: RevenueGuardedBiddingAdaptersOptions) {
    this.policy = createRevenueGuardrailPolicy(options.policy);
    this.now = options.now ?? Date.now;
    this.profitability = Object.freeze({ getProfitability: (query: BusinessProfitabilityQuery) => this.getProfitability(query) });
    this.googleAds = Object.freeze({
      getCampaignSnapshot: (customerId: string, campaignId: string, startMs: number, endMs: number) => this.getCampaignSnapshot(customerId, campaignId, startMs, endMs),
      getPortfolioSnapshot: (customerId: string, resourceName: string, startMs: number, endMs: number) => this.getPortfolioSnapshot(customerId, resourceName, startMs, endMs),
      applyMutation: (customerId: string, action: GoogleAdsControlMutation) => this.applyMutation(customerId, action),
    });
  }

  private emit(event: RevenueGuardrailTelemetryEvent): void {
    try { this.options.onTelemetry?.(Object.freeze(event)); }
    catch (error) { try { this.options.onTelemetryError?.(error); } catch { /* telemetry cannot affect bidding */ } }
  }

  private async getCampaignSnapshot(customerId: string, campaignId: string, startMs: number, endMs: number): Promise<GoogleAdsCampaignSnapshot> {
    const snapshot = await this.options.googleAds.getCampaignSnapshot(customerId, campaignId, startMs, endMs);
    const key = scopeKey(customerId, "CAMPAIGN", campaignId, startMs, endMs);
    this.resourceScope.set(snapshot.campaignResourceName, key);
    this.resourceScope.set(snapshot.budgetResourceName, key);
    this.costByScope.set(key, snapshot.costMicros);
    const current = this.evidence.get(key);
    if (current) this.evidence.set(key, Object.freeze({ ...current, googleCostMicros: snapshot.costMicros }));
    return snapshot;
  }

  private async getPortfolioSnapshot(customerId: string, resourceName: string, startMs: number, endMs: number): Promise<GoogleAdsPortfolioSnapshot> {
    const snapshot = await this.options.googleAds.getPortfolioSnapshot(customerId, resourceName, startMs, endMs);
    const key = scopeKey(customerId, "BIDDING_STRATEGY", snapshot.strategyId, startMs, endMs);
    this.resourceScope.set(snapshot.resourceName, key);
    this.costByScope.set(key, snapshot.costMicros);
    const current = this.evidence.get(key);
    if (current) this.evidence.set(key, Object.freeze({ ...current, googleCostMicros: snapshot.costMicros }));
    return snapshot;
  }

  private async getProfitability(query: BusinessProfitabilityQuery): Promise<BusinessProfitabilitySnapshot> {
    const snapshot = await this.options.profitability.getProfitability(query);
    if (snapshot.customerId !== query.customerId || snapshot.scopeKind !== query.scopeKind || snapshot.scopeId !== query.scopeId || snapshot.windowStart !== query.windowStart || snapshot.windowEnd !== query.windowEnd) throw new BiddingSupervisorError("INTEGRITY_FAILURE", "revenue guardrail profitability scope/window mismatch");
    const startMs = canonicalUtc(query.windowStart, "revenue guardrail windowStart");
    const endMs = canonicalUtc(query.windowEnd, "revenue guardrail windowEnd");
    const key = scopeKey(query.customerId, query.scopeKind, query.scopeId, startMs, endMs);
    this.evidence.set(key, Object.freeze({ snapshot, googleCostMicros: this.costByScope.get(key) ?? -1 }));
    return snapshot;
  }

  private durableRollback(customerId: string, action: GoogleAdsControlMutation): boolean {
    for (const campaign of this.options.campaigns) {
      if (campaign.customerId !== customerId) continue;
      const id = ontologyId("cortex-bidding-state-v2", { scope: this.options.scope, customerId: campaign.customerId, campaignId: campaign.campaignId });
      const record = this.options.transactions.getObject(this.options.scope, id);
      const payload = record?.properties[STATE_PAYLOAD];
      if (!payload || typeof payload !== "object" || Array.isArray(payload)) continue;
      const last = actionFromJson((payload as Readonly<Record<string, JsonValue>>).lastAppliedAction);
      if (last && canonicalJson(reverse(last)) === canonicalJson(action)) return true;
    }
    return false;
  }

  private assertExpansionAllowed(customerId: string, action: GoogleAdsControlMutation): void {
    const key = this.resourceScope.get(action.resourceName);
    if (!key) throw new BiddingSupervisorError("POLICY_VIOLATION", "revenue guardrail has no verified scope for expansion mutation");
    const evidence = this.evidence.get(key);
    if (!evidence || evidence.googleCostMicros < 0) throw new BiddingSupervisorError("POLICY_VIOLATION", "revenue guardrail lacks complete business and spend evidence");
    const observedAt = canonicalUtc(evidence.snapshot.observedAt, "revenue guardrail observedAt");
    const age = this.now() - observedAt;
    if (age < 0 || age > this.policy.maxSnapshotAgeMs) throw new BiddingSupervisorError("POLICY_VIOLATION", "revenue guardrail business evidence is stale or future-dated");
    if (!this.policy.allowedSourceIds.includes(evidence.snapshot.sourceId)) throw new BiddingSupervisorError("POLICY_VIOLATION", "revenue guardrail source is not allowlisted");
    if (evidence.snapshot.revenueMicros < this.policy.minimumRevenueMicros) throw new BiddingSupervisorError("POLICY_VIOLATION", "revenue guardrail minimum realized revenue is not met");
    const profitAfterAdSpend = evidence.snapshot.grossProfitBeforeAdSpendMicros - evidence.googleCostMicros;
    if (profitAfterAdSpend < this.policy.minimumProfitAfterAdSpendMicros) throw new BiddingSupervisorError("POLICY_VIOLATION", "revenue guardrail minimum profit after ad spend is not met");
    if (evidence.snapshot.qualifiedConversions < this.policy.minimumQualifiedConversions) throw new BiddingSupervisorError("POLICY_VIOLATION", "revenue guardrail minimum qualified conversions is not met");
    const revenueToSpend = evidence.googleCostMicros > 0 ? evidence.snapshot.revenueMicros / evidence.googleCostMicros : 0;
    if (revenueToSpend < this.policy.minimumRevenueToSpendRatio) throw new BiddingSupervisorError("POLICY_VIOLATION", "revenue guardrail minimum revenue-to-spend ratio is not met");
  }

  private applyMutation(customerId: string, action: GoogleAdsControlMutation): Promise<GoogleAdsMutationReceipt> {
    if (!expansion(action)) {
      this.emit({ operation: "ALLOW", customerId, resourceName: action.resourceName, actionKind: action.kind, reason: "RISK_CONTRACTION" });
      return this.options.googleAds.applyMutation(customerId, action);
    }
    if (this.durableRollback(customerId, action)) {
      this.emit({ operation: "ROLLBACK_BYPASS", customerId, resourceName: action.resourceName, actionKind: action.kind, reason: "EXACT_DURABLE_ROLLBACK" });
      return this.options.googleAds.applyMutation(customerId, action);
    }
    try {
      this.assertExpansionAllowed(customerId, action);
    } catch (error) {
      this.emit({ operation: "BLOCK", customerId, resourceName: action.resourceName, actionKind: action.kind, reason: error instanceof Error ? error.message : "REVENUE_GUARD_FAILED" });
      throw error;
    }
    this.emit({ operation: "ALLOW", customerId, resourceName: action.resourceName, actionKind: action.kind, reason: "REVENUE_GUARD_PASSED" });
    return this.options.googleAds.applyMutation(customerId, action);
  }
}
