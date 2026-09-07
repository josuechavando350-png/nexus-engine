import {
  Cortex40Error,
  type B2bEnrichmentProvider,
  type B2bEnrichmentResult,
  type CapabilityDecision,
  type CapabilityGateProvider,
  type ChannelDispatcher,
  type ConsentDecision,
  type ConsentRegistryProvider,
  type HumanHandoffDestination,
  type LocalSalesAssistant,
  type LocalSalesAssistantInput,
  type LocalSalesAssistantResult,
  type SalesChannel,
  type SalesRequestedAction,
} from "./autonomous-sales.js";

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{3,191}$/u;
const SHA256 = /^sha256:[0-9a-f]{64}$/u;
const MAX_RESPONSE_BYTES = 128 * 1024;

interface HttpAdapterConfig {
  readonly endpoint: URL;
  readonly bearerToken: string;
  readonly timeoutMs?: number;
  readonly fetchImpl?: typeof fetch;
}

function token(value: string, label: string): string {
  const normalized = value.trim();
  if (normalized.length < 32 || normalized.length > 8192 || /[\r\n\0]/u.test(normalized)) {
    throw new Cortex40Error("INVALID_CONFIG", `${label} is invalid`);
  }
  return normalized;
}

function timeout(value: number | undefined): number {
  const resolved = value ?? 10_000;
  if (!Number.isSafeInteger(resolved) || resolved < 1000 || resolved > 120_000) {
    throw new Cortex40Error("INVALID_CONFIG", "adapter timeoutMs is invalid");
  }
  return resolved;
}

function httpsEndpoint(endpoint: URL, label: string): URL {
  if (
    endpoint.protocol !== "https:" ||
    endpoint.username ||
    endpoint.password ||
    endpoint.hash ||
    endpoint.search
  ) {
    throw new Cortex40Error("INVALID_CONFIG", `${label} must be a credential-free HTTPS endpoint`);
  }
  return new URL(endpoint);
}

function loopbackEndpoint(endpoint: URL): URL {
  const loopback = endpoint.hostname === "127.0.0.1" || endpoint.hostname === "[::1]" || endpoint.hostname === "::1";
  if (
    endpoint.protocol !== "http:" ||
    !loopback ||
    endpoint.username ||
    endpoint.password ||
    endpoint.hash ||
    endpoint.search
  ) {
    throw new Cortex40Error("INVALID_CONFIG", "local LLM endpoint must be loopback-only HTTP without credentials/query/fragment");
  }
  return new URL(endpoint);
}

async function boundedJson(response: Response): Promise<Record<string, unknown>> {
  const declared = response.headers.get("content-length");
  if (declared !== null && (!/^\d+$/u.test(declared) || Number(declared) > MAX_RESPONSE_BYTES)) {
    throw new Cortex40Error("INTEGRITY_FAILURE", "adapter response is oversized");
  }
  if (!response.body) throw new Cortex40Error("INTEGRITY_FAILURE", "adapter response body is missing");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      total += next.value.byteLength;
      if (total > MAX_RESPONSE_BYTES) {
        await reader.cancel().catch(() => undefined);
        throw new Cortex40Error("INTEGRITY_FAILURE", "adapter response is oversized");
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(bytes)) as unknown;
  } catch {
    throw new Cortex40Error("INTEGRITY_FAILURE", "adapter response contains malformed JSON");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) || Object.getPrototypeOf(parsed) !== Object.prototype) {
    throw new Cortex40Error("INTEGRITY_FAILURE", "adapter response must be a plain object");
  }
  return parsed as Record<string, unknown>;
}

class JsonHttpAdapter {
  readonly endpoint: URL;
  readonly bearerToken: string;
  readonly timeoutMs: number;
  readonly fetchImpl: typeof fetch;

  constructor(config: HttpAdapterConfig, label: string, loopback = false) {
    this.endpoint = loopback ? loopbackEndpoint(config.endpoint) : httpsEndpoint(config.endpoint, label);
    this.bearerToken = token(config.bearerToken, `${label} bearer token`);
    this.timeoutMs = timeout(config.timeoutMs);
    this.fetchImpl = config.fetchImpl ?? fetch;
  }

