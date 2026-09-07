import { timingSafeEqual } from "node:crypto";
import {
  DurableEnhancedConversionsPipeline,
  EnhancedConversionError,
  observeEnhancedConversionInput,
  type EnhancedConversionObservation,
  type EnhancedConversionRecord,
} from "./index";
import { DataManagerApiError, type DataManagerConversionEvent } from "./data-manager-rest";

const TX_ID = /^[A-Za-z0-9](?:[A-Za-z0-9._:-]{7,127})$/u;
const DECISION_ID = /^[A-Za-z0-9](?:[A-Za-z0-9._:-]{7,127})$/u;
const POLICY_ID = /^[A-Za-z0-9](?:[A-Za-z0-9._:-]{0,127})$/u;
const MAX_RESPONSE_BYTES = 64 * 1024;

export type IdentityClass = "USER_DATA" | "AD_CLICK";
export type PrivacyDecisionStatus = "GRANTED" | "DENIED" | "REVOKED";

export interface ConversionPrivacyDecision {
  readonly transactionId: string;
  readonly decisionId: string;
  readonly policyId: string;
  readonly revision: number;
  readonly status: PrivacyDecisionStatus;
  readonly allowedIdentityClasses: readonly IdentityClass[];
  readonly observedAt: string;
  readonly expiresAt: string;
}

export interface ConversionPrivacyDecisionProvider {
  resolve(transactionId: string): Promise<ConversionPrivacyDecision>;
}

export interface ConversionPrivacyPolicy {
  readonly version: 1;
  readonly maxDecisionAgeMs: number;
  readonly allowedPolicyIds: readonly string[];
}

export interface HttpConversionPrivacyDecisionProviderConfig {
  readonly endpoint: string;
  readonly bearerToken: string;
  readonly timeoutMs?: number;
  readonly fetchImpl?: typeof fetch;
}

export class ConversionPrivacyError extends Error {
  constructor(
    public readonly code:
      | "INVALID_CONFIG"
      | "INVALID_INPUT"
      | "INVALID_RESPONSE"
      | "HTTP_ERROR"
      | "TIMEOUT"
      | "CONSENT_DENIED"
      | "CONSENT_REVOKED"
      | "STALE_DECISION"
      | "POLICY_VIOLATION",
    message: string,
  ) {
    super(message);
    this.name = "ConversionPrivacyError";
  }
}

function plainObject(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new ConversionPrivacyError("INVALID_INPUT", `${label} must be a plain object`);
  }
  return value as Record<string, unknown>;
}

function canonicalUtc(value: unknown, field: string, code: ConversionPrivacyError["code"]): string {
  if (typeof value !== "string") throw new ConversionPrivacyError(code, `${field} must be canonical UTC`);
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== value) throw new ConversionPrivacyError(code, `${field} must be canonical UTC`);
  return value;
}

function normalizedEndpoint(value: string): string {
  let parsed: URL;
  try { parsed = new URL(value); } catch { throw new ConversionPrivacyError("INVALID_CONFIG", "privacy endpoint is invalid"); }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new ConversionPrivacyError("INVALID_CONFIG", "privacy endpoint must be clean HTTPS");
  }
  return parsed.toString();
}

function secret(value: string): string {
  const normalized = value.trim();
  if (normalized.length < 32 || normalized.length > 4096) throw new ConversionPrivacyError("INVALID_CONFIG", "privacy bearer token must contain 32..4096 characters");
  return normalized;
}

function timeout(value: number | undefined): number {
  const resolved = value ?? 5_000;
  if (!Number.isSafeInteger(resolved) || resolved < 1_000 || resolved > 60_000) throw new ConversionPrivacyError("INVALID_CONFIG", "privacy timeoutMs must be 1000..60000");
  return resolved;
}

