import {
  GOOGLE_ADS_API_VERSION,
  type GoogleAdsAccessTokenProvider,
} from "../../bidding-supervisor/google-ads-rest.js";
import {
  GoogleDataManagerRestClient,
  type DataManagerDestination,
} from "../../enhanced-conversions/data-manager-rest.js";

const GOOGLE_ADS_BASE_URL = "https://googleads.googleapis.com";
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/u;
const NUMERIC_CUSTOMER_ID = /^\d{5,20}$/u;
const NUMERIC_RESOURCE_ID = /^\d{1,20}$/u;
const CLICK_ID = /^\S{8,256}$/u;
const CURRENCY = /^[A-Z]{3}$/u;
const EVENT_NAME = /^[A-Za-z][A-Za-z0-9_]{0,63}$/u;
const MAX_RESPONSE_BYTES = 128 * 1024;

export type QualifiedLeadStage = "QUALIFIED" | "PROPOSAL" | "WON";
export type OfflineConversionProvider = "GOOGLE_ADS_API" | "GOOGLE_DATA_MANAGER";

export type GoogleClickId =
  | { readonly kind: "gclid"; readonly value: string }
  | { readonly kind: "gbraid"; readonly value: string }
  | { readonly kind: "wbraid"; readonly value: string };

export interface OfflineConversionCandidate {
  readonly leadId: string;
  readonly occurredAt: string;
  readonly stage: QualifiedLeadStage;
  readonly conversionValue: number;
  readonly currencyCode: string;
  readonly invalidTrafficScore: number;
  readonly clickId: GoogleClickId;
  readonly adUserDataConsent: "GRANTED" | "DENIED";
}

export interface OfflineConversionQualificationPolicy {
  readonly minimumConversionValue: number;
  readonly maximumInvalidTrafficScore: number;
  readonly eligibleStages: readonly QualifiedLeadStage[];
}

export type OfflineConversionSkipReason = "BELOW_MINIMUM_VALUE" | "TRAFFIC_RISK_TOO_HIGH" | "STAGE_NOT_ELIGIBLE";

export interface QualifiedOfflineConversion {
  readonly orderId: string;
  readonly occurredAt: string;
  readonly stage: QualifiedLeadStage;
  readonly conversionValue: number;
  readonly currencyCode: string;
  readonly invalidTrafficScore: number;
  readonly clickId: GoogleClickId;
  readonly adUserDataConsent: "GRANTED" | "DENIED";
}

export type OfflineConversionQualification =
  | { readonly eligible: true; readonly conversion: QualifiedOfflineConversion }
  | { readonly eligible: false; readonly reasons: readonly OfflineConversionSkipReason[] };

export interface OfflineConversionUploadOptions {
  readonly validateOnly?: boolean;
  readonly jobId?: number;
}

export interface OfflineConversionReceipt {
  readonly provider: OfflineConversionProvider;
  readonly requestId: string | null;
  readonly jobId: string | null;
  readonly status: "UPLOADED" | "VALIDATED";
}

export interface OfflineConversionSink {
  upload(conversion: QualifiedOfflineConversion, options?: OfflineConversionUploadOptions): Promise<OfflineConversionReceipt>;
}

export type QualifiedOfflineConversionEngineResult =
  | { readonly status: "SKIPPED"; readonly reasons: readonly OfflineConversionSkipReason[] }
  | { readonly status: "SENT"; readonly receipt: OfflineConversionReceipt };

export class OfflineConversionError extends Error {
  constructor(
    public readonly code:
      | "INVALID_CONFIG"
      | "INVALID_INPUT"
      | "AUTHENTICATION_FAILED"
      | "QUOTA_EXHAUSTED"
      | "API_ERROR"
      | "PARTIAL_FAILURE"
      | "INVALID_RESPONSE"
      | "TIMEOUT"
      | "AMBIGUOUS_OUTCOME"
      | "LEGACY_API_RESTRICTED",
    message: string,
    public readonly httpStatus: number | null = null,
    public readonly requestId: string | null = null,
  ) {
    super(message);
    this.name = "OfflineConversionError";
  }
}

function canonicalUtc(value: string, label: string): string {
  if (typeof value !== "string") throw new OfflineConversionError("INVALID_INPUT", `${label} must be a string`);
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== value) throw new OfflineConversionError("INVALID_INPUT", `${label} must be canonical UTC RFC3339`);
  return value;
}

function numericCustomerId(value: string, label: string): string {
  const normalized = value.replaceAll("-", "").trim();
  if (!NUMERIC_CUSTOMER_ID.test(normalized)) throw new OfflineConversionError("INVALID_CONFIG", `${label} is malformed`);
  return normalized;
}

