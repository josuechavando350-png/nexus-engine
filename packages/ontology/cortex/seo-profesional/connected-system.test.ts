import { describe, expect, it, vi } from "vitest";
import {
  createAdPersonalizationPolicy,
} from "../../../core/cortex/ad-context-edge-workers/personalization.js";
import {
  createSeoProfessionalCamaleonAdapter,
} from "../../../core/cortex/ad-context-edge-workers/seo-profesional-adapter.js";
import {
  CidrNetworkClassifier,
  IdentifiedQualifiedOfflineConversionEngine,
  InvalidTrafficClickScorer,
} from "./01-detector-de-trampas/index.js";
import {
  ExactMatchSynthesizerEngine,
  GoogleAdsExactMatchClient,
} from "./02-cazador-con-lupa/index.js";
import {
  ConnectedSeoProfessionalSystem,
  type ConnectedAttributionReceipt,
} from "./connected-system.js";

const CUSTOMER_ID = "1234567890";
const CLICK_ID = "click-id-real-123456789";
const NOW = Date.parse("2026-09-08T06:00:00.000Z");

type HttpRecord = { url: string; body: Record<string, unknown> };

function trafficScorer(networkClass: "RESIDENTIAL" | "DATACENTER" = "RESIDENTIAL") {
  return new InvalidTrafficClickScorer({
    signingSecret: "traffic-signing-secret-00000000000000000000000000000001",
    networkSecret: "traffic-network-secret-00000000000000000000000000000002",
    clickReplaySecret: "traffic-replay-secret-000000000000000000000000000000003",
    providerId: "nexus.seo.detector.v1",
    networkClassifier: new CidrNetworkClassifier([
      { id: "test-network", cidr: "203.0.113.0/24", networkClass },
    ]),
    now: () => NOW,
    idFactory: () => networkClass === "RESIDENTIAL" ? "assessment-connected-0001" : "assessment-connected-0002",
  });
}

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
    },
    blocks: [
      { blockId: "proof", heading: "Prueba", body: "Contenido aprobado." },
      { blockId: "contact", heading: "Contacto", body: "Ruta controlada." },
    ],
    profiles: [
      {
        experienceId: "default",
        headline: "Experiencia general",
        subheadline: "Contenido general aprobado.",
        ctaLabel: "Contactar",
        ctaHref: "/contact",
        blockOrder: ["proof", "contact"],
        layoutProfileId: "standard",
      },
      {
        experienceId: "paid-search",
        headline: "Experiencia de búsqueda",
        subheadline: "Contenido de búsqueda aprobado.",
        ctaLabel: "Ver opciones",
        ctaHref: "/contact?source=paid-search",
        blockOrder: ["contact", "proof"],
        layoutProfileId: "intent-first",
      },
    ],
  });
}

function exactMatchEngine(requests: HttpRecord[]) {
  const fetchImpl: typeof fetch = vi.fn(async (input, init) => {
    const url = String(input);
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    requests.push({ url, body });
    if (url.endsWith("/googleAds:search")) {
      const query = String(body.query ?? "");
      if (query.includes("FROM search_term_view")) {
        return new Response(JSON.stringify({
          results: [{
            campaign: { id: "1111111111" },
            adGroup: { id: "2222222222" },
            searchTermView: { searchTerm: "abogado penal urgente", status: "NONE" },
            segments: { searchTermMatchType: "BROAD" },
            metrics: {
              impressions: "100",
              clicks: "20",
              conversions: 4,
              conversionsValue: 120_000,
              costMicros: "20000000",
            },
          }],
        }), { status: 200, headers: { "content-type": "application/json", "request-id": "connected-search" } });
      }
      return new Response(JSON.stringify({ results: [] }), {
        status: 200,
        headers: { "content-type": "application/json", "request-id": "connected-existing" },
      });
    }
    if (url.endsWith("/googleAds:mutate")) {
      return new Response(JSON.stringify({}), {
        status: 200,
        headers: { "content-type": "application/json", "request-id": "connected-validate" },
      });
    }
    throw new Error(`unexpected Google Ads endpoint ${url}`);
  });
  const client = new GoogleAdsExactMatchClient({
    developerToken: "developer-token-real-shape",
    loginCustomerId: "999-888-7777",
    accessTokenProvider: async () => "oauth-access-token-real-shape-123456",
    fetchImpl,
    maxReadRetries: 0,
  });
  return new ExactMatchSynthesizerEngine(client);
}

