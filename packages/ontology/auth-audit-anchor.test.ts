import { describe, expect, it } from "vitest";
import {
  AnchoredAuditTrail,
  InMemoryAuditAnchor,
  InMemoryAuditTrail,
  type AuditInput,
  type AuditTrailCheckpoint,
  type IndependentAuditAnchorPort,
} from "./auth-audit";

const scope = { tenantId: "tenant-a", organizationId: "org-a", brandId: "brand-a" } as const;

function input(actionId: string, occurredAt: string): AuditInput {
  return {
    occurredAt,
    principalId: "principal-a",
    scope,
    actionId,
    decision: "ALLOW",
    reason: "test",
    risk: "LOW",
    policyVersion: "v1",
  };
}

describe("independently anchored audit trail", () => {
  it("fails verification when the local ledger is rewritten and re-hashed without changing the anchor", () => {
    const ledger = new InMemoryAuditTrail();
    const anchors = new InMemoryAuditAnchor();
    const trail = new AnchoredAuditTrail(ledger, anchors, () => "2026-08-16T00:00:00.000Z");

    trail.append(input("action.one", "2026-08-16T00:00:01.000Z"));
    trail.append(input("action.two", "2026-08-16T00:00:02.000Z"));
    expect(trail.verify(scope)).toBe(true);

    const forged = new InMemoryAuditTrail();
    forged.append(input("action.rewritten", "2026-08-16T00:00:01.000Z"));
    forged.append(input("action.two", "2026-08-16T00:00:02.000Z"));

    // Simulate an attacker with complete control of the ledger store, including
    // the ability to recompute a perfectly valid local hash chain.
    ledger.restore(forged.checkpoint());
    expect(ledger.verify(scope)).toBe(true);
    expect(trail.verify(scope)).toBe(false);
  });

  it("rolls the local append back when the independent anchor cannot be published", () => {
    const ledger = new InMemoryAuditTrail();
    const unavailableAnchor: IndependentAuditAnchorPort = {
      publish: () => { throw new Error("remote WORM store unavailable"); },
      latest: () => undefined,
    };
    const trail = new AnchoredAuditTrail(ledger, unavailableAnchor, () => "2026-08-16T00:00:00.000Z");
    const before: AuditTrailCheckpoint = ledger.checkpoint();

    expect(() => trail.append(input("action.one", "2026-08-16T00:00:01.000Z"))).toThrow(/rolled back/);
    expect(ledger.checkpoint()).toEqual(before);
  });
});
