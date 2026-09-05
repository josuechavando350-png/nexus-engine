import { describe, expect, it } from "vitest";
import { InMemoryOntologyTransactionStore } from "@nexus/ontology/transaction";
import { createCortexBanditPolicy } from "./index";
import { CortexBanditRuntimeController, CortexBanditRuntimeControlError } from "./runtime-control";

const scope = { tenantId: "tenant:cortex-control", organizationId: "org:cortex-control" } as const;
const policy = createCortexBanditPolicy({
  policyId: "runtime-control-test",
  version: "v1",
  defaultArmId: "control",
  minimumObservationsPerArm: 1,
  confidenceLevel: 0.95,
  ucbExplorationCoefficient: 1,
  maxArms: 2,
  maxContextFeatures: 2,
  allowedContextKeys: ["channel"],
  maxRewardDelayMs: 86_400_000,
  conversionWeight: 0.5,
  economicValueWeight: 0.5,
  economicValueNormalizationCap: 10_000,
  mode: "ACTIVE",
});

describe("CORTEX bandit durable runtime control", () => {
  it("persists audited rollback and kill transitions with CAS revisions", () => {
    const store = new InMemoryOntologyTransactionStore();
    let now = Date.parse("2026-09-05T22:00:00.000Z");
    const control = new CortexBanditRuntimeController(store, scope, "hero-test", policy.digest, policy.mode, () => now);

    expect(control.current()).toMatchObject({ mode: "ACTIVE", revision: 0, changedAt: null });
    const fallback = control.set({ expectedRevision: 0, mode: "FALLBACK_ONLY", reason: "operator rollback after conversion regression" });
    expect(fallback).toMatchObject({ mode: "FALLBACK_ONLY", revision: 1 });

    now += 1_000;
    const killed = control.set({ expectedRevision: 1, mode: "KILLED", reason: "emergency kill while upstream incident is investigated" });
    expect(killed).toMatchObject({ mode: "KILLED", revision: 2 });
    expect(control.history()).toMatchObject([
      { fromMode: "ACTIVE", toMode: "FALLBACK_ONLY", targetRevision: 1 },
      { fromMode: "FALLBACK_ONLY", toMode: "KILLED", targetRevision: 2 },
    ]);

    expect(() => control.set({ expectedRevision: 1, mode: "ACTIVE", reason: "stale operator request" }))
      .toThrow(CortexBanditRuntimeControlError);
  });

  it("cannot weaken a more restrictive configured policy", () => {
    const store = new InMemoryOntologyTransactionStore();
    const fallbackPolicy = createCortexBanditPolicy({ ...policy, policyId: "fallback-config", mode: "FALLBACK_ONLY" });
    const control = new CortexBanditRuntimeController(store, scope, "fallback-test", fallbackPolicy.digest, fallbackPolicy.mode);
    expect(() => control.set({ expectedRevision: 0, mode: "ACTIVE", reason: "attempt to bypass configured rollback" }))
      .toThrow(/cannot weaken configured mode/i);
  });
});
