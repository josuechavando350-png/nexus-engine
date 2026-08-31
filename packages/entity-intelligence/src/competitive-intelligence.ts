import { Buffer } from "node:buffer";
import { canonicalJson, digest } from "./index";
import { requestPinnedPublicUrl, resolvePublicAddress, type LookupPublic } from "./competitive-public-http";

const MAX_COMPETITORS = 20;
const MAX_BODY_BYTES = 2_000_000;
const MAX_REDIRECTS = 3;
const MAX_TIMEOUT_MS = 30_000;
const MAX_URL = 4_096;
const MAX_TERMS = 2_000;
const liveObservations = new WeakSet<object>();

export interface CompetitiveScope { readonly tenantId: string; readonly organizationId: string; readonly brandId: string }
export type CompetitiveAuthority = "PUBLIC_HTTP_CAPTURE" | "CONTROLLED_TEST";
export interface PublicPageObservation {
  readonly url: string; readonly finalUrl: string; readonly observedAt: string; readonly status: number;
  readonly authority: CompetitiveAuthority; readonly title: string | null; readonly description: string | null;
  readonly canonicalUrl: string | null; readonly visibleTerms: readonly string[]; readonly bodyDigest: string; readonly observationDigest: string;
}
export interface CompetitiveSubject { readonly id: string; readonly label: string; readonly observation: PublicPageObservation }
export interface CompetitiveGap { readonly term: string; readonly competitorCount: number; readonly targetPresent: boolean }
export interface CompetitiveIntelligenceReport {
  readonly formatVersion: "nexus-competitive-intelligence-v1"; readonly scope: CompetitiveScope; readonly targetId: string;
  readonly competitorIds: readonly string[]; readonly evidenceState: "OBSERVED_PUBLIC_HTTP" | "SYNTHETIC";
  readonly nonClaim: "PUBLIC_PAGE_OBSERVATION_NOT_MARKET_SHARE_RANKING_TRAFFIC_OR_BUSINESS_OUTCOME";
  readonly gaps: readonly CompetitiveGap[]; readonly sourceDigests: readonly string[]; readonly reportDigest: string;
}

type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

function clean(label: string, value: string, max = 500): string {
  if (typeof value !== "string") throw new Error(`${label} must be a string`);
  const normalized = value.normalize("NFKC").replace(/\s+/gu, " ").trim();
  if (!normalized || normalized.length > max) throw new Error(`${label} must be non-empty and <= ${max} characters`);
  return normalized;
}
function cleanNullable(label: string, value: string | null, max: number): string | null { return value === null ? null : clean(label, value, max); }
function normalizedScope(value: CompetitiveScope): CompetitiveScope {
  if (!value || typeof value !== "object") throw new Error("scope must be an object");
  return Object.freeze({ tenantId: clean("scope.tenantId", value.tenantId, 128), organizationId: clean("scope.organizationId", value.organizationId, 128), brandId: clean("scope.brandId", value.brandId, 128) });
}
export function validateCompetitiveScope(value: CompetitiveScope): CompetitiveScope { return normalizedScope(value); }
function normalizeUrl(value: string): string {
  const parsed = new URL(clean("URL", value, MAX_URL));
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
function decodeEntities(value: string): string { return value.replace(/&amp;/giu, "&").replace(/&quot;/giu, '"').replace(/&#39;|&apos;/giu, "'").replace(/&lt;/giu, "<").replace(/&gt;/giu, ">"); }
function matchFirst(html: string, expression: RegExp): string | null {
  const match = expression.exec(html)?.[1];
  if (!match) return null;
  const normalized = decodeEntities(match.replace(/<[^>]*>/gu, " ")).replace(/\s+/gu, " ").trim();
  return normalized ? normalized.slice(0, 2_000) : null;
}
function visibleTerms(html: string): readonly string[] {
  const text = html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/giu, " ").replace(/<style\b[^>]*>[\s\S]*?<\/style>/giu, " ").replace(/<[^>]+>/gu, " ");
  const normalized = decodeEntities(text).normalize("NFKD").replace(/[\u0300-\u036f]/gu, "").toLocaleLowerCase("en-US");
  const counts = new Map<string, number>();
  for (const term of normalized.split(/[^a-z0-9]+/gu).filter((entry) => entry.length >= 3 && entry.length <= 80)) counts.set(term, (counts.get(term) ?? 0) + 1);
  return Object.freeze([...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], "en")).slice(0, MAX_TERMS).map(([term]) => term));
}
function buildObservation(input: Omit<PublicPageObservation, "observationDigest">): PublicPageObservation {
  if (input.authority !== "PUBLIC_HTTP_CAPTURE" && input.authority !== "CONTROLLED_TEST") throw new Error("unknown competitive observation authority");
  if (!Number.isInteger(input.status) || input.status < 200 || input.status > 299) throw new Error("competitive observation requires a successful HTTP response");
  if (!/^[a-f0-9]{64}$/u.test(input.bodyDigest)) throw new Error("bodyDigest must be sha256 hex");
  const terms = input.visibleTerms.map((term) => clean("visible term", term, 80));
  if (terms.length > MAX_TERMS || new Set(terms).size !== terms.length) throw new Error("visible terms must be unique and bounded");
  const core = {
    url: normalizeUrl(input.url), finalUrl: normalizeUrl(input.finalUrl), observedAt: canonicalTime(input.observedAt), status: input.status, authority: input.authority,
    title: cleanNullable("title", input.title, 2_000), description: cleanNullable("description", input.description, 2_000),
    canonicalUrl: input.canonicalUrl === null ? null : normalizeUrl(input.canonicalUrl), visibleTerms: Object.freeze(terms), bodyDigest: input.bodyDigest,
  };
  return Object.freeze({ ...core, observationDigest: digest(core) });
}
export function createControlledPublicPageObservation(input: Omit<PublicPageObservation, "authority" | "observationDigest">): PublicPageObservation { return buildObservation({ ...input, authority: "CONTROLLED_TEST" }); }
export function validatePublicPageObservation(observation: PublicPageObservation): void {
  const { observationDigest, ...input } = observation;
  const rebuilt = buildObservation(input);
  if (rebuilt.observationDigest !== observationDigest || canonicalJson(rebuilt) !== canonicalJson(observation)) throw new Error("public page observation replay mismatch");
  if (observation.authority === "PUBLIC_HTTP_CAPTURE" && !liveObservations.has(observation)) throw new Error("public HTTP observation is not live-attested in this process");
}

function abortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new Error("competitive capture cancelled");
}

async function readBoundedBody(response: Response, controller: AbortController): Promise<string> {
  const contentLength = Number(response.headers.get("content-length") ?? "0");
  if (Number.isFinite(contentLength) && contentLength > MAX_BODY_BYTES) throw new Error("competitive capture body exceeds byte budget");
  const reader = response.body?.getReader();
  if (!reader) throw new Error("competitive capture response has no body");
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  while (true) {
    if (controller.signal.aborted) {
      await reader.cancel(controller.signal.reason).catch(() => undefined);
      throw abortError(controller.signal);
    }
    let onAbort: (() => void) | undefined;
    const aborted = new Promise<never>((_resolve, reject) => {
      onAbort = () => {
        const error = abortError(controller.signal);
        reject(error);
        void reader.cancel(controller.signal.reason).catch(() => undefined);
      };
      controller.signal.addEventListener("abort", onAbort, { once: true });
    });
    let chunk: ReadableStreamReadResult<Uint8Array>;
    try {
      chunk = await Promise.race([reader.read(), aborted]);
    } finally {
      if (onAbort) controller.signal.removeEventListener("abort", onAbort);
    }
    if (controller.signal.aborted) throw abortError(controller.signal);
    if (chunk.done) break;
    bytes += chunk.value.byteLength;
    if (bytes > MAX_BODY_BYTES) {
      controller.abort(new Error("body budget exceeded"));
      await reader.cancel(controller.signal.reason).catch(() => undefined);
      throw new Error("competitive capture body exceeds byte budget");
    }
    chunks.push(chunk.value);
  }
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString("utf8");
}

