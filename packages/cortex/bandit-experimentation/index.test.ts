import { describe, expect, it } from "vitest";
import { InMemoryOntologyTransactionStore } from "@nexus/ontology/transaction";
import {
  CortexBanditError,
  ServerSideContextualBanditEngine,
  createCortexBanditPolicy,
  type CortexBanditArmDefinition,
  type CortexBanditPolicy,
} from "./index";

const scope = Object.freeze({ tenantId: "tenant-a", organizationId: "org-a", brandId: "brand-a" });

const arms: readonly CortexBanditArmDefinition[] = Object.freeze([
  Object.freeze({
    armId: "control",
    payload: Object.freeze({ headline: "Control", cta: "Book now" }),
    minTrafficShare: 0.1,
    maxTrafficShare: 0.6,
  }),
  Object.freeze({
    armId: "variant-b",
    payload: Object.freeze({ headline: "Variant B", cta: "Schedule" }),
    minTrafficShare: 0.1,
    maxTrafficShare: 0.6,
  }),
]);

function policy(overrides: Partial<Parameters<typeof createCortexBanditPolicy>[0]> = {}): CortexBanditPolicy {
  return createCortexBanditPolicy({
    policyId: "hero-experiment",
    version: "v1",
    defaultArmId: "control",
    minimumObservationsPerArm: 2,
    confidenceLevel: 0.95,
    ucbExplorationCoefficient: 1,
    maxArms: 4,
    maxContextFeatures: 4,
    allowedContextKeys: ["campaign", "device", "market"],
    maxRewardDelayMs: 86_400_000,
    conversionWeight: 0.6,
    economicValueWeight: 0.4,
    economicValueNormalizationCap: 1_000,
    maxWriteRetries: 3,
    mode: "ACTIVE",
    ...overrides,
  });
}

function harness(options: {
  readonly policy?: CortexBanditPolicy;
  readonly armDefinitions?: readonly CortexBanditArmDefinition[];
  readonly experimentId?: string;
} = {}) {
  const store = new InMemoryOntologyTransactionStore();
  let now = Date.parse("2026-09-04T18:00:00.000Z");
  const engine = new ServerSideContextualBanditEngine(
    store,
    scope,
    options.experimentId ?? "landing-hero",
    options.policy ?? policy(),
    options.armDefinitions ?? arms,
    () => now,
  );
  return {
    store,
    engine,
    now: () => now,
    advance(ms: number) {
      now += ms;
    },
    iso() {
      return new Date(now).toISOString();
    },
  };
}

function assignAndReward(
  h: ReturnType<typeof harness>,
  requestId: string,
  converted: boolean,
  economicValue: number,
  context = Object.freeze({ campaign: "search-brand", device: "mobile" }),
) {
  const decision = h.engine.select({
    requestId,
    context,
    eligibleArmIds: ["control", "variant-b"],
  });
  h.advance(1);
  return h.engine.recordOutcome({
    decisionId: decision.decisionId,
    converted,
    economicValue,
    outcomeAt: h.iso(),
  });
}

