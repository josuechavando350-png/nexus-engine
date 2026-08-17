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
  providerId?: string;
  modelId?: string;
  modelConfigurationDigest?: `sha256:${string}`;
  providerRequestId?: string;
}

export interface MultimodalVisualJudgeImage {
  artifactId: string;
  digest: string;
  mediaType: "image/png";
  bytes: Uint8Array;
}

export interface MultimodalVisualJudgePort {
  providerId: string;
  modelId: string;
  configurationDigest: `sha256:${string}`;
  review(input: {
    rubricVersion: string;
    images: readonly MultimodalVisualJudgeImage[];
  }): Promise<{
    verdict: Exclude<VerdictState, "NOT_TESTED">;
    findings: readonly string[];
    reviewedAt: string;
    requestId: string;
  }>;
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

const BASELINE_REQUIRED_BROWSERS = Object.freeze(["chromium", "webkit"] as const);
const BASELINE_REQUIRED_VIEWPORTS = Object.freeze(["mobile-390", "tablet-768", "desktop-1440"] as const);
const VALID_REVIEWER_TYPES = Object.freeze(["HUMAN", "MULTIMODAL_MODEL"] as const);
const VALID_REVIEW_VERDICTS = Object.freeze(["PASS", "FAIL", "WARNING"] as const);

const DEFAULT_POLICY: VisualJudgePolicy = Object.freeze({
  requiredBrowsers: BASELINE_REQUIRED_BROWSERS,
  requiredViewports: BASELINE_REQUIRED_VIEWPORTS,
  requireDesignGenome: true,
  allowedReviewerTypes: VALID_REVIEWER_TYPES,
});

function key(browser: string, viewport: string): string {
  return `${browser.trim().toLowerCase()}::${viewport.trim().toLowerCase()}`;
}

function canonicalTimestamp(value: string): boolean {
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString() === value;
}

function canonicalSha256(value: string): value is `sha256:${string}` {
  return /^sha256:[a-f0-9]{64}$/.test(value);
}

function sha256(bytes: Uint8Array): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function assertVisualPolicy(policy: VisualJudgePolicy): void {
  if (!policy.requiredBrowsers.length || !policy.requiredViewports.length) throw new Error("visual judge browser/viewport policy cannot be empty");
  if (!policy.allowedReviewerTypes.length) throw new Error("visual judge reviewer policy cannot be empty");
  if (policy.requiredBrowsers.some((browser) => !browser.trim()) || new Set(policy.requiredBrowsers.map((browser) => browser.trim().toLowerCase())).size !== policy.requiredBrowsers.length) {
    throw new Error("visual judge requiredBrowsers must be unique non-empty values");
  }
  if (policy.requiredViewports.some((viewport) => !viewport.trim()) || new Set(policy.requiredViewports.map((viewport) => viewport.trim().toLowerCase())).size !== policy.requiredViewports.length) {
    throw new Error("visual judge requiredViewports must be unique non-empty values");
  }
  if (new Set(policy.allowedReviewerTypes).size !== policy.allowedReviewerTypes.length || policy.allowedReviewerTypes.some((type) => !VALID_REVIEWER_TYPES.includes(type))) {
    throw new Error("visual judge allowedReviewerTypes contains invalid or duplicate values");
  }

  const browsers = new Set(policy.requiredBrowsers.map((browser) => browser.trim().toLowerCase()));
  for (const browser of BASELINE_REQUIRED_BROWSERS) {
    if (!browsers.has(browser)) throw new Error(`visual judge policy cannot remove baseline browser ${browser}`);
  }
  const viewports = new Set(policy.requiredViewports.map((viewport) => viewport.trim().toLowerCase()));
  for (const viewport of BASELINE_REQUIRED_VIEWPORTS) {
    if (!viewports.has(viewport)) throw new Error(`visual judge policy cannot remove baseline viewport ${viewport}`);
  }
  if (!policy.requireDesignGenome) throw new Error("visual judge policy cannot disable baseline Design Genome evidence");
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

export async function executeMultimodalVisualReview(input: {
  artifacts: readonly CaptureArtifact[];
  reviewerId: string;
  rubricVersion: string;
  port: MultimodalVisualJudgePort;
}): Promise<VisualReview> {
  if (!input.reviewerId.trim() || !input.rubricVersion.trim()) throw new Error("multimodal review requires reviewerId and rubricVersion");
  if (!input.port.providerId.trim() || !input.port.modelId.trim()) throw new Error("multimodal judge port requires providerId and modelId");
  if (!canonicalSha256(input.port.configurationDigest)) throw new Error("multimodal judge port requires canonical configurationDigest");
  const screenshots = input.artifacts.filter((artifact) => artifact.capability === "SCREENSHOT");
  if (!screenshots.length) throw new Error("multimodal review requires persisted screenshot evidence");

  const images: MultimodalVisualJudgeImage[] = [];
  for (const artifact of screenshots) {
    const problem = await verifyArtifact(artifact);
    if (problem) throw new Error(`multimodal review refused unverified screenshot: ${problem}`);
    const bytes = await readFile(artifact.uri!);
    images.push(Object.freeze({ artifactId: artifact.artifactId, digest: artifact.digest, mediaType: "image/png", bytes }));
  }

  const outcome = await input.port.review({ rubricVersion: input.rubricVersion, images: Object.freeze(images) });
  if (!VALID_REVIEW_VERDICTS.includes(outcome.verdict)) throw new Error("multimodal provider returned an invalid verdict");
  if (!canonicalTimestamp(outcome.reviewedAt)) throw new Error("multimodal provider reviewedAt must be canonical UTC");
  if (!outcome.requestId.trim()) throw new Error("multimodal provider requestId is required");
  if (outcome.findings.some((finding) => !finding.trim())) throw new Error("multimodal provider findings cannot be empty strings");

  return Object.freeze({
    reviewerType: "MULTIMODAL_MODEL",
    reviewerId: input.reviewerId.trim(),
    rubricVersion: input.rubricVersion.trim(),
    verdict: outcome.verdict,
    findings: Object.freeze([...outcome.findings]),
    evidenceArtifactIds: Object.freeze(images.map((image) => image.artifactId)),
    reviewedAt: outcome.reviewedAt,
    providerId: input.port.providerId.trim(),
    modelId: input.port.modelId.trim(),
    modelConfigurationDigest: input.port.configurationDigest,
    providerRequestId: outcome.requestId.trim(),
    modelIdentity: `${input.port.providerId.trim()}/${input.port.modelId.trim()}#${input.port.configurationDigest}`,
  });
}

export async function judgeVisualEvidence(input: {
  artifacts: readonly CaptureArtifact[];
  review?: VisualReview;
  policy?: VisualJudgePolicy;
}): Promise<VisualJudgeResult> {
  const policy = input.policy ?? DEFAULT_POLICY;
  assertVisualPolicy(policy);

  const findings: string[] = [];
  const verifiedArtifactIds: string[] = [];
  const screenshotMatrix = new Set<string>();
  const genomeMatrix = new Set<string>();
  const screenshotIdsByMatrix = new Map<string, string[]>();
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
    const matrixKey = key(browser, viewport);
    if (artifact.capability === "SCREENSHOT") {
      screenshotMatrix.add(matrixKey);
      const ids = screenshotIdsByMatrix.get(matrixKey) ?? [];
      ids.push(artifact.artifactId);
      screenshotIdsByMatrix.set(matrixKey, ids);
    }
    if (artifact.capability === "DESIGN_GENOME") genomeMatrix.add(matrixKey);
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
    } else if (!VALID_REVIEWER_TYPES.includes(review.reviewerType)) {
      findings.push(`visual reviewer type ${String(review.reviewerType)} is invalid`);
      reviewVerdict = "FAIL";
    } else if (!VALID_REVIEW_VERDICTS.includes(review.verdict)) {
      findings.push(`visual review verdict ${String(review.verdict)} is invalid`);
      reviewVerdict = "FAIL";
    } else if (!policy.allowedReviewerTypes.includes(review.reviewerType)) {
      findings.push(`visual reviewer type ${review.reviewerType} is not allowed by policy`);
      reviewVerdict = "FAIL";
    } else if (review.reviewerType === "MULTIMODAL_MODEL" && (
      !review.modelIdentity?.trim()
      || !review.providerId?.trim()
      || !review.modelId?.trim()
      || !review.providerRequestId?.trim()
      || !review.modelConfigurationDigest
      || !canonicalSha256(review.modelConfigurationDigest)
    )) {
      findings.push("multimodal visual review must identify provider, model, configuration digest and provider request");
      reviewVerdict = "FAIL";
    } else {
      const verified = new Set(verifiedArtifactIds);
      const reviewIds = review.evidenceArtifactIds;
      const uniqueReviewIds = new Set(reviewIds);
      const missingEvidence = reviewIds.filter((artifactId) => !verified.has(artifactId));
      const requiredScreenshotIds = required.flatMap((requiredKey) => screenshotIdsByMatrix.get(requiredKey) ?? []);
      const omittedRequiredScreenshots = requiredScreenshotIds.filter((artifactId) => !uniqueReviewIds.has(artifactId));
      if (!reviewIds.length || missingEvidence.length || uniqueReviewIds.size !== reviewIds.length || omittedRequiredScreenshots.length) {
        if (!reviewIds.length) findings.push("visual review must reference persisted screenshot evidence");
        if (missingEvidence.length) findings.push(`visual review references unverified evidence: ${missingEvidence.join(", ")}`);
        if (uniqueReviewIds.size !== reviewIds.length) findings.push("visual review evidenceArtifactIds cannot contain duplicates");
        if (omittedRequiredScreenshots.length) findings.push(`visual review omitted required screenshots: ${omittedRequiredScreenshots.join(", ")}`);
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
