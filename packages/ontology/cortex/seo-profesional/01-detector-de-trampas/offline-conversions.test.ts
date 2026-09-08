import { describe, expect, it, vi } from "vitest";
import { GoogleDataManagerRestClient } from "../../enhanced-conversions/data-manager-rest.js";
import {
  GoogleAdsOfflineConversionClient,
  GoogleDataManagerOfflineConversionSink,
  OfflineConversionError,
  QualifiedOfflineConversionEngine,
  qualifyOfflineConversion,
  type OfflineConversionCandidate,
  type OfflineConversionSink,
} from "./offline-conversions.js";

const candidate: OfflineConversionCandidate = {
  leadId: "lead-qualified-0001",
  occurredAt: "2026-09-08T05:10:11.000Z",
  stage: "QUALIFIED",
  conversionValue: 25_000,
  currencyCode: "MXN",
  invalidTrafficScore: 40,
  clickId: { kind: "gclid", value: "EAIaIQobChMI-real-click-id-123456789" },
  adUserDataConsent: "GRANTED",
};

const policy = {
  minimumConversionValue: 10_000,
  maximumInvalidTrafficScore: 300,
  eligibleStages: ["QUALIFIED", "PROPOSAL", "WON"] as const,
};

describe("offline conversion qualification", () => {
  it("requires value, acceptable traffic risk and an eligible lead stage", () => {
    expect(qualifyOfflineConversion(candidate, policy)).toMatchObject({ eligible: true });
    expect(qualifyOfflineConversion({ ...candidate, conversionValue: 500, invalidTrafficScore: 900, stage: "QUALIFIED" }, policy)).toEqual({
      eligible: false,
      reasons: ["BELOW_MINIMUM_VALUE", "TRAFFIC_RISK_TOO_HIGH"],
    });
    expect(qualifyOfflineConversion({ ...candidate, stage: "QUALIFIED" }, { ...policy, eligibleStages: ["WON"] })).toEqual({
      eligible: false,
      reasons: ["STAGE_NOT_ELIGIBLE"],
    });
  });

  it("never calls the external sink when a lead fails qualification", async () => {
    const upload = vi.fn<OfflineConversionSink["upload"]>();
    const engine = new QualifiedOfflineConversionEngine(policy, { upload });
    const result = await engine.process({ ...candidate, invalidTrafficScore: 950 });
    expect(result).toEqual({ status: "SKIPPED", reasons: ["TRAFFIC_RISK_TOO_HIGH"] });
    expect(upload).not.toHaveBeenCalled();
  });
});

