import { domainToASCII } from "node:url";
import {
  canonicalGooglebotJson,
  canonicalGooglebotTimestamp,
  canonicalGooglebotUrl,
  googlebotEvidenceDigest,
  normalizeGooglebotRenderSnapshot,
  type GooglebotRenderSnapshot,
} from "./googlebot-render-diff.js";

export interface GoogleUrlInspectionRequest {
  inspectionUrl: string;
  siteUrl: string;
  languageCode?: string;
}

export interface GoogleUrlInspectionOptions {
  accessToken?: string | null;
  signal?: AbortSignal;
  timeoutMs?: number;
  maxResponseBytes?: number;
  clock?: () => Date;
  toolVersion?: string;
}

const ENDPOINT = "https://searchconsole.googleapis.com/v1/urlInspection/index:inspect";
const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_TIMEOUT_MS = 60_000;
const DEFAULT_MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
const TOOL_VERSION = "nexus-search-console-url-inspection/1.0.0";
const URL_INSPECTION_USER_AGENT = "NOT_EXPOSED_BY_URL_INSPECTION_API";

function boundedInteger(value: number | undefined, fallback: number, field: string, min: number, max: number): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved < min || resolved > max) throw new Error(`${field} must be an integer from ${min} to ${max}`);
  return resolved;
}

function safeToken(value: string | null | undefined): string | null {
  if (value == null) return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 16_384) return null;
  for (const character of trimmed) {
    const code = character.charCodeAt(0);
    if (code <= 0x1f || code === 0x7f) return null;
  }
  return trimmed;
}

function safeToolVersion(value: string | undefined): string {
  const resolved = (value ?? TOOL_VERSION).trim();
  if (!resolved || resolved.length > 256) throw new Error("toolVersion must be between 1 and 256 characters");
  return resolved;
}

function observedAt(clock: (() => Date) | undefined): string {
  return canonicalGooglebotTimestamp((clock?.() ?? new Date()).toISOString());
}

function canonicalLanguageCode(value: string | undefined): string {
  if (value === undefined) return "en-US";
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 64) throw new Error("languageCode must be between 1 and 64 characters");
  try {
    return new Intl.Locale(trimmed).toString();
  } catch {
    throw new Error("languageCode must be a valid BCP-47 locale");
  }
}

function canonicalSiteUrl(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) throw new Error("siteUrl is required");
  if (trimmed.startsWith("sc-domain:")) {
    const rawDomain = trimmed.slice("sc-domain:".length).toLowerCase();
    const domain = domainToASCII(rawDomain);
    if (!domain || domain.length > 253 || domain.includes("..") || domain.startsWith(".") || domain.endsWith(".")) throw new Error("sc-domain siteUrl is invalid");
    return `sc-domain:${domain}`;
  }
  let rawUrl: URL;
  try {
    rawUrl = new URL(trimmed);
  } catch {
    throw new Error("URL-prefix siteUrl must be an absolute HTTP(S) URL");
  }
  if (rawUrl.search || rawUrl.hash || rawUrl.username || rawUrl.password) throw new Error("URL-prefix siteUrl cannot contain credentials, query, or fragment");
  const url = new URL(canonicalGooglebotUrl(rawUrl.toString()));
  if (!url.pathname.endsWith("/")) throw new Error("URL-prefix siteUrl must include a trailing slash");
  return url.toString();
}

function assertInspectionWithinProperty(inspectionUrl: string, siteUrl: string): void {
  const inspected = new URL(inspectionUrl);
  if (siteUrl.startsWith("sc-domain:")) {
    const domain = siteUrl.slice("sc-domain:".length);
    const host = inspected.hostname.toLowerCase();
    if (host !== domain && !host.endsWith(`.${domain}`)) throw new Error("inspectionUrl is outside the Search Console domain property");
    return;
  }
  const property = new URL(siteUrl);
  if (property.origin !== inspected.origin || !inspected.pathname.startsWith(property.pathname)) {
    throw new Error("inspectionUrl is outside the Search Console URL-prefix property");
  }
}

function isJsonContentType(value: string | null): boolean {
  if (value === null) return false;
  const mediaType = value.split(";", 1)[0]?.trim().toLowerCase();
  return mediaType === "application/json" || Boolean(mediaType?.endsWith("+json"));
}

async function readBoundedJson(response: Response, maxBytes: number, signal: AbortSignal | undefined): Promise<unknown> {
  const contentLength = response.headers.get("content-length");
  if (contentLength !== null && /^\d+$/u.test(contentLength) && Number(contentLength) > maxBytes) throw new Error(`Search Console API response Content-Length exceeds ${maxBytes} bytes`);
  if (response.body === null) throw new Error("Search Console API response body is empty");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      if (signal?.aborted) throw new Error("Search Console API response read cancelled");
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) throw new Error(`Search Console API response exceeds ${maxBytes} bytes`);
      chunks.push(value);
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
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new Error("Search Console API response is not valid UTF-8 JSON");
  }
}

function plainObject(value: unknown, field: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error(`${field} must be an object`);
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) throw new Error(`${field} must be a plain object`);
  return value as Record<string, unknown>;
}

