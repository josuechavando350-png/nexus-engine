import { describe, expect, it, vi } from "vitest";
import type { DomainDnsSnapshot } from "./05-emboscador-de-nacimientos/dns-intelligence.js";
import {
  DomainBirthIntelligenceEngine,
  DomainBirthOutreachEngine,
  type DnsDomainIntelligencePort,
  type RdapDomainLookupPort,
  WhatsAppCloudApiClient,
} from "./05-emboscador-de-nacimientos/index.js";
import { PublicProcurementIntelligenceEngine } from "./06-infiltrador-corporativo/procurement-intelligence.js";
import { PublicProcurementUrlPolicy } from "./06-infiltrador-corporativo/public-url-policy.js";
import {
  SeoProfessionalMasterSystem,
  type AuthorizedProgrammaticSeoPort,
  type PassiveRevivalIntelligencePort,
  type SeoProfessionalCorePort,
} from "./master-system.js";

const NOW = Date.parse("2026-09-08T12:00:00.000Z");

function core(origin = "https://example.test"): SeoProfessionalCorePort<unknown, unknown> {
  return {
    snapshot: () => ({ googleAdsCustomerId: "1234567890", offlineConversionProvider: "GOOGLE_ADS_API", canonicalWebsiteOrigin: origin }),
    assessLanding: async () => { throw new Error("not exercised in master wiring test"); },
    recordQualifiedConversion: async () => { throw new Error("not exercised in master wiring test"); },
    optimizeExactMatches: async () => { throw new Error("not exercised in master wiring test"); },
  };
}

function dns(): DomainDnsSnapshot {
  return Object.freeze({ domain: "newco.com", ipv4: Object.freeze(["203.0.113.10"]), ipv6: Object.freeze([]), mx: Object.freeze([]), nameservers: Object.freeze(["ns1.example.net"]), webAddressable: true, mailRouted: false, dnsActive: true });
}

function outreach(origin = "https://example.test", requests: string[] = []) {
  const rdap: RdapDomainLookupPort = { lookupDomain: async () => ({ status: "REGISTERED", record: { domain: "newco.com", registrationDate: "2026-09-07T12:00:00.000Z", lastChangedDate: null, expirationDate: null, statuses: Object.freeze(["active"]), nameservers: Object.freeze(["ns1.example.net"]), registrarHandle: "REGISTRAR-1", delegationSigned: true } }) };
  const dnsPort: DnsDomainIntelligencePort = { inspect: async () => dns() };
  const intelligence = new DomainBirthIntelligenceEngine({ rdap, dns: dnsPort, now: () => NOW });
  const fetchImpl: typeof fetch = vi.fn(async (input: RequestInfo | URL) => {
    requests.push(String(input));
    return new Response(JSON.stringify({ messages: [{ id: "wamid.master00000001" }], contacts: [{ wa_id: "525512345678" }] }), { status: 200 });
  });
  const whatsapp = new WhatsAppCloudApiClient({ phoneNumberId: "123456789012345", accessTokenProvider: async () => "meta-system-user-access-token-1234567890", fetchImpl, now: () => NOW });
  return new DomainBirthOutreachEngine({ intelligence, whatsapp, senderWebsiteOrigin: origin, templateName: "new_domain_welcome", languageCode: "es_MX", now: () => NOW });
}

function procurement(origin = "https://example.test") {
  const urlPolicy = new PublicProcurementUrlPolicy(["https://compras.example"], { resolve: async () => ["8.8.8.8"] });
  const fetchImpl: typeof fetch = vi.fn(async (input: RequestInfo | URL) => String(input).endsWith("robots.txt")
    ? new Response("User-agent: *\nAllow: /\n", { status: 200 })
    : new Response(JSON.stringify({ releases: [{ id: "r1", tender: { title: "Seguridad administrada" } }] }), { status: 200 }));
  return new PublicProcurementIntelligenceEngine({ profile: { tenantId: "tenant-master", canonicalWebsiteOrigin: origin, capabilityPhrases: ["seguridad administrada"], minimumMatchScore: 1 }, urlPolicy, browser: { fetchPublicPage: async () => { throw new Error("OCDS path does not use Playwright"); } }, fetchImpl, now: () => NOW });
}

