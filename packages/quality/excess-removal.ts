import type { RemovalExperimentArtifact } from "@nexus/capture/removal-experiment";
import type { VerdictState } from "@nexus/creative";

export type ElementPurpose = "HIERARCHY" | "COMPREHENSION" | "INTERACTION" | "IDENTITY" | "ACCESSIBILITY" | "CONTENT";
export type RemovalOutcome = "MEANINGFUL_LOSS" | "NO_MATERIAL_LOSS" | "BROKEN_EXPERIENCE";

export interface RemovalObservation {
  outcome: RemovalOutcome;
  evidenceIds: readonly string[];
  notes: string;
}

export interface ExcessCandidate {
  elementId: string;
  purposes: readonly ElementPurpose[];
  rationale: string;
  observation?: RemovalObservation;
}

export interface RemovalEvidenceReview {
  elementId: string;
  reviewerType: "HUMAN";
  reviewerId: string;
  outcome: Exclude<RemovalOutcome, "BROKEN_EXPERIENCE">;
  notes: string;
  reviewedAt: string;
  beforeScreenshotDigest: string;
  afterScreenshotDigest: string;
  diagnosticsDigest: string;
}

export interface EvidenceBackedExcessCandidateInput {
  elementId: string;
  selector: string;
  purposes: readonly ElementPurpose[];
  rationale: string;
  artifact: RemovalExperimentArtifact;
  review?: RemovalEvidenceReview;
}

export interface ExcessFinding {
  elementId: string;
  verdict: VerdictState;
  code: "MISSING_PURPOSE" | "REMOVAL_NOT_TESTED" | "EXCESS_CONFIRMED" | "PURPOSE_SUPPORTED";
  message: string;
  evidenceIds: readonly string[];
}

export interface ExcessRemovalReport {
  authority: "NEXUS_EXCESS_REMOVAL_GATE";
  verdict: VerdictState;
  findings: readonly ExcessFinding[];
}

const SHA256 = /^sha256:[a-f0-9]{64}$/;
const PURPOSES = new Set<ElementPurpose>(["HIERARCHY", "COMPREHENSION", "INTERACTION", "IDENTITY", "ACCESSIBILITY", "CONTENT"]);

function canonicalTimestamp(value: string): boolean {
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString() === value;
}

function validObservation(observation: RemovalObservation): boolean {
  return observation.notes.trim().length > 0
    && observation.evidenceIds.length > 0
    && observation.evidenceIds.every((id) => id.trim().length > 0);
}

function validatePurposes(purposes: readonly ElementPurpose[], elementId: string): readonly ElementPurpose[] {
  if (!Array.isArray(purposes) || purposes.some((purpose) => !PURPOSES.has(purpose))) throw new Error(`invalid purposes for ${elementId}`);
  if (new Set(purposes).size !== purposes.length) throw new Error(`duplicate purposes for ${elementId}`);
  return Object.freeze([...purposes]);
}

function experimentEvidenceIds(artifact: RemovalExperimentArtifact): readonly string[] {
  return Object.freeze([artifact.beforeScreenshotDigest, artifact.afterScreenshotDigest, artifact.diagnosticsDigest]);
}

function validateExperimentBinding(input: EvidenceBackedExcessCandidateInput): void {
  const { artifact } = input;
  if (!input.elementId.trim() || !input.selector.trim()) throw new Error("evidence-backed excess candidate requires elementId and selector");
  if (artifact.elementId !== input.elementId) throw new Error(`removal artifact elementId ${artifact.elementId} does not match ${input.elementId}`);
  if (artifact.selector !== input.selector) throw new Error(`removal artifact selector does not match ${input.elementId}`);
  if (artifact.removedNodeCount !== 1 || artifact.before.selectorCount !== 1 || artifact.after.selectorCount !== 0 || artifact.after.target.present) {
    throw new Error(`removal artifact for ${input.elementId} does not prove an exact one-node removal`);
  }
  for (const digest of experimentEvidenceIds(artifact)) {
    if (!SHA256.test(digest)) throw new Error(`removal artifact for ${input.elementId} contains an invalid evidence digest`);
  }
  if (artifact.before.target.visible && artifact.beforeScreenshotDigest === artifact.afterScreenshotDigest) {
    throw new Error(`visible removal candidate ${input.elementId} produced identical before/after screenshots`);
  }
}

function objectiveBreakage(input: EvidenceBackedExcessCandidateInput): string | undefined {
  const { before, after } = input.artifact;
  if (before.mainLandmarkCount > 0 && after.mainLandmarkCount === 0) return "removal eliminated the page main landmark";
  if (before.headingOneCount > 0 && after.headingOneCount === 0) return "removal eliminated the page level-one heading";
  if (before.visibleElementCount > 0 && after.visibleElementCount === 0) return "removal eliminated all visible page elements";
  if (before.textCharacterCount > 0 && after.textCharacterCount === 0) return "removal eliminated all rendered page text";
  if (input.purposes.includes("INTERACTION") && before.interactiveElementCount > 0 && after.interactiveElementCount === 0) return "removal eliminated all interactive controls";
  if (input.purposes.includes("ACCESSIBILITY") && before.focusableElementCount > 0 && after.focusableElementCount === 0) return "removal eliminated all focusable controls";
  return undefined;
}

