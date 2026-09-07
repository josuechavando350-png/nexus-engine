import { createHmac, timingSafeEqual } from "node:crypto";
import { Cortex14Error, evaluateSignedRiskEnvelopeForNetwork, type RiskGateDecision, type RiskPolicy, type SignedRiskEnvelope } from "./index";

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,191}$/u;
const SHA256 = /^sha256:[0-9a-f]{64}$/u;

export type CompositeRiskFamily = "NETWORK" | "AUTOMATION" | "VELOCITY" | "INTEGRITY" | "BEHAVIORAL";
export type NetworkContextClass = "DEDICATED" | "SHARED_OR_NAT" | "CORPORATE" | "UNKNOWN";

export interface CompositeRiskProviderPolicy {
  readonly providerId: string;
  readonly family: CompositeRiskFamily;
  readonly weight: number;
}

export interface CompositeRiskPolicy {
  readonly version: 1;
  readonly challengeAtOrAbove: number;
  readonly denyAtOrAbove: number;
  readonly minFamiliesForChallenge: number;
  readonly minFamiliesForDeny: number;
  readonly minPresentFamilies: number;
  readonly highFamilyAtOrAbove: number;
  readonly sharedNetworkWeightMultiplier: number;
  readonly baseEnvelopePolicy: RiskPolicy;
  readonly providers: readonly CompositeRiskProviderPolicy[];
}

export interface SignedNetworkContextPayload {
  readonly schemaVersion: 1;
  readonly providerId: string;
  readonly assessedAt: string;
  readonly expiresAt: string;
  readonly networkKeyHash: string;
  readonly networkClass: NetworkContextClass;
}

export interface SignedNetworkContextEnvelope {
  readonly payload: SignedNetworkContextPayload;
  readonly signature: `sha256=${string}`;
}

export interface CompositeRiskInput {
  readonly version: 1;
  readonly signals: readonly SignedRiskEnvelope[];
  readonly networkContext: SignedNetworkContextEnvelope;
}

export interface CompositeRiskDecision extends RiskGateDecision {
  readonly compositeScore: number;
  readonly presentFamilies: readonly CompositeRiskFamily[];
  readonly highRiskFamilies: readonly CompositeRiskFamily[];
  readonly networkClass: NetworkContextClass;
  readonly networkContributionAttenuated: boolean;
  readonly reason: "COMPOSITE_ALLOW" | "COMPOSITE_CHALLENGE" | "COMPOSITE_DENY" | "INSUFFICIENT_INDEPENDENT_EVIDENCE";
}

export interface CompositeRiskSecrets {
  readonly providerSecrets: Readonly<Record<string, string>>;
  readonly networkContextSecret: string;
}

export class CompositeRiskError extends Error {
  constructor(public readonly code: "INVALID_CONFIG" | "INVALID_INPUT" | "INTEGRITY_FAILURE" | "INSUFFICIENT_EVIDENCE", message: string) {
    super(message);
    this.name = "CompositeRiskError";
  }
}

