import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OntologyScope } from "@nexus/ontology";
import { InMemoryOntologyTransactionStore } from "@nexus/ontology/transaction";
import type { EnhancedConversionGateway } from "../enhanced-conversions/index";
import type { DataManagerDestination } from "../enhanced-conversions/data-manager-rest";
import { createPymeConsentSubjectId, SqlitePymeConsentRegistry } from "./consent-registry";
import { PymeEnhancedConversionProductionEngine, PymeEnhancedConversionsPrivacyLayer } from "./enhanced-conversions-privacy";

const dirs: string[] = [];
afterEach(() => { while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true }); });

const scope: OntologyScope = Object.freeze({ tenantId: "tenant-pyme", organizationId: "org-pyme", brandId: "brand-pyme" });
const destination: DataManagerDestination = Object.freeze({ operatingAccountId: "1234567890", conversionActionId: "9876543210" });

describe("CORTEX #30 PyME central privacy layer", () => {
  it("hashes identifiers, binds consent durably and blocks a revoked conversion at the final Data Manager boundary", async () => {
    const dir = mkdtempSync(join(tmpdir(), "nexus-pyme-conversion-")); dirs.push(dir);
    let now = Date.parse("2026-09-08T04:30:00.000Z");
    const registry = new SqlitePymeConsentRegistry(join(dir, "privacy.sqlite"), () => now);
    const subject = createPymeConsentSubjectId("EMAIL", "Test.User+campaign@gmail.com");
    registry.grant({ subjectId: subject, channel: "ENHANCED_CONVERSIONS", purpose: "ads_measurement", expectedRevision: 0, reasonCode: "EXPLICIT_OPT_IN", sourceRef: "lead-form-consent-0030", decidedAt: "2026-09-08T04:29:00.000Z" });
    const gateway: EnhancedConversionGateway = { ingestConversion: vi.fn(async () => ({ requestId: "data-manager-request-0030" })) };
    const layer = new PymeEnhancedConversionsPrivacyLayer({
      databasePath: join(dir, "privacy.sqlite"), transactions: new InMemoryOntologyTransactionStore(), scope, destination, gateway, modeProvider: () => "ACTIVE", consentRegistry: registry, now: () => now,
    });
    const prepared = layer.prepare(subject, {
      transactionId: "pyme-conversion-0030",
      eventTimestamp: "2026-09-08T04:29:30.000Z",
      eventName: "qualified_lead",
      eventSource: "WEB",
      adUserDataConsent: "GRANTED",
      gbraid: "gbraid-click-003000",
      emailAddresses: ["Test.User+campaign@gmail.com"],
    });
    expect(JSON.stringify(prepared)).not.toContain("Test.User");
    expect(prepared.event.userIdentifiers).toHaveLength(1);

    now = Date.parse("2026-09-08T04:30:30.000Z");
    registry.revoke({ subjectId: subject, channel: "ENHANCED_CONVERSIONS", purpose: "ads_measurement", expectedRevision: 1, reasonCode: "OPT_OUT", sourceRef: "privacy-center-0030", decidedAt: "2026-09-08T04:30:20.000Z" });
    await expect(layer.dispatch(prepared.transactionId)).rejects.toMatchObject({ code: "CONSENT_VIOLATION" });
    expect(layer.get(prepared.transactionId)?.status).toBe("PREPARED");
    expect(gateway.ingestConversion).not.toHaveBeenCalled();
    layer.close(); registry.close();
  });

  it("accepts the production envelope without exposing the consent subject in observation output", () => {
    const dir = mkdtempSync(join(tmpdir(), "nexus-pyme-conversion-")); dirs.push(dir);
    const registry = new SqlitePymeConsentRegistry(join(dir, "privacy.sqlite"));
    const subject = createPymeConsentSubjectId("OPAQUE", "customer-identity-3030");
    registry.grant({ subjectId: subject, channel: "ENHANCED_CONVERSIONS", purpose: "ads_measurement", expectedRevision: 0, reasonCode: "EXPLICIT_OPT_IN", sourceRef: "consent-source-3030", decidedAt: new Date(Date.now() - 1000).toISOString() });
    const layer = new PymeEnhancedConversionsPrivacyLayer({ databasePath: join(dir, "privacy.sqlite"), transactions: new InMemoryOntologyTransactionStore(), scope, destination, gateway: { ingestConversion: vi.fn(async () => ({ requestId: "unused-request" })) }, modeProvider: () => "ACTIVE", consentRegistry: registry });
    const engine = new PymeEnhancedConversionProductionEngine(layer);
    const envelope = { subjectId: subject, event: { transactionId: "pyme-envelope-3030", eventTimestamp: new Date().toISOString(), eventName: "lead", eventSource: "WEB", adUserDataConsent: "GRANTED", gclid: "gclid-click-303000" } };
    expect(engine.prepare(envelope).status).toBe("PREPARED");
    expect(JSON.stringify(engine.observe(envelope))).not.toContain(subject);
    engine.close(); registry.close();
  });

  it("refuses PyME preparation when the event itself declares denied ad-user-data consent", () => {
    const dir = mkdtempSync(join(tmpdir(), "nexus-pyme-conversion-")); dirs.push(dir);
    const registry = new SqlitePymeConsentRegistry(join(dir, "privacy.sqlite"));
    const subject = createPymeConsentSubjectId("OPAQUE", "customer-identity-0030");
    registry.grant({ subjectId: subject, channel: "ENHANCED_CONVERSIONS", purpose: "ads_measurement", expectedRevision: 0, reasonCode: "EXPLICIT_OPT_IN", sourceRef: "consent-source-0030", decidedAt: new Date(Date.now() - 1000).toISOString() });
    const layer = new PymeEnhancedConversionsPrivacyLayer({ databasePath: join(dir, "privacy.sqlite"), transactions: new InMemoryOntologyTransactionStore(), scope, destination, gateway: { ingestConversion: vi.fn(async () => ({ requestId: "unused-request" })) }, modeProvider: () => "ACTIVE", consentRegistry: registry });
    expect(() => layer.prepare(subject, { transactionId: "pyme-denied-0030", eventTimestamp: new Date().toISOString(), eventName: "lead", eventSource: "WEB", adUserDataConsent: "DENIED", gclid: "gclid-click-003000" })).toThrow(/GRANTED/u);
    layer.close(); registry.close();
  });
});
