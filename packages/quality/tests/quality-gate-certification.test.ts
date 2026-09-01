import { describe, expect, it } from "vitest";
import { certifyQualityGatesForDelivery, requiredDeliveryGateIds, requiredRedTeamAttackIds, type DeliveryGateEvidence } from "../quality-gate-certification";
import type { ExcessRemovalReport } from "../excess-removal";
import type { QualityCycleResult } from "../quality-cycle";
import type { RedTeamArenaReport } from "../red-team";
import type { VisualJudgeResult } from "../visual-judge";

const SHA = "a".repeat(40);
const CYCLE_EVIDENCE = [
  { evidenceId: "cycle:build", stage: "BUILD" as const, subjectRevision: SHA, producedAt: "2026-09-01T00:00:00.000Z" },
  { evidenceId: "cycle:capture", stage: "CAPTURE" as const, subjectRevision: SHA, producedAt: "2026-09-01T00:00:01.000Z" },
  { evidenceId: "cycle:judge", stage: "JUDGE" as const, subjectRevision: SHA, producedAt: "2026-09-01T00:00:02.000Z" },
];
const CYCLE_EVIDENCE_IDS = CYCLE_EVIDENCE.map((item) => item.evidenceId);

function passingGates(): DeliveryGateEvidence[] {
  return requiredDeliveryGateIds().map((gateId) => ({
    gateId,
    verdict: "PASS",
    detail: `${gateId} executed on exact revision`,
    evidenceIds: gateId === "REPAIR_REJUDGE" ? [...CYCLE_EVIDENCE_IDS] : [`evidence:${gateId}`],
  }));
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

const cycleEvaluation = { verdict: "PASS" as const, findings: [], evidenceIds: CYCLE_EVIDENCE_IDS };
const qualityCycle: QualityCycleResult = {
  authority: "NEXUS_BOUNDED_REPAIR_LOOP",
  status: "SHIPPABLE",
  finalEvaluation: cycleEvaluation,
  iterations: [],
  snapshots: [{
    revision: SHA,
    evaluation: cycleEvaluation,
    evidence: CYCLE_EVIDENCE,
    judgeCriterion: { rubricVersion: "quality-v1", rubricDigest: "b".repeat(64) },
  }],
  repairLineage: [],
};

describe("delivery certification", () => {
  it("certifies only when every required gate and hostile quality authority passes on one exact revision", () => {
    const report = certifyQualityGatesForDelivery({ projectId: "fixture", sourceRevision: SHA, gates: passingGates(), visualJudge, redTeam, excessRemoval, qualityCycle });
    expect(report.verdict).toBe("PASS");
    expect(report.certified).toBe(true);
    expect(report.blockers).toEqual([]);
  });

  it("refuses a quality cycle that advanced to another revision without restarting the full delivery pipeline", () => {
    const repairedSha = "b".repeat(40);
    const mixed: QualityCycleResult = {
      ...qualityCycle,
      finalEvaluation: { verdict: "PASS", findings: [], evidenceIds: ["r2:build", "r2:capture", "r2:judge"] },
      iterations: [{
        attempt: 1,
        before: { verdict: "FAIL", findings: ["weak hierarchy"], evidenceIds: CYCLE_EVIDENCE_IDS },
        action: { summary: "changed source", changedFiles: ["src/page.tsx"], evidenceIds: ["patch:r2"] },
        after: { verdict: "PASS", findings: [], evidenceIds: ["r2:build", "r2:capture", "r2:judge"] },
      }],
      snapshots: [
        ...qualityCycle.snapshots,
        {
          revision: repairedSha,
          evaluation: { verdict: "PASS", findings: [], evidenceIds: ["r2:build", "r2:capture", "r2:judge"] },
          evidence: [
            { evidenceId: "r2:build", stage: "BUILD", subjectRevision: repairedSha, producedAt: "2026-09-01T00:01:00.000Z" },
            { evidenceId: "r2:capture", stage: "CAPTURE", subjectRevision: repairedSha, producedAt: "2026-09-01T00:01:01.000Z" },
            { evidenceId: "r2:judge", stage: "JUDGE", subjectRevision: repairedSha, producedAt: "2026-09-01T00:01:02.000Z" },
          ],
          judgeCriterion: { rubricVersion: "quality-v1", rubricDigest: "b".repeat(64) },
        },
      ],
      repairLineage: [{
        attempt: 1,
        fromRevision: SHA,
        toRevision: repairedSha,
        triggeringEvidenceIds: CYCLE_EVIDENCE_IDS,
        repairEvidenceIds: ["patch:r2"],
        changedFiles: ["src/page.tsx"],
      }],
    };
    const gates = passingGates();
    const repair = gates.find((gate) => gate.gateId === "REPAIR_REJUDGE")!;
    repair.evidenceIds = [...CYCLE_EVIDENCE_IDS, "r2:build", "r2:capture", "r2:judge", "patch:r2"];
    const report = certifyQualityGatesForDelivery({ projectId: "fixture", sourceRevision: SHA, gates, visualJudge, redTeam, excessRemoval, qualityCycle: mixed });
    expect(report.verdict).toBe("FAIL");
    expect(report.certified).toBe(false);
    expect(report.blockers.join(" ")).toContain("fresh single-revision SHIPPABLE quality cycle");
  });

  it("treats any missing required gate as NOT_TESTED rather than pretending a build is deliverable", () => {
    const gates = passingGates().filter((gate) => gate.gateId !== "CAPTURE");
    const report = certifyQualityGatesForDelivery({ projectId: "fixture", sourceRevision: SHA, gates, visualJudge, redTeam, excessRemoval, qualityCycle });
    expect(report.verdict).toBe("NOT_TESTED");
    expect(report.certified).toBe(false);
    expect(report.blockers.some((blocker) => blocker.startsWith("CAPTURE:NOT_TESTED"))).toBe(true);
  });

  it("rejects a claimed visual PASS without a real bound Visual Judge report", () => {
    const report = certifyQualityGatesForDelivery({ projectId: "fixture", sourceRevision: SHA, gates: passingGates(), redTeam, excessRemoval, qualityCycle });
    expect(report.verdict).toBe("FAIL");
    expect(report.certified).toBe(false);
    expect(report.blockers).toContain("VISUAL_JUDGE claimed PASS without an approved NEXUS Visual Judge report");
  });

  it("rejects an incomplete Red Team even when the supplied subset all PASS", () => {
    const incomplete = { ...redTeam, attacks: redTeam.attacks.slice(0, 2) };
    const report = certifyQualityGatesForDelivery({ projectId: "fixture", sourceRevision: SHA, gates: passingGates(), visualJudge, redTeam: incomplete, excessRemoval, qualityCycle });
    expect(report.verdict).toBe("FAIL");
    expect(report.certified).toBe(false);
    expect(report.blockers).toContain("RED_TEAM claimed PASS without the complete mandatory hostile attack set plus a passing evidence-backed Excess Removal gate");
  });

  it("rejects Red Team PASS when Excess Removal evidence is absent", () => {
    const report = certifyQualityGatesForDelivery({ projectId: "fixture", sourceRevision: SHA, gates: passingGates(), visualJudge, redTeam, qualityCycle });
    expect(report.verdict).toBe("FAIL");
    expect(report.certified).toBe(false);
  });

  it("rejects empty or untested excess-removal reports", () => {
    const empty: ExcessRemovalReport = { authority: "NEXUS_EXCESS_REMOVAL_GATE", verdict: "NOT_TESTED", findings: [] };
    const report = certifyQualityGatesForDelivery({ projectId: "fixture", sourceRevision: SHA, gates: passingGates(), visualJudge, redTeam, excessRemoval: empty, qualityCycle });
    expect(report.verdict).toBe("FAIL");
    expect(report.certified).toBe(false);
  });

  it("does not certify WARNING or NOT_TESTED states", () => {
    const gates = passingGates();
    const generation = gates.find((gate) => gate.gateId === "GENERATION")!;
    generation.verdict = "WARNING";
    const report = certifyQualityGatesForDelivery({ projectId: "fixture", sourceRevision: SHA, gates, visualJudge, redTeam, excessRemoval, qualityCycle });
    expect(report.verdict).toBe("WARNING");
    expect(report.certified).toBe(false);
  });
});
