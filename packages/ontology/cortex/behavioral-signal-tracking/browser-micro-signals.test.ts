import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { InMemoryOntologyTransactionStore } from "@nexus/ontology/transaction";
import { SqliteOntologyTransactionStore } from "@nexus/ontology/cortex/sqlite-transaction-store";
import { createBehavioralSignalPolicy, type CreateBehavioralSignalPolicyInput } from "./index";
import { BehavioralMicroInteractionTrackingEngine, type BehavioralMicroInteractionInput } from "./browser-micro-signals";

const scope = Object.freeze({ tenantId: "tenant-cortex", organizationId: "org-cortex", brandId: "brand-cortex" });
const NOW = Date.parse("2026-09-05T18:00:00.000Z");
const KEY = "behavioral-micro-test-key-material-64-bytes-minimum-xxxxxxxxxxxxx";

function policy(overrides: Partial<CreateBehavioralSignalPolicyInput> = {}) {
  return createBehavioralSignalPolicy({
    policyId: "behavioral-signals",
    version: "v2",
    pseudonymizationKeyId: "behavior-key-v1",
    allowedSurfaceIds: ["home", "pricing", "contact"],
    allowedElementIds: ["cta.primary", "nav.pricing", "form.contact"],
    maxEventAgeMs: 60_000,
    maxFutureSkewMs: 1_000,
    maxSessionDurationMs: 30_000,
    maxEventsPerSession: 32,
    maxEngagementMsPerEvent: 30_000,
    maxWriteRetries: 3,
    mode: "ACTIVE",
    ...overrides,
  });
}

function input(overrides: Partial<BehavioralMicroInteractionInput> = {}): BehavioralMicroInteractionInput {
  return {
    eventId: "micro-event-0001",
    sessionId: "micro-session-0001",
    siteId: "site-a",
    kind: "POINTER_ENTER",
    occurredAt: new Date(NOW - 500).toISOString(),
    surfaceId: "home",
    elementId: "cta.primary",
    collectionAllowed: true,
    privacyDecisionRef: "decision-v1",
    ...overrides,
  };
}

function engine(store = new InMemoryOntologyTransactionStore(), policyValue = policy()) {
  return { store, tracker: new BehavioralMicroInteractionTrackingEngine(store, scope, policyValue, { pseudonymizationKey: KEY }, () => NOW) };
}