describe("ServerSideContextualBanditEngine", () => {
  it("rejects invalid policy, traffic, and context configurations before serving traffic", () => {
    expect(() => policy({ conversionWeight: 0.7, economicValueWeight: 0.4 })).toThrow(/must sum to 1/);
    expect(() => policy({ confidenceLevel: 1 })).toThrow(/confidenceLevel/);
    expect(() => harness({
      armDefinitions: [
        { armId: "control", payload: {}, minTrafficShare: 0.6, maxTrafficShare: 0.7 },
        { armId: "variant-b", payload: {}, minTrafficShare: 0.6, maxTrafficShare: 0.7 },
      ],
    })).toThrow(/sum of minTrafficShare/);

    const h = harness();
    expect(() => h.engine.select({
      requestId: "bad-context",
      context: { email: "person@example.com" },
      eligibleArmIds: ["control", "variant-b"],
    })).toThrow(/context key email is not allowed/);
  });

  it("persists assignment and outcome atomically and is idempotent on repeated delivery", () => {
    const h = harness();
    const request = {
      requestId: "req-001",
      context: Object.freeze({ campaign: "search-brand", device: "mobile" }),
      eligibleArmIds: ["control", "variant-b"] as const,
    };
    const first = h.engine.select(request);
    const repeated = h.engine.select(request);
    expect(repeated).toEqual(first);
    expect(h.engine.auditSnapshot(request.context, request.eligibleArmIds).evidence.totalExposures).toBe(1);

    h.advance(5);
    const rewarded = h.engine.recordOutcome({
      decisionId: first.decisionId,
      converted: true,
      economicValue: 500,
      outcomeAt: h.iso(),
    });
    expect(rewarded.status).toBe("REWARDED");
    expect(rewarded.reward).toBeCloseTo(0.8, 12);

    const repeatedOutcome = h.engine.recordOutcome({
      decisionId: first.decisionId,
      converted: true,
      economicValue: 500,
      outcomeAt: h.iso(),
    });
    expect(repeatedOutcome).toEqual(rewarded);
    expect(() => h.engine.recordOutcome({
      decisionId: first.decisionId,
      converted: false,
      economicValue: 500,
      outcomeAt: h.iso(),
    })).toThrow(/already rewarded/);

    const audit = h.engine.auditSnapshot(request.context, request.eligibleArmIds);
    expect(audit.evidence.totalExposures).toBe(1);
    expect(audit.evidence.totalObservations).toBe(1);
    expect(audit.evidence.arms.reduce((sum, row) => sum + row.economicValueSum, 0)).toBe(500);
    expect(audit.digest).toMatch(/^sha256:[a-f0-9]{64}$/);
  });

  it("uses deterministic fallback until evidence justifies automatic exploitation", () => {
    const h = harness({ policy: policy({ minimumObservationsPerArm: 1 }) });
    assignAndReward(h, "warm-control", false, 0);
    assignAndReward(h, "warm-variant", false, 0);

    const decision = h.engine.select({
      requestId: "no-winner",
      context: { campaign: "search-brand", device: "mobile" },
      eligibleArmIds: ["control", "variant-b"],
    });
    expect(decision.armId).toBe("control");
    expect(decision.reason).toBe("DETERMINISTIC_FALLBACK");
    expect(decision.evidence.confidentWinnerArmId).toBeNull();
  });

  it("discovers a statistically separated winner while retaining explicit traffic ceilings", () => {
    const h = harness({ policy: policy({ minimumObservationsPerArm: 2 }) });

    for (let i = 0; i < 80; i += 1) {
      const decision = h.engine.select({
        requestId: `winner-${i}`,
        context: { campaign: "search-brand", device: "mobile" },
        eligibleArmIds: ["control", "variant-b"],
      });
      h.advance(1);
      h.engine.recordOutcome({
        decisionId: decision.decisionId,
        converted: decision.armId === "variant-b",
        economicValue: decision.armId === "variant-b" ? 1_000 : 0,
        outcomeAt: h.iso(),
      });
    }

    const audit = h.engine.auditSnapshot(
      { campaign: "search-brand", device: "mobile" },
      ["control", "variant-b"],
    );
    expect(audit.evidence.confidentWinnerArmId).toBe("variant-b");
    for (const row of audit.evidence.arms) {
      expect(row.exposures).toBeGreaterThan(0);
      expect(row.trafficShare).toBeLessThanOrEqual(row.maxTrafficShare + 0.02);
      expect(row.trafficShare).toBeGreaterThanOrEqual(row.minTrafficShare - 0.02);
    }
  });

  it("honors fallback-only and kill-switch modes even when the learned evidence favors another arm", () => {
    const h = harness();
    for (let i = 0; i < 20; i += 1) {
      const decision = h.engine.select({
        requestId: `guardrail-train-${i}`,
        context: { campaign: "search-brand", device: "mobile" },
        eligibleArmIds: ["control", "variant-b"],
      });
      h.advance(1);
      h.engine.recordOutcome({
        decisionId: decision.decisionId,
        converted: decision.armId === "variant-b",
        economicValue: decision.armId === "variant-b" ? 1_000 : 0,
        outcomeAt: h.iso(),
      });
    }

    const fallback = h.engine.select({
      requestId: "fallback-only",
      context: { campaign: "search-brand", device: "mobile" },
      eligibleArmIds: ["control", "variant-b"],
      mode: "FALLBACK_ONLY",
    });
    expect(fallback.armId).toBe("control");
    expect(fallback.reason).toBe("ROLLBACK_FALLBACK");

    const killed = h.engine.select({
      requestId: "killed",
      context: { campaign: "search-brand", device: "mobile" },
      eligibleArmIds: ["control", "variant-b"],
      mode: "KILLED",
    });
    expect(killed.armId).toBe("control");
    expect(killed.reason).toBe("KILL_SWITCH");
  });

  it("rejects stale, future, negative, and conflicting outcomes", () => {
    const h = harness({ policy: policy({ maxRewardDelayMs: 1_000 }) });
    const decision = h.engine.select({
      requestId: "expiry",
      context: { campaign: "search-brand", device: "mobile" },
      eligibleArmIds: ["control", "variant-b"],
    });
    expect(() => h.engine.recordOutcome({
      decisionId: decision.decisionId,
      converted: true,
      economicValue: -1,
      outcomeAt: h.iso(),
    })).toThrow(/economicValue/);

    const future = new Date(h.now() + 10_000).toISOString();
    expect(() => h.engine.recordOutcome({
      decisionId: decision.decisionId,
      converted: true,
      economicValue: 10,
      outcomeAt: future,
    })).toThrow(/future/);

    h.advance(1_001);
    expect(() => h.engine.recordOutcome({
      decisionId: decision.decisionId,
      converted: true,
      economicValue: 10,
      outcomeAt: h.iso(),
    })).toThrow(CortexBanditError);
  });

  it("isolates learning by context and by immutable experiment configuration", () => {
    const h = harness();
    assignAndReward(h, "mobile-1", true, 1_000, { campaign: "search-brand", device: "mobile" });
    const desktop = h.engine.auditSnapshot(
      { campaign: "search-brand", device: "desktop" },
      ["control", "variant-b"],
    );
    expect(desktop.evidence.totalExposures).toBe(0);
    expect(desktop.evidence.totalObservations).toBe(0);

    const changed = harness({
      armDefinitions: [
        arms[0]!,
        { ...arms[1]!, payload: { headline: "Changed variant", cta: "Schedule" } },
      ],
    });
    expect(changed.engine.configurationDigest).not.toBe(h.engine.configurationDigest);
  });

  it("survives a deterministic adversarial traffic simulation without violating accounting invariants", () => {
    const h = harness({ policy: policy({ minimumObservationsPerArm: 5 }) });
    const contexts = [
      Object.freeze({ campaign: "search-brand", device: "mobile", market: "mx" }),
      Object.freeze({ campaign: "search-nonbrand", device: "desktop", market: "mx" }),
      Object.freeze({ campaign: "pmax", device: "mobile", market: "us" }),
    ] as const;

    for (let i = 0; i < 600; i += 1) {
      const context = contexts[i % contexts.length]!;
      const decision = h.engine.select({
        requestId: `sim-${i}`,
        context,
        eligibleArmIds: ["control", "variant-b"],
      });
      expect(["control", "variant-b"]).toContain(decision.armId);
      h.advance(1);
      const favorable = decision.armId === "variant-b" ? i % 5 !== 0 : i % 10 === 0;
      h.engine.recordOutcome({
        decisionId: decision.decisionId,
        converted: favorable,
        economicValue: favorable ? 250 + (i % 4) * 125 : 0,
        outcomeAt: h.iso(),
      });
    }

    for (const context of contexts) {
      const audit = h.engine.auditSnapshot(context, ["control", "variant-b"]);
      expect(audit.evidence.totalExposures).toBe(200);
      expect(audit.evidence.totalObservations).toBe(200);
      expect(audit.evidence.arms.reduce((sum, row) => sum + row.exposures, 0)).toBe(200);
      expect(audit.evidence.arms.reduce((sum, row) => sum + row.observations, 0)).toBe(200);
      for (const row of audit.evidence.arms) {
        expect(Number.isFinite(row.meanReward)).toBe(true);
        expect(Number.isFinite(row.ucbScore)).toBe(true);
        expect(row.pendingOutcomes).toBe(0);
        expect(row.observations).toBeLessThanOrEqual(row.exposures);
        expect(row.conversions).toBeLessThanOrEqual(row.observations);
        expect(row.trafficShare).toBeLessThanOrEqual(row.maxTrafficShare + 0.01);
        expect(row.trafficShare).toBeGreaterThanOrEqual(row.minTrafficShare - 0.01);
      }
    }
  });
});
