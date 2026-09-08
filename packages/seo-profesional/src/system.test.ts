import { describe, expect, it, vi } from "vitest";
import {
  SeoProfesionalCazadorConLupa as CazadorConLupa,
  SeoProfesionalDetectorDeTrampas as DetectorDeTrampas,
} from "@nexus/ontology";
import { createAdPersonalizationPolicy } from "@nexus/core/cortex/ad-context-edge-personalization";
import { ConnectedSeoProfessionalSystem } from "./system.js";

const GCLID = "EAIaIQobChMI-connected-seo-click-123456";

function personalizationPolicy() {
  return createAdPersonalizationPolicy({
    version: 1,
    languageTag: "es-MX",
    adContext: {
      policyId: "seo-connected-camaleon-v1",
      mode: "ACTIVE",
      defaultExperienceId: "default",
      paidSearchExperienceId: "paid-search",
      allowedExperienceIds: ["default", "paid-search"],
      exactRules: [{
        ruleId: "google-brand",
        experienceId: "paid-search",
        source: "google",
        medium: "cpc",
        campaign: "brand",
      }],
    },
    blocks: [{ blockId: "proof", heading: "Prueba", body: "Contenido aprobado por el negocio." }],
    profiles: [
      {
        experienceId: "default",
        headline: "Experiencia general",
        subheadline: "Contenido base",
        ctaLabel: "Contactar",
        ctaHref: "/contact",
        blockOrder: ["proof"],
        layoutProfileId: "standard",
      },
      {
        experienceId: "paid-search",
        headline: "Experiencia de búsqueda",
        subheadline: "Contenido para intención pagada",
        ctaLabel: "Consultar",
        ctaHref: "/contact?source=paid-search",
        blockOrder: ["proof"],
        layoutProfileId: "intent-first",
      },
    ],
  });
}

function trafficScorer(networkClass: "RESIDENTIAL" | "DATACENTER" = "RESIDENTIAL") {
  return new DetectorDeTrampas.InvalidTrafficClickScorer({
    signingSecret: "s".repeat(64),
    networkSecret: "n".repeat(64),
    clickReplaySecret: "r".repeat(64),
    providerId: "seo-connected-risk-provider",
    networkClassifier: new DetectorDeTrampas.CidrNetworkClassifier([
      { id: "test-network", cidr: "198.51.100.0/24", networkClass },
    ]),
    idFactory: () => "assessment-connected-0001",
    now: () => Date.parse("2026-09-08T12:00:00.000Z"),
  });
}

function landingHeaders(userAgent = "Mozilla/5.0 Chrome/140 Safari/537.36") {
  return {
    "user-agent": userAgent,
    accept: "text/html,application/xhtml+xml",
    "sec-fetch-dest": "document",
    "sec-fetch-mode": "navigate",
  } as const;
}

function exactMatchEngine(requests: Array<{ url: string; body: Record<string, unknown> }>) {
  const fetchImpl: typeof fetch = vi.fn(async (input, init) => {
    const url = String(input);
    const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    requests.push({ url, body });
    if (url.endsWith("/googleAds:search")) {
      const query = String(body.query ?? "");
      if (query.includes("FROM search_term_view")) {
        return new Response(JSON.stringify({
          results: [{
            campaign: { id: "1111111111" },
            adGroup: { id: "2222222222" },
            searchTermView: { searchTerm: "abogado penalista cdmx", status: "NONE" },
            segments: { searchTermMatchType: "BROAD" },
            metrics: {
              impressions: "200",
              clicks: "30",
              conversions: 6,
              conversionsValue: 180,
              costMicros: "30000000",
            },
          }],
        }), { status: 200, headers: { "content-type": "application/json", "request-id": "terms-1" } });
      }
      if (query.includes("FROM ad_group_criterion")) {
        return new Response(JSON.stringify({ results: [] }), { status: 200, headers: { "content-type": "application/json", "request-id": "inventory-1" } });
      }
    }
    if (url.endsWith("/googleAds:mutate")) {
      return new Response(JSON.stringify({}), { status: 200, headers: { "content-type": "application/json", "request-id": "validate-1" } });
    }
    throw new Error(`unexpected request ${url}`);
  });
  const client = new CazadorConLupa.GoogleAdsExactMatchClient({
    developerToken: "developer-token-real-shape",
    accessTokenProvider: async () => "oauth-access-token-real-shape-123456",
    fetchImpl,
    maxReadRetries: 0,
  });
  return new CazadorConLupa.ExactMatchSynthesizerEngine(client);
}

function offlineEngine(upload: ReturnType<typeof vi.fn>) {
  return new DetectorDeTrampas.QualifiedOfflineConversionEngine({
    minimumConversionValue: 1_000,
    maximumInvalidTrafficScore: 400,
    eligibleStages: ["QUALIFIED", "PROPOSAL", "WON"],
  }, { upload });
}

