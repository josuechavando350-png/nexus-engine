import { createHash } from "node:crypto";
import { parseOcdsOpportunities, type ProcurementOpportunity } from "./ocds.js";
import { PublicProcurementUrlPolicy } from "./public-url-policy.js";
import { RobotsPolicy } from "./robots.js";

export class ProcurementIntelligenceError extends Error {
  constructor(
    public readonly code: "INVALID_INPUT" | "ROBOTS_DENIED" | "SOURCE_FAILURE" | "BOUNDS_EXCEEDED" | "IDENTITY_MISMATCH",
    message: string,
  ) {
    super(message);
    this.name = "ProcurementIntelligenceError";
  }
}

export type ProcurementSourceKind = "OCDS_JSON" | "PUBLIC_HTML";

export interface ProcurementSourceConfig {
  readonly sourceId: string;
  readonly kind: ProcurementSourceKind;
  readonly url: string;
  readonly noticePathPrefixes?: readonly string[];
}

export interface ProcurementTenantProfile {
  readonly tenantId: string;
  readonly canonicalWebsiteOrigin: string;
  readonly capabilityPhrases: readonly string[];
  readonly minimumMatchScore: number;
}

export interface PublicBrowserPage {
  readonly finalUrl: string;
  readonly status: number;
  readonly title: string;
  readonly text: string;
  readonly links: readonly string[];
}

export interface PublicProcurementBrowserPort {
  fetchPublicPage(input: Readonly<{
    tenantId: string;
    url: string;
    userAgent: string;
    timeoutMs: number;
    maxTextBytes: number;
    authorizeUrl: (url: URL) => Promise<void>;
  }>): Promise<PublicBrowserPage>;
}

export interface ProcurementMatch {
  readonly opportunity: ProcurementOpportunity;
  readonly score: number;
  readonly matchedCapabilities: readonly string[];
  readonly handoffUrl: string;
}

export interface ProcurementScanResult {
  readonly sourceId: string;
  readonly sourceKind: ProcurementSourceKind;
  readonly observedAt: string;
  readonly opportunities: readonly ProcurementOpportunity[];
  readonly matches: readonly ProcurementMatch[];
}

const USER_AGENT = "NexusProcurementBot";
const MAX_JSON_BYTES = 4 * 1024 * 1024;
const MAX_ROBOTS_BYTES = 512 * 1024;
const MAX_HTML_TEXT_BYTES = 2 * 1024 * 1024;
const MAX_HTML_LINKS = 256;
const MAX_HTML_NOTICES = 20;
const MAX_NOTICE_PREFIXES = 16;
const MAX_CAPABILITIES = 64;
const MAX_CAPABILITY_LENGTH = 256;
const SOURCE_ID = /^[a-z0-9][a-z0-9._-]{2,127}$/u;
const TENANT_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{2,191}$/u;

function canonicalNow(now: () => number): string {
  const value = now();
  if (!Number.isFinite(value)) throw new ProcurementIntelligenceError("INVALID_INPUT", "clock returned an invalid value");
  return new Date(value).toISOString();
}

async function readBounded(response: Response, maxBytes: number): Promise<Uint8Array> {
  const declared = response.headers.get("content-length");
  if (declared !== null && (!/^\d+$/u.test(declared) || Number(declared) > maxBytes)) {
    throw new ProcurementIntelligenceError("BOUNDS_EXCEEDED", "public procurement response exceeds its byte bound");
  }
  if (!response.body) throw new ProcurementIntelligenceError("SOURCE_FAILURE", "public procurement response body is missing");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new ProcurementIntelligenceError("BOUNDS_EXCEEDED", "public procurement response exceeds its byte bound");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return bytes;
}

function normalizeTerms(value: string): readonly string[] {
  return Object.freeze(value.normalize("NFKC").toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((token) => token.length >= 3).slice(0, 512));
}

function matchOpportunity(opportunity: ProcurementOpportunity, profile: ProcurementTenantProfile): { score: number; matchedCapabilities: readonly string[] } {
  const haystack = new Set(normalizeTerms(`${opportunity.title} ${opportunity.description} ${opportunity.procurementMethod ?? ""}`));
  const matched: string[] = [];
  let totalTokens = 0;
  let matchedTokens = 0;
  for (const phrase of profile.capabilityPhrases) {
    const tokens = normalizeTerms(phrase);
    if (tokens.length === 0) continue;
    totalTokens += tokens.length;
    const hits = tokens.filter((token) => haystack.has(token)).length;
    matchedTokens += hits;
    if (hits === tokens.length) matched.push(phrase);
  }
  const score = totalTokens === 0 ? 0 : matchedTokens / totalTokens;
  return { score, matchedCapabilities: Object.freeze(matched) };
}