describe("GoogleAdsOfflineConversionClient", () => {
  it("sends the documented uploadClickConversions request with partial failure and a stable order id", async () => {
    const requests: Array<{ url: string; init: RequestInit; body: Record<string, unknown> }> = [];
    const fetchImpl: typeof fetch = vi.fn(async (input, init) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      requests.push({ url: String(input), init: init ?? {}, body });
      return new Response(JSON.stringify({ results: [{ gclid: candidate.clickId.value }], jobId: "12345" }), {
        status: 200,
        headers: { "content-type": "application/json", "request-id": "request-ads-001" },
      });
    });
    const client = new GoogleAdsOfflineConversionClient({
      developerToken: "developer-token-real-shape",
      customerId: "123-456-7890",
      conversionActionId: "987654321",
      loginCustomerId: "111-222-3333",
      accessTokenProvider: async () => "oauth-access-token-real-shape-123456",
      fetchImpl,
    });
    const engine = new QualifiedOfflineConversionEngine(policy, client);

    const result = await engine.process(candidate, { jobId: 77 });

    expect(result).toEqual({
      status: "SENT",
      receipt: { provider: "GOOGLE_ADS_API", requestId: "request-ads-001", jobId: "12345", status: "UPLOADED" },
    });
    expect(requests).toHaveLength(1);
    expect(requests[0]!.url).toBe("https://googleads.googleapis.com/v25/customers/1234567890:uploadClickConversions");
    expect(requests[0]!.init.method).toBe("POST");
    expect(requests[0]!.init.redirect).toBe("error");
    expect(requests[0]!.init.headers).toMatchObject({
      authorization: "Bearer oauth-access-token-real-shape-123456",
      "developer-token": "developer-token-real-shape",
      "login-customer-id": "1112223333",
    });
    expect(requests[0]!.body).toMatchObject({
      partialFailure: true,
      validateOnly: false,
      jobId: 77,
      conversions: [{
        conversionAction: "customers/1234567890/conversionActions/987654321",
        gclid: candidate.clickId.value,
        conversionValue: 25_000,
        conversionDateTime: "2026-09-08 05:10:11+00:00",
        currencyCode: "MXN",
        orderId: "lead-qualified-0001",
        consent: { adUserData: "GRANTED" },
      }],
    });
  });

  it("fails the whole logical upload when Google reports a partial conversion failure", async () => {
    const client = new GoogleAdsOfflineConversionClient({
      developerToken: "developer-token-real-shape",
      customerId: "1234567890",
      conversionActionId: "987654321",
      accessTokenProvider: async () => "oauth-access-token-real-shape-123456",
      fetchImpl: async () => new Response(JSON.stringify({ partialFailureError: { code: 3, message: "conversion rejected" }, results: [{}] }), {
        status: 200,
        headers: { "content-type": "application/json", "request-id": "request-ads-002" },
      }),
    });

    await expect(client.upload(qualifyOrThrow(candidate))).rejects.toMatchObject({
      code: "PARTIAL_FAILURE",
      requestId: "request-ads-002",
    });
  });

  it("surfaces Google's post-2026 allowlist restriction with an explicit Data Manager fallback code", async () => {
    const client = new GoogleAdsOfflineConversionClient({
      developerToken: "developer-token-real-shape",
      customerId: "1234567890",
      conversionActionId: "987654321",
      accessTokenProvider: async () => "oauth-access-token-real-shape-123456",
      fetchImpl: async () => new Response(JSON.stringify({
        error: {
          code: 403,
          status: "PERMISSION_DENIED",
          message: "CUSTOMER_NOT_ALLOWLISTED_FOR_THIS_FEATURE",
          details: [{ errors: [{ errorCode: { conversionUploadError: "CUSTOMER_NOT_ALLOWLISTED_FOR_THIS_FEATURE" } }] }],
        },
      }), { status: 403, headers: { "content-type": "application/json", "request-id": "request-ads-003" } }),
    });

    await expect(client.upload(qualifyOrThrow(candidate))).rejects.toMatchObject({
      code: "LEGACY_API_RESTRICTED",
      requestId: "request-ads-003",
    });
  });

  it("treats a server failure as an ambiguous mutation outcome instead of retrying", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ error: { status: "INTERNAL", message: "temporary server failure" } }), {
      status: 503,
      headers: { "content-type": "application/json", "request-id": "request-ads-004" },
    }));
    const client = new GoogleAdsOfflineConversionClient({
      developerToken: "developer-token-real-shape",
      customerId: "1234567890",
      conversionActionId: "987654321",
      accessTokenProvider: async () => "oauth-access-token-real-shape-123456",
      fetchImpl,
    });

    await expect(client.upload(qualifyOrThrow(candidate))).rejects.toMatchObject({ code: "AMBIGUOUS_OUTCOME" });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});

describe("GoogleDataManagerOfflineConversionSink", () => {
  it("sends a qualified click conversion through the existing real Data Manager REST client", async () => {
    const requests: Array<{ url: string; body: Record<string, unknown> }> = [];
    const fetchImpl: typeof fetch = vi.fn(async (input, init) => {
      requests.push({ url: String(input), body: JSON.parse(String(init?.body)) as Record<string, unknown> });
      return new Response(JSON.stringify({ requestId: "data-manager-request-001" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    const dataManager = new GoogleDataManagerRestClient({
      accessTokenProvider: async () => "data-manager-oauth-token-123456",
      fetchImpl,
    });
    const sink = new GoogleDataManagerOfflineConversionSink({
      client: dataManager,
      destination: { operatingAccountId: "1234567890", conversionActionId: "987654321", loginAccountId: "1112223333" },
      eventName: "qualified_lead",
      eventSource: "WEB",
    });
    const engine = new QualifiedOfflineConversionEngine(policy, sink);

    expect(await engine.process({ ...candidate, clickId: { kind: "wbraid", value: "EAIaIQobChMI-wbraid-real-123456789" } })).toEqual({
      status: "SENT",
      receipt: { provider: "GOOGLE_DATA_MANAGER", requestId: "data-manager-request-001", jobId: null, status: "UPLOADED" },
    });
    expect(requests).toHaveLength(1);
    expect(requests[0]!.url).toBe("https://datamanager.googleapis.com/v1/events:ingest");
    expect(requests[0]!.body).toMatchObject({
      encoding: "HEX",
      validateOnly: false,
      consent: { adUserData: "CONSENT_GRANTED" },
      destinations: [{ productDestinationId: "987654321" }],
      events: [{
        transactionId: "lead-qualified-0001",
        eventTimestamp: "2026-09-08T05:10:11.000Z",
        eventName: "qualified_lead",
        eventSource: "WEB",
        conversionValue: 25_000,
        currency: "MXN",
        adIdentifiers: { wbraid: "EAIaIQobChMI-wbraid-real-123456789" },
      }],
    });
  });
});

function qualifyOrThrow(input: OfflineConversionCandidate) {
  const result = qualifyOfflineConversion(input, policy);
  if (!result.eligible) throw new OfflineConversionError("INVALID_INPUT", "test candidate unexpectedly failed qualification");
  return result.conversion;
}
