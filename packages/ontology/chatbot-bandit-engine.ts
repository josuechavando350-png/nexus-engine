import type { OntologyScope } from "./index.js";
import type { OntologyReadPort } from "./persistence-query.js";
import type { TransactionOperation } from "./transaction.js";
import { canonicalUtc, hash, normalizeIdentifier } from "./chatbot-knowledge-types.js";
import {
  BANDIT_DECISION_TYPE,
  BANDIT_STATE_TYPE,
  ContextualBanditError,
  type BanditArmDefinition,
  type BanditArmScore,
  type BanditDecision,
  type BanditRewardInput,
  type BanditSelectionRequest,
  type BanditSelectionResult,
  type ContextualBanditPolicy,
} from "./chatbot-bandit-types.js";
import {
  banditDecisionId,
  banditStateId,
  decisionPayload,
  normalizeBanditContext,
  projectBanditDecision,
  projectBanditState,
  statePayload,
} from "./chatbot-bandit-codec.js";
import { banditPlan, chatbotContextualBanditSchema } from "./chatbot-bandit-schema.js";

function freezePlan(definition: BanditArmDefinition): BanditArmDefinition {
  const armId = normalizeIdentifier(definition.armId, "armId");
  const planId = normalizeIdentifier(definition.plan.planId, "planId");
  if (definition.plan.segments.length === 0) throw new ContextualBanditError("INVALID_INPUT", `arm ${armId} must contain at least one guarded response segment`);
  const segments = definition.plan.segments.map((segment) => Object.freeze({ ...segment }));
  return Object.freeze({ armId, plan: Object.freeze({ planId, segments: Object.freeze(segments) }) });
}

function decisionDigest(input: Omit<BanditDecision, "digest">): string {
  return hash("cbdecision-runtime", {
    decisionId: input.decisionId,
    banditId: input.banditId,
    interactionId: input.interactionId,
    armId: input.armId,
    planId: input.plan.planId,
    contextKey: input.contextKey,
    contextDigest: input.contextDigest,
    policyDigest: input.policyDigest,
    guardrailContextDigest: input.guardrailContextDigest,
    issuedAt: input.issuedAt,
  });
}

export class ContextualBanditEngine {
  readonly scopeDigest: string;
  private readonly arms = new Map<string, BanditArmDefinition>();
  private readonly schema;

  constructor(
    private readonly read: OntologyReadPort,
    readonly scope: OntologyScope,
    readonly policy: ContextualBanditPolicy,
    armDefinitions: readonly BanditArmDefinition[],
    private readonly now: () => number = Date.now,
  ) {
    if (armDefinitions.length === 0) throw new ContextualBanditError("INVALID_INPUT", "at least one bandit arm is required");
    if (armDefinitions.length > policy.maxArms) throw new ContextualBanditError("POLICY_VIOLATION", "bandit arm count exceeds policy maxArms");
    for (const raw of armDefinitions) {
      const arm = freezePlan(raw);
      if (this.arms.has(arm.armId)) throw new ContextualBanditError("INVALID_INPUT", `duplicate bandit arm ${arm.armId}`);
      this.arms.set(arm.armId, arm);
    }
    this.scopeDigest = hash("cbscope", scope);
    this.schema = chatbotContextualBanditSchema(scope);
  }

  private currentTime(): { ms: number; iso: string } {
    const ms = this.now();
    if (!Number.isFinite(ms)) throw new ContextualBanditError("INTEGRITY_FAILURE", "bandit engine clock is invalid");
    return { ms, iso: new Date(ms).toISOString() };
  }

  private state(banditId: string, armId: string, contextKey: string) {
    const record = this.read.getObject(this.scope, banditStateId(banditId, armId, contextKey));
    return record ? projectBanditState(record) : undefined;
  }

