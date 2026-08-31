import { createHash } from "node:crypto";

const MAX_OBSERVATIONS = 100_000;
const MAX_URL_LENGTH = 4_000;
const MAX_AGENT_LENGTH = 2_000;
const MAX_SOURCE_LENGTH = 2_000;
const MAX_WINDOW_MS = 31 * 24 * 60 * 60 * 1000;

function canonical(value: unknown): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("non-finite number");
    return Object.is(value, -0) ? 0 : value;
  }
  if (Array.isArray(value)) return value.map(canonical);
  if (typeof value === "object") {
    const proto = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) throw new Error("non-plain object");
    const out: Record<string, unknown> = Object.create(null);
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      const item = (value as Record<string, unknown>)[key];
      if (item === undefined) throw new Error(`undefined at ${key}`);
      out[key] = canonical(item);
    }
    return out;
  }
  throw new Error(`unsupported canonical value ${typeof value}`);
}

export function digestValue(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");
}

function clean(label: string, value: string, max: number): string {
  if (typeof value !== "string") throw new Error(`${label} must be a string`);
  const normalized = value.trim();
  if (!normalized) throw new Error(`${label} must not be empty`);
  if (normalized.length > max) throw new Error(`${label} exceeds ${max} characters`);
  return normalized;
}

function safeUrl(value: string): string {
  const raw = clean("URL", value, MAX_URL_LENGTH);
  const url = new URL(raw);
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("URL must be HTTP(S)");
  if (url.username || url.password) throw new Error("URL must not contain credentials");
  url.hash = "";
  return url.toString();
}

function isoTime(label: string, value: string): string {
  const normalized = clean(label, value, 100);
  const time = Date.parse(normalized);
  if (!Number.isFinite(time)) throw new Error(`${label} must be an ISO-compatible timestamp`);
  return new Date(time).toISOString();
}

function statusCode(value: number): number {
  if (!Number.isInteger(value) || value < 100 || value > 599) throw new Error("status must be an HTTP status code");
  return value;
}

export type CrawlActor = "SEARCH_BOT" | "OTHER_BOT" | "USER" | "UNKNOWN";
export type ObservationAuthority = "SERVER_ACCESS_LOG" | "EDGE_LOG" | "CONTROLLED_TEST";

export interface CrawlObservationInput {
  id: string;
  observedAt: string;
  url: string;
  status: number;
  userAgent: string;
  actor: CrawlActor;
  authority: ObservationAuthority;
  source: string;
  responseTimeMs?: number;
  redirectLocation?: string;
  robotsAllowed?: boolean | null;
}

export interface CrawlObservation {
  id: string;
  observedAt: string;
  url: string;
  status: number;
  userAgent: string;
  actor: CrawlActor;
  authority: ObservationAuthority;
  source: string;
  responseTimeMs: number | null;
  redirectLocation: string | null;
  robotsAllowed: boolean | null;
  observationDigest: string;
}

const ACTORS = new Set<CrawlActor>(["SEARCH_BOT", "OTHER_BOT", "USER", "UNKNOWN"]);
const AUTHORITIES = new Set<ObservationAuthority>(["SERVER_ACCESS_LOG", "EDGE_LOG", "CONTROLLED_TEST"]);

export function createObservation(input: CrawlObservationInput): CrawlObservation {
  if (!ACTORS.has(input.actor)) throw new Error("invalid crawl actor");
  if (!AUTHORITIES.has(input.authority)) throw new Error("invalid observation authority");
  const responseTimeMs = input.responseTimeMs ?? null;
  if (responseTimeMs !== null && (!Number.isFinite(responseTimeMs) || responseTimeMs < 0 || responseTimeMs > 300_000)) {
    throw new Error("responseTimeMs must be within [0,300000]");
  }
  const redirectLocation = input.redirectLocation == null ? null : safeUrl(input.redirectLocation);
  if (redirectLocation !== null && (input.status < 300 || input.status > 399)) throw new Error("redirectLocation requires 3xx status");
  const robotsAllowed = input.robotsAllowed ?? null;
  if (robotsAllowed !== null && typeof robotsAllowed !== "boolean") throw new Error("robotsAllowed must be boolean or null");
  const core = {
    id: clean("observation id", input.id, 200),
    observedAt: isoTime("observedAt", input.observedAt),
    url: safeUrl(input.url),
    status: statusCode(input.status),
    userAgent: clean("userAgent", input.userAgent, MAX_AGENT_LENGTH),
    actor: input.actor,
    authority: input.authority,
    source: clean("source", input.source, MAX_SOURCE_LENGTH),
    responseTimeMs,
    redirectLocation,
    robotsAllowed,
  };
  return Object.freeze({ ...core, observationDigest: digestValue(core) });
}

export function validateObservation(observation: CrawlObservation): void {
  const rebuilt = createObservation(observation);
  if (rebuilt.observationDigest !== observation.observationDigest) throw new Error("observation digest mismatch");
}

export interface CrawlDatasetInput {
  site: string;
  windowStart: string;
  windowEnd: string;
  observations: readonly CrawlObservationInput[];
}

