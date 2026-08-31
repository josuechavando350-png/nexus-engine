import { Buffer } from "node:buffer";
import { lookup as dnsLookup } from "node:dns/promises";
import { isIP } from "node:net";
import { canonicalJson, digest } from "./index";

const MAX_COMPETITORS = 20;
const MAX_BODY_BYTES = 2_000_000;
const MAX_REDIRECTS = 3;
const MAX_TIMEOUT_MS = 30_000;
const MAX_URL = 4_096;
const MAX_TERMS = 2_000;

export interface CompetitiveScope {
  readonly tenantId: string;
  readonly organizationId: string;
  readonly brandId: string;
}

export type CompetitiveAuthority = "PUBLIC_HTTP_CAPTURE" | "CONTROLLED_TEST";

export interface PublicPageObservation {
  readonly url: string;
  readonly finalUrl: string;
  readonly observedAt: string;
  readonly status: number;
  readonly authority: CompetitiveAuthority;
  readonly title: string | null;
  readonly description: string | null;
  readonly canonicalUrl: string | null;
  readonly visibleTerms: readonly string[];
  readonly bodyDigest: string;
  readonly observationDigest: string;
}

export interface CompetitiveSubject {
  readonly id: string;
  readonly label: string;
  readonly observation: PublicPageObservation;
}

export interface CompetitiveGap {
  readonly term: string;
  readonly competitorCount: number;
  readonly targetPresent: boolean;
}

export interface CompetitiveIntelligenceReport {
  readonly formatVersion: "nexus-competitive-intelligence-v1";
  readonly scope: CompetitiveScope;
  readonly targetId: string;
  readonly competitorIds: readonly string[];
  readonly evidenceState: "OBSERVED_PUBLIC_HTTP" | "SYNTHETIC" | "NOT_ENOUGH_EVIDENCE";
  readonly nonClaim: "PUBLIC_PAGE_OBSERVATION_NOT_MARKET_SHARE_RANKING_TRAFFIC_OR_BUSINESS_OUTCOME";
  readonly gaps: readonly CompetitiveGap[];
  readonly sourceDigests: readonly string[];
  readonly reportDigest: string;
}

type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
type LookupLike = (hostname: string) => Promise<readonly { address: string; family: number }[]>;

function clean(label: string, value: string, max = 500): string {
  if (typeof value !== "string") throw new Error(`${label} must be a string`);
  const normalized = value.normalize("NFKC").replace(/\s+/gu, " ").trim();
  if (!normalized || normalized.length > max) throw new Error(`${label} must be non-empty and <= ${max} characters`);
  return normalized;
}

function scope(scope: CompetitiveScope): CompetitiveScope {
  return Object.freeze({
    tenantId: clean("scope.tenantId", scope.tenantId, 128),
    organizationId: clean("scope.organizationId", scope.organizationId, 128),
    brandId: clean("scope.brandId", scope.brandId, 128),
  });
}

function normalizeUrl(value: string): string {
  const raw = clean("URL", value, MAX_URL);
  const parsed = new URL(raw);
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") throw new Error("URL must use HTTP(S)");
  if (parsed.username || parsed.password) throw new Error("URL credentials are forbidden");
  if (!parsed.hostname || parsed.hostname === "localhost" || parsed.hostname.endsWith(".localhost")) throw new Error("local hosts are forbidden");
  parsed.hash = "";
  return parsed.toString();
}

function canonicalTime(value: string): string {
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== value) throw new Error("observedAt must be canonical ISO-8601 UTC");
  return value;
}

function isPrivateIpv4(address: string): boolean {
  const parts = address.split(".").map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return true;
  const [a, b] = parts;
  return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b! >= 16 && b! <= 31) || (a === 192 && b === 168) || a! >= 224;
}

function isPrivateIp(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return isPrivateIpv4(address);
  if (family !== 6) return true;
  const normalized = address.toLowerCase();
  if (normalized === "::" || normalized === "::1" || normalized.startsWith("fe80:") || normalized.startsWith("fc") || normalized.startsWith("fd")) return true;
  if (normalized.startsWith("::ffff:")) return isPrivateIpv4(normalized.slice(7));
  return false;
}

async function defaultLookup(hostname: string): Promise<readonly { address: string; family: number }[]> {
  return dnsLookup(hostname, { all: true, verbatim: true });
}

async function assertPublicDestination(url: string, lookup: LookupLike): Promise<void> {
  const parsed = new URL(url);
  if (isIP(parsed.hostname)) {
    if (isPrivateIp(parsed.hostname)) throw new Error("private or reserved IP destination is forbidden");
    return;
  }
  const addresses = await lookup(parsed.hostname);
  if (addresses.length === 0) throw new Error("hostname did not resolve");
  if (addresses.some(({ address }) => isPrivateIp(address))) throw new Error("hostname resolves to a private or reserved destination");
}

