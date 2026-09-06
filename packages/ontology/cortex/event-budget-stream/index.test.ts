import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { Cortex17Error, SqliteDurableEventStream, arbitrateBudget } from "./index";

const dirs: string[] = [];
function databasePath(): string {
  const dir = mkdtempSync(join(tmpdir(), "nexus-cortex17-"));
  dirs.push(dir);
  return join(dir, "events.sqlite");
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("CORTEX #17 durable event stream", () => {
  it("persists events across process-style reopen and preserves idempotency", () => {
    const path = databasePath();
    const input = { stream: "commerce.events", eventId: "evt-00000001", occurredAt: "2026-09-06T00:00:00.000Z", payload: { revenue: 125.5, currency: "MXN" } } as const;
    const first = new SqliteDurableEventStream(path, () => Date.parse("2026-09-06T00:00:01.000Z"));
    const created = first.append(input);
    expect(created.sequence).toBe(1);
    expect(first.append(input)).toEqual(created);
    first.close();

    const reopened = new SqliteDurableEventStream(path);
    expect(reopened.read("commerce.events", 0, 10)).toEqual([created]);
    expect(() => reopened.append({ ...input, payload: { revenue: 999, currency: "MXN" } })).toThrowError(Cortex17Error);
    reopened.close();
  });

  it("commits monotonic consumer offsets only to real stream sequences", () => {
    const stream = new SqliteDurableEventStream(databasePath());
    stream.append({ stream: "ads.events", eventId: "evt-00000011", occurredAt: "2026-09-06T00:00:00.000Z", payload: { spend: 10 } });
    stream.append({ stream: "ads.events", eventId: "evt-00000012", occurredAt: "2026-09-06T00:00:01.000Z", payload: { spend: 11 } });
    expect(stream.commitOffset("dashboard.consumer", "ads.events", 1)).toBe(1);
    expect(stream.commitOffset("dashboard.consumer", "ads.events", 2)).toBe(2);
    expect(() => stream.commitOffset("dashboard.consumer", "ads.events", 1)).toThrowError(/cannot move backwards/u);
    expect(() => stream.commitOffset("other.consumer", "ads.events", 999)).toThrowError(/does not belong/u);
    stream.close();
  });
});

describe("CORTEX #17 cross-channel budget arbitration", () => {
  const base = {
    totalBudget: 1_000,
    maxShiftFraction: 0.2,
    minConfidence: 0.8,
    maxDataAgeMinutes: 60,
    channels: [
      { channel: "search", currentSpend: 500, minSpend: 300, maxSpend: 700, marginalReturn: 2.5, confidence: 0.95, dataAgeMinutes: 10 },
      { channel: "social", currentSpend: 500, minSpend: 300, maxSpend: 700, marginalReturn: 1.2, confidence: 0.9, dataAgeMinutes: 10 },
    ],
  } as const;

  it("reallocates only within configured bounds when evidence is sufficient", () => {
    const result = arbitrateBudget(base);
    expect(result.decision).toBe("REALLOCATE");
    expect(result.reason).toBe("EVIDENCE_OK");
    expect(result.allocations.find((item) => item.channel === "search")?.nextSpend).toBe(600);
    expect(result.allocations.find((item) => item.channel === "social")?.nextSpend).toBe(400);
    expect(result.allocations.reduce((sum, item) => sum + item.nextSpend, 0)).toBe(1_000);
  });

  it("holds the entire budget when evidence is stale or low-confidence", () => {
    const stale = { ...base, channels: [{ ...base.channels[0], dataAgeMinutes: 61 }, base.channels[1]] };
    const result = arbitrateBudget(stale);
    expect(result.decision).toBe("HOLD");
    expect(result.reason).toBe("INSUFFICIENT_EVIDENCE");
    expect(result.allocations.every((item) => item.delta === 0)).toBe(true);
  });

  it("rejects malformed or infeasible contracts instead of guessing", () => {
    expect(() => arbitrateBudget({ ...base, totalBudget: 999 })).toThrowError(/must equal totalBudget/u);
    expect(() => arbitrateBudget({ ...base, channels: [...base.channels, base.channels[0]] })).toThrowError(/duplicated/u);
  });
});