export interface CrawlDataset {
  site: string;
  windowStart: string;
  windowEnd: string;
  observations: readonly CrawlObservation[];
  datasetDigest: string;
}

export function createDataset(input: CrawlDatasetInput): CrawlDataset {
  if (input.observations.length === 0) throw new Error("crawl dataset requires observations");
  if (input.observations.length > MAX_OBSERVATIONS) throw new Error(`observations exceeds ${MAX_OBSERVATIONS}`);
  const site = safeUrl(input.site);
  const siteUrl = new URL(site);
  const windowStart = isoTime("windowStart", input.windowStart);
  const windowEnd = isoTime("windowEnd", input.windowEnd);
  const startMs = Date.parse(windowStart);
  const endMs = Date.parse(windowEnd);
  if (endMs <= startMs) throw new Error("windowEnd must be after windowStart");
  if (endMs - startMs > MAX_WINDOW_MS) throw new Error("crawl observation window exceeds 31 days");
  const observations = input.observations.map(createObservation).sort((a, b) => a.observedAt.localeCompare(b.observedAt) || a.id.localeCompare(b.id));
  const ids = observations.map((item) => item.id);
  if (new Set(ids).size !== ids.length) throw new Error("duplicate observation ids");
  for (const observation of observations) {
    const url = new URL(observation.url);
    if (url.origin !== siteUrl.origin) throw new Error(`observation ${observation.id} is cross-origin`);
    const time = Date.parse(observation.observedAt);
    if (time < startMs || time > endMs) throw new Error(`observation ${observation.id} falls outside dataset window`);
  }
  const core = { site, windowStart, windowEnd, observations: Object.freeze(observations) };
  return Object.freeze({ ...core, datasetDigest: digestValue(core) });
}

export function validateDataset(dataset: CrawlDataset): void {
  const rebuilt = createDataset(dataset);
  if (rebuilt.datasetDigest !== dataset.datasetDigest) throw new Error("dataset digest mismatch");
  if (rebuilt.observations.some((item, index) => item.observationDigest !== dataset.observations[index]?.observationDigest)) {
    throw new Error("observation replay mismatch");
  }
}

export type CrawlIssueCode =
  | "SEARCH_BOT_5XX"
  | "SEARCH_BOT_4XX"
  | "SEARCH_BOT_REDIRECT_CHAIN"
  | "ROBOTS_POLICY_CONFLICT"
  | "SLOW_SEARCH_BOT_RESPONSE"
  | "INSUFFICIENT_SEARCH_BOT_EVIDENCE";

export interface CrawlIssue {
  code: CrawlIssueCode;
  severity: "INFO" | "WARN" | "ERROR";
  url: string | null;
  observationIds: readonly string[];
  detail: string;
}

export interface CrawlSummary {
  totalRequests: number;
  searchBotRequests: number;
  searchBot2xx: number;
  searchBot3xx: number;
  searchBot4xx: number;
  searchBot5xx: number;
  p95SearchBotResponseMs: number | null;
  uniqueSearchBotUrls: number;
}

export type CrawlAssessmentStatus = "READY" | "DEGRADED" | "BLOCKED" | "INSUFFICIENT_EVIDENCE";

export interface CrawlAssessment {
  site: string;
  datasetDigest: string;
  status: CrawlAssessmentStatus;
  summary: CrawlSummary;
  issues: readonly CrawlIssue[];
  assessmentDigest: string;
  nonClaim: "OBSERVED_SERVER_OR_EDGE_REQUEST_DIAGNOSTIC_NOT_SEARCH_ENGINE_INDEXING_OR_RANKING_EVIDENCE";
}

function percentile95(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.ceil(sorted.length * 0.95) - 1] ?? null;
}

function redirectIssues(observations: readonly CrawlObservation[]): CrawlIssue[] {
  const byUrl = new Map<string, CrawlObservation[]>();
  for (const observation of observations) {
    if (observation.actor !== "SEARCH_BOT" || observation.redirectLocation === null) continue;
    const list = byUrl.get(observation.url) ?? [];
    list.push(observation);
    byUrl.set(observation.url, list);
  }
  const issues: CrawlIssue[] = [];
  for (const start of [...byUrl.keys()].sort()) {
    const visited = new Set<string>();
    const ids: string[] = [];
    let current = start;
    for (let hop = 0; hop < 6; hop += 1) {
      if (visited.has(current)) {
        issues.push({ code: "SEARCH_BOT_REDIRECT_CHAIN", severity: "ERROR", url: start, observationIds: Object.freeze(ids), detail: "Observed search-bot redirects contain a loop." });
        break;
      }
      visited.add(current);
      const nextObservation = byUrl.get(current)?.[0];
      if (!nextObservation?.redirectLocation) break;
      ids.push(nextObservation.id);
      current = nextObservation.redirectLocation;
      if (hop >= 2) {
        issues.push({ code: "SEARCH_BOT_REDIRECT_CHAIN", severity: "WARN", url: start, observationIds: Object.freeze([...ids]), detail: "Observed search-bot redirect path exceeds two hops." });
        break;
      }
    }
  }
  return issues;
}

