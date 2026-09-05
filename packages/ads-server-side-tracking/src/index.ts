import { createHash } from "node:crypto";

const MAX_EVENT_NAME = 40;
const MAX_EVENT_ID = 128;
const MAX_CLIENT_ID = 256;
const MAX_TAG_ID = 64;
const MAX_CLICK_ID = 512;
const MAX_PARAMETER_NAME = 40;
const MAX_PARAMETER_VALUE = 500;
const MAX_ACTIVATION_PATH = 512;
const MAX_BODY_BYTES = 64 * 1024;
const MAX_TRANSACTION_ID = 64;
const DEFAULT_TIMEOUT_MS = 5_000;

export type ConsentValue = "granted" | "denied";

export interface TrackingConsent {
  analyticsStorage: ConsentValue;
  adStorage: ConsentValue;
  adUserData: ConsentValue;
  adPersonalization: ConsentValue;
}

export interface GoogleConsentModeDefaults {
  analytics_storage: ConsentValue;
  ad_storage: ConsentValue;
  ad_user_data: ConsentValue;
  ad_personalization: ConsentValue;
}

export interface GoogleClickIds {
  gclid?: string;
  wbraid?: string;
  gbraid?: string;
}

export interface EnhancedConversionUserDataInput {
  email?: string;
  phoneNumber?: string;
  firstName?: string;
  lastName?: string;
  street?: string;
  city?: string;
  region?: string;
  postalCode?: string;
  country?: string;
}

export interface HashedEnhancedConversionAddress {
  sha256_first_name?: string;
  sha256_last_name?: string;
  sha256_street?: string;
  city?: string;
  region?: string;
  postal_code?: string;
  country?: string;
}

export interface HashedEnhancedConversionUserData {
  sha256_email_address?: string;
  sha256_phone_number?: string;
  address?: HashedEnhancedConversionAddress;
}

export type TrackingParameterValue = string | number | boolean;
export type TrackingParameters = Readonly<Record<string, TrackingParameterValue>>;

export interface EnhancedConversionDataLayerInput {
  eventName: string;
  eventId: string;
  transactionId?: string;
  consent: TrackingConsent;
  userData: EnhancedConversionUserDataInput;
  parameters?: TrackingParameters;
}

export interface ServerMeasurementEvent {
  eventName: string;
  eventId: string;
  clientId: string;
  consent: TrackingConsent;
  category?: string;
  value?: number;
  pageLocation?: string;
  clickIds?: GoogleClickIds;
  dimensions?: Readonly<Record<number, string>>;
  metrics?: Readonly<Record<number, number>>;
}

export interface GtmServerTransportConfig {
  serverContainerUrl: string;
  activationPath: string;
  tagId: string;
  timeoutMs?: number;
  fetchImplementation?: typeof fetch;
}

export interface GtmServerDispatchResult {
  eventId: string;
  status: number;
  endpoint: string;
  bytesSent: number;
}

export interface GtmServerTransport {
  readonly serverContainerUrl: string;
  readonly activationPath: string;
  readonly tagId: string;
  send(event: ServerMeasurementEvent): Promise<GtmServerDispatchResult>;
}

export class GtmServerTransportError extends Error {
  readonly status: number | null;
  readonly eventId: string;

  constructor(message: string, eventId: string, status: number | null = null) {
    super(message);
    this.name = "GtmServerTransportError";
    this.status = status;
    this.eventId = eventId;
  }
}

function containsControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit <= 0x1f || codeUnit === 0x7f) return true;
  }
  return false;
}

function clean(label: string, value: string, maxLength: number): string {
  if (typeof value !== "string") throw new TypeError(`${label} must be a string`);
  const normalized = value.trim();
  if (!normalized) throw new Error(`${label} must not be empty`);
  if (normalized.length > maxLength) throw new Error(`${label} exceeds ${maxLength} characters`);
  if (containsControlCharacter(normalized)) throw new Error(`${label} contains control characters`);
  return normalized;
}

