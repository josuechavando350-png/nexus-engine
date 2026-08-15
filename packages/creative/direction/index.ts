import type { RankedMemory } from "../memory";
import { assertCanonicalId, assertNonEmpty, assertScope, lexicalCompare, type CreativeScope } from "../shared";

export type DirectionAuthority = "PROPOSED_DIRECTION";
export type DirectionFactor = "BRIEF" | "BRAND" | "MEMORY" | "CONSTRAINTS";

export type DirectionErrorCode =
  | "INVALID_INPUT"
  | "INVALID_CONFIGURATION"
  | "SCOPE_MISMATCH"
  | "INCONSISTENT_EVIDENCE"
  | "NO_VALID_CANDIDATES"
  | "UNRESOLVABLE_CONFLICT";

export class DirectionError extends Error {
  constructor(readonly code: DirectionErrorCode, message: string) {
    super(message);
    this.name = "DirectionError";
  }
}

export type CreativeBrief = Readonly<{
  briefId: string;
  scope: CreativeScope;
  subjectId: string;
  objective: string;
  keywords: readonly string[];
  constraints: readonly string[];
}>;

export type DirectionCandidate = Readonly<{
  directionId: string;
  label: string;
  keywords: readonly string[];
  brandSignals: readonly string[];
  satisfiesConstraints: readonly string[];
  confidence: number;
}>;

export type DirectionWeights = Readonly<Record<DirectionFactor, number>>;

export type DirectionConfig = Readonly<{
  weights: DirectionWeights;
  minimumCandidateConfidence: number;
  rejectConflictedEvidence: boolean;
}>;

export type DirectionEvidence = Readonly<{
  recordId: string;
  evidenceIds: readonly string[];
  score: number;
  stale: boolean;
  superseded: boolean;
  conflicts: readonly string[];
}>;

export type CandidateEvaluation = Readonly<{
  directionId: string;
  accepted: boolean;
  score: number;
  factors: Readonly<Record<DirectionFactor, number>>;
  reasons: readonly string[];
  evidenceRecordIds: readonly string[];
  evidenceIds: readonly string[];
}>;

export type DirectionTraceEntry = Readonly<{
  rank: number;
  directionId: string;
  score: number;
  accepted: boolean;
  reason: string;
}>;

export type DirectionProposal = Readonly<{
  authority: DirectionAuthority;
  mayFinalizeDirection: false;
  scope: CreativeScope;
  briefId: string;
  subjectId: string;
  recommendedDirectionId: string;
  confidence: number;
  rationale: readonly string[];
  conflicts: readonly string[];
  evaluations: readonly CandidateEvaluation[];
  trace: readonly DirectionTraceEntry[];
}>;

const normalize = (value: string): string => value.trim().toLowerCase();
const unique = (values: readonly string[]): string[] => [...new Set(values.map(normalize).filter(Boolean))].sort(lexicalCompare);
const overlap = (left: readonly string[], right: readonly string[]): number => {
  const a = unique(left);
  const b = new Set(unique(right));
  return a.length ? a.filter((item) => b.has(item)).length / a.length : 0;
};
const clamp = (value: number): number => Math.max(0, Math.min(1, value));

function validateConfig(config: DirectionConfig): void {
  if (!Number.isFinite(config.minimumCandidateConfidence) || config.minimumCandidateConfidence < 0 || config.minimumCandidateConfidence > 1) {
    throw new DirectionError("INVALID_CONFIGURATION", "minimumCandidateConfidence must be in [0,1]");
  }
  let total = 0;
  for (const factor of ["BRIEF", "BRAND", "MEMORY", "CONSTRAINTS"] as const) {
    const weight = config.weights[factor];
    if (!Number.isFinite(weight) || weight < 0 || weight > 1) throw new DirectionError("INVALID_CONFIGURATION", `${factor} weight must be in [0,1]`);
    total += weight;
  }
  if (Math.abs(total - 1) > 1e-9) throw new DirectionError("INVALID_CONFIGURATION", "direction weights must sum to 1");
}

function validateBrief(brief: CreativeBrief): void {
  try {
    assertScope(brief.scope);
    assertCanonicalId(brief.briefId, "brief.briefId");
    assertCanonicalId(brief.subjectId, "brief.subjectId");
    assertNonEmpty(brief.objective, "brief.objective");
  } catch (error) {
    throw new DirectionError("INVALID_INPUT", error instanceof Error ? error.message : "invalid brief");
  }
  if (!Array.isArray(brief.keywords) || !Array.isArray(brief.constraints) || brief.keywords.some((v) => typeof v !== "string" || !v.trim()) || brief.constraints.some((v) => typeof v !== "string" || !v.trim())) {
    throw new DirectionError("INVALID_INPUT", "brief keywords and constraints must contain non-empty strings");
  }
}

function validateCandidate(candidate: DirectionCandidate): void {
  try {
    assertCanonicalId(candidate.directionId, "candidate.directionId");
    assertNonEmpty(candidate.label, "candidate.label");
  } catch (error) {
    throw new DirectionError("INVALID_INPUT", error instanceof Error ? error.message : "invalid candidate");
  }
  if (!Number.isFinite(candidate.confidence) || candidate.confidence < 0 || candidate.confidence > 1) throw new DirectionError("INVALID_INPUT", "candidate confidence must be in [0,1]");
  for (const values of [candidate.keywords, candidate.brandSignals, candidate.satisfiesConstraints]) {
    if (!Array.isArray(values) || values.some((value) => typeof value !== "string" || !value.trim())) throw new DirectionError("INVALID_INPUT", "candidate signals must be non-empty strings");
  }
}

