import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { SqliteGeoExperimentRegistry } from "./registry";

const dirs: string[] = [];
function path(): string {
  const dir = mkdtempSync(join(tmpdir(), "nexus-cortex12-registry-"));
  dirs.push(dir);
  return join(dir, "experiments.sqlite");
}
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

const geos = Array.from({ length: 20 }, (_, index) => ({ geoId: `geo-${String(index + 1).padStart(4, "0")}`, baselineOutcome: 1_000 + index * 10 }));
const designInput = {
  experimentId: "experiment-geo-001",
  seed: "seed-with-at-least-sixteen-chars",
  holdoutFraction: 0.4,
  maxBaselineImbalance: 0.2,
  minGeosPerArm: 3,
  geos,
} as const;

describe("CORTEX #12 durable experiment registry", () => {
  it("persists a READY randomized design and makes experiment identity immutable", () => {
    const registry = new SqliteGeoExperimentRegistry(path(), () => Date.parse("2026-09-06T12:00:00.000Z"));
    const first = registry.registerDesign(designInput);
    expect(first.design.status).toBe("READY");
    expect(first.design.minGeosPerArm).toBe(3);
    expect(registry.registerDesign(designInput)).toEqual(first);
    expect(() => registry.registerDesign({ ...designInput, seed: "different-seed-with-sixteen-chars" })).toThrowError(/different geo design/u);
    registry.close();
  });

  it("commits one immutable analysis tied to the exact preregistered design digest", () => {
    const registry = new SqliteGeoExperimentRegistry(path(), () => Date.parse("2026-09-06T12:00:00.000Z"));
    const record = registry.registerDesign(designInput);
    const outcomes = record.design.assignments.map((assignment, index) => ({
      geoId: assignment.geoId,
      baselineOutcome: assignment.baselineOutcome,
      experimentOutcome: assignment.baselineOutcome + (assignment.arm === "TREATMENT" ? 100 + index : 10 + index),
    }));
    const analyzed = registry.analyze(record.experimentId, outcomes);
    expect(analyzed.analysis?.designDigest).toBe(record.design.designDigest);
    expect(registry.analyze(record.experimentId, outcomes).analysis).toEqual(analyzed.analysis);
    const drifted = outcomes.map((row, index) => index === 0 ? { ...row, experimentOutcome: row.experimentOutcome + 5 } : row);
    expect(() => registry.analyze(record.experimentId, drifted)).toThrowError(/immutable/u);
    registry.close();
  });

  it("survives restart with design and analysis provenance intact", () => {
    const db = path();
    const first = new SqliteGeoExperimentRegistry(db, () => Date.parse("2026-09-06T12:00:00.000Z"));
    const record = first.registerDesign(designInput);
    const outcomes = record.design.assignments.map((assignment) => ({ geoId: assignment.geoId, baselineOutcome: assignment.baselineOutcome, experimentOutcome: assignment.baselineOutcome + 20 }));
    const analyzed = first.analyze(record.experimentId, outcomes);
    first.close();
    const reopened = new SqliteGeoExperimentRegistry(db);
    expect(reopened.get(record.experimentId)).toEqual(analyzed);
    reopened.close();
  });

  it("refuses rejected designs instead of persisting an invalid experiment", () => {
    const registry = new SqliteGeoExperimentRegistry(path());
    const extreme = geos.map((geo, index) => ({ ...geo, baselineOutcome: index < 10 ? 1 : 1_000_000 + index }));
    expect(() => registry.registerDesign({ ...designInput, maxBaselineImbalance: 0, geos: extreme })).toThrowError(/not READY/u);
    expect(registry.get(designInput.experimentId)).toBeUndefined();
    registry.close();
  });

  it("checks the runtime mutation guard immediately before durable writes", () => {
    let active = false;
    const registry = new SqliteGeoExperimentRegistry(path(), Date.now, () => active);
    expect(() => registry.registerDesign(designInput)).toThrowError(/runtime mode blocks/u);
    expect(registry.get(designInput.experimentId)).toBeUndefined();
    active = true;
    const registered = registry.registerDesign(designInput);
    const outcomes = registered.design.assignments.map((assignment) => ({ geoId: assignment.geoId, baselineOutcome: assignment.baselineOutcome, experimentOutcome: assignment.baselineOutcome + 5 }));
    active = false;
    expect(() => registry.analyze(registered.experimentId, outcomes)).toThrowError(/runtime mode blocks/u);
    expect(registry.get(registered.experimentId)?.analysis).toBeNull();
    registry.close();
  });
});
