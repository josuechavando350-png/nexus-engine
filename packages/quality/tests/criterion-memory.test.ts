import { describe, expect, it } from "vitest";
import { assertCriterionHistory, learnEmitterPriors, recordCriterionMemory, replayRubricRegression } from "../criterion-memory";

const SHA = "0123456789abcdef0123456789abcdef01234567";
const DIGEST = "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" as const;

function entry(overrides: Partial<Parameters<typeof recordCriterionMemory>[0]> = {}) {
  return recordCriterionMemory({
    schemaVersion: 1,
    tenantId: "tenant-a",
    projectId: "project-a",
    revision: SHA,
    recordedAt: "2026-08-17T07:00:00.000Z",
    dnaDigest: DIGEST,
    emittedCssDigest: DIGEST,
    artifacts: [{ artifactId: "capture-a", digest: DIGEST, kind: "CAPTURE" }],
    rubricVersion: "rubric-v1",
    judgeVerdict: "FAIL",
    judgeFindings: ["generic composition"],
    humanDecision: "VETO",
    humanRationale: "Fails the project-specific art direction.",
    deliveryVerdict: "FAIL",
    businessOutcomes: [],
    ...overrides,
  });
}

describe("criterion memory", () => {
  it("binds records to immutable content and detects tampering", () => {
    const original = entry();
    expect(original.entryId).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(() => assertCriterionHistory([original])).not.toThrow();
    const tampered = { ...original, judgeVerdict: "PASS" as const };
    expect(() => assertCriterionHistory([tampered])).toThrow(/integrity verification/);
  });

  it("requires rationale for a human veto", () => {
    expect(() => entry({ humanRationale: "" })).toThrow(/human veto requires rationale/);
  });

  it("rejects rubric promotion when replay would approve a historical veto", () => {
    const historical = entry();
    const report = replayRubricRegression({
      candidateRubricVersion: "rubric-v2",
      history: [historical],
      evaluate: () => "PASS",
    });
    expect(report.promotable).toBe(false);
    expect(report.replayedEntryCount).toBe(1);
    expect(report.violations.join(" ")).toMatch(/historically vetoed/);
  });

  it("keeps emitter learning fail-closed until enough distinct real projects exist", () => {
    const observations = Array.from({ length: 19 }, (_, index) => ({
      tenantId: "tenant-a",
      projectId: `project-${index}`,
      revision: SHA,
      dnaFeatures: { asymmetry: 0.6 },
      approvedWithoutCorrection: true,
      businessOutcomes: [],
    }));
    const report = learnEmitterPriors({ observations, tenantId: "tenant-a", minimumProjects: 20 });
    expect(report.status).toBe("NOT_ENOUGH_HISTORY");
    expect(report.featureMeans).toEqual({});
  });

  it("does not declare learned priors ready when observed history has too few clean approvals", () => {
    const observations = Array.from({ length: 20 }, (_, index) => ({
      tenantId: "tenant-a",
      projectId: `project-${index}`,
      revision: SHA,
      dnaFeatures: { asymmetry: 0.6 },
      approvedWithoutCorrection: index < 3,
      businessOutcomes: [],
    }));
    const report = learnEmitterPriors({ observations, tenantId: "tenant-a", minimumProjects: 20, minimumApprovedProjects: 10 });
    expect(report.status).toBe("NOT_ENOUGH_HISTORY");
    expect(report.observedProjects).toBe(20);
    expect(report.approvedWithoutCorrectionProjects).toBe(3);
    expect(report.featureMeans).toEqual({});
  });

  it("derives priors only from approved observations after both thresholds", () => {
    const observations = Array.from({ length: 20 }, (_, index) => ({
      tenantId: "tenant-a",
      projectId: `project-${index}`,
      revision: SHA,
      dnaFeatures: { asymmetry: index < 10 ? 0.4 : 0.8 },
      approvedWithoutCorrection: index !== 0,
      businessOutcomes: [{ metric: "conversion_rate", value: index / 100, observedAt: "2026-08-17T07:00:00.000Z", source: "production-import" }],
    }));
    const report = learnEmitterPriors({ observations, tenantId: "tenant-a", minimumProjects: 20, minimumApprovedProjects: 10 });
    expect(report.status).toBe("READY");
    expect(report.minimumApprovedProjects).toBe(10);
    expect(report.observedProjects).toBe(20);
    expect(report.approvedWithoutCorrectionProjects).toBe(19);
    expect(report.featureMeans.asymmetry).toBeGreaterThan(0.5);
    expect(report.businessMetricMeans.conversion_rate).toBeGreaterThan(0);
  });
});
