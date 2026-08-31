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
  metadata?: Readonly<Record<string, string>>;
  reason?: string;
}

export interface GooglebotRenderDiffRequest {
  scope: MeasurementScope;
  expectedUrl: string;
  baseline: GooglebotRenderSnapshot;
  candidate: GooglebotRenderSnapshot;
}

export interface GooglebotRenderDiffResult {
  scope: MeasurementScope;
  expectedUrl: string;
  baseline: GooglebotRenderSnapshot;
  candidate: GooglebotRenderSnapshot;
  comparisons: Readonly<{
    html: "MATCH" | "DIFFERENT" | "UNASSESSED";
    text: "MATCH" | "DIFFERENT" | "UNASSESSED";
    screenshot: "MATCH" | "DIFFERENT" | "UNASSESSED";
  }>;
  externallyVerified: boolean;
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

function digest(value: unknown): string {
  return `sha256:${createHash("sha256").update(JSON.stringify(canonicalize(value))).digest("hex")}`;
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

function canonicalUrl(value: string): string {
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
  return parsed.toString();
}

function canonicalTimestamp(value: string): string {
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
  if (status === "SIMULATED_RENDER" && source !== "SIMULATED_BROWSER") throw new Error("SIMULATED_RENDER requires SIMULATED_BROWSER evidence");
  if (status === "OBSERVED_FETCH" && source !== "OBSERVED_HTTP_FETCH") throw new Error("OBSERVED_FETCH requires OBSERVED_HTTP_FETCH evidence");
  if (status === "GOOGLE_API_OBSERVED" && source !== "GOOGLE_SEARCH_CONSOLE_API") throw new Error("GOOGLE_API_OBSERVED requires GOOGLE_SEARCH_CONSOLE_API evidence");
  if (source === "SIMULATED_BROWSER" && status === "GOOGLE_API_OBSERVED") throw new Error("simulated evidence cannot claim Google API observation");
}

export function normalizeGooglebotRenderSnapshot(input: GooglebotRenderSnapshot): GooglebotRenderSnapshot {
  assertStatusSourceBinding(input.source, input.status);
  const url = canonicalUrl(input.url);
  const observedAt = canonicalTimestamp(input.observedAt);
  const userAgent = safeText(input.userAgent, "userAgent", 1_024);
  const toolVersion = safeText(input.toolVersion, "toolVersion", 256);
  const htmlDigest = normalizedDigest(input.htmlDigest, "htmlDigest");
  const textDigest = normalizedDigest(input.textDigest, "textDigest");
  const screenshotDigest = normalizedDigest(input.screenshotDigest, "screenshotDigest");
  const reason = input.reason === undefined ? undefined : safeText(input.reason, "reason", 1_024);
  const metadata = normalizeMetadata(input.metadata);

  const unavailable = input.status === "UNAVAILABLE" || input.status === "NOT_VERIFIED";
  if (unavailable && (htmlDigest !== null || textDigest !== null || screenshotDigest !== null)) {
    throw new Error(`${input.status} evidence cannot contain observed artifact digests`);
  }
  if (unavailable && reason === undefined) throw new Error(`${input.status} evidence requires a reason`);
  if (!unavailable && htmlDigest === null && textDigest === null && screenshotDigest === null) {
    throw new Error(`${input.status} evidence requires at least one artifact digest`);
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
    ...(metadata === undefined ? {} : { metadata }),
    ...(reason === undefined ? {} : { reason }),
  });
}

function assertScope(scope: MeasurementScope): MeasurementScope {
  const tenantId = safeText(scope.tenantId, "scope.tenantId", 128);
  const brandId = safeText(scope.brandId, "scope.brandId", 128);
  return Object.freeze({ tenantId, brandId });
}

function compareDigest(left: string | null, right: string | null): "MATCH" | "DIFFERENT" | "UNASSESSED" {
  if (left === null || right === null) return "UNASSESSED";
  return left === right ? "MATCH" : "DIFFERENT";
}

export function diffGooglebotRenderEvidence(request: GooglebotRenderDiffRequest): GooglebotRenderDiffResult {
  const scope = assertScope(request.scope);
  const expectedUrl = canonicalUrl(request.expectedUrl);
  const baseline = normalizeGooglebotRenderSnapshot(request.baseline);
  const candidate = normalizeGooglebotRenderSnapshot(request.candidate);
  if (baseline.url !== expectedUrl || candidate.url !== expectedUrl) throw new Error("render evidence URL does not match expectedUrl");

  const comparisons = Object.freeze({
    html: compareDigest(baseline.htmlDigest, candidate.htmlDigest),
    text: compareDigest(baseline.textDigest, candidate.textDigest),
    screenshot: compareDigest(baseline.screenshotDigest, candidate.screenshotDigest),
  });
  const externallyVerified = baseline.status === "GOOGLE_API_OBSERVED" || candidate.status === "GOOGLE_API_OBSERVED";
  const core = Object.freeze({ scope, expectedUrl, baseline, candidate, comparisons, externallyVerified });
  return Object.freeze({ ...core, resultDigest: digest(core) });
}

export function validateGooglebotRenderDiffResult(result: GooglebotRenderDiffResult): void {
  const replay = diffGooglebotRenderEvidence({
    scope: result.scope,
    expectedUrl: result.expectedUrl,
    baseline: result.baseline,
    candidate: result.candidate,
  });
  if (replay.resultDigest !== result.resultDigest) throw new Error("googlebot render diff replay mismatch");
  if (digest(replay.comparisons) !== digest(result.comparisons)) throw new Error("googlebot render comparison replay mismatch");
  if (replay.externallyVerified !== result.externallyVerified) throw new Error("googlebot external verification replay mismatch");
}
