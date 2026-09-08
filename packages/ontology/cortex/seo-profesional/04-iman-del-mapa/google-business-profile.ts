const BUSINESS_INFORMATION_BASE = "https://mybusinessbusinessinformation.googleapis.com/v1";
const LOCATION_NAME = /^locations\/[A-Za-z0-9_-]{1,128}$/u;
const COUNTRY = /^[A-Z]{2}$/u;
const MAX_RESPONSE_BYTES = 1024 * 1024;
const DEFAULT_READ_MASK = Object.freeze([
  "name",
  "title",
  "websiteUri",
  "phoneNumbers",
  "storefrontAddress",
  "metadata",
] as const);
const ALLOWED_UPDATE_MASKS = new Set([
  "title",
  "websiteUri",
  "phoneNumbers.primaryPhone",
  "storefrontAddress",
] as const);
const ALLOWED_PATCH_KEYS = new Set(["title", "websiteUri", "phoneNumbers", "storefrontAddress"]);

export type GoogleBusinessProfileAccessTokenProvider = () => Promise<string>;
export type GoogleBusinessProfileExecutionMode = "VALIDATE_ONLY" | "APPLY";
export type GoogleBusinessProfileUpdateField =
  | "title"
  | "websiteUri"
  | "phoneNumbers.primaryPhone"
  | "storefrontAddress";

export interface GoogleBusinessProfilePostalAddress {
  readonly regionCode: string;
  readonly addressLines: readonly string[];
  readonly locality?: string;
  readonly administrativeArea?: string;
  readonly postalCode?: string;
}

export interface GoogleBusinessProfileLocation {
  readonly name: string;
  readonly title: string | null;
  readonly websiteUri: string | null;
  readonly phoneNumbers: Readonly<{ primaryPhone: string | null }>;
  readonly storefrontAddress: GoogleBusinessProfilePostalAddress | null;
  readonly metadata: Readonly<{
    canUpdate: boolean | null;
    hasGoogleUpdated: boolean | null;
    mapsUri: string | null;
    placeId: string | null;
  }>;
}

export interface GoogleBusinessProfilePatch {
  readonly title?: string;
  readonly websiteUri?: string;
  readonly phoneNumbers?: Readonly<{ primaryPhone: string }>;
  readonly storefrontAddress?: GoogleBusinessProfilePostalAddress;
}

export interface GoogleBusinessProfileGoogleUpdated {
  readonly location: GoogleBusinessProfileLocation;
  readonly diffMask: readonly string[];
  readonly pendingMask: readonly string[];
}

export interface GoogleBusinessProfileClientConfig {
  readonly accessTokenProvider: GoogleBusinessProfileAccessTokenProvider;
  readonly fetchImpl?: typeof fetch;
  readonly timeoutMs?: number;
  readonly maxReadRetries?: number;
  readonly sleep?: (ms: number) => Promise<void>;
}

export class GoogleBusinessProfileError extends Error {
  constructor(
    public readonly code:
      | "INVALID_CONFIG"
      | "INVALID_INPUT"
      | "AUTHENTICATION_FAILED"
      | "QUOTA_EXHAUSTED"
      | "API_ERROR"
      | "INVALID_RESPONSE"
      | "TIMEOUT"
      | "AMBIGUOUS_OUTCOME",
    message: string,
    public readonly httpStatus: number | null = null,
  ) {
    super(message);
    this.name = "GoogleBusinessProfileError";
  }
}

