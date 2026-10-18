import { digestValue } from "./index.js";

const MAX_ID = 200;
const MAX_TENANT = 200;
const MAX_SCOPE = 200;
const MAX_URL = 4_000;
const MAX_SOURCE = 2_000;
const MAX_TEXT_LENGTH = 10_000_000;
const MAX_LINK_COUNT = 100_000;
const MAX_CAPTURE_SKEW_MS = 5 * 60 * 1000;
const SHA256 = /^[a-f0-9]{64}$/u;

export const RENDER_DIFF_NON_CLAIM =
  "CONTROLLED_BROWSER_GOOGLEBOT_COMPAT_RENDER_DIFF_NOT_GOOGLE_CRAWL_INDEXING_OR_RANKING_EVIDENCE" as const;

export type RenderProfile = "STANDARD_CHROMIUM" | "GOOGLEBOT_COMPAT";
export type RenderAuthority = "CONTROLLED_BROWSER" | "SYNTHETIC_TEST";
export type RenderEvidenceState = "OBSERVED" | "NOT_VERIFIED" | "UNAVAILABLE";

export interface RenderObservationInput {
  id: string;
  tenantId: string;
  scopeId: string;
  capturedAt: string;
  url: string;
  profile: RenderProfile;
  authority: RenderAuthority;
  source: string;
  httpStatus: number;
  htmlSha256: string;
  visibleTextSha256: string;
  linkSetSha256: string;
  visibleTextLength: number;
  linkCount: number;
}

export interface RenderObservation extends RenderObservationInput {
  observationDigest: string;
}

export interface RenderDiffIssue {
  code:
    | "HTML_DIFF"
    | "VISIBLE_TEXT_DIFF"
    | "LINK_SET_DIFF"
    | "VISIBLE_TEXT_LENGTH_DRIFT"
    | "LINK_COUNT_DRIFT"
    | "HTTP_STATUS_DIFF";
  severity: "INFO" | "WARN" | "ERROR";
  detail: string;
}

export interface RenderDiffAssessment {
  tenantId: string;
  scopeId: string;
  url: string;
  standardObservationDigest: string;
  googlebotObservationDigest: string;
  state: RenderEvidenceState;
  equivalent: boolean;
  issues: readonly RenderDiffIssue[];
  assessmentDigest: string;
  nonClaim: typeof RENDER_DIFF_NON_CLAIM;
}

function clean(label: string, value: unknown, max: number): string {
  if (typeof value !== "string") throw new Error(`${label} must be a string`);
  const normalized = value.trim();
  if (!normalized) throw new Error(`${label} must not be empty`);
  if (normalized.length > max) throw new Error(`${label} exceeds ${max} characters`);
  for (const character of normalized) {
    const code = character.charCodeAt(0);
    if (code <= 0x1f || code === 0x7f) throw new Error(`${label} contains control characters`);
  }
  return normalized;
}

function safeUrl(value: unknown): string {
  const raw = clean("url", value, MAX_URL);
  const url = new URL(raw);
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("url must use HTTP(S)");
  if (url.username || url.password) throw new Error("url must not contain credentials");
  url.hash = "";
  return url.toString();
}

function isoTime(value: unknown): string {
  const raw = clean("capturedAt", value, 100);
  const timestamp = Date.parse(raw);
  if (!Number.isFinite(timestamp)) throw new Error("capturedAt must be an ISO-compatible timestamp");
  return new Date(timestamp).toISOString();
}

function sha256(label: string, value: unknown): string {
  const raw = clean(label, value, 64);
  if (!SHA256.test(raw)) throw new Error(`${label} must be lowercase sha256 hex`);
  return raw;
}

