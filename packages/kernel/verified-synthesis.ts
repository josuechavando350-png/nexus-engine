import { createHash } from "node:crypto";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

export type Scalar = number | boolean;
export type ValueType = "NUMBER" | "BOOLEAN";
export type SolverKind = "SMT" | "SYGUS";
export type SolverStatus = "SAT" | "UNSAT" | "UNKNOWN" | "UNAVAILABLE" | "TIMEOUT" | "CANCELLED" | "ERROR";

export type Expr =
  | { readonly kind: "const"; readonly value: Scalar }
  | { readonly kind: "var"; readonly name: string; readonly valueType: ValueType }
  | { readonly kind: "add" | "sub" | "mul"; readonly left: Expr; readonly right: Expr }
  | { readonly kind: "eq" | "lt" | "le"; readonly left: Expr; readonly right: Expr }
  | { readonly kind: "and" | "or"; readonly left: Expr; readonly right: Expr }
  | { readonly kind: "not"; readonly value: Expr }
  | { readonly kind: "ite"; readonly condition: Expr; readonly whenTrue: Expr; readonly whenFalse: Expr };

export interface TypedProgram {
  readonly version: 1;
  readonly programId: string;
  readonly tenantId: string;
  readonly scopeId: string;
  readonly outputType: ValueType;
  readonly expression: Expr;
}

export interface Example {
  readonly inputs: Readonly<Record<string, Scalar>>;
  readonly expected: Scalar;
}

export interface SynthesisBudget {
  readonly maxCandidates: number;
  readonly maxIterations: number;
  readonly maxExpressionNodes: number;
  readonly maxExamples: number;
  readonly timeoutMs: number;
}

export interface Counterexample {
  readonly inputs: Readonly<Record<string, Scalar>>;
  readonly expected: Scalar;
  readonly source: "RUNTIME" | "BROWSER" | "CALLER";
  readonly sourceDigest: string;
}

export interface CounterexampleOracle {
  readonly kind: "RUNTIME" | "BROWSER";
  findCounterexample(program: TypedProgram, signal: AbortSignal): Promise<Counterexample | null>;
}

export interface SolverRequest {
  readonly tenantId: string;
  readonly scopeId: string;
  readonly kind: SolverKind;
  readonly input: string;
  readonly timeoutMs: number;
}

export interface SolverResult {
  readonly kind: SolverKind;
  readonly status: SolverStatus;
  readonly stdout: string;
  readonly stderr: string;
  readonly solver: string;
  readonly requestDigest: string;
  readonly resultDigest: string;
}

export interface SolverAdapter {
  readonly kind: SolverKind;
  solve(request: SolverRequest, signal?: AbortSignal): Promise<SolverResult>;
}

export interface EqualitySaturationResult {
  readonly canonical: Expr;
  readonly explored: number;
  readonly iterations: number;
  readonly status: "SATURATED" | "BOUNDED";
  readonly digest: string;
}

export interface SynthesisProof {
  readonly authority: "NEXUS_VERIFIED_SYNTHESIS_V1";
  readonly tenantId: string;
  readonly scopeId: string;
  readonly programDigest: string;
  readonly examplesDigest: string;
  readonly counterexamplesDigest: string;
  readonly equalityDigest: string;
  readonly solverDigests: readonly string[];
  readonly outcome: "VERIFIED" | "NOT_VERIFIED" | "UNAVAILABLE";
  readonly stopReason: "VERIFIED" | "EXHAUSTED" | "CANCELLED" | "TIMEOUT" | "SOLVER_UNAVAILABLE";
  readonly proofDigest: string;
}

export interface SynthesisResult {
  readonly status: "VERIFIED" | "NOT_VERIFIED" | "UNAVAILABLE";
  readonly program: TypedProgram | null;
  readonly examples: readonly Example[];
  readonly counterexamples: readonly Counterexample[];
  readonly solverResults: readonly SolverResult[];
  readonly equality: EqualitySaturationResult | null;
  readonly proof: SynthesisProof;
  readonly events: readonly ({ readonly type: "CANDIDATE_TESTED" | "COUNTEREXAMPLE_ADDED" | "SOLVER_INVOKED" | "VERIFIED" | "BOUNDED_STOP"; readonly index: number })[];
}

