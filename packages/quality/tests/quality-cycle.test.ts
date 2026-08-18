import { describe, expect, it } from "vitest";
import { runQualityCycle, type CycleEvidence, type JudgeCycleResult, type QualityCycleExecutor } from "../quality-cycle";

const RUBRIC_VERSION = "quality-cycle-test-v1";
const RUBRIC_DIGEST = "a".repeat(64);

function evidence(stage: CycleEvidence["stage"], revision: string, evidenceId = `${stage.toLowerCase()}:${revision}`): CycleEvidence {
  return { evidenceId, stage, subjectRevision: revision, producedAt: "2026-08-17T04:00:00.000Z" };
}

function judged(evidenceArtifact: CycleEvidence, evaluation: JudgeCycleResult["evaluation"]): JudgeCycleResult {
  return {
    evidence: evidenceArtifact,
    evaluation,
    rubricVersion: RUBRIC_VERSION,
    rubricDigest: RUBRIC_DIGEST,
  };
}

describe("runQualityCycle", () => {
  it("forces build -> capture -> judge again after every revision-changing repair and records lineage", async () => {
    let revision = "r1";
    const calls: string[] = [];
    const executor: QualityCycleExecutor = {
      async currentRevision() { return revision; },
      async build(current) { calls.push(`build:${current}`); return evidence("BUILD", current); },
      async capture(current) { calls.push(`capture:${current}`); return evidence("CAPTURE", current); },
      async judge(current, fresh) {
        calls.push(`judge:${current}`);
        const judge = evidence("JUDGE", current);
        return judged(judge, {
          verdict: current === "r2" ? "PASS" : "FAIL",
          findings: current === "r2" ? [] : ["visual hierarchy failed"],
          evidenceIds: [...fresh.map((item) => item.evidenceId), judge.evidenceId],
        });
      },
      async repair(_evaluation, attempt) {
        calls.push(`repair:${attempt}`);
        revision = "r2";
        return { summary: "Fix hierarchy", changedFiles: ["src/page.tsx"], evidenceIds: ["patch:r2"] };
      },
    };

    const result = await runQualityCycle(executor);
    expect(result.status).toBe("SHIPPABLE");
    expect(result.snapshots.map((snapshot) => snapshot.revision)).toEqual(["r1", "r2"]);
    expect(calls).toEqual(["build:r1", "capture:r1", "judge:r1", "repair:1", "build:r2", "capture:r2", "judge:r2"]);
    expect(result.snapshots.every((snapshot) => new Set(snapshot.evidence.map((item) => item.stage)).size === 3)).toBe(true);
    expect(result.repairLineage).toEqual([{
      attempt: 1,
      fromRevision: "r1",
      toRevision: "r2",
      triggeringEvidenceIds: ["build:r1", "capture:r1", "judge:r1"],
      repairEvidenceIds: ["patch:r2"],
      changedFiles: ["src/page.tsx"],
    }]);
  });

  it("preserves legitimate judge sub-evidence in repair lineage without confusing it for stale cycle evidence", async () => {
    let revision = "r1";
    const executor: QualityCycleExecutor = {
      async currentRevision() { return revision; },
      async build(current) { return evidence("BUILD", current); },
      async capture(current) { return evidence("CAPTURE", current); },
      async judge(current, fresh) {
        const judge = evidence("JUDGE", current);
        return judged(judge, {
          verdict: current === "r2" ? "PASS" : "FAIL",
          findings: current === "r2" ? [] : ["visual hierarchy failed"],
          evidenceIds: [...fresh.map((item) => item.evidenceId), judge.evidenceId, `multimodal-detail:${current}`],
        });
      },
      async repair() {
        revision = "r2";
        return { summary: "Fix hierarchy", changedFiles: ["src/page.tsx"], evidenceIds: ["patch:r2"] };
      },
    };

    const result = await runQualityCycle(executor);
    expect(result.status).toBe("SHIPPABLE");
    expect(result.repairLineage[0]?.triggeringEvidenceIds).toContain("multimodal-detail:r1");
  });

  it("rejects stale capture evidence instead of judging the repaired revision with old artifacts", async () => {
    const executor: QualityCycleExecutor = {
      async currentRevision() { return "r2"; },
      async build(current) { return evidence("BUILD", current); },
      async capture() { return evidence("CAPTURE", "r1"); },
      async judge() { throw new Error("must not judge stale evidence"); },
      async repair() { throw new Error("must not repair before valid evidence"); },
    };
    await expect(runQualityCycle(executor)).rejects.toThrow(/CAPTURE evidence is stale/);
  });

  it("rejects a judge that does not reference all fresh build/capture/judge evidence", async () => {
    const executor: QualityCycleExecutor = {
      async currentRevision() { return "r1"; },
      async build(current) { return evidence("BUILD", current); },
      async capture(current) { return evidence("CAPTURE", current); },
      async judge(current) {
        const judge = evidence("JUDGE", current);
        return judged(judge, { verdict: "PASS", findings: [], evidenceIds: [judge.evidenceId] });
      },
      async repair() { throw new Error("not reached"); },
    };
    await expect(runQualityCycle(executor)).rejects.toThrow(/omitted fresh BUILD evidence/);
  });

  it("rejects repairs that claim success without advancing the subject revision", async () => {
    const executor: QualityCycleExecutor = {
      async currentRevision() { return "r1"; },
      async build(current) { return evidence("BUILD", current); },
      async capture(current) { return evidence("CAPTURE", current); },
      async judge(current, fresh) {
        const judge = evidence("JUDGE", current);
        return judged(judge, { verdict: "FAIL", findings: ["still broken"], evidenceIds: [...fresh.map((item) => item.evidenceId), judge.evidenceId] });
      },
      async repair() { return { summary: "No-op", changedFiles: ["src/page.tsx"], evidenceIds: ["patch:no-op"] }; },
    };
    await expect(runQualityCycle(executor)).rejects.toThrow(/repair must advance the subject revision/);
  });

  it("rejects a repair with no change evidence instead of allowing an unauditable self-correction", async () => {
    let revision = "r1";
    const executor: QualityCycleExecutor = {
      async currentRevision() { return revision; },
      async build(current) { return evidence("BUILD", current); },
      async capture(current) { return evidence("CAPTURE", current); },
      async judge(current, fresh) {
        const judge = evidence("JUDGE", current);
        return judged(judge, { verdict: "FAIL", findings: ["hierarchy"], evidenceIds: [...fresh.map((item) => item.evidenceId), judge.evidenceId] });
      },
      async repair() {
        revision = "r2";
        return { summary: "Unproven change", changedFiles: ["src/page.tsx"], evidenceIds: [] };
      },
    };
    await expect(runQualityCycle(executor)).rejects.toThrow(/repair must emit evidence/);
  });

  it("rejects reused evidence identifiers across rebuilt revisions", async () => {
    let revision = "r1";
    const executor: QualityCycleExecutor = {
      async currentRevision() { return revision; },
      async build(current) { return evidence("BUILD", current, "build:constant"); },
      async capture(current) { return evidence("CAPTURE", current, `capture:${current}`); },
      async judge(current, fresh) {
        const judge = evidence("JUDGE", current, `judge:${current}`);
        return judged(judge, {
          verdict: current === "r2" ? "PASS" : "FAIL",
          findings: current === "r2" ? [] : ["hierarchy"],
          evidenceIds: [...fresh.map((item) => item.evidenceId), judge.evidenceId],
        });
      },
      async repair() {
        revision = "r2";
        return { summary: "Fix hierarchy", changedFiles: ["src/page.tsx"], evidenceIds: ["patch:r2"] };
      },
    };
    await expect(runQualityCycle(executor)).rejects.toThrow(/refused reused evidenceId build:constant/);
  });

  it("rejects rollback to a revision that has already been judged", async () => {
    let revision = "r1";
    let repairCount = 0;
    const executor: QualityCycleExecutor = {
      async currentRevision() { return revision; },
      async build(current) { return evidence("BUILD", current); },
      async capture(current) { return evidence("CAPTURE", current); },
      async judge(current, fresh) {
        const judge = evidence("JUDGE", current);
        return judged(judge, { verdict: "FAIL", findings: ["still weak"], evidenceIds: [...fresh.map((item) => item.evidenceId), judge.evidenceId] });
      },
      async repair() {
        repairCount += 1;
        revision = repairCount === 1 ? "r2" : "r1";
        return { summary: "Change", changedFiles: ["src/page.tsx"], evidenceIds: [`patch:${repairCount}`] };
      },
    };
    await expect(runQualityCycle(executor)).rejects.toThrow(/cannot roll back to previously evaluated revision r1/);
  });
});
