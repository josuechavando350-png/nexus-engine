import { describe, expect, it, vi } from "vitest";
import type { DomainDnsSnapshot } from "./dns-intelligence.js";
import {
  DomainBirthIntelligenceEngine,
  DomainBirthOutreachEngine,
  type DnsDomainIntelligencePort,
  type RdapDomainLookupPort,
} from "./domain-birth-outreach.js";
import type { RdapDomainRecord } from "./rdap-client.js";
import { WhatsAppCloudApiClient, type WhatsAppConsentEvidence } from "./whatsapp-cloud.js";

const NOW = Date.parse("2026-09-08T12:00:00.000Z");

function record(registrationDate: string | null): RdapDomainRecord {
  return Object.freeze({
    domain: "newco.com",
    registrationDate,
    lastChangedDate: null,
    expirationDate: null,
    statuses: Object.freeze(["active"]),
    nameservers: Object.freeze(["ns1.example.net"]),
    registrarHandle: "REGISTRAR-1",
    delegationSigned: true,
  });
}

function dns(active = true): DomainDnsSnapshot {
  return Object.freeze({
    domain: "newco.com",
    ipv4: Object.freeze(active ? ["203.0.113.10"] : []),
    ipv6: Object.freeze([]),
    mx: Object.freeze([]),
    nameservers: Object.freeze(active ? ["ns1.example.net"] : []),
    webAddressable: active,
    mailRouted: false,
    dnsActive: active,
  });
}

function intelligence(registrationDate: string | null, active = true) {
  const rdap: RdapDomainLookupPort = {
    lookupDomain: async () => ({ status: "REGISTERED", record: record(registrationDate) }),
  };
  const dnsPort: DnsDomainIntelligencePort = { inspect: async () => dns(active) };
  return new DomainBirthIntelligenceEngine({
    rdap,
    dns: dnsPort,
    maximumDomainAgeMs: 7 * 24 * 60 * 60 * 1_000,
    now: () => NOW,
  });
}

function consent(): WhatsAppConsentEvidence {
  return {
    status: "OPTED_IN",
    recipientE164: "+525512345678",
    capturedAt: "2026-09-01T10:00:00.000Z",
    source: "first-party CRM",
    proofId: "consent-proof-00000005",
  };
}

describe("DomainBirthIntelligenceEngine", () => {
  it("qualifies a recently registered, DNS-active domain without deriving a recipient from RDAP", async () => {
    await expect(intelligence("2026-09-06T12:00:00.000Z").inspect("NEWCO.COM")).resolves.toMatchObject({
      domain: "newco.com",
      classification: "NEWLY_REGISTERED_ACTIVE",
      ageMs: 2 * 24 * 60 * 60 * 1_000,
      eligibleForConsentedOutreach: true,
    });
  });

  it("does not qualify established, unregistered, unknown-age, or DNS-inactive domains", async () => {
    await expect(intelligence("2026-08-01T12:00:00.000Z").inspect("newco.com")).resolves.toMatchObject({ classification: "ESTABLISHED", eligibleForConsentedOutreach: false });
    await expect(intelligence(null).inspect("newco.com")).resolves.toMatchObject({ classification: "UNKNOWN_AGE", eligibleForConsentedOutreach: false });
    await expect(intelligence("2026-09-06T12:00:00.000Z", false).inspect("newco.com")).resolves.toMatchObject({ classification: "NEWLY_REGISTERED_INACTIVE", eligibleForConsentedOutreach: false });

    const rdap: RdapDomainLookupPort = { lookupDomain: async () => ({ status: "NOT_REGISTERED", domain: "newco.com" }) };
    const dnsPort: DnsDomainIntelligencePort = { inspect: vi.fn(async () => dns()) };
    const engine = new DomainBirthIntelligenceEngine({ rdap, dns: dnsPort, now: () => NOW });
    await expect(engine.inspect("newco.com")).resolves.toMatchObject({ classification: "NOT_REGISTERED", eligibleForConsentedOutreach: false });
    expect(dnsPort.inspect).not.toHaveBeenCalled();
  });
});