const DEFAULT_BUDGET: SynthesisBudget = Object.freeze({ maxCandidates: 128, maxIterations: 32, maxExpressionNodes: 256, maxExamples: 128, timeoutMs: 5_000 });

function stable(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stable(record[key])}`).join(",")}}`;
}

export function digest(value: unknown): string {
  return createHash("sha256").update(stable(value)).digest("hex");
}

function assertId(name: string, value: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value)) throw new Error(`${name} is invalid`);
}

function typeOfExpr(expr: Expr, seen: { count: number }, maxNodes: number): ValueType {
  seen.count += 1;
  if (seen.count > maxNodes) throw new Error("Expression node budget exceeded");
  switch (expr.kind) {
    case "const":
      if (typeof expr.value === "number" && !Number.isFinite(expr.value)) throw new Error("Numeric constants must be finite");
      return typeof expr.value === "number" ? "NUMBER" : "BOOLEAN";
    case "var": assertId("variable name", expr.name); return expr.valueType;
    case "add": case "sub": case "mul":
      if (typeOfExpr(expr.left, seen, maxNodes) !== "NUMBER" || typeOfExpr(expr.right, seen, maxNodes) !== "NUMBER") throw new Error(`${expr.kind} requires NUMBER operands`);
      return "NUMBER";
    case "eq": {
      const left = typeOfExpr(expr.left, seen, maxNodes); const right = typeOfExpr(expr.right, seen, maxNodes);
      if (left !== right) throw new Error("eq operands must have the same type");
      return "BOOLEAN";
    }
    case "lt": case "le":
      if (typeOfExpr(expr.left, seen, maxNodes) !== "NUMBER" || typeOfExpr(expr.right, seen, maxNodes) !== "NUMBER") throw new Error(`${expr.kind} requires NUMBER operands`);
      return "BOOLEAN";
    case "and": case "or":
      if (typeOfExpr(expr.left, seen, maxNodes) !== "BOOLEAN" || typeOfExpr(expr.right, seen, maxNodes) !== "BOOLEAN") throw new Error(`${expr.kind} requires BOOLEAN operands`);
      return "BOOLEAN";
    case "not":
      if (typeOfExpr(expr.value, seen, maxNodes) !== "BOOLEAN") throw new Error("not requires BOOLEAN operand");
      return "BOOLEAN";
    case "ite": {
      if (typeOfExpr(expr.condition, seen, maxNodes) !== "BOOLEAN") throw new Error("ite condition must be BOOLEAN");
      const whenTrue = typeOfExpr(expr.whenTrue, seen, maxNodes); const whenFalse = typeOfExpr(expr.whenFalse, seen, maxNodes);
      if (whenTrue !== whenFalse) throw new Error("ite branches must have same type");
      return whenTrue;
    }
  }
}

export function validateProgram(program: TypedProgram, maxNodes = DEFAULT_BUDGET.maxExpressionNodes): void {
  if (program.version !== 1) throw new Error("Unsupported program version");
  assertId("programId", program.programId); assertId("tenantId", program.tenantId); assertId("scopeId", program.scopeId);
  if (typeOfExpr(program.expression, { count: 0 }, maxNodes) !== program.outputType) throw new Error("Program output type mismatch");
}