function offlineEngine(requests: HttpRecord[], customerId = CUSTOMER_ID) {
  const fetchImpl: typeof fetch = vi.fn(async (input, init) => {
    const url = String(input);
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    requests.push({ url, body });
    return new Response(JSON.stringify({
      results: [{ gclidDateTimePair: { gclid: CLICK_ID, conversionDateTime: "2026-09-08 06:05:00+00:00" } }],
      jobId: "77",
    }), {
      status: 200,
      headers: { "content-type": "application/json", "request-id": "offline-connected-1" },
    });
  });
  return IdentifiedQualifiedOfflineConversionEngine.forGoogleAdsApi({
    minimumConversionValue: 10_000,
    maximumInvalidTrafficScore: 200,
    eligibleStages: ["QUALIFIED", "PROPOSAL", "WON"],
  }, {
    developerToken: "developer-token-real-shape",
    customerId,
    conversionActionId: "987654321",
    loginCustomerId: "999-888-7777",
    accessTokenProvider: async () => "oauth-access-token-real-shape-123456",
    fetchImpl,
  });
}

function landingHeaders(userAgent = "Mozilla/5.0 Nexus Test Browser") {
  return {
    "user-agent": userAgent,
    accept: "text/html,application/xhtml+xml",
    "sec-fetch-dest": "document",
    "sec-fetch-mode": "navigate",
  } as const;
}

function buildSystem(
  scorer: InvalidTrafficClickScorer,
  exactRequests: HttpRecord[],
  offlineRequests: HttpRecord[],
  offlineCustomerId = CUSTOMER_ID,
) {
  return new ConnectedSeoProfessionalSystem({
    googleAdsCustomerId: "123-456-7890",
    maximumPersonalizationRiskScore: 200,
    attributionSecret: "connected-attribution-secret-0000000000000000000000000001",
    attributionTtlMs: 30 * 24 * 60 * 60 * 1_000,
    now: () => NOW,
    trafficScorer: scorer,
    offlineConversions: offlineEngine(offlineRequests, offlineCustomerId),
    exactMatchSynthesizer: exactMatchEngine(exactRequests),
    camaleonWeb: createSeoProfessionalCamaleonAdapter(personalizationPolicy()),
  });
}

