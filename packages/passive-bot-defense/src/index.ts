import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { isIP } from "node:net";

const MAX_PATH = 2_000;
const MAX_KEY_ID = 128;
const MAX_ENCODED_BYTES = 64 * 1024;
const MAX_TTL_MS = 60_000;
const MAX_CLOCK_SKEW_MS = 5_000;

function canonical(value: unknown): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("non-finite number");
    return Object.is(value, -0) ? 0 : value;
  }
  if (Array.isArray(value)) return value.map(canonical);
  if (typeof value === "object") {
    const proto = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) throw new Error("non-plain object");
    const out: Record<string, unknown> = Object.create(null);
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      const item = (value as Record<string, unknown>)[key];
      if (item === undefined) throw new Error(`undefined at ${key}`);
      out[key] = canonical(item);
    }
    return out;
  }
  throw new Error(`unsupported canonical value ${typeof value}`);
}

export function digestValue(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");
}

function clean(label: string, value: string, max: number): string {
  if (typeof value !== "string") throw new Error(`${label} must be a string`);
  const result = value.trim();
  if (!result) throw new Error(`${label} must not be empty`);
  if (result.length > max) throw new Error(`${label} exceeds ${max} characters`);
  if (/[\r\n\0]/u.test(result)) throw new Error(`${label} contains control characters`);
  return result;
}

function timestamp(label: string, value: string): string {
  const parsed = Date.parse(clean(label, value, 100));
  if (!Number.isFinite(parsed)) throw new Error(`${label} must be a timestamp`);
  return new Date(parsed).toISOString();
}

function boundedRatio(label: string, value: number | null): number | null {
  if (value === null) return null;
  if (!Number.isFinite(value) || value < 0 || value > 1) throw new Error(`${label} must be between 0 and 1`);
  return value;
}

function boundedBotScore(value: number | null): number | null {
  if (value === null) return null;
  if (!Number.isFinite(value) || value < 0 || value > 100) throw new Error("botScore must be between 0 and 100");
  return value;
}

export type PassiveProvider = "CLOUDFLARE" | "AWS_WAF" | "SIGNED_EDGE" | "CONTROLLED_TEST";
export type SignalTrust = "RUNTIME_BOUNDARY" | "HMAC_VERIFIED" | "CONTROLLED_TEST";
export type Action = "ALLOW" | "OBSERVE" | "RATE_LIMIT" | "DENY";
export type RiskFamily = "PROVIDER_SCORE" | "PROVIDER_HEURISTIC" | "BEHAVIOR" | "CURATED_REPUTATION";

const PROVIDERS = new Set<PassiveProvider>(["CLOUDFLARE", "AWS_WAF", "SIGNED_EDGE", "CONTROLLED_TEST"]);
const TRUST = new Set<SignalTrust>(["RUNTIME_BOUNDARY", "HMAC_VERIFIED", "CONTROLLED_TEST"]);

export function normalizeJa3(value: string | null | undefined): string | null {
  if (value == null || value.trim() === "") return null;
  const normalized = value.toLowerCase().trim();
  if (!/^[a-f0-9]{32}$/u.test(normalized)) throw new Error("invalid JA3 fingerprint");
  return normalized;
}

export function normalizeJa4(value: string | null | undefined): string | null {
  if (value == null || value.trim() === "") return null;
  const normalized = value.toLowerCase().trim();
  if (!/^[a-z0-9]{10}_[a-f0-9]{12}_[a-f0-9]{12}$/u.test(normalized)) throw new Error("invalid JA4 fingerprint");
  return normalized;
}

export interface PassiveSignalInput {
  provider: PassiveProvider;
  trust: SignalTrust;
  observedAt: string;
  method: string;
  path: string;
  ja3?: string | null;
  ja4?: string | null;
  botScore?: number | null;
  verifiedBot?: boolean;
  signedAgent?: boolean;
  heuristicRatio?: number | null;
  browserRatio?: number | null;
  requestQuantile?: number | null;
  curatedReputationMatch?: boolean;
}

