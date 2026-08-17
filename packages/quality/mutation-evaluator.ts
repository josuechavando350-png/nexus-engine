import type { BrowserMutationArtifact, BrowserMutationId } from "@nexus/capture/mutation-runner";
import type { VerdictState } from "@nexus/creative";
import type { MutationAttackId } from "./red-team";

export interface MutationEvidencePolicy {
  maxHorizontalOverflowPx: number;
  minimumVisibleElements: number;
}

export type VisualMutationAttackId = "BRAND_SWAP" | "INDUSTRY_TRANSPLANT" | "GRAYSCALE";

export interface MutationVisualReview {
  attackId: VisualMutationAttackId;
  verdict: Exclude<VerdictState, "NOT_TESTED">;
  reviewerType: "HUMAN" | "MULTIMODAL_MODEL";
  reviewerId: string;
  rubricVersion: string;
  reviewedAt: string;
  evidenceDigests: readonly string[];
  providerId?: string;
  modelId?: string;
  modelConfigurationDigest?: `sha256:${string}`;
  providerRequestId?: string;
}

export interface MutationEvidenceEvaluation {
  authority: "NEXUS_MUTATION_EVIDENCE_EVALUATOR";
  verdicts: Readonly<Record<MutationAttackId, VerdictState>>;
  findings: readonly string[];
  evidence: Readonly<Partial<Record<MutationAttackId, readonly string[]>>>;
}

const DEFAULT_POLICY: MutationEvidencePolicy = Object.freeze({
  maxHorizontalOverflowPx: 1,
  minimumVisibleElements: 1,
});

function canonicalSha256(value: string): boolean {
  return /^sha256:[a-f0-9]{64}$/.test(value);
}

function canonicalUtc(value: string): boolean {
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString() === value;
}

function validateArtifact(artifact: BrowserMutationArtifact): string | undefined {
  if (!artifact.screenshotUri.trim() || !artifact.diagnosticsUri.trim()) return `${artifact.mutationId} evidence paths are missing`;
  if (!canonicalSha256(artifact.screenshotDigest) || !canonicalSha256(artifact.diagnosticsDigest)) return `${artifact.mutationId} evidence digests are not canonical SHA-256`;
  if (!Number.isInteger(artifact.screenshotByteLength) || artifact.screenshotByteLength <= 0) return `${artifact.mutationId} screenshot byte length is invalid`;
  const diagnostics = artifact.diagnostics;
  for (const [key, value] of Object.entries(diagnostics)) {
    if (!Number.isFinite(value) || value < 0) return `${artifact.mutationId} diagnostic ${key} is invalid`;
  }
  return undefined;
}

function byId(artifacts: readonly BrowserMutationArtifact[], id: BrowserMutationId): BrowserMutationArtifact | undefined {
  return artifacts.find((artifact) => artifact.mutationId === id);
}

function resilienceVerdict(
  artifact: BrowserMutationArtifact | undefined,
  policy: MutationEvidencePolicy,
  extra?: (artifact: BrowserMutationArtifact) => string | undefined,
): { verdict: VerdictState; findings: string[]; evidence: string[] } {
  if (!artifact) return { verdict: "NOT_TESTED", findings: ["required browser mutation evidence is missing"], evidence: [] };
  const malformed = validateArtifact(artifact);
  if (malformed) return { verdict: "FAIL", findings: [malformed], evidence: [] };
  const findings: string[] = [];
  if (artifact.diagnostics.horizontalOverflowPx > policy.maxHorizontalOverflowPx) findings.push(`horizontal overflow ${artifact.diagnostics.horizontalOverflowPx}px exceeds ${policy.maxHorizontalOverflowPx}px`);
  if (artifact.diagnostics.visibleElementCount < policy.minimumVisibleElements) findings.push(`visible element count ${artifact.diagnostics.visibleElementCount} is below ${policy.minimumVisibleElements}`);
  const extraFailure = extra?.(artifact);
  if (extraFailure) findings.push(extraFailure);
  return {
    verdict: findings.length ? "FAIL" : "PASS",
    findings,
    evidence: [artifact.screenshotDigest, artifact.diagnosticsDigest],
  };
}