function containsControlCharacters(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

function requiredText(value: unknown, label: string, max = 4096): string {
  if (typeof value !== "string") throw new GoogleBusinessProfileError("INVALID_RESPONSE", `${label} must be a string`);
  const normalized = value.normalize("NFKC").trim();
  if (!normalized || normalized.length > max || containsControlCharacters(normalized)) {
    throw new GoogleBusinessProfileError("INVALID_RESPONSE", `${label} is empty, oversized, or malformed`);
  }
  return normalized;
}

function inputText(value: unknown, label: string, max = 4096): string {
  if (typeof value !== "string") throw new GoogleBusinessProfileError("INVALID_INPUT", `${label} must be a string`);
  const normalized = value.normalize("NFKC").replace(/\s+/gu, " ").trim();
  if (!normalized || normalized.length > max || containsControlCharacters(normalized)) {
    throw new GoogleBusinessProfileError("INVALID_INPUT", `${label} is empty, oversized, or malformed`);
  }
  return normalized;
}

function inputWebsite(value: unknown): string {
  const normalized = inputText(value, "websiteUri", 2048);
  let url: URL;
  try {
    url = new URL(normalized);
  } catch {
    throw new GoogleBusinessProfileError("INVALID_INPUT", "websiteUri must be an absolute URL");
  }
  if (!(url.protocol === "https:" || url.protocol === "http:") || url.username || url.password || url.search || url.hash) {
    throw new GoogleBusinessProfileError("INVALID_INPUT", "websiteUri must be an http(s) URL without credentials, query, or fragment");
  }
  return url.href;
}

function optionalText(value: unknown, label: string, max = 4096): string | null {
  if (value === undefined || value === null || value === "") return null;
  return requiredText(value, label, max);
}

function token(value: string): string {
  if (typeof value !== "string") throw new GoogleBusinessProfileError("AUTHENTICATION_FAILED", "OAuth access token is missing");
  const normalized = value.trim();
  if (normalized.length < 16 || normalized.length > 8192 || containsControlCharacters(normalized)) {
    throw new GoogleBusinessProfileError("AUTHENTICATION_FAILED", "OAuth access token is malformed");
  }
  return normalized;
}

function locationName(value: string): string {
  if (typeof value !== "string" || !LOCATION_NAME.test(value)) throw new GoogleBusinessProfileError("INVALID_INPUT", "locationName must use locations/{locationId}");
  return value;
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new GoogleBusinessProfileError("INVALID_RESPONSE", `${label} must be an object`);
  return value as Record<string, unknown>;
}

function optionalObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function booleanOrNull(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

function postalAddress(value: unknown): GoogleBusinessProfilePostalAddress | null {
  const raw = optionalObject(value);
  if (!raw) return null;
  const lines = raw.addressLines;
  if (!Array.isArray(lines) || lines.some((line) => typeof line !== "string")) throw new GoogleBusinessProfileError("INVALID_RESPONSE", "storefrontAddress.addressLines is malformed");
  const regionCode = optionalText(raw.regionCode, "storefrontAddress.regionCode", 8);
  if (!regionCode) throw new GoogleBusinessProfileError("INVALID_RESPONSE", "storefrontAddress.regionCode is missing");
  return Object.freeze({
    regionCode,
    addressLines: Object.freeze(lines.map((line, index) => requiredText(line, `storefrontAddress.addressLines[${index}]`, 200))),
    ...(raw.locality === undefined || raw.locality === "" ? {} : { locality: requiredText(raw.locality, "storefrontAddress.locality", 200) }),
    ...(raw.administrativeArea === undefined || raw.administrativeArea === "" ? {} : { administrativeArea: requiredText(raw.administrativeArea, "storefrontAddress.administrativeArea", 200) }),
    ...(raw.postalCode === undefined || raw.postalCode === "" ? {} : { postalCode: requiredText(raw.postalCode, "storefrontAddress.postalCode", 64) }),
  });
}

function inputPostalAddress(value: unknown): GoogleBusinessProfilePostalAddress {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new GoogleBusinessProfileError("INVALID_INPUT", "storefrontAddress must be an object");
  const raw = value as Record<string, unknown>;
  const allowed = new Set(["regionCode", "addressLines", "locality", "administrativeArea", "postalCode"]);
  for (const key of Object.keys(raw)) if (!allowed.has(key)) throw new GoogleBusinessProfileError("INVALID_INPUT", `unsupported storefrontAddress field ${key}`);
  const regionCode = inputText(raw.regionCode, "storefrontAddress.regionCode", 2).toUpperCase();
  if (!COUNTRY.test(regionCode)) throw new GoogleBusinessProfileError("INVALID_INPUT", "storefrontAddress.regionCode must use ISO alpha-2 form");
  if (!Array.isArray(raw.addressLines) || raw.addressLines.length < 1 || raw.addressLines.length > 3) throw new GoogleBusinessProfileError("INVALID_INPUT", "storefrontAddress.addressLines must contain 1..3 lines");
  const addressLines = Object.freeze(raw.addressLines.map((line, index) => inputText(line, `storefrontAddress.addressLines[${index}]`, 120)));
  return Object.freeze({
    regionCode,
    addressLines,
    ...(raw.locality === undefined ? {} : { locality: inputText(raw.locality, "storefrontAddress.locality", 100) }),
    ...(raw.administrativeArea === undefined ? {} : { administrativeArea: inputText(raw.administrativeArea, "storefrontAddress.administrativeArea", 100) }),
    ...(raw.postalCode === undefined ? {} : { postalCode: inputText(raw.postalCode, "storefrontAddress.postalCode", 24) }),
  });
}

function parseLocation(payload: unknown, expectedName: string): GoogleBusinessProfileLocation {
  const root = object(payload, "Business Profile location");
  const name = requiredText(root.name, "location.name", 256);
  if (name !== expectedName) throw new GoogleBusinessProfileError("INVALID_RESPONSE", "Business Profile returned a different location resource");
  const phones = optionalObject(root.phoneNumbers);
  const metadata = optionalObject(root.metadata);
  return Object.freeze({
    name,
    title: optionalText(root.title, "location.title", 300),
    websiteUri: optionalText(root.websiteUri, "location.websiteUri", 2048),
    phoneNumbers: Object.freeze({ primaryPhone: optionalText(phones?.primaryPhone, "location.phoneNumbers.primaryPhone", 64) }),
    storefrontAddress: postalAddress(root.storefrontAddress),
    metadata: Object.freeze({
      canUpdate: booleanOrNull(metadata?.canUpdate),
      hasGoogleUpdated: booleanOrNull(metadata?.hasGoogleUpdated),
      mapsUri: optionalText(metadata?.mapsUri ?? metadata?.mapsUrl, "location.metadata.mapsUri", 4096),
      placeId: optionalText(metadata?.placeId, "location.metadata.placeId", 256),
    }),
  });
}

function fieldMask(value: unknown): readonly string[] {
  if (value === undefined || value === null || value === "") return Object.freeze([]);
  if (typeof value === "string") return Object.freeze(value.split(",").map((item) => item.trim()).filter(Boolean));
  const raw = optionalObject(value);
  const paths = raw?.paths;
  if (Array.isArray(paths) && paths.every((path) => typeof path === "string")) return Object.freeze(paths.map((path) => path.trim()).filter(Boolean));
  throw new GoogleBusinessProfileError("INVALID_RESPONSE", "Business Profile field mask is malformed");
}

async function boundedJson(response: Response): Promise<unknown> {
  const declared = response.headers.get("content-length");
  if (declared !== null && (!/^\d+$/u.test(declared) || Number(declared) > MAX_RESPONSE_BYTES)) {
    throw new GoogleBusinessProfileError("INVALID_RESPONSE", "Business Profile response declared an invalid or oversized body", response.status);
  }
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
        throw new GoogleBusinessProfileError("INVALID_RESPONSE", "Business Profile response exceeded the bounded body size", response.status);
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  if (total === 0) return null;
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
  } catch {
    throw new GoogleBusinessProfileError("INVALID_RESPONSE", "Business Profile returned malformed JSON", response.status);
  }
}

function retryAfterMs(value: string | null): number | null {
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(60_000, Math.ceil(seconds * 1000));
  const absolute = Date.parse(value);
  return Number.isFinite(absolute) ? Math.min(60_000, Math.max(0, absolute - Date.now())) : null;
}

async function defaultSleep(ms: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, ms));
}