function decodeEntities(value: string): string {
  return value.replace(/&amp;/giu, "&").replace(/&quot;/giu, '"').replace(/&#39;|&apos;/giu, "'").replace(/&lt;/giu, "<").replace(/&gt;/giu, ">");
}

function matchFirst(html: string, expression: RegExp): string | null {
  const match = expression.exec(html)?.[1];
  if (!match) return null;
  const normalized = decodeEntities(match.replace(/<[^>]*>/gu, " ")).replace(/\s+/gu, " ").trim();
  return normalized ? normalized.slice(0, 2_000) : null;
}

function visibleTerms(html: string): readonly string[] {
  const withoutNoise = html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/giu, " ").replace(/<style\b[^>]*>[\s\S]*?<\/style>/giu, " ").replace(/<[^>]+>/gu, " ");
  const normalized = decodeEntities(withoutNoise).normalize("NFKD").replace(/[\u0300-\u036f]/gu, "").toLocaleLowerCase("en-US");
  const counts = new Map<string, number>();
  for (const term of normalized.split(/[^a-z0-9]+/gu).filter((term) => term.length >= 3 && term.length <= 80)) counts.set(term, (counts.get(term) ?? 0) + 1);
  return Object.freeze([...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], "en")).slice(0, MAX_TERMS).map(([term]) => term));
}

function buildObservation(input: Omit<PublicPageObservation, "observationDigest">): PublicPageObservation {
  const core = {
    url: normalizeUrl(input.url),
    finalUrl: normalizeUrl(input.finalUrl),
    observedAt: canonicalTime(input.observedAt),
    status: input.status,
    authority: input.authority,
    title: input.title,
    description: input.description,
    canonicalUrl: input.canonicalUrl === null ? null : normalizeUrl(input.canonicalUrl),
    visibleTerms: Object.freeze([...input.visibleTerms]),
    bodyDigest: input.bodyDigest,
  };
  if (!Number.isInteger(core.status) || core.status < 100 || core.status > 599) throw new Error("status must be an HTTP status code");
  if (!/^[a-f0-9]{64}$/u.test(core.bodyDigest)) throw new Error("bodyDigest must be sha256 hex");
  if (new Set(core.visibleTerms).size !== core.visibleTerms.length || core.visibleTerms.length > MAX_TERMS) throw new Error("visible terms must be unique and bounded");
  return Object.freeze({ ...core, observationDigest: digest(core) });
}

export function createControlledPublicPageObservation(input: Omit<PublicPageObservation, "authority" | "observationDigest">): PublicPageObservation {
  return buildObservation({ ...input, authority: "CONTROLLED_TEST" });
}

export function validatePublicPageObservation(observation: PublicPageObservation): void {
  const { observationDigest, ...input } = observation;
  const rebuilt = buildObservation(input);
  if (rebuilt.observationDigest !== observationDigest || canonicalJson(rebuilt) !== canonicalJson(observation)) throw new Error("public page observation replay mismatch");
}

