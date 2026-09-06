const DATA_MANAGER_INGEST_URL = "https://datamanager.googleapis.com/v1/events:ingest";
const MAX_RESPONSE_BYTES = 64 * 1024;
const NUMERIC_ID = /^\d{5,20}$/u;
const SHA256_HEX = /^[0-9a-f]{64}$/u;
const CURRENCY = /^[A-Z]{3}$/u;

export interface DataManagerAccessTokenProvider { (): Promise<string> }

export interface DataManagerDestination {
  readonly operatingAccountId: string;
  readonly conversionActionId: string;
  readonly loginAccountId?: string;
}

export interface DataManagerUserIdentifier {
  readonly hashedEmail?: string;
  readonly hashedPhoneNumber?: string;
}

export interface DataManagerConversionEvent {
  readonly transactionId: string;
  readonly eventTimestamp: string;
  readonly eventName: string;
  readonly eventSource: "WEB" | "APP" | "IN_STORE" | "PHONE" | "OTHER";
  readonly conversionValue?: number;
  readonly currency?: string;
  readonly gclid?: string;
  readonly userIdentifiers: readonly DataManagerUserIdentifier[];
}

export interface DataManagerIngestReceipt {
  readonly requestId: string;
}

export interface DataManagerRestConfig {
  readonly accessTokenProvider: DataManagerAccessTokenProvider;
  readonly fetchImpl?: typeof fetch;
  readonly timeoutMs?: number;
}

export class DataManagerApiError extends Error {
  constructor(
    public readonly code: "INVALID_CONFIG" | "AUTHENTICATION_FAILED" | "API_ERROR" | "INVALID_RESPONSE" | "TIMEOUT" | "AMBIGUOUS_OUTCOME",
    message: string,
    public readonly httpStatus: number | null = null,
  ) {
    super(message);
    this.name = "DataManagerApiError";
  }
}

function numericId(value: string, label: string): string {
  const normalized = value.replaceAll("-", "").trim();
  if (!NUMERIC_ID.test(normalized)) throw new DataManagerApiError("INVALID_CONFIG", `${label} is malformed`);
  return normalized;
}

function token(value: string): string {
  const normalized = value.trim();
  if (normalized.length < 16 || normalized.length > 8192) throw new DataManagerApiError("AUTHENTICATION_FAILED", "Data Manager access token is invalid");
  return normalized;
}

function destinationPayload(destination: DataManagerDestination) {
  const operatingAccountId = numericId(destination.operatingAccountId, "operatingAccountId");
  const conversionActionId = numericId(destination.conversionActionId, "conversionActionId");
  const loginAccountId = destination.loginAccountId === undefined ? undefined : numericId(destination.loginAccountId, "loginAccountId");
  return {
    reference: "google-ads-conversion",
    ...(loginAccountId === undefined ? {} : { loginAccount: { accountType: "GOOGLE_ADS", accountId: loginAccountId } }),
    operatingAccount: { accountType: "GOOGLE_ADS", accountId: operatingAccountId },
    productDestinationId: conversionActionId,
  };
}

function identifierPayload(identifier: DataManagerUserIdentifier) {
  const keys = Object.keys(identifier).filter((key) => identifier[key as keyof DataManagerUserIdentifier] !== undefined);
  if (keys.length !== 1) throw new DataManagerApiError("INVALID_CONFIG", "each Data Manager user identifier must contain exactly one identifier");
  if (identifier.hashedEmail !== undefined) {
    if (!SHA256_HEX.test(identifier.hashedEmail)) throw new DataManagerApiError("INVALID_CONFIG", "hashedEmail must be lowercase SHA-256 hex");
    return { emailAddress: identifier.hashedEmail };
  }
  if (identifier.hashedPhoneNumber !== undefined) {
    if (!SHA256_HEX.test(identifier.hashedPhoneNumber)) throw new DataManagerApiError("INVALID_CONFIG", "hashedPhoneNumber must be lowercase SHA-256 hex");
    return { phoneNumber: identifier.hashedPhoneNumber };
  }
  throw new DataManagerApiError("INVALID_CONFIG", "unsupported Data Manager user identifier");
}