  async post(body: unknown, idempotencyKey?: string): Promise<Record<string, unknown>> {
    let response: Response;
    try {
      response = await this.fetchImpl(this.endpoint, {
        method: "POST",
        redirect: "error",
        signal: AbortSignal.timeout(this.timeoutMs),
        headers: {
          authorization: `Bearer ${this.bearerToken}`,
          "content-type": "application/json",
          accept: "application/json",
          ...(idempotencyKey ? { "idempotency-key": idempotencyKey } : {}),
        },
        body: JSON.stringify(body),
      });
    } catch (error) {
      throw new Cortex40Error("INTEGRITY_FAILURE", error instanceof Error ? error.message : "adapter transport failed");
    }
    const parsed = await boundedJson(response);
    if (!response.ok) throw new Cortex40Error("INTEGRITY_FAILURE", `adapter returned HTTP ${response.status}`);
    return parsed;
  }
}

export interface HttpB2bEnrichmentConfig extends HttpAdapterConfig {
  readonly providerId: string;
}

export class HttpB2bEnrichmentProvider implements B2bEnrichmentProvider {
  readonly providerId: string;
  private readonly http: JsonHttpAdapter;

  constructor(config: HttpB2bEnrichmentConfig) {
    if (!ID.test(config.providerId)) throw new Cortex40Error("INVALID_CONFIG", "B2B providerId is malformed");
    this.providerId = config.providerId;
    this.http = new JsonHttpAdapter(config, "B2B enrichment");
  }

  async enrich(domain: string, idempotencyKey: string): Promise<B2bEnrichmentResult> {
    const body = await this.http.post({
      schemaVersion: 1,
      providerId: this.providerId,
      purpose: "SALES_QUALIFICATION",
      domain,
    }, idempotencyKey);
    if (
      body.providerId !== this.providerId ||
      typeof body.evidenceId !== "string" ||
      !ID.test(body.evidenceId) ||
      body.domain !== domain ||
      !body.attributes ||
      typeof body.attributes !== "object" ||
      Array.isArray(body.attributes)
    ) {
      throw new Cortex40Error("INTEGRITY_FAILURE", "B2B enrichment response identity is invalid");
    }
    return Object.freeze({
      providerId: this.providerId,
      evidenceId: body.evidenceId,
      domain,
      attributes: Object.freeze({ ...(body.attributes as Record<string, string | number | boolean>) }),
    });
  }
}

export class HttpConsentRegistryProvider implements ConsentRegistryProvider {
  private readonly http: JsonHttpAdapter;

  constructor(config: HttpAdapterConfig) {
    this.http = new JsonHttpAdapter(config, "consent registry");
  }

  async resolve(contactHash: `sha256:${string}`, channel: SalesChannel): Promise<ConsentDecision> {
    if (!SHA256.test(contactHash) || !(channel === "WHATSAPP" || channel === "SMS")) {
      throw new Cortex40Error("INVALID_INPUT", "consent lookup input is invalid");
    }
    const body = await this.http.post({ schemaVersion: 1, contactHash, channel });
    if (
      typeof body.decisionId !== "string" ||
      !ID.test(body.decisionId) ||
      !(body.status === "GRANTED" || body.status === "DENIED" || body.status === "REVOKED") ||
      body.channel !== channel ||
      body.contactHash !== contactHash ||
      typeof body.expiresAt !== "string" ||
      !Number.isFinite(Date.parse(body.expiresAt))
    ) {
      throw new Cortex40Error("INTEGRITY_FAILURE", "consent registry response is invalid");
    }
    return Object.freeze({
      decisionId: body.decisionId,
      status: body.status,
      channel,
      contactHash,
      expiresAt: body.expiresAt,
    });
  }
}

export class HttpCapabilityGateProvider implements CapabilityGateProvider {
  private readonly http: JsonHttpAdapter;

  constructor(config: HttpAdapterConfig) {
    this.http = new JsonHttpAdapter(config, "capability gate");
  }