function htmlOpportunity(page: PublicBrowserPage, sourceUrl: URL, observedAt: string): ProcurementOpportunity {
  const title = page.title.trim() || "Public procurement notice";
  const text = page.text.normalize("NFKC").replace(/\s+/gu, " ").trim();
  if (!text) throw new ProcurementIntelligenceError("SOURCE_FAILURE", "public procurement page has no readable text");
  const documentUrls = page.links.slice(0, MAX_HTML_LINKS).flatMap((raw) => {
    try {
      const url = new URL(raw, page.finalUrl);
      return url.protocol === "https:" && url.origin === sourceUrl.origin ? [url.toString()] : [];
    } catch {
      return [];
    }
  });
  const id = createHash("sha256").update(`${sourceUrl.toString()}\n${title}\n${text.slice(0, 4096)}`, "utf8").digest("hex");
  return Object.freeze({
    opportunityId: `html_${id}`,
    sourceKind: "PUBLIC_HTML" as const,
    sourceUrl: page.finalUrl,
    buyerName: null,
    title: title.slice(0, 2000),
    description: text.slice(0, 20_000),
    status: null,
    procurementMethod: null,
    deadline: null,
    amount: null,
    currency: null,
    documentUrls: Object.freeze(documentUrls),
    observedAt,
  });
}

export class PublicProcurementIntelligenceEngine {
  private readonly profile: ProcurementTenantProfile;

  constructor(private readonly input: Readonly<{
    profile: ProcurementTenantProfile;
    urlPolicy: PublicProcurementUrlPolicy;
    browser: PublicProcurementBrowserPort;
    fetchImpl?: typeof fetch;
    now?: () => number;
  }>) {
    const profile = input?.profile;
    if (!profile || !TENANT_ID.test(profile.tenantId) || !Array.isArray(profile.capabilityPhrases) || profile.capabilityPhrases.length < 1 || profile.capabilityPhrases.length > MAX_CAPABILITIES ||
      profile.capabilityPhrases.some((phrase) => typeof phrase !== "string" || !phrase.trim() || phrase.length > MAX_CAPABILITY_LENGTH) ||
      !Number.isFinite(profile.minimumMatchScore) || profile.minimumMatchScore < 0 || profile.minimumMatchScore > 1) {
      throw new ProcurementIntelligenceError("INVALID_INPUT", "procurement tenant profile is invalid");
    }
    const origin = new URL(profile.canonicalWebsiteOrigin);
    if (origin.protocol !== "https:" || origin.origin !== profile.canonicalWebsiteOrigin || origin.pathname !== "/" || origin.search || origin.hash) {
      throw new ProcurementIntelligenceError("INVALID_INPUT", "canonicalWebsiteOrigin must be a bare HTTPS origin");
    }
    if (!input.urlPolicy || !input.browser || typeof input.browser.fetchPublicPage !== "function") throw new ProcurementIntelligenceError("INVALID_INPUT", "procurement runtime dependencies are invalid");
    this.profile = Object.freeze({ ...profile, capabilityPhrases: Object.freeze([...profile.capabilityPhrases]) });
  }

  identity() {
    return Object.freeze({ strategy: 6 as const, provider: "PUBLIC_PROCUREMENT_INTELLIGENCE" as const, sellerWebsiteOrigin: this.profile.canonicalWebsiteOrigin });
  }

  private async fetchRobots(source: URL): Promise<RobotsPolicy> {
    const robots = new URL("/robots.txt", source.origin);
    await this.input.urlPolicy.authorize(robots);
    const fetchImpl = this.input.fetchImpl ?? fetch;
    let response: Response;
    try {
      response = await fetchImpl(robots, { method: "GET", headers: { accept: "text/plain", "user-agent": USER_AGENT }, redirect: "error", signal: AbortSignal.timeout(5_000) });
    } catch (error) {
      throw new ProcurementIntelligenceError("SOURCE_FAILURE", `robots.txt request failed: ${error instanceof Error ? error.message : "unknown error"}`);
    }
    if (response.status === 404 || response.status === 410) return new RobotsPolicy("");
    if (!response.ok) throw new ProcurementIntelligenceError("SOURCE_FAILURE", `robots.txt returned HTTP ${response.status}`);
    return new RobotsPolicy(new TextDecoder().decode(await readBounded(response, MAX_ROBOTS_BYTES)));
  }

