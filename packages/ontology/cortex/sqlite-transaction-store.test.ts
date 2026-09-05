import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ServerSideContextualBanditEngine, createCortexBanditPolicy } from "./bandit-experimentation/index";
import { SqliteOntologyStoreError, SqliteOntologyTransactionStore } from "./sqlite-transaction-store";

const roots: string[] = [];
const scope = Object.freeze({ tenantId: "tenant-sqlite", organizationId: "org-sqlite", brandId: "brand-sqlite" });

function databasePath(): string {
  const root = mkdtempSync(join(tmpdir(), "nexus-cortex-bandit-"));
  roots.push(root);
  return join(root, "cortex.sqlite");
}

function policy() {
  return createCortexBanditPolicy({
    policyId: "durable-bandit",
    version: "v1",
    defaultArmId: "control",
    minimumObservationsPerArm: 1,
    confidenceLevel: 0.95,
    ucbExplorationCoefficient: 1,
    maxArms: 2,
    maxContextFeatures: 2,
    allowedContextKeys: ["campaign", "device"],
    maxRewardDelayMs: 60_000,
    conversionWeight: 0.5,
    economicValueWeight: 0.5,
    economicValueNormalizationCap: 500,
  });
}

function engine(store: SqliteOntologyTransactionStore, now: () => number) {
  return new ServerSideContextualBanditEngine(
    store,
    scope,
    "durable-hero",
    policy(),
    [
      { armId: "control", payload: { headline: "Control" }, minTrafficShare: 0, maxTrafficShare: 1 },
      { armId: "variant", payload: { headline: "Variant" }, minTrafficShare: 0, maxTrafficShare: 1 },
    ],
    now,
  );
}

afterEach(() => {
  while (roots.length) {
    const root = roots.pop();
    if (root) rmSync(root, { recursive: true, force: true });
  }
});

describe("SqliteOntologyTransactionStore", () => {
  it("rejects accidental ephemeral storage by default", () => {
    expect(() => new SqliteOntologyTransactionStore(":memory:")).toThrow(SqliteOntologyStoreError);
  });

  it("persists assignment and economic outcome across process-style reopen", () => {
    const path = databasePath();
    let now = Date.parse("2026-09-04T19:00:00.000Z");
    const events: number[] = [];
    const firstStore = new SqliteOntologyTransactionStore(path, {
      onTransaction: (event) => events.push(event.operationCount),
    });
    const firstEngine = engine(firstStore, () => now);
    const decision = firstEngine.select({
      requestId: "persisted-request",
      context: { campaign: "search", device: "mobile" },
      eligibleArmIds: ["control", "variant"],
    });
    now += 10;
    firstEngine.recordOutcome({
      decisionId: decision.decisionId,
      converted: true,
      economicValue: 250,
      outcomeAt: new Date(now).toISOString(),
    });
    expect(events).toEqual([2, 2]);
    firstStore.close();

    const reopenedStore = new SqliteOntologyTransactionStore(path);
    const reopenedEngine = engine(reopenedStore, () => now);
    const repeated = reopenedEngine.select({
      requestId: "persisted-request",
      context: { campaign: "search", device: "mobile" },
      eligibleArmIds: ["control", "variant"],
    });
    expect(repeated.status).toBe("REWARDED");
    expect(repeated.decisionId).toBe(decision.decisionId);
    expect(repeated.reward).toBeCloseTo(0.75, 12);

    const audit = reopenedEngine.auditSnapshot(
      { campaign: "search", device: "mobile" },
      ["control", "variant"],
    );
    expect(audit.evidence.totalExposures).toBe(1);
    expect(audit.evidence.totalObservations).toBe(1);
    expect(audit.evidence.arms.reduce((sum, arm) => sum + arm.economicValueSum, 0)).toBe(250);
    reopenedStore.close();
  });

  it("makes committed state visible to another live SQLite connection", () => {
    const path = databasePath();
    let now = Date.parse("2026-09-04T20:00:00.000Z");
    const writerStore = new SqliteOntologyTransactionStore(path);
    const readerStore = new SqliteOntologyTransactionStore(path);
    const writer = engine(writerStore, () => now);
    const reader = engine(readerStore, () => now);

    const decision = writer.select({
      requestId: "cross-connection",
      context: { campaign: "search", device: "desktop" },
      eligibleArmIds: ["control", "variant"],
    });
    const observedBeforeReward = reader.auditSnapshot(
      { campaign: "search", device: "desktop" },
      ["control", "variant"],
    );
    expect(observedBeforeReward.evidence.totalExposures).toBe(1);
    expect(observedBeforeReward.evidence.totalObservations).toBe(0);

    now += 5;
    writer.recordOutcome({
      decisionId: decision.decisionId,
      converted: false,
      economicValue: 100,
      outcomeAt: new Date(now).toISOString(),
    });
    const observedAfterReward = reader.auditSnapshot(
      { campaign: "search", device: "desktop" },
      ["control", "variant"],
    );
    expect(observedAfterReward.evidence.totalObservations).toBe(1);
    expect(observedAfterReward.evidence.arms.reduce((sum, arm) => sum + arm.economicValueSum, 0)).toBe(100);

    readerStore.close();
    writerStore.close();
  });
});
