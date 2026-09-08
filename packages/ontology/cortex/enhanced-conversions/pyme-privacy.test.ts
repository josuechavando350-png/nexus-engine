import { describe, expect, it, vi } from "vitest";
import type { OntologyScope } from "@nexus/ontology";
import { InMemoryOntologyTransactionStore } from "@nexus/ontology/transaction";
import { GoogleDataManagerRestClient, type DataManagerConversionEvent, type DataManagerDestination } from "./data-manager-rest";
import { DurableEnhancedConversionsPipeline, EnhancedConversionError, type EnhancedConversionGateway } from "./index";

const scope: OntologyScope = Object.freeze({ tenantId: "tenant-pyme", organizationId: "org-pyme", brandId: "brand-pyme" });
const destination: DataManagerDestination = Object.freeze({ operatingAccountId: "1234567890", conversionActionId: "9876543210" });

function conversion(overrides: Record<string, unknown> = {}) {
  return {
    transactionId: "pyme-order-12345678",
    eventTimestamp: "2026-09-08T02:00:00.000Z",
    eventName: "qualified_lead",
    eventSource: "WEB",
    adUserDataConsent: "GRANTED",
    gbraid: "gbraid-click-123456",
    emailAddresses: ["User.Name+ads@gmail.com"],
    ...overrides,
  };
}

describe("CORTEX #30 PyME privacy hardening", () => {
  it("persists and dispatches a supported braid identifier without treating it as user data", async () => {
    const received: DataManagerConversionEvent[] = [];
    const gateway: EnhancedConversionGateway = {
      async ingestConversion(_destination, event) {
        received.push(event);
        return { requestId: "dm-request-00000001" };
      },
    };
    const pipeline = new DurableEnhancedConversionsPipeline(
      new InMemoryOntologyTransactionStore(),
      scope,
      destination,
      gateway,
      () => "ACTIVE",
      () => Date.parse("2026-09-08T02:01:00.000Z"),
    );

    const prepared = pipeline.prepare(conversion());
    expect(prepared.event).toMatchObject({ gbraid: "gbraid-click-123456" });
    expect(prepared.event.userIdentifiers).toHaveLength(1);
    expect(JSON.stringify(prepared)).not.toContain("User.Name");
    await expect(pipeline.dispatch(prepared.transactionId)).resolves.toMatchObject({ status: "SENT" });
    expect(received).toHaveLength(1);
  });

  it("rechecks revocation at the final side-effect boundary and returns the outbox to PREPARED", async () => {
    const gateway: EnhancedConversionGateway = { ingestConversion: vi.fn(async () => ({ requestId: "should-not-run" })) };
    let granted = true;
    const pipeline = new DurableEnhancedConversionsPipeline(
      new InMemoryOntologyTransactionStore(),
      scope,
      destination,
      gateway,
      () => "ACTIVE",
      () => Date.parse("2026-09-08T02:02:00.000Z"),
      undefined,
      () => {
        if (!granted) throw new Error("central consent registry reports REVOKED");
      },
    );
    const prepared = pipeline.prepare(conversion({ transactionId: "pyme-revoke-123456" }));
    granted = false;
    await expect(pipeline.dispatch(prepared.transactionId)).rejects.toMatchObject<Partial<EnhancedConversionError>>({ code: "CONSENT_VIOLATION" });
    expect(pipeline.get(prepared.transactionId)?.status).toBe("PREPARED");
    expect(gateway.ingestConversion).not.toHaveBeenCalled();
  });

  it("encodes GBRAID/WBRAID through the real Data Manager adapter and rejects conflicting braids", async () => {
    const requests: unknown[] = [];
    const client = new GoogleDataManagerRestClient({
      accessTokenProvider: async () => "access-token-long-enough-for-test",
      fetchImpl: vi.fn(async (_input, init) => {
        requests.push(JSON.parse(String(init?.body)) as unknown);
        return new Response(JSON.stringify({ requestId: "dm-request-00000002" }), { status: 200, headers: { "content-type": "application/json" } });
      }),
      timeoutMs: 1_000,
    });
    const base: DataManagerConversionEvent = Object.freeze({
      transactionId: "pyme-dm-12345678",
      eventTimestamp: "2026-09-08T02:00:00.000Z",
      eventName: "qualified_lead",
      eventSource: "WEB",
      adUserDataConsent: "GRANTED",
      gbraid: "gbraid-click-123456",
      userIdentifiers: [],
    });
    await expect(client.ingestConversion(destination, base)).resolves.toEqual({ requestId: "dm-request-00000002" });
    expect(requests[0]).toMatchObject({ events: [{ adIdentifiers: { gbraid: "gbraid-click-123456" } }] });
    await expect(client.ingestConversion(destination, { ...base, gbraid: "gbraid-one-12345", wbraid: "wbraid-two-12345" })).rejects.toMatchObject({ code: "INVALID_CONFIG" });
  });
});