export interface PassiveSignal {
  provider: PassiveProvider;
  trust: SignalTrust;
  observedAt: string;
  method: string;
  path: string;
  ja3: string | null;
  ja4: string | null;
  botScore: number | null;
  verifiedBot: boolean;
  signedAgent: boolean;
  heuristicRatio: number | null;
  browserRatio: number | null;
  requestQuantile: number | null;
  curatedReputationMatch: boolean;
  signalDigest: string;
}

function signalCore(input: PassiveSignalInput) {
  if (!PROVIDERS.has(input.provider)) throw new Error("unknown provider");
  if (!TRUST.has(input.trust)) throw new Error("unknown signal trust");
  if (input.provider === "SIGNED_EDGE" && input.trust !== "HMAC_VERIFIED") throw new Error("signed edge signals require HMAC_VERIFIED trust");
  if (input.provider === "CONTROLLED_TEST" && input.trust !== "CONTROLLED_TEST") throw new Error("controlled test provider requires CONTROLLED_TEST trust");
  if (input.provider !== "CONTROLLED_TEST" && input.trust === "CONTROLLED_TEST") throw new Error("CONTROLLED_TEST trust is not runtime authority");
  const method = clean("method", input.method, 32).toUpperCase();
  if (!/^[A-Z]+$/u.test(method)) throw new Error("invalid HTTP method");
  const path = clean("path", input.path, MAX_PATH);
  if (!path.startsWith("/")) throw new Error("path must be origin-relative");
  const ja3 = normalizeJa3(input.ja3);
  const ja4 = normalizeJa4(input.ja4);
  if ((ja3 !== null || ja4 !== null) && input.trust !== "RUNTIME_BOUNDARY" && input.trust !== "HMAC_VERIFIED" && input.trust !== "CONTROLLED_TEST") {
    throw new Error("TLS fingerprints require trusted edge authority");
  }
  return {
    provider: input.provider,
    trust: input.trust,
    observedAt: timestamp("observedAt", input.observedAt),
    method,
    path,
    ja3,
    ja4,
    botScore: boundedBotScore(input.botScore ?? null),
    verifiedBot: input.verifiedBot === true,
    signedAgent: input.signedAgent === true,
    heuristicRatio: boundedRatio("heuristicRatio", input.heuristicRatio ?? null),
    browserRatio: boundedRatio("browserRatio", input.browserRatio ?? null),
    requestQuantile: boundedRatio("requestQuantile", input.requestQuantile ?? null),
    curatedReputationMatch: input.curatedReputationMatch === true,
  } as const;
}

export function createSignal(input: PassiveSignalInput): PassiveSignal {
  const core = signalCore(input);
  return Object.freeze({ ...core, signalDigest: digestValue(core) });
}

export function validateSignal(signal: PassiveSignal): void {
  if (!signal || typeof signal !== "object") throw new Error("signal required");
  const core = signalCore(signal);
  if (signal.signalDigest !== digestValue(core)) throw new Error("signal digest mismatch");
}

export function subjectToken(sourceIp: string, ja4: string | null, epoch: string, secret: string): string {
  if (!isIP(sourceIp)) throw new Error("sourceIp must be an IP address");
  const normalizedJa4 = normalizeJa4(ja4);
  const normalizedEpoch = clean("epoch", epoch, 100);
  if (Buffer.byteLength(secret, "utf8") < 32) throw new Error("subject secret must be at least 32 bytes");
  return createHmac("sha256", secret)
    .update(["NEXUS_BOT_SUBJECT_V1", normalizedEpoch, sourceIp, normalizedJa4 ?? "NO_JA4"].join("\0"), "utf8")
    .digest("hex");
}

export interface DecisionPolicy {
  denyEnabled?: boolean;
  observeAt?: number;
  rateLimitAt?: number;
  denyAt?: number;
}

export interface RiskContribution {
  family: RiskFamily;
  score: number;
  reason: string;
}

export interface PassiveDecision {
  action: Action;
  riskScore: number;
  contributions: readonly RiskContribution[];
  signalDigest: string;
  fingerprintPresent: boolean;
  nonClaim: "PASSIVE_TLS_FINGERPRINTS_ARE_SIGNALS_NOT_IDENTITIES";
  decisionDigest: string;
}