  async read(capabilityId: string): Promise<CapabilityDecision> {
    if (!ID.test(capabilityId)) throw new Cortex40Error("INVALID_INPUT", "capabilityId is malformed");
    const body = await this.http.post({ schemaVersion: 1, capabilityId });
    if (
      body.capabilityId !== capabilityId ||
      !(body.mode === "ACTIVE" || body.mode === "OBSERVE_ONLY" || body.mode === "KILLED") ||
      typeof body.revision !== "number" ||
      !Number.isSafeInteger(body.revision) ||
      body.revision < 0 ||
      typeof body.policyDigest !== "string" ||
      !SHA256.test(body.policyDigest)
    ) {
      throw new Cortex40Error("INTEGRITY_FAILURE", "capability response is invalid");
    }
    return Object.freeze({
      capabilityId,
      mode: body.mode,
      revision: body.revision,
      policyDigest: body.policyDigest as `sha256:${string}`,
    });
  }
}

export class LoopbackLocalSalesAssistant implements LocalSalesAssistant {
  private readonly http: JsonHttpAdapter;

  constructor(config: HttpAdapterConfig) {
    this.http = new JsonHttpAdapter(config, "local LLM", true);
  }

  async draft(input: LocalSalesAssistantInput): Promise<LocalSalesAssistantResult> {
    const body = await this.http.post({ schemaVersion: 1, input });
    const action = body.requestedAction;
    if (
      typeof body.modelId !== "string" ||
      !ID.test(body.modelId) ||
      typeof body.modelDigest !== "string" ||
      !SHA256.test(body.modelDigest) ||
      typeof body.classification !== "string" ||
      !ID.test(body.classification) ||
      typeof body.summary !== "string" ||
      typeof body.suggestedMessage !== "string" ||
      !(
        action === "FOLLOW_UP" ||
        action === "CUSTOM_PRICE" ||
        action === "DISCOUNT" ||
        action === "CONTRACT" ||
        action === "PAYMENT_TERMS" ||
        action === "LEGAL_COMMITMENT" ||
        action === "HUMAN_HANDOFF"
      )
    ) {
      throw new Cortex40Error("INTEGRITY_FAILURE", "local LLM response is invalid");
    }
    return Object.freeze({
      modelId: body.modelId,
      modelDigest: body.modelDigest as `sha256:${string}`,
      classification: body.classification,
      summary: body.summary,
      suggestedMessage: body.suggestedMessage,
      requestedAction: action as SalesRequestedAction,
    });
  }
}

export class HttpChannelDispatcher implements ChannelDispatcher {
  private readonly http: JsonHttpAdapter;

  constructor(config: HttpAdapterConfig) {
    this.http = new JsonHttpAdapter(config, "channel dispatcher");
  }

  async send(input: { channel: SalesChannel; contact: string; message: string; idempotencyKey: string }): Promise<{ receiptId: string }> {
    const body = await this.http.post({ schemaVersion: 1, ...input }, input.idempotencyKey);
    if (typeof body.receiptId !== "string" || !ID.test(body.receiptId)) {
      throw new Cortex40Error("INTEGRITY_FAILURE", "channel receipt is invalid");
    }
    return Object.freeze({ receiptId: body.receiptId });
  }
}

export class HttpHumanHandoffDestination implements HumanHandoffDestination {
  private readonly http: JsonHttpAdapter;

  constructor(config: HttpAdapterConfig) {
    this.http = new JsonHttpAdapter(config, "human handoff");
  }

  async handoff(input: {
    submissionId: string;
    formId: string;
    leadScore: number;
    predictedClv: number;
    clvCurrency: string;
    requestedAction: SalesRequestedAction;
    summary: string;
    idempotencyKey: string;
  }): Promise<{ receiptId: string }> {
    const body = await this.http.post({ schemaVersion: 1, ...input }, input.idempotencyKey);
    if (typeof body.receiptId !== "string" || !ID.test(body.receiptId)) {
      throw new Cortex40Error("INTEGRITY_FAILURE", "human handoff receipt is invalid");
    }
    return Object.freeze({ receiptId: body.receiptId });
  }
}
