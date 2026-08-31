import { evaluateConstraint, normalizeConstraints, sha256, stable, validateProblem } from "./egraph.js";
import type {
  CandidateAssignment,
  ConstraintEvaluation,
  Counterexample,
  CounterexampleOracle,
  IrConstraint,
  SynthesisIterationRecord,
  SynthesisProblem,
  SynthesisSolver,
  VerifiedSynthesisProof,
  VerifiedSynthesisResult,
  VerifiedSynthesisStatus,
} from "./types.js";

function evaluateAll(constraints: readonly IrConstraint[], candidate: CandidateAssignment): readonly ConstraintEvaluation[] {
  return Object.freeze(constraints.map((constraint) => {
    const evaluated = evaluateConstraint(constraint, candidate);
    return Object.freeze({ constraintId: constraint.id, status: evaluated.pass ? "PASS" as const : "FAIL" as const, leftValue: evaluated.leftValue, rightValue: evaluated.rightValue });
  }));
}

function proofFor(
  problem: SynthesisProblem,
  status: VerifiedSynthesisStatus,
  normalizedConstraints: readonly IrConstraint[],
  counterexamples: readonly Counterexample[],
  iterations: readonly SynthesisIterationRecord[],
  candidate?: CandidateAssignment,
  evaluations?: readonly ConstraintEvaluation[],
): VerifiedSynthesisProof {
  const core = {
    authority: "NEXUS_VERIFIED_SYNTHESIS_PROOF_V1" as const,
    version: 1 as const,
    problemDigest: sha256(problem),
    normalizedConstraintDigest: sha256(normalizedConstraints),
    counterexampleDigest: sha256(counterexamples),
    ...(candidate ? { candidateDigest: sha256(candidate) } : {}),
    ...(evaluations ? { evaluationsDigest: sha256(evaluations) } : {}),
    iterationDigest: sha256(iterations),
    oracleEvidenceDigest: sha256(iterations.flatMap((iteration) => iteration.oracleEvidenceDigests)),
    status,
  };
  return Object.freeze({ ...core, proofDigest: sha256(core) });
}

function terminal(
  problem: SynthesisProblem,
  status: VerifiedSynthesisStatus,
  constraints: readonly IrConstraint[],
  counterexamples: readonly Counterexample[],
  iterations: readonly SynthesisIterationRecord[],
  candidate?: CandidateAssignment,
  evaluations?: readonly ConstraintEvaluation[],
): VerifiedSynthesisResult {
  const result = Object.freeze({
    status,
    problem,
    ...(candidate ? { candidate } : {}),
    ...(evaluations ? { evaluations } : {}),
    counterexamples: Object.freeze([...counterexamples]),
    iterations: Object.freeze([...iterations]),
    proof: proofFor(problem, status, constraints, counterexamples, iterations, candidate, evaluations),
  });
  verifySynthesisResult(result);
  return result;
}

export interface VerifiedSynthesisKernelOptions {
  readonly solver: SynthesisSolver;
  readonly oracles?: readonly CounterexampleOracle[];
}

export class VerifiedSynthesisKernel {
  readonly #solver: SynthesisSolver;
  readonly #oracles: readonly CounterexampleOracle[];

  constructor(options: VerifiedSynthesisKernelOptions) {
    if (!options?.solver) throw new Error("verified synthesis solver is required");
    if (options.oracles && (!Array.isArray(options.oracles) || options.oracles.length > 8)) throw new Error("counterexample oracle count exceeds supported bound");
    const authorities = new Set<string>();
    for (const oracle of options.oracles ?? []) {
      if (!oracle || (oracle.authority !== "RUNTIME" && oracle.authority !== "BROWSER")) throw new Error("invalid counterexample oracle");
      if (authorities.has(oracle.authority)) throw new Error(`duplicate ${oracle.authority} oracle`);
      authorities.add(oracle.authority);
    }
    this.#solver = options.solver;
    this.#oracles = Object.freeze([...(options.oracles ?? [])]);
  }