describe("DomainBirthOutreachEngine", () => {
  it("plans and sends a consented template only for a newly registered active domain", async () => {
    const requests: Array<{ url: string; body: unknown }> = [];
    const fetchImpl: typeof fetch = vi.fn(async (input, init) => {
      requests.push({ url: String(input), body: JSON.parse(String(init?.body)) as unknown });
      return new Response(JSON.stringify({ contacts: [{ wa_id: "525512345678" }], messages: [{ id: "wamid.domainbirth00000001" }] }), { status: 200 });
    });
    const whatsapp = new WhatsAppCloudApiClient({
      phoneNumberId: "123456789012345",
      accessTokenProvider: async () => "meta-system-user-access-token-1234567890",
      fetchImpl,
      now: () => NOW,
    });
    const engine = new DomainBirthOutreachEngine({
      intelligence: intelligence("2026-09-06T12:00:00.000Z"),
      whatsapp,
      senderWebsiteOrigin: "https://example.test/",
      templateName: "new_domain_welcome",
      languageCode: "es_MX",
      now: () => NOW,
    });
    const base = {
      domain: "newco.com",
      recipientE164: "+525512345678",
      consent: consent(),
      leadSource: "FIRST_PARTY_CRM" as const,
      landingUrl: "https://example.test/domain-intelligence?utm_source=whatsapp",
    };
    const plan = await engine.run({ ...base, executionMode: "PLAN_ONLY" });
    expect(plan).toMatchObject({
      status: "PLANNED",
      assessment: { classification: "NEWLY_REGISTERED_ACTIVE" },
      landingUrl: "https://example.test/domain-intelligence?utm_source=whatsapp",
      payload: { template: { name: "new_domain_welcome" } },
    });
    expect(requests).toHaveLength(0);

    const sent = await engine.run({ ...base, executionMode: "APPLY" });
    expect(sent).toMatchObject({ status: "SENT", receipt: { provider: "WHATSAPP_CLOUD_API", messageId: "wamid.domainbirth00000001" } });
    expect(requests).toHaveLength(1);
    expect(requests[0]!.body).toMatchObject({
      type: "template",
      template: { components: [{ parameters: [{ text: "newco.com" }, { text: "https://example.test/domain-intelligence?utm_source=whatsapp" }] }] },
    });
  });

  it("skips an established domain before touching WhatsApp and rejects a landing on another origin", async () => {
    const fetchImpl: typeof fetch = vi.fn(async () => { throw new Error("must not send"); });
    const whatsapp = new WhatsAppCloudApiClient({
      phoneNumberId: "123456789012345",
      accessTokenProvider: async () => "meta-system-user-access-token-1234567890",
      fetchImpl,
      now: () => NOW,
    });
    const engine = new DomainBirthOutreachEngine({
      intelligence: intelligence("2026-08-01T12:00:00.000Z"),
      whatsapp,
      senderWebsiteOrigin: "https://example.test",
      templateName: "new_domain_welcome",
      languageCode: "es_MX",
      now: () => NOW,
    });
    await expect(engine.run({
      domain: "newco.com",
      recipientE164: "+525512345678",
      consent: consent(),
      leadSource: "USER_REQUEST",
      landingUrl: "https://example.test/domain-intelligence",
      executionMode: "APPLY",
    })).resolves.toMatchObject({ status: "SKIPPED", reasons: ["DOMAIN_NOT_NEW"] });
    expect(fetchImpl).not.toHaveBeenCalled();

    await expect(engine.run({
      domain: "newco.com",
      recipientE164: "+525512345678",
      consent: consent(),
      leadSource: "USER_REQUEST",
      landingUrl: "https://evil.example/domain-intelligence",
      executionMode: "PLAN_ONLY",
    })).rejects.toMatchObject({ code: "INVALID_INPUT" });
  });
});
