const GRAPH_BASE = "https://graph.facebook.com";
const DEFAULT_GRAPH_API_VERSION = "v26.0";
const MAX_RESPONSE_BYTES = 512 * 1024;
const DEFAULT_TIMEOUT_MS = 10_000;
const PHONE_NUMBER_ID = /^\d{6,32}$/u;
const GRAPH_VERSION = /^v\d{1,2}\.0$/u;
const TEMPLATE_NAME = /^[a-z0-9_]{1,512}$/u;
const LANGUAGE_CODE = /^[a-z]{2,3}(?:_[A-Z]{2})?$/u;
const PROOF_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,191}$/u;

export type WhatsAppAccessTokenProvider = () => Promise<string>;

export interface WhatsAppConsentEvidence {
  readonly status: "OPTED_IN";
  readonly recipientE164: string;
  readonly capturedAt: string;
  readonly source: string;
  readonly proofId: string;
  readonly withdrawnAt?: string;
}

export interface WhatsAppTemplateMessageInput {
  readonly recipientE164: string;
  readonly consent: WhatsAppConsentEvidence;
  readonly templateName: string;
  readonly languageCode: string;
  readonly bodyParameters?: readonly string[];
}

export interface WhatsAppTemplatePayload {
  readonly messaging_product: "whatsapp";
  readonly recipient_type: "individual";
  readonly to: string;
  readonly type: "template";
  readonly template: Readonly<{
    name: string;
    language: Readonly<{ code: string }>;
    components?: readonly Readonly<{
      type: "body";
      parameters: readonly Readonly<{ type: "text"; text: string }>[];
    }>[];
  }>;
}

export interface WhatsAppSendReceipt {
  readonly provider: "WHATSAPP_CLOUD_API";
  readonly messageId: string;
  readonly recipientWaId: string | null;
  readonly graphApiVersion: string;
}

export interface WhatsAppCloudApiClientConfig {
  readonly phoneNumberId: string;
  readonly accessTokenProvider: WhatsAppAccessTokenProvider;
  readonly graphApiVersion?: string;
  readonly fetchImpl?: typeof fetch;
  readonly timeoutMs?: number;
  readonly now?: () => number;
}

export class WhatsAppCloudApiError extends Error {
  constructor(
    public readonly code:
      | "INVALID_CONFIG"
      | "INVALID_INPUT"
      | "CONSENT_REQUIRED"
      | "AUTHENTICATION_FAILED"
      | "QUOTA_EXHAUSTED"
      | "API_ERROR"
      | "INVALID_RESPONSE"
      | "AMBIGUOUS_OUTCOME",
    message: string,
    public readonly httpStatus: number | null = null,
  ) {
    super(message);
    this.name = "WhatsAppCloudApiError";
  }
}

function containsControlCharacters(value: string): boolean {
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

function boundedText(value: unknown, label: string, maximum: number): string {
  if (typeof value !== "string") throw new WhatsAppCloudApiError("INVALID_INPUT", `${label} must be a string`);
  const normalized = value.normalize("NFKC").replace(/\s+/gu, " ").trim();
  if (!normalized || normalized.length > maximum || containsControlCharacters(normalized)) {
    throw new WhatsAppCloudApiError("INVALID_INPUT", `${label} is empty, oversized, or malformed`);
  }
  return normalized;
}

export function normalizeWhatsAppRecipient(value: unknown): string {
  const normalized = boundedText(value, "recipientE164", 32).replace(/[\s()-]/gu, "");
  const digits = normalized.startsWith("+") ? normalized.slice(1) : normalized;
  if (!/^[1-9]\d{7,14}$/u.test(digits)) throw new WhatsAppCloudApiError("INVALID_INPUT", "recipientE164 must use international E.164 form");
  return digits;
}

function canonicalUtc(value: unknown, label: string): string {
  if (typeof value !== "string") throw new WhatsAppCloudApiError("CONSENT_REQUIRED", `${label} must be a timestamp`);
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== value) throw new WhatsAppCloudApiError("CONSENT_REQUIRED", `${label} must be canonical UTC`);
  return value;
}