export function assessCrawl(dataset: CrawlDataset): CrawlAssessment {
  validateDataset(dataset);
  const search = dataset.observations.filter((item) => item.actor === "SEARCH_BOT");
  const timings = search.map((item) => item.responseTimeMs).filter((value): value is number => value !== null);
  const summary: CrawlSummary = Object.freeze({
    totalRequests: dataset.observations.length,
    searchBotRequests: search.length,
    searchBot2xx: search.filter((item) => item.status >= 200 && item.status <= 299).length,
    searchBot3xx: search.filter((item) => item.status >= 300 && item.status <= 399).length,
    searchBot4xx: search.filter((item) => item.status >= 400 && item.status <= 499).length,
    searchBot5xx: search.filter((item) => item.status >= 500).length,
    p95SearchBotResponseMs: percentile95(timings),
    uniqueSearchBotUrls: new Set(search.map((item) => item.url)).size,
  });
  const issues: CrawlIssue[] = [];
  if (search.length < 3) issues.push({ code: "INSUFFICIENT_SEARCH_BOT_EVIDENCE", severity: "INFO", url: null, observationIds: Object.freeze(search.map((item) => item.id)), detail: "Fewer than three observed search-bot requests are available in this bounded window." });
  for (const item of search) {
    if (item.status >= 500) issues.push({ code: "SEARCH_BOT_5XX", severity: "ERROR", url: item.url, observationIds: Object.freeze([item.id]), detail: `Observed search-bot request returned HTTP ${item.status}.` });
    else if (item.status >= 400) issues.push({ code: "SEARCH_BOT_4XX", severity: item.status === 429 ? "ERROR" : "WARN", url: item.url, observationIds: Object.freeze([item.id]), detail: `Observed search-bot request returned HTTP ${item.status}.` });
    if (item.robotsAllowed === false && item.status >= 200 && item.status <= 299) issues.push({ code: "ROBOTS_POLICY_CONFLICT", severity: "WARN", url: item.url, observationIds: Object.freeze([item.id]), detail: "Observation is marked robots-disallowed while the request was served successfully; verify robots-policy attribution and edge behavior." });
    if (item.responseTimeMs !== null && item.responseTimeMs > 3_000) issues.push({ code: "SLOW_SEARCH_BOT_RESPONSE", severity: "WARN", url: item.url, observationIds: Object.freeze([item.id]), detail: `Observed search-bot response took ${item.responseTimeMs} ms.` });
  }
  issues.push(...redirectIssues(search));
  issues.sort((a, b) => `${a.code}:${a.url ?? ""}:${a.observationIds.join(",")}`.localeCompare(`${b.code}:${b.url ?? ""}:${b.observationIds.join(",")}`));
  const hasError = issues.some((issue) => issue.severity === "ERROR");
  const hasWarn = issues.some((issue) => issue.severity === "WARN");
  const status: CrawlAssessmentStatus = search.length < 3 ? "INSUFFICIENT_EVIDENCE" : hasError ? "BLOCKED" : hasWarn ? "DEGRADED" : "READY";
  const core = {
    site: dataset.site,
    datasetDigest: dataset.datasetDigest,
    status,
    summary,
    issues: Object.freeze(issues),
    nonClaim: "OBSERVED_SERVER_OR_EDGE_REQUEST_DIAGNOSTIC_NOT_SEARCH_ENGINE_INDEXING_OR_RANKING_EVIDENCE" as const,
  };
  return Object.freeze({ ...core, assessmentDigest: digestValue(core) });
}

export function validateAssessment(dataset: CrawlDataset, assessment: CrawlAssessment): void {
  const rebuilt = assessCrawl(dataset);
  if (rebuilt.assessmentDigest !== assessment.assessmentDigest) throw new Error("assessment digest mismatch");
  if (digestValue(rebuilt) !== digestValue(assessment)) throw new Error("assessment replay mismatch");
}

export function parseObservationJsonLine(line: string): CrawlObservationInput {
  const raw = clean("JSON line", line, 20_000);
  const parsed: unknown = JSON.parse(raw);
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("observation line must be an object");
  const allowed = new Set(["id", "observedAt", "url", "status", "userAgent", "actor", "authority", "source", "responseTimeMs", "redirectLocation", "robotsAllowed"]);
  for (const key of Object.keys(parsed)) if (!allowed.has(key)) throw new Error(`unknown observation field ${key}`);
  const value = parsed as Record<string, unknown>;
  return {
    id: value.id as string,
    observedAt: value.observedAt as string,
    url: value.url as string,
    status: value.status as number,
    userAgent: value.userAgent as string,
    actor: value.actor as CrawlActor,
    authority: value.authority as ObservationAuthority,
    source: value.source as string,
    responseTimeMs: value.responseTimeMs as number | undefined,
    redirectLocation: value.redirectLocation as string | undefined,
    robotsAllowed: value.robotsAllowed as boolean | null | undefined,
  };
}