function normalizedPolicy(policy: DecisionPolicy = {}) {
  const observeAt = policy.observeAt ?? 0.25;
  const rateLimitAt = policy.rateLimitAt ?? 0.55;
  const denyAt = policy.denyAt ?? 0.8;
  for (const [label, value] of [["observeAt", observeAt], ["rateLimitAt", rateLimitAt], ["denyAt", denyAt]] as const) {
    if (!Number.isFinite(value) || value < 0 || value > 1) throw new Error(`${label} must be between 0 and 1`);
  }
  if (!(observeAt < rateLimitAt && rateLimitAt < denyAt)) throw new Error("decision thresholds must be strictly increasing");
  return { denyEnabled: policy.denyEnabled === true, observeAt, rateLimitAt, denyAt } as const;
}

function computeContributions(signal: PassiveSignal): RiskContribution[] {
  const out: RiskContribution[] = [];
  if (signal.botScore !== null && signal.botScore < 30) {
    out.push({ family: "PROVIDER_SCORE", score: Math.min(0.45, (30 - signal.botScore) / 50), reason: "trusted provider reported a low bot score" });
  }
  if (signal.heuristicRatio !== null && signal.heuristicRatio >= 0.5) {
    out.push({ family: "PROVIDER_HEURISTIC", score: Math.min(0.3, signal.heuristicRatio * 0.3), reason: "trusted provider heuristic ratio is elevated" });
  }
  const behavior = Math.max(signal.requestQuantile ?? 0, signal.browserRatio === null ? 0 : 1 - signal.browserRatio);
  if (behavior >= 0.8) {
    out.push({ family: "BEHAVIOR", score: Math.min(0.4, behavior * 0.4), reason: "request behavior is unusually automated" });
  }
  if (signal.curatedReputationMatch) {
    out.push({ family: "CURATED_REPUTATION", score: 0.3, reason: "trusted curated reputation evidence matched" });
  }
  return out;
}

function decisionCore(signal: PassiveSignal, policy: DecisionPolicy = {}) {
  validateSignal(signal);
  const p = normalizedPolicy(policy);
  const fingerprintPresent = signal.ja3 !== null || signal.ja4 !== null;
  if (signal.verifiedBot || signal.signedAgent) {
    return {
      action: "ALLOW" as const,
      riskScore: 0,
      contributions: [] as readonly RiskContribution[],
      signalDigest: signal.signalDigest,
      fingerprintPresent,
      nonClaim: "PASSIVE_TLS_FINGERPRINTS_ARE_SIGNALS_NOT_IDENTITIES" as const,
    };
  }
  const contributions = computeContributions(signal);
  const riskScore = Math.min(1, contributions.reduce((sum, item) => sum + item.score, 0));
  const independentFamilies = new Set(contributions.map((item) => item.family)).size;
  let action: Action = "ALLOW";
  if (riskScore >= p.observeAt) action = "OBSERVE";
  if (riskScore >= p.rateLimitAt) action = "RATE_LIMIT";
  if (p.denyEnabled && riskScore >= p.denyAt && independentFamilies >= 2) action = "DENY";
  return {
    action,
    riskScore,
    contributions,
    signalDigest: signal.signalDigest,
    fingerprintPresent,
    nonClaim: "PASSIVE_TLS_FINGERPRINTS_ARE_SIGNALS_NOT_IDENTITIES" as const,
  };
}

export function decide(signal: PassiveSignal, policy: DecisionPolicy = {}): PassiveDecision {
  const core = decisionCore(signal, policy);
  return Object.freeze({ ...core, decisionDigest: digestValue(core) });
}

