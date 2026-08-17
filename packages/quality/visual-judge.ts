import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { CaptureArtifact } from "@nexus/capture";
import type { VerdictState } from "@nexus/creative";

export type VisualReviewerType = "HUMAN" | "MULTIMODAL_MODEL";

export interface VisualReview {
  reviewerType: VisualReviewerType;
  reviewerId: string;
  rubricVersion: string;
  verdict: Exclude<VerdictState, "NOT_TESTED">;
  findings: readonly string[];
  evidenceArtifactIds: readonly string[];
  reviewedAt: string;
  modelIdentity?: string;
}

export interface VisualJudgePolicy {
  requiredBrowsers: readonly string[];
  requiredViewports: readonly string[];
  requireDesignGenome: boolean;
  allowedReviewerTypes: readonly VisualReviewerType[];
}

export interface VisualJudgeResult {
  authority: "NEXUS_VISUAL_JUDGE";
  verdict: VerdictState;
  approved: boolean;
  integrityVerdict: "PASS" | "FAIL";
  reviewVerdict: VerdictState;
  findings: readonly string[];
  verifiedArtifactIds: readonly string[];
}

const DEFAULT_POLICY: VisualJudgePolicy = Object.freeze({
  requiredBrowsers: Object.freeze(["chromium", "webkit"]),
  requiredViewports: Object.freeze(["mobile-390", "tablet-768", "desktop-1440"]),
  requireDesignGenome: true,
  allowedReviewerTypes: Object.freeze(["HUMAN", "MULTIMODAL_MODEL"] as const),
});

function key(browser: string, viewport: string): string {
  return `${browser.trim().toLowerCase()}::${viewport.trim().toLowerCase()}`;
}

function canonicalTimestamp(value: string): boolean {
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString() === value;
}

function sha256(bytes: Uint8Array): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

