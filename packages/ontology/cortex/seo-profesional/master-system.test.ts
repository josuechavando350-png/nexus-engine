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
  type SeoProfessionalCorePort,
} from "./master-system.js";

const NOW = Date.parse("2026-09-08T12:00:00.000Z");

function core(origin = "https://example.test"): SeoProfessionalCorePort<unknown, unknown> {
  return {
    snapshot: () => ({
      googleAdsCustomerId: "1234567890",
      offlineConversionProvider: "GOOGLE_ADS_API",
      canonicalWebsiteOrigin: origin,
    }),
    assessLanding: async () => { throw new Error("not exercised in master wiring test"); },
    recordQualifiedConversion: async () => { throw new Error("not exercised in master wiring test"); },
    optimizeExactMatches: async () => { throw new Error("not exercised in master wiring test"); },
  };
}

function dns(): DomainDnsSnapshot {
  return Object.freeze({
    domain: "newco.com",
    ipv4: Object.freeze(["203.0.113.10"]),
    ipv6: Object.freeze([]),
    mx: Object.freeze([]),
    nameservers: Object.freeze(["ns1.example.net"]),
    webAddressable: true,
    mailRouted: false,
    dnsActive: true,
  });
}

function outreach(origin = "https://example.test", requests: string[] = []) {
  const rdap: RdapDomainLookupPort = {
    lookupDomain: async () => ({
      status: "REGISTERED",
      record: {
        domain: "newco.com",
        registrationDate: "2026-09-07T12:00:00.000Z",
        lastChangedDate: null,
        expirationDate: null,
        statuses: Object.freeze(["active"]),
        nameservers: Object.freeze(["ns1.example.net"]),
        registrarHandle: "REGISTRAR-1",
        delegationSigned: true,
      },
    }),
  };
  const dnsPort: DnsDomainIntelligencePort = { inspect: async () => dns() };
  const intelligence = new DomainBirthIntelligenceEngine({ rdap, dns: dnsPort, now: () => NOW });
  const fetchImpl: typeof fetch = vi.fn(async (input) => {
    requests.push(String(input));
    return new Response(JSON.stringify({ messages: [{ id: "wamid.master00000001" }], contacts: [{ wa_id: "525512345678" }] }), { status: 200 });
  });
  const whatsapp = new WhatsAppCloudApiClient({
    phoneNumberId: "123456789012345",
    accessTokenProvider: async () => "meta-system-user-access-token-1234567890",
    fetchImpl,
    now: () => NOW,
  });
  return new DomainBirthOutreachEngine({
    intelligence,
    whatsapp,
    senderWebsiteOrigin: origin,
    templateName: "new_domain_welcome",
    languageCode: "es_MX",
    now: () => NOW,
  });
}

function procurement(origin = "https://example.test") {
  const urlPolicy = new PublicProcurementUrlPolicy(["https://compras.example"], { resolve: async () => ["8.8.8.8"] });
  const fetchImpl: typeof fetch = vi.fn(async (input) => String(input).endsWith("robots.txt")
    ? new Response("User-agent: *\nAllow: /\n", { status: 200 })
    : new Response(JSON.stringify({ releases: [{ id: "r1", tender: { title: "Seguridad administrada" } }] }), { status: 200 }));
  return new PublicProcurementIntelligenceEngine({
    profile: { tenantId: "tenant-master", canonicalWebsiteOrigin: origin, capabilityPhrases: ["seguridad administrada"], minimumMatchScore: 1 },
    urlPolicy,
    browser: { fetchPublicPage: async () => { throw new Error("OCDS path does not use Playwright"); } },
    fetchImpl,
    now: () => NOW,
  });
}

describe("SeoProfessionalMasterSystem #1..#6", () => {
  it("binds #5 and #6 to the canonical #4 identity and executes both through the same master runtime", async () => {
    const requests: string[] = [];
    const system = new SeoProfessionalMasterSystem({
      core: core(),
      domainBirthOutreach: outreach("https://example.test", requests),
      corporateProcurement: procurement("https://example.test"),
    });
    expect(system.snapshot()).toEqual({
      googleAdsCustomerId: "1234567890",
      offlineConversionProvider: "GOOGLE_ADS_API",
      canonicalWebsiteOrigin: "https://example.test",
      domainBirthOutreachProvider: "WHATSAPP_CLOUD_API",
      corporateProcurementProvider: "PUBLIC_PROCUREMENT_INTELLIGENCE",
      strategyNumbers: [1, 2, 3, 4, 5, 6],
      connectionCount: 9,
      connected: true,
    });
    expect(system.topology().strategies.map((strategy) => strategy.number)).toEqual([1, 2, 3, 4, 5, 6]);

    const outreachResult = await system.runDomainBirthOutreach({
      domain: "newco.com",
      recipientE164: "+525512345678",
      consent: {
        status: "OPTED_IN",
        purpose: "DOMAIN_BIRTH_OUTREACH",
        recipientE164: "+525512345678",
        capturedAt: "2026-09-01T10:00:00.000Z",
        source: "first-party CRM",
        proofId: "consent-proof-master-0001",
      },
      leadSource: "FIRST_PARTY_CRM",
      landingUrl: "https://example.test/domain-intelligence?utm_source=whatsapp",
      executionMode: "APPLY",
    });
    expect(outreachResult).toMatchObject({ status: "SENT", assessment: { classification: "NEWLY_REGISTERED_ACTIVE" } });
    expect(requests).toEqual(["https://graph.facebook.com/v26.0/123456789012345/messages"]);

    const scan = await system.scanCorporateProcurement({ sourceId: "portal-ocds", kind: "OCDS_JSON", url: "https://compras.example/ocds.json" });
    expect(scan.matches).toHaveLength(1);
    expect(scan.matches[0]?.handoffUrl).toMatch(/^https:\/\/example\.test\/procurement-opportunity/u);
  });

  it("fails closed when #5 sender identity does not match the canonical local business origin", () => {
    expect(() => new SeoProfessionalMasterSystem({
      core: core("https://example.test"),
      domainBirthOutreach: outreach("https://other.example"),
      corporateProcurement: procurement("https://example.test"),
    })).toThrowError(/#5 sender website origin/u);
  });

  it("fails closed when #6 seller identity does not match the canonical local business origin", () => {
    expect(() => new SeoProfessionalMasterSystem({
      core: core("https://example.test"),
      domainBirthOutreach: outreach("https://example.test"),
      corporateProcurement: procurement("https://other.example"),
    })).toThrowError(/#6 seller website origin/u);
  });
});
