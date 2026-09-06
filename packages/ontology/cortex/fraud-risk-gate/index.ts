import { createHmac, timingSafeEqual } from "node:crypto";

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,191}$/u;
const SHA256 = /^sha256:[0-9a-f]{64}$/u;

export interface RiskEnvelopePayload {
  readonly schemaVersion: 1;
  readonly assessmentId: string;
  readonly providerId: string;
  readonly assessedAt: string;
  readonly expiresAt: string;
  readonly riskScore: number;
  readonly networkKeyHash: string;
}

export interface SignedRiskEnvelope {
  readonly payload: RiskEnvelopePayload;
  readonly signature: `sha256=${string}`;
}

export interface RiskPolicy {
  readonly challengeAtOrAbove: number;
  readonly denyAtOrAbove: number;
  readonly maxAssessmentAgeSeconds: number;
  readonly maxFutureSkewSeconds: number;
}

export interface RiskGateDecision {
  readonly action: "ALLOW" | "CHALLENGE" | "DENY";
  readonly assessmentId: string;
  readonly providerId: string;
  readonly riskScore: number;
  readonly reason: "BELOW_CHALLENGE_THRESHOLD" | "CHALLENGE_THRESHOLD" | "DENY_THRESHOLD";
}

export class Cortex14Error extends Error {
  constructor(public readonly code: "INVALID_INPUT" | "INVALID_SIGNATURE" | "STALE_ASSESSMENT" | "POLICY_ERROR" | "NETWORK_MISMATCH", message: string) {
    super(message);
    this.name = "Cortex14Error";
  }
}

