import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { discoverClientApps, robustFleetAnomalies } from "./client-fleet.mjs";

const roots = [];
afterEach(() => { while (roots.length) rmSync(roots.pop(), { recursive: true, force: true }); });

describe("client fleet", () => {
  it("never classifies seed, reference or probe apps as clients", () => {
    const root = mkdtempSync(join(tmpdir(), "nexus-fleet-")); roots.push(root);
    for (const name of ["_experience-seed", "reference-alfil", "v2-probe-editorial", "cano-legal", "zona-dental"]) mkdirSync(join(root, "apps", name), { recursive: true });
    expect(discoverClientApps(root)).toEqual(["cano-legal", "zona-dental"]);
  });

  it("requires fleet evidence instead of inventing an anomaly verdict", () => {
    expect(robustFleetAnomalies([{ projectId: "a", lcpP75Ms: 1000, inpP75Ms: 80, clsP75: 0.01 }])).toMatchObject({ verdict: "INSUFFICIENT_EVIDENCE", sampleCount: 1 });
  });

  it("detects a robust outlier against peer behavior", () => {
    const samples = [
      { projectId: "a", lcpP75Ms: 1000, inpP75Ms: 80, clsP75: 0.01 },
      { projectId: "b", lcpP75Ms: 1050, inpP75Ms: 82, clsP75: 0.011 },
      { projectId: "c", lcpP75Ms: 980, inpP75Ms: 79, clsP75: 0.009 },
      { projectId: "d", lcpP75Ms: 1010, inpP75Ms: 81, clsP75: 0.012 },
      { projectId: "outlier", lcpP75Ms: 4000, inpP75Ms: 600, clsP75: 0.2 },
    ];
    const result = robustFleetAnomalies(samples);
    expect(result.verdict).toBe("ANOMALY_DETECTED");
    expect(result.anomalies.some((anomaly) => anomaly.projectId === "outlier" && anomaly.metric === "lcpP75Ms")).toBe(true);
  });
});