function numericResourceId(value: string, label: string): string {
  const normalized = value.trim();
  if (!NUMERIC_RESOURCE_ID.test(normalized)) throw new OfflineConversionError("INVALID_CONFIG", `${label} is malformed`);
  return normalized;
}

function secret(value: string, label: string): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > 8192 || /[\r\n\0]/u.test(normalized)) throw new OfflineConversionError("INVALID_CONFIG", `${label} is missing or malformed`);
  return normalized;
}

function validateClickId(clickId: GoogleClickId): GoogleClickId {
  if (!clickId || typeof clickId !== "object" || !CLICK_ID.test(clickId.value)) throw new OfflineConversionError("INVALID_INPUT", "Google click identifier is malformed");
  if (!(clickId.kind === "gclid" || clickId.kind === "gbraid" || clickId.kind === "wbraid")) throw new OfflineConversionError("INVALID_INPUT", "Google click identifier kind is unsupported");
  return Object.freeze({ kind: clickId.kind, value: clickId.value });
}

function validateCandidate(candidate: OfflineConversionCandidate): QualifiedOfflineConversion {
  if (!candidate || typeof candidate !== "object") throw new OfflineConversionError("INVALID_INPUT", "offline conversion candidate is required");
  if (!ID.test(candidate.leadId)) throw new OfflineConversionError("INVALID_INPUT", "leadId is malformed");
  canonicalUtc(candidate.occurredAt, "occurredAt");
  if (!(candidate.stage === "QUALIFIED" || candidate.stage === "PROPOSAL" || candidate.stage === "WON")) throw new OfflineConversionError("INVALID_INPUT", "lead stage is invalid");
  if (!Number.isFinite(candidate.conversionValue) || candidate.conversionValue < 0 || candidate.conversionValue > 1_000_000_000) throw new OfflineConversionError("INVALID_INPUT", "conversionValue is invalid");
  if (!CURRENCY.test(candidate.currencyCode)) throw new OfflineConversionError("INVALID_INPUT", "currencyCode must be an uppercase ISO 4217 code");
  if (!Number.isInteger(candidate.invalidTrafficScore) || candidate.invalidTrafficScore < 0 || candidate.invalidTrafficScore > 1_000) throw new OfflineConversionError("INVALID_INPUT", "invalidTrafficScore must be an integer from 0 to 1000");
  if (!(candidate.adUserDataConsent === "GRANTED" || candidate.adUserDataConsent === "DENIED")) throw new OfflineConversionError("INVALID_INPUT", "adUserDataConsent is invalid");
  const clickId = validateClickId(candidate.clickId);
  return Object.freeze({
    orderId: candidate.leadId,
    occurredAt: candidate.occurredAt,
    stage: candidate.stage,
    conversionValue: candidate.conversionValue,
    currencyCode: candidate.currencyCode,
    invalidTrafficScore: candidate.invalidTrafficScore,
    clickId,
    adUserDataConsent: candidate.adUserDataConsent,
  });
}

function validatePolicy(policy: OfflineConversionQualificationPolicy): Readonly<OfflineConversionQualificationPolicy> {
  if (!policy || typeof policy !== "object") throw new OfflineConversionError("INVALID_CONFIG", "offline conversion qualification policy is required");
  if (!Number.isFinite(policy.minimumConversionValue) || policy.minimumConversionValue < 0 || policy.minimumConversionValue > 1_000_000_000) throw new OfflineConversionError("INVALID_CONFIG", "minimumConversionValue is invalid");
  if (!Number.isInteger(policy.maximumInvalidTrafficScore) || policy.maximumInvalidTrafficScore < 0 || policy.maximumInvalidTrafficScore > 1_000) throw new OfflineConversionError("INVALID_CONFIG", "maximumInvalidTrafficScore must be an integer from 0 to 1000");
  if (!Array.isArray(policy.eligibleStages) || policy.eligibleStages.length < 1 || policy.eligibleStages.length > 3) throw new OfflineConversionError("INVALID_CONFIG", "eligibleStages must contain at least one supported stage");
  const stages = policy.eligibleStages.map((stage) => {
    if (!(stage === "QUALIFIED" || stage === "PROPOSAL" || stage === "WON")) throw new OfflineConversionError("INVALID_CONFIG", "eligibleStages contains an invalid stage");
    return stage;
  });
  if (new Set(stages).size !== stages.length) throw new OfflineConversionError("INVALID_CONFIG", "eligibleStages contains duplicates");
  return Object.freeze({
    minimumConversionValue: policy.minimumConversionValue,
    maximumInvalidTrafficScore: policy.maximumInvalidTrafficScore,
    eligibleStages: Object.freeze(stages),
  });
}

