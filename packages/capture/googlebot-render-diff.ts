import { createHash } from "node:crypto";
import type { MeasurementScope } from "../measurement/index.js";

export type GooglebotEvidenceStatus =
  | "SIMULATED_RENDER"
  | "OBSERVED_FETCH"
  | "GOOGLE_API_OBSERVED"
  | "UNAVAILABLE"
  | "NOT_VERIFIED";

export type GooglebotEvidenceSource =
  | "SIMULATED_BROWSER"
  | "OBSERVED_HTTP_FETCH"
  | "GOOGLE_SEARCH_CONSOLE_API";

export interface GooglebotRenderSnapshot {
  source: GooglebotEvidenceSource;
  status: GooglebotEvidenceStatus;
  url: string;
  observedAt: string;
  userAgent: string;
  toolVersion: string;
  htmlDigest: string | null;
  textDigest: string | null;
  screenshotDigest: string | null;
  apiPayloadDigest: string | null;
  metadata?: Readonly<Record<string, string>>;
  reason?: string;
}

export interface GooglebotRenderDiffRequest {
  scope: MeasurementScope;
  expectedUrl: string;
  baseline: GooglebotRenderSnapshot;
  candidate: GooglebotRenderSnapshot;
}

export type GooglebotDigestComparison = "MATCH" | "DIFFERENT" | "UNASSESSED";

export interface GooglebotRenderDiffResult {
  scope: MeasurementScope;
  expectedUrl: string;
  baseline: GooglebotRenderSnapshot;
  candidate: GooglebotRenderSnapshot;
  comparisons: Readonly<{
    html: GooglebotDigestComparison;
    text: GooglebotDigestComparison;
    screenshot: GooglebotDigestComparison;
    apiPayload: GooglebotDigestComparison;
  }>;
  verification: Readonly<{
    googleApiObserved: boolean;
    googleLiveRenderVerified: false;
  }>;
  resultDigest: string;
}

const SHA256_PATTERN = /^sha256:[a-f0-9]{64}$/u;
const MAX_TEXT = 512;
const MAX_URL = 2_048;
const MAX_METADATA_ENTRIES = 64;

function canonicalize(value: unknown, seen = new WeakSet<object>()): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("canonical JSON rejects non-finite numbers");
    return Object.is(value, -0) ? 0 : value;
  }
  if (Array.isArray(value)) return value.map((item) => canonicalize(item, seen));
  if (typeof value === "object") {
    const object = value as Record<string, unknown>;
    if (seen.has(object)) throw new Error("canonical JSON rejects cyclic objects");
    const prototype = Object.getPrototypeOf(object);
    if (prototype !== Object.prototype && prototype !== null) throw new Error("canonical JSON requires plain objects");
    seen.add(object);
    const output: Record<string, unknown> = Object.create(null);
    for (const key of Object.keys(object).sort()) {
      if (key === "__proto__" || key === "prototype" || key === "constructor") throw new Error(`unsafe object key ${key}`);
      const item = object[key];
      if (item === undefined) throw new Error(`canonical JSON rejects undefined at ${key}`);
      output[key] = canonicalize(item, seen);
    }
    seen.delete(object);
    return output;
  }
  throw new Error(`canonical JSON rejects ${typeof value}`);
}

export function canonicalGooglebotJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

export function googlebotEvidenceDigest(value: unknown): string {
  return `sha256:${createHash("sha256").update(canonicalGooglebotJson(value)).digest("hex")}`;
}

function safeText(value: string, field: string, max = MAX_TEXT): string {
  if (typeof value !== "string") throw new Error(`${field} must be a string`);
  const trimmed = value.trim();
  if (!trimmed) throw new Error(`${field} must be non-empty`);
  if (trimmed.length > max) throw new Error(`${field} exceeds ${max} characters`);
  for (const character of trimmed) {
    const code = character.charCodeAt(0);
    if (code <= 0x1f || code === 0x7f) throw new Error(`${field} contains control characters`);
  }
  return trimmed;
}