function structuredKnowledge(origin = "https://example.test") {
  return { identity: () => Object.freeze({ strategy: 7 as const, provider: "VERIFIED_SEMANTIC_GRAPH_RICH_RESULTS" as const, publisherWebsiteOrigin: origin }), publish: async () => { throw new Error("not exercised in master wiring test"); } };
}

function revival(origin = "https://example.test"): PassiveRevivalIntelligencePort {
  return {
    identity: () => Object.freeze({ strategy: 8 as const, provider: "PASSIVE_TECH_ENRICHMENT_REDIS" as const, queue: "REDIS_RESP2_LUA" as const, operatorWebsiteOrigin: origin }),
    assess: async (candidate) => Object.freeze({ assessmentId: "rev_master000000000000000000000001", assessedAt: "2026-09-08T12:00:00.000Z", tenantId: candidate.tenantId, candidateId: candidate.candidateId, websiteOrigin: new URL(candidate.websiteUrl).origin, relationship: candidate.relationship, dormantDays: 365, classification: "REVIEW_REACTIVATION" as const, score: 40, reasons: Object.freeze(["DORMANT_365_PLUS_DAYS"]), publicSite: Object.freeze({ status: 200, title: null, description: null, hasCanonical: false, hasViewport: false, hasJsonLd: false }), technology: null, handoffUrl: `${origin}/revival-review?assessment=rev_master000000000000000000000001`, receiptDigest: `sha256:${"a".repeat(64)}` }),
    enqueue: async () => "revjob_123e4567-e89b-12d3-a456-426614174000",
  };
}

function programmatic(origin = "https://example.test"): AuthorizedProgrammaticSeoPort {
  const result = (runId: string) => Object.freeze({
    programmatic: Object.freeze({ runId, siteId: "site-client", status: "NOOP" as const, reason: "OBSERVE_ONLY" as const, mode: "OBSERVE_ONLY" as const, bundleDigest: `sha256:${"b".repeat(64)}`, action: null, receipt: null, policyDigest: `sha256:${"c".repeat(64)}`, digest: `sha256:${"d".repeat(64)}` }),
    authorization: Object.freeze({ kind: "DNS_TXT_DELEGATION" as const, siteId: "site-client", propertyBaseUrl: "https://client.example/", propertyOrigin: "https://client.example", operatorWebsiteOrigin: origin, verifiedAt: "2026-09-08T12:00:00.000Z", expiresAt: "2026-09-15T12:00:00.000Z", dnsName: "_nexus-pseo.client.example", proofDigest: `sha256:${"e".repeat(64)}`, policyVersion: "seo9-property-authorization-v1" as const }),
    receiptDigest: `sha256:${"f".repeat(64)}`,
    policyVersion: "seo9-authorized-pseo-runtime-v1" as const,
  });
  return {
    identity: () => Object.freeze({ strategy: 9 as const, provider: "AUTHORIZED_HEADLESS_PROGRAMMATIC_SEO" as const, engine: "CORTEX_HEADLESS_PROGRAMMATIC_SEO" as const, siteId: "site-client", propertyOrigin: "https://client.example", operatorWebsiteOrigin: origin }),
    build: async (input) => result(input.runId),
    rollbackLastMutation: async (input) => result(input.runId),
  };
}

function system(origin = "https://example.test", overrides: Partial<{ outreachOrigin: string; procurementOrigin: string; structuredOrigin: string; revivalOrigin: string; programmaticOrigin: string }> = {}) {
  return new SeoProfessionalMasterSystem({
    core: core(origin),
    domainBirthOutreach: outreach(overrides.outreachOrigin ?? origin),
    corporateProcurement: procurement(overrides.procurementOrigin ?? origin),
    structuredKnowledge: structuredKnowledge(overrides.structuredOrigin ?? origin),
    revivalIntelligence: revival(overrides.revivalOrigin ?? origin),
    programmaticSeo: programmatic(overrides.programmaticOrigin ?? origin),
  });
}

