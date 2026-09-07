import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CapabilityGatedGeoExperimentRegistry, SqliteGeoCapabilityGateStore, evaluateGeoCapabilityGate } from "./capability-gate";
import { SqliteGeoExperimentRegistry } from "./registry";

let roots: string[] = [];
afterEach(() => { for (const root of roots) rmSync(root, { recursive: true, force: true }); roots = []; });

function design(experimentId = "geo-capability-0001") {
  return {
    experimentId,
    seed: "geo-capability-seed-0000000001",
    holdoutFraction: 0.2,
    maxBaselineImbalance: 0.1,
    minGeosPerArm: 10,
    geos: Array.from({ length: 100 }, (_, index) => ({ geoId: `geo-${String(index).padStart(3, "0")}`, baselineOutcome: 1_000 + index })),
  };
}
function input(lift = 0.05, experimentId = "geo-capability-0001") {
  return { design: design(experimentId), minimumDetectableRelativeLift: lift, targetPower: 0.8, alpha: 0.05, varianceInflation: 1.25, minimumBaselineTotal: 50_000 };
}

describe("CORTEX #32 geo capability gating", () => {
  it("allows a sufficiently powered preregistered geo design and exposes reproducible evidence", () => {
    const result = evaluateGeoCapabilityGate(input(0.05));
    expect(result.status).toBe("ALLOWED");
    expect(result.reason).toBe("POWER_SUFFICIENT");
    expect(result.treatmentGeos).toBe(80);
    expect(result.controlGeos).toBe(20);
    expect(result.achievedPower).toBeGreaterThanOrEqual(0.8);
    expect(result.gateDigest).toMatch(/^sha256:[a-f0-9]{64}$/u);
    expect(evaluateGeoCapabilityGate(input(0.05))).toEqual(result);
  });

  it("blocks underpowered experiments before the #12 registry can create them", () => {
    const root = mkdtempSync(join(tmpdir(), "cortex32-")); roots.push(root);
    const db = join(root, "geo.sqlite");
    const base = new SqliteGeoExperimentRegistry(db);
    const gates = new SqliteGeoCapabilityGateStore(db);
    const registry = new CapabilityGatedGeoExperimentRegistry(base, gates);
    expect(() => registry.register(input(0.001, "geo-underpowered-0001"))).toThrow(/capability blocked/u);
    expect(base.get("geo-underpowered-0001")).toBeUndefined();
    expect(gates.get("geo-underpowered-0001")?.reason).toBe("POWER_INSUFFICIENT");
    gates.close(); base.close();
  });

  it("persists the exact gate and refuses to reuse an experimentId with different statistical assumptions", () => {
    const root = mkdtempSync(join(tmpdir(), "cortex32-")); roots.push(root);
    const db = join(root, "geo.sqlite");
    const base = new SqliteGeoExperimentRegistry(db);
    const gates = new SqliteGeoCapabilityGateStore(db);
    const registry = new CapabilityGatedGeoExperimentRegistry(base, gates);
    const first = registry.register(input(0.05, "geo-immutable-0001"));
    expect(first.experiment.design.designDigest).toBe(first.gate.designDigest);
    expect(() => registry.register(input(0.06, "geo-immutable-0001"))).toThrow(/different capability gate/u);
    gates.close(); base.close();
  });
});
