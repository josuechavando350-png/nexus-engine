import { afterEach, describe, expect, it } from "vitest";
import { InMemoryOntologyTransactionStore } from "@nexus/ontology/transaction";
import { createBehavioralSignalPolicy } from "./index";
import { CortexBehavioralSignalRuntime } from "./runtime";
import {
  PrivacyIsolationKeyLifecycle,
  PrivacyIsolationSessionService,
  PrivacyRetainingTransactionPort,
  createPrivacyIsolationPolicy,
} from "./privacy-isolation";
import { createPrivacyIsolationProductionServer, type PrivacyIsolationProductionServer } from "./privacy-isolation-production-server";

const NOW = Date.parse("2026-09-07T05:00:00.000Z");
const ORIGIN = "https://site.example";
const SITE = "site-main";
const INGEST = "ingest-token-000000000000000000000000000000";
const CONTROL = "control-token-00000000000000000000000000000";
const TRACKER = "tracker-key-0000000000000000000000000000000000";
const KEY_ONE = "privacy-http-key-one-000000000000000000000000000000";
const KEY_TWO = "privacy-http-key-two-000000000000000000000000000000";
const servers: PrivacyIsolationProductionServer[] = [];

afterEach(async () => {
  for (const server of servers.splice(0)) await server.close();
});

async function listen(server: PrivacyIsolationProductionServer): Promise<string> {
  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.server.once("error", reject);
    server.server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.server.address();
  if (!address || typeof address === "string") throw new Error("test server did not expose a TCP address");
  return `http://127.0.0.1:${address.port}`;
}

function harness() {
  let now = NOW;
  const store = new InMemoryOntologyTransactionStore();
  const scope = { tenantId: "tenant-private-http", organizationId: "org-private-http" } as const;
  const privacyPolicy = createPrivacyIsolationPolicy({
    version: 1,
    sessionTtlMs: 15 * 60_000,
    aggregateRetentionMs: 60 * 60_000,
    retentionSweepIntervalMs: 10_000,
    maxTrackedSessionsPerSite: 32,
    maxActiveKeyAgeMs: 24 * 60 * 60_000,
    allowedSiteIds: [SITE],
  });
  const keyLifecycle = new PrivacyIsolationKeyLifecycle(store, scope, privacyPolicy, {
    version: 1,
    bootstrapActiveKeyId: "privacy-key-v1",
    keys: [{ keyId: "privacy-key-v1", key: KEY_ONE }, { keyId: "privacy-key-v2", key: KEY_TWO }],
  }, () => now);
  const retention = new PrivacyRetainingTransactionPort(store, scope, privacyPolicy, () => now);
  const runtime = new CortexBehavioralSignalRuntime(
    retention,
    scope,
    createBehavioralSignalPolicy({
      policyId: "private-http",
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
    }),
    { pseudonymizationKey: TRACKER },
    () => now,
  );
  let nonce = 0;
  const sessions = new PrivacyIsolationSessionService({
    keyLifecycle,
    now: () => now,
    random: () => {
      nonce += 1;
      return Buffer.from(nonce.toString(16).padStart(32, "0"), "hex");
    },
  });
  const operational: Readonly<Record<string, unknown>>[] = [];
  const production = createPrivacyIsolationProductionServer({ runtime, sessions, keyLifecycle, retention, allowedOrigins: [ORIGIN], ingestToken: INGEST, controlToken: CONTROL, onOperationalEvent: (event) => operational.push(event) });
  return { store, privacyPolicy, keyLifecycle, retention, runtime, production, operational, now: () => now, advance: (ms: number) => { now += ms; } };
}

async function post(base: string, path: string, token: string, body: unknown, origin?: string): Promise<Response> {
  const headers: Record<string, string> = { authorization: `Bearer ${token}`, "content-type": "application/json" };
  if (origin !== undefined) headers.origin = origin;
  return fetch(`${base}${path}`, { method: "POST", headers, body: JSON.stringify(body) });
}

async function issue(base: string, privacyDecisionRef = "privacy-decision-0001"): Promise<string> {
  const response = await post(base, "/v1/behavioral/privacy/session", CONTROL, { siteId: SITE, collectionAllowed: true, privacyDecisionRef });
  expect(response.status).toBe(201);
  return (await response.json() as { sessionToken: string }).sessionToken;
}