function validateConsent(consent: TrackingConsent): TrackingConsent {
  if (!consent || typeof consent !== "object") throw new Error("consent is required");
  const keys = ["analyticsStorage", "adStorage", "adUserData", "adPersonalization"] as const;
  for (const key of keys) {
    const value = consent[key];
    if (value !== "granted" && value !== "denied") throw new Error(`${key} must be granted or denied`);
  }
  return consent;
}

function normalizeEventName(value: string): string {
  const eventName = clean("eventName", value, MAX_EVENT_NAME);
  if (!/^[A-Za-z][A-Za-z0-9_]*$/u.test(eventName)) {
    throw new Error("eventName must begin with a letter and contain only letters, numbers, and underscores");
  }
  return eventName;
}

function normalizeEventId(value: string): string {
  const eventId = clean("eventId", value, MAX_EVENT_ID);
  if (!/^[A-Za-z0-9._:-]+$/u.test(eventId)) throw new Error("eventId contains unsupported characters");
  return eventId;
}

function normalizeTransactionId(value: string): string {
  return clean("transactionId", value, MAX_TRANSACTION_ID);
}

function normalizeClientId(value: string): string {
  return clean("clientId", value, MAX_CLIENT_ID);
}

function normalizeTagId(value: string): string {
  const tagId = clean("tagId", value, MAX_TAG_ID);
  if (!/^[A-Za-z0-9_-]+$/u.test(tagId)) throw new Error("tagId contains unsupported characters");
  return tagId;
}

function normalizeServerContainerUrl(value: string): URL {
  const raw = clean("serverContainerUrl", value, 2_048);
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("serverContainerUrl must be an absolute URL");
  }
  if (url.protocol !== "https:") throw new Error("serverContainerUrl must use HTTPS");
  if (url.username || url.password) throw new Error("serverContainerUrl must not contain credentials");
  if (url.search || url.hash) throw new Error("serverContainerUrl must not contain a query string or fragment");
  return url;
}

function normalizeActivationPath(value: string): string {
  const path = clean("activationPath", value, MAX_ACTIVATION_PATH);
  if (!path.startsWith("/")) throw new Error("activationPath must start with /");
  if (path.includes("?") || path.includes("#")) throw new Error("activationPath must not contain a query string or fragment");
  if (path.startsWith("//")) throw new Error("activationPath must be origin-relative");
  let decodedPath: string;
  try {
    decodedPath = decodeURIComponent(path);
  } catch {
    throw new Error("activationPath contains invalid percent encoding");
  }
  if (decodedPath.split("/").some((segment) => segment === "." || segment === "..")) {
    throw new Error("activationPath must not contain dot segments");
  }
  return path;
}

function buildServerEndpoint(serverUrl: URL, activationPath: string): string {
  const basePath = serverUrl.pathname === "/" ? "" : serverUrl.pathname.replace(/\/+$/u, "");
  return new URL(`${basePath}${activationPath}`, serverUrl.origin).toString();
}