function optionalString(object: Record<string, unknown>, key: string): string | undefined {
  const value = object[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function metadataValue(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  if (value.length <= 1_024) return value;
  return `sha256-of-long-value:${googlebotEvidenceDigest(value).slice("sha256:".length)}`;
}

function inspectionMetadata(payload: unknown): Readonly<Record<string, string>> {
  const root = plainObject(payload, "response");
  const inspection = plainObject(root.inspectionResult, "inspectionResult");
  const indexStatusRaw = inspection.indexStatusResult;
  const indexStatus = indexStatusRaw === undefined ? Object.create(null) as Record<string, unknown> : plainObject(indexStatusRaw, "indexStatusResult");
  const entries: Array<[string, string | undefined]> = [
    ["inspectionResultLink", metadataValue(optionalString(inspection, "inspectionResultLink"))],
    ["verdict", optionalString(indexStatus, "verdict")],
    ["coverageState", optionalString(indexStatus, "coverageState")],
    ["robotsTxtState", optionalString(indexStatus, "robotsTxtState")],
    ["indexingState", optionalString(indexStatus, "indexingState")],
    ["lastCrawlTime", optionalString(indexStatus, "lastCrawlTime")],
    ["pageFetchState", optionalString(indexStatus, "pageFetchState")],
    ["crawledAs", optionalString(indexStatus, "crawledAs")],
    ["googleCanonical", metadataValue(optionalString(indexStatus, "googleCanonical"))],
    ["userCanonical", metadataValue(optionalString(indexStatus, "userCanonical"))],
  ];
  const metadata: Record<string, string> = Object.create(null);
  for (const [key, value] of entries) if (value !== undefined) metadata[key] = value;
  metadata.evidenceMeaning = "Search Console URL Inspection API observation of the version in Google's index; not a live URL render test";
  return Object.freeze(metadata);
}

function unavailable(
  inspectionUrl: string,
  reason: string,
  options: GoogleUrlInspectionOptions,
  status: "UNAVAILABLE" | "NOT_VERIFIED",
): GooglebotRenderSnapshot {
  return normalizeGooglebotRenderSnapshot({
    source: "GOOGLE_SEARCH_CONSOLE_API",
    status,
    url: inspectionUrl,
    observedAt: observedAt(options.clock),
    userAgent: URL_INSPECTION_USER_AGENT,
    toolVersion: safeToolVersion(options.toolVersion),
    htmlDigest: null,
    textDigest: null,
    screenshotDigest: null,
    apiPayloadDigest: null,
    reason,
  });
}

export async function inspectUrlWithSearchConsole(
  request: GoogleUrlInspectionRequest,
  options: GoogleUrlInspectionOptions = {},
): Promise<GooglebotRenderSnapshot> {
  const inspectionUrl = canonicalGooglebotUrl(request.inspectionUrl);
  const siteUrl = canonicalSiteUrl(request.siteUrl);
  assertInspectionWithinProperty(inspectionUrl, siteUrl);
  const languageCode = canonicalLanguageCode(request.languageCode);
  const accessToken = safeToken(options.accessToken);
  if (accessToken === null) return unavailable(inspectionUrl, "Search Console OAuth access token is not configured", options, "UNAVAILABLE");

  const timeoutMs = boundedInteger(options.timeoutMs, DEFAULT_TIMEOUT_MS, "timeoutMs", 100, MAX_TIMEOUT_MS);
  const maxResponseBytes = boundedInteger(options.maxResponseBytes, DEFAULT_MAX_RESPONSE_BYTES, "maxResponseBytes", 1, MAX_RESPONSE_BYTES);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const forwardAbort = () => controller.abort();
  options.signal?.addEventListener("abort", forwardAbort, { once: true });

  try {
    const response = await fetch(ENDPOINT, {
      method: "POST",
      signal: controller.signal,
      headers: {
        authorization: `Bearer ${accessToken}`,
        "content-type": "application/json",
        accept: "application/json",
      },
      body: canonicalGooglebotJson({ inspectionUrl, siteUrl, languageCode }),
    });
    if (!response.ok) {
      const status = response.status === 401 || response.status === 403 || response.status === 429 || response.status >= 500 ? "UNAVAILABLE" : "NOT_VERIFIED";
      return unavailable(inspectionUrl, `Search Console URL Inspection API returned HTTP ${response.status}`, options, status);
    }
    if (!isJsonContentType(response.headers.get("content-type"))) return unavailable(inspectionUrl, "Search Console URL Inspection API returned a non-JSON Content-Type", options, "NOT_VERIFIED");

    try {
      const payload = await readBoundedJson(response, maxResponseBytes, controller.signal);
      const metadata = inspectionMetadata(payload);
      return normalizeGooglebotRenderSnapshot({
        source: "GOOGLE_SEARCH_CONSOLE_API",
        status: "GOOGLE_API_OBSERVED",
        url: inspectionUrl,
        observedAt: observedAt(options.clock),
        userAgent: URL_INSPECTION_USER_AGENT,
        toolVersion: safeToolVersion(options.toolVersion),
        htmlDigest: null,
        textDigest: null,
        screenshotDigest: null,
        apiPayloadDigest: googlebotEvidenceDigest(payload),
        metadata,
      });
    } catch (error) {
      const reason = error instanceof Error ? error.message : "Search Console API response could not be verified";
      return unavailable(inspectionUrl, reason, options, /cancelled|abort|timed out/iu.test(reason) ? "UNAVAILABLE" : "NOT_VERIFIED");
    }
  } catch (error) {
    return unavailable(
      inspectionUrl,
      error instanceof Error ? error.message : "Search Console URL Inspection API request failed",
      options,
      "UNAVAILABLE",
    );
  } finally {
    clearTimeout(timeout);
    options.signal?.removeEventListener("abort", forwardAbort);
  }
}