export function qualifyOfflineConversion(candidateInput: OfflineConversionCandidate, policyInput: OfflineConversionQualificationPolicy): OfflineConversionQualification {
  const candidate = validateCandidate(candidateInput);
  const policy = validatePolicy(policyInput);
  const reasons: OfflineConversionSkipReason[] = [];
  if (candidate.conversionValue < policy.minimumConversionValue) reasons.push("BELOW_MINIMUM_VALUE");
  if (candidate.invalidTrafficScore > policy.maximumInvalidTrafficScore) reasons.push("TRAFFIC_RISK_TOO_HIGH");
  if (!policy.eligibleStages.includes(candidate.stage)) reasons.push("STAGE_NOT_ELIGIBLE");
  if (reasons.length) return Object.freeze({ eligible: false, reasons: Object.freeze(reasons) });
  return Object.freeze({ eligible: true, conversion: candidate });
}

export class QualifiedOfflineConversionEngine {
  private readonly policy: Readonly<OfflineConversionQualificationPolicy>;

  constructor(policy: OfflineConversionQualificationPolicy, private readonly sink: OfflineConversionSink) {
    this.policy = validatePolicy(policy);
    if (!sink || typeof sink.upload !== "function") throw new OfflineConversionError("INVALID_CONFIG", "offline conversion sink is required");
  }

  async process(candidate: OfflineConversionCandidate, options?: OfflineConversionUploadOptions): Promise<QualifiedOfflineConversionEngineResult> {
    const qualification = qualifyOfflineConversion(candidate, this.policy);
    if (!qualification.eligible) return Object.freeze({ status: "SKIPPED", reasons: qualification.reasons });
    const receipt = await this.sink.upload(qualification.conversion, options);
    return Object.freeze({ status: "SENT", receipt });
  }
}

function googleAdsDateTime(occurredAt: string): string {
  const iso = canonicalUtc(occurredAt, "occurredAt");
  return `${iso.slice(0, 10)} ${iso.slice(11, 19)}+00:00`;
}

function boundedTimeout(value: number | undefined): number {
  const timeoutMs = value ?? 15_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 120_000) throw new OfflineConversionError("INVALID_CONFIG", "timeoutMs must be 1000..120000");
  return timeoutMs;
}

async function boundedJson(response: Response): Promise<unknown> {
  const declared = response.headers.get("content-length");
  if (declared !== null && (!/^\d+$/u.test(declared) || Number(declared) > MAX_RESPONSE_BYTES)) throw new OfflineConversionError("INVALID_RESPONSE", "Google Ads response declared an invalid or oversized body", response.status, response.headers.get("request-id"));
  if (!response.body) return null;
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
        throw new OfflineConversionError("INVALID_RESPONSE", "Google Ads response exceeded bounded size", response.status, response.headers.get("request-id"));
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  if (!total) return null;
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
  } catch {
    throw new OfflineConversionError("INVALID_RESPONSE", "Google Ads returned malformed JSON", response.status, response.headers.get("request-id"));
  }
}

function object(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function googleError(payload: unknown): { readonly status: string | null; readonly message: string; readonly restricted: boolean } {
  const root = object(payload);
  const error = object(root?.error);
  const status = typeof error?.status === "string" ? error.status : null;
  const rawMessage = typeof error?.message === "string" ? error.message : "Google Ads API request failed";
  const message = rawMessage.slice(0, 500);
  const serialized = JSON.stringify(payload ?? "");
  return Object.freeze({
    status,
    message,
    restricted: message.includes("CUSTOMER_NOT_ALLOWLISTED_FOR_THIS_FEATURE") || serialized.includes("CUSTOMER_NOT_ALLOWLISTED_FOR_THIS_FEATURE"),
  });
}

function jobIdFromPayload(payload: unknown): string | null {
  const root = object(payload);
  const value = root?.jobId;
  if (typeof value === "string" && /^\d+$/u.test(value)) return value;
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return String(value);
  return null;
}

function partialFailureMessage(payload: unknown): string | null {
  const root = object(payload);
  const failure = object(root?.partialFailureError);
  if (!failure) return null;
  const message = typeof failure.message === "string" && failure.message ? failure.message : "Google Ads rejected the offline conversion in partial-failure mode";
  return message.slice(0, 500);
}

function validateJobId(value: number | undefined): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || value < 0 || value >= 2 ** 31) throw new OfflineConversionError("INVALID_INPUT", "jobId must be an integer in [0, 2^31)");
  return value;
}

