import { describe, expect, it, vi } from "vitest";
import {
  GoogleAdsOfflineConversionClient,
  QualifiedOfflineConversionEngine,
  type OfflineConversionCandidate,
} from "./offline-conversions.js";

const candidate: OfflineConversionCandidate = {
  leadId: "lead-job-id-0001",
  occurredAt: "2026-09-08T05:10:11.000Z",
  stage: "WON",
  conversionValue: 30_000,
  currencyCode: "MXN",
  invalidTrafficScore: 20,
  clickId: { kind: "gclid", value: "EAIaIQobChMI-job-id-click-123456789" },
  adUserDataConsent: "GRANTED",
};

describe("Google Ads offline conversion request validation", () => {
  it("rejects jobId zero before any outbound request", async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const client = new GoogleAdsOfflineConversionClient({
      developerToken: "developer-token-real-shape",
      customerId: "1234567890",
      conversionActionId: "987654321",
      accessTokenProvider: async () => "oauth-access-token-real-shape-123456",
      fetchImpl,
    });
    const engine = new QualifiedOfflineConversionEngine({
      minimumConversionValue: 10_000,
      maximumInvalidTrafficScore: 300,
      eligibleStages: ["WON"],
    }, client);

    await expect(engine.process(candidate, { jobId: 0 })).rejects.toMatchObject({ code: "INVALID_INPUT" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