export async function capturePublicPage(
  url: string,
  observedAt: string,
  options: Readonly<{ timeoutMs?: number; signal?: AbortSignal; fetchImpl?: FetchLike; lookup?: LookupPublic }> = {},
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
  const controlledTransport = Boolean(options.fetchImpl || options.lookup);
  let current = initialUrl;
  try {
    for (let redirect = 0; redirect <= MAX_REDIRECTS; redirect += 1) {
      if (controller.signal.aborted) throw abortError(controller.signal);
      let response: Response;
      if (controlledTransport) {
        await resolvePublicAddress(current, options.lookup);
        response = await (options.fetchImpl ?? fetch)(current, { method: "GET", redirect: "manual", signal: controller.signal });
      } else {
        response = await requestPinnedPublicUrl(current, controller.signal);
      }
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get("location");
        if (!location) throw new Error("redirect response omitted location");
        if (redirect === MAX_REDIRECTS) throw new Error("redirect limit exceeded");
        current = normalizeUrl(new URL(location, current).toString());
        continue;
      }
      if (response.status < 200 || response.status > 299) throw new Error(`competitive capture returned HTTP ${response.status}`);
      const body = await readBoundedBody(response, controller);
      const canonicalHref = matchFirst(body, /<link\b[^>]*rel=["'][^"']*canonical[^"']*["'][^>]*href=["']([^"']+)["'][^>]*>/iu) ?? matchFirst(body, /<link\b[^>]*href=["']([^"']+)["'][^>]*rel=["'][^"']*canonical[^"']*["'][^>]*>/iu);
      const observation = buildObservation({
        url: initialUrl, finalUrl: current, observedAt, status: response.status, authority: controlledTransport ? "CONTROLLED_TEST" : "PUBLIC_HTTP_CAPTURE",
        title: matchFirst(body, /<title\b[^>]*>([\s\S]*?)<\/title>/iu),
        description: matchFirst(body, /<meta\b[^>]*name=["']description["'][^>]*content=["']([^"']*)["'][^>]*>/iu) ?? matchFirst(body, /<meta\b[^>]*content=["']([^"']*)["'][^>]*name=["']description["'][^>]*>/iu),
        canonicalUrl: canonicalHref ? normalizeUrl(new URL(canonicalHref, current).toString()) : null, visibleTerms: visibleTerms(body), bodyDigest: digest(body),
      });
      if (!controlledTransport) liveObservations.add(observation);
      return observation;
    }
    throw new Error("unreachable redirect state");
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", forwardAbort);
  }
}

export function analyzeCompetitiveIntelligence(scopeInput: CompetitiveScope, target: CompetitiveSubject, competitors: readonly CompetitiveSubject[]): CompetitiveIntelligenceReport {
  const scope = normalizedScope(scopeInput);
  if (competitors.length < 1 || competitors.length > MAX_COMPETITORS) throw new Error(`competitors must contain 1 to ${MAX_COMPETITORS} observations`);
  const all = [target, ...competitors];
  const ids = all.map((subject) => clean("subject.id", subject.id, 200));
  if (new Set(ids).size !== ids.length) throw new Error("competitive subject ids must be unique");
  all.forEach((subject) => { clean("subject.label", subject.label, 500); validatePublicPageObservation(subject.observation); });
  const authorities = new Set(all.map((subject) => subject.observation.authority));
  if (authorities.size !== 1) throw new Error("mixed competitive observation authorities are forbidden");
  const targetTerms = new Set(target.observation.visibleTerms);
  const counts = new Map<string, number>();
  for (const competitor of competitors) for (const term of competitor.observation.visibleTerms) counts.set(term, (counts.get(term) ?? 0) + 1);
  const gaps = Object.freeze([...counts.entries()].map(([term, competitorCount]) => ({ term, competitorCount, targetPresent: targetTerms.has(term) })).filter((gap) => !gap.targetPresent).sort((a, b) => b.competitorCount - a.competitorCount || a.term.localeCompare(b.term, "en")).slice(0, 500));
  const core = {
    formatVersion: "nexus-competitive-intelligence-v1" as const, scope, targetId: ids[0]!, competitorIds: Object.freeze(ids.slice(1).sort((a, b) => a.localeCompare(b, "en"))),
    evidenceState: target.observation.authority === "PUBLIC_HTTP_CAPTURE" ? "OBSERVED_PUBLIC_HTTP" as const : "SYNTHETIC" as const,
    nonClaim: "PUBLIC_PAGE_OBSERVATION_NOT_MARKET_SHARE_RANKING_TRAFFIC_OR_BUSINESS_OUTCOME" as const, gaps,
    sourceDigests: Object.freeze(all.map((subject) => subject.observation.observationDigest).sort((a, b) => a.localeCompare(b, "en"))),
  };
  return Object.freeze({ ...core, reportDigest: digest(core) });
}
export function verifyCompetitiveIntelligence(scopeInput: CompetitiveScope, target: CompetitiveSubject, competitors: readonly CompetitiveSubject[], report: CompetitiveIntelligenceReport): boolean {
  try { return canonicalJson(analyzeCompetitiveIntelligence(scopeInput, target, competitors)) === canonicalJson(report); } catch { return false; }
}