function validateVisualReview(
  review: MutationVisualReview,
  artifact: BrowserMutationArtifact,
): string | undefined {
  if (!review.reviewerId.trim() || !review.rubricVersion.trim()) return "visual review reviewerId and rubricVersion are required";
  if (!canonicalUtc(review.reviewedAt)) return "visual review reviewedAt must be canonical UTC";
  if (!["PASS", "FAIL", "WARNING"].includes(review.verdict)) return "visual review verdict is invalid";
  if (!review.evidenceDigests.length || new Set(review.evidenceDigests).size !== review.evidenceDigests.length) return "visual review evidence digests must be non-empty and unique";
  if (review.evidenceDigests.some((value) => !canonicalSha256(value))) return "visual review evidence contains a non-canonical digest";
  const required = [artifact.screenshotDigest, artifact.diagnosticsDigest];
  const supplied = new Set(review.evidenceDigests);
  const missing = required.filter((digest) => !supplied.has(digest));
  if (missing.length) return `visual review is not bound to current mutation evidence: missing ${missing.join(", ")}`;
  if (review.reviewerType === "MULTIMODAL_MODEL") {
    if (!review.providerId?.trim() || !review.modelId?.trim() || !review.providerRequestId?.trim() || !review.modelConfigurationDigest || !canonicalSha256(review.modelConfigurationDigest)) {
      return "multimodal mutation review requires provider, model, configuration digest and provider request";
    }
  }
  return undefined;
}

function identityMutationEvidence(
  artifact: BrowserMutationArtifact | undefined,
  attackId: VisualMutationAttackId,
  policy: MutationEvidencePolicy,
  review?: MutationVisualReview,
  requireReplacement = false,
): { verdict: VerdictState; findings: string[]; evidence: string[] } {
  if (!artifact) return { verdict: "NOT_TESTED", findings: [`${attackId} browser mutation evidence is missing`], evidence: [] };
  const objective = resilienceVerdict(
    artifact,
    policy,
    requireReplacement ? (item) => item.diagnostics.replacementCount > 0 ? undefined : "explicit text replacement matched no rendered content" : undefined,
  );
  if (objective.verdict === "FAIL") return objective;
  if (!review) {
    return {
      verdict: "NOT_TESTED",
      findings: [requireReplacement
        ? `${attackId} executed ${artifact.diagnostics.replacementCount} explicit rendered-text replacement(s); identity survival still requires a traceable visual review`
        : `${attackId} browser evidence exists, but identity survival requires a traceable visual review`],
      evidence: objective.evidence,
    };
  }
  if (review.attackId !== attackId) {
    return { verdict: "FAIL", findings: [`visual review attackId ${review.attackId} does not match ${attackId}`], evidence: objective.evidence };
  }
  const reviewProblem = validateVisualReview(review, artifact);
  if (reviewProblem) return { verdict: "FAIL", findings: [reviewProblem], evidence: objective.evidence };
  return {
    verdict: review.verdict,
    findings: review.verdict === "PASS" ? [] : [`traceable visual review returned ${review.verdict}`],
    evidence: [...objective.evidence, ...review.evidenceDigests],
  };
}