function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`;
}
function safeSecret(value: string, label: string): string {
  if (typeof value !== "string" || value.length < 32 || value.length > 4096 || /[\r\n\0]/u.test(value)) throw new CompositeRiskError("INVALID_CONFIG", `${label} is invalid`);
  return value;
}
function id(value: string, label: string): string {
  if (typeof value !== "string" || !ID.test(value)) throw new CompositeRiskError("INVALID_CONFIG", `${label} is malformed`);
  return value;
}
function ratio(value: number, label: string, min = 0, max = 1): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max) throw new CompositeRiskError("INVALID_CONFIG", `${label} is out of range`);
  return value;
}
function integer(value: number, label: string, min: number, max: number): number {
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new CompositeRiskError("INVALID_CONFIG", `${label} is out of range`);
  return value;
}
function parseUtc(value: unknown, label: string): number {
  if (typeof value !== "string") throw new CompositeRiskError("INVALID_INPUT", `${label} must be canonical UTC`);
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== value) throw new CompositeRiskError("INVALID_INPUT", `${label} must be canonical UTC`);
  return parsed.getTime();
}
function equal(left: string, right: string): boolean {
  const a = Buffer.from(left, "utf8"); const b = Buffer.from(right, "utf8"); return a.length === b.length && timingSafeEqual(a, b);
}

export function createCompositeRiskPolicy(input: CompositeRiskPolicy): CompositeRiskPolicy {
  if (input.version !== 1) throw new CompositeRiskError("INVALID_CONFIG", "composite risk policy version must be 1");
  const challengeAtOrAbove = integer(input.challengeAtOrAbove, "challengeAtOrAbove", 0, 1000);
  const denyAtOrAbove = integer(input.denyAtOrAbove, "denyAtOrAbove", challengeAtOrAbove, 1000);
  const highFamilyAtOrAbove = integer(input.highFamilyAtOrAbove, "highFamilyAtOrAbove", 1, 1000);
  const minPresentFamilies = integer(input.minPresentFamilies, "minPresentFamilies", 2, 5);
  const minFamiliesForChallenge = integer(input.minFamiliesForChallenge, "minFamiliesForChallenge", 2, 5);
  const minFamiliesForDeny = integer(input.minFamiliesForDeny, "minFamiliesForDeny", Math.max(2, minFamiliesForChallenge), 5);
  if (minFamiliesForChallenge < minPresentFamilies) throw new CompositeRiskError("INVALID_CONFIG", "minFamiliesForChallenge cannot be lower than minPresentFamilies");
  const sharedNetworkWeightMultiplier = ratio(input.sharedNetworkWeightMultiplier, "sharedNetworkWeightMultiplier", 0, 0.5);
  if (!Array.isArray(input.providers) || input.providers.length < minPresentFamilies || input.providers.length > 32) throw new CompositeRiskError("INVALID_CONFIG", "providers count is outside policy");
  const seen = new Set<string>();
  const providers = input.providers.map((provider, index) => {
    const providerId = id(provider.providerId, `providers[${index}].providerId`);
    if (seen.has(providerId)) throw new CompositeRiskError("INVALID_CONFIG", `duplicate providerId ${providerId}`);
    seen.add(providerId);
    if (!(provider.family === "NETWORK" || provider.family === "AUTOMATION" || provider.family === "VELOCITY" || provider.family === "INTEGRITY" || provider.family === "BEHAVIORAL")) throw new CompositeRiskError("INVALID_CONFIG", `providers[${index}].family is invalid`);
    return Object.freeze({ providerId, family: provider.family, weight: ratio(provider.weight, `providers[${index}].weight`, 0.01, 1) });
  });
  return Object.freeze({ version: 1, challengeAtOrAbove, denyAtOrAbove, minFamiliesForChallenge, minFamiliesForDeny, minPresentFamilies, highFamilyAtOrAbove, sharedNetworkWeightMultiplier, baseEnvelopePolicy: input.baseEnvelopePolicy, providers: Object.freeze(providers) });
}

export function signNetworkContext(payload: SignedNetworkContextPayload, secret: string): SignedNetworkContextEnvelope {
  safeSecret(secret, "network context secret");
  const signature = createHmac("sha256", secret).update(canonical(payload), "utf8").digest("hex");
  return Object.freeze({ payload, signature: `sha256=${signature}` });
}

function verifyNetworkContext(value: SignedNetworkContextEnvelope, secret: string, expectedNetworkKeyHash: string, policy: RiskPolicy, nowMs: number): SignedNetworkContextPayload {
  safeSecret(secret, "network context secret");
  if (!value || typeof value !== "object" || Array.isArray(value) || !value.payload || typeof value.signature !== "string" || !/^sha256=[0-9a-f]{64}$/u.test(value.signature)) throw new CompositeRiskError("INVALID_INPUT", "network context envelope is invalid");
  const payload = value.payload;
  if (payload.schemaVersion !== 1 || !ID.test(payload.providerId) || !SHA256.test(payload.networkKeyHash) || !(payload.networkClass === "DEDICATED" || payload.networkClass === "SHARED_OR_NAT" || payload.networkClass === "CORPORATE" || payload.networkClass === "UNKNOWN")) throw new CompositeRiskError("INVALID_INPUT", "network context payload is invalid");
  const expectedSig = `sha256=${createHmac("sha256", secret).update(canonical(payload), "utf8").digest("hex")}`;
  if (!equal(expectedSig, value.signature)) throw new CompositeRiskError("INTEGRITY_FAILURE", "network context signature mismatch");
  if (!equal(payload.networkKeyHash, expectedNetworkKeyHash)) throw new CompositeRiskError("INTEGRITY_FAILURE", "network context is bound to another network");
  const assessedAt = parseUtc(payload.assessedAt, "networkContext.assessedAt");
  const expiresAt = parseUtc(payload.expiresAt, "networkContext.expiresAt");
  if (expiresAt <= assessedAt || nowMs > expiresAt || nowMs - assessedAt > policy.maxAssessmentAgeSeconds * 1000 || assessedAt - nowMs > policy.maxFutureSkewSeconds * 1000) throw new CompositeRiskError("INVALID_INPUT", "network context is stale, expired or future-dated");
  return payload;
}

export function evaluateCompositeRisk(
  input: CompositeRiskInput,
  policyInput: CompositeRiskPolicy,
  secrets: CompositeRiskSecrets,
  expectedNetworkKeyHash: string,
  nowMs = Date.now(),
): CompositeRiskDecision {
  const policy = createCompositeRiskPolicy(policyInput);
  if (!input || input.version !== 1 || !Array.isArray(input.signals) || input.signals.length < policy.minPresentFamilies || input.signals.length > policy.providers.length) throw new CompositeRiskError("INVALID_INPUT", "composite signal set is invalid");
  if (!SHA256.test(expectedNetworkKeyHash)) throw new CompositeRiskError("INVALID_INPUT", "expectedNetworkKeyHash is invalid");
  const context = verifyNetworkContext(input.networkContext, secrets.networkContextSecret, expectedNetworkKeyHash, policy.baseEnvelopePolicy, nowMs);
  const providerById = new Map(policy.providers.map((provider) => [provider.providerId, provider] as const));
  const seenProviders = new Set<string>();
  const familyScores = new Map<CompositeRiskFamily, { score: number; weight: number }>();
  let assessmentId = "";
  for (const envelope of input.signals) {
    const providerId = envelope?.payload?.providerId;
    if (typeof providerId !== "string" || seenProviders.has(providerId)) throw new CompositeRiskError("INVALID_INPUT", "composite signals contain duplicate or malformed providerId");
    seenProviders.add(providerId);
    const provider = providerById.get(providerId);
    const secret = secrets.providerSecrets[providerId];
    if (!provider || !secret) throw new CompositeRiskError("INVALID_CONFIG", `provider ${providerId} is not configured with a secret`);
    const verified = evaluateSignedRiskEnvelopeForNetwork(envelope, safeSecret(secret, `provider ${providerId} secret`), policy.baseEnvelopePolicy, expectedNetworkKeyHash, nowMs);
    if (!assessmentId || verified.assessmentId < assessmentId) assessmentId = verified.assessmentId;
    const multiplier = provider.family === "NETWORK" && (context.networkClass === "SHARED_OR_NAT" || context.networkClass === "CORPORATE") ? policy.sharedNetworkWeightMultiplier : 1;
    const weightedScore = verified.riskScore * multiplier;
    const existing = familyScores.get(provider.family);
    // Same-family signals never stack. Retain the strongest weighted evidence only.
    if (!existing || weightedScore > existing.score) familyScores.set(provider.family, { score: weightedScore, weight: provider.weight });
  }
  const presentFamilies = [...familyScores.keys()].sort() as CompositeRiskFamily[];
  if (presentFamilies.length < policy.minPresentFamilies) throw new CompositeRiskError("INSUFFICIENT_EVIDENCE", "not enough independent risk families are present");
  let numerator = 0; let denominator = 0;
  for (const family of presentFamilies) { const item = familyScores.get(family)!; numerator += item.score * item.weight; denominator += item.weight; }
  const compositeScore = Math.max(0, Math.min(1000, Math.round(numerator / denominator)));
  const highRiskFamilies = presentFamilies.filter((family) => familyScores.get(family)!.score >= policy.highFamilyAtOrAbove);
  const sharedNetwork = context.networkClass === "SHARED_OR_NAT" || context.networkClass === "CORPORATE";
  const independentHighFamilies = highRiskFamilies.filter((family) => !(sharedNetwork && family === "NETWORK"));
  let action: RiskGateDecision["action"] = "ALLOW";
  let reason: CompositeRiskDecision["reason"] = "COMPOSITE_ALLOW";
  if (compositeScore >= policy.denyAtOrAbove && independentHighFamilies.length >= policy.minFamiliesForDeny) { action = "DENY"; reason = "COMPOSITE_DENY"; }
  else if (compositeScore >= policy.challengeAtOrAbove && independentHighFamilies.length >= policy.minFamiliesForChallenge) { action = "CHALLENGE"; reason = "COMPOSITE_CHALLENGE"; }
  else if (compositeScore >= policy.challengeAtOrAbove) reason = "INSUFFICIENT_INDEPENDENT_EVIDENCE";
  return Object.freeze({ action, assessmentId, providerId: "cortex-composite-risk-v1", riskScore: compositeScore, compositeScore, reason, presentFamilies: Object.freeze(presentFamilies), highRiskFamilies: Object.freeze(highRiskFamilies), networkClass: context.networkClass, networkContributionAttenuated: sharedNetwork });
}
