import { describe, expect, it } from "vitest";
import { certifyDelivery, requiredDeliveryGateIds, requiredRedTeamAttackIds, type DeliveryGateEvidence } from "../delivery-certification";
import type { ExcessRemovalReport } from "../excess-removal";
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
  attacks: requiredRedTeamAttackIds().map((attackId) => ({ attackId, verdict: "PASS", detail: `${attackId} passed`, evidence: [`attack:${attackId}`] })),
  similarityReports: [],
};

const excessRemoval: ExcessRemovalReport = {
  authority: "NEXUS_EXCESS_REMOVAL_GATE",
  verdict: "PASS",
  findings: [{
    elementId: "fixture-purposeful-element",
    verdict: "PASS",
    code: "PURPOSE_SUPPORTED",
    message: "Removal caused meaningful loss; evidence supports the declared purpose.",
    evidenceIds: ["excess:remove:fixture-purposeful-element"],
  }],
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
  it("certifies only when every required gate and hostile quality authority passes", () => {
    const report = certifyDelivery({ projectId: "fixture", sourceRevision: SHA, gates: passingGates(), visualJudge, redTeam, excessRemoval, qualityCycle });
    expect(report.verdict).toBe("PASS");
    expect(report.certified).toBe(true);
    expect(report.blockers).toEqual([]);
  });

  it("treats any missing required gate as NOT_TESTED rather than pretending a build is deliverable", () => {
    const gates = passingGates().filter((gate) => gate.gateId !== "CAPTURE");
    const report = certifyDelivery({ projectId: "fixture", sourceRevision: SHA, gates, visualJudge, redTeam, excessRemoval, qualityCycle });
    expect(report.verdict).toBe("NOT_TESTED");
    expect(report.certified).toBe(false);
    expect(report.blockers.some((blocker) => blocker.startsWith("CAPTURE:NOT_TESTED"))).toBe(true);
  });

  it("rejects a claimed visual PASS without a real bound Visual Judge report", () => {
    const report = certifyDelivery({ projectId: "fixture", sourceRevision: SHA, gates: passingGates(), redTeam, excessRemoval, qualityCycle });
    expect(report.verdict).toBe("FAIL");
    expect(report.certified).toBe(false);
    expect(report.blockers).toContain("VISUAL_JUDGE claimed PASS without an approved NEXUS Visual Judge report");
  });

  it("rejects an incomplete Red Team even when the supplied subset all PASS", () => {
    const incomplete = { ...redTeam, attacks: redTeam.attacks.slice(0, 2) };
    const report = certifyDelivery({ projectId: "fixture", sourceRevision: SHA, gates: passingGates(), visualJudge, redTeam: incomplete, excessRemoval, qualityCycle });
    expect(report.verdict).toBe("FAIL");
    expect(report.certified).toBe(false);
    expect(report.blockers).toContain("RED_TEAM claimed PASS without the complete mandatory hostile attack set plus a passing evidence-backed Excess Removal gate");
  });

  it("rejects Red Team PASS when Excess Removal evidence is absent", () => {
    const report = certifyDelivery({ projectId: "fixture", sourceRevision: SHA, gates: passingGates(), visualJudge, redTeam, qualityCycle });
    expect(report.verdict).toBe("FAIL");
    expect(report.certified).toBe(false);
  });

  it("rejects empty or untested excess-removal reports", () => {
    const empty: ExcessRemovalReport = { authority: "NEXUS_EXCESS_REMOVAL_GATE", verdict: "NOT_TESTED", findings: [] };
    const report = certifyDelivery({ projectId: "fixture", sourceRevision: SHA, gates: passingGates(), visualJudge, redTeam, excessRemoval: empty, qualityCycle });
    expect(report.verdict).toBe("FAIL");
    expect(report.certified).toBe(false);
  });

  it("does not certify WARNING or NOT_TESTED states", () => {
    const gates = passingGates();
    const generation = gates.find((gate) => gate.gateId === "GENERATION")!;
    generation.verdict = "WARNING";
    const report = certifyDelivery({ projectId: "fixture", sourceRevision: SHA, gates, visualJudge, redTeam, excessRemoval, qualityCycle });
    expect(report.verdict).toBe("WARNING");
    expect(report.certified).toBe(false);
  });
});