describe("BehavioralMicroInteractionTrackingEngine", () => {
  it("records reading pauses, cursor/pointer intent and touch microinteractions as bounded aggregates", () => {
    const { tracker, store } = engine();
    tracker.ingest(input({ eventId: "micro-read-0001", kind: "READING_PAUSE", elementId: null, durationMs: 1_200 }));
    tracker.ingest(input({ eventId: "micro-pointer-01", kind: "POINTER_ENTER" }));
    tracker.ingest(input({ eventId: "micro-pointer-02", kind: "POINTER_DOWN" }));
    tracker.ingest(input({ eventId: "micro-touch-001", kind: "TOUCH_START" }));
    tracker.ingest(input({ eventId: "micro-touch-002", kind: "TOUCH_END" }));

    expect(tracker.getSessionSnapshot("site-a", "micro-session-0001")).toMatchObject({
      eventCount: 5,
      totalReadingPauseMs: 1_200,
      counts: { READING_PAUSE: 1, POINTER_ENTER: 1, POINTER_DOWN: 1, TOUCH_START: 1, TOUCH_END: 1 },
    });
    expect(tracker.getSiteSnapshot("site-a")).toMatchObject({ eventCount: 5, sessionCount: 1, totalReadingPauseMs: 1_200 });
    expect(store.checkpoint().objects).toHaveLength(2);
  });

  it("never accepts or persists coordinates, pressure, pointer identity, touch count or raw behavioral identifiers", () => {
    const { tracker, store } = engine();
    const raw = input({ eventId: "micro-private-01", sessionId: "micro-private-session", privacyDecisionRef: "privacy-ticket-001" });
    tracker.ingest(raw);
    const checkpoint = JSON.stringify(store.checkpoint());
    expect(checkpoint).not.toContain(raw.eventId);
    expect(checkpoint).not.toContain(raw.sessionId);
    expect(checkpoint).not.toContain(raw.privacyDecisionRef);
    expect(checkpoint).toContain("hmac-sha256:");

    for (const forbidden of [
      { clientX: 200 },
      { clientY: 300 },
      { pressure: 0.7 },
      { pointerId: 44 },
      { touchCount: 2 },
      { userAgent: "browser" },
    ]) {
      expect(() => tracker.ingest({ ...input({ eventId: `micro-forbid-${Object.keys(forbidden)[0]}` }), ...forbidden } as unknown as BehavioralMicroInteractionInput)).toThrow(/unsupported field/);
    }
    expect(tracker.getSiteSnapshot("site-a")?.eventCount).toBe(1);
  });

  it("is idempotent, conflict-detecting and fail-closed for privacy and operational modes", () => {
    const { tracker } = engine();
    expect(tracker.ingest(input()).status).toBe("RECORDED");
    expect(tracker.ingest(input()).status).toBe("DUPLICATE");
    expect(() => tracker.ingest(input({ surfaceId: "pricing" }))).toThrow(/different content/);

    const denied = engine();
    expect(denied.tracker.ingest(input({ collectionAllowed: false, privacyDecisionRef: null })).reason).toBe("PRIVACY_DENIED");
    expect(denied.store.checkpoint().objects).toHaveLength(0);

    const observed = engine();
    expect(observed.tracker.ingest(input({ mode: "OBSERVE_ONLY" })).status).toBe("OBSERVED");
    expect(observed.store.checkpoint().objects).toHaveLength(0);

    const killed = engine(new InMemoryOntologyTransactionStore(), policy({ mode: "KILLED" }));
    expect(killed.tracker.ingest(input({ mode: "ACTIVE" })).reason).toBe("KILL_SWITCH");
    expect(killed.store.checkpoint().objects).toHaveLength(0);
  });

  it("enforces allowlists, signal shape, freshness, duration and session capacity", () => {
    const { tracker } = engine();
    expect(() => tracker.ingest(input({ eventId: "micro-bad-0001", surfaceId: "customer-person" }))).toThrow(/not allowlisted/);
    expect(() => tracker.ingest(input({ eventId: "micro-bad-0002", elementId: null }))).toThrow(/elementId is required/);
    expect(() => tracker.ingest(input({ eventId: "micro-bad-0003", durationMs: 10 }))).toThrow(/durationMs is allowed only/);
    expect(() => tracker.ingest(input({ eventId: "micro-bad-0004", kind: "READING_PAUSE", elementId: null }))).toThrow(/durationMs is required/);
    expect(() => tracker.ingest(input({ eventId: "micro-bad-0005", occurredAt: new Date(NOW - 60_001).toISOString() }))).toThrow(/older than/);
    expect(() => tracker.ingest(input({ eventId: "micro-bad-0006", occurredAt: new Date(NOW + 1_001).toISOString() }))).toThrow(/future/);

    const capped = engine(new InMemoryOntologyTransactionStore(), policy({ maxEventsPerSession: 2 }));
    capped.tracker.ingest(input({ eventId: "micro-cap-0001" }));
    capped.tracker.ingest(input({ eventId: "micro-cap-0002", kind: "POINTER_DOWN" }));
    expect(() => capped.tracker.ingest(input({ eventId: "micro-cap-0003", kind: "TOUCH_START" }))).toThrow(/maxEventsPerSession/);
  });

  it("survives a durable SQLite close/reopen with exact replay idempotency", () => {
    const dir = mkdtempSync(join(tmpdir(), "nexus-behavioral-micro-"));
    const db = join(dir, "micro.sqlite");
    try {
      const first = new SqliteOntologyTransactionStore(db);
      const firstTracker = new BehavioralMicroInteractionTrackingEngine(first, scope, policy(), { pseudonymizationKey: KEY }, () => NOW);
      expect(firstTracker.ingest(input()).status).toBe("RECORDED");
      first.close();

      const reopened = new SqliteOntologyTransactionStore(db);
      const secondTracker = new BehavioralMicroInteractionTrackingEngine(reopened, scope, policy(), { pseudonymizationKey: KEY }, () => NOW);
      expect(secondTracker.ingest(input()).status).toBe("DUPLICATE");
      expect(secondTracker.getSiteSnapshot("site-a")?.eventCount).toBe(1);
      reopened.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("passes an adversarial bounded multi-session accounting simulation", () => {
    const { tracker } = engine();
    let expectedPause = 0;
    for (let session = 0; session < 20; session += 1) {
      for (let eventIndex = 0; eventIndex < 10; eventIndex += 1) {
        const reading = eventIndex % 5 === 0;
        const durationMs = reading ? 250 + eventIndex : null;
        expectedPause += durationMs ?? 0;
        tracker.ingest(input({
          eventId: `micro-${session.toString().padStart(2, "0")}-${eventIndex.toString().padStart(2, "0")}`,
          sessionId: `micro-session-${session.toString().padStart(4, "0")}`,
          kind: reading ? "READING_PAUSE" : eventIndex % 2 === 0 ? "TOUCH_START" : "POINTER_ENTER",
          elementId: reading ? null : "cta.primary",
          durationMs,
          occurredAt: new Date(NOW - 20_000 + session * 100 + eventIndex).toISOString(),
        }));
      }
    }
    expect(tracker.getSiteSnapshot("site-a")).toMatchObject({ eventCount: 200, sessionCount: 20, totalReadingPauseMs: expectedPause });
  });
});
