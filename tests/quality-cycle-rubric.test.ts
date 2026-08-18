import { describe, expect, it } from "vitest";
import { runQualityCycle, type CycleEvidence, type QualityCycleExecutor } from "../packages/quality/quality-cycle";

const RUBRIC_A = "a".repeat(64);
const RUBRIC_B = "b".repeat(64);
const NOW = "2026-08-17T14:00:00.000Z";

function evidence(stage: CycleEvidence["stage"], revision: string, suffix: string): CycleEvidence {
  return {
    evidenceId: `${stage.toLowerCase()}-${revision}-${suffix}`,
    stage,
    subjectRevision: revision,
    producedAt: NOW,
  };
}

describe("quality cycle rubric lineage", () => {
  it("persists the immutable rubric identity on a shippable snapshot", async () => {
    let revision = "rev-a";
    const executor: QualityCycleExecutor = {
      currentRevision: async () => revision,
      build: async (subjectRevision) => evidence("BUILD", subjectRevision, "1"),
      capture: async (subjectRevision) => evidence("CAPTURE", subjectRevision, "1"),
      judge: async (subjectRevision, inputs) => {
        const judged = evidence("JUDGE", subjectRevision, "1");
        return {
          evaluation: { verdict: "PASS", findings: [], evidenceIds: [...inputs.map((item) => item.evidenceId), judged.evidenceId] },
          evidence: judged,
          rubricVersion: "rubric-v1",
          rubricDigest: RUBRIC_A,
        };
      },
      repair: async () => {
        revision = "rev-b";
        return { summary: "unused", changedFiles: ["unused.ts"], evidenceIds: ["repair-unused"] };
      },
    };

    const result = await runQualityCycle(executor);

    expect(result.status).toBe("SHIPPABLE");
    expect(result.snapshots).toHaveLength(1);
    expect(result.snapshots[0]?.judgeCriterion).toEqual({ rubricVersion: "rubric-v1", rubricDigest: RUBRIC_A });
  });

  it("fails closed when the judge does not provide a canonical rubric digest", async () => {
    const revision = "rev-a";
    const executor: QualityCycleExecutor = {
      currentRevision: async () => revision,
      build: async (subjectRevision) => evidence("BUILD", subjectRevision, "1"),
      capture: async (subjectRevision) => evidence("CAPTURE", subjectRevision, "1"),
      judge: async (subjectRevision, inputs) => {
        const judged = evidence("JUDGE", subjectRevision, "1");
        return {
          evaluation: { verdict: "PASS", findings: [], evidenceIds: [...inputs.map((item) => item.evidenceId), judged.evidenceId] },
          evidence: judged,
          rubricVersion: "rubric-v1",
          rubricDigest: "not-a-sha256",
        };
      },
      repair: async () => ({ summary: "unused", changedFiles: ["unused.ts"], evidenceIds: ["repair-unused"] }),
    };

    await expect(runQualityCycle(executor)).rejects.toThrow("judge rubricDigest must be a lowercase SHA-256 hex digest");
  });

  it("refuses rubric drift between the failing snapshot and its repaired rejudge", async () => {
    let revision = "rev-a";
    let judgeCalls = 0;
    const executor: QualityCycleExecutor = {
      currentRevision: async () => revision,
      build: async (subjectRevision) => evidence("BUILD", subjectRevision, `${judgeCalls + 1}`),
      capture: async (subjectRevision) => evidence("CAPTURE", subjectRevision, `${judgeCalls + 1}`),
      judge: async (subjectRevision, inputs) => {
        judgeCalls += 1;
        const judged = evidence("JUDGE", subjectRevision, `${judgeCalls}`);
        return {
          evaluation: {
            verdict: judgeCalls === 1 ? "FAIL" : "PASS",
            findings: judgeCalls === 1 ? ["repair required"] : [],
            evidenceIds: [...inputs.map((item) => item.evidenceId), judged.evidenceId],
          },
          evidence: judged,
          rubricVersion: judgeCalls === 1 ? "rubric-v1" : "rubric-v2",
          rubricDigest: judgeCalls === 1 ? RUBRIC_A : RUBRIC_B,
        };
      },
      repair: async () => {
        revision = "rev-b";
        return {
          summary: "apply repair",
          changedFiles: ["site.css"],
          evidenceIds: ["repair-rev-a-to-rev-b"],
        };
      },
    };

    await expect(runQualityCycle(executor, { maxAttempts: 1 })).rejects.toThrow("quality cycle refused judge rubric drift");
  });
});