async function boundedJson(response: Response): Promise<unknown> {
  const contentType = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  if (contentType !== "application/json") throw new ConversionPrivacyError("INVALID_RESPONSE", "privacy response must be application/json");
  if (!response.body) throw new ConversionPrivacyError("INVALID_RESPONSE", "privacy response body is missing");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      total += next.value.byteLength;
      if (total > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        throw new ConversionPrivacyError("INVALID_RESPONSE", `privacy response exceeds ${MAX_RESPONSE_BYTES} bytes`);
      }
      chunks.push(next.value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  try { return JSON.parse(new TextDecoder().decode(bytes)) as unknown; }
  catch { throw new ConversionPrivacyError("INVALID_RESPONSE", "privacy response contains malformed JSON"); }
}

function parseDecision(value: unknown, expectedTransactionId: string): ConversionPrivacyDecision {
  const raw = plainObject(value, "privacy decision");
  const allowed = new Set(["transactionId", "decisionId", "policyId", "revision", "status", "allowedIdentityClasses", "observedAt", "expiresAt"]);
  for (const key of Object.keys(raw)) if (!allowed.has(key)) throw new ConversionPrivacyError("INVALID_RESPONSE", `privacy decision contains unknown field ${key}`);
  for (const key of allowed) if (!(key in raw)) throw new ConversionPrivacyError("INVALID_RESPONSE", `privacy decision.${key} is required`);
  if (raw.transactionId !== expectedTransactionId) throw new ConversionPrivacyError("INVALID_RESPONSE", "privacy transactionId mismatch");
  if (typeof raw.decisionId !== "string" || !DECISION_ID.test(raw.decisionId)) throw new ConversionPrivacyError("INVALID_RESPONSE", "privacy decisionId is malformed");
  if (typeof raw.policyId !== "string" || !POLICY_ID.test(raw.policyId)) throw new ConversionPrivacyError("INVALID_RESPONSE", "privacy policyId is malformed");
  if (!Number.isSafeInteger(raw.revision) || (raw.revision as number) < 1) throw new ConversionPrivacyError("INVALID_RESPONSE", "privacy revision must be >= 1");
  if (!(raw.status === "GRANTED" || raw.status === "DENIED" || raw.status === "REVOKED")) throw new ConversionPrivacyError("INVALID_RESPONSE", "privacy status is invalid");
  if (!Array.isArray(raw.allowedIdentityClasses) || raw.allowedIdentityClasses.length > 2) throw new ConversionPrivacyError("INVALID_RESPONSE", "privacy allowedIdentityClasses is invalid");
  const classes = raw.allowedIdentityClasses.map((item) => {
    if (!(item === "USER_DATA" || item === "AD_CLICK")) throw new ConversionPrivacyError("INVALID_RESPONSE", "privacy identity class is invalid");
    return item;
  });
  if (new Set(classes).size !== classes.length) throw new ConversionPrivacyError("INVALID_RESPONSE", "privacy identity classes must be unique");
  const observedAt = canonicalUtc(raw.observedAt, "privacy observedAt", "INVALID_RESPONSE");
  const expiresAt = canonicalUtc(raw.expiresAt, "privacy expiresAt", "INVALID_RESPONSE");
  if (Date.parse(expiresAt) <= Date.parse(observedAt)) throw new ConversionPrivacyError("INVALID_RESPONSE", "privacy expiresAt must be after observedAt");
  if (raw.status !== "GRANTED" && classes.length !== 0) throw new ConversionPrivacyError("INVALID_RESPONSE", "denied/revoked decisions cannot allow identity classes");
  return Object.freeze({
    transactionId: expectedTransactionId,
    decisionId: raw.decisionId,
    policyId: raw.policyId,
    revision: raw.revision as number,
    status: raw.status,
    allowedIdentityClasses: Object.freeze(classes),
    observedAt,
    expiresAt,
  });
}

export class HttpConversionPrivacyDecisionProvider implements ConversionPrivacyDecisionProvider {
  private readonly endpoint: string;
  private readonly bearerToken: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(config: HttpConversionPrivacyDecisionProviderConfig) {
    this.endpoint = normalizedEndpoint(config.endpoint);
    this.bearerToken = secret(config.bearerToken);
    this.timeoutMs = timeout(config.timeoutMs);
    this.fetchImpl = config.fetchImpl ?? fetch;
  }

  async resolve(transactionId: string): Promise<ConversionPrivacyDecision> {
    if (!TX_ID.test(transactionId)) throw new ConversionPrivacyError("INVALID_INPUT", "transactionId is malformed");
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let response: Response;
    try {
      response = await this.fetchImpl(this.endpoint, {
        method: "POST",
        redirect: "error",
        signal: controller.signal,
        headers: {
          authorization: `Bearer ${this.bearerToken}`,
          accept: "application/json",
          "content-type": "application/json",
        },
        body: JSON.stringify({ transactionId }),
      });
    } catch (error) {
      if (controller.signal.aborted) throw new ConversionPrivacyError("TIMEOUT", "privacy decision request timed out");
      throw new ConversionPrivacyError("HTTP_ERROR", error instanceof Error ? error.message : "privacy decision request failed");
    } finally { clearTimeout(timer); }
    if (!response.ok) throw new ConversionPrivacyError("HTTP_ERROR", `privacy decision endpoint returned HTTP ${response.status}`);
    return parseDecision(await boundedJson(response), transactionId);
  }
}

export function createConversionPrivacyPolicy(input: ConversionPrivacyPolicy): ConversionPrivacyPolicy {
  if (input.version !== 1) throw new ConversionPrivacyError("INVALID_CONFIG", "privacy policy version must be 1");
  if (!Number.isSafeInteger(input.maxDecisionAgeMs) || input.maxDecisionAgeMs < 1_000 || input.maxDecisionAgeMs > 86_400_000) {
    throw new ConversionPrivacyError("INVALID_CONFIG", "maxDecisionAgeMs must be 1000..86400000");
  }
  if (!Array.isArray(input.allowedPolicyIds) || input.allowedPolicyIds.length < 1 || input.allowedPolicyIds.length > 32) {
    throw new ConversionPrivacyError("INVALID_CONFIG", "allowedPolicyIds must contain 1..32 items");
  }
  const allowedPolicyIds = input.allowedPolicyIds.map((value) => {
    if (typeof value !== "string" || !POLICY_ID.test(value.trim())) throw new ConversionPrivacyError("INVALID_CONFIG", "allowedPolicyIds contains malformed policyId");
    return value.trim();
  });
  if (new Set(allowedPolicyIds).size !== allowedPolicyIds.length) throw new ConversionPrivacyError("INVALID_CONFIG", "allowedPolicyIds must be unique");
  return Object.freeze({ version: 1, maxDecisionAgeMs: input.maxDecisionAgeMs, allowedPolicyIds: Object.freeze(allowedPolicyIds) });
}

function transactionIdFromInput(value: unknown): string {
  const raw = plainObject(value, "enhanced conversion input");
  const transactionId = raw.transactionId;
  if (typeof transactionId !== "string" || !TX_ID.test(transactionId.trim())) throw new EnhancedConversionError("INVALID_INPUT", "transactionId is malformed");
  return transactionId.trim();
}

export function validateDecisionForEvent(
  decision: ConversionPrivacyDecision,
  policy: ConversionPrivacyPolicy,
  nowMs: number,
  event?: DataManagerConversionEvent,
): void {
  if (!policy.allowedPolicyIds.includes(decision.policyId)) throw new ConversionPrivacyError("POLICY_VIOLATION", "privacy decision policy is not allowlisted");
  const observedAt = Date.parse(decision.observedAt);
  const expiresAt = Date.parse(decision.expiresAt);
  const age = nowMs - observedAt;
  if (age < 0 || age > policy.maxDecisionAgeMs || expiresAt <= nowMs) throw new ConversionPrivacyError("STALE_DECISION", "privacy decision is stale, future-dated, or expired");
  if (decision.status === "REVOKED") throw new ConversionPrivacyError("CONSENT_REVOKED", "conversion privacy consent has been revoked");
  if (decision.status === "DENIED") throw new ConversionPrivacyError("CONSENT_DENIED", "conversion privacy consent is denied");
  if (event) {
    if (event.userIdentifiers.length > 0 && !decision.allowedIdentityClasses.includes("USER_DATA")) {
      throw new ConversionPrivacyError("CONSENT_DENIED", "privacy decision does not allow user-data identifiers");
    }
    if (event.gclid !== undefined && !decision.allowedIdentityClasses.includes("AD_CLICK")) {
      throw new ConversionPrivacyError("CONSENT_DENIED", "privacy decision does not allow ad-click identifiers");
    }
  }
}

function governedInput(value: unknown, decision: ConversionPrivacyDecision): unknown {
  const raw = plainObject(value, "enhanced conversion input");
  const next: Record<string, unknown> = { ...raw };
  const allowUserData = decision.status === "GRANTED" && decision.allowedIdentityClasses.includes("USER_DATA");
  const allowAdClick = decision.status === "GRANTED" && decision.allowedIdentityClasses.includes("AD_CLICK");
  next.adUserDataConsent = allowUserData ? "GRANTED" : "DENIED";
  if (!allowUserData) {
    delete next.emailAddresses;
    delete next.phoneNumbers;
  }
  if (!allowAdClick) delete next.gclid;
  return next;
}

export interface PrivacyGuardedEnhancedConversionsPipelineOptions {
  readonly base: DurableEnhancedConversionsPipeline;
  readonly decisions: ConversionPrivacyDecisionProvider;
  readonly policy: ConversionPrivacyPolicy;
  readonly now?: () => number;
}

export class PrivacyGuardedEnhancedConversionsPipeline {
  readonly policy: ConversionPrivacyPolicy;
  private readonly now: () => number;

  constructor(private readonly options: PrivacyGuardedEnhancedConversionsPipelineOptions) {
    this.policy = createConversionPrivacyPolicy(options.policy);
    this.now = options.now ?? Date.now;
  }

  private async resolveFor(value: unknown): Promise<{ transactionId: string; input: unknown; decision: ConversionPrivacyDecision }> {
    const transactionId = transactionIdFromInput(value);
    const decision = await this.options.decisions.resolve(transactionId);
    validateDecisionForEvent(decision, this.policy, this.now());
    const input = governedInput(value, decision);
    return { transactionId, input, decision };
  }

  async observe(value: unknown): Promise<EnhancedConversionObservation> {
    const resolved = await this.resolveFor(value);
    return observeEnhancedConversionInput(resolved.input);
  }

  async prepare(value: unknown): Promise<EnhancedConversionRecord> {
    const resolved = await this.resolveFor(value);
    return this.options.base.prepare(resolved.input);
  }

  dispatch(transactionId: string): Promise<EnhancedConversionRecord> {
    return this.options.base.dispatch(transactionId);
  }

  rollback(transactionId: string): EnhancedConversionRecord {
    return this.options.base.rollback(transactionId);
  }

  get(transactionId: string): EnhancedConversionRecord | undefined {
    return this.options.base.get(transactionId);
  }
}

export function createPrivacyMutationGuard(
  decisions: ConversionPrivacyDecisionProvider,
  policyInput: ConversionPrivacyPolicy,
  now: () => number = Date.now,
): (event: DataManagerConversionEvent) => Promise<void> {
  const policy = createConversionPrivacyPolicy(policyInput);
  return async (event) => {
    const decision = await decisions.resolve(event.transactionId);
    try {
      validateDecisionForEvent(decision, policy, now(), event);
    } catch (error) {
      if (error instanceof ConversionPrivacyError && (error.code === "CONSENT_DENIED" || error.code === "CONSENT_REVOKED" || error.code === "STALE_DECISION" || error.code === "POLICY_VIOLATION")) {
        throw new DataManagerApiError("CONSENT_BLOCKED", error.message, 403);
      }
      throw error;
    }
  };
}

export function equalBearerSecret(left: string, right: string): boolean {
  const a = Buffer.from(left.trim(), "utf8");
  const b = Buffer.from(right.trim(), "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}
