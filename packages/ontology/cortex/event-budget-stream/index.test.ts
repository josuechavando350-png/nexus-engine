import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { Cortex17Error, SqliteDurableEventStream, arbitrateBudget } from "./index";

const dirs: string[] = [];
function databasePath(): string { const dir = mkdtempSync(join(tmpdir(), "nexus-cortex17-")); dirs.push(dir); return join(dir, "events.sqlite"); }
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

describe("CORTEX #17 durable event stream", () => {
  it("persists canonical digest-verified events across reopen and preserves idempotency", () => {
    const path = databasePath();
    const input = { stream: "commerce.events", eventId: "evt-00000001", occurredAt: "2026-09-06T00:00:00.000Z", payload: { revenue: 125.5, currency: "MXN" } } as const;
    const first = new SqliteDurableEventStream(path, () => Date.parse("2026-09-06T00:00:01.000Z"));
    const created = first.append(input);
    expect(created.sequence).toBe(1); expect(created.digest).toMatch(/^sha256:[0-9a-f]{64}$/u); expect(first.append(input)).toEqual(created);
    first.close();
    const reopened = new SqliteDurableEventStream(path);
    expect(reopened.read("commerce.events", 0, 10)).toEqual([created]);
    expect(() => reopened.append({ ...input, payload: { revenue: 999, currency: "MXN" } })).toThrowError(Cortex17Error);
    reopened.close();
  });

  it("rolls back append when the final mutation guard fails", () => {
    const stream = new SqliteDurableEventStream(databasePath());
    const event = { stream: "ads.events", eventId: "evt-00000010", occurredAt: "2026-09-06T00:00:00.000Z", payload: { spend: 10 } };
    expect(() => stream.append(event, () => { throw new Error("killed"); })).toThrowError(/killed/u);
    expect(stream.read("ads.events", 0, 10)).toEqual([]);
    stream.close();
  });

  it("commits monotonic consumer offsets only to real stream sequences and honors the final guard", () => {
    const stream = new SqliteDurableEventStream(databasePath());
    stream.append({ stream: "ads.events", eventId: "evt-00000011", occurredAt: "2026-09-06T00:00:00.000Z", payload: { spend: 10 } });
    stream.append({ stream: "ads.events", eventId: "evt-00000012", occurredAt: "2026-09-06T00:00:01.000Z", payload: { spend: 11 } });
    expect(stream.commitOffset("dashboard.consumer", "ads.events", 1)).toBe(1);
    expect(() => stream.commitOffset("dashboard.consumer", "ads.events", 2, () => { throw new Error("killed"); })).toThrowError(/killed/u);
    expect(stream.readOffset("dashboard.consumer", "ads.events")).toBe(1);
    expect(stream.commitOffset("dashboard.consumer", "ads.events", 2)).toBe(2);
    expect(stream.commitOffset("dashboard.consumer", "ads.events", 2)).toBe(2);
    expect(() => stream.commitOffset("dashboard.consumer", "ads.events", 1)).toThrowError(/cannot move backwards/u);
    expect(() => stream.commitOffset("other.consumer", "ads.events", 999)).toThrowError(/does not belong/u);
    stream.close();
  });

  it("detects persisted event tampering instead of returning corrupt evidence", () => {
    const path = databasePath(); const stream = new SqliteDurableEventStream(path);
    stream.append({ stream: "ads.events", eventId: "evt-00000013", occurredAt: "2026-09-06T00:00:00.000Z", payload: { spend: 10 } }); stream.close();
    const db = new DatabaseSync(path); db.prepare("UPDATE cortex17_events SET payload_json=? WHERE event_id=?").run('{"spend":999}', "evt-00000013"); db.close();
    const reopened = new SqliteDurableEventStream(path);
    expect(() => reopened.read("ads.events", 0, 10)).toThrowError(/digest mismatch/u);
    reopened.close();
  });
});

describe("CORTEX #17 cross-channel budget arbitration", () => {
  const base = {
    totalBudget: 1000.03,
    maxShiftFraction: 0.2,
    minConfidence: 0.8,
    maxDataAgeMinutes: 60,
    channels: [
      { channel: "search", currentSpend: 500.01, minSpend: 300, maxSpend: 700, marginalReturn: 2.5, confidence: 0.95, dataAgeMinutes: 10 },
      { channel: "social", currentSpend: 500.02, minSpend: 300, maxSpend: 700, marginalReturn: 1.2, confidence: 0.9, dataAgeMinutes: 10 },
    ],
  } as const;

  it("reallocates in exact cents, conserves the total budget, and stays within configured shift/bounds", () => {
    const result = arbitrateBudget(base);
    expect(result.decision).toBe("REALLOCATE"); expect(result.reason).toBe("EVIDENCE_OK");
    expect(result.allocations.find((item) => item.channel === "search")?.nextSpend).toBe(600.01);
    expect(result.allocations.find((item) => item.channel === "social")?.nextSpend).toBe(400.02);
    expect(Math.round(result.allocations.reduce((sum, item) => sum + item.nextSpend, 0) * 100)).toBe(100003);
  });

  it("holds the entire budget when evidence is stale or low-confidence", () => {
    const stale = { ...base, channels: [{ ...base.channels[0], dataAgeMinutes: 61 }, base.channels[1]] };
    const result = arbitrateBudget(stale);
    expect(result.decision).toBe("HOLD"); expect(result.reason).toBe("INSUFFICIENT_EVIDENCE"); expect(result.allocations.every((item) => item.delta === 0)).toBe(true);
  });

  it("rejects malformed money precision, duplicate channels, and infeasible contracts instead of guessing", () => {
    expect(() => arbitrateBudget({ ...base, totalBudget: 1000.031 })).toThrowError(/two decimal places/u);
    expect(() => arbitrateBudget({ ...base, channels: [...base.channels, base.channels[0]] })).toThrowError(/duplicated/u);
    expect(() => arbitrateBudget({ ...base, channels: [{ ...base.channels[0], minSpend: 650 }, { ...base.channels[1], minSpend: 650 }] })).toThrowError(/bounds|infeasible/u);
  });
});
