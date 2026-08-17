import type { BrowserMutationArtifact, BrowserMutationId } from "@nexus/capture/mutation-runner";
import type { VerdictState } from "@nexus/creative";
import type { MutationAttackId } from "./red-team";

export interface MutationEvidencePolicy {
  maxHorizontalOverflowPx: number;
  minimumVisibleElements: number;
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

function validateArtifact(artifact: BrowserMutationArtifact): string | undefined {
  if (!artifact.screenshotUri.trim() || !artifact.diagnosticsUri.trim()) return `${artifact.mutationId} evidence paths are missing`;
  if (!artifact.screenshotDigest.startsWith("sha256:") || !artifact.diagnosticsDigest.startsWith("sha256:")) return `${artifact.mutationId} evidence digests are not SHA-256`;
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

function identityMutationEvidence(
  artifact: BrowserMutationArtifact | undefined,
  attackId: "BRAND_SWAP" | "INDUSTRY_TRANSPLANT",
  policy: MutationEvidencePolicy,
): { verdict: VerdictState; findings: string[]; evidence: string[] } {
  if (!artifact) return { verdict: "NOT_TESTED", findings: [`${attackId} browser mutation evidence is missing`], evidence: [] };
  const objective = resilienceVerdict(artifact, policy, (item) => item.diagnostics.replacementCount > 0 ? undefined : "explicit text replacement matched no rendered content");
  if (objective.verdict === "FAIL") return objective;
  return {
    verdict: "NOT_TESTED",
    findings: [`${attackId} executed ${artifact.diagnostics.replacementCount} explicit rendered-text replacement(s); identity survival still requires a traceable visual review`],
    evidence: objective.evidence,
  };
}

export function evaluateBrowserMutationEvidence(
  artifacts: readonly BrowserMutationArtifact[],
  policy: MutationEvidencePolicy = DEFAULT_POLICY,
): MutationEvidenceEvaluation {
  if (!Number.isFinite(policy.maxHorizontalOverflowPx) || policy.maxHorizontalOverflowPx < 0) throw new Error("maxHorizontalOverflowPx must be finite and non-negative");
  if (!Number.isInteger(policy.minimumVisibleElements) || policy.minimumVisibleElements < 1) throw new Error("minimumVisibleElements must be a positive integer");

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

  const brandSwap = identityMutationEvidence(byId(artifacts, "BRAND_SWAP"), "BRAND_SWAP", policy);
  verdicts.BRAND_SWAP = brandSwap.verdict;
  evidence.BRAND_SWAP = brandSwap.evidence;
  findings.push(...brandSwap.findings.map((finding) => `BRAND_SWAP:${finding}`));

  const industryTransplant = identityMutationEvidence(byId(artifacts, "INDUSTRY_TRANSPLANT"), "INDUSTRY_TRANSPLANT", policy);
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

  const grayscale = byId(artifacts, "GRAYSCALE");
  if (grayscale) {
    const malformed = validateArtifact(grayscale);
    if (malformed) {
      verdicts.GRAYSCALE = "FAIL";
      findings.push(`GRAYSCALE:${malformed}`);
    } else {
      evidence.GRAYSCALE = [grayscale.screenshotDigest, grayscale.diagnosticsDigest];
      findings.push("GRAYSCALE:browser evidence exists, but identity survival requires a traceable visual review");
    }
  } else {
    findings.push("GRAYSCALE:browser evidence is missing");
  }

  return Object.freeze({
    authority: "NEXUS_MUTATION_EVIDENCE_EVALUATOR",
    verdicts: Object.freeze(verdicts),
    findings: Object.freeze(findings),
    evidence: Object.freeze(evidence),
  });
}
