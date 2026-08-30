import type { OntologyScope } from "./index.js";
import type { GuardrailResponsePlan } from "./chatbot-guardrails-types.js";
import type { TransactionOperation } from "./transaction.js";

export const BANDIT_STATE_TYPE = "chatbot.contextual_bandit_state";
export const BANDIT_DECISION_TYPE = "chatbot.contextual_bandit_decision";

export const BSP = Object.freeze({
  banditId: "chatbot.bandit_id",
  armId: "chatbot.bandit_arm_id",
  contextKey: "chatbot.bandit_context_key",
  pulls: "chatbot.bandit_pulls",
  rewardSum: "chatbot.bandit_reward_sum",
  rewardSquareSum: "chatbot.bandit_reward_square_sum",
  createdAt: "chatbot.bandit_state_created_at",
  updatedAt: "chatbot.bandit_state_updated_at",
  recordDigest: "chatbot.bandit_state_digest",
});

export const BDP = Object.freeze({
  banditId: "chatbot.bandit_decision_bandit_id",
  interactionId: "chatbot.bandit_interaction_id",
  armId: "chatbot.bandit_decision_arm_id",
  contextKey: "chatbot.bandit_decision_context_key",
  contextDigest: "chatbot.bandit_context_digest",
  policyDigest: "chatbot.bandit_policy_digest",
  guardrailContextDigest: "chatbot.bandit_guardrail_context_digest",
  issuedAt: "chatbot.bandit_issued_at",
  status: "chatbot.bandit_decision_status",
  reward: "chatbot.bandit_reward",
  outcomeAt: "chatbot.bandit_outcome_at",
  recordDigest: "chatbot.bandit_decision_digest",
});

export type BanditDecisionStatus = "PENDING" | "REWARDED";

export type BanditContextValue = string | number | boolean;
export type BanditContext = Readonly<Record<string, BanditContextValue>>;

export interface BanditArmDefinition {
  readonly armId: string;
  readonly plan: GuardrailResponsePlan;
}

export interface ContextualBanditPolicy {
  readonly policyId: string;
  readonly version: string;
  readonly explorationWeight: number;
  readonly minimumSamplesPerArm: number;
  readonly maxArms: number;
  readonly maxContextFeatures: number;
  readonly maxRewardDelayMs: number;
  readonly allowedContextKeys: readonly string[];
  readonly digest: string;
}

export interface BanditStateRecord {
  readonly id: string;
  readonly banditId: string;
  readonly armId: string;
  readonly contextKey: string;
  readonly pulls: number;
  readonly rewardSum: number;
  readonly rewardSquareSum: number;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly digest: string;
  readonly revision: number;
}

export interface BanditDecisionRecord {
  readonly id: string;
  readonly banditId: string;
  readonly interactionId: string;
  readonly armId: string;
  readonly contextKey: string;
  readonly contextDigest: string;
  readonly policyDigest: string;
  readonly guardrailContextDigest: string;
  readonly issuedAt: string;
  readonly status: BanditDecisionStatus;
  readonly reward?: number;
  readonly outcomeAt?: string;
  readonly digest: string;
  readonly revision: number;
}

export interface BanditMutationPlan {
  readonly scope: OntologyScope;
  readonly schemaId: string;
  readonly requiredPermission: "chatbot.bandit.write";
  readonly noop: boolean;
  readonly operations: readonly TransactionOperation[];
  readonly digest: string;
}

export interface BanditSelectionRequest {
  readonly banditId: string;
  readonly interactionId: string;
  readonly context: BanditContext;
  readonly eligibleArmIds: readonly string[];
  readonly guardrailContextDigest: string;
}

export interface BanditArmScore {
  readonly armId: string;
  readonly pulls: number;
  readonly meanReward: number;
  readonly explorationBonus: number;
  readonly score: number;
}

export interface BanditDecision {
  readonly decisionId: string;
  readonly banditId: string;
  readonly interactionId: string;
  readonly armId: string;
  readonly plan: GuardrailResponsePlan;
  readonly contextKey: string;
  readonly contextDigest: string;
  readonly policyDigest: string;
  readonly guardrailContextDigest: string;
  readonly issuedAt: string;
  readonly scores: readonly BanditArmScore[];
  readonly digest: string;
}

export interface BanditSelectionResult {
  readonly decision: BanditDecision;
  readonly exposurePlan: BanditMutationPlan;
}

export interface BanditRewardInput {
  readonly decisionId: string;
  readonly reward: number;
  readonly outcomeAt: string;
}

export class ContextualBanditError extends Error {
  constructor(
    public readonly code:
      | "INVALID_INPUT"
      | "NOT_FOUND"
      | "CONFLICT"
      | "INTEGRITY_FAILURE"
      | "POLICY_VIOLATION"
      | "REWARD_EXPIRED",
    message: string,
  ) {
    super(message);
    this.name = "ContextualBanditError";
  }
}