  private scores(banditId: string, contextKey: string, eligibleArmIds: readonly string[]): BanditArmScore[] {
    const rows = eligibleArmIds.map((armId) => {
      const state = this.state(banditId, armId, contextKey);
      return { armId, pulls: state?.pulls ?? 0, rewardSum: state?.rewardSum ?? 0 };
    });
    const totalPulls = rows.reduce((sum, row) => sum + row.pulls, 0);
    const cold = rows.some((row) => row.pulls < this.policy.minimumSamplesPerArm);
    return rows.map((row) => {
      const meanReward = row.pulls === 0 ? 0 : row.rewardSum / row.pulls;
      if (cold && row.pulls < this.policy.minimumSamplesPerArm) {
        const explorationBonus = this.policy.minimumSamplesPerArm - row.pulls;
        return { armId: row.armId, pulls: row.pulls, meanReward, explorationBonus, score: 1_000_000 + explorationBonus };
      }
      if (cold) return { armId: row.armId, pulls: row.pulls, meanReward, explorationBonus: 0, score: meanReward };
      const explorationBonus = this.policy.explorationWeight * Math.sqrt(Math.log(totalPulls + 1) / Math.max(1, row.pulls));
      return { armId: row.armId, pulls: row.pulls, meanReward, explorationBonus, score: meanReward + explorationBonus };
    }).sort((a, b) => b.score - a.score || a.pulls - b.pulls || a.armId.localeCompare(b.armId));
  }

  select(request: BanditSelectionRequest): BanditSelectionResult {
    const banditId = normalizeIdentifier(request.banditId, "banditId");
    const interactionId = normalizeIdentifier(request.interactionId, "interactionId");
    const guardrailContextDigest = normalizeIdentifier(request.guardrailContextDigest, "guardrailContextDigest");
    const { contextKey, contextDigest } = normalizeBanditContext(request.context, this.policy);
    const eligible = [...new Set(request.eligibleArmIds.map((id) => normalizeIdentifier(id, "eligibleArmId")))].sort();
    if (eligible.length === 0) throw new ContextualBanditError("INVALID_INPUT", "eligibleArmIds must not be empty");
    if (eligible.length > this.policy.maxArms) throw new ContextualBanditError("POLICY_VIOLATION", "eligible arm count exceeds policy maxArms");
    for (const armId of eligible) if (!this.arms.has(armId)) throw new ContextualBanditError("POLICY_VIOLATION", `eligible arm ${armId} is not registered`);

    const id = banditDecisionId(banditId, interactionId);
    const existingRaw = this.read.getObject(this.scope, id);
    if (existingRaw) {
      const existing = projectBanditDecision(existingRaw);
      if (existing.status !== "PENDING") throw new ContextualBanditError("CONFLICT", "interaction already has a rewarded bandit decision");
      if (existing.contextDigest !== contextDigest || existing.contextKey !== contextKey || existing.guardrailContextDigest !== guardrailContextDigest) {
        throw new ContextualBanditError("CONFLICT", "interactionId cannot be reused with different context or guardrail state");
      }
      if (existing.policyDigest !== this.policy.digest) throw new ContextualBanditError("CONFLICT", "interactionId was issued under a different bandit policy");
      const arm = this.arms.get(existing.armId);
      if (!arm || !eligible.includes(existing.armId)) throw new ContextualBanditError("CONFLICT", "existing interaction selected an arm that is no longer eligible");
      const core = {
        decisionId: existing.id,
        banditId,
        interactionId,
        armId: existing.armId,
        plan: arm.plan,
        contextKey,
        contextDigest,
        policyDigest: existing.policyDigest,
        guardrailContextDigest,
        issuedAt: existing.issuedAt,
        scores: Object.freeze([]) as readonly BanditArmScore[],
      };
      const decision = Object.freeze({ ...core, digest: decisionDigest(core) });
      return { decision, exposurePlan: banditPlan(this.scope, this.schema, []) };
    }

    const { ms: nowMs, iso: issuedAt } = this.currentTime();
    const ranked = this.scores(banditId, contextKey, eligible);
    const selected = ranked[0];
    if (!selected) throw new ContextualBanditError("INTEGRITY_FAILURE", "no bandit arm could be selected");
    const arm = this.arms.get(selected.armId)!;
    const current = this.state(banditId, selected.armId, contextKey);
    const nextState = statePayload({
      banditId,
      armId: selected.armId,
      contextKey,
      pulls: (current?.pulls ?? 0) + 1,
      rewardSum: current?.rewardSum ?? 0,
      rewardSquareSum: current?.rewardSquareSum ?? 0,
      createdAt: current?.createdAt ?? issuedAt,
      updatedAt: issuedAt,
    });
    const decisionProperties = decisionPayload({
      banditId,
      interactionId,
      armId: selected.armId,
      contextKey,
      contextDigest,
      policyDigest: this.policy.digest,
      guardrailContextDigest,
      issuedAt,
      status: "PENDING",
    });
    if (Date.parse(issuedAt) !== nowMs) throw new ContextualBanditError("INTEGRITY_FAILURE", "bandit clock canonicalization failed");
    const operations: TransactionOperation[] = [
      {
        kind: "CREATE_OBJECT",
        record: { id, typeId: BANDIT_DECISION_TYPE, scope: this.scope, properties: decisionProperties },
      },
      current
        ? { kind: "UPDATE_OBJECT", id: current.id, expectedRevision: current.revision, properties: nextState }
        : { kind: "CREATE_OBJECT", record: { id: banditStateId(banditId, selected.armId, contextKey), typeId: BANDIT_STATE_TYPE, scope: this.scope, properties: nextState } },
    ];
    const core = {
      decisionId: id,
      banditId,
      interactionId,
      armId: selected.armId,
      plan: arm.plan,
      contextKey,
      contextDigest,
      policyDigest: this.policy.digest,
      guardrailContextDigest,
      issuedAt,
      scores: Object.freeze(ranked.map((score) => Object.freeze({ ...score }))),
    };
    const decision = Object.freeze({ ...core, digest: decisionDigest(core) });
    return { decision, exposurePlan: banditPlan(this.scope, this.schema, operations) };
  }

