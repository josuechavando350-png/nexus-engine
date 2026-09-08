import { describe, expect, it } from "vitest";
import { InMemoryOntologyTransactionStore } from "@nexus/ontology/transaction";
import { createBehavioralSignalPolicy } from "./index";
import { CortexBehavioralSignalRuntime } from "./runtime";
import {
  PrivacyIsolatedBehavioralSignalAdapter,
  PrivacyIsolationKeyLifecycle,
  PrivacyIsolationSessionService,
  PrivacyRetainingTransactionPort,
  createPrivacyIsolationPolicy,
} from "./privacy-isolation";

const NOW = Date.parse("2026-09-07T05:00:00.000Z");
const SITE = "site-main";
const scope = { tenantId: "tenant-privacy-isolation", organizationId: "org-privacy-isolation" } as const;
const trackerKey = "tracker-pseudonymization-key-000000000000000000000000";
const keyOne = "privacy-isolation-key-one-00000000000000000000000000";
const keyTwo = "privacy-isolation-key-two-00000000000000000000000000";

function behavioralPolicy() {
  return createBehavioralSignalPolicy({
    policyId: "privacy-isolated-signals",
    version: "v1",
    pseudonymizationKeyId: "tracker-key-v1",
    allowedSurfaceIds: ["home"],
    allowedElementIds: ["hero-cta"],
    maxEventAgeMs: 60_000,
    maxFutureSkewMs: 5_000,
    maxSessionDurationMs: 30 * 60_000,
    maxEventsPerSession: 32,
    maxEngagementMsPerEvent: 60_000,
    maxWriteRetries: 3,
    mode: "ACTIVE",
  });
}

function privacyPolicy(overrides: Partial<Parameters<typeof createPrivacyIsolationPolicy>[0]> = {}) {
  return createPrivacyIsolationPolicy({
    version: 1,
    sessionTtlMs: 15 * 60_000,
    aggregateRetentionMs: 60 * 60_000,
    retentionSweepIntervalMs: 10_000,
    maxTrackedSessionsPerSite: 32,
    maxActiveKeyAgeMs: 24 * 60 * 60_000,
    allowedSiteIds: [SITE],
    ...overrides,
  });
}

function harness(options: { maxTrackedSessionsPerSite?: number } = {}) {
  let now = NOW;
  let nonce = 0;
  const raw = new InMemoryOntologyTransactionStore();
  const policy = privacyPolicy({ ...(options.maxTrackedSessionsPerSite === undefined ? {} : { maxTrackedSessionsPerSite: options.maxTrackedSessionsPerSite }) });
  const lifecycle = new PrivacyIsolationKeyLifecycle(raw, scope, policy, {
    version: 1,
    bootstrapActiveKeyId: "privacy-key-v1",
    keys: [
      { keyId: "privacy-key-v1", key: keyOne },
      { keyId: "privacy-key-v2", key: keyTwo },
    ],
  }, () => now);
  const retaining = new PrivacyRetainingTransactionPort(raw, scope, policy, () => now);
  const runtime = new CortexBehavioralSignalRuntime(raw === retaining ? raw : retaining, scope, behavioralPolicy(), { pseudonymizationKey: trackerKey }, () => now);
  const sessions = new PrivacyIsolationSessionService({
    keyLifecycle: lifecycle,
    now: () => now,
    random: () => {
      nonce += 1;
      return Buffer.from(nonce.toString(16).padStart(32, "0"), "hex");
    },
  });
  const adapter = new PrivacyIsolatedBehavioralSignalAdapter(runtime, sessions, retaining);
  return {
    raw,
    policy,
    lifecycle,
    retaining,
    runtime,
    sessions,
    adapter,
    now: () => now,
    advance: (ms: number) => { now += ms; },
  };
}

function event(sessionToken: string, occurredAt = NOW) {
  return {
    eventId: "browser-event-reused-0001",
    sessionToken,
    siteId: SITE,
    kind: "CTA_CLICK" as const,
    occurredAt: new Date(occurredAt).toISOString(),
    surfaceId: "home",
    elementId: "hero-cta",
  };
}