export function validateDecision(signal: PassiveSignal, decision: PassiveDecision, policy: DecisionPolicy = {}): void {
  const expected = decisionCore(signal, policy);
  if (decision.decisionDigest !== digestValue(expected)) throw new Error("decision digest mismatch");
  if (JSON.stringify(canonical(decision.contributions)) !== JSON.stringify(canonical(expected.contributions))) throw new Error("decision contributions mismatch");
  if (decision.action !== expected.action || decision.riskScore !== expected.riskScore || decision.signalDigest !== expected.signalDigest || decision.fingerprintPresent !== expected.fingerprintPresent || decision.nonClaim !== expected.nonClaim) {
    throw new Error("decision replay mismatch");
  }
}

export interface ReplayStore {
  consume(nonce: string, expiresAt: string): Promise<boolean>;
}

export class InMemoryReplayStore implements ReplayStore {
  private readonly seen = new Map<string, number>();

  async consume(nonce: string, expiresAt: string): Promise<boolean> {
    const expiry = Date.parse(expiresAt);
    if (!Number.isFinite(expiry)) throw new Error("invalid replay expiry");
    const now = Date.now();
    for (const [key, value] of this.seen) if (value < now) this.seen.delete(key);
    if (this.seen.has(nonce)) return false;
    this.seen.set(nonce, expiry);
    return true;
  }
}

export interface EdgeEnvelopePayload {
  authority: "NEXUS_SIGNED_BOT_EDGE_PAYLOAD_V1";
  keyId: string;
  nonce: string;
  issuedAt: string;
  expiresAt: string;
  method: string;
  path: string;
  signal: PassiveSignal;
  subjectTokenDigest: string | null;
}

export interface SignedEnvelope {
  keyId: string;
  encoded: string;
  signature: string;
}

function validateEnvelopePayload(payload: EdgeEnvelopePayload): EdgeEnvelopePayload {
  if (payload.authority !== "NEXUS_SIGNED_BOT_EDGE_PAYLOAD_V1") throw new Error("invalid envelope authority");
  const keyId = clean("keyId", payload.keyId, MAX_KEY_ID);
  if (!/^[A-Za-z0-9._-]+$/u.test(keyId)) throw new Error("invalid keyId");
  if (!/^[A-Za-z0-9_-]{16,128}$/u.test(payload.nonce)) throw new Error("invalid nonce");
  const issuedAt = timestamp("issuedAt", payload.issuedAt);
  const expiresAt = timestamp("expiresAt", payload.expiresAt);
  const issued = Date.parse(issuedAt);
  const expires = Date.parse(expiresAt);
  if (expires <= issued || expires - issued > MAX_TTL_MS) throw new Error("invalid envelope TTL");
  validateSignal(payload.signal);
  const method = clean("method", payload.method, 32).toUpperCase();
  const path = clean("path", payload.path, MAX_PATH);
  if (method !== payload.signal.method || path !== payload.signal.path) throw new Error("signal binding mismatch");
  if (payload.signal.provider !== "SIGNED_EDGE" || payload.signal.trust !== "HMAC_VERIFIED") throw new Error("signed envelope must carry SIGNED_EDGE/HMAC_VERIFIED signal");
  if (payload.subjectTokenDigest !== null && !/^[a-f0-9]{64}$/u.test(payload.subjectTokenDigest)) throw new Error("invalid subjectTokenDigest");
  return { ...payload, keyId, issuedAt, expiresAt, method, path };
}

export function signEnvelope(payload: EdgeEnvelopePayload, secret: string): SignedEnvelope {
  if (Buffer.byteLength(secret, "utf8") < 32) throw new Error("edge secret must be at least 32 bytes");
  const validated = validateEnvelopePayload(payload);
  const encoded = Buffer.from(JSON.stringify(canonical(validated)), "utf8").toString("base64url");
  if (Buffer.byteLength(encoded, "utf8") > MAX_ENCODED_BYTES) throw new Error("encoded envelope exceeds budget");
  const signature = createHmac("sha256", secret).update(encoded, "utf8").digest("base64url");
  return Object.freeze({ keyId: validated.keyId, encoded, signature });
}

const ENVELOPE_KEYS = new Set(["authority", "keyId", "nonce", "issuedAt", "expiresAt", "method", "path", "signal", "subjectTokenDigest"]);
const SIGNAL_KEYS = new Set(["provider", "trust", "observedAt", "method", "path", "ja3", "ja4", "botScore", "verifiedBot", "signedAgent", "heuristicRatio", "browserRatio", "requestQuantile", "curatedReputationMatch", "signalDigest"]);