export function evaluate(program: TypedProgram, inputs: Readonly<Record<string, Scalar>>, maxNodes = DEFAULT_BUDGET.maxExpressionNodes): Scalar {
  validateProgram(program, maxNodes);
  let count = 0;
  const visit = (expr: Expr): Scalar => {
    count += 1; if (count > maxNodes) throw new Error("Evaluation node budget exceeded");
    switch (expr.kind) {
      case "const": return expr.value;
      case "var": {
        if (!(expr.name in inputs)) throw new Error(`Missing input ${expr.name}`);
        const value = inputs[expr.name];
        if ((expr.valueType === "NUMBER") !== (typeof value === "number")) throw new Error(`Input type mismatch for ${expr.name}`);
        if (typeof value === "number" && !Number.isFinite(value)) throw new Error(`Input ${expr.name} must be finite`);
        return value;
      }
      case "add": return (visit(expr.left) as number) + (visit(expr.right) as number);
      case "sub": return (visit(expr.left) as number) - (visit(expr.right) as number);
      case "mul": return (visit(expr.left) as number) * (visit(expr.right) as number);
      case "eq": return visit(expr.left) === visit(expr.right);
      case "lt": return (visit(expr.left) as number) < (visit(expr.right) as number);
      case "le": return (visit(expr.left) as number) <= (visit(expr.right) as number);
      case "and": return (visit(expr.left) as boolean) && (visit(expr.right) as boolean);
      case "or": return (visit(expr.left) as boolean) || (visit(expr.right) as boolean);
      case "not": return !(visit(expr.value) as boolean);
      case "ite": return (visit(expr.condition) as boolean) ? visit(expr.whenTrue) : visit(expr.whenFalse);
    }
  };
  const result = visit(program.expression);
  if (typeof result === "number" && !Number.isFinite(result)) throw new Error("Program produced non-finite output");
  return result;
}

function normalize(expr: Expr): Expr {
  switch (expr.kind) {
    case "const": case "var": return expr;
    case "not": {
      const value = normalize(expr.value);
      if (value.kind === "const" && typeof value.value === "boolean") return { kind: "const", value: !value.value };
      return { kind: "not", value };
    }
    case "ite": {
      const condition = normalize(expr.condition); const whenTrue = normalize(expr.whenTrue); const whenFalse = normalize(expr.whenFalse);
      if (condition.kind === "const" && typeof condition.value === "boolean") return condition.value ? whenTrue : whenFalse;
      if (digest(whenTrue) === digest(whenFalse)) return whenTrue;
      return { kind: "ite", condition, whenTrue, whenFalse };
    }
    default: {
      let left = normalize(expr.left); let right = normalize(expr.right);
      if (["add", "mul", "eq", "and", "or"].includes(expr.kind) && digest(left) > digest(right)) [left, right] = [right, left];
      if (expr.kind === "add" && right.kind === "const" && right.value === 0) return left;
      if (expr.kind === "mul" && right.kind === "const" && right.value === 1) return left;
      if (expr.kind === "mul" && right.kind === "const" && right.value === 0) return right;
      if (left.kind === "const" && right.kind === "const") {
        const outputType: ValueType = ["add", "sub", "mul"].includes(expr.kind) ? "NUMBER" : "BOOLEAN";
        const folded: TypedProgram = { version: 1, programId: "fold", tenantId: "fold", scopeId: "fold", outputType, expression: { ...expr, left, right } as Expr };
        return { kind: "const", value: evaluate(folded, {}) };
      }
      return { ...expr, left, right } as Expr;
    }
  }
}

export function equalitySaturate(expression: Expr, limits: Pick<SynthesisBudget, "maxIterations" | "maxExpressionNodes"> = DEFAULT_BUDGET): EqualitySaturationResult {
  const eclass = new Map<string, Expr>();
  let current = expression; let iterations = 0; let saturated = false;
  while (iterations < limits.maxIterations) {
    typeOfExpr(current, { count: 0 }, limits.maxExpressionNodes);
    const before = digest(current); eclass.set(before, current);
    const rewritten = normalize(current); const after = digest(rewritten); eclass.set(after, rewritten);
    iterations += 1;
    current = rewritten;
    if (before === after) { saturated = true; break; }
  }
  const canonical = [...eclass.values()].sort((a, b) => stable(a).localeCompare(stable(b)))[0] ?? current;
  return Object.freeze({ canonical, explored: eclass.size, iterations, status: saturated ? "SATURATED" : "BOUNDED", digest: digest({ canonical, members: [...eclass.keys()].sort(), iterations, saturated }) });
}

