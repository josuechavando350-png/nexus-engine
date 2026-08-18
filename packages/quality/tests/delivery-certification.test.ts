import { describe, expect, it } from "vitest";
import { certifyDelivery, requiredDeliveryGateIds, type DeliveryGateEvidence } from "../delivery-certification";
import type { QualityCycleResult } from "../quality-cycle";
import type { RedTeamArenaReport } from "../red-team";
import type { VisualJudgeResult } from "../visual-judge";

const SHA = "a".repeat(40);

function passingGates(): DeliveryGateEvidence[] {
  return requiredDeliveryGateIds().map((gateId) => ({ gateId, verdict: "PASS", detail: `${gateId} executed on exact revision`, evidenceIds: [`evidence:${gateId}`] }));
}

const visualJudge: VisualJudgeResult = {
  authority: "NEXUS_VISUAL_JUDGE",
  verdict: "PASS",
  approved: true,
  integrityVerdict: "PASS",
  reviewVerdict: "PASS",
  findings: [],
  verifiedArtifactIds: ["capture:desktop"],
};

const redTeam: RedTeamArenaReport = {
  authority: "NEXUS_RED_TEAM_ARENA",
  experienceId: "fixture",
  verdict: "PASS",
  approved: true,
  attacks: [{ attackId: "CREATIVE_CRITIC", verdict: "PASS", detail: "passed", evidence: ["critic:1"] }],
  similarityReports: [],
};

const qualityCycle: QualityCycleResult = {
  authority: "NEXUS_BOUNDED_REPAIR_LOOP",
  status: "SHIPPABLE",
  finalEvaluation: { verdict: "PASS", findings: [], evidenceIds: ["judge:final"] },
  iterations: [],
  snapshots: [],
  repairLineage: [],
};

describe("delivery certification", () => {
  it("certifies only when every required gate and bound quality authority passes", () => {
    const report = certifyDelivery({ projectId: "fixture", sourceRevision: SHA, gates: passingGates(), visualJudge, redTeam, qualityCycle });
    expect(report.verdict).toBe("PASS");
    expect(report.certified).toBe(true);
    expect(report.blockers).toEqual([]);
  });

  it("treats any missing required gate as NOT_TESTED rather than pretending a build is deliverable", () => {
    const gates = passingGates().filter((gate) => gate.gateId !== "CAPTURE");
    const report = certifyDelivery({ projectId: "fixture", sourceRevision: SHA, gates, visualJudge, redTeam, qualityCycle });
    expect(report.verdict).toBe("NOT_TESTED");
    expect(report.certified).toBe(false);
    expect(report.blockers.some((blocker) => blocker.startsWith("CAPTURE:NOT_TESTED"))).toBe(true);
  });

  it("rejects a claimed visual PASS without a real bound Visual Judge report", () => {
    const report = certifyDelivery({ projectId: "fixture", sourceRevision: SHA, gates: passingGates(), redTeam, qualityCycle });
    expect(report.verdict).toBe("FAIL");
    expect(report.certified).toBe(false);
    expect(report.blockers).toContain("VISUAL_JUDGE claimed PASS without an approved NEXUS Visual Judge report");
  });

  it("does not certify WARNING or NOT_TESTED states", () => {
    const gates = passingGates();
    const generation = gates.find((gate) => gate.gateId === "GENERATION")!;
    generation.verdict = "WARNING";
    const report = certifyDelivery({ projectId: "fixture", sourceRevision: SHA, gates, visualJudge, redTeam, qualityCycle });
    expect(report.verdict).toBe("WARNING");
    expect(report.certified).toBe(false);
  });
});
