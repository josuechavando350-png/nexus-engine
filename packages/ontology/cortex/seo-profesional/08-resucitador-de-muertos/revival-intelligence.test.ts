import { describe, expect, it } from "vitest";
import { PassivePublicSiteProbe, PassivePublicSiteProbeError, type PinnedHttpsTransportPort } from "./public-site-probe.js";
import { PassiveTechnologyRevivalEngine } from "./revival-intelligence.js";

const NOW = Date.parse("2026-09-08T20:00:00.000Z");

function probe(body: string, status = 200): PassivePublicSiteProbe {
  const transport: PinnedHttpsTransportPort = {
    get: async () => ({ status, headers: { "content-type": "text/html", "x-vercel-id": "iad1::abc" }, body }),
  };
  return new PassivePublicSiteProbe({ resolver: { resolve: async () => ["8.8.8.8"] }, transport, now: () => NOW });
}

function engine(siteProbe: PassivePublicSiteProbe): PassiveTechnologyRevivalEngine {
  return new PassiveTechnologyRevivalEngine({
    profile: { tenantId: "tenant-revival", operatorWebsiteOrigin: "https://nexus.example", minimumDormancyDays: 90 },
    probe: siteProbe,
    now: () => NOW,
  });
}

describe("PassiveTechnologyRevivalEngine", () => {
  it("enriches a dormant first-party CRM candidate without treating the detected vendor as a vulnerability", async () => {
    const result = await engine(probe('<html><head><title>Candidate</title><meta name="description" content="Empresa"><meta name="viewport" content="width=device-width"><link rel="canonical" href="https://candidate.example/"><script type="application/ld+json">{}</script><script src="/_next/static/a.js"></script></head></html>')).assess({
      tenantId: "tenant-revival",
      candidateId: "lead-0001",
      websiteUrl: "https://candidate.example/",
      relationship: "FIRST_PARTY_CRM",
      dormantSince: "2025-09-01T00:00:00.000Z",
    });
    expect(result.classification).toBe("NO_ACTION");
    expect(result.reasons).toEqual(["DORMANT_365_PLUS_DAYS"]);
    expect(result.technology?.technologies.map((item) => item.name)).toEqual(["Next.js", "Vercel"]);
    expect(result.handoffUrl).toMatch(/^https:\/\/nexus\.example\/revival-review\?assessment=rev_/u);
    expect(result.receiptDigest).toMatch(/^sha256:[a-f0-9]{64}$/u);
  });

  it("prioritizes missing public SEO fundamentals without inventing CVE or exploit conclusions", async () => {
    const result = await engine(probe("<html><body>Legacy public homepage</body></html>")).assess({
      tenantId: "tenant-revival",
      candidateId: "lead-0002",
      websiteUrl: "https://candidate.example/",
      relationship: "FIRST_PARTY_CRM",
      dormantSince: "2026-01-01T00:00:00.000Z",
    });
    expect(result.classification).toBe("REVIEW_REACTIVATION");
    expect(result.reasons).toEqual(expect.arrayContaining(["MISSING_TITLE", "MISSING_META_DESCRIPTION", "MISSING_CANONICAL", "MISSING_VIEWPORT", "MISSING_JSON_LD"]));
    expect(JSON.stringify(result)).not.toMatch(/CVE|exploit|vulnerab/iu);
  });

  it("classifies a network failure for human review but does not turn policy failures into opportunities", async () => {
    const networkProbe = new PassivePublicSiteProbe({
      resolver: { resolve: async () => ["8.8.8.8"] },
      transport: { get: async () => { throw new PassivePublicSiteProbeError("NETWORK_FAILURE", "offline"); } },
      now: () => NOW,
    });
    const result = await engine(networkProbe).assess({
      tenantId: "tenant-revival",
      candidateId: "lead-0003",
      websiteUrl: "https://candidate.example/",
      relationship: "OWNED_PORTFOLIO",
      dormantSince: "2025-01-01T00:00:00.000Z",
    });
    expect(result).toMatchObject({ classification: "REVIEW_OFFLINE_OR_BROKEN", publicSite: { status: null } });

    const privateProbe = new PassivePublicSiteProbe({ resolver: { resolve: async () => ["127.0.0.1"] }, transport: { get: async () => { throw new Error("must not run"); } } });
    await expect(engine(privateProbe).assess({
      tenantId: "tenant-revival",
      candidateId: "lead-0004",
      websiteUrl: "https://candidate.example/",
      relationship: "FIRST_PARTY_CRM",
      dormantSince: "2025-01-01T00:00:00.000Z",
    })).rejects.toMatchObject({ code: "NON_PUBLIC_ADDRESS" });
  });

  it("fails closed on cross-tenant candidates and insufficient dormancy", async () => {
    const runtime = engine(probe("<html></html>"));
    await expect(runtime.assess({ tenantId: "other-tenant", candidateId: "lead-0005", websiteUrl: "https://candidate.example/", relationship: "FIRST_PARTY_CRM", dormantSince: "2025-01-01T00:00:00.000Z" })).rejects.toMatchObject({ code: "TENANT_MISMATCH" });
    await expect(runtime.assess({ tenantId: "tenant-revival", candidateId: "lead-0006", websiteUrl: "https://candidate.example/", relationship: "FIRST_PARTY_CRM", dormantSince: "2026-08-20T00:00:00.000Z" })).rejects.toMatchObject({ code: "INVALID_INPUT" });
  });
});
