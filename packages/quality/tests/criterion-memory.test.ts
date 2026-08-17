import { describe, expect, it } from "vitest";
import { assertCriterionHistory, learnEmitterPriors, recordCriterionMemory, replayRubricRegression } from "../criterion-memory";

const SHA = "0123456789abcdef0123456789abcdef01234567";
const DIGEST = "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" as const;

const completeArtifacts = () => [
  { artifactId: "dna-a", digest: DIGEST, kind: "DNA" as const },
  { artifactId: "css-a", digest: DIGEST, kind: "EMITTED_CSS" as const },
  { artifactId: "capture-a", digest: DIGEST, kind: "CAPTURE" as const },
  { artifactId: "judge-a", digest: DIGEST, kind: "JUDGE_REPORT" as const },
  { artifactId: "delivery-a", digest: DIGEST, kind: "DELIVERY_EVIDENCE" as const },
];

function entry(overrides: Partial<Parameters<typeof recordCriterionMemory>[0]> = {}) {
  return recordCriterionMemory({
    schemaVersion: 1,
    tenantId: "tenant-a",
    projectId: "project-a",
    revision: SHA,
    recordedAt: "2026-08-17T07:00:00.000Z",
    dnaDigest: DIGEST,
    emittedCssDigest: DIGEST,
    artifacts: completeArtifacts(),
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

  it("requires complete DNA/CSS/capture/judge/delivery evidence rather than partial history", () => {
    expect(() => entry({ artifacts: completeArtifacts().filter((artifact) => artifact.kind !== "JUDGE_REPORT") })).toThrow(/requires JUDGE_REPORT evidence/);
    expect(() => entry({ artifacts: completeArtifacts().filter((artifact) => artifact.kind !== "DELIVERY_EVIDENCE") })).toThrow(/requires DELIVERY_EVIDENCE evidence/);
  });

  it("binds DNA and emitted CSS artifact digests to the top-level record", () => {
    const other = `sha256:${"b".repeat(64)}` as const;
    expect(() => entry({ dnaDigest: other })).toThrow(/DNA artifact digest must match dnaDigest/);
    expect(() => entry({ emittedCssDigest: other })).toThrow(/EMITTED_CSS artifact digest must match emittedCssDigest/);
  });

  it("requires rationale for explicit human decisions", () => {
    expect(() => entry({ humanRationale: "" })).toThrow(/human veto requires rationale/);
    expect(() => entry({ humanDecision: "APPROVE", humanRationale: "" })).toThrow(/human approval requires rationale/);
    expect(() => entry({ humanDecision: "NO_DECISION", humanRationale: "should not exist" })).toThrow(/NO_DECISION cannot carry/);
  });

  it("rejects runtime-invalid verdicts even if untyped JS reaches the boundary", () => {
    expect(() => entry({ judgeVerdict: "YES" as never })).toThrow(/judgeVerdict is invalid/);
    expect(() => entry({ deliveryVerdict: "GOOD" as never })).toThrow(/deliveryVerdict is invalid/);
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

  it("rejects a malformed candidate rubric verdict at runtime", () => {
    expect(() => replayRubricRegression({
      candidateRubricVersion: "rubric-v2",
      history: [entry()],
      evaluate: () => "APPROVE" as never,
    })).toThrow(/candidate rubric verdict is invalid/);
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

  it("rejects multiple observations for one project so repeated revisions cannot overweight learned priors", () => {
    const observations = [
      { tenantId: "tenant-a", projectId: "project-a", revision: SHA, dnaFeatures: { asymmetry: 0.2 }, approvedWithoutCorrection: true, businessOutcomes: [] },
      { tenantId: "tenant-a", projectId: "project-a", revision: "1123456789abcdef0123456789abcdef01234567", dnaFeatures: { asymmetry: 0.9 }, approvedWithoutCorrection: true, businessOutcomes: [] },
    ];
    expect(() => learnEmitterPriors({ observations, tenantId: "tenant-a", minimumProjects: 1 })).toThrow(/multiple prior observations for one project/);
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