  private async fetchOcds(source: URL, observedAt: string): Promise<readonly ProcurementOpportunity[]> {
    await this.input.urlPolicy.authorize(source);
    const fetchImpl = this.input.fetchImpl ?? fetch;
    let response: Response;
    try {
      response = await fetchImpl(source, { method: "GET", headers: { accept: "application/json", "user-agent": USER_AGENT }, redirect: "error", signal: AbortSignal.timeout(10_000) });
    } catch (error) {
      throw new ProcurementIntelligenceError("SOURCE_FAILURE", `OCDS request failed: ${error instanceof Error ? error.message : "unknown error"}`);
    }
    if (!response.ok) throw new ProcurementIntelligenceError("SOURCE_FAILURE", `OCDS source returned HTTP ${response.status}`);
    const bytes = await readBounded(response, MAX_JSON_BYTES);
    let payload: unknown;
    try { payload = JSON.parse(new TextDecoder().decode(bytes)) as unknown; }
    catch { throw new ProcurementIntelligenceError("SOURCE_FAILURE", "OCDS source returned invalid JSON"); }
    return parseOcdsOpportunities(payload, source, observedAt);
  }

  async scan(sourceConfig: ProcurementSourceConfig): Promise<ProcurementScanResult> {
    if (!sourceConfig || !SOURCE_ID.test(sourceConfig.sourceId) || (sourceConfig.kind !== "OCDS_JSON" && sourceConfig.kind !== "PUBLIC_HTML") ||
      (sourceConfig.kind === "OCDS_JSON" && sourceConfig.noticePathPrefixes !== undefined) ||
      (sourceConfig.noticePathPrefixes !== undefined && (!Array.isArray(sourceConfig.noticePathPrefixes) || sourceConfig.noticePathPrefixes.length < 1 || sourceConfig.noticePathPrefixes.length > MAX_NOTICE_PREFIXES || sourceConfig.noticePathPrefixes.some((prefix) => typeof prefix !== "string" || !prefix.startsWith("/") || prefix.length > 512)))) {
      throw new ProcurementIntelligenceError("INVALID_INPUT", "procurement source configuration is invalid");
    }
    const source = new URL(sourceConfig.url);
    await this.input.urlPolicy.authorize(source);
    const robots = await this.fetchRobots(source);
    const robotsDecision = robots.decide(USER_AGENT, source);
    if (!robotsDecision.allowed) throw new ProcurementIntelligenceError("ROBOTS_DENIED", `robots.txt denies ${source.pathname}`);
    const observedAt = canonicalNow(this.input.now ?? Date.now);

    let opportunities: readonly ProcurementOpportunity[];
    if (sourceConfig.kind === "OCDS_JSON") opportunities = await this.fetchOcds(source, observedAt);
    else {
      const fetchPage = async (url: URL): Promise<PublicBrowserPage> => {
        const page = await this.input.browser.fetchPublicPage({
          tenantId: this.profile.tenantId,
          url: url.toString(),
          userAgent: USER_AGENT,
          timeoutMs: 15_000,
          maxTextBytes: MAX_HTML_TEXT_BYTES,
          authorizeUrl: async (candidate) => { await this.input.urlPolicy.authorize(candidate); },
        });
        if (page.status < 200 || page.status >= 400) throw new ProcurementIntelligenceError("SOURCE_FAILURE", `public procurement page returned HTTP ${page.status}`);
        return page;
      };
      const landingPage = await fetchPage(source);
      if (!sourceConfig.noticePathPrefixes) opportunities = Object.freeze([htmlOpportunity(landingPage, source, observedAt)]);
      else {
        const candidates = new Map<string, URL>();
        for (const raw of landingPage.links.slice(0, MAX_HTML_LINKS)) {
          try {
            const url = new URL(raw, landingPage.finalUrl);
            if (url.origin !== source.origin || url.protocol !== "https:" || !sourceConfig.noticePathPrefixes.some((prefix) => url.pathname.startsWith(prefix))) continue;
            url.hash = "";
            candidates.set(url.toString(), url);
            if (candidates.size >= MAX_HTML_NOTICES) break;
          } catch { /* ignore malformed public links */ }
        }
        const discovered: ProcurementOpportunity[] = [];
        for (const noticeUrl of candidates.values()) {
          if (!robots.decide(USER_AGENT, noticeUrl).allowed) continue;
          await this.input.urlPolicy.authorize(noticeUrl);
          discovered.push(htmlOpportunity(await fetchPage(noticeUrl), noticeUrl, observedAt));
        }
        opportunities = Object.freeze(discovered);
      }
    }

    const matches = opportunities.flatMap((opportunity) => {
      const match = matchOpportunity(opportunity, this.profile);
      if (match.score < this.profile.minimumMatchScore || match.matchedCapabilities.length === 0) return [];
      const handoff = new URL("/procurement-opportunity", this.profile.canonicalWebsiteOrigin);
      handoff.searchParams.set("opportunity", opportunity.opportunityId);
      return [Object.freeze({ opportunity, score: match.score, matchedCapabilities: match.matchedCapabilities, handoffUrl: handoff.toString() })];
    });
    return Object.freeze({ sourceId: sourceConfig.sourceId, sourceKind: sourceConfig.kind, observedAt, opportunities, matches: Object.freeze(matches) });
  }
}
