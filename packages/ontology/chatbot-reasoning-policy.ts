import { hash, normalizeIdentifier } from "./chatbot-knowledge-types.js";
import { ChatbotReasoningError, type ReasoningPolicy } from "./chatbot-reasoning-types.js";

function integer(value: number, name: string, min: number, max: number): number {
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new ChatbotReasoningError("INVALID_INPUT", `${name} must be an integer from ${min} to ${max}`);
  }
  return value;
}

function finite(value: number, name: string, min: number, max: number): number {
  if (!Number.isFinite(value) || value < min || value > max) {
    throw new ChatbotReasoningError("INVALID_INPUT", `${name} must be a finite number from ${min} to ${max}`);
  }
  return value;
}

export function finalizeReasoningPolicy(input: Omit<ReasoningPolicy, "digest">): ReasoningPolicy {
  const policyId = normalizeIdentifier(input.policyId, "policyId");
  const version = input.version.trim();
  if (!version) throw new ChatbotReasoningError("INVALID_INPUT", "version must be non-empty");
  const core = {
    policyId,
    version,
    maxInputChars: integer(input.maxInputChars, "maxInputChars", 1, 32_000),
    agentTimeoutMs: integer(input.agentTimeoutMs, "agentTimeoutMs", 10, 30_000),
    maxRepairAttempts: integer(input.maxRepairAttempts, "maxRepairAttempts", 0, 16),
    minAcceptVotes: integer(input.minAcceptVotes, "minAcceptVotes", 1, 16),
    minMeanConfidence: finite(input.minMeanConfidence, "minMeanConfidence", 0, 1),
    maxAgentFailures: integer(input.maxAgentFailures, "maxAgentFailures", 0, 16),
    maxIntentTagsPerCandidate: integer(input.maxIntentTagsPerCandidate, "maxIntentTagsPerCandidate", 0, 64),
    maxIntentTagChars: integer(input.maxIntentTagChars, "maxIntentTagChars", 1, 128),
  };
  return Object.freeze({ ...core, digest: hash("reasoning-policy", core) });
}

export function verifyReasoningPolicy(policy: ReasoningPolicy): void {
  const canonical = finalizeReasoningPolicy({
    policyId: policy.policyId,
    version: policy.version,
    maxInputChars: policy.maxInputChars,
    agentTimeoutMs: policy.agentTimeoutMs,
    maxRepairAttempts: policy.maxRepairAttempts,
    minAcceptVotes: policy.minAcceptVotes,
    minMeanConfidence: policy.minMeanConfidence,
    maxAgentFailures: policy.maxAgentFailures,
    maxIntentTagsPerCandidate: policy.maxIntentTagsPerCandidate,
    maxIntentTagChars: policy.maxIntentTagChars,
  });
  if (canonical.digest !== policy.digest) {
    throw new ChatbotReasoningError("INTEGRITY_FAILURE", "reasoning policy digest mismatch");
  }
}

export function createDefaultReasoningPolicy(): ReasoningPolicy {
  return finalizeReasoningPolicy({
    policyId: "nexus.chatbot.deliberative-reasoning.default",
    version: "1.0.0",
    maxInputChars: 4_000,
    agentTimeoutMs: 3_000,
    maxRepairAttempts: 3,
    minAcceptVotes: 2,
    minMeanConfidence: 0.6,
    maxAgentFailures: 1,
    maxIntentTagsPerCandidate: 16,
    maxIntentTagChars: 64,
  });
}
