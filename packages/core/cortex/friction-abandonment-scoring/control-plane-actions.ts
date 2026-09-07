import type { FrictionProbabilityModel, FrictionScore, FrictionSnapshot } from "./index";

export type FrictionActionMode = "ACTIVE" | "OBSERVE_ONLY" | "KILLED";
export type FrictionRescueKind = "SHOW_HELP" | "SIMPLIFY_CHOICE" | "SURFACE_CONTACT";
export type FrictionActionReason = "KILL_SWITCH" | "OBSERVE_ONLY" | "INSUFFICIENT_EVIDENCE" | "BELOW_CONFIDENCE" | "ACTION_SELECTED";

export interface FrictionRescueProfileInput {
  readonly actionId: string;
  readonly kind: FrictionRescueKind;
  readonly label: string;
  readonly message: string;
}

export interface FrictionActionPolicyInput {
  readonly schemaVersion: 1;
  readonly policyId: string;
  readonly sourceDigest: `sha256:${string}`;
  readonly mode: FrictionActionMode;
  readonly minimumElapsedMs: number;
  readonly minimumInteractionCount: number;
  readonly minimumAbandonmentProbability: number;
  readonly minimumProbabilityMarginAboveHighRisk: number;
  readonly coarsePointerActionId: string;
  readonly finePointerActionId: string;
  readonly profiles: readonly FrictionRescueProfileInput[];
}

export interface FrictionRescueProfile extends FrictionRescueProfileInput {}
export interface FrictionActionPolicy extends Omit<FrictionActionPolicyInput, "profiles"> {
  readonly profiles: ReadonlyMap<string, FrictionRescueProfile>;
}

export interface FrictionActionDecision {
  readonly mode: FrictionActionMode;
  readonly action: FrictionRescueProfile | null;
  readonly reason: FrictionActionReason;
  readonly abandonmentProbability: number;
  readonly requiredProbability: number;
  readonly evidenceSufficient: boolean;
  readonly policyId: string;
  readonly policySourceDigest: `sha256:${string}`;
  readonly modelId: string;
  readonly modelSourceDigest: `sha256:${string}`;
}

const ID = /^[A-Za-z0-9](?:[A-Za-z0-9._:-]{0,127})$/u;
const SHA256 = /^sha256:[0-9a-f]{64}$/u;
const TEXT_MAX = 180;

function identifier(value: string, field: string): string {
  if (typeof value !== "string" || !ID.test(value.trim())) throw new Error(`${field} is malformed`);
  return value.trim();
}

function boundedInteger(value: number, field: string, min: number, max: number): number {
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new Error(`${field} must be ${min}..${max}`);
  return value;
}

function probability(value: number, field: string, max = 1): number {
  if (!Number.isFinite(value) || value < 0 || value > max) throw new Error(`${field} must be within 0..${max}`);
  return value;
}

function text(value: string, field: string): string {
  if (typeof value !== "string") throw new Error(`${field} must be a string`);
  const normalized = value.normalize("NFKC").replace(/\s+/gu, " ").trim();
  if (!normalized || [...normalized].length > TEXT_MAX) throw new Error(`${field} must contain 1..${TEXT_MAX} characters`);
  for (const character of normalized) {
    const point = character.codePointAt(0) ?? 0;
    if (point < 0x20 || point === 0x7f) throw new Error(`${field} contains a control character`);
  }
  return normalized;
}

