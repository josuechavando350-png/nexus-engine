import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { InMemoryOntologyTransactionStore } from "@nexus/ontology/transaction";
import { SqliteOntologyTransactionStore } from "@nexus/ontology/cortex/sqlite-transaction-store";
import {
  BehavioralSignalError,
  BehavioralSignalTrackingEngine,
  createBehavioralSignalPolicy,
  type BehavioralSignalEventInput,
  type CreateBehavioralSignalPolicyInput,
} from "./index";

const scope = Object.freeze({ tenantId: "tenant-cortex", organizationId: "org-cortex", brandId: "brand-cortex" });
const NOW = Date.parse("2026-09-05T15:00:00.000Z");
const KEY = "behavioral-signal-test-key-material-64-bytes-minimum-xxxxxxxxxxxx";

function policy(overrides: Partial<CreateBehavioralSignalPolicyInput> = {}) {
  return createBehavioralSignalPolicy({
    policyId: "behavioral-signals",
    version: "v1",
    pseudonymizationKeyId: "behavior-key-v1",
    allowedSurfaceIds: ["home", "pricing", "contact"],
    allowedElementIds: ["cta.primary", "form.contact", "form.quote"],
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

function event(overrides: Partial<BehavioralSignalEventInput> = {}): BehavioralSignalEventInput {
  return {
    eventId: "event-0001",
    sessionId: "session-0001",
    siteId: "site-a",
    kind: "PAGE_VIEW",
    occurredAt: new Date(NOW - 1_000).toISOString(),
    surfaceId: "home",
    collectionAllowed: true,
    privacyDecisionRef: "decision-v1",
    ...overrides,
  };
}

function engine(options: {
  readonly store?: InMemoryOntologyTransactionStore;
  readonly policyInput?: Partial<CreateBehavioralSignalPolicyInput>;
  readonly onTelemetry?: ConstructorParameters<typeof BehavioralSignalTrackingEngine>[5];
  readonly onTelemetryError?: ConstructorParameters<typeof BehavioralSignalTrackingEngine>[6];
} = {}) {
  const store = options.store ?? new InMemoryOntologyTransactionStore();
  const tracker = new BehavioralSignalTrackingEngine(store, scope, policy(options.policyInput), { pseudonymizationKey: KEY }, () => NOW, options.onTelemetry, options.onTelemetryError);
  return { store, tracker };
}

describe("BehavioralSignalTrackingEngine", () => {
  it("records bounded behavioral facts and deterministic session/site aggregates", () => {
    const { tracker, store } = engine();
    expect(tracker.ingest(event()).status).toBe("RECORDED");
    expect(tracker.ingest(event({ eventId: "event-0002", kind: "CTA_CLICK", elementId: "cta.primary", occurredAt: new Date(NOW - 800).toISOString() })).status).toBe("RECORDED");
    expect(tracker.ingest(event({ eventId: "event-0003", kind: "ENGAGEMENT", engagementMs: 1_500, occurredAt: new Date(NOW - 600).toISOString() })).status).toBe("RECORDED");
    expect(tracker.ingest(event({ eventId: "event-0004", kind: "SCROLL_DEPTH", scrollDepthPercent: 80, occurredAt: new Date(NOW - 400).toISOString() })).status).toBe("RECORDED");
    expect(tracker.ingest(event({ eventId: "event-0005", kind: "FORM_START", elementId: "form.contact", surfaceId: "contact", occurredAt: new Date(NOW - 200).toISOString() })).status).toBe("RECORDED");
    expect(tracker.ingest(event({ eventId: "event-0006", kind: "FORM_SUBMIT", elementId: "form.contact", surfaceId: "contact", occurredAt: new Date(NOW - 100).toISOString() })).status).toBe("RECORDED");

    const session = tracker.getSessionSnapshot("site-a", "session-0001");
    expect(session).toMatchObject({
      eventCount: 6,
      totalEngagementMs: 1_500,
      maxScrollDepthPercent: 80,
      lastSurfaceId: "contact",
      lastEventKind: "FORM_SUBMIT",
    });
    expect(session?.counts).toMatchObject({ PAGE_VIEW: 1, CTA_CLICK: 1, ENGAGEMENT: 1, SCROLL_DEPTH: 1, FORM_START: 1, FORM_SUBMIT: 1 });

    const site = tracker.getSiteSnapshot("site-a");
    expect(site).toMatchObject({ eventCount: 6, sessionCount: 1, totalEngagementMs: 1_500, maxScrollDepthPercent: 80 });
    expect(site?.counts.FORM_SUBMIT).toBe(1);
    expect(store.checkpoint().objects).toHaveLength(2);
  });

  it("never persists raw session/event/privacy identifiers and rejects undeclared fields", () => {
    const { tracker, store } = engine();
    const raw = event({ eventId: "event-private-001", sessionId: "session-private-001", privacyDecisionRef: "privacy-ticket-001" });
    tracker.ingest(raw);
    const checkpoint = JSON.stringify(store.checkpoint());
    expect(checkpoint).not.toContain(raw.eventId);
    expect(checkpoint).not.toContain(raw.sessionId);
    expect(checkpoint).not.toContain(raw.privacyDecisionRef);
    expect(checkpoint).toContain("hmac-sha256:");

    const withEmail = { ...event({ eventId: "event-private-002" }), email: "person@example.com" } as unknown as BehavioralSignalEventInput;
    expect(() => tracker.ingest(withEmail)).toThrow(/unsupported field email/);
    expect(tracker.getSiteSnapshot("site-a")?.eventCount).toBe(1);

    expect(() => tracker.ingest(event({ eventId: "event-private-003", surfaceId: "customer-john" }))).toThrow(/not allowlisted/);
    expect(tracker.getSiteSnapshot("site-a")?.eventCount).toBe(1);
  });

  it("is idempotent and rejects conflicting eventId replays", () => {
    const { tracker } = engine();
    const first = tracker.ingest(event());
    expect(first.status).toBe("RECORDED");
    const replay = tracker.ingest(event());
    expect(replay.status).toBe("DUPLICATE");
    expect(replay.eventDigest).toBe(first.eventDigest);
    expect(replay.site?.eventCount).toBe(1);

    expect(() => tracker.ingest(event({ surfaceId: "pricing" }))).toThrow(BehavioralSignalError);
    expect(() => tracker.ingest(event({ surfaceId: "pricing" }))).toThrow(/different content/);
    expect(tracker.getSiteSnapshot("site-a")?.eventCount).toBe(1);
  });

  it("fails closed for denied collection and enforces restrictive modes without persistence", () => {
    const denied = engine();
    expect(denied.tracker.ingest(event({ collectionAllowed: false, privacyDecisionRef: null })).reason).toBe("PRIVACY_DENIED");
    expect(denied.store.checkpoint().objects).toHaveLength(0);

    const observed = engine();
    const observation = observed.tracker.ingest(event({ mode: "OBSERVE_ONLY" }));
    expect(observation.status).toBe("OBSERVED");
    expect(observation.eventDigest).toMatch(/^sha256:/);
    expect(observed.store.checkpoint().objects).toHaveLength(0);

    const killed = engine({ policyInput: { mode: "KILLED" } });
    expect(killed.tracker.ingest(event({ mode: "ACTIVE" })).reason).toBe("KILL_SWITCH");
    expect(killed.store.checkpoint().objects).toHaveLength(0);

    const policyObserved = engine({ policyInput: { mode: "OBSERVE_ONLY" } });
    expect(policyObserved.tracker.ingest(event({ mode: "ACTIVE" })).status).toBe("OBSERVED");
    expect(policyObserved.store.checkpoint().objects).toHaveLength(0);
  });

  it("enforces event shape, freshness, session duration, and per-session capacity", () => {
    const strict = engine({ policyInput: { maxSessionDurationMs: 2_000, maxEventsPerSession: 2 } });
    expect(() => strict.tracker.ingest(event({ eventId: "event-shape-01", kind: "CTA_CLICK" }))).toThrow(/elementId is required/);
    expect(() => strict.tracker.ingest(event({ eventId: "event-shape-02", elementId: "cta.primary" }))).toThrow(/elementId is required only/);
    expect(() => strict.tracker.ingest(event({ eventId: "event-shape-03", kind: "ENGAGEMENT" }))).toThrow(/engagementMs is required/);
    expect(() => strict.tracker.ingest(event({ eventId: "event-shape-04", kind: "SCROLL_DEPTH", scrollDepthPercent: 101 }))).toThrow(/scrollDepthPercent/);
    expect(() => strict.tracker.ingest(event({ eventId: "event-stale-01", occurredAt: new Date(NOW - 60_001).toISOString() }))).toThrow(/older than/);
    expect(() => strict.tracker.ingest(event({ eventId: "event-future-01", occurredAt: new Date(NOW + 1_001).toISOString() }))).toThrow(/future/);

    strict.tracker.ingest(event({ eventId: "event-cap-0001", occurredAt: new Date(NOW - 3_000).toISOString() }));
    expect(() => strict.tracker.ingest(event({ eventId: "event-cap-0002", occurredAt: new Date(NOW).toISOString() }))).toThrow(/session exceeded maxSessionDurationMs/);

    const capped = engine({ policyInput: { maxEventsPerSession: 2 } });
    capped.tracker.ingest(event({ eventId: "event-cap-1001" }));
    capped.tracker.ingest(event({ eventId: "event-cap-1002", kind: "NAVIGATION", occurredAt: new Date(NOW - 500).toISOString() }));
    expect(() => capped.tracker.ingest(event({ eventId: "event-cap-1003", occurredAt: new Date(NOW - 200).toISOString() }))).toThrow(/maxEventsPerSession/);
    expect(capped.tracker.getSiteSnapshot("site-a")?.eventCount).toBe(2);
  });

  it("produces the same aggregate digest for out-of-order delivery", () => {
    const left = engine();
    const right = engine();
    const first = event({ eventId: "event-order-a", kind: "PAGE_VIEW", occurredAt: new Date(NOW - 500).toISOString(), surfaceId: "home" });
    const second = event({ eventId: "event-order-b", kind: "NAVIGATION", occurredAt: new Date(NOW - 500).toISOString(), surfaceId: "pricing" });

    left.tracker.ingest(first);
    left.tracker.ingest(second);
    right.tracker.ingest(second);
    right.tracker.ingest(first);

    expect(left.tracker.getSessionSnapshot("site-a", "session-0001")?.digest).toBe(right.tracker.getSessionSnapshot("site-a", "session-0001")?.digest);
    expect(left.tracker.getSiteSnapshot("site-a")?.digest).toBe(right.tracker.getSiteSnapshot("site-a")?.digest);
  });

  it("persists idempotency and aggregates across SQLite restart", () => {
    const directory = mkdtempSync(join(tmpdir(), "nexus-behavioral-"));
    const path = join(directory, "state.sqlite");
    try {
      const firstStore = new SqliteOntologyTransactionStore(path);
      const first = new BehavioralSignalTrackingEngine(firstStore, scope, policy(), { pseudonymizationKey: KEY }, () => NOW);
      first.ingest(event());
      first.ingest(event({ eventId: "event-sqlite-02", kind: "ENGAGEMENT", engagementMs: 2_000 }));
      firstStore.close();

      const secondStore = new SqliteOntologyTransactionStore(path);
      const second = new BehavioralSignalTrackingEngine(secondStore, scope, policy(), { pseudonymizationKey: KEY }, () => NOW);
      expect(second.getSessionSnapshot("site-a", "session-0001")).toMatchObject({ eventCount: 2, totalEngagementMs: 2_000 });
      expect(second.getSiteSnapshot("site-a")).toMatchObject({ eventCount: 2, sessionCount: 1 });
      expect(second.ingest(event()).status).toBe("DUPLICATE");
      expect(second.getSiteSnapshot("site-a")?.eventCount).toBe(2);
      secondStore.close();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("isolates telemetry failures from committed ingestion", () => {
    const telemetryErrors: unknown[] = [];
    const { tracker } = engine({
      onTelemetry: () => {
        throw new Error("sink unavailable");
      },
      onTelemetryError: (error) => telemetryErrors.push(error),
    });
    expect(tracker.ingest(event()).status).toBe("RECORDED");
    expect(telemetryErrors).toHaveLength(1);
    expect(tracker.getSiteSnapshot("site-a")?.eventCount).toBe(1);
  });

  it("survives an adversarial multi-session accounting simulation", () => {
    const { tracker } = engine({ policyInput: { maxEventsPerSession: 16 } });
    for (let session = 0; session < 50; session += 1) {
      const sessionId = `session-sim-${String(session).padStart(3, "0")}`;
      const kinds = ["PAGE_VIEW", "CTA_CLICK", "FORM_START", "FORM_SUBMIT", "FORM_ERROR", "SCROLL_DEPTH", "ENGAGEMENT", "NAVIGATION"] as const;
      kinds.forEach((kind, index) => {
        const common = {
          eventId: `event-sim-${String(session).padStart(3, "0")}-${String(index).padStart(2, "0")}`,
          sessionId,
          kind,
          occurredAt: new Date(NOW - 2_000 + index * 100).toISOString(),
        };
        if (kind === "CTA_CLICK") tracker.ingest(event({ ...common, elementId: "cta.primary" }));
        else if (kind === "FORM_START" || kind === "FORM_SUBMIT" || kind === "FORM_ERROR") tracker.ingest(event({ ...common, elementId: "form.contact", surfaceId: "contact" }));
        else if (kind === "SCROLL_DEPTH") tracker.ingest(event({ ...common, scrollDepthPercent: 90 }));
        else if (kind === "ENGAGEMENT") tracker.ingest(event({ ...common, engagementMs: 1_000 }));
        else tracker.ingest(event(common));
      });
    }

    const site = tracker.getSiteSnapshot("site-a");
    expect(site).toMatchObject({ eventCount: 400, sessionCount: 50, totalEngagementMs: 50_000, maxScrollDepthPercent: 90 });
    for (const kind of ["PAGE_VIEW", "CTA_CLICK", "FORM_START", "FORM_SUBMIT", "FORM_ERROR", "SCROLL_DEPTH", "ENGAGEMENT", "NAVIGATION"] as const) expect(site?.counts[kind]).toBe(50);

    expect(tracker.ingest(event({ eventId: "event-sim-000-00", sessionId: "session-sim-000", kind: "PAGE_VIEW", occurredAt: new Date(NOW - 2_000).toISOString() })).status).toBe("DUPLICATE");
    expect(tracker.getSiteSnapshot("site-a")?.eventCount).toBe(400);
  });
});