function boundedInteger(label: string, value: unknown, minimum: number, maximum: number): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${label} must be an integer in [${minimum},${maximum}]`);
  }
  return value;
}

function normalizeProfile(value: unknown): RenderProfile {
  if (value !== "STANDARD_CHROMIUM" && value !== "GOOGLEBOT_COMPAT") throw new Error("invalid render profile");
  return value;
}

function normalizeAuthority(value: unknown): RenderAuthority {
  if (value !== "CONTROLLED_BROWSER" && value !== "SYNTHETIC_TEST") throw new Error("invalid render authority");
  return value;
}

export function createRenderObservation(input: RenderObservationInput): RenderObservation {
  const core: RenderObservationInput = {
    id: clean("id", input.id, MAX_ID),
    tenantId: clean("tenantId", input.tenantId, MAX_TENANT),
    scopeId: clean("scopeId", input.scopeId, MAX_SCOPE),
    capturedAt: isoTime(input.capturedAt),
    url: safeUrl(input.url),
    profile: normalizeProfile(input.profile),
    authority: normalizeAuthority(input.authority),
    source: clean("source", input.source, MAX_SOURCE),
    httpStatus: boundedInteger("httpStatus", input.httpStatus, 100, 599),
    htmlSha256: sha256("htmlSha256", input.htmlSha256),
    visibleTextSha256: sha256("visibleTextSha256", input.visibleTextSha256),
    linkSetSha256: sha256("linkSetSha256", input.linkSetSha256),
    visibleTextLength: boundedInteger("visibleTextLength", input.visibleTextLength, 0, MAX_TEXT_LENGTH),
    linkCount: boundedInteger("linkCount", input.linkCount, 0, MAX_LINK_COUNT),
  };
  return Object.freeze({ ...core, observationDigest: digestValue(core) });
}

export function validateRenderObservation(observation: RenderObservation): void {
  const rebuilt = createRenderObservation(observation);
  if (rebuilt.observationDigest !== observation.observationDigest) throw new Error("render observation replay mismatch");
}

function driftRatio(left: number, right: number): number {
  if (left === right) return 0;
  return Math.abs(left - right) / Math.max(1, left, right);
}

export function compareRenderPair(input: {
  standard: RenderObservation;
  googlebot: RenderObservation;
}): RenderDiffAssessment {
  validateRenderObservation(input.standard);
  validateRenderObservation(input.googlebot);
  const standard = input.standard;
  const googlebot = input.googlebot;

  if (standard.profile !== "STANDARD_CHROMIUM") throw new Error("standard observation must use STANDARD_CHROMIUM profile");
  if (googlebot.profile !== "GOOGLEBOT_COMPAT") throw new Error("googlebot observation must use GOOGLEBOT_COMPAT profile");
  if (standard.tenantId !== googlebot.tenantId) throw new Error("render pair tenant mismatch");
  if (standard.scopeId !== googlebot.scopeId) throw new Error("render pair scope mismatch");
  if (standard.url !== googlebot.url) throw new Error("render pair URL mismatch");

  const skew = Math.abs(Date.parse(standard.capturedAt) - Date.parse(googlebot.capturedAt));
  if (skew > MAX_CAPTURE_SKEW_MS) throw new Error("render pair capture timestamps exceed five-minute skew bound");

  const issues: RenderDiffIssue[] = [];
  if (standard.httpStatus !== googlebot.httpStatus) {
    issues.push({ code: "HTTP_STATUS_DIFF", severity: "ERROR", detail: `HTTP status differs: standard=${standard.httpStatus}, googlebot=${googlebot.httpStatus}.` });
  }
  if (standard.htmlSha256 !== googlebot.htmlSha256) {
    issues.push({ code: "HTML_DIFF", severity: "INFO", detail: "Serialized HTML differs between controlled render profiles." });
  }
  if (standard.visibleTextSha256 !== googlebot.visibleTextSha256) {
    issues.push({ code: "VISIBLE_TEXT_DIFF", severity: "ERROR", detail: "Visible-text content differs between controlled render profiles." });
  }
  if (standard.linkSetSha256 !== googlebot.linkSetSha256) {
    issues.push({ code: "LINK_SET_DIFF", severity: "ERROR", detail: "Link-set content differs between controlled render profiles." });
  }
  const textDrift = driftRatio(standard.visibleTextLength, googlebot.visibleTextLength);
  if (textDrift > 0.05) {
    issues.push({ code: "VISIBLE_TEXT_LENGTH_DRIFT", severity: textDrift > 0.2 ? "ERROR" : "WARN", detail: `Visible-text length drift is ${(textDrift * 100).toFixed(2)}%.` });
  }
  const linkDrift = driftRatio(standard.linkCount, googlebot.linkCount);
  if (linkDrift > 0.05) {
    issues.push({ code: "LINK_COUNT_DRIFT", severity: linkDrift > 0.2 ? "ERROR" : "WARN", detail: `Link-count drift is ${(linkDrift * 100).toFixed(2)}%.` });
  }
  issues.sort((a, b) => a.code.localeCompare(b.code));

  const controlled = standard.authority === "CONTROLLED_BROWSER" && googlebot.authority === "CONTROLLED_BROWSER";
  const state: RenderEvidenceState = controlled ? "OBSERVED" : "NOT_VERIFIED";
  const equivalent = controlled && !issues.some((issue) => issue.severity === "ERROR");
  const core = {
    tenantId: standard.tenantId,
    scopeId: standard.scopeId,
    url: standard.url,
    standardObservationDigest: standard.observationDigest,
    googlebotObservationDigest: googlebot.observationDigest,
    state,
    equivalent,
    issues: Object.freeze(issues),
    nonClaim: RENDER_DIFF_NON_CLAIM,
  };
  return Object.freeze({ ...core, assessmentDigest: digestValue(core) });
}

export function validateRenderDiffAssessment(input: {
  standard: RenderObservation;
  googlebot: RenderObservation;
  assessment: RenderDiffAssessment;
}): void {
  const rebuilt = compareRenderPair({ standard: input.standard, googlebot: input.googlebot });
  if (rebuilt.assessmentDigest !== input.assessment.assessmentDigest) throw new Error("render diff assessment digest mismatch");
  if (digestValue(rebuilt) !== digestValue(input.assessment)) throw new Error("render diff assessment replay mismatch");
}

const INPUT_FIELDS = new Set([
  "id", "tenantId", "scopeId", "capturedAt", "url", "profile", "authority", "source", "httpStatus",
  "htmlSha256", "visibleTextSha256", "linkSetSha256", "visibleTextLength", "linkCount",
]);

export function parseRenderObservationJson(value: string): RenderObservation {
  const raw = clean("render observation JSON", value, 64_000);
  const parsed: unknown = JSON.parse(raw);
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("render observation JSON must be an object");
  const record = parsed as Record<string, unknown>;
  for (const key of Object.keys(record)) if (!INPUT_FIELDS.has(key)) throw new Error(`unknown render observation field ${key}`);
  return createRenderObservation(record as unknown as RenderObservationInput);
}
