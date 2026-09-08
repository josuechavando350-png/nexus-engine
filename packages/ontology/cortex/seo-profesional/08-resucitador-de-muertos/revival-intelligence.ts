import { createHash } from "node:crypto";
import { PassivePublicSiteProbe, PassivePublicSiteProbeError, type PassivePublicSiteEvidence } from "./public-site-probe.js";
import { fingerprintPublicTechnology, type TechnologyFingerprint } from "./technology-fingerprint.js";

export class RevivalIntelligenceError extends Error {
  constructor(public readonly code: "INVALID_CONFIG" | "INVALID_INPUT" | "TENANT_MISMATCH", message: string) {
    super(message);
    this.name = "RevivalIntelligenceError";
  }
}

export type RevivalRelationship = "FIRST_PARTY_CRM" | "OWNED_PORTFOLIO";

export interface RevivalTenantProfile {
  readonly tenantId: string;
  readonly operatorWebsiteOrigin: string;
  readonly minimumDormancyDays?: number;
}

export interface RevivalCandidate {
  readonly tenantId: string;
  readonly candidateId: string;
  readonly websiteUrl: string;
  readonly relationship: RevivalRelationship;
  readonly dormantSince: string;
}

export interface PublicSiteSeoSnapshot {
  readonly status: number | null;
  readonly title: string | null;
  readonly description: string | null;
  readonly hasCanonical: boolean;
  readonly hasViewport: boolean;
  readonly hasJsonLd: boolean;
}

export interface RevivalAssessment {
  readonly assessmentId: string;
  readonly assessedAt: string;
  readonly tenantId: string;
  readonly candidateId: string;
  readonly websiteOrigin: string;
  readonly relationship: RevivalRelationship;
  readonly dormantDays: number;
  readonly classification: "NO_ACTION" | "REVIEW_REACTIVATION" | "REVIEW_OFFLINE_OR_BROKEN";
  readonly score: number;
  readonly reasons: readonly string[];
  readonly publicSite: PublicSiteSeoSnapshot;
  readonly technology: TechnologyFingerprint | null;
  readonly handoffUrl: string;
  readonly receiptDigest: string;
}

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{2,191}$/u;
const DAY_MS = 86_400_000;

function canonicalOrigin(raw: string, label: string): string {
  let url: URL;
  try { url = new URL(raw); }
  catch { throw new RevivalIntelligenceError("INVALID_CONFIG", `${label} must be an absolute URL`); }
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || url.pathname !== "/" || url.port) {
    throw new RevivalIntelligenceError("INVALID_CONFIG", `${label} must be a bare HTTPS origin`);
  }
  return url.origin;
}

function extract(pattern: RegExp, html: string): string | null {
  const match = pattern.exec(html);
  if (!match?.[1]) return null;
  return match[1].normalize("NFKC").replace(/\s+/gu, " ").trim().slice(0, 512) || null;
}

