import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { InMemoryOntologyTransactionStore } from "@nexus/ontology/transaction";
import { SqliteOntologyTransactionStore } from "@nexus/ontology/cortex/sqlite-transaction-store";
import { BehavioralSignalError, createBehavioralSignalPolicy, type CreateBehavioralSignalPolicyInput } from "./index";
import { CortexBehavioralSignalRuntime, type BehavioralSignalRuntimeTelemetryEvent } from "./runtime";

const scope = Object.freeze({ tenantId: "tenant-cortex", organizationId: "org-cortex", brandId: "brand-cortex" });
const NOW = Date.parse("2026-09-05T19:00:00.000Z");
const KEY = "behavioral-runtime-test-key-material-64-bytes-minimum-xxxxxxxxxxxx";

function policy(overrides: Partial<CreateBehavioralSignalPolicyInput> = {}) {
  return createBehavioralSignalPolicy({
    policyId: "behavioral-runtime",
    version: "v1",
    pseudonymizationKeyId: "behavior-key-v1",
    allowedSurfaceIds: ["home", "contact"],
    allowedElementIds: ["cta.primary", "form.contact"],
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

function baseEvent(eventId: string) {
  return {
    eventId,
    sessionId: "runtime-session-0001",
    siteId: "site-a",
    kind: "SCROLL_DEPTH" as const,
    occurredAt: new Date(NOW - 500).toISOString(),
    surfaceId: "home",
    scrollDepthPercent: 70,
    collectionAllowed: true,
    privacyDecisionRef: "decision-v1",
  };
}

function microEvent(eventId: string) {
  return {
    eventId,
    sessionId: "runtime-session-0001",
    siteId: "site-a",
    kind: "POINTER_ENTER" as const,
    occurredAt: new Date(NOW - 400).toISOString(),
    surfaceId: "home",
    elementId: "cta.primary",
    collectionAllowed: true,
    privacyDecisionRef: "decision-v1",
  };
}

describe("CortexBehavioralSignalRuntime", () => {
  it("is the connected production entry point for base and micro behavioral measurement", () => {
    const store = new InMemoryOntologyTransactionStore();
    const active = policy();
    const runtime = new CortexBehavioralSignalRuntime(store, scope, active, { pseudonymizationKey: KEY }, () => NOW);

    expect(runtime.ingest(baseEvent("runtime-base-0001")).status).toBe("RECORDED");
    expect(runtime.ingestMicroInteraction(microEvent("runtime-micro-001")).status).toBe("RECORDED");
    expect(runtime.controlState()).toMatchObject({ active: { digest: active.digest, mode: "ACTIVE" }, previous: null, generation: 1 });
    expect(store.checkpoint().objects).toHaveLength(5);
  });

  it("provides a durable kill switch and exact configuration rollback without deleting accepted measurement facts", () => {
    const store = new InMemoryOntologyTransactionStore();
    const active = policy();
    const runtime = new CortexBehavioralSignalRuntime(store, scope, active, { pseudonymizationKey: KEY }, () => NOW);
    expect(runtime.ingest(baseEvent("runtime-base-0001")).status).toBe("RECORDED");
    const beforeKill = store.checkpoint().objects.length;

    const killed = runtime.kill(active.digest);
    expect(killed.active.mode).toBe("KILLED");
    expect(killed.previous?.digest).toBe(active.digest);
    expect(runtime.ingest(baseEvent("runtime-base-0002")).reason).toBe("KILL_SWITCH");
    expect(runtime.ingestMicroInteraction(microEvent("runtime-micro-002")).reason).toBe("KILL_SWITCH");
    expect(store.checkpoint().objects).toHaveLength(beforeKill);

    const restored = runtime.rollbackPolicy(killed.active.digest);
    expect(restored.active.digest).toBe(active.digest);
    expect(restored.previous?.mode).toBe("KILLED");
    expect(runtime.ingestMicroInteraction(microEvent("runtime-micro-003")).status).toBe("RECORDED");
    expect(store.checkpoint().objects).toHaveLength(beforeKill + 2);
  });

  it("uses CAS expectations for policy activation and rejects forged policy digests", () => {
    const store = new InMemoryOntologyTransactionStore();
    const active = policy();
    const runtime = new CortexBehavioralSignalRuntime(store, scope, active, { pseudonymizationKey: KEY }, () => NOW);
    const observe = policy({ version: "v2", mode: "OBSERVE_ONLY" });

    expect(() => runtime.activatePolicy(observe, "sha256:" + "0".repeat(64))).toThrow(/changed before/);
    expect(runtime.activatePolicy(observe, active.digest).active.digest).toBe(observe.digest);
    expect(runtime.ingest(baseEvent("runtime-base-0004")).status).toBe("OBSERVED");

    const forged = Object.freeze({ ...policy({ version: "v3" }), digest: observe.digest });
    expect(() => runtime.activatePolicy(forged, observe.digest)).toThrow(BehavioralSignalError);
    expect(runtime.controlState().active.digest).toBe(observe.digest);
  });

  it("emits privacy-minimized unified telemetry for base, micro, controls and errors while isolating sink failures", () => {
    const store = new InMemoryOntologyTransactionStore();
    const events: BehavioralSignalRuntimeTelemetryEvent[] = [];
    const telemetryErrors: unknown[] = [];
    let calls = 0;
    const runtime = new CortexBehavioralSignalRuntime(store, scope, policy(), { pseudonymizationKey: KEY }, () => NOW, {
      onTelemetry: (event) => {
        events.push(event);
        calls += 1;
        if (calls === 2) throw new Error("telemetry unavailable");
      },
      onTelemetryError: (error) => telemetryErrors.push(error),
    });

    expect(runtime.ingest(baseEvent("runtime-base-0005")).status).toBe("RECORDED");
    expect(runtime.ingestMicroInteraction(microEvent("runtime-micro-005")).status).toBe("RECORDED");
    expect(() => runtime.ingestMicroInteraction({ ...microEvent("runtime-micro-006"), clientX: 20 } as never)).toThrow(/unsupported field/);
    expect(telemetryErrors).toHaveLength(1);
    expect(events.some((event) => event.category === "INGEST" && event.channel === "MICRO" && event.outcome === "ERROR")).toBe(true);
    const serialized = JSON.stringify(events);
    expect(serialized).not.toContain("runtime-session-0001");
    expect(serialized).not.toContain("decision-v1");
    expect(serialized).not.toContain("runtime-base-0005");
  });

  it("persists control state across SQLite restart and rolls back the active policy after reopen", () => {
    const dir = mkdtempSync(join(tmpdir(), "nexus-behavioral-runtime-"));
    const db = join(dir, "runtime.sqlite");
    const active = policy();
    const observe = policy({ version: "v2", mode: "OBSERVE_ONLY" });
    try {
      const firstStore = new SqliteOntologyTransactionStore(db);
      const first = new CortexBehavioralSignalRuntime(firstStore, scope, active, { pseudonymizationKey: KEY }, () => NOW);
      expect(first.activatePolicy(observe, active.digest).active.digest).toBe(observe.digest);
      firstStore.close();

      const reopenedStore = new SqliteOntologyTransactionStore(db);
      const reopened = new CortexBehavioralSignalRuntime(reopenedStore, scope, active, { pseudonymizationKey: KEY }, () => NOW);
      expect(reopened.controlState().active.digest).toBe(observe.digest);
      expect(reopened.rollbackPolicy(observe.digest).active.digest).toBe(active.digest);
      expect(reopened.ingest(baseEvent("runtime-base-0007")).status).toBe("RECORDED");
      reopenedStore.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