describe("CORTEX #26 behavioral privacy isolation", () => {
  it("isolates browser identifiers and consent references per server-issued session without persisting secrets", () => {
    const h = harness();
    const firstToken = h.sessions.issue(SITE, "consent-decision-reused-0001", true);
    const first = h.adapter.ingest(event(firstToken));
    expect(first.status).toBe("RECORDED");

    h.advance(1_000);
    const secondToken = h.sessions.issue(SITE, "consent-decision-reused-0001", true);
    const second = h.adapter.ingest(event(secondToken, h.now()));
    expect(second.status).toBe("RECORDED");
    expect(first.session?.sessionKey).not.toBe(second.session?.sessionKey);
    expect(second.site?.sessionCount).toBe(2);

    const persisted = JSON.stringify(h.raw.checkpoint());
    expect(persisted).not.toContain("browser-event-reused-0001");
    expect(persisted).not.toContain("consent-decision-reused-0001");
    expect(persisted).not.toContain(firstToken);
    expect(persisted).not.toContain(secondToken);
    expect(persisted).not.toContain(keyOne);
    expect(persisted).not.toContain(keyTwo);
  });

  it("binds collection approval at the trusted session boundary and rejects browser consent assertions", () => {
    const h = harness();
    expect(() => h.sessions.issue(SITE, "consent-decision-denied-0001", false)).toThrowError(/denied/u);
    const token = h.sessions.issue(SITE, "consent-decision-allowed-0001", true);
    const attemptedOverride = { ...event(token), collectionAllowed: true, privacyDecisionRef: "browser-self-asserted-consent" };
    expect(() => h.adapter.ingest(attemptedOverride as never)).toThrowError(/unsupported field/u);
    expect(h.raw.checkpoint().objects.filter((record) => record.typeId.includes("behavioral_signal_session"))).toHaveLength(0);
  });

  it("tracks BASE and MICRO aggregates atomically and purges the whole site retention window", () => {
    const h = harness();
    const token = h.sessions.issue(SITE, "consent-decision-retention-0001", true);
    expect(h.adapter.ingest(event(token)).status).toBe("RECORDED");
    expect(h.adapter.ingestMicroInteraction({
      eventId: "micro-event-0001",
      sessionToken: token,
      siteId: SITE,
      kind: "POINTER_DOWN",
      occurredAt: new Date(NOW).toISOString(),
      surfaceId: "home",
      elementId: "hero-cta",
    }).status).toBe("RECORDED");

    const before = h.raw.checkpoint().objects;
    expect(before.some((record) => record.typeId === "cortex.behavioral_privacy_retention_index")).toBe(true);
    expect(before.some((record) => record.typeId === "cortex.behavioral_signal_session")).toBe(true);
    expect(before.some((record) => record.typeId === "cortex.behavioral_micro_signal_session")).toBe(true);

    h.advance(h.policy.aggregateRetentionMs);
    const swept = h.retaining.sweepAll();
    expect(swept.purgedSites).toBe(1);
    const after = h.raw.checkpoint().objects;
    expect(after.some((record) => record.typeId === "cortex.behavioral_privacy_retention_index")).toBe(false);
    expect(after.some((record) => record.typeId === "cortex.behavioral_signal_session" || record.typeId === "cortex.behavioral_signal_site")).toBe(false);
    expect(after.some((record) => record.typeId === "cortex.behavioral_micro_signal_session" || record.typeId === "cortex.behavioral_micro_signal_site")).toBe(false);
    expect(after.some((record) => record.typeId === "cortex.behavioral_privacy_key_control")).toBe(true);
    expect(after.some((record) => record.typeId === "cortex.behavioral_signal_runtime_control")).toBe(true);
  });

  it("rotates privacy keys with token grace, rejects expired old epochs, and retires only after grace", () => {
    const h = harness();
    const oldToken = h.sessions.issue(SITE, "consent-decision-rotate-0001", true);
    const before = h.lifecycle.controlState();
    const rotated = h.lifecycle.activate("privacy-key-v2", before.digest);
    expect(rotated.activeKeyId).toBe("privacy-key-v2");
    expect(() => h.lifecycle.retire("privacy-key-v1", rotated.digest)).toThrowError(/before all tokens/u);
    expect(h.adapter.ingest(event(oldToken)).status).toBe("RECORDED");

    h.advance(h.policy.sessionTtlMs);
    expect(() => h.sessions.verify(oldToken, SITE)).toThrowError(/grace|valid/u);
    const retired = h.lifecycle.retire("privacy-key-v1", h.lifecycle.controlState().digest);
    expect(retired.previous.some((epoch) => epoch.keyId === "privacy-key-v1")).toBe(false);

    const newToken = h.sessions.issue(SITE, "consent-decision-rotate-0002", true);
    expect(newToken).not.toBe(oldToken);
  });

  it("fails closed on legacy behavioral state that predates the retention index", () => {
    let now = NOW;
    const raw = new InMemoryOntologyTransactionStore();
    const legacy = new CortexBehavioralSignalRuntime(raw, scope, behavioralPolicy(), { pseudonymizationKey: trackerKey }, () => now);
    expect(legacy.ingest({
      eventId: "legacy-event-0001",
      sessionId: "legacy-session-0001",
      siteId: SITE,
      kind: "CTA_CLICK",
      occurredAt: new Date(now).toISOString(),
      surfaceId: "home",
      elementId: "hero-cta",
      collectionAllowed: true,
      privacyDecisionRef: "legacy-consent-0001",
    }).status).toBe("RECORDED");
    const retaining = new PrivacyRetainingTransactionPort(raw, scope, privacyPolicy(), () => now);
    expect(() => retaining.sweepAll()).toThrowError(/created before CORTEX #26/u);
    now += 1;
  });

  it("refuses a new session before persistence when the durable retention index capacity is exhausted", () => {
    const h = harness({ maxTrackedSessionsPerSite: 1 });
    const first = h.sessions.issue(SITE, "consent-capacity-0001", true);
    expect(h.adapter.ingest(event(first)).status).toBe("RECORDED");
    const before = JSON.stringify(h.raw.checkpoint());

    h.advance(1_000);
    const second = h.sessions.issue(SITE, "consent-capacity-0002", true);
    expect(() => h.adapter.ingest(event(second, h.now()))).toThrowError(/capacity/u);
    const after = h.raw.checkpoint();
    const sessions = after.objects.filter((record) => record.typeId === "cortex.behavioral_signal_session");
    expect(sessions).toHaveLength(1);
    expect(JSON.stringify(after)).toBe(before);
  });
});
