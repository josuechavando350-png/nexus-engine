import { describe, expect, it, vi } from "vitest";
import { DataManagerApiError, GoogleDataManagerRestClient, type DataManagerConversionEvent, type DataManagerDestination } from "./data-manager-rest";

const destination: DataManagerDestination = Object.freeze({ operatingAccountId: "123-456-7890", loginAccountId: "1112223333", conversionActionId: "9876543210" });
const event: DataManagerConversionEvent = Object.freeze({
  transactionId: "order-12345678",
  eventTimestamp: "2026-09-06T11:59:00.000Z",
  eventName: "purchase",
  eventSource: "WEB",
  adUserDataConsent: "GRANTED",
  conversionValue: 125.5,
  currency: "MXN",
  gclid: "click-id-123456",
  userIdentifiers: Object.freeze([{ hashedEmail: "a".repeat(64) }]),
});

describe("CORTEX #10 Google Data Manager REST adapter", () => {
  it("calls the real Data Manager ingestion boundary with normalized destination and explicit consent", async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toBe("https://datamanager.googleapis.com/v1/events:ingest");
      expect(init?.method).toBe("POST");
      expect(init?.redirect).toBe("error");
      expect((init?.headers as Record<string, string>).authorization).toBe("Bearer access-token-long-enough");
      const payload = JSON.parse(String(init?.body)) as Record<string, unknown>;
      expect(payload).toMatchObject({ consent: { adUserData: "CONSENT_GRANTED" }, encoding: "HEX", validateOnly: false });
      expect(payload.destinations).toEqual([{
        reference: "google-ads-conversion",
        loginAccount: { accountType: "GOOGLE_ADS", accountId: "1112223333" },
        operatingAccount: { accountType: "GOOGLE_ADS", accountId: "1234567890" },
        productDestinationId: "9876543210",
      }]);
      expect(payload.events).toEqual([expect.objectContaining({ transactionId: event.transactionId, userData: { userIdentifiers: [{ emailAddress: "a".repeat(64) }] } })]);
      return new Response(JSON.stringify({ requestId: "request-real-boundary-1" }), { status: 200, headers: { "content-type": "application/json" } });
    });
    const client = new GoogleDataManagerRestClient({ accessTokenProvider: async () => "access-token-long-enough", fetchImpl: fetchImpl as typeof fetch });
    await expect(client.ingestConversion(destination, event)).resolves.toEqual({ requestId: "request-real-boundary-1" });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("propagates denied consent and forbids hashed identifiers under denied consent", async () => {
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const payload = JSON.parse(String(init?.body)) as { consent: { adUserData: string }; events: unknown[] };
      expect(payload.consent.adUserData).toBe("CONSENT_DENIED");
      expect(payload.events).toEqual([expect.not.objectContaining({ userData: expect.anything() })]);
      return new Response(JSON.stringify({ requestId: "request-denied-consent" }), { status: 200 });
    });
    const client = new GoogleDataManagerRestClient({ accessTokenProvider: async () => "access-token-long-enough", fetchImpl: fetchImpl as typeof fetch });
    await client.ingestConversion(destination, { ...event, adUserDataConsent: "DENIED", userIdentifiers: [] });
    await expect(client.ingestConversion(destination, { ...event, adUserDataConsent: "DENIED" })).rejects.toBeInstanceOf(DataManagerApiError);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("classifies authentication, malformed response, and ambiguous transport without leaking credentials", async () => {
    const authClient = new GoogleDataManagerRestClient({ accessTokenProvider: async () => "access-token-long-enough", fetchImpl: async () => new Response("{}", { status: 403 }) });
    await expect(authClient.ingestConversion(destination, event)).rejects.toMatchObject({ code: "AUTHENTICATION_FAILED", httpStatus: 403 });

    const malformedClient = new GoogleDataManagerRestClient({ accessTokenProvider: async () => "access-token-long-enough", fetchImpl: async () => new Response("not-json", { status: 200 }) });
    await expect(malformedClient.ingestConversion(destination, event)).rejects.toMatchObject({ code: "INVALID_RESPONSE" });

    const transportClient = new GoogleDataManagerRestClient({ accessTokenProvider: async () => "super-secret-access-token", fetchImpl: async () => { throw new Error("socket reset"); } });
    const error = await transportClient.ingestConversion(destination, event).then(() => null, (caught: unknown) => caught as DataManagerApiError);
    expect(error?.code).toBe("AMBIGUOUS_OUTCOME");
    expect(error?.message).not.toContain("super-secret-access-token");
  });

  it("bounds the response stream before materializing it", async () => {
    const client = new GoogleDataManagerRestClient({
      accessTokenProvider: async () => "access-token-long-enough",
      fetchImpl: async () => new Response("x".repeat(70 * 1024), { status: 200 }),
    });
    await expect(client.ingestConversion(destination, event)).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
  });
});