function rejectUnknownFields(value: Record<string, unknown>, allowed: Set<string>, label: string): void {
  for (const key of Object.keys(value)) if (!allowed.has(key)) throw new Error(`unknown ${label} field: ${key}`);
}

export async function verifyEnvelope(input: {
  encoded: string;
  signature: string;
  keyId: string;
  secret: string;
  now: string;
  expectedMethod: string;
  expectedPath: string;
  replayStore: ReplayStore;
}): Promise<EdgeEnvelopePayload> {
  if (Buffer.byteLength(input.secret, "utf8") < 32) throw new Error("edge secret must be at least 32 bytes");
  if (Buffer.byteLength(input.encoded, "utf8") > MAX_ENCODED_BYTES) throw new Error("encoded envelope exceeds budget");
  if (!/^[A-Za-z0-9_-]+$/u.test(input.encoded) || !/^[A-Za-z0-9_-]+$/u.test(input.signature)) throw new Error("invalid base64url envelope encoding");
  const expected = createHmac("sha256", input.secret).update(input.encoded, "utf8").digest();
  const actual = Buffer.from(input.signature, "base64url");
  if (actual.length !== expected.length || !timingSafeEqual(expected, actual)) throw new Error("invalid envelope signature");
  let raw: unknown;
  try {
    raw = JSON.parse(Buffer.from(input.encoded, "base64url").toString("utf8"));
  } catch {
    throw new Error("invalid envelope JSON");
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("invalid envelope payload");
  rejectUnknownFields(raw as Record<string, unknown>, ENVELOPE_KEYS, "envelope");
  const signalRaw = (raw as Record<string, unknown>).signal;
  if (!signalRaw || typeof signalRaw !== "object" || Array.isArray(signalRaw)) throw new Error("invalid envelope signal");
  rejectUnknownFields(signalRaw as Record<string, unknown>, SIGNAL_KEYS, "signal");
  const payload = validateEnvelopePayload(raw as EdgeEnvelopePayload);
  if (payload.keyId !== clean("keyId", input.keyId, MAX_KEY_ID)) throw new Error("envelope keyId mismatch");
  const now = Date.parse(timestamp("now", input.now));
  const issued = Date.parse(payload.issuedAt);
  const expires = Date.parse(payload.expiresAt);
  if (now < issued - MAX_CLOCK_SKEW_MS || now > expires) throw new Error("expired or future envelope");
  if (payload.method !== clean("expectedMethod", input.expectedMethod, 32).toUpperCase() || payload.path !== clean("expectedPath", input.expectedPath, MAX_PATH)) throw new Error("request binding mismatch");
  const canonicalEncoded = Buffer.from(JSON.stringify(canonical(payload)), "utf8").toString("base64url");
  if (canonicalEncoded !== input.encoded) throw new Error("non-canonical envelope encoding");
  if (!(await input.replayStore.consume(payload.nonce, payload.expiresAt))) throw new Error("replayed envelope");
  return Object.freeze(payload);
}

export function parseTrustedRuntimeSignalJson(text: string): PassiveSignal {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Error("invalid signal JSON");
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("signal JSON must be an object");
  const allowed = new Set(["provider", "trust", "observedAt", "method", "path", "ja3", "ja4", "botScore", "verifiedBot", "signedAgent", "heuristicRatio", "browserRatio", "requestQuantile", "curatedReputationMatch"]);
  rejectUnknownFields(raw as Record<string, unknown>, allowed, "runtime signal");
  const input = raw as unknown as PassiveSignalInput;
  if (input.provider === "SIGNED_EDGE") throw new Error("SIGNED_EDGE input must be accepted through verifyEnvelope, not raw JSON");
  if (input.provider !== "CLOUDFLARE" && input.provider !== "AWS_WAF" && input.provider !== "CONTROLLED_TEST") throw new Error("unsupported runtime provider");
  return createSignal(input);
}