function validateConsent(value: unknown, recipient: string, nowMs: number): WhatsAppConsentEvidence {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new WhatsAppCloudApiError("CONSENT_REQUIRED", "explicit WhatsApp opt-in evidence is required");
  const raw = value as Record<string, unknown>;
  if (raw.status !== "OPTED_IN") throw new WhatsAppCloudApiError("CONSENT_REQUIRED", "WhatsApp recipient has not opted in");
  const evidenceRecipient = normalizeWhatsAppRecipient(raw.recipientE164);
  if (evidenceRecipient !== recipient) throw new WhatsAppCloudApiError("CONSENT_REQUIRED", "WhatsApp consent belongs to a different recipient");
  const capturedAt = canonicalUtc(raw.capturedAt, "consent.capturedAt");
  if (Date.parse(capturedAt) > nowMs + 5 * 60_000) throw new WhatsAppCloudApiError("CONSENT_REQUIRED", "WhatsApp consent timestamp is in the future");
  if (raw.withdrawnAt !== undefined) {
    canonicalUtc(raw.withdrawnAt, "consent.withdrawnAt");
    throw new WhatsAppCloudApiError("CONSENT_REQUIRED", "WhatsApp consent has been withdrawn");
  }
  const source = boundedText(raw.source, "consent.source", 128);
  const proofId = boundedText(raw.proofId, "consent.proofId", 192);
  if (!PROOF_ID.test(proofId)) throw new WhatsAppCloudApiError("CONSENT_REQUIRED", "WhatsApp consent proofId is malformed");
  return Object.freeze({ status: "OPTED_IN", recipientE164: evidenceRecipient, capturedAt, source, proofId });
}

function validateTemplateName(value: unknown): string {
  const normalized = boundedText(value, "templateName", 512).toLowerCase();
  if (!TEMPLATE_NAME.test(normalized)) throw new WhatsAppCloudApiError("INVALID_INPUT", "templateName must match an approved WhatsApp template name");
  return normalized;
}

function validateLanguage(value: unknown): string {
  const normalized = boundedText(value, "languageCode", 16);
  if (!LANGUAGE_CODE.test(normalized)) throw new WhatsAppCloudApiError("INVALID_INPUT", "languageCode is malformed");
  return normalized;
}

function validateBodyParameters(value: unknown): readonly string[] {
  if (value === undefined) return Object.freeze([]);
  if (!Array.isArray(value) || value.length > 10) throw new WhatsAppCloudApiError("INVALID_INPUT", "bodyParameters must contain at most 10 values");
  return Object.freeze(value.map((item, index) => boundedText(item, `bodyParameters[${index}]`, 1024)));
}

function accessToken(value: unknown): string {
  if (typeof value !== "string") throw new WhatsAppCloudApiError("AUTHENTICATION_FAILED", "WhatsApp access token is missing");
  const normalized = value.trim();
  if (normalized.length < 16 || normalized.length > 8192 || containsControlCharacters(normalized)) {
    throw new WhatsAppCloudApiError("AUTHENTICATION_FAILED", "WhatsApp access token is malformed");
  }
  return normalized;
}

async function boundedJson(response: Response): Promise<unknown> {
  const declared = response.headers.get("content-length");
  if (declared !== null && (!/^\d+$/u.test(declared) || Number(declared) > MAX_RESPONSE_BYTES)) {
    throw new WhatsAppCloudApiError("INVALID_RESPONSE", "WhatsApp response declared an invalid or oversized body", response.status);
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength > MAX_RESPONSE_BYTES) throw new WhatsAppCloudApiError("INVALID_RESPONSE", "WhatsApp response exceeded the bounded body size", response.status);
  if (bytes.byteLength === 0) return null;
  try {
    return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
  } catch {
    throw new WhatsAppCloudApiError("INVALID_RESPONSE", "WhatsApp returned malformed JSON", response.status);
  }
}

function parseReceipt(payload: unknown, graphApiVersion: string): WhatsAppSendReceipt {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new WhatsAppCloudApiError("INVALID_RESPONSE", "WhatsApp response must be an object");
  const raw = payload as Record<string, unknown>;
  const messages = raw.messages;
  if (!Array.isArray(messages) || messages.length < 1 || !messages[0] || typeof messages[0] !== "object") {
    throw new WhatsAppCloudApiError("INVALID_RESPONSE", "WhatsApp response is missing message receipt");
  }
  const messageId = (messages[0] as Record<string, unknown>).id;
  if (typeof messageId !== "string" || messageId.length < 8 || messageId.length > 512 || containsControlCharacters(messageId)) {
    throw new WhatsAppCloudApiError("INVALID_RESPONSE", "WhatsApp message receipt id is malformed");
  }
  let recipientWaId: string | null = null;
  if (Array.isArray(raw.contacts) && raw.contacts[0] && typeof raw.contacts[0] === "object") {
    const waId = (raw.contacts[0] as Record<string, unknown>).wa_id;
    if (typeof waId === "string" && /^\d{8,15}$/u.test(waId)) recipientWaId = waId;
  }
  return Object.freeze({ provider: "WHATSAPP_CLOUD_API", messageId, recipientWaId, graphApiVersion });
}