export async function capturePublicPage(
  url: string,
  observedAt: string,
  options: Readonly<{ timeoutMs?: number; signal?: AbortSignal; fetchImpl?: FetchLike; lookup?: LookupLike }> = {},
): Promise<PublicPageObservation> {
  const timeoutMs = options.timeoutMs ?? 10_000;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > MAX_TIMEOUT_MS) throw new Error("timeoutMs must be an integer from 100 to 30000");
  const initialUrl = normalizeUrl(url);
  canonicalTime(observedAt);
  const controller = new AbortController();
  const forwardAbort = () => controller.abort(options.signal?.reason);
  if (options.signal?.aborted) controller.abort(options.signal.reason);
  else options.signal?.addEventListener("abort", forwardAbort, { once: true });
  const timer = setTimeout(() => controller.abort(new Error("competitive capture timeout")), timeoutMs);
  const fetchImpl = options.fetchImpl ?? fetch;
  const lookup = options.lookup ?? defaultLookup;
  let current = initialUrl;
  try {
    for (let redirect = 0; redirect <= MAX_REDIRECTS; redirect += 1) {
      await assertPublicDestination(current, lookup);
      const response = await fetchImpl(current, { method: "GET", redirect: "manual", signal: controller.signal, headers: { accept: "text/html,application/xhtml+xml;q=0.9,*/*;q=0.1", "user-agent": "NEXUS-Competitive-Observation/1.0" } });
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get("location");
        if (!location) throw new Error("redirect response omitted location");
        if (redirect === MAX_REDIRECTS) throw new Error("redirect limit exceeded");
        current = normalizeUrl(new URL(location, current).toString());
        continue;
      }
      const contentLength = Number(response.headers.get("content-length") ?? "0");
      if (Number.isFinite(contentLength) && contentLength > MAX_BODY_BYTES) throw new Error("competitive capture body exceeds byte budget");
      const reader = response.body?.getReader();
      if (!reader) throw new Error("competitive capture response has no body");
      const chunks: Uint8Array[] = [];
      let bytes = 0;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        bytes += value.byteLength;
        if (bytes > MAX_BODY_BYTES) { controller.abort(); throw new Error("competitive capture body exceeds byte budget"); }
        chunks.push(value);
      }
      const body = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString("utf8");
      const canonicalHref = matchFirst(body, /<link\b[^>]*rel=["'][^"']*canonical[^"']*["'][^>]*href=["']([^"']+)["'][^>]*>/iu)
        ?? matchFirst(body, /<link\b[^>]*href=["']([^"']+)["'][^>]*rel=["'][^"']*canonical[^"']*["'][^>]*>/iu);
      const canonicalUrl = canonicalHref ? normalizeUrl(new URL(canonicalHref, current).toString()) : null;
      return buildObservation({
        url: initialUrl,
        finalUrl: current,
        observedAt,
        status: response.status,
        authority: "PUBLIC_HTTP_CAPTURE",
        title: matchFirst(body, /<title\b[^>]*>([\s\S]*?)<\/title>/iu),
        description: matchFirst(body, /<meta\b[^>]*name=["']description["'][^>]*content=["']([^"']*)["'][^>]*>/iu) ?? matchFirst(body, /<meta\b[^>]*content=["']([^"']*)["'][^>]*name=["']description["'][^>]*>/iu),
        canonicalUrl,
        visibleTerms: visibleTerms(body),
        bodyDigest: digest(body),
      });
    }
    throw new Error("unreachable redirect state");
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", forwardAbort);
  }
}

export function analyzeCompetitiveIntelligence(scopeInput: CompetitiveScope, target: CompetitiveSubject, competitors: readonly CompetitiveSubject[]): CompetitiveIntelligenceReport {
  const normalizedScope = scope(scopeInput);
  if (competitors.length === 0) throw new Error("at least one competitor observation is required");
  if (competitors.length > MAX_COMPETITORS) throw new Error(`competitors exceed ${MAX_COMPETITORS}`);
  const all = [target, ...competitors];
  const ids = all.map((subject) => clean("subject.id", subject.id, 200));
  if (new Set(ids).size !== ids.length) throw new Error("competitive subject ids must be unique");
  all.forEach((subject) => { clean("subject.label", subject.label, 500); validatePublicPageObservation(subject.observation); });
  const authorities = new Set(all.map((subject) => subject.observation.authority));
  if (authorities.size !== 1) throw new Error("mixed competitive observation authorities are forbidden");
  const targetTerms = new Set(target.observation.visibleTerms);
  const counts = new Map<string, number>();
  for (const competitor of competitors) for (const term of competitor.observation.visibleTerms) counts.set(term, (counts.get(term) ?? 0) + 1);
  const gaps = Object.freeze([...counts.entries()].map(([term, competitorCount]) => ({ term, competitorCount, targetPresent: targetTerms.has(term) }))
    .filter((gap) => !gap.targetPresent)
    .sort((a, b) => b.competitorCount - a.competitorCount || a.term.localeCompare(b.term, "en"))
    .slice(0, 500));
  const evidenceState = all.every((subject) => subject.observation.authority === "PUBLIC_HTTP_CAPTURE")
    ? "OBSERVED_PUBLIC_HTTP" as const
    : all.length > 1 ? "SYNTHETIC" as const : "NOT_ENOUGH_EVIDENCE" as const;
  const core = {
    formatVersion: "nexus-competitive-intelligence-v1" as const,
    scope: normalizedScope,
    targetId: ids[0]!,
    competitorIds: Object.freeze(ids.slice(1).sort((a, b) => a.localeCompare(b, "en"))),
    evidenceState,
    nonClaim: "PUBLIC_PAGE_OBSERVATION_NOT_MARKET_SHARE_RANKING_TRAFFIC_OR_BUSINESS_OUTCOME" as const,
    gaps,
    sourceDigests: Object.freeze(all.map((subject) => subject.observation.observationDigest).sort((a, b) => a.localeCompare(b, "en"))),
  };
  return Object.freeze({ ...core, reportDigest: digest(core) });
}

export function verifyCompetitiveIntelligence(scopeInput: CompetitiveScope, target: CompetitiveSubject, competitors: readonly CompetitiveSubject[], report: CompetitiveIntelligenceReport): boolean {
  try { return canonicalJson(analyzeCompetitiveIntelligence(scopeInput, target, competitors)) === canonicalJson(report); } catch { return false; }
}