export class ProcessSolverAdapter implements SolverAdapter {
  public constructor(public readonly kind: SolverKind, private readonly executable: string, private readonly args: readonly string[] = []) {
    if (!executable.trim()) throw new Error("Solver executable cannot be empty");
  }

  public async solve(request: SolverRequest, signal?: AbortSignal): Promise<SolverResult> {
    if (request.kind !== this.kind) throw new Error("Solver request kind mismatch");
    assertId("tenantId", request.tenantId); assertId("scopeId", request.scopeId);
    if (!Number.isInteger(request.timeoutMs) || request.timeoutMs < 10 || request.timeoutMs > 60_000) throw new Error("Invalid solver timeout");
    if (!request.input || Buffer.byteLength(request.input) > 256_000) throw new Error("Solver input is empty or too large");
    const requestDigest = digest({ tenantId: request.tenantId, scopeId: request.scopeId, kind: request.kind, input: request.input });
    return await new Promise<SolverResult>((resolve) => {
      let stdout = ""; let stderr = ""; let settled = false; let child: ChildProcessWithoutNullStreams | null = null; let timer: NodeJS.Timeout | undefined;
      const onAbort = (): void => { child?.kill("SIGKILL"); finish("CANCELLED"); };
      const finish = (status: SolverStatus): void => {
        if (settled) return; settled = true;
        if (timer) clearTimeout(timer); signal?.removeEventListener("abort", onAbort);
        const clippedOut = stdout.slice(0, 256_000); const clippedErr = stderr.slice(0, 32_000);
        resolve(Object.freeze({ kind: this.kind, status, stdout: clippedOut, stderr: clippedErr, solver: this.executable, requestDigest, resultDigest: digest({ kind: this.kind, status, stdout: clippedOut, stderr: clippedErr, solver: this.executable, requestDigest }) }));
      };
      if (signal?.aborted) { finish("CANCELLED"); return; }
      try { child = spawn(this.executable, [...this.args], { stdio: ["pipe", "pipe", "pipe"], shell: false }); }
      catch (error) { stderr = error instanceof Error ? error.message : "spawn failed"; finish("UNAVAILABLE"); return; }
      timer = setTimeout(() => { child?.kill("SIGKILL"); finish("TIMEOUT"); }, request.timeoutMs);
      signal?.addEventListener("abort", onAbort, { once: true });
      child.on("error", (error: NodeJS.ErrnoException) => { stderr += error.message; finish(error.code === "ENOENT" ? "UNAVAILABLE" : "ERROR"); });
      child.stdout.on("data", (chunk: Buffer) => { if (stdout.length < 256_000) stdout += chunk.toString("utf8"); });
      child.stderr.on("data", (chunk: Buffer) => { if (stderr.length < 32_000) stderr += chunk.toString("utf8"); });
      child.on("close", (code) => {
        if (settled) return;
        if (code !== 0) { finish("ERROR"); return; }
        const first = stdout.trim().split(/\s+/u)[0]?.toLowerCase();
        finish(first === "sat" ? "SAT" : first === "unsat" ? "UNSAT" : "UNKNOWN");
      });
      child.stdin.end(request.input);
    });
  }
}

export class SmtLibAdapter extends ProcessSolverAdapter { public constructor(executable = "z3") { super("SMT", executable, ["-in", "-smt2"]); } }
export class SyGuSAdapter extends ProcessSolverAdapter { public constructor(executable = "cvc5") { super("SYGUS", executable, ["--lang=sygus2"]); } }