  planReward(input: BanditRewardInput) {
    const decisionId = normalizeIdentifier(input.decisionId, "decisionId");
    if (!Number.isFinite(input.reward) || input.reward < 0 || input.reward > 1) throw new ContextualBanditError("INVALID_INPUT", "reward must be a finite number from 0 to 1");
    const outcomeAt = canonicalUtc(input.outcomeAt);
    const now = this.currentTime();
    if (Date.parse(outcomeAt) > now.ms) throw new ContextualBanditError("INVALID_INPUT", "outcomeAt cannot be in the future");
    const raw = this.read.getObject(this.scope, decisionId);
    if (!raw) throw new ContextualBanditError("NOT_FOUND", "bandit decision does not exist");
    const decision = projectBanditDecision(raw);
    if (decision.status === "REWARDED") {
      if (decision.reward === input.reward && decision.outcomeAt === outcomeAt) return banditPlan(this.scope, this.schema, []);
      throw new ContextualBanditError("CONFLICT", "bandit decision was already rewarded with a different outcome");
    }
    const issuedMs = Date.parse(decision.issuedAt);
    const outcomeMs = Date.parse(outcomeAt);
    if (outcomeMs < issuedMs) throw new ContextualBanditError("INVALID_INPUT", "outcomeAt cannot precede decision issuance");
    if (outcomeMs - issuedMs > this.policy.maxRewardDelayMs) throw new ContextualBanditError("REWARD_EXPIRED", "reward arrived after the configured attribution window");

    const stateRaw = this.read.getObject(this.scope, banditStateId(decision.banditId, decision.armId, decision.contextKey));
    if (!stateRaw) throw new ContextualBanditError("INTEGRITY_FAILURE", "bandit state for decision exposure is missing");
    const state = projectBanditState(stateRaw);
    if (state.pulls < 1) throw new ContextualBanditError("INTEGRITY_FAILURE", "bandit state has no recorded exposure");
    const nextState = statePayload({
      banditId: state.banditId,
      armId: state.armId,
      contextKey: state.contextKey,
      pulls: state.pulls,
      rewardSum: state.rewardSum + input.reward,
      rewardSquareSum: state.rewardSquareSum + input.reward * input.reward,
      createdAt: state.createdAt,
      updatedAt: outcomeAt,
    });
    const nextDecision = decisionPayload({
      banditId: decision.banditId,
      interactionId: decision.interactionId,
      armId: decision.armId,
      contextKey: decision.contextKey,
      contextDigest: decision.contextDigest,
      policyDigest: decision.policyDigest,
      guardrailContextDigest: decision.guardrailContextDigest,
      issuedAt: decision.issuedAt,
      status: "REWARDED",
      reward: input.reward,
      outcomeAt,
    });
    const operations: TransactionOperation[] = [
      { kind: "UPDATE_OBJECT", id: state.id, expectedRevision: state.revision, properties: nextState },
      { kind: "UPDATE_OBJECT", id: decision.id, expectedRevision: decision.revision, properties: nextDecision },
    ];
    return banditPlan(this.scope, this.schema, operations);
  }
}