describe("SEO Profesional connected system #1 + #2 + #3", () => {
  it("runs the real acquisition loop through one verified customer identity and a signed private attribution receipt", async () => {
    const exactRequests: HttpRecord[] = [];
    const offlineRequests: HttpRecord[] = [];
    const system = buildSystem(trafficScorer(), exactRequests, offlineRequests);

    expect(system.snapshot()).toEqual({
      googleAdsCustomerId: CUSTOMER_ID,
      offlineConversionProvider: "GOOGLE_ADS_API",
      strategyNumbers: [1, 2, 3],
      connectionCount: 3,
      connected: true,
    });

    const landing = await system.assessLanding({
      url: `https://example.test/?gclid=${CLICK_ID}`,
      clientIp: "203.0.113.10",
      method: "GET",
      headers: landingHeaders(),
    });

    expect(landing.traffic.riskScore).toBe(0);
    expect(landing.personalization.context).toMatchObject({
      experienceId: "paid-search",
      applied: true,
      reason: "PAID_SEARCH_SIGNAL",
    });
    expect(landing.personalizationSuppressedByTrafficRisk).toBe(false);
    expect(landing.strategyTrace).toEqual([1, 3]);
    expect(landing.attribution).not.toBeNull();
    expect(JSON.stringify(landing.attribution)).not.toContain(CLICK_ID);

    const conversion = await system.recordQualifiedConversion({
      leadId: "lead-connected-0001",
      occurredAt: "2026-09-08T06:05:00.000Z",
      stage: "QUALIFIED",
      conversionValue: 50_000,
      currencyCode: "MXN",
      clickId: { kind: "gclid", value: CLICK_ID },
      adUserDataConsent: "GRANTED",
      attribution: landing.attribution!,
    }, { jobId: 77 });
    expect(conversion).toMatchObject({
      status: "SENT",
      receipt: { provider: "GOOGLE_ADS_API", requestId: "offline-connected-1", jobId: "77", status: "UPLOADED" },
    });
    expect(offlineRequests).toHaveLength(1);
    expect(offlineRequests[0]!.url).toBe(`https://googleads.googleapis.com/v25/customers/${CUSTOMER_ID}:uploadClickConversions`);
    expect(offlineRequests[0]!.body).toMatchObject({
      jobId: 77,
      partialFailure: true,
      validateOnly: false,
      conversions: [{
        conversionAction: `customers/${CUSTOMER_ID}/conversionActions/987654321`,
        gclid: CLICK_ID,
        conversionValue: 50_000,
        currencyCode: "MXN",
        orderId: "lead-connected-0001",
      }],
    });

    const optimization = await system.optimizeExactMatches({
      policy: {
        startDate: "2026-08-01",
        endDate: "2026-08-31",
        minimumClicks: 1,
        minimumConversions: 1,
        minimumConversionRate: 0.01,
        maximumCandidates: 10,
      },
      campaignIds: ["1111111111"],
      materialization: { executionMode: "VALIDATE_ONLY", adGroupNamePrefix: "NEXUS EXACT" },
    });
    expect(optimization.selection.selected).toHaveLength(1);
    expect(optimization.materialization).toMatchObject({ status: "VALIDATED", requestId: "connected-validate" });
    expect(exactRequests).toHaveLength(3);
    for (const request of exactRequests) expect(request.url).toContain(`/customers/${CUSTOMER_ID}/`);
    expect(String(exactRequests[0]!.body.query)).toContain("FROM search_term_view");
    expect(exactRequests[2]!.body).toMatchObject({ validateOnly: true, partialFailure: false });
  });

  it("rejects a tampered receipt and a different click id before the real offline transport", async () => {
    const exactRequests: HttpRecord[] = [];
    const offlineRequests: HttpRecord[] = [];
    const system = buildSystem(trafficScorer(), exactRequests, offlineRequests);
    const landing = await system.assessLanding({
      url: `https://example.test/?gclid=${CLICK_ID}`,
      clientIp: "203.0.113.10",
      headers: landingHeaders(),
    });
    const receipt = landing.attribution!;
    const tampered: ConnectedAttributionReceipt = {
      payload: { ...receipt.payload, riskScore: 999 },
      signature: receipt.signature,
    };

    await expect(system.recordQualifiedConversion({
      leadId: "lead-connected-0002",
      occurredAt: "2026-09-08T06:05:00.000Z",
      stage: "QUALIFIED",
      conversionValue: 50_000,
      currencyCode: "MXN",
      clickId: { kind: "gclid", value: CLICK_ID },
      adUserDataConsent: "GRANTED",
      attribution: tampered,
    })).rejects.toMatchObject({ code: "ATTRIBUTION_MISMATCH" });

    await expect(system.recordQualifiedConversion({
      leadId: "lead-connected-0003",
      occurredAt: "2026-09-08T06:05:00.000Z",
      stage: "QUALIFIED",
      conversionValue: 50_000,
      currencyCode: "MXN",
      clickId: { kind: "gclid", value: "different-click-id-123456789" },
      adUserDataConsent: "GRANTED",
      attribution: receipt,
    })).rejects.toMatchObject({ code: "ATTRIBUTION_MISMATCH" });
    expect(offlineRequests).toHaveLength(0);
  });

  it("uses #1 risk to suppress #3 personalization and prevents risky feedback from reaching Google Ads", async () => {
    const exactRequests: HttpRecord[] = [];
    const offlineRequests: HttpRecord[] = [];
    const system = buildSystem(trafficScorer("DATACENTER"), exactRequests, offlineRequests);
    const landing = await system.assessLanding({
      url: `https://example.test/?gclid=${CLICK_ID}`,
      clientIp: "203.0.113.55",
      headers: landingHeaders("HeadlessChrome/140.0"),
    });

    expect(landing.traffic.riskScore).toBeGreaterThan(200);
    expect(landing.personalizationSuppressedByTrafficRisk).toBe(true);
    expect(landing.personalization.context).toMatchObject({
      experienceId: "default",
      applied: false,
      reason: "NO_AD_CONTEXT",
    });

    const result = await system.recordQualifiedConversion({
      leadId: "lead-connected-0004",
      occurredAt: "2026-09-08T06:05:00.000Z",
      stage: "WON",
      conversionValue: 250_000,
      currencyCode: "MXN",
      clickId: { kind: "gclid", value: CLICK_ID },
      adUserDataConsent: "GRANTED",
      attribution: landing.attribution!,
    });
    expect(result).toEqual({ status: "SKIPPED", reasons: ["TRAFFIC_RISK_TOO_HIGH"] });
    expect(offlineRequests).toHaveLength(0);
  });

  it("fails construction when #1 offline destination and #2 optimization customer differ", () => {
    expect(() => buildSystem(trafficScorer(), [], [], "7777777777")).toThrowError(/offline conversion destination must match googleAdsCustomerId/u);
  });
});
