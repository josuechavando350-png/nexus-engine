import type { VerdictState } from "@nexus/creative";

export interface OpeningCandidate {
  openingId: string;
  concept: string;
  signatureMechanic: string;
  openingSignature: string;
  evidenceIds: readonly string[];
}

export interface OpeningEvaluation {
  openingId: string;
  creativeVerdict: VerdictState;
  visualVerdict: VerdictState;
  redTeamVerdict: VerdictState;
  businessSpecificityVerdict: VerdictState;
  findings: readonly string[];
  evidenceIds: readonly string[];
}

export interface OpeningEvaluator {
  evaluate(candidate: OpeningCandidate): Promise<OpeningEvaluation>;
}

export interface OpeningTournamentResult {
  authority: "NEXUS_OPENING_TOURNAMENT";
  status: "SELECTED" | "REGENERATE" | "NEEDS_DECISION";
  selectedOpeningId?: string;
  evaluations: readonly OpeningEvaluation[];
  eligibleOpeningIds: readonly string[];
  reason: string;
}

function validateCandidate(candidate: OpeningCandidate): void {
  if (!candidate.openingId.trim()) throw new Error("openingId is required");
  if (candidate.concept.trim().length < 24) throw new Error(`opening ${candidate.openingId} concept is too weak`);
  if (candidate.signatureMechanic.trim().length < 24) throw new Error(`opening ${candidate.openingId} signature mechanic is too weak`);
  if (!candidate.openingSignature.trim()) throw new Error(`opening ${candidate.openingId} requires an opening signature`);
  if (!candidate.evidenceIds.length || candidate.evidenceIds.some((evidenceId) => !evidenceId.trim())) throw new Error(`opening ${candidate.openingId} requires evidence`);
}

function validateEvaluation(candidate: OpeningCandidate, evaluation: OpeningEvaluation): void {
  if (evaluation.openingId !== candidate.openingId) throw new Error(`opening evaluator returned mismatched id for ${candidate.openingId}`);
  const verdicts = [evaluation.creativeVerdict, evaluation.visualVerdict, evaluation.redTeamVerdict, evaluation.businessSpecificityVerdict];
  if (verdicts.some((verdict) => !["PASS", "FAIL", "WARNING", "NOT_TESTED"].includes(verdict))) throw new Error(`opening ${candidate.openingId} returned an invalid verdict`);
  if (evaluation.findings.some((finding) => !finding.trim())) throw new Error(`opening ${candidate.openingId} returned an empty finding`);
  if (!evaluation.evidenceIds.length || evaluation.evidenceIds.some((evidenceId) => !evidenceId.trim())) throw new Error(`opening ${candidate.openingId} evaluation requires evidence`);
}

function fullyEligible(evaluation: OpeningEvaluation): boolean {
  return evaluation.creativeVerdict === "PASS"
    && evaluation.visualVerdict === "PASS"
    && evaluation.redTeamVerdict === "PASS"
    && evaluation.businessSpecificityVerdict === "PASS";
}

export async function runOpeningTournament(input: {
  candidates: readonly OpeningCandidate[];
  evaluator: OpeningEvaluator;
  briefPreferenceOrder?: readonly string[];
}): Promise<OpeningTournamentResult> {
  if (input.candidates.length < 3 || input.candidates.length > 5) throw new Error("opening tournament requires 3 to 5 candidates");
  input.candidates.forEach(validateCandidate);
  const ids = input.candidates.map((candidate) => candidate.openingId);
  if (new Set(ids).size !== ids.length) throw new Error("opening candidate ids must be unique");
  const signatures = input.candidates.map((candidate) => candidate.openingSignature.trim().toLowerCase());
  if (new Set(signatures).size !== signatures.length) throw new Error("opening candidates must have distinct structural signatures");
  const mechanics = input.candidates.map((candidate) => candidate.signatureMechanic.trim().toLowerCase());
  if (new Set(mechanics).size !== mechanics.length) throw new Error("opening candidates must have distinct signature mechanics");

  const evaluations = await Promise.all(input.candidates.map(async (candidate) => {
    const evaluation = await input.evaluator.evaluate(candidate);
    validateEvaluation(candidate, evaluation);
    return Object.freeze({ ...evaluation, findings: Object.freeze([...evaluation.findings]), evidenceIds: Object.freeze([...evaluation.evidenceIds]) });
  }));
  const eligible = evaluations.filter(fullyEligible).map((evaluation) => evaluation.openingId);

  if (!eligible.length) {
    return Object.freeze({
      authority: "NEXUS_OPENING_TOURNAMENT",
      status: "REGENERATE",
      evaluations: Object.freeze(evaluations),
      eligibleOpeningIds: Object.freeze([]),
      reason: "no opening passed every required quality dimension",
    });
  }

  if (eligible.length === 1) {
    return Object.freeze({
      authority: "NEXUS_OPENING_TOURNAMENT",
      status: "SELECTED",
      selectedOpeningId: eligible[0],
      evaluations: Object.freeze(evaluations),
      eligibleOpeningIds: Object.freeze(eligible),
      reason: "only one opening passed every required quality dimension",
    });
  }

  const preferenceOrder = input.briefPreferenceOrder ?? [];
  const unknownPreferences = preferenceOrder.filter((openingId) => !ids.includes(openingId));
  if (unknownPreferences.length) throw new Error(`brief preference order references unknown openings: ${unknownPreferences.join(", ")}`);
  const preferred = preferenceOrder.find((openingId) => eligible.includes(openingId));
  if (preferred) {
    return Object.freeze({
      authority: "NEXUS_OPENING_TOURNAMENT",
      status: "SELECTED",
      selectedOpeningId: preferred,
      evaluations: Object.freeze(evaluations),
      eligibleOpeningIds: Object.freeze(eligible),
      reason: "multiple openings passed; explicit brief preference order resolved the tie",
    });
  }

  return Object.freeze({
    authority: "NEXUS_OPENING_TOURNAMENT",
    status: "NEEDS_DECISION",
    evaluations: Object.freeze(evaluations),
    eligibleOpeningIds: Object.freeze(eligible),
    reason: "multiple openings passed and no evidence-backed brief preference resolves the tie",
  });
}