function normalizeClickId(label: string, value: string | null): string | undefined {
  if (value == null || value.trim() === "") return undefined;
  return clean(label, value, MAX_CLICK_ID);
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function normalizeTextForHash(label: string, value: string | undefined): string | undefined {
  if (value == null || value.trim() === "") return undefined;
  return clean(label, value, 512).trim().toLowerCase();
}

function normalizeEmail(value: string | undefined): string | undefined {
  const normalized = normalizeTextForHash("email", value);
  if (normalized == null) return undefined;
  const parts = normalized.split("@");
  if (parts.length !== 2 || !parts[0] || !parts[1]) throw new Error("email must be a valid email address");
  const [localPart, domain] = parts;
  if (domain === "gmail.com" || domain === "googlemail.com") {
    return `${localPart.replace(/\./gu, "")}@${domain}`;
  }
  return normalized;
}

function normalizePhone(value: string | undefined): string | undefined {
  if (value == null || value.trim() === "") return undefined;
  const raw = clean("phoneNumber", value, 64);
  const compact = raw.replace(/[\s().-]/gu, "");
  if (!/^\+[1-9]\d{10,14}$/u.test(compact)) {
    throw new Error("phoneNumber must use E.164 format with 11 to 15 digits, for example +525512345678");
  }
  return compact;
}

function normalizeCountry(value: string | undefined): string | undefined {
  if (value == null || value.trim() === "") return undefined;
  const country = clean("country", value, 2).toUpperCase();
  if (!/^[A-Z]{2}$/u.test(country)) throw new Error("country must be an ISO 3166-1 alpha-2 code");
  return country;
}

function normalizePlainLocation(label: string, value: string | undefined, max: number): string | undefined {
  if (value == null || value.trim() === "") return undefined;
  return clean(label, value, max).trim().toLowerCase();
}

function normalizeParameters(parameters: TrackingParameters | undefined): Record<string, TrackingParameterValue> {
  const output: Record<string, TrackingParameterValue> = {};
  if (parameters == null) return output;
  const reserved = new Set([
    "event",
    "event_id",
    "transaction_id",
    "user_data",
    "email",
    "phone",
    "phone_number",
    "first_name",
    "last_name",
    "street",
    "address",
  ]);
  for (const [rawKey, rawValue] of Object.entries(parameters)) {
    const key = clean("parameter name", rawKey, MAX_PARAMETER_NAME);
    if (!/^[A-Za-z][A-Za-z0-9_]*$/u.test(key)) throw new Error(`invalid tracking parameter name: ${key}`);
    if (reserved.has(key.toLowerCase())) throw new Error(`tracking parameter ${key} is reserved for protected data`);
    if (typeof rawValue === "string") output[key] = clean(`parameter ${key}`, rawValue, MAX_PARAMETER_VALUE);
    else if (typeof rawValue === "number") {
      if (!Number.isFinite(rawValue)) throw new Error(`parameter ${key} must be finite`);
      output[key] = rawValue;
    } else if (typeof rawValue === "boolean") output[key] = rawValue;
    else throw new Error(`parameter ${key} has an unsupported value`);
  }
  return output;
}

export function buildGoogleConsentModeDefaults(consent: TrackingConsent): GoogleConsentModeDefaults {
  validateConsent(consent);
  return Object.freeze({
    analytics_storage: consent.analyticsStorage,
    ad_storage: consent.adStorage,
    ad_user_data: consent.adUserData,
    ad_personalization: consent.adPersonalization,
  });
}

export function buildGoogleTagServerConfig(serverContainerUrl: string): Readonly<{ server_container_url: string }> {
  const url = normalizeServerContainerUrl(serverContainerUrl);
  return Object.freeze({ server_container_url: url.toString().replace(/\/$/u, "") });
}

export function buildServerContainerCspSources(serverContainerUrl: string): Readonly<{
  imgSrc: string;
  connectSrc: string;
  frameSrc: string;
}> {
  const url = normalizeServerContainerUrl(serverContainerUrl);
  const origin = url.origin;
  return Object.freeze({ imgSrc: origin, connectSrc: origin, frameSrc: origin });
}

export function extractGoogleClickIds(inputUrl: string): Readonly<GoogleClickIds> {
  let url: URL;
  try {
    url = new URL(clean("inputUrl", inputUrl, 8_192));
  } catch {
    throw new Error("inputUrl must be an absolute URL");
  }
  const ids: GoogleClickIds = {};
  const gclid = normalizeClickId("gclid", url.searchParams.get("gclid"));
  const wbraid = normalizeClickId("wbraid", url.searchParams.get("wbraid"));
  const gbraid = normalizeClickId("gbraid", url.searchParams.get("gbraid"));
  if (gclid) ids.gclid = gclid;
  if (wbraid) ids.wbraid = wbraid;
  if (gbraid) ids.gbraid = gbraid;
  return Object.freeze(ids);
}

export function filterClickIdsByConsent(clickIds: GoogleClickIds | undefined, consent: TrackingConsent): Readonly<GoogleClickIds> {
  validateConsent(consent);
  if (consent.adStorage !== "granted" || clickIds == null) return Object.freeze({});
  const ids: GoogleClickIds = {};
  const gclid = normalizeClickId("gclid", clickIds.gclid ?? null);
  const wbraid = normalizeClickId("wbraid", clickIds.wbraid ?? null);
  const gbraid = normalizeClickId("gbraid", clickIds.gbraid ?? null);
  if (gclid) ids.gclid = gclid;
  if (wbraid) ids.wbraid = wbraid;
  if (gbraid) ids.gbraid = gbraid;
  return Object.freeze(ids);
}

export function hashEnhancedConversionUserData(
  input: EnhancedConversionUserDataInput,
  consent: TrackingConsent,
): Readonly<HashedEnhancedConversionUserData> {
  validateConsent(consent);
  if (consent.adUserData !== "granted") throw new Error("adUserData consent is required for enhanced conversion user data");
  if (!input || typeof input !== "object") throw new Error("userData is required");

  const email = normalizeEmail(input.email);
  const phone = normalizePhone(input.phoneNumber);
  if (email == null && phone == null) {
    throw new Error("enhanced conversion user data requires at least email or phoneNumber");
  }

  const firstName = normalizeTextForHash("firstName", input.firstName);
  const lastName = normalizeTextForHash("lastName", input.lastName);
  const street = normalizeTextForHash("street", input.street);
  const city = normalizePlainLocation("city", input.city, 128);
  const region = normalizePlainLocation("region", input.region, 128);
  const postalCode = normalizePlainLocation("postalCode", input.postalCode, 32);
  const country = normalizeCountry(input.country);

  const output: HashedEnhancedConversionUserData = {};
  if (email) output.sha256_email_address = sha256(email);
  if (phone) output.sha256_phone_number = sha256(phone);

  const address: HashedEnhancedConversionAddress = {};
  if (firstName) address.sha256_first_name = sha256(firstName);
  if (lastName) address.sha256_last_name = sha256(lastName);
  if (street) address.sha256_street = sha256(street);
  if (city) address.city = city;
  if (region) address.region = region;
  if (postalCode) address.postal_code = postalCode;
  if (country) address.country = country;
  if (Object.keys(address).length > 0) output.address = Object.freeze(address);

  return Object.freeze(output);
}

export function buildEnhancedConversionDataLayerEvent(
  input: EnhancedConversionDataLayerInput,
): Readonly<Record<string, unknown>> {
  const event = normalizeEventName(input.eventName);
  const eventId = normalizeEventId(input.eventId);
  const transactionId = input.transactionId == null ? undefined : normalizeTransactionId(input.transactionId);
  const parameters = normalizeParameters(input.parameters);
  const userData = hashEnhancedConversionUserData(input.userData, input.consent);
  return Object.freeze({
    event,
    event_id: eventId,
    ...(transactionId == null ? {} : { transaction_id: transactionId }),
    ...parameters,
    user_data: userData,
  });
}

function validateDimensionIndex(index: number): number {
  if (!Number.isInteger(index) || index < 1 || index > 200) throw new Error("custom dimension index must be an integer between 1 and 200");
  return index;
}

function validateMetricIndex(index: number): number {
  if (!Number.isInteger(index) || index < 1 || index > 200) throw new Error("custom metric index must be an integer between 1 and 200");
  return index;
}

function buildMeasurementProtocolBody(event: ServerMeasurementEvent, tagId: string): URLSearchParams {
  validateConsent(event.consent);
  if (event.consent.analyticsStorage !== "granted") {
    throw new Error("analyticsStorage consent is required to send a server measurement event");
  }

  const eventName = normalizeEventName(event.eventName);
  const eventId = normalizeEventId(event.eventId);
  const clientId = normalizeClientId(event.clientId);
  const category = clean("category", event.category ?? "nexus", 150);

  const body = new URLSearchParams();
  body.set("v", "1");
  body.set("tid", tagId);
  body.set("cid", clientId);
  body.set("t", "event");
  body.set("ec", category);
  body.set("ea", eventName);
  body.set("el", eventId);

  if (event.value != null) {
    if (!Number.isFinite(event.value) || event.value < 0 || !Number.isInteger(event.value)) {
      throw new Error("value must be a non-negative integer for Measurement Protocol event value");
    }
    body.set("ev", String(event.value));
  }
  if (event.pageLocation != null) {
    let pageUrl: URL;
    try {
      pageUrl = new URL(clean("pageLocation", event.pageLocation, 8_192));
    } catch {
      throw new Error("pageLocation must be an absolute URL");
    }
    if (pageUrl.protocol !== "https:" && pageUrl.protocol !== "http:") throw new Error("pageLocation must use HTTP or HTTPS");
    body.set("dl", pageUrl.toString());
  }

  const clickIds = filterClickIdsByConsent(event.clickIds, event.consent);
  if (clickIds.gclid) body.set("gclid", clickIds.gclid);
  if (clickIds.wbraid) body.set("wbraid", clickIds.wbraid);
  if (clickIds.gbraid) body.set("gbraid", clickIds.gbraid);
  if (event.consent.adPersonalization === "denied") body.set("npa", "1");

  for (const [rawIndex, rawValue] of Object.entries(event.dimensions ?? {})) {
    const index = validateDimensionIndex(Number(rawIndex));
    body.set(`cd${index}`, clean(`dimension ${index}`, rawValue, MAX_PARAMETER_VALUE));
  }
  for (const [rawIndex, rawValue] of Object.entries(event.metrics ?? {})) {
    const index = validateMetricIndex(Number(rawIndex));
    if (!Number.isFinite(rawValue) || rawValue < 0) throw new Error(`metric ${index} must be a non-negative finite number`);
    body.set(`cm${index}`, String(rawValue));
  }
  return body;
}

function normalizeTimeout(value: number | undefined): number {
  const timeout = value ?? DEFAULT_TIMEOUT_MS;
  if (!Number.isInteger(timeout) || timeout < 100 || timeout > 30_000) {
    throw new Error("timeoutMs must be an integer between 100 and 30000");
  }
  return timeout;
}

export function createGtmServerTransport(config: GtmServerTransportConfig): GtmServerTransport {
  if (!config || typeof config !== "object") throw new Error("transport config is required");
  const serverUrl = normalizeServerContainerUrl(config.serverContainerUrl);
  const activationPath = normalizeActivationPath(config.activationPath);
  const tagId = normalizeTagId(config.tagId);
  const timeoutMs = normalizeTimeout(config.timeoutMs);
  const fetchImplementation = config.fetchImplementation ?? globalThis.fetch;
  if (typeof fetchImplementation !== "function") throw new Error("a fetch implementation is required");

  const endpoint = buildServerEndpoint(serverUrl, activationPath);

  return Object.freeze({
    serverContainerUrl: serverUrl.toString().replace(/\/$/u, ""),
    activationPath,
    tagId,
    async send(event: ServerMeasurementEvent): Promise<GtmServerDispatchResult> {
      const eventId = normalizeEventId(event.eventId);
      const body = buildMeasurementProtocolBody(event, tagId).toString();
      const bytesSent = Buffer.byteLength(body, "utf8");
      if (bytesSent > MAX_BODY_BYTES) throw new GtmServerTransportError("Measurement Protocol body exceeds 64 KiB", eventId);

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const response = await fetchImplementation(endpoint, {
          method: "POST",
          headers: {
            "content-type": "application/x-www-form-urlencoded;charset=UTF-8",
            "cache-control": "no-store",
            "x-nexus-event-id": eventId,
          },
          body,
          redirect: "error",
          signal: controller.signal,
        });
        if (!response.ok) {
          throw new GtmServerTransportError(`server container rejected event with HTTP ${response.status}`, eventId, response.status);
        }
        return Object.freeze({ eventId, status: response.status, endpoint, bytesSent });
      } catch (error) {
        if (error instanceof GtmServerTransportError) throw error;
        if (controller.signal.aborted) throw new GtmServerTransportError("server container request timed out", eventId);
        const message = error instanceof Error ? error.message : "unknown transport error";
        throw new GtmServerTransportError(`server container request failed: ${message}`, eventId);
      } finally {
        clearTimeout(timer);
      }
    },
  });
}
