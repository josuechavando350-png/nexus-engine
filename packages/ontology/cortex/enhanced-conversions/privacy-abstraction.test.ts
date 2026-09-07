import { describe, expect, it, vi } from "vitest";
import { InMemoryOntologyTransactionStore } from "@nexus/ontology/transaction";
import { DurableEnhancedConversionsPipeline } from "./index";
import { GoogleDataManagerRestClient } from "./data-manager-rest";
import {
  HttpConversionPrivacyDecisionProvider,
  PrivacyGuardedEnhancedConversionsPipeline,
  createPrivacyMutationGuard,
  type ConversionPrivacyDecision,
  type ConversionPrivacyDecisionProvider,
  type ConversionPrivacyPolicy,
} from "./privacy-abstraction";

const NOW = Date.parse("2026-09-07T06:00:00.000Z");
const scope = Object.freeze({ tenantId: "tenant-privacy", organizationId: "org-privacy" });
const destination = Object.freeze({ operatingAccountId: "1234567890", conversionActionId: "9876543210" });
const policy: ConversionPrivacyPolicy = Object.freeze({ version: 1, maxDecisionAgeMs: 60_000, allowedPolicyIds: Object.freeze(["privacy-v1"]) });

function decision(overrides: Partial<ConversionPrivacyDecision> = {}): ConversionPrivacyDecision {
  return Object.freeze({
    transactionId: "txn-privacy-0001",
    decisionId: "decision-privacy-0001",
    policyId: "privacy-v1",
    revision: 1,
    status: "GRANTED",
    allowedIdentityClasses: Object.freeze(["USER_DATA", "AD_CLICK"]),
    observedAt: new Date(NOW - 1_000).toISOString(),
    expiresAt: new Date(NOW + 60_000).toISOString(),
    ...overrides,
  });
}

class MutableDecisionProvider implements ConversionPrivacyDecisionProvider {
  current = decision();
  calls = 0;
  async resolve(transactionId: string): Promise<ConversionPrivacyDecision> {
    this.calls += 1;
    return Object.freeze({ ...this.current, transactionId });
  }
}

function input(transactionId = "txn-privacy-0001") {
  return {
    transactionId,
    eventTimestamp: new Date(NOW).toISOString(),
    eventName: "lead_submit",
    eventSource: "WEB" as const,
    // This client assertion is deliberately not authoritative in CORTEX #30.
    adUserDataConsent: "GRANTED" as const,
    gclid: "gclid-privacy-0001",
    emailAddresses: ["person@example.com"],
  };
}

function harness(provider = new MutableDecisionProvider()) {
  const store = new InMemoryOntologyTransactionStore();
  const fetchMock = vi.fn(async () => Response.json({ requestId: "dm-request-0001" }));
  const gateway = new GoogleDataManagerRestClient({
    accessTokenProvider: async () => "access-token-privacy-0000000000000000",
    fetchImpl: fetchMock as unknown as typeof fetch,
    beforeMutation: createPrivacyMutationGuard(provider, policy, () => NOW),
  });
  const base = new DurableEnhancedConversionsPipeline(store, scope, destination, gateway, () => "ACTIVE", () => NOW);
  const engine = new PrivacyGuardedEnhancedConversionsPipeline({ base, decisions: provider, policy, now: () => NOW });
  return { provider, store, fetchMock, engine };
}

describe("CORTEX #30 Enhanced Conversions privacy abstraction", () => {
  it("ignores client-asserted GRANTED and strips user data when the authoritative policy allows only ad-click identity", async () => {
    const h = harness();
    h.provider.current = decision({ allowedIdentityClasses: Object.freeze(["AD_CLICK"]) });
    const prepared = await h.engine.prepare(input());
    expect(prepared.event.adUserDataConsent).toBe("DENIED");
    expect(prepared.event.userIdentifiers).toEqual([]);
    expect(prepared.event.gclid).toBe("gclid-privacy-0001");

    const sent = await h.engine.dispatch(prepared.transactionId);
    expect(sent.status).toBe("SENT");
    expect(h.fetchMock).toHaveBeenCalledTimes(1);
    const request = h.fetchMock.mock.calls[0]?.[1] as RequestInit;
    const body = JSON.parse(String(request.body)) as Record<string, unknown>;
    expect(JSON.stringify(body)).not.toContain("person@example.com");
    expect(JSON.stringify(body)).not.toContain("userData");
    expect(JSON.stringify(body)).toContain("CONSENT_DENIED");
  });

  it("rechecks revocation immediately before Data Manager fetch and returns the outbox to PREPARED with zero external mutation", async () => {
    const h = harness();
    const prepared = await h.engine.prepare(input());
    expect(prepared.status).toBe("PREPARED");
    expect(prepared.event.userIdentifiers).toHaveLength(1);

    h.provider.current = decision({ revision: 2, status: "REVOKED", allowedIdentityClasses: Object.freeze([]) });
    await expect(h.engine.dispatch(prepared.transactionId)).rejects.toMatchObject({ code: "REMOTE_FAILURE" });
    expect(h.fetchMock).toHaveBeenCalledTimes(0);
    expect(h.engine.get(prepared.transactionId)?.status).toBe("PREPARED");
  });

  it("fails closed on expired/stale privacy evidence before durable preparation", async () => {
    const h = harness();
    h.provider.current = decision({ observedAt: new Date(NOW - 120_000).toISOString(), expiresAt: new Date(NOW - 60_000).toISOString() });
    await expect(h.engine.prepare(input())).rejects.toMatchObject({ code: "STALE_DECISION" });
    expect(h.fetchMock).toHaveBeenCalledTimes(0);
    expect(h.engine.get("txn-privacy-0001")).toBeUndefined();
  });

  it("uses a bounded HTTPS consent transport and rejects weak credentials/non-HTTPS endpoints", () => {
    expect(() => new HttpConversionPrivacyDecisionProvider({ endpoint: "http://privacy.example/v1/resolve", bearerToken: "p".repeat(32) })).toThrow(/HTTPS/u);
    expect(() => new HttpConversionPrivacyDecisionProvider({ endpoint: "https://privacy.example/v1/resolve", bearerToken: "short" })).toThrow(/32\.\.4096/u);
  });
});