function resolveBudget(input?: Partial<SynthesisBudget>): SynthesisBudget {
  const value = { ...DEFAULT_BUDGET, ...input };
  for (const [key, raw] of Object.entries(value)) if (!Number.isInteger(raw) || raw <= 0) throw new Error(`Invalid budget ${key}`);
  if (value.maxCandidates > 10_000 || value.maxIterations > 1_000 || value.maxExpressionNodes > 10_000 || value.maxExamples > 10_000 || value.timeoutMs > 60_000) throw new Error("Synthesis budget exceeds hard limit");
  return Object.freeze(value);
}

function validateExample(example: Example, outputType: ValueType): void {
  if ((outputType === "NUMBER") !== (typeof example.expected === "number")) throw new Error("Example expected type mismatch");
  if (typeof example.expected === "number" && !Number.isFinite(example.expected)) throw new Error("Example expected must be finite");
  if (Object.keys(example.inputs).length > 64) throw new Error("Too many example inputs");
  for (const [name, value] of Object.entries(example.inputs)) { assertId("input name", name); if (typeof value === "number" && !Number.isFinite(value)) throw new Error(`Input ${name} must be finite`); }
}

function finalize(input: { readonly tenantId: string; readonly scopeId: string; readonly status: SynthesisResult["status"]; readonly stopReason: SynthesisProof["stopReason"]; readonly program: TypedProgram | null; readonly examples: readonly Example[]; readonly counterexamples: readonly Counterexample[]; readonly solverResults: readonly SolverResult[]; readonly equality: EqualitySaturationResult | null; readonly events: SynthesisResult["events"] }): SynthesisResult {
  const base = { authority: "NEXUS_VERIFIED_SYNTHESIS_V1" as const, tenantId: input.tenantId, scopeId: input.scopeId, programDigest: digest(input.program), examplesDigest: digest(input.examples), counterexamplesDigest: digest(input.counterexamples), equalityDigest: input.equality?.digest ?? digest(null), solverDigests: input.solverResults.map((result) => result.resultDigest), outcome: input.status, stopReason: input.stopReason };
  const proof = Object.freeze({ ...base, proofDigest: digest(base) });
  return Object.freeze({ status: input.status, program: input.program, examples: Object.freeze([...input.examples]), counterexamples: Object.freeze([...input.counterexamples]), solverResults: Object.freeze([...input.solverResults]), equality: input.equality, proof, events: Object.freeze([...input.events]) });
}

