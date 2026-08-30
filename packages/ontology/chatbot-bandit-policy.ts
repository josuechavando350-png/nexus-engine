import { hash, normalizeIdentifier } from "./chatbot-knowledge-types.js";
import { ContextualBanditError, type ContextualBanditPolicy } from "./chatbot-bandit-types.js";

const DAY = 24 * 60 * 60 * 1000;

function finite(value: number, name: string, min: number, max: number): number {
  if (!Number.isFinite(value) || value < min || value > max) {
    throw new ContextualBanditError("INVALID_INPUT", `${name} must be a finite number from ${min} to ${max}`);
  }
  return value;
}

function integer(value: number, name: string, min: number, max: number): number {
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new ContextualBanditError("INVALID_INPUT", `${name} must be an integer from ${min} to ${max}`);
  }
  return value;
}

export function finalizeContextualBanditPolicy(input: Omit<ContextualBanditPolicy, "digest">): ContextualBanditPolicy {
  const policyId = normalizeIdentifier(input.policyId, "policyId");
  const version = input.version.trim();
  if (!version) throw new ContextualBanditError("INVALID_INPUT", "version must be non-empty");
  const keys = [...new Set(input.allowedContextKeys.map((key) => normalizeIdentifier(key, "allowedContextKey")))].sort();
  if (keys.length === 0) throw new ContextualBanditError("INVALID_INPUT", "allowedContextKeys must not be empty");
  const core = {
    policyId,
    version,
    explorationWeight: finite(input.explorationWeight, "explorationWeight", 0, 10),
    minimumSamplesPerArm: integer(input.minimumSamplesPerArm, "minimumSamplesPerArm", 1, 10_000),
    maxArms: integer(input.maxArms, "maxArms", 1, 100),
    maxContextFeatures: integer(input.maxContextFeatures, "maxContextFeatures", 1, 64),
    maxRewardDelayMs: integer(input.maxRewardDelayMs, "maxRewardDelayMs", 1_000, 365 * DAY),
    allowedContextKeys: Object.freeze(keys),
  };
  if (core.allowedContextKeys.length > core.maxContextFeatures) {
    throw new ContextualBanditError("INVALID_INPUT", "allowedContextKeys exceeds maxContextFeatures");
  }
  return Object.freeze({ ...core, digest: hash("cbpolicy", core) });
}

export function createDefaultContextualBanditPolicy(): ContextualBanditPolicy {
  return finalizeContextualBanditPolicy({
    policyId: "nexus.chatbot.contextual-bandit.default",
    version: "1.0.0",
    explorationWeight: 1.25,
    minimumSamplesPerArm: 3,
    maxArms: 16,
    maxContextFeatures: 8,
    maxRewardDelayMs: 30 * DAY,
    allowedContextKeys: ["intent", "channel", "journey-stage", "locale", "returning-customer"],
  });
}
