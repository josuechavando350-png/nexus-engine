import { describe, expect, it } from "vitest";
import { InMemoryOntologyTransactionStore } from "@nexus/ontology/transaction";
import { createBehavioralSignalPolicy } from "./index";
import { createBehavioralSignalHttpHandler } from "./http-handler";
import { CortexBehavioralSignalRuntime } from "./runtime";

const scope = Object.freeze({ tenantId: "tenant-cortex", organizationId: "org-cortex", brandId: "brand-cortex" });
const NOW = Date.parse("2026-09-05T20:30:00.000Z");
const ORIGIN = "https://example.test";
const KEY = "bounded-body-test-key-material-64-bytes-minimum-xxxxxxxxxxxxxxxxx";

function policy() {
  return createBehavioralSignalPolicy({
    policyId: "behavioral-http-body",
    version: "v1",
    pseudonymizationKeyId: "behavior-key-v1",
    allowedSurfaceIds: ["home"],
    allowedElementIds: ["cta.primary"],
    maxEventAgeMs: 60_000,
    maxFutureSkewMs: 1_000,
    maxSessionDurationMs: 60_000,
    maxEventsPerSession: 64,
    maxEngagementMsPerEvent: 10_000,
    maxWriteRetries: 3,
    mode: "ACTIVE",
  });
}

describe("behavioral HTTP boundary guardrails", () => {
  it("cancels an oversized streaming body before consuming the full stream", async () => {
    const store = new InMemoryOntologyTransactionStore();
    const runtime = new CortexBehavioralSignalRuntime(store, scope, policy(), { pseudonymizationKey: KEY }, () => NOW);
    const handler = createBehavioralSignalHttpHandler(runtime, { allowedOrigins: [ORIGIN], maxBodyBytes: 1_024 });

    let pulls = 0;
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls += 1;
        if (pulls > 20) {
          controller.close();
          return;
        }
        controller.enqueue(new Uint8Array(600).fill(0x78));
      },
      cancel() {
        cancelled = true;
      },
    });

    const request = new Request(`${ORIGIN}/api`, {
      method: "POST",
      headers: { origin: ORIGIN, "content-type": "application/json" },
      body,
      duplex: "half",
    } as RequestInit & { duplex: "half" });

    const response = await handler(request);
    expect(response.status).toBe(413);
    expect(cancelled).toBe(true);
    expect(pulls).toBeLessThan(20);
    expect(store.checkpoint().objects).toHaveLength(1);
  });

  it("accepts JSON parameters but rejects media types that merely share the application/json prefix", async () => {
    const store = new InMemoryOntologyTransactionStore();
    const runtime = new CortexBehavioralSignalRuntime(store, scope, policy(), { pseudonymizationKey: KEY }, () => NOW);
    const handler = createBehavioralSignalHttpHandler(runtime, { allowedOrigins: [ORIGIN] });
    const body = JSON.stringify({ channel: "BASE", event: {} });

    const parameterized = await handler(new Request(`${ORIGIN}/api`, {
      method: "POST",
      headers: { origin: ORIGIN, "content-type": "application/json; charset=utf-8" },
      body,
    }));
    expect(parameterized.status).not.toBe(415);

    const invalidPrefix = await handler(new Request(`${ORIGIN}/api`, {
      method: "POST",
      headers: { origin: ORIGIN, "content-type": "application/jsonp" },
      body,
    }));
    expect(invalidPrefix.status).toBe(415);
    expect(store.checkpoint().objects).toHaveLength(1);
  });
});
