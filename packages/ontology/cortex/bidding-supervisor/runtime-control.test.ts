import { describe, expect, it } from "vitest";
import { InMemoryOntologyTransactionStore } from "@nexus/ontology/transaction";
import { createBiddingSupervisorPolicy } from "./index";
import { BiddingRuntimeController, BiddingRuntimeControlError } from "./runtime-control";

const scope = { tenantId: "tenant:bidding-control", organizationId: "org:bidding-control" } as const;

function policy(mode: "ACTIVE" | "OBSERVE_ONLY" | "KILLED" = "ACTIVE", version = "v1") {
  return createBiddingSupervisorPolicy({
    policyId: "bidding-control",
    version,
    observationWindowDays: 14,
    reportingLagDays: 2,
    cooldownMs: 86_400_000,
    maxBusinessDataAgeMs: 3_600_000,
    minimumCostMicros: 1_000_000,
    minimumGoogleConversions: 1,
    increaseVolumeProfitToSpendRatio: 2,
    decreaseRiskProfitToSpendRatio: 0.8,
    budgetStepFraction: 0.1,
    targetStepFraction: 0.1,
    bidBoundStepFraction: 0.1,
    minBudgetMicros: 1_000_000,
    maxBudgetMicros: 100_000_000,
    minTargetCpaMicros: 100_000,
    maxTargetCpaMicros: 50_000_000,
    minTargetRoas: 0.1,
    maxTargetRoas: 20,
    minPortfolioCpcCeilingMicros: 10_000,
    maxPortfolioCpcCeilingMicros: 10_000_000,
    allowSharedBudgets: false,
    managePortfolioBidBounds: true,
    mode,
  });
}

describe("CORTEX bidding durable runtime control", () => {
  it("persists observe-only and kill transitions with an auditable CAS history", () => {
    const store = new InMemoryOntologyTransactionStore();
    let now = Date.parse("2026-09-05T22:00:00.000Z");
    const active = policy();
    const control = new BiddingRuntimeController(store, scope, active.digest, active.mode, () => now);
    expect(control.current()).toMatchObject({ mode: "ACTIVE", revision: 0 });

    const observe = control.set({ expectedRevision: 0, mode: "OBSERVE_ONLY", reason: "operator observation window before changing bids" });
    expect(observe).toMatchObject({ mode: "OBSERVE_ONLY", revision: 1 });
    now += 1_000;
    const killed = control.set({ expectedRevision: 1, mode: "KILLED", reason: "emergency stop during upstream incident" });
    expect(killed).toMatchObject({ mode: "KILLED", revision: 2 });
    expect(control.history()).toMatchObject([
      { fromMode: "ACTIVE", toMode: "OBSERVE_ONLY", targetRevision: 1 },
      { fromMode: "OBSERVE_ONLY", toMode: "KILLED", targetRevision: 2 },
    ]);
    expect(() => control.set({ expectedRevision: 1, mode: "ACTIVE", reason: "stale write" })).toThrow(BiddingRuntimeControlError);
  });

  it("keeps a kill effective after the supervisor policy digest rotates", () => {
    const store = new InMemoryOntologyTransactionStore();
    const first = policy("ACTIVE", "v1");
    const firstControl = new BiddingRuntimeController(store, scope, first.digest, first.mode);
    firstControl.set({ expectedRevision: 0, mode: "KILLED", reason: "operator kill before bidding policy rollout" });

    const second = policy("ACTIVE", "v2");
    const rotated = new BiddingRuntimeController(store, scope, second.digest, second.mode);
    expect(rotated.current()).toMatchObject({ mode: "KILLED", revision: 1, policyDigest: first.digest });
    expect(rotated.effectiveMode()).toBe("KILLED");
    expect(rotated.history()).toMatchObject([{ policyDigest: first.digest, toMode: "KILLED", targetRevision: 1 }]);

    const reactivated = rotated.set({ expectedRevision: 1, mode: "ACTIVE", reason: "operator reactivation after policy rollout validation" });
    expect(reactivated).toMatchObject({ mode: "ACTIVE", revision: 2, policyDigest: second.digest });
  });

  it("cannot reactivate a policy configured as observe-only", () => {
    const store = new InMemoryOntologyTransactionStore();
    const observePolicy = policy("OBSERVE_ONLY");
    const control = new BiddingRuntimeController(store, scope, observePolicy.digest, observePolicy.mode);
    expect(() => control.set({ expectedRevision: 0, mode: "ACTIVE", reason: "attempt to weaken configured safety mode" }))
      .toThrow(/cannot weaken configured mode/i);
  });
});