function seoSnapshot(evidence: PassivePublicSiteEvidence): PublicSiteSeoSnapshot {
  const html = evidence.html;
  const title = extract(/<title[^>]*>([\s\S]{1,512}?)<\/title>/iu, html);
  const description = extract(/<meta\s+[^>]*name=["']description["'][^>]*content=["']([^"']{1,512})["'][^>]*>/iu, html)
    ?? extract(/<meta\s+[^>]*content=["']([^"']{1,512})["'][^>]*name=["']description["'][^>]*>/iu, html);
  return Object.freeze({
    status: evidence.status,
    title,
    description,
    hasCanonical: /<link\s+[^>]*rel=["'][^"']*canonical[^"']*["'][^>]*href=/iu.test(html) || /<link\s+[^>]*href=["'][^"']+["'][^>]*rel=["'][^"']*canonical[^"']*["']/iu.test(html),
    hasViewport: /<meta\s+[^>]*name=["']viewport["']/iu.test(html),
    hasJsonLd: /<script\s+[^>]*type=["']application\/ld\+json["']/iu.test(html),
  });
}

function emptySeoSnapshot(): PublicSiteSeoSnapshot {
  return Object.freeze({ status: null, title: null, description: null, hasCanonical: false, hasViewport: false, hasJsonLd: false });
}

function receipt(value: unknown): string {
  return `sha256:${createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex")}`;
}

export class PassiveTechnologyRevivalEngine {
  private readonly profile: Readonly<Required<RevivalTenantProfile>>;
  private readonly probe: PassivePublicSiteProbe;
  private readonly now: () => number;

  constructor(
    input: {
      readonly profile: RevivalTenantProfile;
      readonly probe?: PassivePublicSiteProbe;
      readonly now?: () => number;
    },
  ) {
    if (!input || typeof input !== "object" || !input.profile || !ID.test(input.profile.tenantId)) {
      throw new RevivalIntelligenceError("INVALID_CONFIG", "revival tenant profile is invalid");
    }
    const minimumDormancyDays = input.profile.minimumDormancyDays ?? 90;
    if (!Number.isSafeInteger(minimumDormancyDays) || minimumDormancyDays < 30 || minimumDormancyDays > 3_650) {
      throw new RevivalIntelligenceError("INVALID_CONFIG", "minimumDormancyDays must be between 30 and 3650");
    }
    this.profile = Object.freeze({
      tenantId: input.profile.tenantId,
      operatorWebsiteOrigin: canonicalOrigin(input.profile.operatorWebsiteOrigin, "operatorWebsiteOrigin"),
      minimumDormancyDays,
    });
    this.probe = input.probe ?? new PassivePublicSiteProbe();
    this.now = input.now ?? Date.now;
  }

  async assess(candidate: RevivalCandidate): Promise<RevivalAssessment> {
    if (!candidate || typeof candidate !== "object" || !ID.test(candidate.tenantId) || !ID.test(candidate.candidateId) || (candidate.relationship !== "FIRST_PARTY_CRM" && candidate.relationship !== "OWNED_PORTFOLIO")) {
      throw new RevivalIntelligenceError("INVALID_INPUT", "revival candidate contract is invalid");
    }
    if (candidate.tenantId !== this.profile.tenantId) throw new RevivalIntelligenceError("TENANT_MISMATCH", "revival candidate tenant does not match runtime tenant");
    let website: URL;
    try { website = new URL(candidate.websiteUrl); }
    catch { throw new RevivalIntelligenceError("INVALID_INPUT", "revival candidate website URL is invalid"); }
    if (website.protocol !== "https:" || website.username || website.password || website.search || website.hash || website.pathname !== "/" || website.port) {
      throw new RevivalIntelligenceError("INVALID_INPUT", "revival candidate website must be a bare HTTPS origin");
    }
    const nowMs = this.now();
    const dormantSinceMs = Date.parse(candidate.dormantSince);
    if (!Number.isFinite(nowMs) || !Number.isFinite(dormantSinceMs) || dormantSinceMs > nowMs) throw new RevivalIntelligenceError("INVALID_INPUT", "revival candidate dormancy timestamp is invalid");
    const dormantDays = Math.floor((nowMs - dormantSinceMs) / DAY_MS);
    if (dormantDays < this.profile.minimumDormancyDays) throw new RevivalIntelligenceError("INVALID_INPUT", "revival candidate has not reached the configured dormancy threshold");

    let evidence: PassivePublicSiteEvidence | null = null;
    let networkFailure = false;
    try {
      evidence = await this.probe.inspect(website.origin + "/");
    } catch (error) {
      if (error instanceof PassivePublicSiteProbeError && error.code === "NETWORK_FAILURE") networkFailure = true;
      else throw error;
    }

    const publicSite = evidence ? seoSnapshot(evidence) : emptySeoSnapshot();
    const technology = evidence ? fingerprintPublicTechnology({ status: evidence.status, finalUrl: evidence.finalUrl, headers: evidence.headers, html: evidence.html }) : null;
    const reasons: string[] = [];
    let score = dormantDays >= 365 ? 30 : dormantDays >= 180 ? 20 : 10;
    reasons.push(dormantDays >= 365 ? "DORMANT_365_PLUS_DAYS" : dormantDays >= 180 ? "DORMANT_180_PLUS_DAYS" : "DORMANT_THRESHOLD_MET");
    if (networkFailure) { score += 35; reasons.push("PUBLIC_HOMEPAGE_UNREACHABLE"); }
    if (publicSite.status !== null && publicSite.status >= 500) { score += 30; reasons.push("PUBLIC_HOMEPAGE_SERVER_ERROR"); }
    else if (publicSite.status !== null && publicSite.status >= 400) { score += 15; reasons.push("PUBLIC_HOMEPAGE_HTTP_ERROR"); }
    if (!networkFailure && publicSite.status !== null && publicSite.status < 400) {
      if (!publicSite.title) { score += 10; reasons.push("MISSING_TITLE"); }
      if (!publicSite.description) { score += 10; reasons.push("MISSING_META_DESCRIPTION"); }
      if (!publicSite.hasCanonical) { score += 10; reasons.push("MISSING_CANONICAL"); }
      if (!publicSite.hasViewport) { score += 5; reasons.push("MISSING_VIEWPORT"); }
      if (!publicSite.hasJsonLd) { score += 10; reasons.push("MISSING_JSON_LD"); }
    }
    score = Math.min(100, score);
    const classification: RevivalAssessment["classification"] = networkFailure || (publicSite.status !== null && publicSite.status >= 500)
      ? "REVIEW_OFFLINE_OR_BROKEN"
      : score >= 35 ? "REVIEW_REACTIVATION" : "NO_ACTION";
    const assessedAt = new Date(nowMs).toISOString();
    const assessmentId = `rev_${createHash("sha256").update(`${candidate.tenantId}\n${candidate.candidateId}\n${website.origin}\n${assessedAt}`, "utf8").digest("hex").slice(0, 32)}`;
    const handoffUrl = `${this.profile.operatorWebsiteOrigin}/revival-review?assessment=${encodeURIComponent(assessmentId)}`;
    const receiptPayload = { assessmentId, assessedAt, tenantId: candidate.tenantId, candidateId: candidate.candidateId, websiteOrigin: website.origin, dormantDays, classification, score, reasons, publicSite, technologyDigest: technology?.evidenceDigest ?? null, handoffUrl };
    return Object.freeze({
      assessmentId,
      assessedAt,
      tenantId: candidate.tenantId,
      candidateId: candidate.candidateId,
      websiteOrigin: website.origin,
      relationship: candidate.relationship,
      dormantDays,
      classification,
      score,
      reasons: Object.freeze(reasons),
      publicSite,
      technology,
      handoffUrl,
      receiptDigest: receipt(receiptPayload),
    });
  }
}