export function canonicalGooglebotUrl(value: string): string {
  const safe = safeText(value, "url", MAX_URL);
  let parsed: URL;
  try {
    parsed = new URL(safe);
  } catch {
    throw new Error("url must be an absolute HTTP(S) URL");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new Error("url must use HTTP(S)");
  if (parsed.username || parsed.password) throw new Error("credential-bearing URLs are forbidden");
  parsed.hash = "";
  if (parsed.toString().length > MAX_URL) throw new Error(`normalized url exceeds ${MAX_URL} characters`);
  return parsed.toString();
}

export function canonicalGooglebotTimestamp(value: string): string {
  const safe = safeText(value, "observedAt", 64);
  const parsed = new Date(safe);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== safe) throw new Error("observedAt must be canonical ISO-8601 UTC");
  return safe;
}

function normalizedDigest(value: string | null, field: string): string | null {
  if (value === null) return null;
  if (!SHA256_PATTERN.test(value)) throw new Error(`${field} must be a sha256 digest`);
  return value;
}

function normalizeMetadata(metadata: Readonly<Record<string, string>> | undefined): Readonly<Record<string, string>> | undefined {
  if (metadata === undefined) return undefined;
  const entries = Object.entries(metadata);
  if (entries.length > MAX_METADATA_ENTRIES) throw new Error(`metadata exceeds ${MAX_METADATA_ENTRIES} entries`);
  const normalized: Record<string, string> = Object.create(null);
  for (const [rawKey, rawValue] of entries.sort(([left], [right]) => left.localeCompare(right))) {
    const key = safeText(rawKey, "metadata key", 128);
    if (key === "__proto__" || key === "prototype" || key === "constructor") throw new Error(`unsafe metadata key ${key}`);
    normalized[key] = safeText(rawValue, `metadata.${key}`, 1_024);
  }
  return Object.freeze(normalized);
}

function assertStatusSourceBinding(source: GooglebotEvidenceSource, status: GooglebotEvidenceStatus): void {
  const allowed = source === "SIMULATED_BROWSER"
    ? new Set<GooglebotEvidenceStatus>(["SIMULATED_RENDER", "UNAVAILABLE", "NOT_VERIFIED"])
    : source === "OBSERVED_HTTP_FETCH"
      ? new Set<GooglebotEvidenceStatus>(["OBSERVED_FETCH", "UNAVAILABLE", "NOT_VERIFIED"])
      : new Set<GooglebotEvidenceStatus>(["GOOGLE_API_OBSERVED", "UNAVAILABLE", "NOT_VERIFIED"]);
  if (!allowed.has(status)) throw new Error(`${status} cannot be emitted by ${source}`);
}

export function normalizeGooglebotRenderSnapshot(input: GooglebotRenderSnapshot): GooglebotRenderSnapshot {
  assertStatusSourceBinding(input.source, input.status);
  const url = canonicalGooglebotUrl(input.url);
  const observedAt = canonicalGooglebotTimestamp(input.observedAt);
  const userAgent = safeText(input.userAgent, "userAgent", 1_024);
  const toolVersion = safeText(input.toolVersion, "toolVersion", 256);
  const htmlDigest = normalizedDigest(input.htmlDigest, "htmlDigest");
  const textDigest = normalizedDigest(input.textDigest, "textDigest");
  const screenshotDigest = normalizedDigest(input.screenshotDigest, "screenshotDigest");
  const apiPayloadDigest = normalizedDigest(input.apiPayloadDigest, "apiPayloadDigest");
  const reason = input.reason === undefined ? undefined : safeText(input.reason, "reason", 1_024);
  const metadata = normalizeMetadata(input.metadata);

  const unavailable = input.status === "UNAVAILABLE" || input.status === "NOT_VERIFIED";
  if (unavailable) {
    if (htmlDigest !== null || textDigest !== null || screenshotDigest !== null || apiPayloadDigest !== null) {
      throw new Error(`${input.status} evidence cannot contain observed artifact digests`);
    }
    if (reason === undefined) throw new Error(`${input.status} evidence requires a reason`);
  }

  if (input.status === "SIMULATED_RENDER") {
    if (apiPayloadDigest !== null) throw new Error("SIMULATED_RENDER cannot contain Google API payload evidence");
    if (htmlDigest === null && textDigest === null && screenshotDigest === null) throw new Error("SIMULATED_RENDER requires render artifact evidence");
  }

  if (input.status === "OBSERVED_FETCH") {
    if (htmlDigest === null) throw new Error("OBSERVED_FETCH requires an HTTP response body digest");
    if (screenshotDigest !== null || apiPayloadDigest !== null) throw new Error("OBSERVED_FETCH cannot contain screenshot or Google API payload evidence");
  }

  if (input.status === "GOOGLE_API_OBSERVED") {
    if (apiPayloadDigest === null) throw new Error("GOOGLE_API_OBSERVED requires the Search Console API payload digest");
    if (htmlDigest !== null || textDigest !== null || screenshotDigest !== null) {
      throw new Error("GOOGLE_API_OBSERVED cannot be represented as rendered HTML, text, or screenshot evidence");
    }
  }

  return Object.freeze({
    source: input.source,
    status: input.status,
    url,
    observedAt,
    userAgent,
    toolVersion,
    htmlDigest,
    textDigest,
    screenshotDigest,
    apiPayloadDigest,
    ...(metadata === undefined ? {} : { metadata }),
    ...(reason === undefined ? {} : { reason }),
  });
}

