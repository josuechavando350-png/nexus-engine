import { describe, expect, it } from "vitest";
import { InMemoryEdgeCircuitStateStore } from "./circuit-breaker.js";

describe("InMemoryEdgeCircuitStateStore", () => {
  it("opens after the configured threshold and admits only one half-open probe", async () => {
    const store = new InMemoryEdgeCircuitStateStore();
    expect((await store.beforeRequest("landing", 1_000, 2_000)).allowed).toBe(true);
    expect((await store.recordFailure("landing", 1_100, { failureThreshold: 2, openCircuitMs: 5_000 })).phase).toBe("CLOSED");
    const opened = await store.recordFailure("landing", 1_200, { failureThreshold: 2, openCircuitMs: 5_000 });
    expect(opened).toMatchObject({ phase: "OPEN", retryAt: 6_200, consecutiveFailures: 2 });
    expect((await store.beforeRequest("landing", 6_199, 2_000)).allowed).toBe(false);
    expect(await store.beforeRequest("landing", 6_200, 2_000)).toMatchObject({ allowed: true, state: { phase: "HALF_OPEN", probeUntil: 8_200 } });
    expect((await store.beforeRequest("landing", 6_201, 2_000)).allowed).toBe(false);
  });

  it("closes after a successful probe and reopens immediately when a probe fails", async () => {
    const store = new InMemoryEdgeCircuitStateStore();
    await store.recordFailure("api", 1_000, { failureThreshold: 1, openCircuitMs: 1_000 });
    await store.beforeRequest("api", 2_000, 1_000);
    expect((await store.recordSuccess("api", 2_100)).phase).toBe("CLOSED");
    expect((await store.beforeRequest("api", 2_101, 1_000)).allowed).toBe(true);

    await store.recordFailure("api", 3_000, { failureThreshold: 1, openCircuitMs: 1_000 });
    await store.beforeRequest("api", 4_000, 1_000);
    const reopened = await store.recordFailure("api", 4_100, { failureThreshold: 3, openCircuitMs: 2_000 });
    expect(reopened).toMatchObject({ phase: "OPEN", retryAt: 6_100 });
  });
});
