import { describe, expect, it } from "vitest";
import { InMemoryOntologyTransactionStore } from "@nexus/ontology/transaction";
import { createBehavioralSignalPolicy } from "./index";
import { CortexBehavioralSignalSuite } from "./suite";

const scope = Object.freeze({ tenantId: "tenant-cortex", organizationId: "org-cortex", brandId: "brand-cortex" });
const NOW = Date.parse("2026-09-05T18:00:00.000Z");
const KEY = "behavioral-suite-test-key-material-64-bytes-minimum-xxxxxxxxxxxxx";

function policy() {
  return createBehavioralSignalPolicy({
    policyId: "behavioral-suite",
    version: "v1",
    pseudonymizationKeyId: "behavior-key-v1",
    allowedSurfaceIds: ["home"],
    allowedElementIds: ["cta.primary"],
    maxEventAgeMs: 60_000,
    maxFutureSkewMs: 1_000,
    maxSessionDurationMs: 30_000,
    maxEventsPerSession: 32,
    maxEngagementMsPerEvent: 30_000,
    maxWriteRetries: 3,
    mode: "ACTIVE",
  });
}

describe("CortexBehavioralSignalSuite", () => {
  it("connects generic behavioral facts and privacy-safe browser micro-signals through one governed production entry point", () => {
    const store = new InMemoryOntologyTransactionStore();
    const suite = new CortexBehavioralSignalSuite(store, scope, policy(), { pseudonymizationKey: KEY }, () => NOW);

    expect(suite.ingest({
      eventId: "base-event-0001",
      sessionId: "shared-session-0001",
      siteId: "site-a",
      kind: "SCROLL_DEPTH",
      occurredAt: new Date(NOW - 500).toISOString(),
      surfaceId: "home",
      scrollDepthPercent: 75,
      collectionAllowed: true,
      privacyDecisionRef: "decision-v1",
    }).status).toBe("RECORDED");

    expect(suite.ingestMicroInteraction({
      eventId: "micro-event-0001",
      sessionId: "shared-session-0001",
      siteId: "site-a",
      kind: "POINTER_ENTER",
      occurredAt: new Date(NOW - 400).toISOString(),
      surfaceId: "home",
      elementId: "cta.primary",
      collectionAllowed: true,
      privacyDecisionRef: "decision-v1",
    }).status).toBe("RECORDED");

    expect(suite.ingestMicroInteraction({
      eventId: "micro-event-0002",
      sessionId: "shared-session-0001",
      siteId: "site-a",
      kind: "READING_PAUSE",
      occurredAt: new Date(NOW - 300).toISOString(),
      surfaceId: "home",
      elementId: null,
      durationMs: 900,
      collectionAllowed: true,
      privacyDecisionRef: "decision-v1",
    }).status).toBe("RECORDED");

    expect(suite.getSessionSnapshot("site-a", "shared-session-0001")).toMatchObject({ eventCount: 1, maxScrollDepthPercent: 75 });
    expect(suite.getMicroSessionSnapshot("site-a", "shared-session-0001")).toMatchObject({ eventCount: 2, totalReadingPauseMs: 900 });
    expect(store.checkpoint().objects).toHaveLength(4);
  });
});
