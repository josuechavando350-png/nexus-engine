import { describe, expect, it, vi } from "vitest";
import { GoogleDataManagerRestClient } from "../../enhanced-conversions/data-manager-rest.js";
import { IdentifiedQualifiedOfflineConversionEngine } from "./connected-offline-conversions.js";

const POLICY = {
  minimumConversionValue: 10_000,
  maximumInvalidTrafficScore: 200,
  eligibleStages: ["QUALIFIED", "PROPOSAL", "WON"],
} as const;

describe("identified offline conversion engines", () => {
  it("derives Google Ads API identity from the same config used by the real sink", () => {
    const engine = IdentifiedQualifiedOfflineConversionEngine.forGoogleAdsApi(POLICY, {
      developerToken: "developer-token-real-shape",
      customerId: "123-456-7890",
      conversionActionId: "987654321",
      loginCustomerId: "999-888-7777",
      accessTokenProvider: async () => "oauth-access-token-real-shape-123456",
      fetchImpl: vi.fn(),
    });
    expect(engine.destinationIdentity()).toEqual({
      provider: "GOOGLE_ADS_API",
      googleAdsCustomerId: "1234567890",
    });
  });

  it("derives Data Manager identity from the operating account used by the real sink", () => {
    const client = new GoogleDataManagerRestClient({
      accessTokenProvider: async () => "data-manager-access-token-real-shape-123456",
      fetchImpl: vi.fn(),
    });
    const engine = IdentifiedQualifiedOfflineConversionEngine.forGoogleDataManager(POLICY, {
      client,
      destination: {
        operatingAccountId: "123-456-7890",
        conversionActionId: "987654321",
        loginAccountId: "999-888-7777",
      },
    });
    expect(engine.destinationIdentity()).toEqual({
      provider: "GOOGLE_DATA_MANAGER",
      googleAdsCustomerId: "1234567890",
    });
  });

  it("preserves #1 qualification and avoids the real transport for high-risk feedback", async () => {
    const fetchImpl: typeof fetch = vi.fn();
    const engine = IdentifiedQualifiedOfflineConversionEngine.forGoogleAdsApi(POLICY, {
      developerToken: "developer-token-real-shape",
      customerId: "1234567890",
      conversionActionId: "987654321",
      accessTokenProvider: async () => "oauth-access-token-real-shape-123456",
      fetchImpl,
    });
    const result = await engine.process({
      leadId: "lead-identified-0001",
      occurredAt: "2026-09-08T06:05:00.000Z",
      stage: "WON",
      conversionValue: 250_000,
      currencyCode: "MXN",
      invalidTrafficScore: 900,
      clickId: { kind: "gclid", value: "click-id-real-123456789" },
      adUserDataConsent: "GRANTED",
    });
    expect(result).toEqual({ status: "SKIPPED", reasons: ["TRAFFIC_RISK_TOO_HIGH"] });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