function validateReview(review: RemovalEvidenceReview, input: EvidenceBackedExcessCandidateInput): void {
  if (review.reviewerType !== "HUMAN") throw new Error(`removal review for ${input.elementId} must be HUMAN`);
  if (review.elementId !== input.elementId) throw new Error(`removal review elementId does not match ${input.elementId}`);
  if (!review.reviewerId.trim() || !review.notes.trim()) throw new Error(`removal review for ${input.elementId} requires reviewerId and notes`);
  if (!canonicalTimestamp(review.reviewedAt)) throw new Error(`removal review for ${input.elementId} requires canonical reviewedAt`);
  if (!["MEANINGFUL_LOSS", "NO_MATERIAL_LOSS"].includes(review.outcome)) throw new Error(`removal review for ${input.elementId} has invalid outcome`);
  if (review.beforeScreenshotDigest !== input.artifact.beforeScreenshotDigest
    || review.afterScreenshotDigest !== input.artifact.afterScreenshotDigest
    || review.diagnosticsDigest !== input.artifact.diagnosticsDigest) {
    throw new Error(`removal review for ${input.elementId} is not bound to the executed experiment evidence`);
  }
}

export function createEvidenceBackedExcessCandidate(input: EvidenceBackedExcessCandidateInput): ExcessCandidate {
  validateExperimentBinding(input);
  const purposes = validatePurposes(input.purposes, input.elementId);
  const evidenceIds = experimentEvidenceIds(input.artifact);
  const brokenReason = objectiveBreakage(input);
  if (brokenReason) {
    return Object.freeze({
      elementId: input.elementId.trim(),
      purposes,
      rationale: input.rationale.trim(),
      observation: Object.freeze({
        outcome: "BROKEN_EXPERIENCE",
        evidenceIds,
        notes: `Objective removal invariant failed: ${brokenReason}.`,
      }),
    });
  }
  if (!input.review) {
    return Object.freeze({ elementId: input.elementId.trim(), purposes, rationale: input.rationale.trim() });
  }
  validateReview(input.review, input);
  return Object.freeze({
    elementId: input.elementId.trim(),
    purposes,
    rationale: input.rationale.trim(),
    observation: Object.freeze({
      outcome: input.review.outcome,
      evidenceIds,
      notes: input.review.notes.trim(),
    }),
  });
}

export function evaluateExcessRemoval(candidates: readonly ExcessCandidate[]): ExcessRemovalReport {
  if (!candidates.length) {
    return Object.freeze({ authority: "NEXUS_EXCESS_REMOVAL_GATE", verdict: "NOT_TESTED", findings: Object.freeze([]) });
  }
  if (new Set(candidates.map((candidate) => candidate.elementId)).size !== candidates.length) throw new Error("excess candidates require unique elementId values");

  const findings: ExcessFinding[] = candidates.map((candidate) => {
    if (!candidate.elementId.trim()) throw new Error("excess candidate elementId is required");
    validatePurposes(candidate.purposes, candidate.elementId);
    if (!candidate.rationale.trim() || !candidate.purposes.length) {
      return Object.freeze({
        elementId: candidate.elementId,
        verdict: "FAIL" as const,
        code: "MISSING_PURPOSE" as const,
        message: "Element has no explicit product/design purpose and must not ship as unexplained decoration.",
        evidenceIds: Object.freeze([]),
      });
    }
    if (!candidate.observation) {
      return Object.freeze({
        elementId: candidate.elementId,
        verdict: "NOT_TESTED" as const,
        code: "REMOVAL_NOT_TESTED" as const,
        message: "Purpose is declared, but removal was not tested against evidence.",
        evidenceIds: Object.freeze([]),
      });
    }
    if (!validObservation(candidate.observation)) throw new Error(`removal observation for ${candidate.elementId} requires notes and evidenceIds`);
    if (candidate.observation.outcome === "NO_MATERIAL_LOSS") {
      return Object.freeze({
        elementId: candidate.elementId,
        verdict: "FAIL" as const,
        code: "EXCESS_CONFIRMED" as const,
        message: "Removal produced no material loss; element is excess until a supported purpose is demonstrated.",
        evidenceIds: Object.freeze([...candidate.observation.evidenceIds]),
      });
    }
    return Object.freeze({
      elementId: candidate.elementId,
      verdict: "PASS" as const,
      code: "PURPOSE_SUPPORTED" as const,
      message: candidate.observation.outcome === "BROKEN_EXPERIENCE"
        ? "Removal broke the experience; evidence supports the element as necessary."
        : "Removal caused meaningful loss; evidence supports the declared purpose.",
      evidenceIds: Object.freeze([...candidate.observation.evidenceIds]),
    });
  });

  const verdict: VerdictState = findings.some((finding) => finding.verdict === "FAIL")
    ? "FAIL"
    : findings.some((finding) => finding.verdict === "NOT_TESTED")
      ? "NOT_TESTED"
      : findings.some((finding) => finding.verdict === "WARNING")
        ? "WARNING"
        : "PASS";

  return Object.freeze({ authority: "NEXUS_EXCESS_REMOVAL_GATE", verdict, findings: Object.freeze(findings) });
}