function errorMessage(payload: unknown): string {
  const root = optionalObject(payload);
  const error = optionalObject(root?.error);
  return typeof error?.message === "string" && error.message ? error.message.slice(0, 500) : "Google Business Profile API request failed";
}

function validateUpdateMask(values: readonly GoogleBusinessProfileUpdateField[]): readonly GoogleBusinessProfileUpdateField[] {
  if (!Array.isArray(values) || values.length < 1 || values.length > ALLOWED_UPDATE_MASKS.size) {
    throw new GoogleBusinessProfileError("INVALID_INPUT", "updateMask must contain 1..4 supported fields");
  }
  const unique = [...new Set(values)];
  for (const value of unique) if (!ALLOWED_UPDATE_MASKS.has(value)) throw new GoogleBusinessProfileError("INVALID_INPUT", `unsupported update field ${value}`);
  return Object.freeze(unique);
}

function validatePatch(patch: GoogleBusinessProfilePatch, mask: readonly GoogleBusinessProfileUpdateField[]): GoogleBusinessProfilePatch {
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) throw new GoogleBusinessProfileError("INVALID_INPUT", "location patch is required");
  const raw = patch as Record<string, unknown>;
  for (const key of Object.keys(raw)) if (!ALLOWED_PATCH_KEYS.has(key)) throw new GoogleBusinessProfileError("INVALID_INPUT", `unsupported patch field ${key}`);
  const allowedTopLevelForMask = new Set(mask.map((field) => field === "phoneNumbers.primaryPhone" ? "phoneNumbers" : field));
  for (const key of Object.keys(raw)) if (!allowedTopLevelForMask.has(key)) throw new GoogleBusinessProfileError("INVALID_INPUT", `patch field ${key} is not present in updateMask`);

  const normalized: {
    title?: string;
    websiteUri?: string;
    phoneNumbers?: Readonly<{ primaryPhone: string }>;
    storefrontAddress?: GoogleBusinessProfilePostalAddress;
  } = {};
  if (mask.includes("title")) normalized.title = inputText(raw.title, "title", 300);
  if (mask.includes("websiteUri")) normalized.websiteUri = inputWebsite(raw.websiteUri);
  if (mask.includes("phoneNumbers.primaryPhone")) {
    const phones = raw.phoneNumbers;
    if (!phones || typeof phones !== "object" || Array.isArray(phones)) throw new GoogleBusinessProfileError("INVALID_INPUT", "phoneNumbers is required by updateMask");
    const phoneRecord = phones as Record<string, unknown>;
    if (Object.keys(phoneRecord).some((key) => key !== "primaryPhone")) throw new GoogleBusinessProfileError("INVALID_INPUT", "phoneNumbers contains unsupported fields");
    normalized.phoneNumbers = Object.freeze({ primaryPhone: inputText(phoneRecord.primaryPhone, "phoneNumbers.primaryPhone", 64) });
  }
  if (mask.includes("storefrontAddress")) normalized.storefrontAddress = inputPostalAddress(raw.storefrontAddress);
  return Object.freeze(normalized);
}