function eventPayload(event: DataManagerConversionEvent) {
  if (!/^[A-Za-z0-9._:-]{8,128}$/u.test(event.transactionId)) throw new DataManagerApiError("INVALID_CONFIG", "transactionId is malformed");
  const occurredAt = new Date(event.eventTimestamp);
  if (!Number.isFinite(occurredAt.getTime()) || occurredAt.toISOString() !== event.eventTimestamp) throw new DataManagerApiError("INVALID_CONFIG", "eventTimestamp must be canonical UTC RFC3339");
  if (!/^[A-Za-z][A-Za-z0-9_]{0,63}$/u.test(event.eventName)) throw new DataManagerApiError("INVALID_CONFIG", "eventName is malformed");
  if (event.conversionValue !== undefined && (!Number.isFinite(event.conversionValue) || event.conversionValue < 0 || event.conversionValue > 1_000_000_000)) throw new DataManagerApiError("INVALID_CONFIG", "conversionValue is invalid");
  if (event.currency !== undefined && !CURRENCY.test(event.currency)) throw new DataManagerApiError("INVALID_CONFIG", "currency must be ISO-style uppercase code");
  if ((event.conversionValue === undefined) !== (event.currency === undefined)) throw new DataManagerApiError("INVALID_CONFIG", "conversionValue and currency must be provided together");
  if (event.gclid !== undefined && (event.gclid.length < 8 || event.gclid.length > 256 || /\s/u.test(event.gclid))) throw new DataManagerApiError("INVALID_CONFIG", "gclid is malformed");
  if (event.userIdentifiers.length > 5) throw new DataManagerApiError("INVALID_CONFIG", "at most five user identifiers are allowed");
  return {
    destinationReferences: ["google-ads-conversion"],
    transactionId: event.transactionId,
    eventTimestamp: event.eventTimestamp,
    eventName: event.eventName,
    eventSource: event.eventSource,
    ...(event.conversionValue === undefined ? {} : { conversionValue: event.conversionValue, currency: event.currency }),
    ...(event.gclid === undefined ? {} : { adIdentifiers: { gclid: event.gclid } }),
    ...(event.userIdentifiers.length === 0 ? {} : { userData: { userIdentifiers: event.userIdentifiers.map(identifierPayload) } }),
  };
}

async function boundedJson(response: Response): Promise<unknown> {
  const reader = response.body?.getReader();
  if (!reader) return null;
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      total += next.value.byteLength;
      if (total > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        throw new DataManagerApiError("INVALID_RESPONSE", "Data Manager response exceeded bounded size", response.status);
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
  if (!bytes.byteLength) return null;
  try { return JSON.parse(new TextDecoder().decode(bytes)) as unknown; }
  catch { throw new DataManagerApiError("INVALID_RESPONSE", "Data Manager returned malformed JSON", response.status); }
}

export class GoogleDataManagerRestClient {
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(private readonly config: DataManagerRestConfig) {
    this.fetchImpl = config.fetchImpl ?? fetch;
    this.timeoutMs = config.timeoutMs ?? 15_000;
    if (!Number.isSafeInteger(this.timeoutMs) || this.timeoutMs < 1_000 || this.timeoutMs > 120_000) throw new DataManagerApiError("INVALID_CONFIG", "timeoutMs must be 1000..120000");
  }

  async ingestConversion(destination: DataManagerDestination, event: DataManagerConversionEvent): Promise<DataManagerIngestReceipt> {
    const body = JSON.stringify({
      destinations: [destinationPayload(destination)],
      events: [eventPayload(event)],
      consent: { adUserData: "CONSENT_GRANTED" },
      encoding: "HEX",
      validateOnly: false,
    });
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let response: Response;
    try {
      const accessToken = token(await this.config.accessTokenProvider());
      response = await this.fetchImpl(DATA_MANAGER_INGEST_URL, {
        method: "POST",
        redirect: "error",
        signal: controller.signal,
        headers: {
          authorization: `Bearer ${accessToken}`,
          "content-type": "application/json",
          accept: "application/json",
        },
        body,
      });
    } catch (error) {
      if (controller.signal.aborted) throw new DataManagerApiError("TIMEOUT", "Data Manager request timed out");
      throw new DataManagerApiError("AMBIGUOUS_OUTCOME", error instanceof Error ? `Data Manager transport failed: ${error.message}` : "Data Manager transport failed");
    } finally {
      clearTimeout(timer);
    }
    const parsed = await boundedJson(response);
    if (response.status === 401 || response.status === 403) throw new DataManagerApiError("AUTHENTICATION_FAILED", "Data Manager authentication or authorization failed", response.status);
    if (!response.ok) throw new DataManagerApiError("API_ERROR", `Data Manager rejected ingestion with HTTP ${response.status}`, response.status);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) || typeof (parsed as Record<string, unknown>).requestId !== "string" || !(parsed as Record<string, unknown>).requestId) {
      throw new DataManagerApiError("INVALID_RESPONSE", "Data Manager response is missing requestId", response.status);
    }
    return Object.freeze({ requestId: (parsed as Record<string, string>).requestId });
  }
}
