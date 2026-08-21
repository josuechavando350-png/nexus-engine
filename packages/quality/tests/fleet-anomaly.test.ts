import { describe, expect, it } from "vitest";
import { analyzeFleetAnomalies } from "../fleet-anomaly";

describe("fleet anomaly analysis", () => {
  it("refuses to manufacture fleet telemetry without client evidence", () => {
    expect(analyzeFleetAnomalies([])).toEqual({
      authority: "NEXUS_FLEET_ANOMALY_V1",
      status: "NOT_TESTED",
      projectCount: 0,
      anomalies: [],
      reason: "NO_CLIENT_TELEMETRY",
    });
  });

  it("requires a real fleet before statistical comparison", () => {
    const report = analyzeFleetAnomalies([
      { projectId: "a", metric: "LCP_P75", value: 1000 },
      { projectId: "b", metric: "LCP_P75", value: 1100 },
    ]);
    expect(report.status).toBe("INSUFFICIENT_EVIDENCE");
    expect(report.reason).toBe("AT_LEAST_5_CLIENT_PROJECTS_REQUIRED");
  });

  it("detects a fleet-relative outlier using median absolute deviation", () => {
    const report = analyzeFleetAnomalies([
      { projectId: "a", metric: "LCP_P75", value: 1000 },
      { projectId: "b", metric: "LCP_P75", value: 1010 },
      { projectId: "c", metric: "LCP_P75", value: 1020 },
      { projectId: "d", metric: "LCP_P75", value: 1030 },
      { projectId: "e", metric: "LCP_P75", value: 3000 },
    ]);
    expect(report.status).toBe("MEASURED");
    expect(report.anomalies.find((item) => item.projectId === "e")?.status).toBe("ANOMALOUS");
    expect(report.anomalies.find((item) => item.projectId === "c")?.status).toBe("NORMAL");
  });
});