export function parseFrictionActionPolicy(value: unknown): FrictionActionPolicy {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) throw new Error("friction action policy must be a plain object");
  const input = value as Record<string, unknown>;
  const expected = ["coarsePointerActionId", "finePointerActionId", "minimumAbandonmentProbability", "minimumElapsedMs", "minimumInteractionCount", "minimumProbabilityMarginAboveHighRisk", "mode", "policyId", "profiles", "schemaVersion", "sourceDigest"].sort().join(",");
  if (Object.keys(input).sort().join(",") !== expected) throw new Error("friction action policy has unknown or missing fields");
  if (input.schemaVersion !== 1) throw new Error("friction action policy schemaVersion must be 1");
  if (!(input.mode === "ACTIVE" || input.mode === "OBSERVE_ONLY" || input.mode === "KILLED")) throw new Error("friction action policy mode is invalid");
  if (typeof input.sourceDigest !== "string" || !SHA256.test(input.sourceDigest)) throw new Error("friction action policy sourceDigest is invalid");
  if (!Array.isArray(input.profiles) || input.profiles.length < 1 || input.profiles.length > 8) throw new Error("friction action profiles must contain 1..8 items");
  const profiles = new Map<string, FrictionRescueProfile>();
  for (const [index, raw] of input.profiles.entries()) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw) || Object.getPrototypeOf(raw) !== Object.prototype) throw new Error(`profiles[${index}] must be a plain object`);
    const profile = raw as Record<string, unknown>;
    if (Object.keys(profile).sort().join(",") !== ["actionId", "kind", "label", "message"].sort().join(",")) throw new Error(`profiles[${index}] has unknown or missing fields`);
    const actionId = identifier(profile.actionId as string, `profiles[${index}].actionId`);
    if (profiles.has(actionId)) throw new Error(`duplicate actionId ${actionId}`);
    if (!(profile.kind === "SHOW_HELP" || profile.kind === "SIMPLIFY_CHOICE" || profile.kind === "SURFACE_CONTACT")) throw new Error(`profiles[${index}].kind is invalid`);
    profiles.set(actionId, Object.freeze({ actionId, kind: profile.kind, label: text(profile.label as string, `profiles[${index}].label`), message: text(profile.message as string, `profiles[${index}].message`) }));
  }
  const coarsePointerActionId = identifier(input.coarsePointerActionId as string, "coarsePointerActionId");
  const finePointerActionId = identifier(input.finePointerActionId as string, "finePointerActionId");
  if (!profiles.has(coarsePointerActionId) || !profiles.has(finePointerActionId)) throw new Error("pointer action IDs must reference declared profiles");
  return Object.freeze({
    schemaVersion: 1,
    policyId: identifier(input.policyId as string, "policyId"),
    sourceDigest: input.sourceDigest as `sha256:${string}`,
    mode: input.mode,
    minimumElapsedMs: boundedInteger(input.minimumElapsedMs as number, "minimumElapsedMs", 5_000, 1_800_000),
    minimumInteractionCount: boundedInteger(input.minimumInteractionCount as number, "minimumInteractionCount", 1, 500),
    minimumAbandonmentProbability: probability(input.minimumAbandonmentProbability as number, "minimumAbandonmentProbability"),
    minimumProbabilityMarginAboveHighRisk: probability(input.minimumProbabilityMarginAboveHighRisk as number, "minimumProbabilityMarginAboveHighRisk", 0.5),
    coarsePointerActionId,
    finePointerActionId,
    profiles,
  });
}

export function decideFrictionControlPlaneAction(snapshot: FrictionSnapshot, score: FrictionScore, model: FrictionProbabilityModel, policy: FrictionActionPolicy): FrictionActionDecision {
  if (score.modelId !== model.modelId || score.modelSourceDigest !== model.sourceDigest || score.pointerClass !== snapshot.pointerClass) throw new Error("friction action inputs do not share one model/snapshot identity");
  const requiredProbability = Math.min(1, Math.max(policy.minimumAbandonmentProbability, model.mediumRiskMax + policy.minimumProbabilityMarginAboveHighRisk));
  const evidenceSufficient = snapshot.elapsedMs >= policy.minimumElapsedMs && snapshot.interactionCount >= policy.minimumInteractionCount;
  const base = {
    mode: policy.mode,
    abandonmentProbability: score.abandonmentProbability,
    requiredProbability,
    evidenceSufficient,
    policyId: policy.policyId,
    policySourceDigest: policy.sourceDigest,
    modelId: model.modelId,
    modelSourceDigest: model.sourceDigest,
  } as const;
  if (policy.mode === "KILLED") return Object.freeze({ ...base, action: null, reason: "KILL_SWITCH" });
  if (!evidenceSufficient) return Object.freeze({ ...base, action: null, reason: "INSUFFICIENT_EVIDENCE" });
  if (score.abandonmentProbability < requiredProbability || score.riskBand !== "HIGH") return Object.freeze({ ...base, action: null, reason: "BELOW_CONFIDENCE" });
  const actionId = score.pointerClass === "COARSE" ? policy.coarsePointerActionId : policy.finePointerActionId;
  const action = policy.profiles.get(actionId);
  if (!action) throw new Error("friction action profile disappeared after validation");
  if (policy.mode === "OBSERVE_ONLY") return Object.freeze({ ...base, action: null, reason: "OBSERVE_ONLY" });
  return Object.freeze({ ...base, action, reason: "ACTION_SELECTED" });
}