export function buildWhatsAppTemplatePayload(input: WhatsAppTemplateMessageInput, nowMs = Date.now()): WhatsAppTemplatePayload {
  if (!input || typeof input !== "object") throw new WhatsAppCloudApiError("INVALID_INPUT", "WhatsApp template input is required");
  if (!Number.isFinite(nowMs)) throw new WhatsAppCloudApiError("INVALID_CONFIG", "clock returned a non-finite timestamp");
  const recipient = normalizeWhatsAppRecipient(input.recipientE164);
  validateConsent(input.consent, recipient, nowMs);
  const templateName = validateTemplateName(input.templateName);
  const languageCode = validateLanguage(input.languageCode);
  const bodyParameters = validateBodyParameters(input.bodyParameters);
  return Object.freeze({
    messaging_product: "whatsapp",
    recipient_type: "individual",
    to: recipient,
    type: "template",
    template: Object.freeze({
      name: templateName,
      language: Object.freeze({ code: languageCode }),
      ...(bodyParameters.length === 0 ? {} : {
        components: Object.freeze([
          Object.freeze({
            type: "body" as const,
            parameters: Object.freeze(bodyParameters.map((text) => Object.freeze({ type: "text" as const, text }))),
          }),
        ]),
      }),
    }),
  });
}

export class WhatsAppCloudApiClient {
  private readonly phoneNumberId: string;
  private readonly accessTokenProvider: WhatsAppAccessTokenProvider;
  private readonly graphApiVersion: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly now: () => number;

  constructor(config: WhatsAppCloudApiClientConfig) {
    if (!config || typeof config !== "object") throw new WhatsAppCloudApiError("INVALID_CONFIG", "WhatsApp Cloud API config is required");
    if (typeof config.phoneNumberId !== "string" || !PHONE_NUMBER_ID.test(config.phoneNumberId)) throw new WhatsAppCloudApiError("INVALID_CONFIG", "phoneNumberId is malformed");
    if (typeof config.accessTokenProvider !== "function") throw new WhatsAppCloudApiError("INVALID_CONFIG", "accessTokenProvider is required");
    const version = config.graphApiVersion ?? DEFAULT_GRAPH_API_VERSION;
    if (!GRAPH_VERSION.test(version)) throw new WhatsAppCloudApiError("INVALID_CONFIG", "graphApiVersion must use vN.0 form");
    const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 250 || timeoutMs > 30_000) throw new WhatsAppCloudApiError("INVALID_CONFIG", "timeoutMs is outside the supported range");
    this.phoneNumberId = config.phoneNumberId;
    this.accessTokenProvider = config.accessTokenProvider;
    this.graphApiVersion = version;
    this.fetchImpl = config.fetchImpl ?? fetch;
    this.timeoutMs = timeoutMs;
    this.now = config.now ?? Date.now;
  }

  identity() {
    return Object.freeze({ provider: "WHATSAPP_CLOUD_API" as const, phoneNumberId: this.phoneNumberId, graphApiVersion: this.graphApiVersion });
  }

  async sendTemplate(input: WhatsAppTemplateMessageInput): Promise<WhatsAppSendReceipt> {
    const nowMs = this.now();
    const payload = buildWhatsAppTemplatePayload(input, nowMs);
    const token = accessToken(await this.accessTokenProvider());
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    let response: Response;
    try {
      response = await this.fetchImpl(`${GRAPH_BASE}/${this.graphApiVersion}/${this.phoneNumberId}/messages`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
          accept: "application/json",
        },
        body: JSON.stringify(payload),
        redirect: "error",
        signal: controller.signal,
      });
    } catch {
      throw new WhatsAppCloudApiError("AMBIGUOUS_OUTCOME", "WhatsApp message mutation failed before a definitive response; do not retry blindly");
    } finally {
      clearTimeout(timeout);
    }
    const body = await boundedJson(response);
    if (response.status === 401 || response.status === 403) throw new WhatsAppCloudApiError("AUTHENTICATION_FAILED", "WhatsApp authentication failed", response.status);
    if (response.status === 429) throw new WhatsAppCloudApiError("QUOTA_EXHAUSTED", "WhatsApp quota or rate limit was exhausted", response.status);
    if (response.status >= 500) throw new WhatsAppCloudApiError("AMBIGUOUS_OUTCOME", "WhatsApp server error leaves mutation outcome ambiguous; do not retry blindly", response.status);
    if (!response.ok) throw new WhatsAppCloudApiError("API_ERROR", "WhatsApp rejected the template message", response.status);
    return parseReceipt(body, this.graphApiVersion);
  }
}