export interface GoogleAdsOfflineConversionClientConfig {
  readonly developerToken: string;
  readonly customerId: string;
  readonly conversionActionId: string;
  readonly loginCustomerId?: string;
  readonly accessTokenProvider: GoogleAdsAccessTokenProvider;
  readonly apiVersion?: `v${number}`;
  readonly fetchImpl?: typeof fetch;
  readonly timeoutMs?: number;
}

export class GoogleAdsOfflineConversionClient implements OfflineConversionSink {
  private readonly developerToken: string;
  private readonly customerId: string;
  private readonly conversionActionId: string;
  private readonly loginCustomerId: string | null;
  private readonly apiVersion: `v${number}`;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(private readonly config: GoogleAdsOfflineConversionClientConfig) {
    this.developerToken = secret(config.developerToken, "developerToken");
    this.customerId = numericCustomerId(config.customerId, "customerId");
    this.conversionActionId = numericResourceId(config.conversionActionId, "conversionActionId");
    this.loginCustomerId = config.loginCustomerId === undefined ? null : numericCustomerId(config.loginCustomerId, "loginCustomerId");
    if (typeof config.accessTokenProvider !== "function") throw new OfflineConversionError("INVALID_CONFIG", "accessTokenProvider is required");
    const apiVersion = config.apiVersion ?? GOOGLE_ADS_API_VERSION;
    if (!/^v\d{1,3}$/u.test(apiVersion)) throw new OfflineConversionError("INVALID_CONFIG", "apiVersion is malformed");
    this.apiVersion = apiVersion as `v${number}`;
    this.fetchImpl = config.fetchImpl ?? fetch;
    this.timeoutMs = boundedTimeout(config.timeoutMs);
  }

  async upload(conversionInput: QualifiedOfflineConversion, options: OfflineConversionUploadOptions = {}): Promise<OfflineConversionReceipt> {
    const conversion = validateCandidate({
      leadId: conversionInput.orderId,
      occurredAt: conversionInput.occurredAt,
      stage: conversionInput.stage,
      conversionValue: conversionInput.conversionValue,
      currencyCode: conversionInput.currencyCode,
      invalidTrafficScore: conversionInput.invalidTrafficScore,
      clickId: conversionInput.clickId,
      adUserDataConsent: conversionInput.adUserDataConsent,
    });
    const jobId = validateJobId(options.jobId);
    const validateOnly = options.validateOnly === true;
    const clickField = { [conversion.clickId.kind]: conversion.clickId.value };
    const payload = {
      conversions: [{
        conversionAction: `customers/${this.customerId}/conversionActions/${this.conversionActionId}`,
        ...clickField,
        conversionValue: conversion.conversionValue,
        conversionDateTime: googleAdsDateTime(conversion.occurredAt),
        currencyCode: conversion.currencyCode,
        orderId: conversion.orderId,
        consent: { adUserData: conversion.adUserDataConsent },
      }],
      partialFailure: true,
      validateOnly,
      ...(jobId === undefined ? {} : { jobId }),
    };

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let response: Response;
    let parsed: unknown;
    try {
      const accessToken = secret(await this.config.accessTokenProvider(), "OAuth access token");
      const headers: Record<string, string> = {
        authorization: `Bearer ${accessToken}`,
        "content-type": "application/json",
        accept: "application/json",
        "developer-token": this.developerToken,
      };
      if (this.loginCustomerId) headers["login-customer-id"] = this.loginCustomerId;
      response = await this.fetchImpl(`${GOOGLE_ADS_BASE_URL}/${this.apiVersion}/customers/${this.customerId}:uploadClickConversions`, {
        method: "POST",
        headers,
        body: JSON.stringify(payload),
        redirect: "error",
        signal: controller.signal,
      });
      parsed = await boundedJson(response);
    } catch (error) {
      if (error instanceof OfflineConversionError) throw error;
      if (controller.signal.aborted) throw new OfflineConversionError("TIMEOUT", "Google Ads offline conversion upload timed out");
      throw new OfflineConversionError("AMBIGUOUS_OUTCOME", error instanceof Error ? `Google Ads offline conversion transport failed: ${error.message}` : "Google Ads offline conversion transport failed");
    } finally {
      clearTimeout(timer);
    }

    const requestId = response.headers.get("request-id");
    if (!response.ok) {
      const detail = googleError(parsed);
      if (detail.restricted) throw new OfflineConversionError("LEGACY_API_RESTRICTED", "Google Ads rejected legacy offline conversion upload for this developer token; use the Data Manager API sink", response.status, requestId);
      if (response.status === 401 || response.status === 403) throw new OfflineConversionError("AUTHENTICATION_FAILED", detail.message, response.status, requestId);
      if (response.status === 429 || detail.status === "RESOURCE_EXHAUSTED") throw new OfflineConversionError("QUOTA_EXHAUSTED", detail.message, response.status, requestId);
      if (response.status >= 500) throw new OfflineConversionError("AMBIGUOUS_OUTCOME", "Google Ads returned a server error; remote application of the conversion is unconfirmed", response.status, requestId);
      throw new OfflineConversionError("API_ERROR", detail.message, response.status, requestId);
    }

    const partialFailure = partialFailureMessage(parsed);
    if (partialFailure) throw new OfflineConversionError("PARTIAL_FAILURE", partialFailure, response.status, requestId);
    const root = object(parsed);
    if (!root) throw new OfflineConversionError("INVALID_RESPONSE", "Google Ads success response must be a JSON object", response.status, requestId);
    if (!validateOnly) {
      const results = root.results;
      if (!Array.isArray(results) || results.length !== 1 || !object(results[0]) || Object.keys(object(results[0])!).length === 0) throw new OfflineConversionError("INVALID_RESPONSE", "Google Ads response is missing the successful conversion result", response.status, requestId);
    }
    return Object.freeze({
      provider: "GOOGLE_ADS_API",
      requestId,
      jobId: jobIdFromPayload(parsed),
      status: validateOnly ? "VALIDATED" : "UPLOADED",
    });
  }
}

