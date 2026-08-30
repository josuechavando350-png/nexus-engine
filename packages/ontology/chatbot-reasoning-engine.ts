import type { OntologyScope } from "./index.js";
import { hash, normalizeIdentifier } from "./chatbot-knowledge-types.js";
import type { GuardrailResponsePlan } from "./chatbot-guardrails-types.js";
import { verifyReasoningPolicy } from "./chatbot-reasoning-policy.js";
import {
  ChatbotReasoningError,
  REASONING_AGENT_ROLES,
  REASONING_ISSUE_CODES,
  REASONING_VERDICTS,
  type ReasoningAgentAssessment,
  type ReasoningAgentInput,
  type ReasoningAgentPort,
  type ReasoningAttemptRecord,
  type ReasoningCandidateProfile,
  type ReasoningEvaluationResult,
  type ReasoningIssueCode,
  type ReasoningPolicy,
  type ReasoningEvidenceSnapshot,
  type VerifiedReasoningAssessment,
} from "./chatbot-reasoning-types.js";

const MAX_REASONING_AGENTS = 16;

class ReasoningAgentTimeoutError extends Error {
  constructor() {
    super("reasoning agent timed out");
    this.name = "ReasoningAgentTimeoutError";
  }
}

function normalizeText(value: string): string {
  return value.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function tokens(value: string): ReadonlySet<string> {
  return new Set(normalizeText(value).split(/\s+/).filter(Boolean));
}

function freezeAssessment(input: ReasoningAgentAssessment): VerifiedReasoningAssessment {
  const core = {
    agentId: input.agentId,
    role: input.role,
    candidateArmId: input.candidateArmId,
    verdict: input.verdict,
    confidence: input.confidence,
    issueCodes: Object.freeze([...input.issueCodes]),
  };
  return Object.freeze({ ...core, digest: hash("reasoning-assessment", core) });
}

function validateAssessment(raw: ReasoningAgentAssessment, agent: ReasoningAgentPort, input: ReasoningAgentInput): VerifiedReasoningAssessment {
  const agentId = normalizeIdentifier(raw.agentId, "agentId");
  if (agentId !== agent.agentId) throw new ChatbotReasoningError("INTEGRITY_FAILURE", `agent ${agent.agentId} returned a mismatched agentId`);
  if (raw.role !== agent.role || !REASONING_AGENT_ROLES.includes(raw.role)) {
    throw new ChatbotReasoningError("INTEGRITY_FAILURE", `agent ${agent.agentId} returned an invalid role`);
  }
  if (normalizeIdentifier(raw.candidateArmId, "candidateArmId") !== input.candidateArmId) {
    throw new ChatbotReasoningError("INTEGRITY_FAILURE", `agent ${agent.agentId} assessed a different candidate`);
  }
  if (!REASONING_VERDICTS.includes(raw.verdict)) throw new ChatbotReasoningError("INTEGRITY_FAILURE", `agent ${agent.agentId} returned an invalid verdict`);
  if (!Number.isFinite(raw.confidence) || raw.confidence < 0 || raw.confidence > 1) {
    throw new ChatbotReasoningError("INTEGRITY_FAILURE", `agent ${agent.agentId} returned invalid confidence`);
  }
  if (!Array.isArray(raw.issueCodes) || raw.issueCodes.length === 0 || raw.issueCodes.length > 16) {
    throw new ChatbotReasoningError("INTEGRITY_FAILURE", `agent ${agent.agentId} returned invalid issue codes`);
  }
  const issues = [...new Set(raw.issueCodes)];
  if (issues.some((code) => !REASONING_ISSUE_CODES.includes(code))) {
    throw new ChatbotReasoningError("INTEGRITY_FAILURE", `agent ${agent.agentId} returned an unknown issue code`);
  }
  const normalizedIssues = issues.length > 1 ? issues.filter((code) => code !== "NONE") : issues;
  return freezeAssessment({ ...raw, agentId, candidateArmId: input.candidateArmId, issueCodes: normalizedIssues.length ? normalizedIssues : ["NONE"] });
}

async function invokeAgent(
  agent: ReasoningAgentPort,
  baseInput: Omit<ReasoningAgentInput, "signal">,
  timeoutMs: number,
): Promise<VerifiedReasoningAssessment> {
  const controller = new AbortController();
  const input: ReasoningAgentInput = Object.freeze({ ...baseInput, signal: controller.signal });
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  try {
    const timeout = new Promise<never>((_, reject) => {
      timeoutHandle = setTimeout(() => {
        controller.abort();
        reject(new ReasoningAgentTimeoutError());
      }, timeoutMs);
    });
    const raw = await Promise.race([Promise.resolve(agent.assess(input)), timeout]);
    return validateAssessment(raw, agent, input);
  } finally {
    if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
  }
}

export class IntentPlannerReasoningAgent implements ReasoningAgentPort {
  readonly agentId = "nexus.reasoning.intent-planner";
  readonly role = "PLANNER" as const;

  assess(input: ReasoningAgentInput): ReasoningAgentAssessment {
    const tags = input.candidateProfile?.intentTags ?? [];
    if (tags.length === 0) {
      return { agentId: this.agentId, role: this.role, candidateArmId: input.candidateArmId, verdict: "UNCERTAIN", confidence: 0.5, issueCodes: ["LOW_CONFIDENCE"] };
    }
    const messageTokens = tokens(input.evidence.userMessage);
    const matched = tags.some((tag) => [...tokens(tag)].some((token) => messageTokens.has(token)));
    return matched
      ? { agentId: this.agentId, role: this.role, candidateArmId: input.candidateArmId, verdict: "ACCEPT", confidence: 0.9, issueCodes: ["NONE"] }
      : { agentId: this.agentId, role: this.role, candidateArmId: input.candidateArmId, verdict: "UNCERTAIN", confidence: 0.45, issueCodes: ["INTENT_MISMATCH", "LOW_CONFIDENCE"] };
  }
}

export class GuardrailCriticReasoningAgent implements ReasoningAgentPort {
  readonly agentId = "nexus.reasoning.guardrail-critic";
  readonly role = "CRITIC" as const;

  assess(input: ReasoningAgentInput): ReasoningAgentAssessment {
    if (input.evidence.disposition === "ESCALATE") {
      return { agentId: this.agentId, role: this.role, candidateArmId: input.candidateArmId, verdict: "REJECT", confidence: 1, issueCodes: ["ESCALATION_REQUIRED"] };
    }
    if (input.candidatePlan.segments.length === 0) {
      return { agentId: this.agentId, role: this.role, candidateArmId: input.candidateArmId, verdict: "REJECT", confidence: 1, issueCodes: ["PLAN_EMPTY"] };
    }
    const usableFacts = new Set([...input.evidence.allowedFactIds, ...input.evidence.qualifiedFactIds]);
    for (const segment of input.candidatePlan.segments) {
      if (segment.kind === "FACT" && !usableFacts.has(segment.factId)) {
        return { agentId: this.agentId, role: this.role, candidateArmId: input.candidateArmId, verdict: "REJECT", confidence: 1, issueCodes: ["FACT_NOT_ALLOWED"] };
      }
      if (segment.kind !== "FACT" && segment.kind !== "COPY") {
        return { agentId: this.agentId, role: this.role, candidateArmId: input.candidateArmId, verdict: "REJECT", confidence: 1, issueCodes: ["PLAN_SHAPE_INVALID"] };
      }
    }
    return { agentId: this.agentId, role: this.role, candidateArmId: input.candidateArmId, verdict: "ACCEPT", confidence: 1, issueCodes: ["NONE"] };
  }
}

export class BoundaryVerifierReasoningAgent implements ReasoningAgentPort {
  readonly agentId = "nexus.reasoning.boundary-verifier";
  readonly role = "VERIFIER" as const;

  assess(input: ReasoningAgentInput): ReasoningAgentAssessment {
    if (input.evidence.memoryAuthority !== "PERSONALIZATION_ONLY") {
      return { agentId: this.agentId, role: this.role, candidateArmId: input.candidateArmId, verdict: "REJECT", confidence: 1, issueCodes: ["PLAN_SHAPE_INVALID"] };
    }
    if (!input.candidatePlan.planId.trim() || input.candidatePlan.segments.length === 0) {
      return { agentId: this.agentId, role: this.role, candidateArmId: input.candidateArmId, verdict: "REJECT", confidence: 1, issueCodes: ["PLAN_EMPTY"] };
    }
    return { agentId: this.agentId, role: this.role, candidateArmId: input.candidateArmId, verdict: "ACCEPT", confidence: 1, issueCodes: ["NONE"] };
  }
}

export interface ReasoningEvaluationInput {
  readonly reasoningId: string;
  readonly interactionId: string;
  readonly attempt: number;
  readonly candidateArmId: string;
  readonly candidatePlan: GuardrailResponsePlan;
  readonly remainingArmIds: readonly string[];
  readonly evidence: ReasoningEvidenceSnapshot;
}

export class BoundedMultiAgentReasoningEngine {
  readonly scopeDigest: string;
  readonly policy: ReasoningPolicy;
  private readonly profiles = new Map<string, ReasoningCandidateProfile>();
  private readonly agents: readonly ReasoningAgentPort[];

  constructor(
    readonly scope: OntologyScope,
    policy: ReasoningPolicy,
    candidateProfiles: readonly ReasoningCandidateProfile[] = [],
    agents: readonly ReasoningAgentPort[] = [
      new IntentPlannerReasoningAgent(),
      new GuardrailCriticReasoningAgent(),
      new BoundaryVerifierReasoningAgent(),
    ],
  ) {
    verifyReasoningPolicy(policy);
    this.policy = Object.freeze({ ...policy });
    this.scopeDigest = hash("ltmscope", scope);
    if (agents.length > MAX_REASONING_AGENTS) throw new ChatbotReasoningError("POLICY_VIOLATION", `reasoning agent count exceeds hard cap ${MAX_REASONING_AGENTS}`);
    if (agents.length < this.policy.minAcceptVotes) throw new ChatbotReasoningError("INVALID_INPUT", "reasoning agent count is below minAcceptVotes");
    const agentIds = new Set<string>();
    for (const agent of agents) {
      const agentId = normalizeIdentifier(agent.agentId, "agentId");
      if (agent.agentId !== agentId) throw new ChatbotReasoningError("INVALID_INPUT", `reasoning agent ${agent.agentId} must use a canonical agentId`);
      if (agentIds.has(agentId)) throw new ChatbotReasoningError("INVALID_INPUT", `duplicate reasoning agent ${agentId}`);
      agentIds.add(agentId);
      if (!REASONING_AGENT_ROLES.includes(agent.role)) throw new ChatbotReasoningError("INVALID_INPUT", `reasoning agent ${agentId} has invalid role`);
    }
    this.agents = Object.freeze([...agents]);
    for (const raw of candidateProfiles) {
      const armId = normalizeIdentifier(raw.armId, "armId");
      if (this.profiles.has(armId)) throw new ChatbotReasoningError("INVALID_INPUT", `duplicate reasoning candidate profile ${armId}`);
      const tags = raw.intentTags ?? [];
      if (tags.length > this.policy.maxIntentTagsPerCandidate) throw new ChatbotReasoningError("POLICY_VIOLATION", `candidate ${armId} exceeds intent tag limit`);
      const normalizedTags = tags.map((tag) => {
        const normalized = normalizeText(tag);
        if (!normalized || normalized.length > this.policy.maxIntentTagChars) throw new ChatbotReasoningError("INVALID_INPUT", `candidate ${armId} has invalid intent tag`);
        return normalized;
      });
      this.profiles.set(armId, Object.freeze({ armId, intentTags: Object.freeze([...new Set(normalizedTags)]) }));
    }
  }

  async evaluate(raw: ReasoningEvaluationInput): Promise<ReasoningEvaluationResult> {
    verifyReasoningPolicy(this.policy);
    const reasoningId = normalizeIdentifier(raw.reasoningId, "reasoningId");
    const interactionId = normalizeIdentifier(raw.interactionId, "interactionId");
    const candidateArmId = normalizeIdentifier(raw.candidateArmId, "candidateArmId");
    if (!Number.isInteger(raw.attempt) || raw.attempt < 1 || raw.attempt > this.policy.maxRepairAttempts + 1) {
      throw new ChatbotReasoningError("INVALID_INPUT", "reasoning attempt is outside policy bounds");
    }
    if (!raw.evidence.userMessage.trim() || raw.evidence.userMessage.length > this.policy.maxInputChars) {
      throw new ChatbotReasoningError("POLICY_VIOLATION", "reasoning input exceeds configured message budget");
    }
    if (raw.evidence.memoryAuthority !== "PERSONALIZATION_ONLY") {
      throw new ChatbotReasoningError("INTEGRITY_FAILURE", "reasoning memory authority boundary is invalid");
    }
    const remainingArmIds = Object.freeze([...new Set(raw.remainingArmIds.map((id) => normalizeIdentifier(id, "remainingArmId")))].sort());
    if (!remainingArmIds.includes(candidateArmId)) throw new ChatbotReasoningError("INTEGRITY_FAILURE", "selected reasoning candidate is absent from remaining arms");
    const baseInput: Omit<ReasoningAgentInput, "signal"> = Object.freeze({
      reasoningId,
      interactionId,
      attempt: raw.attempt,
      scope: this.scope,
      scopeDigest: this.scopeDigest,
      candidateArmId,
      candidatePlan: raw.candidatePlan,
      candidateProfile: this.profiles.get(candidateArmId),
      remainingArmIds,
      evidence: raw.evidence,
    });

    const results = await Promise.all(this.agents.map(async (agent) => {
      try {
        return { assessment: await invokeAgent(agent, baseInput, this.policy.agentTimeoutMs), failed: false } as const;
      } catch (error) {
        const issue: ReasoningIssueCode = error instanceof ReasoningAgentTimeoutError
          ? "AGENT_TIMEOUT"
          : error instanceof ChatbotReasoningError && error.code === "INTEGRITY_FAILURE"
            ? "INVALID_AGENT_OUTPUT"
            : "AGENT_FAILURE";
        return {
          assessment: freezeAssessment({
            agentId: agent.agentId,
            role: agent.role,
            candidateArmId,
            verdict: "UNCERTAIN",
            confidence: 0,
            issueCodes: [issue],
          }),
          failed: true,
        } as const;
      }
    }));
    const failures = results.filter((item) => item.failed).length;
    const assessments = results.map((item) => item.assessment);
    if (failures > this.policy.maxAgentFailures) {
      throw new ChatbotReasoningError("AGENT_FAILURE_BUDGET_EXCEEDED", "reasoning agent failure budget exceeded");
    }
    const acceptVotes = assessments.filter((item) => item.verdict === "ACCEPT").length;
    const rejectVotes = assessments.filter((item) => item.verdict === "REJECT").length;
    const uncertainVotes = assessments.length - acceptVotes - rejectVotes;
    const meanConfidence = assessments.reduce((sum, item) => sum + item.confidence, 0) / assessments.length;
    const accepted = rejectVotes === 0 && acceptVotes >= this.policy.minAcceptVotes && meanConfidence >= this.policy.minMeanConfidence;
    const verdict = accepted ? "ACCEPT" : rejectVotes > 0 ? "REJECT" : "UNCERTAIN";
    const issueCodes = [...new Set(assessments.flatMap((item) => item.issueCodes).filter((code) => code !== "NONE"))];
    const normalizedIssues: ReasoningIssueCode[] = issueCodes.length ? issueCodes : ["NONE"];
    const core = {
      attempt: raw.attempt,
      candidateArmId,
      candidatePlanId: raw.candidatePlan.planId,
      verdict,
      acceptVotes,
      rejectVotes,
      uncertainVotes,
      meanConfidence,
      issueCodes: Object.freeze(normalizedIssues),
      assessments: Object.freeze(assessments),
    };
    const attempt: ReasoningAttemptRecord = Object.freeze({ ...core, digest: hash("reasoning-attempt", core) });
    return Object.freeze({ accepted, attempt });
  }
}