export function evaluateBrowserMutationEvidence(
  artifacts: readonly BrowserMutationArtifact[],
  policy: MutationEvidencePolicy = DEFAULT_POLICY,
  visualReviews: readonly MutationVisualReview[] = [],
): MutationEvidenceEvaluation {
  if (!Number.isFinite(policy.maxHorizontalOverflowPx) || policy.maxHorizontalOverflowPx < 0) throw new Error("maxHorizontalOverflowPx must be finite and non-negative");
  if (!Number.isInteger(policy.minimumVisibleElements) || policy.minimumVisibleElements < 1) throw new Error("minimumVisibleElements must be a positive integer");
  if (new Set(visualReviews.map((review) => review.attackId)).size !== visualReviews.length) throw new Error("only one visual review per mutation attack is allowed");

  const findings: string[] = [];
  const evidence: Partial<Record<MutationAttackId, readonly string[]>> = {};
  const verdicts: Record<MutationAttackId, VerdictState> = {
    BRAND_SWAP: "NOT_TESTED",
    INDUSTRY_TRANSPLANT: "NOT_TESTED",
    CONTENT_STRESS: "NOT_TESTED",
    ASSET_DEGRADATION: "NOT_TESTED",
    VIEWPORT_TORTURE: "NOT_TESTED",
    MOTION_REMOVAL: "NOT_TESTED",
    GRAYSCALE: "NOT_TESTED",
  };

  const reviewFor = (attackId: VisualMutationAttackId) => visualReviews.find((review) => review.attackId === attackId);

  const brandSwap = identityMutationEvidence(byId(artifacts, "BRAND_SWAP"), "BRAND_SWAP", policy, reviewFor("BRAND_SWAP"), true);
  verdicts.BRAND_SWAP = brandSwap.verdict;
  evidence.BRAND_SWAP = brandSwap.evidence;
  findings.push(...brandSwap.findings.map((finding) => `BRAND_SWAP:${finding}`));

  const industryTransplant = identityMutationEvidence(byId(artifacts, "INDUSTRY_TRANSPLANT"), "INDUSTRY_TRANSPLANT", policy, reviewFor("INDUSTRY_TRANSPLANT"), true);
  verdicts.INDUSTRY_TRANSPLANT = industryTransplant.verdict;
  evidence.INDUSTRY_TRANSPLANT = industryTransplant.evidence;
  findings.push(...industryTransplant.findings.map((finding) => `INDUSTRY_TRANSPLANT:${finding}`));

  const content = resilienceVerdict(byId(artifacts, "CONTENT_STRESS"), policy);
  verdicts.CONTENT_STRESS = content.verdict;
  evidence.CONTENT_STRESS = content.evidence;
  findings.push(...content.findings.map((finding) => `CONTENT_STRESS:${finding}`));

  const assets = resilienceVerdict(byId(artifacts, "ASSET_DEGRADATION"), policy);
  verdicts.ASSET_DEGRADATION = assets.verdict;
  evidence.ASSET_DEGRADATION = assets.evidence;
  findings.push(...assets.findings.map((finding) => `ASSET_DEGRADATION:${finding}`));

  const narrow = resilienceVerdict(byId(artifacts, "VIEWPORT_TORTURE_NARROW"), policy);
  const wide = resilienceVerdict(byId(artifacts, "VIEWPORT_TORTURE_WIDE"), policy);
  verdicts.VIEWPORT_TORTURE = narrow.verdict === "FAIL" || wide.verdict === "FAIL"
    ? "FAIL"
    : narrow.verdict === "NOT_TESTED" || wide.verdict === "NOT_TESTED"
      ? "NOT_TESTED"
      : "PASS";
  evidence.VIEWPORT_TORTURE = [...narrow.evidence, ...wide.evidence];
  findings.push(...narrow.findings.map((finding) => `VIEWPORT_TORTURE_NARROW:${finding}`), ...wide.findings.map((finding) => `VIEWPORT_TORTURE_WIDE:${finding}`));

  const motion = resilienceVerdict(byId(artifacts, "MOTION_REMOVAL"), policy, (artifact) => artifact.diagnostics.animatedElementCount === 0 ? undefined : `animated element count remained ${artifact.diagnostics.animatedElementCount}`);
  verdicts.MOTION_REMOVAL = motion.verdict;
  evidence.MOTION_REMOVAL = motion.evidence;
  findings.push(...motion.findings.map((finding) => `MOTION_REMOVAL:${finding}`));

  const grayscale = identityMutationEvidence(byId(artifacts, "GRAYSCALE"), "GRAYSCALE", policy, reviewFor("GRAYSCALE"));
  verdicts.GRAYSCALE = grayscale.verdict;
  evidence.GRAYSCALE = grayscale.evidence;
  findings.push(...grayscale.findings.map((finding) => `GRAYSCALE:${finding}`));

  return Object.freeze({
    authority: "NEXUS_MUTATION_EVIDENCE_EVALUATOR",
    verdicts: Object.freeze(verdicts),
    findings: Object.freeze(findings),
    evidence: Object.freeze(evidence),
  });
}