describe("ConnectedSeoProfessionalSystem", () => {
  it("runs #1 -> #3 landing, #1 offline feedback, then #2 exact-match optimization on one connected Google Ads account", async () => {
    const requests: Array<{ url: string; body: Record<string, unknown> }> = [];
    const upload = vi.fn(async (conversion) => ({
      provider: "GOOGLE_ADS_API" as const,
      requestId: `offline-${conversion.orderId}`,
      jobId: null,
      status: "UPLOADED" as const,
    }));
    const system = new ConnectedSeoProfessionalSystem({
      googleAdsCustomerId: "123-456-7890",
      maximumPersonalizationRiskScore: 400,
      trafficScorer: trafficScorer(),
      offlineConversions: offlineEngine(upload),
      exactMatchSynthesizer: exactMatchEngine(requests),
      personalizationPolicy: personalizationPolicy(),
    });

    const landing = await system.assessLanding({
      url: `https://example.test/?utm_source=google&utm_medium=cpc&utm_campaign=brand&gclid=${GCLID}`,
      clientIp: "198.51.100.25",
      method: "GET",
      headers: landingHeaders(),
    });
    expect(landing.traffic.riskScore).toBe(0);
    expect(landing.personalization).toMatchObject({
      context: { experienceId: "paid-search", applied: true, ruleId: "google-brand" },
    });
    expect(landing.personalizationSuppressedByTrafficRisk).toBe(false);
    expect(landing.strategyTrace).toEqual([1, 3]);

    const conversion = await system.recordQualifiedConversion({
      landing,
      leadId: "lead-connected-0001",
      occurredAt: "2026-09-08T12:30:00.000Z",
      stage: "QUALIFIED",
      conversionValue: 25_000,
      currencyCode: "MXN",
      clickId: { kind: "gclid", value: GCLID },
      adUserDataConsent: "GRANTED",
    });
    expect(conversion.status).toBe("SENT");
    expect(upload).toHaveBeenCalledTimes(1);
    expect(upload.mock.calls[0]?.[0]).toMatchObject({
      orderId: "lead-connected-0001",
      invalidTrafficScore: 0,
      clickId: { kind: "gclid", value: GCLID },
    });

    const optimization = await system.optimizeExactMatches({
      policy: {
        startDate: "2026-08-01",
        endDate: "2026-08-31",
        minimumClicks: 20,
        minimumConversions: 3,
        minimumConversionRate: 0.1,
        maximumCostPerConversionMicros: 6_000_000,
        minimumConversionValuePerCost: 2,
        maximumCandidates: 10,
      },
      campaignIds: ["1111111111"],
      materialization: { executionMode: "VALIDATE_ONLY", adGroupNamePrefix: "NEXUS EXACT" },
    });
    expect(optimization.selection.selected).toHaveLength(1);
    expect(optimization.selection.selected[0]?.searchTerm).toBe("abogado penalista cdmx");
    expect(optimization.materialization.status).toBe("VALIDATED");
    expect(requests.map((request) => request.url)).toEqual([
      "https://googleads.googleapis.com/v25/customers/1234567890/googleAds:search",
      "https://googleads.googleapis.com/v25/customers/1234567890/googleAds:search",
      "https://googleads.googleapis.com/v25/customers/1234567890/googleAds:mutate",
    ]);
    expect(system.snapshot()).toEqual({
      googleAdsCustomerId: "1234567890",
      strategyNumbers: [1, 2, 3],
      connectionCount: 3,
      connected: true,
    });
  });

  it("uses #1 risk to fail personalization to the default experience and prevents risky offline feedback", async () => {
    const upload = vi.fn(async () => ({ provider: "GOOGLE_ADS_API" as const, requestId: "unexpected", jobId: null, status: "UPLOADED" as const }));
    const system = new ConnectedSeoProfessionalSystem({
      googleAdsCustomerId: "1234567890",
      maximumPersonalizationRiskScore: 400,
      trafficScorer: trafficScorer("DATACENTER"),
      offlineConversions: offlineEngine(upload),
      exactMatchSynthesizer: exactMatchEngine([]),
      personalizationPolicy: personalizationPolicy(),
    });
    const landing = await system.assessLanding({
      url: `https://example.test/?utm_source=google&utm_medium=cpc&utm_campaign=brand&gclid=${GCLID}`,
      clientIp: "198.51.100.30",
      method: "GET",
      headers: landingHeaders("HeadlessChrome/140"),
    });
    expect(landing.traffic.riskScore).toBeGreaterThan(400);
    expect(landing.personalizationSuppressedByTrafficRisk).toBe(true);
    expect(landing.personalization.context).toMatchObject({ experienceId: "default", applied: false, reason: "NO_AD_CONTEXT" });

    const conversion = await system.recordQualifiedConversion({
      landing,
      leadId: "lead-risky-0001",
      occurredAt: "2026-09-08T12:30:00.000Z",
      stage: "QUALIFIED",
      conversionValue: 25_000,
      currencyCode: "MXN",
      clickId: { kind: "gclid", value: GCLID },
      adUserDataConsent: "GRANTED",
    });
    expect(conversion).toMatchObject({ status: "SKIPPED", reasons: expect.arrayContaining(["TRAFFIC_RISK_TOO_HIGH"]) });
    expect(upload).not.toHaveBeenCalled();
  });

  it("rejects attribution that changes the Google click-id kind between landing and conversion", async () => {
    const upload = vi.fn(async () => ({ provider: "GOOGLE_ADS_API" as const, requestId: "unexpected", jobId: null, status: "UPLOADED" as const }));
    const system = new ConnectedSeoProfessionalSystem({
      googleAdsCustomerId: "1234567890",
      maximumPersonalizationRiskScore: 400,
      trafficScorer: trafficScorer(),
      offlineConversions: offlineEngine(upload),
      exactMatchSynthesizer: exactMatchEngine([]),
      personalizationPolicy: personalizationPolicy(),
    });
    const landing = await system.assessLanding({
      url: `https://example.test/?gclid=${GCLID}`,
      clientIp: "198.51.100.31",
      method: "GET",
      headers: landingHeaders(),
    });
    await expect(system.recordQualifiedConversion({
      landing,
      leadId: "lead-mismatch-0001",
      occurredAt: "2026-09-08T12:30:00.000Z",
      stage: "QUALIFIED",
      conversionValue: 25_000,
      currencyCode: "MXN",
      clickId: { kind: "wbraid", value: "wbraid-connected-123456789" },
      adUserDataConsent: "GRANTED",
    })).rejects.toMatchObject({ code: "ATTRIBUTION_MISMATCH" });
    expect(upload).not.toHaveBeenCalled();
  });
});
