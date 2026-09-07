import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { SqliteDurableEventStream } from "../event-budget-stream/index";
import { HybridFinancialMetricStore } from "./index";
import { Cortex18FirstPartyConsumer } from "./production-first-party";
import type { Cortex18Mode } from "./runtime-control";

const dirs: string[] = [];
function database(name: string): string { const dir = mkdtempSync(join(tmpdir(), `nexus-cortex18-first-party-${name}-`)); dirs.push(dir); return join(dir, `${name}.sqlite`); }
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

const metric = {
  source: "first-party",
  eventId: "metric-00000001",
  occurredAt: "2026-09-06T00:00:00.000Z",
  currency: "MXN",
  revenue: 1000,
  cost: 300,
  spend: 200,
  conversions: 2,
} as const;

describe("CORTEX #18 production first-party consumer", () => {
  it("consumes the real #17 SQLite stream and persists its offset", () => {
    const eventsPath = database("events"); const metricsPath = database("metrics");
    const events = new SqliteDurableEventStream(eventsPath); events.append({ stream: "financial.metrics", eventId: metric.eventId, occurredAt: metric.occurredAt, payload: metric });
    const store = new HybridFinancialMetricStore(metricsPath);
    const consumer = new Cortex18FirstPartyConsumer(store, events, "financial.metrics", "dashboard.consumer", () => "ACTIVE");
    expect(consumer.runOnce()).toEqual({ consumed: 1, inserted: 1, offset: 1 });
    expect(events.readOffset("dashboard.consumer", "financial.metrics")).toBe(1);
    store.close(); events.close();
  });

  it("does not advance the #17 offset if durable control dies after metric persistence, and recovers idempotently", () => {
    const eventsPath = database("race-events"); const metricsPath = database("race-metrics");
    const events = new SqliteDurableEventStream(eventsPath); events.append({ stream: "financial.metrics", eventId: metric.eventId, occurredAt: metric.occurredAt, payload: metric });
    const store = new HybridFinancialMetricStore(metricsPath);
    let mode: Cortex18Mode = "ACTIVE"; let reads = 0;
    const consumer = new Cortex18FirstPartyConsumer(store, events, "financial.metrics", "dashboard.consumer", () => {
      reads += 1;
      if (reads >= 3) mode = "KILLED";
      return mode;
    });
    expect(() => consumer.runOnce()).toThrowError(/killed at durable first-party mutation boundary/u);
    expect(events.readOffset("dashboard.consumer", "financial.metrics")).toBe(0);
    expect(store.summaries()).toEqual([{ currency: "MXN", revenue: 1000, cost: 300, spend: 200, profit: 500, conversions: 2, events: 1 }]);

    mode = "ACTIVE"; reads = 0;
    const recovered = new Cortex18FirstPartyConsumer(store, events, "financial.metrics", "dashboard.consumer", () => mode);
    expect(recovered.runOnce()).toEqual({ consumed: 1, inserted: 0, offset: 1 });
    expect(events.readOffset("dashboard.consumer", "financial.metrics")).toBe(1);
    expect(store.summaries()[0]?.events).toBe(1);
    store.close(); events.close();
  });

  it("performs no first-party consumption while KILLED", () => {
    const events = new SqliteDurableEventStream(database("killed-events")); events.append({ stream: "financial.metrics", eventId: metric.eventId, occurredAt: metric.occurredAt, payload: metric });
    const store = new HybridFinancialMetricStore(database("killed-metrics"));
    const consumer = new Cortex18FirstPartyConsumer(store, events, "financial.metrics", "dashboard.consumer", () => "KILLED");
    expect(consumer.runOnce()).toEqual({ consumed: 0, inserted: 0, offset: 0 });
    expect(store.summaries()).toEqual([]);
    store.close(); events.close();
  });
});