export class GoogleBusinessProfileClient {
  private readonly accessTokenProvider: GoogleBusinessProfileAccessTokenProvider;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly maxReadRetries: number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(config: GoogleBusinessProfileClientConfig) {
    if (!config || typeof config !== "object" || typeof config.accessTokenProvider !== "function") {
      throw new GoogleBusinessProfileError("INVALID_CONFIG", "accessTokenProvider is required");
    }
    this.accessTokenProvider = config.accessTokenProvider;
    this.fetchImpl = config.fetchImpl ?? fetch;
    this.timeoutMs = config.timeoutMs ?? 20_000;
    if (!Number.isSafeInteger(this.timeoutMs) || this.timeoutMs < 1000 || this.timeoutMs > 120_000) throw new GoogleBusinessProfileError("INVALID_CONFIG", "timeoutMs must be 1000..120000");
    this.maxReadRetries = config.maxReadRetries ?? 2;
    if (!Number.isSafeInteger(this.maxReadRetries) || this.maxReadRetries < 0 || this.maxReadRetries > 5) throw new GoogleBusinessProfileError("INVALID_CONFIG", "maxReadRetries must be 0..5");
    this.sleep = config.sleep ?? defaultSleep;
  }

  private async request(url: string, init: RequestInit, retrySafe: boolean, validateOnly = false): Promise<unknown> {
    const attempts = retrySafe ? this.maxReadRetries + 1 : 1;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      const accessToken = token(await this.accessTokenProvider());
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);
      try {
        const response = await this.fetchImpl(url, {
          ...init,
          headers: {
            accept: "application/json",
            ...(init.body === undefined ? {} : { "content-type": "application/json" }),
            authorization: `Bearer ${accessToken}`,
            ...(init.headers ?? {}),
          },
          signal: controller.signal,
          redirect: "error",
        });
        const payload = await boundedJson(response);
        if (response.ok) return payload;
        if (retrySafe && (response.status === 429 || response.status >= 500) && attempt + 1 < attempts) {
          await this.sleep(retryAfterMs(response.headers.get("retry-after")) ?? Math.min(8000, 500 * 2 ** attempt));
          continue;
        }
        if (!retrySafe && response.status >= 500) throw new GoogleBusinessProfileError("AMBIGUOUS_OUTCOME", "Business Profile mutation returned a server error; remote application is unconfirmed", response.status);
        if (response.status === 401 || response.status === 403) throw new GoogleBusinessProfileError("AUTHENTICATION_FAILED", errorMessage(payload), response.status);
        if (response.status === 429) throw new GoogleBusinessProfileError("QUOTA_EXHAUSTED", errorMessage(payload), response.status);
        throw new GoogleBusinessProfileError("API_ERROR", errorMessage(payload), response.status);
      } catch (error) {
        if (error instanceof GoogleBusinessProfileError) throw error;
        const aborted = controller.signal.aborted || (error instanceof DOMException && error.name === "AbortError");
        if (retrySafe && attempt + 1 < attempts) {
          await this.sleep(Math.min(8000, 500 * 2 ** attempt));
          continue;
        }
        if (!retrySafe) {
          if (validateOnly && aborted) throw new GoogleBusinessProfileError("TIMEOUT", "Business Profile validate-only request timed out");
          throw new GoogleBusinessProfileError("AMBIGUOUS_OUTCOME", aborted ? "Business Profile mutation timed out; remote application is unconfirmed" : "Business Profile mutation transport failed; remote application is unconfirmed");
        }
        if (aborted) throw new GoogleBusinessProfileError("TIMEOUT", "Business Profile read timed out");
        throw new GoogleBusinessProfileError("API_ERROR", "Business Profile read transport failed");
      } finally {
        clearTimeout(timer);
      }
    }
    throw new GoogleBusinessProfileError("API_ERROR", "Business Profile request retry loop exhausted");
  }

  async getLocation(locationNameInput: string): Promise<GoogleBusinessProfileLocation> {
    const name = locationName(locationNameInput);
    const url = new URL(`${BUSINESS_INFORMATION_BASE}/${name}`);
    url.searchParams.set("readMask", DEFAULT_READ_MASK.join(","));
    return parseLocation(await this.request(url.href, { method: "GET" }, true), name);
  }

  async getGoogleUpdated(locationNameInput: string): Promise<GoogleBusinessProfileGoogleUpdated> {
    const name = locationName(locationNameInput);
    const url = new URL(`${BUSINESS_INFORMATION_BASE}/${name}:googleUpdated`);
    url.searchParams.set("readMask", DEFAULT_READ_MASK.join(","));
    const payload = object(await this.request(url.href, { method: "GET" }, true), "Business Profile googleUpdated response");
    return Object.freeze({
      location: parseLocation(payload.location, name),
      diffMask: fieldMask(payload.diffMask),
      pendingMask: fieldMask(payload.pendingMask),
    });
  }

  async patchLocation(
    locationNameInput: string,
    patchInput: GoogleBusinessProfilePatch,
    updateMaskInput: readonly GoogleBusinessProfileUpdateField[],
    executionMode: GoogleBusinessProfileExecutionMode,
  ): Promise<GoogleBusinessProfileLocation> {
    const name = locationName(locationNameInput);
    if (!(executionMode === "VALIDATE_ONLY" || executionMode === "APPLY")) throw new GoogleBusinessProfileError("INVALID_INPUT", "executionMode must be VALIDATE_ONLY or APPLY");
    const updateMask = validateUpdateMask(updateMaskInput);
    const patch = validatePatch(patchInput, updateMask);
    const url = new URL(`${BUSINESS_INFORMATION_BASE}/${name}`);
    url.searchParams.set("updateMask", updateMask.join(","));
    url.searchParams.set("validateOnly", executionMode === "VALIDATE_ONLY" ? "true" : "false");
    const payload = await this.request(url.href, {
      method: "PATCH",
      body: JSON.stringify({ name, ...patch }),
    }, false, executionMode === "VALIDATE_ONLY");
    return parseLocation(payload, name);
  }
}