  async synthesize(problem: SynthesisProblem, signal: AbortSignal = new AbortController().signal): Promise<VerifiedSynthesisResult> {
    validateProblem(problem);
    const baseConstraints = normalizeConstraints(problem, problem.constraints);
    const constraints: IrConstraint[] = [...baseConstraints];
    const counterexamples: Counterexample[] = [];
    const iterations: SynthesisIterationRecord[] = [];
    const counterexampleEvidence = new Set<string>();

    for (let iteration = 1; iteration <= problem.budgets.maxIterations; iteration += 1) {
      if (signal.aborted) return terminal(problem, "ERROR", Object.freeze([...constraints]), counterexamples, iterations);
      const constraintSet = normalizeConstraints(problem, constraints);
      const solved = await this.#solver.solve(problem, constraintSet, signal);
      const baseRecord = {
        iteration,
        constraintSetDigest: sha256(constraintSet),
        solver: solved.evidence,
        ...(solved.candidate ? { candidateDigest: sha256(solved.candidate) } : {}),
      };
      if (solved.status !== "SAT" || !solved.candidate) {
        iterations.push(Object.freeze({ ...baseRecord, oracleEvidenceDigests: Object.freeze([]), counterexampleDigests: Object.freeze([]) }));
        const status: VerifiedSynthesisStatus = solved.status === "UNSAT" ? "UNSAT" : solved.status === "UNAVAILABLE" ? "UNAVAILABLE" : solved.status === "TIMEOUT" ? "TIMEOUT" : solved.status === "UNKNOWN" ? "NOT_VERIFIED" : "ERROR";
        return terminal(problem, status, constraintSet, counterexamples, iterations);
      }

      const candidate = solved.candidate;
      const evaluations = evaluateAll(constraintSet, candidate);
      if (evaluations.some((evaluation) => evaluation.status !== "PASS")) {
        iterations.push(Object.freeze({ ...baseRecord, oracleEvidenceDigests: Object.freeze([]), counterexampleDigests: Object.freeze([]) }));
        return terminal(problem, "ERROR", constraintSet, counterexamples, iterations, candidate, evaluations);
      }

      const oracleEvidenceDigests: string[] = [];
      const iterationCounterexamples: Counterexample[] = [];
      let terminalStatus: VerifiedSynthesisStatus | undefined;
      for (const oracle of this.#oracles) {
        const observed = await oracle.check(problem, candidate, signal);
        oracleEvidenceDigests.push(observed.evidenceDigest);
        if (observed.status === "PASS") continue;
        if (observed.status === "COUNTEREXAMPLE" && observed.counterexample) {
          if (counterexamples.length + iterationCounterexamples.length >= problem.budgets.maxCounterexamples) { terminalStatus = "NOT_VERIFIED"; break; }
          if (counterexampleEvidence.has(observed.counterexample.evidenceDigest)) { terminalStatus = "NOT_VERIFIED"; break; }
          if (constraints.some((constraint) => constraint.id === observed.counterexample?.constraint.id) || iterationCounterexamples.some((counterexample) => counterexample.constraint.id === observed.counterexample?.constraint.id)) {
            terminalStatus = "ERROR";
            break;
          }
          counterexampleEvidence.add(observed.counterexample.evidenceDigest);
          iterationCounterexamples.push(observed.counterexample);
          continue;
        }
        terminalStatus = observed.status === "UNAVAILABLE" ? "UNAVAILABLE" : observed.status === "TIMEOUT" ? "TIMEOUT" : "ERROR";
        break;
      }

      iterations.push(Object.freeze({
        ...baseRecord,
        oracleEvidenceDigests: Object.freeze(oracleEvidenceDigests),
        counterexampleDigests: Object.freeze(iterationCounterexamples.map((counterexample) => sha256(counterexample))),
      }));
      if (terminalStatus) return terminal(problem, terminalStatus, constraintSet, counterexamples, iterations, candidate, evaluations);
      if (iterationCounterexamples.length === 0) return terminal(problem, "VERIFIED", constraintSet, counterexamples, iterations, candidate, evaluations);
      counterexamples.push(...iterationCounterexamples);
      constraints.push(...iterationCounterexamples.map((counterexample) => counterexample.constraint));
    }

    const finalConstraints = normalizeConstraints(problem, constraints);
    return terminal(problem, "NOT_VERIFIED", finalConstraints, counterexamples, iterations);
  }
}

export function verifySynthesisResult(result: VerifiedSynthesisResult): void {
  if (!result || typeof result !== "object" || Array.isArray(result)) throw new Error("verified synthesis result must be an object");
  validateProblem(result.problem);
  if (!["VERIFIED", "UNSAT", "NOT_VERIFIED", "UNAVAILABLE", "TIMEOUT", "ERROR"].includes(result.status)) throw new Error("invalid verified synthesis status");
  if (!Array.isArray(result.counterexamples) || result.counterexamples.length > result.problem.budgets.maxCounterexamples) throw new Error("invalid counterexample evidence collection");
  if (!Array.isArray(result.iterations) || result.iterations.length > result.problem.budgets.maxIterations) throw new Error("invalid synthesis iteration collection");
  const constraints: IrConstraint[] = [...result.problem.constraints];
  const seenIds = new Set(constraints.map((constraint) => constraint.id));
  for (const counterexample of result.counterexamples) {
    if (!counterexample || typeof counterexample !== "object" || (counterexample.authority !== "RUNTIME" && counterexample.authority !== "BROWSER" && counterexample.authority !== "SYNTHETIC_TEST")) throw new Error("invalid counterexample evidence");
    if (!/^[a-f0-9]{64}$/.test(counterexample.evidenceDigest)) throw new Error("invalid counterexample evidence digest");
    if (seenIds.has(counterexample.constraint.id)) throw new Error("counterexample constraint id replay or collision");
    validateProblem({ ...result.problem, constraints: [counterexample.constraint] });
    seenIds.add(counterexample.constraint.id);
    constraints.push(counterexample.constraint);
  }
  const normalizedConstraints = normalizeConstraints(result.problem, constraints);
  if (result.candidate) {
    const candidateKeys = Object.keys(result.candidate).sort();
    const variableKeys = result.problem.variables.map((variable) => variable.name).sort();
    if (stable(candidateKeys) !== stable(variableKeys)) throw new Error("candidate variable set mismatch");
    for (const variable of result.problem.variables) {
      const value = result.candidate[variable.name];
      if (!Number.isSafeInteger(value) || value < variable.min || value > variable.max) throw new Error(`candidate ${variable.name} is outside bounds`);
    }
  }
  if (result.status === "VERIFIED") {
    if (!result.candidate || !result.evaluations) throw new Error("verified synthesis requires candidate and evaluations");
    const expected = evaluateAll(normalizedConstraints, result.candidate);
    if (expected.some((evaluation) => evaluation.status !== "PASS") || sha256(expected) !== sha256(result.evaluations)) throw new Error("verified synthesis evaluations do not match candidate");
    const last = result.iterations.at(-1);
    if (!last || last.counterexampleDigests.length !== 0) throw new Error("verified synthesis must end without a counterexample");
  }
  const expectedProof = proofFor(result.problem, result.status, normalizedConstraints, result.counterexamples, result.iterations, result.candidate, result.evaluations);
  if (stable(expectedProof) !== stable(result.proof)) throw new Error("verified synthesis proof digest or linkage mismatch");
}