describe("CORTEX #26 privacy-isolated production server", () => {
  it("keeps session issuance on the trusted control boundary and records browser events without browser consent assertions", async () => {
    const h = harness();
    const base = await listen(h.production);
    const forbidden = await post(base, "/v1/behavioral/privacy/session", INGEST, { siteId: SITE, collectionAllowed: true, privacyDecisionRef: "privacy-decision-0001" });
    expect(forbidden.status).toBe(401);

    const sessionToken = await issue(base);
    const ingested = await post(base, "/v1/behavioral/ingest", INGEST, {
      channel: "BASE",
      event: {
        eventId: "browser-event-0001",
        sessionToken,
        siteId: SITE,
        kind: "CTA_CLICK",
        occurredAt: new Date(NOW).toISOString(),
        surfaceId: "home",
        elementId: "hero-cta",
      },
    }, ORIGIN);
    expect(ingested.status).toBe(200);
    expect(ingested.headers.get("access-control-allow-origin")).toBe(ORIGIN);
    await expect(ingested.json()).resolves.toMatchObject({ status: "RECORDED", siteId: SITE });
    const persisted = JSON.stringify(h.store.checkpoint());
    expect(persisted).not.toContain("browser-event-0001");
    expect(persisted).not.toContain("privacy-decision-0001");
    expect(persisted).not.toContain(sessionToken);
    expect(JSON.stringify(h.operational)).not.toContain(sessionToken);
  });

  it("rejects browser consent fields, raw sessions, fingerprint fields and foreign origins before persistence", async () => {
    const h = harness();
    const base = await listen(h.production);
    const sessionToken = await issue(base, "privacy-decision-0002");
    const before = JSON.stringify(h.store.checkpoint());
    const bad = await post(base, "/v1/behavioral/ingest", INGEST, {
      channel: "BASE",
      event: {
        eventId: "browser-event-0002",
        sessionToken,
        sessionId: "client-controlled-session-0001",
        collectionAllowed: true,
        privacyDecisionRef: "browser-controlled-consent",
        ipAddress: "203.0.113.5",
        userAgent: "fingerprint-me",
        siteId: SITE,
        kind: "PAGE_VIEW",
        occurredAt: new Date(NOW).toISOString(),
        surfaceId: "home",
      },
    }, ORIGIN);
    expect(bad.status).toBe(400);
    expect(JSON.stringify(h.store.checkpoint())).toBe(before);

    const crossOrigin = await post(base, "/v1/behavioral/ingest", INGEST, { channel: "BASE", event: {} }, "https://evil.example");
    expect(crossOrigin.status).toBe(403);
  });

  it("rotates privacy keys only through the control token and keeps old tokens valid only during grace", async () => {
    const h = harness();
    const base = await listen(h.production);
    const oldToken = await issue(base, "privacy-decision-rotate-0001");
    const before = h.keyLifecycle.controlState();
    const unauthorized = await post(base, "/v1/behavioral/privacy/keys/activate", INGEST, { keyId: "privacy-key-v2", expectedControlDigest: before.digest });
    expect(unauthorized.status).toBe(401);

    const activated = await post(base, "/v1/behavioral/privacy/keys/activate", CONTROL, { keyId: "privacy-key-v2", expectedControlDigest: before.digest });
    expect(activated.status).toBe(200);
    await expect(activated.json()).resolves.toMatchObject({ activeKeyId: "privacy-key-v2" });

    const withinGrace = await post(base, "/v1/behavioral/ingest", INGEST, {
      channel: "BASE",
      event: { eventId: "browser-event-old-key-0001", sessionToken: oldToken, siteId: SITE, kind: "PAGE_VIEW", occurredAt: new Date(h.now()).toISOString(), surfaceId: "home" },
    }, ORIGIN);
    expect(withinGrace.status).toBe(200);

    h.advance(h.privacyPolicy.sessionTtlMs);
    const expired = await post(base, "/v1/behavioral/ingest", INGEST, {
      channel: "BASE",
      event: { eventId: "browser-event-old-key-0002", sessionToken: oldToken, siteId: SITE, kind: "PAGE_VIEW", occurredAt: new Date(h.now()).toISOString(), surfaceId: "home" },
    }, ORIGIN);
    expect(expired.status).toBe(400);
  });

  it("executes an authenticated retention sweep and preserves control state while deleting behavioral aggregates", async () => {
    const h = harness();
    const base = await listen(h.production);
    const sessionToken = await issue(base, "privacy-decision-retention-http-0001");
    const ingested = await post(base, "/v1/behavioral/ingest", INGEST, {
      channel: "MICRO",
      event: { eventId: "micro-event-http-0001", sessionToken, siteId: SITE, kind: "POINTER_DOWN", occurredAt: new Date(NOW).toISOString(), surfaceId: "home", elementId: "hero-cta" },
    }, ORIGIN);
    expect(ingested.status).toBe(200);

    h.advance(h.privacyPolicy.aggregateRetentionMs);
    const swept = await post(base, "/v1/behavioral/privacy/retention/sweep", CONTROL, {});
    expect(swept.status).toBe(200);
    await expect(swept.json()).resolves.toMatchObject({ purgedSites: 1 });
    const objects = h.store.checkpoint().objects;
    expect(objects.some((record) => record.typeId === "cortex.behavioral_micro_signal_session" || record.typeId === "cortex.behavioral_micro_signal_site")).toBe(false);
    expect(objects.some((record) => record.typeId === "cortex.behavioral_privacy_key_control")).toBe(true);
    expect(objects.some((record) => record.typeId === "cortex.behavioral_signal_runtime_control")).toBe(true);
  });

  it("preserves the existing durable behavioral kill switch at the final ingest boundary", async () => {
    const h = harness();
    const base = await listen(h.production);
    const sessionToken = await issue(base, "privacy-decision-kill-0001");
    const state = h.runtime.controlState();
    const killed = await post(base, "/v1/behavioral/control/kill", CONTROL, { expectedActiveDigest: state.active.digest });
    expect(killed.status).toBe(200);

    const result = await post(base, "/v1/behavioral/ingest", INGEST, {
      channel: "BASE",
      event: { eventId: "browser-event-after-kill", sessionToken, siteId: SITE, kind: "PAGE_VIEW", occurredAt: new Date(NOW).toISOString(), surfaceId: "home" },
    }, ORIGIN);
    expect(result.status).toBe(200);
    await expect(result.json()).resolves.toMatchObject({ reason: "KILL_SWITCH", status: "NOOP" });
    expect(h.store.checkpoint().objects.some((record) => record.typeId === "cortex.behavioral_signal_session")).toBe(false);
  });
});