function assertScope(scope: MeasurementScope): MeasurementScope {
  const tenantId = safeText(scope.tenantId, "scope.tenantId", 128);
  const brandId = safeText(scope.brandId, "scope.brandId", 128);
  return Object.freeze({ tenantId, brandId });
}

function compareDigest(left: string | null, right: string | null): GooglebotDigestComparison {
  if (left === null || right === null) return "UNASSESSED";
  return left === right ? "MATCH" : "DIFFERENT";
}

export function diffGooglebotRenderEvidence(request: GooglebotRenderDiffRequest): GooglebotRenderDiffResult {
  const scope = assertScope(request.scope);
  const expectedUrl = canonicalGooglebotUrl(request.expectedUrl);
  const baseline = normalizeGooglebotRenderSnapshot(request.baseline);
  const candidate = normalizeGooglebotRenderSnapshot(request.candidate);
  if (baseline.url !== expectedUrl || candidate.url !== expectedUrl) throw new Error("render evidence URL does not match expectedUrl");

  const comparisons = Object.freeze({
    html: compareDigest(baseline.htmlDigest, candidate.htmlDigest),
    text: compareDigest(baseline.textDigest, candidate.textDigest),
    screenshot: compareDigest(baseline.screenshotDigest, candidate.screenshotDigest),
    apiPayload: compareDigest(baseline.apiPayloadDigest, candidate.apiPayloadDigest),
  });
  const verification = Object.freeze({
    googleApiObserved: baseline.status === "GOOGLE_API_OBSERVED" || candidate.status === "GOOGLE_API_OBSERVED",
    // The public URL Inspection API reports the indexed version's inspection status. It does not provide
    // a live rendered DOM or screenshot, so this model must never upgrade render parity to Google-verified.
    googleLiveRenderVerified: false as const,
  });
  const core = Object.freeze({ scope, expectedUrl, baseline, candidate, comparisons, verification });
  return Object.freeze({ ...core, resultDigest: googlebotEvidenceDigest(core) });
}

export function validateGooglebotRenderDiffResult(result: GooglebotRenderDiffResult): void {
  const replay = diffGooglebotRenderEvidence({
    scope: result.scope,
    expectedUrl: result.expectedUrl,
    baseline: result.baseline,
    candidate: result.candidate,
  });
  if (replay.resultDigest !== result.resultDigest) throw new Error("googlebot render diff replay mismatch");
  if (googlebotEvidenceDigest(replay.comparisons) !== googlebotEvidenceDigest(result.comparisons)) throw new Error("googlebot render comparison replay mismatch");
  if (googlebotEvidenceDigest(replay.verification) !== googlebotEvidenceDigest(result.verification)) throw new Error("googlebot verification replay mismatch");
}
