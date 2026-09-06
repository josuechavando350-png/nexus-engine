import { describe, expect, it } from "vitest";
import { Cortex12Error, analyzeGeoHoldout, designGeoHoldout, verifyGeoHoldoutDesign } from "./index";

const geos = Array.from({ length: 20 }, (_, index) => ({ geoId: `geo-${String(index + 1).padStart(4, "0")}`, baselineOutcome: 1_000 + index * 10 }));
const designInput = {
  experimentId: "experiment-geo-001",
  seed: "seed-with-at-least-sixteen-chars",
  holdoutFraction: 0.4,
  maxBaselineImbalance: 0.2,
  minGeosPerArm: 3,
  geos,
} as const;

describe("CORTEX #12 geo holdout design", () => {
  it("produces deterministic stratified assignments and binds the preregistered analysis plan", () => {
    const first = designGeoHoldout(designInput);
    const second = designGeoHoldout(designInput);
    expect(first).toEqual(second);
    expect(first.status).toBe("READY");
    expect(first.minGeosPerArm).toBe(3);
    expect(first.maxBaselineImbalance).toBe(0.2);
    expect(first.seedDigest).toMatch(/^sha256:[0-9a-f]{64}$/u);
    expect(JSON.stringify(first)).not.toContain(designInput.seed);
    expect(first.assignments.filter((row) => row.arm === "CONTROL").length).toBe(Math.round(geos.length * designInput.holdoutFraction));
    expect(first.assignments.filter((row) => row.arm === "TREATMENT").length).toBe(geos.length - Math.round(geos.length * designInput.holdoutFraction));
    expect(first.designDigest).toMatch(/^sha256:[0-9a-f]{64}$/u);
    expect(verifyGeoHoldoutDesign(first)).toEqual(first);
  });

  it("honors the requested holdout fraction across a non-default allocation", () => {
    const result = designGeoHoldout({ ...designInput, holdoutFraction: 0.2 });
    expect(result.assignments.filter((row) => row.arm === "CONTROL")).toHaveLength(4);
    expect(verifyGeoHoldoutDesign(result)).toEqual(result);
  });

  it("rejects duplicate geos and represents an impossible sample plan without fabricating imbalance", () => {
    expect(() => designGeoHoldout({ ...designInput, geos: [...geos, geos[0]!] })).toThrowError(/duplicated/u);
    const impossible = designGeoHoldout({ ...designInput, minGeosPerArm: 9 });
    expect(impossible.status).toBe("REJECTED");
    expect(impossible.reason).toBe("INSUFFICIENT_ARM_SIZE");
    expect(impossible.baselineImbalance).toBeNull();
    expect(verifyGeoHoldoutDesign(impossible)).toEqual(impossible);
  });

  it("rejects excessive baseline imbalance explicitly", () => {
    const extreme = geos.map((geo, index) => ({ ...geo, baselineOutcome: index < 10 ? 1 : 1_000_000 + index }));
    const result = designGeoHoldout({ ...designInput, maxBaselineImbalance: 0, geos: extreme });
    expect(result.status).toBe("REJECTED");
    expect(result.reason).toBe("BASELINE_IMBALANCE");
    expect(result.baselineImbalance).not.toBeNull();
  });

  it("detects mutation of assignments, preregistered thresholds or rejection semantics", () => {
    const design = designGeoHoldout(designInput);
    expect(() => verifyGeoHoldoutDesign({ ...design, minGeosPerArm: 4 })).toThrowError(/digest mismatch/u);
    expect(() => verifyGeoHoldoutDesign({ ...design, assignments: design.assignments.map((item, index) => index === 0 ? { ...item, baselineOutcome: item.baselineOutcome + 1 } : item) })).toThrowError(/digest mismatch/u);
    expect(() => verifyGeoHoldoutDesign({ ...design, status: "REJECTED", reason: "INSUFFICIENT_ARM_SIZE", baselineImbalance: null })).toThrowError(Cortex12Error);
    const changedArm = design.assignments.map((item, index) => index === 0 ? { ...item, arm: item.arm === "CONTROL" ? "TREATMENT" as const : "CONTROL" as const } : item);
    expect(() => verifyGeoHoldoutDesign({ ...design, assignments: changedArm })).toThrowError(Cortex12Error);
  });
});

describe("CORTEX #12 incrementality analysis", () => {
  it("computes difference-in-differences with Welch uncertainty from assigned geos only", () => {
    const design = designGeoHoldout(designInput);
    const outcomes = design.assignments.map((assignment, index) => ({
      geoId: assignment.geoId,
      baselineOutcome: assignment.baselineOutcome,
      experimentOutcome: assignment.baselineOutcome + (assignment.arm === "TREATMENT" ? 120 + index : 10 + index),
    }));
    const result = analyzeGeoHoldout({ design, outcomes });
    expect(result.incrementalDelta).toBeGreaterThan(90);
    expect(result.treatmentGeos + result.controlGeos).toBe(20);
    expect(result.confidenceInterval95).toHaveLength(2);
    expect(["POSITIVE", "INCONCLUSIVE"]).toContain(result.verdict);
  });

  it("fails closed if assignment provenance or baseline is violated", () => {
    const design = designGeoHoldout(designInput);
    const outcomes = design.assignments.map((assignment) => ({ geoId: assignment.geoId, baselineOutcome: assignment.baselineOutcome, experimentOutcome: assignment.baselineOutcome + 10 }));
    const tampered = { ...design, assignments: design.assignments.map((item, index) => index === 0 ? { ...item, arm: item.arm === "CONTROL" ? "TREATMENT" as const : "CONTROL" as const } : item) };
    expect(() => analyzeGeoHoldout({ design: tampered, outcomes })).toThrowError(Cortex12Error);
    expect(() => analyzeGeoHoldout({ design, outcomes: outcomes.map((item, index) => index === 0 ? { ...item, baselineOutcome: item.baselineOutcome + 1 } : item) })).toThrowError(/baseline outcome changed/u);
    expect(() => analyzeGeoHoldout({ design, outcomes, minGeosPerArm: 1 })).toThrowError(/unsupported fields/u);
  });
});
