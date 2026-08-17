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

function validObservation(observation: RemovalObservation): boolean {
  return observation.notes.trim().length > 0
    && observation.evidenceIds.length > 0
    && observation.evidenceIds.every((id) => id.trim().length > 0);
}

export function evaluateExcessRemoval(candidates: readonly ExcessCandidate[]): ExcessRemovalReport {
  if (!candidates.length) {
    return Object.freeze({ authority: "NEXUS_EXCESS_REMOVAL_GATE", verdict: "NOT_TESTED", findings: Object.freeze([]) });
  }
  if (new Set(candidates.map((candidate) => candidate.elementId)).size !== candidates.length) throw new Error("excess candidates require unique elementId values");

  const findings: ExcessFinding[] = candidates.map((candidate) => {
    if (!candidate.elementId.trim()) throw new Error("excess candidate elementId is required");
    if (!candidate.rationale.trim() || !candidate.purposes.length) {
      return Object.freeze({
        elementId: candidate.elementId,
        verdict: "FAIL" as const,
        code: "MISSING_PURPOSE" as const,
        message: "Element has no explicit product/design purpose and must not ship as unexplained decoration.",
        evidenceIds: Object.freeze([]),
      });
    }
    if (new Set(candidate.purposes).size !== candidate.purposes.length) throw new Error(`duplicate purposes for ${candidate.elementId}`);
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
