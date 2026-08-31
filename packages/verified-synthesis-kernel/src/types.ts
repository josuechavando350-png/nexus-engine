export type SynthesisScalar = number;

export type IrExpression =
  | { readonly kind: "const"; readonly value: number }
  | { readonly kind: "var"; readonly name: string }
  | { readonly kind: "add" | "sub" | "mul" | "min" | "max"; readonly left: IrExpression; readonly right: IrExpression };

export type IrRelation = "EQ" | "LE" | "GE";

export interface IrConstraint {
  readonly id: string;
  readonly left: IrExpression;
  readonly relation: IrRelation;
  readonly right: IrExpression;
}

export interface SynthesisVariable {
  readonly name: string;
  readonly min: number;
  readonly max: number;
}

export interface SynthesisScope {
  readonly tenantId: string;
  readonly organizationId: string;
  readonly projectId: string;
}

export interface SynthesisBudgets {
  readonly maxIterations: number;
  readonly maxCandidates: number;
  readonly maxCounterexamples: number;
  readonly maxEGraphIterations: number;
  readonly maxEGraphNodes: number;
  readonly solverTimeoutMs: number;
  readonly oracleTimeoutMs: number;
}

export interface SynthesisProblem {
  readonly authority: "NEXUS_VERIFIED_SYNTHESIS_PROBLEM_V1";
  readonly scope: SynthesisScope;
  readonly problemId: string;
  readonly variables: readonly SynthesisVariable[];
  readonly constraints: readonly IrConstraint[];
  readonly budgets: SynthesisBudgets;
}

export type CandidateAssignment = Readonly<Record<string, number>>;

export type ConstraintEvaluationStatus = "PASS" | "FAIL";

export interface ConstraintEvaluation {
  readonly constraintId: string;
  readonly status: ConstraintEvaluationStatus;
  readonly leftValue: number;
  readonly rightValue: number;
}

export type SolverStatus = "SAT" | "UNSAT" | "UNKNOWN" | "TIMEOUT" | "UNAVAILABLE" | "ERROR";
export type SolverKind = "INTERNAL_BOUNDED" | "SMT" | "SYGUS";

export interface SolverEvidence {
  readonly solverKind: SolverKind;
  readonly implementation: string;
  readonly status: SolverStatus;
  readonly toolVersion?: string;
  readonly queryDigest: string;
  readonly outputDigest?: string;
  readonly durationMs: number;
}

export interface SolverResult {
  readonly status: SolverStatus;
  readonly candidate?: CandidateAssignment;
  readonly evidence: SolverEvidence;
}

export type CounterexampleAuthority = "RUNTIME" | "BROWSER" | "SYNTHETIC_TEST";
export type CounterexampleStatus = "PASS" | "COUNTEREXAMPLE" | "UNAVAILABLE" | "TIMEOUT" | "ERROR";

export interface Counterexample {
  readonly id: string;
  readonly authority: CounterexampleAuthority;
  readonly constraint: IrConstraint;
  readonly evidenceDigest: string;
}

export interface OracleResult {
  readonly status: CounterexampleStatus;
  readonly counterexample?: Counterexample;
  readonly evidenceDigest: string;
  readonly durationMs: number;
}

export interface CounterexampleOracle {
  readonly authority: Exclude<CounterexampleAuthority, "SYNTHETIC_TEST">;
  check(problem: SynthesisProblem, candidate: CandidateAssignment, signal: AbortSignal): Promise<OracleResult>;
}

export interface SynthesisSolver {
  readonly kind: SolverKind;
  solve(problem: SynthesisProblem, constraints: readonly IrConstraint[], signal: AbortSignal): Promise<SolverResult>;
}

export interface SynthesisIterationRecord {
  readonly iteration: number;
  readonly constraintSetDigest: string;
  readonly solver: SolverEvidence;
  readonly candidateDigest?: string;
  readonly oracleEvidenceDigests: readonly string[];
  readonly counterexampleDigests: readonly string[];
}

export type VerifiedSynthesisStatus = "VERIFIED" | "UNSAT" | "NOT_VERIFIED" | "UNAVAILABLE" | "TIMEOUT" | "ERROR";

export interface VerifiedSynthesisProof {
  readonly authority: "NEXUS_VERIFIED_SYNTHESIS_PROOF_V1";
  readonly version: 1;
  readonly problemDigest: string;
  readonly normalizedConstraintDigest: string;
  readonly counterexampleDigest: string;
  readonly candidateDigest?: string;
  readonly evaluationsDigest?: string;
  readonly iterationDigest: string;
  readonly oracleEvidenceDigest: string;
  readonly status: VerifiedSynthesisStatus;
  readonly proofDigest: string;
}

export interface VerifiedSynthesisResult {
  readonly status: VerifiedSynthesisStatus;
  readonly problem: SynthesisProblem;
  readonly candidate?: CandidateAssignment;
  readonly evaluations?: readonly ConstraintEvaluation[];
  readonly counterexamples: readonly Counterexample[];
  readonly iterations: readonly SynthesisIterationRecord[];
  readonly proof: VerifiedSynthesisProof;
}