describe("SeoProfessionalMasterSystem #1..#9", () => {
  it("binds #5 through #9 to the canonical #4 operator identity while allowing #9 to publish to a separately authorized property", async () => {
    const requests: string[] = [];
    const master = new SeoProfessionalMasterSystem({ core: core(), domainBirthOutreach: outreach("https://example.test", requests), corporateProcurement: procurement(), structuredKnowledge: structuredKnowledge(), revivalIntelligence: revival(), programmaticSeo: programmatic() });
    expect(master.snapshot()).toEqual({
      googleAdsCustomerId: "1234567890",
      offlineConversionProvider: "GOOGLE_ADS_API",
      canonicalWebsiteOrigin: "https://example.test",
      domainBirthOutreachProvider: "WHATSAPP_CLOUD_API",
      corporateProcurementProvider: "PUBLIC_PROCUREMENT_INTELLIGENCE",
      structuredKnowledgeProvider: "VERIFIED_SEMANTIC_GRAPH_RICH_RESULTS",
      revivalIntelligenceProvider: "PASSIVE_TECH_ENRICHMENT_REDIS",
      revivalQueue: "REDIS_RESP2_LUA",
      programmaticSeoProvider: "AUTHORIZED_HEADLESS_PROGRAMMATIC_SEO",
      programmaticSeoEngine: "CORTEX_HEADLESS_PROGRAMMATIC_SEO",
      strategyNumbers: [1, 2, 3, 4, 5, 6, 7, 8, 9],
      connectionCount: 15,
      connected: true,
    });
    expect(master.topology().strategies.map((strategy) => strategy.number)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);

    const outreachResult = await master.runDomainBirthOutreach({ domain: "newco.com", recipientE164: "+525512345678", consent: { status: "OPTED_IN", purpose: "DOMAIN_BIRTH_OUTREACH", recipientE164: "+525512345678", capturedAt: "2026-09-01T10:00:00.000Z", source: "first-party CRM", proofId: "consent-proof-master-0001" }, leadSource: "FIRST_PARTY_CRM", landingUrl: "https://example.test/domain-intelligence?utm_source=whatsapp", executionMode: "APPLY" });
    expect(outreachResult).toMatchObject({ status: "SENT", assessment: { classification: "NEWLY_REGISTERED_ACTIVE" } });
    expect(requests).toEqual(["https://graph.facebook.com/v26.0/123456789012345/messages"]);

    const scan = await master.scanCorporateProcurement({ sourceId: "portal-ocds", kind: "OCDS_JSON", url: "https://compras.example/ocds.json" });
    expect(scan.matches).toHaveLength(1);
    const candidate = { tenantId: "tenant-master", candidateId: "lead-master-001", websiteUrl: "https://candidate.example/", relationship: "FIRST_PARTY_CRM" as const, dormantSince: "2025-01-01T00:00:00.000Z" };
    await expect(master.assessRevivalCandidate(candidate)).resolves.toMatchObject({ candidateId: "lead-master-001" });
    await expect(master.enqueueRevivalCandidate({ candidate, scanKey: "cycle-master-001" })).resolves.toMatch(/^revjob_/u);
    await expect(master.runAuthorizedProgrammaticSeo({ runId: "seo9-master-001", mode: "OBSERVE_ONLY" })).resolves.toMatchObject({ programmatic: { siteId: "site-client", reason: "OBSERVE_ONLY" }, authorization: { propertyOrigin: "https://client.example", operatorWebsiteOrigin: "https://example.test" } });
  });

  it("fails closed when #5 sender identity does not match #4", () => { expect(() => system("https://example.test", { outreachOrigin: "https://other.example" })).toThrowError(/#5 sender website origin/u); });
  it("fails closed when #6 seller identity does not match #4", () => { expect(() => system("https://example.test", { procurementOrigin: "https://other.example" })).toThrowError(/#6 seller website origin/u); });
  it("fails closed when #7 publisher identity does not match #4", () => { expect(() => system("https://example.test", { structuredOrigin: "https://other.example" })).toThrowError(/#7 publisher website origin/u); });
  it("fails closed when #8 operator identity does not match #4", () => { expect(() => system("https://example.test", { revivalOrigin: "https://other.example" })).toThrowError(/#8 operator website origin/u); });
  it("fails closed when #9 operator identity does not match #4", () => { expect(() => system("https://example.test", { programmaticOrigin: "https://other.example" })).toThrowError(/#9 operator website origin/u); });
});