function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`;
}

function parseUtc(value: unknown, label: string): number {
  if (typeof value !== "string") throw new Cortex14Error("INVALID_INPUT", `${label} must be canonical UTC`);
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== value) throw new Cortex14Error("INVALID_INPUT", `${label} must be canonical UTC`);
  return parsed.getTime();
}

function parsePayload(value: unknown): RiskEnvelopePayload {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) throw new Cortex14Error("INVALID_INPUT", "risk payload must be a plain object");
  const raw = value as Record<string, unknown>;
  if (Object.keys(raw).sort().join(",") !== "assessedAt,assessmentId,expiresAt,networkKeyHash,providerId,riskScore,schemaVersion") throw new Cortex14Error("INVALID_INPUT", "risk payload contains missing or unsupported fields");
  if (raw.schemaVersion !== 1) throw new Cortex14Error("INVALID_INPUT", "unsupported risk schema version");
  if (typeof raw.assessmentId !== "string" || !ID.test(raw.assessmentId)) throw new Cortex14Error("INVALID_INPUT", "assessmentId is malformed");
  if (typeof raw.providerId !== "string" || !ID.test(raw.providerId)) throw new Cortex14Error("INVALID_INPUT", "providerId is malformed");
  if (typeof raw.networkKeyHash !== "string" || !SHA256.test(raw.networkKeyHash)) throw new Cortex14Error("INVALID_INPUT", "networkKeyHash must be a SHA-256 digest");
  if (typeof raw.riskScore !== "number" || !Number.isInteger(raw.riskScore) || raw.riskScore < 0 || raw.riskScore > 1_000) throw new Cortex14Error("INVALID_INPUT", "riskScore must be an integer from 0 to 1000");
  parseUtc(raw.assessedAt, "assessedAt");
  parseUtc(raw.expiresAt, "expiresAt");
  return Object.freeze(raw as unknown as RiskEnvelopePayload);
}

export function computeRiskNetworkKeyHash(networkKey: string, secret: string): `sha256:${string}` {
  if (typeof networkKey !== "string" || networkKey.length < 1 || networkKey.length > 256 || /[\r\n\0]/u.test(networkKey)) throw new Cortex14Error("INVALID_INPUT", "network key is malformed");
  if (typeof secret !== "string" || secret.length < 32 || secret.length > 4096 || /[\r\n]/u.test(secret)) throw new Cortex14Error("INVALID_INPUT", "network key secret is invalid");
  return `sha256:${createHmac("sha256", secret).update(networkKey, "utf8").digest("hex")}`;
}

export function signRiskPayload(payloadInput: unknown, secret: string): SignedRiskEnvelope {
  if (secret.length < 32) throw new Cortex14Error("INVALID_INPUT", "signing secret must contain at least 32 characters");
  const payload = parsePayload(payloadInput);
  const signature = createHmac("sha256", secret).update(canonical(payload), "utf8").digest("hex");
  return Object.freeze({ payload, signature: `sha256=${signature}` as const });
}

function verifySignature(envelope: SignedRiskEnvelope, secret: string): void {
  if (secret.length < 32 || typeof envelope.signature !== "string" || !/^sha256=[0-9a-f]{64}$/u.test(envelope.signature)) throw new Cortex14Error("INVALID_SIGNATURE", "risk signature is malformed");
  const expected = Buffer.from(createHmac("sha256", secret).update(canonical(envelope.payload), "utf8").digest("hex"), "utf8");
  const provided = Buffer.from(envelope.signature.slice(7), "utf8");
  if (expected.length !== provided.length || !timingSafeEqual(expected, provided)) throw new Cortex14Error("INVALID_SIGNATURE", "risk signature mismatch");
}

function parsePolicy(value: unknown): RiskPolicy {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) throw new Cortex14Error("POLICY_ERROR", "risk policy must be a plain object");
  const raw = value as Record<string, unknown>;
  if (Object.keys(raw).sort().join(",") !== "challengeAtOrAbove,denyAtOrAbove,maxAssessmentAgeSeconds,maxFutureSkewSeconds") throw new Cortex14Error("POLICY_ERROR", "risk policy contract contains missing or unsupported fields");
  const ints = [raw.challengeAtOrAbove, raw.denyAtOrAbove, raw.maxAssessmentAgeSeconds, raw.maxFutureSkewSeconds];
  if (!ints.every((item) => typeof item === "number" && Number.isInteger(item))) throw new Cortex14Error("POLICY_ERROR", "risk policy values must be integers");
  const challenge = raw.challengeAtOrAbove as number;
  const deny = raw.denyAtOrAbove as number;
  const maxAge = raw.maxAssessmentAgeSeconds as number;
  const skew = raw.maxFutureSkewSeconds as number;
  if (challenge < 0 || challenge > 1_000 || deny < challenge || deny > 1_000 || maxAge < 1 || maxAge > 86_400 || skew < 0 || skew > 300) throw new Cortex14Error("POLICY_ERROR", "risk policy values are out of range");
  return Object.freeze({ challengeAtOrAbove: challenge, denyAtOrAbove: deny, maxAssessmentAgeSeconds: maxAge, maxFutureSkewSeconds: skew });
}

function parseAndVerifyEnvelope(envelopeInput: unknown, secret: string, policyInput: unknown, nowMs: number): { payload: RiskEnvelopePayload; policy: RiskPolicy } {
  if (!envelopeInput || typeof envelopeInput !== "object" || Array.isArray(envelopeInput) || Object.getPrototypeOf(envelopeInput) !== Object.prototype) throw new Cortex14Error("INVALID_INPUT", "signed risk envelope must be a plain object");
  const raw = envelopeInput as Record<string, unknown>;
  if (Object.keys(raw).sort().join(",") !== "payload,signature") throw new Cortex14Error("INVALID_INPUT", "signed risk envelope contract is invalid");
  const payload = parsePayload(raw.payload);
  const envelope = { payload, signature: raw.signature } as SignedRiskEnvelope;
  verifySignature(envelope, secret);
  const policy = parsePolicy(policyInput);
  if (!Number.isFinite(nowMs)) throw new Cortex14Error("INVALID_INPUT", "nowMs is invalid");
  const assessedAt = parseUtc(payload.assessedAt, "assessedAt");
  const expiresAt = parseUtc(payload.expiresAt, "expiresAt");
  if (expiresAt <= assessedAt || nowMs > expiresAt || nowMs - assessedAt > policy.maxAssessmentAgeSeconds * 1_000 || assessedAt - nowMs > policy.maxFutureSkewSeconds * 1_000) throw new Cortex14Error("STALE_ASSESSMENT", "risk assessment is stale, expired, or from the future");
  return { payload, policy };
}

function decisionFor(payload: RiskEnvelopePayload, policy: RiskPolicy): RiskGateDecision {
  if (payload.riskScore >= policy.denyAtOrAbove) return Object.freeze({ action: "DENY", assessmentId: payload.assessmentId, providerId: payload.providerId, riskScore: payload.riskScore, reason: "DENY_THRESHOLD" });
  if (payload.riskScore >= policy.challengeAtOrAbove) return Object.freeze({ action: "CHALLENGE", assessmentId: payload.assessmentId, providerId: payload.providerId, riskScore: payload.riskScore, reason: "CHALLENGE_THRESHOLD" });
  return Object.freeze({ action: "ALLOW", assessmentId: payload.assessmentId, providerId: payload.providerId, riskScore: payload.riskScore, reason: "BELOW_CHALLENGE_THRESHOLD" });
}

export function evaluateSignedRiskEnvelope(envelopeInput: unknown, secret: string, policyInput: unknown, nowMs = Date.now()): RiskGateDecision {
  const { payload, policy } = parseAndVerifyEnvelope(envelopeInput, secret, policyInput, nowMs);
  return decisionFor(payload, policy);
}

export function evaluateSignedRiskEnvelopeForNetwork(envelopeInput: unknown, secret: string, policyInput: unknown, expectedNetworkKeyHash: string, nowMs = Date.now()): RiskGateDecision {
  if (typeof expectedNetworkKeyHash !== "string" || !SHA256.test(expectedNetworkKeyHash)) throw new Cortex14Error("INVALID_INPUT", "expected network key hash is invalid");
  const { payload, policy } = parseAndVerifyEnvelope(envelopeInput, secret, policyInput, nowMs);
  const expected = Buffer.from(expectedNetworkKeyHash, "utf8");
  const supplied = Buffer.from(payload.networkKeyHash, "utf8");
  if (expected.length !== supplied.length || !timingSafeEqual(expected, supplied)) throw new Cortex14Error("NETWORK_MISMATCH", "risk assessment is bound to a different request network key");
  return decisionFor(payload, policy);
}