function memoryDirection(record: RankedMemory): string | undefined {
  const payload = record.record.payload;
  return payload.kind === "OBSERVATION" ? undefined : payload.directionId;
}

export class DeterministicArtDirectionEngine {
  propose(input: Readonly<{
    brief: CreativeBrief;
    candidates: readonly DirectionCandidate[];
    memory: readonly RankedMemory[];
    config: DirectionConfig;
  }>): DirectionProposal {
    validateBrief(input.brief);
    validateConfig(input.config);
    if (!Array.isArray(input.candidates) || !input.candidates.length) throw new DirectionError("NO_VALID_CANDIDATES", "at least one candidate is required");
    input.candidates.forEach(validateCandidate);
    if (new Set(input.candidates.map((candidate) => candidate.directionId)).size !== input.candidates.length) throw new DirectionError("INVALID_INPUT", "candidate IDs must be unique");

    for (const ranked of input.memory) {
      const scope = ranked.record.scope;
      if (scope.tenantId !== input.brief.scope.tenantId || scope.brandId !== input.brief.scope.brandId || ranked.record.subjectId !== input.brief.subjectId) {
        throw new DirectionError("SCOPE_MISMATCH", `memory record ${ranked.record.recordId} is outside brief scope`);
      }
      if (!Number.isFinite(ranked.score) || ranked.score < 0 || ranked.score > 1) throw new DirectionError("INCONSISTENT_EVIDENCE", `memory score is invalid for ${ranked.record.recordId}`);
    }

    const activeMemory = input.memory.filter((ranked) => !ranked.stale && !ranked.superseded);
    const globalConflicts = unique(activeMemory.flatMap((ranked) => ranked.conflicts));
    if (input.config.rejectConflictedEvidence && globalConflicts.length && activeMemory.every((ranked) => ranked.conflicts.length > 0)) {
      throw new DirectionError("UNRESOLVABLE_CONFLICT", "all active memory evidence is conflicted");
    }

    const evaluations = input.candidates.map((candidate): CandidateEvaluation => {
      const reasons: string[] = [];
      const constraintScore = input.brief.constraints.length ? overlap(input.brief.constraints, candidate.satisfiesConstraints) : 1;
      const briefScore = overlap(input.brief.keywords, candidate.keywords);
      const brandScore = overlap(input.brief.keywords, candidate.brandSignals);
      const related = activeMemory.filter((ranked) => memoryDirection(ranked) === candidate.directionId && (!input.config.rejectConflictedEvidence || ranked.conflicts.length === 0));
      const memoryScore = related.length ? related.reduce((sum, ranked) => sum + ranked.score * ranked.record.confidence, 0) / related.length : 0;
      const accepted = candidate.confidence >= input.config.minimumCandidateConfidence && constraintScore === 1;
      if (!accepted) reasons.push(candidate.confidence < input.config.minimumCandidateConfidence ? "candidate-confidence-below-threshold" : "constraints-not-satisfied");
      if (!related.length) reasons.push("no-active-memory-support");
      const factors = Object.freeze({ BRIEF: briefScore, BRAND: brandScore, MEMORY: clamp(memoryScore), CONSTRAINTS: constraintScore });
      const weighted = factors.BRIEF * input.config.weights.BRIEF + factors.BRAND * input.config.weights.BRAND + factors.MEMORY * input.config.weights.MEMORY + factors.CONSTRAINTS * input.config.weights.CONSTRAINTS;
      const score = accepted ? clamp(weighted * candidate.confidence) : 0;
      const evidenceRecordIds = related.map((ranked) => ranked.record.recordId).sort(lexicalCompare);
      const evidenceIds = unique(related.flatMap((ranked) => ranked.record.provenance.evidenceIds));
      return Object.freeze({ directionId: candidate.directionId, accepted, score, factors, reasons: Object.freeze(reasons.sort(lexicalCompare)), evidenceRecordIds: Object.freeze(evidenceRecordIds), evidenceIds: Object.freeze(evidenceIds) });
    }).sort((a, b) => b.score - a.score || lexicalCompare(a.directionId, b.directionId));

    const winner = evaluations.find((evaluation) => evaluation.accepted);
    if (!winner) throw new DirectionError("NO_VALID_CANDIDATES", "no candidate satisfies the brief and configuration");
    const trace = evaluations.map((evaluation, index) => Object.freeze({ rank: index + 1, directionId: evaluation.directionId, score: evaluation.score, accepted: evaluation.accepted, reason: evaluation.directionId === winner.directionId ? "highest-deterministic-score" : evaluation.reasons[0] ?? "lower-deterministic-score" }));
    const rationale = Object.freeze([`selected ${winner.directionId} by deterministic weighted evaluation`, ...winner.reasons]);
    return Object.freeze({
      authority: "PROPOSED_DIRECTION",
      mayFinalizeDirection: false,
      scope: Object.freeze({ ...input.brief.scope }),
      briefId: input.brief.briefId,
      subjectId: input.brief.subjectId,
      recommendedDirectionId: winner.directionId,
      confidence: winner.score,
      rationale,
      conflicts: Object.freeze(globalConflicts),
      evaluations: Object.freeze(evaluations),
      trace: Object.freeze(trace)
    });
  }
}
