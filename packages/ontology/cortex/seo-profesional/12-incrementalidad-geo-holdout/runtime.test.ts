import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { GeoAssignment, GeoOutcome } from "../../geo-holdout/index.js";
import { createSeoGeoIncrementalityPolicy } from "./contracts.js";
import { createSqliteSeoGeoIncrementalityRuntime } from "./sqlite-runtime.js";

const roots: string[] = [];
afterEach(() => { while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true }); });

function durableRuntime(customer = "1234567890") {
  const root = mkdtempSync(join(tmpdir(), "nexus-seo12-"));
  roots.push(root);
  return createSqliteSeoGeoIncrementalityRuntime({
    databasePath: join(root, "geo.sqlite"),
    policy: createSeoGeoIncrementalityPolicy({ operatorWebsiteOrigin: "https://example.test", googleAdsCustomerId: customer }),
    now: () => Date.parse("2026-09-08T12:00:00.000Z"),
  });
}

function design(runtime: ReturnType<typeof durableRuntime>, experimentKey: string) {
  return runtime.runtime.registerDesign({
    experimentKey,
    operatorWebsiteOrigin: "https://example.test",
    googleAdsCustomerId: "1234567890",
    seed: "deterministic-seed-for-seo12",
    holdoutFraction: 0.5,
    maxBaselineImbalance: 0,
    minGeosPerArm: 3,
    geos: Array.from({ length: 8 }, (_, index) => ({ geoId: `geo-${index + 1}`, baselineOutcome: 100 })),
  });
}

function outcomes(assignments: readonly GeoAssignment[], treatmentDelta: number, controlDelta: number): readonly GeoOutcome[] {
  return assignments.map((assignment) => Object.freeze({
    geoId: assignment.geoId,
    baselineOutcome: assignment.baselineOutcome,
    experimentOutcome: assignment.baselineOutcome + (assignment.arm === "TREATMENT" ? treatmentDelta : controlDelta),
  }));
}

describe("SEO Profesional #12 geo incrementality", () => {
  it("reuses the durable CORTEX #12 registry and binds experiment ids to operator/customer scope", () => {
    const composed = durableRuntime();
    composed.control.setMode("ACTIVE", 0);
    const registration = design(composed, "campaign-lift-001");
    expect(registration.experimentId).toMatch(/^seo12:[0-9a-f]{16}:campaign-lift-001$/u);
    expect(registration.design.status).toBe("READY");
    expect(composed.registry.get(registration.experimentId)?.design.designDigest).toBe(registration.design.designDigest);
    composed.close();
  });

  it("allows #2 optimization only for a statistically positive committed analysis", () => {
    const composed = durableRuntime();
    composed.control.setMode("ACTIVE", 0);
    const registration = design(composed, "positive-lift-001");
    const decision = composed.runtime.analyze({
      experimentKey: "positive-lift-001",
      operatorWebsiteOrigin: "https://example.test",
      googleAdsCustomerId: "1234567890",
      outcomes: outcomes(registration.design.assignments, 20, 0),
    });
    expect(decision.analysis.verdict).toBe("POSITIVE");
    expect(decision.analysis.confidenceInterval95[0]).toBeGreaterThan(0);
    expect(decision.gate).toBe("ALLOW_OPTIMIZATION");
    composed.close();
  });

  it("holds inconclusive evidence and blocks statistically negative regressions", () => {
    const composed = durableRuntime();
    composed.control.setMode("ACTIVE", 0);
    const inconclusive = design(composed, "inconclusive-001");
    expect(composed.runtime.analyze({ experimentKey: "inconclusive-001", operatorWebsiteOrigin: "https://example.test", googleAdsCustomerId: "1234567890", outcomes: outcomes(inconclusive.design.assignments, 10, 10) }).gate).toBe("HOLD");
    const negative = design(composed, "negative-lift-001");
    const negativeDecision = composed.runtime.analyze({ experimentKey: "negative-lift-001", operatorWebsiteOrigin: "https://example.test", googleAdsCustomerId: "1234567890", outcomes: outcomes(negative.design.assignments, 0, 20) });
    expect(negativeDecision.analysis.verdict).toBe("NEGATIVE");
    expect(negativeDecision.gate).toBe("BLOCK_REGRESSION");
    composed.close();
  });

  it("fails closed when durable CORTEX #12 control is not ACTIVE", () => {
    const composed = durableRuntime();
    expect(() => design(composed, "blocked-control-001")).toThrow(/runtime mode blocks durable geo design registration/u);
    composed.control.setMode("OBSERVE_ONLY", 0);
    expect(() => design(composed, "blocked-observe-001")).toThrow(/runtime mode blocks durable geo design registration/u);
    composed.close();
  });

  it("rejects cross-customer/cross-origin reuse before registry access", () => {
    const composed = durableRuntime();
    composed.control.setMode("ACTIVE", 0);
    expect(() => composed.runtime.registerDesign({
      experimentKey: "wrong-scope-001",
      operatorWebsiteOrigin: "https://other.example",
      googleAdsCustomerId: "1234567890",
      seed: "deterministic-seed-for-seo12",
      holdoutFraction: 0.5,
      maxBaselineImbalance: 0,
      minGeosPerArm: 3,
      geos: Array.from({ length: 8 }, (_, index) => ({ geoId: `geo-${index + 1}`, baselineOutcome: 100 })),
    })).toThrow(/does not match the configured operator\/customer scope/u);
    expect(() => composed.runtime.analyze({ experimentKey: "wrong-scope-001", operatorWebsiteOrigin: "https://example.test", googleAdsCustomerId: "0000000000", outcomes: [] })).toThrow(/does not match the configured operator\/customer scope/u);
    composed.close();
  });

  it("inherits CORTEX #12 baseline integrity checks instead of accepting rewritten pre-period data", () => {
    const composed = durableRuntime();
    composed.control.setMode("ACTIVE", 0);
    const registration = design(composed, "baseline-tamper-001");
    const tampered = outcomes(registration.design.assignments, 20, 0).map((row, index) => index === 0 ? { ...row, baselineOutcome: row.baselineOutcome + 1 } : row);
    expect(() => composed.runtime.analyze({ experimentKey: "baseline-tamper-001", operatorWebsiteOrigin: "https://example.test", googleAdsCustomerId: "1234567890", outcomes: tampered })).toThrow(/baseline outcome changed after randomization/u);
    composed.close();
  });
});