export async function synthesizeVerified(input: { readonly tenantId: string; readonly scopeId: string; readonly candidates: readonly TypedProgram[]; readonly examples: readonly Example[]; readonly oracles?: readonly CounterexampleOracle[]; readonly solvers?: readonly { readonly adapter: SolverAdapter; readonly input: string }[]; readonly budget?: Partial<SynthesisBudget>; readonly signal?: AbortSignal }): Promise<SynthesisResult> {
  assertId("tenantId", input.tenantId); assertId("scopeId", input.scopeId);
  const limits = resolveBudget(input.budget);
  if (input.candidates.length === 0 || input.candidates.length > limits.maxCandidates) throw new Error("Candidate count is out of bounds");
  if (input.examples.length > limits.maxExamples) throw new Error("Example count is out of bounds");
  const examples = [...input.examples]; const counterexamples: Counterexample[] = []; const solverResults: SolverResult[] = []; const events: SynthesisResult["events"][number][] = [];
  const controller = new AbortController(); let timedOut = false;
  const timeout = setTimeout(() => { timedOut = true; controller.abort(); }, limits.timeoutMs);
  const abort = (): void => controller.abort(); input.signal?.addEventListener("abort", abort, { once: true });
  try {
    for (const candidate of input.candidates) {
      if (controller.signal.aborted) break;
      validateProgram(candidate, limits.maxExpressionNodes);
      if (candidate.tenantId !== input.tenantId || candidate.scopeId !== input.scopeId) throw new Error("Cross-tenant/scope candidate rejected");
      for (const example of examples) validateExample(example, candidate.outputType);
      events.push({ type: "CANDIDATE_TESTED", index: events.length });
      if (!examples.every((example) => evaluate(candidate, example.inputs, limits.maxExpressionNodes) === example.expected)) continue;
      let counterexampleFound = false;
      for (const oracle of input.oracles ?? []) {
        const found = await oracle.findCounterexample(candidate, controller.signal);
        if (controller.signal.aborted) break;
        if (!found) continue;
        if (found.source !== oracle.kind) throw new Error("Counterexample source does not match oracle kind");
        validateExample(found, candidate.outputType);
        if (!/^[a-f0-9]{64}$/.test(found.sourceDigest)) throw new Error("Counterexample source digest is invalid");
        if (examples.length >= limits.maxExamples) throw new Error("Counterexample would exceed example budget");
        counterexamples.push(found); examples.push({ inputs: found.inputs, expected: found.expected }); events.push({ type: "COUNTEREXAMPLE_ADDED", index: events.length }); counterexampleFound = true; break;
      }
      if (controller.signal.aborted) break;
      if (counterexampleFound) continue;
      const equality = equalitySaturate(candidate.expression, limits); const verifiedProgram = Object.freeze({ ...candidate, expression: equality.canonical });
      for (const solver of input.solvers ?? []) {
        if (controller.signal.aborted) break;
        events.push({ type: "SOLVER_INVOKED", index: events.length });
        solverResults.push(await solver.adapter.solve({ tenantId: input.tenantId, scopeId: input.scopeId, kind: solver.adapter.kind, input: solver.input, timeoutMs: Math.min(limits.timeoutMs, 60_000) }, controller.signal));
      }
      if (controller.signal.aborted) break;
      if (solverResults.some((result) => ["UNAVAILABLE", "ERROR", "TIMEOUT", "CANCELLED"].includes(result.status))) {
        events.push({ type: "BOUNDED_STOP", index: events.length });
        return finalize({ tenantId: input.tenantId, scopeId: input.scopeId, status: "UNAVAILABLE", stopReason: "SOLVER_UNAVAILABLE", program: verifiedProgram, examples, counterexamples, solverResults, equality, events });
      }
      events.push({ type: "VERIFIED", index: events.length });
      return finalize({ tenantId: input.tenantId, scopeId: input.scopeId, status: "VERIFIED", stopReason: "VERIFIED", program: verifiedProgram, examples, counterexamples, solverResults, equality, events });
    }
    events.push({ type: "BOUNDED_STOP", index: events.length });
    return finalize({ tenantId: input.tenantId, scopeId: input.scopeId, status: "NOT_VERIFIED", stopReason: timedOut ? "TIMEOUT" : controller.signal.aborted ? "CANCELLED" : "EXHAUSTED", program: null, examples, counterexamples, solverResults, equality: null, events });
  } finally { clearTimeout(timeout); input.signal?.removeEventListener("abort", abort); }
}

export function verifySynthesisProof(result: SynthesisResult): void {
  const { proof } = result;
  if (proof.authority !== "NEXUS_VERIFIED_SYNTHESIS_V1") throw new Error("Unsupported synthesis proof authority");
  if (proof.outcome !== result.status || proof.programDigest !== digest(result.program) || proof.examplesDigest !== digest(result.examples) || proof.counterexamplesDigest !== digest(result.counterexamples) || proof.equalityDigest !== (result.equality?.digest ?? digest(null)) || digest(result.solverResults.map((item) => item.resultDigest)) !== digest(proof.solverDigests)) throw new Error("Synthesis proof linkage mismatch");
  if (result.program && (proof.tenantId !== result.program.tenantId || proof.scopeId !== result.program.scopeId)) throw new Error("Synthesis proof scope mismatch");
  const { proofDigest, ...base } = proof; if (digest(base) !== proofDigest) throw new Error("Synthesis proof digest mismatch");
  if (result.program) validateProgram(result.program);
  result.events.forEach((event, index) => { if (event.index !== index) throw new Error("Synthesis event sequence mismatch"); });
}