async function verifyArtifact(artifact: CaptureArtifact): Promise<string | undefined> {
  if (!artifact.uri) return `artifact ${artifact.artifactId} has no persisted uri`;
  let bytes: Buffer;
  try {
    bytes = await readFile(artifact.uri);
  } catch {
    return `artifact ${artifact.artifactId} cannot be read from ${artifact.uri}`;
  }
  if (bytes.byteLength !== artifact.byteLength) return `artifact ${artifact.artifactId} byte length does not match persisted evidence`;
  if (sha256(bytes) !== artifact.digest) return `artifact ${artifact.artifactId} digest does not match persisted evidence`;
  if (artifact.capability === "SCREENSHOT" && bytes.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a") return `artifact ${artifact.artifactId} is not a PNG`;
  if (artifact.capability === "DESIGN_GENOME") {
    try {
      const data = JSON.parse(bytes.toString("utf8")) as Record<string, unknown>;
      if (data.schemaVersion !== 1 || typeof data.visibleElementCount !== "number") return `artifact ${artifact.artifactId} is not a valid Design Genome`;
    } catch {
      return `artifact ${artifact.artifactId} is not valid JSON`;
    }
  }
  return undefined;
}

export async function judgeVisualEvidence(input: {
  artifacts: readonly CaptureArtifact[];
  review?: VisualReview;
  policy?: VisualJudgePolicy;
}): Promise<VisualJudgeResult> {
  const policy = input.policy ?? DEFAULT_POLICY;
  if (!policy.requiredBrowsers.length || !policy.requiredViewports.length) throw new Error("visual judge browser/viewport policy cannot be empty");
  if (!policy.allowedReviewerTypes.length) throw new Error("visual judge reviewer policy cannot be empty");

  const findings: string[] = [];
  const verifiedArtifactIds: string[] = [];
  const screenshotMatrix = new Set<string>();
  const genomeMatrix = new Set<string>();
  const relevant = input.artifacts.filter((artifact) => artifact.capability === "SCREENSHOT" || artifact.capability === "DESIGN_GENOME");

  for (const artifact of relevant) {
    const problem = await verifyArtifact(artifact);
    if (problem) {
      findings.push(problem);
      continue;
    }
    verifiedArtifactIds.push(artifact.artifactId);
    const browser = artifact.metadata?.browser;
    const viewport = artifact.metadata?.viewport;
    if (!browser || !viewport) {
      findings.push(`artifact ${artifact.artifactId} is missing browser/viewport metadata`);
      continue;
    }
    if (artifact.capability === "SCREENSHOT") screenshotMatrix.add(key(browser, viewport));
    if (artifact.capability === "DESIGN_GENOME") genomeMatrix.add(key(browser, viewport));
  }

  const required = policy.requiredBrowsers.flatMap((browser) => policy.requiredViewports.map((viewport) => key(browser, viewport)));
  for (const requiredKey of required) {
    if (!screenshotMatrix.has(requiredKey)) findings.push(`missing screenshot evidence for ${requiredKey}`);
    if (policy.requireDesignGenome && !genomeMatrix.has(requiredKey)) findings.push(`missing Design Genome evidence for ${requiredKey}`);
  }

  const integrityVerdict = findings.length ? "FAIL" as const : "PASS" as const;
  let reviewVerdict: VerdictState = "NOT_TESTED";

  if (input.review) {
    const review = input.review;
    if (!review.reviewerId.trim() || !review.rubricVersion.trim() || !canonicalTimestamp(review.reviewedAt)) {
      findings.push("visual review metadata is invalid or incomplete");
      reviewVerdict = "FAIL";
    } else if (!policy.allowedReviewerTypes.includes(review.reviewerType)) {
      findings.push(`visual reviewer type ${review.reviewerType} is not allowed by policy`);
      reviewVerdict = "FAIL";
    } else if (review.reviewerType === "MULTIMODAL_MODEL" && !review.modelIdentity?.trim()) {
      findings.push("multimodal visual review must identify the model/provider configuration");
      reviewVerdict = "FAIL";
    } else {
      const verified = new Set(verifiedArtifactIds);
      const missingEvidence = review.evidenceArtifactIds.filter((artifactId) => !verified.has(artifactId));
      if (!review.evidenceArtifactIds.length || missingEvidence.length) {
        findings.push(missingEvidence.length ? `visual review references unverified evidence: ${missingEvidence.join(", ")}` : "visual review must reference persisted screenshot/genome evidence");
        reviewVerdict = "FAIL";
      } else {
        reviewVerdict = review.verdict;
        findings.push(...review.findings.map((finding) => `review:${finding}`));
      }
    }
  }

  const verdict: VerdictState = integrityVerdict === "FAIL"
    ? "FAIL"
    : reviewVerdict;
  return Object.freeze({
    authority: "NEXUS_VISUAL_JUDGE",
    verdict,
    approved: verdict === "PASS",
    integrityVerdict,
    reviewVerdict,
    findings: Object.freeze(findings),
    verifiedArtifactIds: Object.freeze(verifiedArtifactIds.sort()),
  });
}

export interface CalibrationExample {
  exampleId: string;
  humanVerdict: "PASS" | "FAIL" | "WARNING";
  reviewerVerdict: "PASS" | "FAIL" | "WARNING";
}

export interface VisualCalibrationReport {
  authority: "NEXUS_VISUAL_CALIBRATION";
  sampleCount: number;
  exactAgreementCount: number;
  exactAgreementRate: number;
  confusion: Readonly<Record<"PASS" | "FAIL" | "WARNING", Readonly<Record<"PASS" | "FAIL" | "WARNING", number>>>>;
  disagreements: readonly string[];
}

export function calibrateVisualReviewer(examples: readonly CalibrationExample[]): VisualCalibrationReport {
  if (!examples.length) throw new Error("visual calibration requires labeled examples");
  if (new Set(examples.map((example) => example.exampleId)).size !== examples.length) throw new Error("visual calibration exampleId values must be unique");
  const labels = ["PASS", "FAIL", "WARNING"] as const;
  const confusion = Object.fromEntries(labels.map((human) => [human, Object.fromEntries(labels.map((reviewer) => [reviewer, 0]))])) as Record<typeof labels[number], Record<typeof labels[number], number>>;
  const disagreements: string[] = [];
  let exactAgreementCount = 0;
  for (const example of examples) {
    if (!example.exampleId.trim()) throw new Error("visual calibration exampleId is required");
    confusion[example.humanVerdict][example.reviewerVerdict] += 1;
    if (example.humanVerdict === example.reviewerVerdict) exactAgreementCount += 1;
    else disagreements.push(example.exampleId);
  }
  return Object.freeze({
    authority: "NEXUS_VISUAL_CALIBRATION",
    sampleCount: examples.length,
    exactAgreementCount,
    exactAgreementRate: exactAgreementCount / examples.length,
    confusion: Object.freeze(Object.fromEntries(labels.map((human) => [human, Object.freeze({ ...confusion[human] })])) as VisualCalibrationReport["confusion"]),
    disagreements: Object.freeze(disagreements.sort()),
  });
}