export interface GoogleDataManagerOfflineConversionSinkConfig {
  readonly client: GoogleDataManagerRestClient;
  readonly destination: DataManagerDestination;
  readonly eventName?: string;
  readonly eventSource?: "WEB" | "APP" | "IN_STORE" | "PHONE" | "OTHER";
}

export class GoogleDataManagerOfflineConversionSink implements OfflineConversionSink {
  private readonly eventName: string;
  private readonly eventSource: "WEB" | "APP" | "IN_STORE" | "PHONE" | "OTHER";

  constructor(private readonly config: GoogleDataManagerOfflineConversionSinkConfig) {
    if (!(config.client instanceof GoogleDataManagerRestClient)) throw new OfflineConversionError("INVALID_CONFIG", "Google Data Manager client is required");
    this.eventName = config.eventName ?? "qualified_lead";
    if (!EVENT_NAME.test(this.eventName)) throw new OfflineConversionError("INVALID_CONFIG", "Data Manager eventName is malformed");
    this.eventSource = config.eventSource ?? "WEB";
    if (!(this.eventSource === "WEB" || this.eventSource === "APP" || this.eventSource === "IN_STORE" || this.eventSource === "PHONE" || this.eventSource === "OTHER")) throw new OfflineConversionError("INVALID_CONFIG", "Data Manager eventSource is invalid");
  }

  async upload(conversionInput: QualifiedOfflineConversion, options: OfflineConversionUploadOptions = {}): Promise<OfflineConversionReceipt> {
    if (options.jobId !== undefined) throw new OfflineConversionError("INVALID_INPUT", "jobId is only supported by the Google Ads API sink");
    if (options.validateOnly === true) throw new OfflineConversionError("INVALID_INPUT", "validateOnly is not exposed by the existing Data Manager sink contract");
    const conversion = validateCandidate({
      leadId: conversionInput.orderId,
      occurredAt: conversionInput.occurredAt,
      stage: conversionInput.stage,
      conversionValue: conversionInput.conversionValue,
      currencyCode: conversionInput.currencyCode,
      invalidTrafficScore: conversionInput.invalidTrafficScore,
      clickId: conversionInput.clickId,
      adUserDataConsent: conversionInput.adUserDataConsent,
    });
    const click = { [conversion.clickId.kind]: conversion.clickId.value };
    const receipt = await this.config.client.ingestConversion(this.config.destination, {
      transactionId: conversion.orderId,
      eventTimestamp: conversion.occurredAt,
      eventName: this.eventName,
      eventSource: this.eventSource,
      adUserDataConsent: conversion.adUserDataConsent,
      conversionValue: conversion.conversionValue,
      currency: conversion.currencyCode,
      ...click,
      userIdentifiers: [],
    });
    return Object.freeze({ provider: "GOOGLE_DATA_MANAGER", requestId: receipt.requestId, jobId: null, status: "UPLOADED" });
  }
}
