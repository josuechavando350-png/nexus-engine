import type { OntologyScope } from "./index.js";
import type { GuardrailResponsePlan, GuardedGenerationContext } from "./chatbot-guardrails-types.js";
import type { MemoryRecallContext } from "./chatbot-memory-types.js";

export const REASONING_AGENT_ROLES = ["PLANNER", "CRITIC", "VERIFIER", "RECOVERY"] as const;
export type ReasoningAgentRole = (typeof REASONING_AGENT_ROLES)[number];

export const REASONING_VERDICTS = ["ACCEPT", "REJECT", "UNCERTAIN"] as const;
export type ReasoningVerdict = (typeof REASONING_VERDICTS)[number];

export const REASONING_ISSUE_CODES = [
  "NONE",
  "INTENT_MISMATCH",
  "FACT_NOT_ALLOWED",
  "PLAN_EMPTY",
  "PLAN_SHAPE_INVALID",
  "ESCALATION_REQUIRED",
  "LOW_CONFIDENCE",
  "AGENT_FAILURE",
  "INVALID_AGENT_OUTPUT",
  "NO_SAFE_CANDIDATE",
] as const;
export type ReasoningIssueCode = (typeof REASONING_ISSUE_CODES)[number];

export interface ReasoningCandidateProfile {
  readonly armId: string;
  readonly intentTags?: readonly string[];
  readonly fallback?: boolean;
}

export interface ReasoningPolicy {
  readonly policyId: string;
  readonly version: string;
  readonly maxInputChars: number;
  readonly maxRepairAttempts: number;
  readonly minAcceptVotes: number;
  readonly minMeanConfidence: number;
  readonly maxAgentFailures: number;
  readonly maxIntentTagsPerCandidate: number;
  readonly maxIntentTagChars: number;
  readonly digest: string;
}

export interface ReasoningEvidenceSnapshot {
  readonly userMessage: string;
  readonly userMessageDigest: string;
  readonly guardedContextDigest: string;
  readonly groundingStatus: GuardedGenerationContext["grounding"]["status"];
  readonly disposition: GuardedGenerationContext["envelope"]["disposition"];
  readonly allowedFactIds: readonly string[];
  readonly qualifiedFactIds: readonly string[];
  readonly requestedClaimClasses: readonly string[];
  readonly memoryStatus: MemoryRecallContext["status"];
  readonly memoryCategories: readonly string[];
  readonly memoryKeys: readonly string[];
  readonly memoryAuthority: MemoryRecallContext["authority"];
}

export interface ReasoningAgentInput {
  readonly reasoningId: string;
  readonly interactionId: string;
  readonly attempt: number;
  readonly scope: OntologyScope;
  readonly scopeDigest: string;
  readonly candidateArmId: string;
  readonly candidatePlan: GuardrailResponsePlan;
  readonly candidateProfile?: ReasoningCandidateProfile;
  readonly remainingArmIds: readonly string[];
  readonly evidence: ReasoningEvidenceSnapshot;
}

export interface ReasoningAgentAssessment {
  readonly agentId: string;
  readonly role: ReasoningAgentRole;
  readonly candidateArmId: string;
  readonly verdict: ReasoningVerdict;
  readonly confidence: number;
  readonly issueCodes: readonly ReasoningIssueCode[];
}

export interface ReasoningAgentPort {
  readonly agentId: string;
  readonly role: ReasoningAgentRole;
  assess(input: ReasoningAgentInput): Promise<ReasoningAgentAssessment> | ReasoningAgentAssessment;
}

export interface VerifiedReasoningAssessment extends ReasoningAgentAssessment {
  readonly digest: string;
}

export interface ReasoningAttemptRecord {
  readonly attempt: number;
  readonly candidateArmId: string;
  readonly candidatePlanId: string;
  readonly verdict: ReasoningVerdict;
  readonly acceptVotes: number;
  readonly rejectVotes: number;
  readonly uncertainVotes: number;
  readonly meanConfidence: number;
  readonly issueCodes: readonly ReasoningIssueCode[];
  readonly assessments: readonly VerifiedReasoningAssessment[];
  readonly digest: string;
}

export interface ReasoningDeliberation {
  readonly reasoningId: string;
  readonly interactionId: string;
  readonly policyDigest: string;
  readonly scopeDigest: string;
  readonly status: "VERIFIED" | "REPAIRED";
  readonly selectedArmId: string;
  readonly selectedPlanId: string;
  readonly rejectedArmIds: readonly string[];
  readonly attempts: readonly ReasoningAttemptRecord[];
  readonly createdAt: string;
  readonly digest: string;
}

export interface ReasoningEvaluationResult {
  readonly accepted: boolean;
  readonly attempt: ReasoningAttemptRecord;
}

export class ChatbotReasoningError extends Error {
  constructor(
    public readonly code:
      | "INVALID_INPUT"
      | "POLICY_VIOLATION"
      | "INTEGRITY_FAILURE"
      | "NO_SAFE_CANDIDATE"
      | "AGENT_FAILURE_BUDGET_EXCEEDED",
    message: string,
  ) {
    super(message);
    this.name = "ChatbotReasoningError";
  }
}
