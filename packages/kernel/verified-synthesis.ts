import { createHash } from "node:crypto";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

export type Scalar = number | boolean;
export type ValueType = "NUMBER" | "BOOLEAN";
export type SolverKind = "SMT" | "SYGUS";
export type SolverStatus = "SAT" | "UNSAT" | "UNKNOWN" | "UNAVAILABLE" | "TIMEOUT" | "CANCELLED" | "ERROR";
export type SolverPurpose = "CANDIDATE_CHECK" | "INVARIANT_CHECK" | "SYNTHESIS_CHECK";

export type Expr =
  | { readonly kind: "const"; readonly value: Scalar }
  | { readonly kind: "var"; readonly name: string; readonly valueType: ValueType }
  | { readonly kind: "add" | "sub" | "mul" | "eq" | "lt" | "le" | "and" | "or"; readonly left: Expr; readonly right: Expr }
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
  readonly maxEGraphNodes: number;
  readonly maxExamples: number;
  readonly maxCounterexamples: number;
  readonly maxExternalCalls: number;
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
  readonly purpose: SolverPurpose;
  readonly programDigest: string;
  readonly input: string;
  readonly timeoutMs: number;
}

export interface SolverResult {
  readonly kind: SolverKind;
  readonly status: SolverStatus;
  readonly solver: string;
  readonly purpose: SolverPurpose;
  readonly programDigest: string;
  readonly queryDigest: string;
  readonly requestDigest: string;
  readonly outputDigest: string;
  readonly resultDigest: string;
}

export interface SolverAdapter {
  readonly kind: SolverKind;
  solve(request: SolverRequest, signal?: AbortSignal): Promise<SolverResult>;
}

export interface SolverCheck {
  readonly adapter: SolverAdapter;
  readonly input: string;
  readonly purpose?: SolverPurpose;
  readonly expectedStatus?: "SAT" | "UNSAT";
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
  readonly eventDigest: string;
  readonly outcome: "VERIFIED" | "NOT_VERIFIED" | "UNAVAILABLE";
  readonly stopReason: "VERIFIED" | "EXHAUSTED" | "CANCELLED" | "TIMEOUT" | "SOLVER_UNAVAILABLE" | "SOLVER_INCONCLUSIVE" | "COUNTEREXAMPLE_LIMIT";
  readonly proofDigest: string;
}

export interface SynthesisEvent {
  readonly type: "CANDIDATE_TESTED" | "COUNTEREXAMPLE_ADDED" | "SOLVER_INVOKED" | "VERIFIED" | "BOUNDED_STOP";
  readonly index: number;
}

export interface SynthesisResult {
  readonly status: "VERIFIED" | "NOT_VERIFIED" | "UNAVAILABLE";
  readonly program: TypedProgram | null;
  readonly examples: readonly Example[];
  readonly counterexamples: readonly Counterexample[];
  readonly solverResults: readonly SolverResult[];
  readonly equality: EqualitySaturationResult | null;
  readonly proof: SynthesisProof;
  readonly events: readonly SynthesisEvent[];
}

const DEFAULT_BUDGET: SynthesisBudget = Object.freeze({
  maxCandidates: 128,
  maxIterations: 32,
  maxExpressionNodes: 256,
  maxEGraphNodes: 512,
  maxExamples: 128,
  maxCounterexamples: 64,
  maxExternalCalls: 16,
  timeoutMs: 5_000,
});

const HARD_LIMITS: SynthesisBudget = Object.freeze({
  maxCandidates: 10_000,
  maxIterations: 1_000,
  maxExpressionNodes: 2_048,
  maxEGraphNodes: 10_000,
  maxExamples: 10_000,
  maxCounterexamples: 1_000,
  maxExternalCalls: 128,
  timeoutMs: 60_000,
});

const MAX_SOLVER_INPUT_BYTES = 256_000;
const MAX_SOLVER_OUTPUT_BYTES = 256_000;
const MAX_SOLVER_STDERR_BYTES = 32_000;
const MAX_EXECUTABLE_LENGTH = 1_024;
const MAX_SOLVER_ARGS = 32;
const MAX_SOLVER_ARG_LENGTH = 1_024;
const MAX_EXPRESSION_DEPTH = 128;
const DIGEST_RE = /^[a-f0-9]{64}$/u;
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;

function stable(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stable(record[key])}`).join(",")}}`;
}

export function digest(value: unknown): string {
  return createHash("sha256").update(stable(value)).digest("hex");
}

function assertId(name: string, value: unknown): asserts value is string {
  if (typeof value !== "string" || !ID_RE.test(value)) throw new Error(`${name} is invalid`);
}

function assertExactKeys(value: object, allowed: readonly string[], name: string): void {
  const keys = Object.keys(value);
  if (keys.length !== allowed.length || keys.some((key) => !allowed.includes(key))) throw new Error(`${name} contains unknown or missing fields`);
}

function assertFiniteScalar(value: unknown, name: string): asserts value is Scalar {
  if (typeof value !== "number" && typeof value !== "boolean") throw new Error(`${name} must be a number or boolean`);
  if (typeof value === "number" && !Number.isFinite(value)) throw new Error(`${name} must be finite`);
}

function typeOfExpr(expr: Expr, seen: { count: number }, maxNodes: number, depth = 0): ValueType {
  if (!expr || typeof expr !== "object" || Array.isArray(expr)) throw new Error("Expression must be an object");
  seen.count += 1;
  if (seen.count > maxNodes) throw new Error("Expression node budget exceeded");
  if (depth > MAX_EXPRESSION_DEPTH) throw new Error("Expression depth budget exceeded");
  switch (expr.kind) {
    case "const":
      assertExactKeys(expr, ["kind", "value"], "const expression");
      assertFiniteScalar(expr.value, "constant");
      return typeof expr.value === "number" ? "NUMBER" : "BOOLEAN";
    case "var":
      assertExactKeys(expr, ["kind", "name", "valueType"], "var expression");
      assertId("variable name", expr.name);
      if (expr.valueType !== "NUMBER" && expr.valueType !== "BOOLEAN") throw new Error("Variable valueType is invalid");
      return expr.valueType;
    case "add":
    case "sub":
    case "mul":
      assertExactKeys(expr, ["kind", "left", "right"], `${expr.kind} expression`);
      if (typeOfExpr(expr.left, seen, maxNodes, depth + 1) !== "NUMBER" || typeOfExpr(expr.right, seen, maxNodes, depth + 1) !== "NUMBER") throw new Error(`${expr.kind} requires NUMBER operands`);
      return "NUMBER";
    case "lt":
    case "le":
      assertExactKeys(expr, ["kind", "left", "right"], `${expr.kind} expression`);
      if (typeOfExpr(expr.left, seen, maxNodes, depth + 1) !== "NUMBER" || typeOfExpr(expr.right, seen, maxNodes, depth + 1) !== "NUMBER") throw new Error(`${expr.kind} requires NUMBER operands`);
      return "BOOLEAN";
    case "eq": {
      assertExactKeys(expr, ["kind", "left", "right"], "eq expression");
      const left = typeOfExpr(expr.left, seen, maxNodes, depth + 1);
      const right = typeOfExpr(expr.right, seen, maxNodes, depth + 1);
      if (left !== right) throw new Error("eq operands must have the same type");
      return "BOOLEAN";
    }
    case "and":
    case "or":
      assertExactKeys(expr, ["kind", "left", "right"], `${expr.kind} expression`);
      if (typeOfExpr(expr.left, seen, maxNodes, depth + 1) !== "BOOLEAN" || typeOfExpr(expr.right, seen, maxNodes, depth + 1) !== "BOOLEAN") throw new Error(`${expr.kind} requires BOOLEAN operands`);
      return "BOOLEAN";
    case "not":
      assertExactKeys(expr, ["kind", "value"], "not expression");
      if (typeOfExpr(expr.value, seen, maxNodes, depth + 1) !== "BOOLEAN") throw new Error("not requires BOOLEAN operand");
      return "BOOLEAN";
    case "ite": {
      assertExactKeys(expr, ["kind", "condition", "whenTrue", "whenFalse"], "ite expression");
      if (typeOfExpr(expr.condition, seen, maxNodes, depth + 1) !== "BOOLEAN") throw new Error("ite condition must be BOOLEAN");
      const whenTrue = typeOfExpr(expr.whenTrue, seen, maxNodes, depth + 1);
      const whenFalse = typeOfExpr(expr.whenFalse, seen, maxNodes, depth + 1);
      if (whenTrue !== whenFalse) throw new Error("ite branches must have same type");
      return whenTrue;
    }
    default:
      throw new Error("Unsupported expression kind");
  }
}

export function validateProgram(program: TypedProgram, maxNodes = DEFAULT_BUDGET.maxExpressionNodes): void {
  if (!program || typeof program !== "object" || Array.isArray(program)) throw new Error("Program must be an object");
  assertExactKeys(program, ["version", "programId", "tenantId", "scopeId", "outputType", "expression"], "program");
  if (program.version !== 1) throw new Error("Unsupported program version");
  assertId("programId", program.programId);
  assertId("tenantId", program.tenantId);
  assertId("scopeId", program.scopeId);
  if (program.outputType !== "NUMBER" && program.outputType !== "BOOLEAN") throw new Error("Program output type is invalid");
  if (typeOfExpr(program.expression, { count: 0 }, maxNodes) !== program.outputType) throw new Error("Program output type mismatch");
}

function checkedNumber(value: number): number {
  if (!Number.isFinite(value)) throw new Error("Program produced non-finite numeric intermediate");
  return value;
}

export function evaluate(program: TypedProgram, inputs: Readonly<Record<string, Scalar>>, maxNodes = DEFAULT_BUDGET.maxExpressionNodes): Scalar {
  validateProgram(program, maxNodes);
  if (!inputs || typeof inputs !== "object" || Array.isArray(inputs)) throw new Error("Program inputs must be an object");
  let count = 0;
  const visit = (expr: Expr, depth = 0): Scalar => {
    count += 1;
    if (count > maxNodes) throw new Error("Evaluation node budget exceeded");
    if (depth > MAX_EXPRESSION_DEPTH) throw new Error("Evaluation depth budget exceeded");
    switch (expr.kind) {
      case "const": return expr.value;
      case "var": {
        if (!(expr.name in inputs)) throw new Error(`Missing input ${expr.name}`);
        const value = inputs[expr.name];
        if ((expr.valueType === "NUMBER") !== (typeof value === "number")) throw new Error(`Input type mismatch for ${expr.name}`);
        assertFiniteScalar(value, `Input ${expr.name}`);
        return value;
      }
      case "add": return checkedNumber((visit(expr.left, depth + 1) as number) + (visit(expr.right, depth + 1) as number));
      case "sub": return checkedNumber((visit(expr.left, depth + 1) as number) - (visit(expr.right, depth + 1) as number));
      case "mul": return checkedNumber((visit(expr.left, depth + 1) as number) * (visit(expr.right, depth + 1) as number));
      case "eq": return visit(expr.left, depth + 1) === visit(expr.right, depth + 1);
      case "lt": return (visit(expr.left, depth + 1) as number) < (visit(expr.right, depth + 1) as number);
      case "le": return (visit(expr.left, depth + 1) as number) <= (visit(expr.right, depth + 1) as number);
      case "and": return (visit(expr.left, depth + 1) as boolean) && (visit(expr.right, depth + 1) as boolean);
      case "or": return (visit(expr.left, depth + 1) as boolean) || (visit(expr.right, depth + 1) as boolean);
      case "not": return !(visit(expr.value, depth + 1) as boolean);
      case "ite": return (visit(expr.condition, depth + 1) as boolean) ? visit(expr.whenTrue, depth + 1) : visit(expr.whenFalse, depth + 1);
    }
  };
  return visit(program.expression);
}

function exprCost(expr: Expr): number {
  switch (expr.kind) {
    case "const":
    case "var": return 1;
    case "not": return 1 + exprCost(expr.value);
    case "ite": return 1 + exprCost(expr.condition) + exprCost(expr.whenTrue) + exprCost(expr.whenFalse);
    default: return 1 + exprCost(expr.left) + exprCost(expr.right);
  }
}

function constantFold(expr: Expr): Expr | null {
  if (!("left" in expr) || !("right" in expr) || expr.left.kind !== "const" || expr.right.kind !== "const") return null;
  const outputType: ValueType = ["add", "sub", "mul"].includes(expr.kind) ? "NUMBER" : "BOOLEAN";
  try {
    return { kind: "const", value: evaluate({ version: 1, programId: "fold", tenantId: "fold", scopeId: "fold", outputType, expression: expr }, {}) };
  } catch {
    return null;
  }
}

function immediateRewrites(expr: Expr): readonly Expr[] {
  const output: Expr[] = [];
  switch (expr.kind) {
    case "const":
    case "var": return output;
    case "not": {
      const value = normalizeOnce(expr.value);
      if (value.kind === "const" && typeof value.value === "boolean") output.push({ kind: "const", value: !value.value });
      if (value.kind === "not") output.push(value.value);
      output.push({ kind: "not", value });
      return output;
    }
    case "ite": {
      const condition = normalizeOnce(expr.condition);
      const whenTrue = normalizeOnce(expr.whenTrue);
      const whenFalse = normalizeOnce(expr.whenFalse);
      if (condition.kind === "const" && typeof condition.value === "boolean") output.push(condition.value ? whenTrue : whenFalse);
      if (digest(whenTrue) === digest(whenFalse)) output.push(whenTrue);
      output.push({ kind: "ite", condition, whenTrue, whenFalse });
      return output;
    }
    default: {
      const left = normalizeOnce(expr.left);
      const right = normalizeOnce(expr.right);
      const rebuilt = { ...expr, left, right } as Expr;
      output.push(rebuilt);
      if (["add", "mul", "eq", "and", "or"].includes(expr.kind)) output.push({ ...expr, left: right, right: left } as Expr);
      if (expr.kind === "add") {
        if (left.kind === "const" && left.value === 0) output.push(right);
        if (right.kind === "const" && right.value === 0) output.push(left);
      }
      if (expr.kind === "sub" && right.kind === "const" && right.value === 0) output.push(left);
      if (expr.kind === "mul") {
        if (left.kind === "const" && left.value === 0) output.push(left);
        if (right.kind === "const" && right.value === 0) output.push(right);
        if (left.kind === "const" && left.value === 1) output.push(right);
        if (right.kind === "const" && right.value === 1) output.push(left);
      }
      if ((expr.kind === "and" || expr.kind === "or" || expr.kind === "eq") && digest(left) === digest(right)) {
        output.push(expr.kind === "eq" ? { kind: "const", value: true } : left);
      }
      const folded = constantFold(rebuilt);
      if (folded) output.push(folded);
      return output;
    }
  }
}

function normalizeOnce(expr: Expr): Expr {
  const variants = immediateRewritesShallow(expr);
  return variants.sort((a, b) => exprCost(a) - exprCost(b) || stable(a).localeCompare(stable(b)))[0] ?? expr;
}

function immediateRewritesShallow(expr: Expr): Expr[] {
  switch (expr.kind) {
    case "const":
    case "var": return [expr];
    case "not": {
      const value = expr.value;
      if (value.kind === "const" && typeof value.value === "boolean") return [{ kind: "const", value: !value.value }, expr];
      if (value.kind === "not") return [value.value, expr];
      return [expr];
    }
    case "ite": {
      if (expr.condition.kind === "const" && typeof expr.condition.value === "boolean") return [expr.condition.value ? expr.whenTrue : expr.whenFalse, expr];
      if (digest(expr.whenTrue) === digest(expr.whenFalse)) return [expr.whenTrue, expr];
      return [expr];
    }
    default: {
      const output: Expr[] = [expr];
      if (expr.kind === "add") {
        if (expr.left.kind === "const" && expr.left.value === 0) output.push(expr.right);
        if (expr.right.kind === "const" && expr.right.value === 0) output.push(expr.left);
      }
      if (expr.kind === "sub" && expr.right.kind === "const" && expr.right.value === 0) output.push(expr.left);
      if (expr.kind === "mul") {
        if (expr.left.kind === "const" && expr.left.value === 0) output.push(expr.left);
        if (expr.right.kind === "const" && expr.right.value === 0) output.push(expr.right);
        if (expr.left.kind === "const" && expr.left.value === 1) output.push(expr.right);
        if (expr.right.kind === "const" && expr.right.value === 1) output.push(expr.left);
      }
      const folded = constantFold(expr);
      if (folded) output.push(folded);
      return output;
    }
  }
}

export function equalitySaturate(
  expression: Expr,
  limits: Pick<SynthesisBudget, "maxIterations" | "maxExpressionNodes" | "maxEGraphNodes"> = DEFAULT_BUDGET,
): EqualitySaturationResult {
  typeOfExpr(expression, { count: 0 }, limits.maxExpressionNodes);
  const seen = new Map<string, Expr>();
  const initialDigest = digest(expression);
  seen.set(initialDigest, expression);
  let frontier: Expr[] = [expression];
  let iterations = 0;
  let saturated = false;

  while (iterations < limits.maxIterations && frontier.length > 0 && seen.size < limits.maxEGraphNodes) {
    const next: Expr[] = [];
    for (const current of frontier) {
      for (const variant of immediateRewrites(current)) {
        typeOfExpr(variant, { count: 0 }, limits.maxExpressionNodes);
        const variantDigest = digest(variant);
        if (seen.has(variantDigest)) continue;
        if (seen.size >= limits.maxEGraphNodes) break;
        seen.set(variantDigest, variant);
        next.push(variant);
      }
      if (seen.size >= limits.maxEGraphNodes) break;
    }
    iterations += 1;
    if (next.length === 0) {
      saturated = true;
      break;
    }
    frontier = next;
  }

  const canonical = [...seen.values()].sort((a, b) => exprCost(a) - exprCost(b) || stable(a).localeCompare(stable(b)))[0] ?? expression;
  const status = saturated ? "SATURATED" : "BOUNDED";
  return Object.freeze({ canonical, explored: seen.size, iterations, status, digest: digest({ canonical, explored: seen.size, iterations, status }) });
}

function sanitizeExecutable(executable: string): string {
  if (typeof executable !== "string" || executable.length < 1 || executable.length > MAX_EXECUTABLE_LENGTH || executable.includes("\0")) throw new Error("Solver executable is invalid");
  return executable;
}

function validateArgs(args: readonly string[]): readonly string[] {
  if (!Array.isArray(args) || args.length > MAX_SOLVER_ARGS || args.some((arg) => typeof arg !== "string" || arg.length > MAX_SOLVER_ARG_LENGTH || arg.includes("\0"))) throw new Error("Solver arguments are invalid");
  return Object.freeze([...args]);
}

export class ProcessSolverAdapter implements SolverAdapter {
  readonly #executable: string;
  readonly #args: readonly string[];

  public constructor(public readonly kind: SolverKind, executable: string, args: readonly string[] = []) {
    if (kind !== "SMT" && kind !== "SYGUS") throw new Error("Solver kind is invalid");
    this.#executable = sanitizeExecutable(executable);
    this.#args = validateArgs(args);
  }

  public async solve(request: SolverRequest, signal?: AbortSignal): Promise<SolverResult> {
    validateSolverRequest(request, this.kind);
    const requestDigest = digest({
      tenantId: request.tenantId,
      scopeId: request.scopeId,
      kind: request.kind,
      purpose: request.purpose,
      programDigest: request.programDigest,
      queryDigest: digest(request.input),
    });
    if (signal?.aborted) return makeSolverResult(this.kind, "CANCELLED", this.#executable, request, requestDigest, "");

    return await new Promise<SolverResult>((resolve) => {
      let stdout = Buffer.alloc(0);
      let stderrBytes = 0;
      let settled = false;
      let child: ChildProcessWithoutNullStreams | null = null;
      let forcedStatus: SolverStatus | undefined;

      const finish = (status: SolverStatus): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        resolve(makeSolverResult(this.kind, status, this.#executable, request, requestDigest, stdout.toString("utf8")));
      };
      const kill = (): void => { if (child && !child.killed) child.kill("SIGKILL"); };
      const onAbort = (): void => { forcedStatus = "CANCELLED"; kill(); finish("CANCELLED"); };
      const timer = setTimeout(() => { forcedStatus = "TIMEOUT"; kill(); finish("TIMEOUT"); }, request.timeoutMs);

      try {
        child = spawn(this.#executable, [...this.#args], {
          stdio: ["pipe", "pipe", "pipe"],
          shell: false,
          env: { PATH: process.env.PATH ?? "" },
        });
      } catch {
        finish("UNAVAILABLE");
        return;
      }

      signal?.addEventListener("abort", onAbort, { once: true });
      child.on("error", (error: NodeJS.ErrnoException) => finish(error.code === "ENOENT" ? "UNAVAILABLE" : "ERROR"));
      child.stdout.on("data", (chunk: Buffer) => {
        if (settled) return;
        if (stdout.length + chunk.length > MAX_SOLVER_OUTPUT_BYTES) {
          forcedStatus = "ERROR";
          kill();
          finish("ERROR");
          return;
        }
        stdout = Buffer.concat([stdout, chunk]);
      });
      child.stderr.on("data", (chunk: Buffer) => {
        if (settled) return;
        stderrBytes += chunk.length;
        if (stderrBytes > MAX_SOLVER_STDERR_BYTES) {
          forcedStatus = "ERROR";
          kill();
          finish("ERROR");
        }
      });
      child.on("close", (code) => {
        if (settled) return;
        if (forcedStatus) {
          finish(forcedStatus);
          return;
        }
        if (code !== 0) {
          finish("ERROR");
          return;
        }
        const first = stdout.toString("utf8").trim().split(/\s+/u)[0]?.toLowerCase();
        finish(first === "sat" ? "SAT" : first === "unsat" ? "UNSAT" : "UNKNOWN");
      });
      child.stdin.on("error", () => undefined);
      child.stdin.end(request.input);
      if (signal?.aborted) onAbort();
    });
  }
}

function validateSolverRequest(request: SolverRequest, expectedKind: SolverKind): void {
  if (!request || typeof request !== "object" || Array.isArray(request)) throw new Error("Solver request must be an object");
  assertExactKeys(request, ["tenantId", "scopeId", "kind", "purpose", "programDigest", "input", "timeoutMs"], "solver request");
  assertId("tenantId", request.tenantId);
  assertId("scopeId", request.scopeId);
  if (request.kind !== expectedKind) throw new Error("Solver request kind mismatch");
  if (!["CANDIDATE_CHECK", "INVARIANT_CHECK", "SYNTHESIS_CHECK"].includes(request.purpose)) throw new Error("Solver purpose is invalid");
  if (!DIGEST_RE.test(request.programDigest)) throw new Error("Solver program digest is invalid");
  if (typeof request.input !== "string" || !request.input || Buffer.byteLength(request.input) > MAX_SOLVER_INPUT_BYTES) throw new Error("Solver input is empty or too large");
  if (!Number.isInteger(request.timeoutMs) || request.timeoutMs < 10 || request.timeoutMs > HARD_LIMITS.timeoutMs) throw new Error("Invalid solver timeout");
}

function makeSolverResult(kind: SolverKind, status: SolverStatus, solver: string, request: SolverRequest, requestDigest: string, stdout: string): SolverResult {
  const payload = {
    kind,
    status,
    solver,
    purpose: request.purpose,
    programDigest: request.programDigest,
    queryDigest: digest(request.input),
    requestDigest,
    outputDigest: digest(stdout),
  };
  return Object.freeze({ ...payload, resultDigest: digest(payload) });
}

export class SmtLibAdapter extends ProcessSolverAdapter {
  public constructor(executable = "z3") { super("SMT", executable, ["-in", "-smt2"]); }
}

export class SyGuSAdapter extends ProcessSolverAdapter {
  public constructor(executable = "cvc5") { super("SYGUS", executable, ["--lang=sygus2"]); }
}

function resolveBudget(input?: Partial<SynthesisBudget>): SynthesisBudget {
  if (input && (typeof input !== "object" || Array.isArray(input))) throw new Error("Synthesis budget must be an object");
  const allowed = Object.keys(DEFAULT_BUDGET);
  if (input) for (const key of Object.keys(input)) if (!allowed.includes(key)) throw new Error(`Unknown synthesis budget field ${key}`);
  const value = { ...DEFAULT_BUDGET, ...input };
  for (const [key, raw] of Object.entries(value)) {
    if (!Number.isInteger(raw) || raw <= 0) throw new Error(`Invalid budget ${key}`);
    if ((raw as number) > HARD_LIMITS[key as keyof SynthesisBudget]) throw new Error(`Synthesis budget ${key} exceeds hard limit`);
  }
  return Object.freeze(value);
}

function validateExample(example: Example, outputType: ValueType): void {
  if (!example || typeof example !== "object" || Array.isArray(example)) throw new Error("Example must be an object");
  assertExactKeys(example, ["inputs", "expected"], "example");
  if (!example.inputs || typeof example.inputs !== "object" || Array.isArray(example.inputs)) throw new Error("Example inputs must be an object");
  assertFiniteScalar(example.expected, "Example expected");
  if ((outputType === "NUMBER") !== (typeof example.expected === "number")) throw new Error("Example expected type mismatch");
  if (Object.keys(example.inputs).length > 64) throw new Error("Too many example inputs");
  for (const [name, value] of Object.entries(example.inputs)) {
    assertId("input name", name);
    assertFiniteScalar(value, `Input ${name}`);
  }
}

function counterexampleKey(counterexample: Counterexample): string {
  return digest({ inputs: counterexample.inputs, expected: counterexample.expected, source: counterexample.source, sourceDigest: counterexample.sourceDigest });
}

function validateCounterexample(counterexample: Counterexample, oracle: CounterexampleOracle, candidate: TypedProgram): void {
  if (!counterexample || typeof counterexample !== "object" || Array.isArray(counterexample)) throw new Error("Counterexample must be an object");
  assertExactKeys(counterexample, ["inputs", "expected", "source", "sourceDigest"], "counterexample");
  if (counterexample.source !== oracle.kind) throw new Error("Counterexample source does not match oracle kind");
  if (!DIGEST_RE.test(counterexample.sourceDigest)) throw new Error("Counterexample source digest is invalid");
  validateExample(counterexample, candidate.outputType);
  const actual = evaluate(candidate, counterexample.inputs);
  if (actual === counterexample.expected) throw new Error("Oracle counterexample does not falsify the candidate");
}

function validateSolverCheck(check: SolverCheck): void {
  if (!check || typeof check !== "object" || Array.isArray(check)) throw new Error("Solver check must be an object");
  const allowed = ["adapter", "input", "purpose", "expectedStatus"];
  for (const key of Object.keys(check)) if (!allowed.includes(key)) throw new Error(`Unknown solver check field ${key}`);
  if (!check.adapter || (check.adapter.kind !== "SMT" && check.adapter.kind !== "SYGUS") || typeof check.adapter.solve !== "function") throw new Error("Solver adapter is invalid");
  if (typeof check.input !== "string" || !check.input || Buffer.byteLength(check.input) > MAX_SOLVER_INPUT_BYTES) throw new Error("Solver check input is invalid");
  if (check.purpose !== undefined && !["CANDIDATE_CHECK", "INVARIANT_CHECK", "SYNTHESIS_CHECK"].includes(check.purpose)) throw new Error("Solver check purpose is invalid");
  if (check.expectedStatus !== undefined && check.expectedStatus !== "SAT" && check.expectedStatus !== "UNSAT") throw new Error("Solver expected status is invalid");
}

function finalize(input: {
  tenantId: string;
  scopeId: string;
  status: SynthesisResult["status"];
  stopReason: SynthesisProof["stopReason"];
  program: TypedProgram | null;
  examples: readonly Example[];
  counterexamples: readonly Counterexample[];
  solverResults: readonly SolverResult[];
  equality: EqualitySaturationResult | null;
  events: readonly SynthesisEvent[];
}): SynthesisResult {
  const eventDigest = digest(input.events);
  const base = {
    authority: "NEXUS_VERIFIED_SYNTHESIS_V1" as const,
    tenantId: input.tenantId,
    scopeId: input.scopeId,
    programDigest: digest(input.program),
    examplesDigest: digest(input.examples),
    counterexamplesDigest: digest(input.counterexamples),
    equalityDigest: input.equality?.digest ?? digest(null),
    solverDigests: input.solverResults.map((result) => result.resultDigest),
    eventDigest,
    outcome: input.status,
    stopReason: input.stopReason,
  };
  return Object.freeze({
    status: input.status,
    program: input.program,
    examples: Object.freeze([...input.examples]),
    counterexamples: Object.freeze([...input.counterexamples]),
    solverResults: Object.freeze([...input.solverResults]),
    equality: input.equality,
    proof: Object.freeze({ ...base, proofDigest: digest(base) }),
    events: Object.freeze([...input.events]),
  });
}

class BoundedCallError extends Error {
  public constructor(public readonly reason: "TIMEOUT" | "CANCELLED", message: string) {
    super(message);
    this.name = "BoundedCallError";
  }
}

async function callBounded<T>(operation: (signal: AbortSignal) => Promise<T>, timeoutMs: number, parentSignal: AbortSignal): Promise<T> {
  if (parentSignal.aborted) throw new BoundedCallError("CANCELLED", "synthesis operation cancelled");
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onParentAbort: (() => void) | undefined;
  const boundary = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      const error = new BoundedCallError("TIMEOUT", "synthesis external call timed out");
      controller.abort(error);
      reject(error);
    }, timeoutMs);
    onParentAbort = () => {
      const error = new BoundedCallError("CANCELLED", "synthesis operation cancelled");
      controller.abort(error);
      reject(error);
    };
    parentSignal.addEventListener("abort", onParentAbort, { once: true });
  });
  try {
    const execution = Promise.resolve().then(() => operation(controller.signal));
    return await Promise.race([execution, boundary]);
  } finally {
    if (timer) clearTimeout(timer);
    if (onParentAbort) parentSignal.removeEventListener("abort", onParentAbort);
  }
}

function remainingMs(deadline: number): number {
  return Math.max(1, deadline - Date.now());
}

function statusForBoundedError(error: unknown): { status: "NOT_VERIFIED"; reason: "TIMEOUT" | "CANCELLED" } | null {
  if (!(error instanceof BoundedCallError)) return null;
  return { status: "NOT_VERIFIED", reason: error.reason };
}

export async function synthesizeVerified(input: {
  tenantId: string;
  scopeId: string;
  candidates: readonly TypedProgram[];
  examples: readonly Example[];
  oracles?: readonly CounterexampleOracle[];
  solvers?: readonly SolverCheck[];
  budget?: Partial<SynthesisBudget>;
  signal?: AbortSignal;
}): Promise<SynthesisResult> {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Synthesis input must be an object");
  const allowed = ["tenantId", "scopeId", "candidates", "examples", "oracles", "solvers", "budget", "signal"];
  for (const key of Object.keys(input)) if (!allowed.includes(key)) throw new Error(`Unknown synthesis input field ${key}`);
  assertId("tenantId", input.tenantId);
  assertId("scopeId", input.scopeId);
  const limits = resolveBudget(input.budget);
  if (!Array.isArray(input.candidates) || input.candidates.length === 0 || input.candidates.length > limits.maxCandidates) throw new Error("Candidate count is out of bounds");
  if (!Array.isArray(input.examples) || input.examples.length > limits.maxExamples) throw new Error("Example count is out of bounds");
  if (input.oracles && (!Array.isArray(input.oracles) || input.oracles.length > limits.maxExternalCalls)) throw new Error("Oracle count is out of bounds");
  if (input.solvers && (!Array.isArray(input.solvers) || input.solvers.length > limits.maxExternalCalls)) throw new Error("Solver count is out of bounds");
  for (const oracle of input.oracles ?? []) if (!oracle || (oracle.kind !== "RUNTIME" && oracle.kind !== "BROWSER") || typeof oracle.findCounterexample !== "function") throw new Error("Counterexample oracle is invalid");
  for (const solver of input.solvers ?? []) validateSolverCheck(solver);

  const examples = [...input.examples];
  const counterexamples: Counterexample[] = [];
  const counterexampleDigests = new Set<string>();
  const solverResults: SolverResult[] = [];
  const events: SynthesisEvent[] = [];
  const controller = new AbortController();
  const deadline = Date.now() + limits.timeoutMs;
  let timedOut = false;
  const timeout = setTimeout(() => { timedOut = true; controller.abort(new BoundedCallError("TIMEOUT", "synthesis timed out")); }, limits.timeoutMs);
  const abort = (): void => controller.abort(input.signal?.reason ?? new BoundedCallError("CANCELLED", "synthesis cancelled"));
  input.signal?.addEventListener("abort", abort, { once: true });
  if (input.signal?.aborted) abort();

  try {
    for (const candidate of input.candidates) {
      if (controller.signal.aborted || Date.now() >= deadline) break;
      validateProgram(candidate, limits.maxExpressionNodes);
      if (candidate.tenantId !== input.tenantId || candidate.scopeId !== input.scopeId) throw new Error("Cross-tenant/scope candidate rejected");
      for (const example of examples) validateExample(example, candidate.outputType);
      events.push({ type: "CANDIDATE_TESTED", index: events.length });
      if (!examples.every((example) => evaluate(candidate, example.inputs, limits.maxExpressionNodes) === example.expected)) continue;

      let rejected = false;
      for (const oracle of input.oracles ?? []) {
        if (controller.signal.aborted) break;
        let found: Counterexample | null;
        try {
          found = await callBounded(
            (signal) => oracle.findCounterexample(candidate, signal),
            Math.min(remainingMs(deadline), limits.timeoutMs),
            controller.signal,
          );
        } catch (error) {
          const bounded = statusForBoundedError(error);
          if (bounded) {
            events.push({ type: "BOUNDED_STOP", index: events.length });
            return finalize({ tenantId: input.tenantId, scopeId: input.scopeId, status: bounded.status, stopReason: bounded.reason, program: null, examples, counterexamples, solverResults, equality: null, events });
          }
          throw error;
        }
        if (!found) continue;
        validateCounterexample(found, oracle, candidate);
        const evidenceKey = counterexampleKey(found);
        if (counterexampleDigests.has(evidenceKey)) {
          events.push({ type: "BOUNDED_STOP", index: events.length });
          return finalize({ tenantId: input.tenantId, scopeId: input.scopeId, status: "NOT_VERIFIED", stopReason: "COUNTEREXAMPLE_LIMIT", program: null, examples, counterexamples, solverResults, equality: null, events });
        }
        if (counterexamples.length >= limits.maxCounterexamples || examples.length >= limits.maxExamples) {
          events.push({ type: "BOUNDED_STOP", index: events.length });
          return finalize({ tenantId: input.tenantId, scopeId: input.scopeId, status: "NOT_VERIFIED", stopReason: "COUNTEREXAMPLE_LIMIT", program: null, examples, counterexamples, solverResults, equality: null, events });
        }
        counterexampleDigests.add(evidenceKey);
        counterexamples.push(Object.freeze({ ...found, inputs: Object.freeze({ ...found.inputs }) }));
        examples.push(Object.freeze({ inputs: Object.freeze({ ...found.inputs }), expected: found.expected }));
        events.push({ type: "COUNTEREXAMPLE_ADDED", index: events.length });
        rejected = true;
        break;
      }
      if (controller.signal.aborted) break;
      if (rejected) continue;

      const equality = equalitySaturate(candidate.expression, limits);
      const verifiedProgram = Object.freeze({ ...candidate, expression: equality.canonical });
      const candidateDigest = digest(verifiedProgram);
      if (!examples.every((example) => evaluate(verifiedProgram, example.inputs, limits.maxExpressionNodes) === example.expected)) throw new Error("Equality saturation changed candidate semantics");

      let solverStop: SynthesisProof["stopReason"] | undefined;
      for (const solver of input.solvers ?? []) {
        if (controller.signal.aborted) break;
        events.push({ type: "SOLVER_INVOKED", index: events.length });
        const purpose = solver.purpose ?? "CANDIDATE_CHECK";
        const expectedStatus = solver.expectedStatus ?? "SAT";
        let result: SolverResult;
        try {
          result = await callBounded(
            (signal) => solver.adapter.solve({
              tenantId: input.tenantId,
              scopeId: input.scopeId,
              kind: solver.adapter.kind,
              purpose,
              programDigest: candidateDigest,
              input: solver.input,
              timeoutMs: Math.min(remainingMs(deadline), HARD_LIMITS.timeoutMs),
            }, signal),
            Math.min(remainingMs(deadline), HARD_LIMITS.timeoutMs),
            controller.signal,
          );
        } catch (error) {
          const bounded = statusForBoundedError(error);
          if (bounded) {
            events.push({ type: "BOUNDED_STOP", index: events.length });
            return finalize({ tenantId: input.tenantId, scopeId: input.scopeId, status: "NOT_VERIFIED", stopReason: bounded.reason, program: verifiedProgram, examples, counterexamples, solverResults, equality, events });
          }
          throw error;
        }
        verifySolverResult(result, { tenantId: input.tenantId, scopeId: input.scopeId, programDigest: candidateDigest, kind: solver.adapter.kind, purpose, input: solver.input });
        solverResults.push(result);
        if (["UNAVAILABLE", "ERROR", "CANCELLED"].includes(result.status)) {
          solverStop = "SOLVER_UNAVAILABLE";
          break;
        }
        if (result.status === "TIMEOUT") {
          solverStop = "TIMEOUT";
          break;
        }
        if (result.status === "UNKNOWN" || result.status !== expectedStatus) {
          solverStop = "SOLVER_INCONCLUSIVE";
          break;
        }
      }
      if (controller.signal.aborted) break;
      if (solverStop) {
        events.push({ type: "BOUNDED_STOP", index: events.length });
        return finalize({
          tenantId: input.tenantId,
          scopeId: input.scopeId,
          status: solverStop === "SOLVER_UNAVAILABLE" ? "UNAVAILABLE" : "NOT_VERIFIED",
          stopReason: solverStop,
          program: verifiedProgram,
          examples,
          counterexamples,
          solverResults,
          equality,
          events,
        });
      }

      events.push({ type: "VERIFIED", index: events.length });
      return finalize({ tenantId: input.tenantId, scopeId: input.scopeId, status: "VERIFIED", stopReason: "VERIFIED", program: verifiedProgram, examples, counterexamples, solverResults, equality, events });
    }

    events.push({ type: "BOUNDED_STOP", index: events.length });
    return finalize({
      tenantId: input.tenantId,
      scopeId: input.scopeId,
      status: "NOT_VERIFIED",
      stopReason: timedOut ? "TIMEOUT" : controller.signal.aborted ? "CANCELLED" : "EXHAUSTED",
      program: null,
      examples,
      counterexamples,
      solverResults,
      equality: null,
      events,
    });
  } finally {
    clearTimeout(timeout);
    input.signal?.removeEventListener("abort", abort);
  }
}

function verifySolverResult(result: SolverResult, expected?: { tenantId: string; scopeId: string; programDigest: string; kind: SolverKind; purpose: SolverPurpose; input: string }): void {
  if (!result || typeof result !== "object" || Array.isArray(result)) throw new Error("Solver result must be an object");
  assertExactKeys(result, ["kind", "status", "solver", "purpose", "programDigest", "queryDigest", "requestDigest", "outputDigest", "resultDigest"], "solver result");
  if (result.kind !== "SMT" && result.kind !== "SYGUS") throw new Error("Solver result kind is invalid");
  if (!["SAT", "UNSAT", "UNKNOWN", "UNAVAILABLE", "TIMEOUT", "CANCELLED", "ERROR"].includes(result.status)) throw new Error("Solver result status is invalid");
  if (!["CANDIDATE_CHECK", "INVARIANT_CHECK", "SYNTHESIS_CHECK"].includes(result.purpose)) throw new Error("Solver result purpose is invalid");
  if (typeof result.solver !== "string" || !result.solver || result.solver.length > MAX_EXECUTABLE_LENGTH) throw new Error("Solver result implementation is invalid");
  for (const value of [result.programDigest, result.queryDigest, result.requestDigest, result.outputDigest, result.resultDigest]) if (!DIGEST_RE.test(value)) throw new Error("Solver result digest is invalid");
  const { resultDigest, ...payload } = result;
  if (digest(payload) !== resultDigest) throw new Error("Solver result digest mismatch");
  if (expected) {
    if (result.kind !== expected.kind || result.purpose !== expected.purpose || result.programDigest !== expected.programDigest || result.queryDigest !== digest(expected.input)) throw new Error("Solver result candidate/query binding mismatch");
    const expectedRequestDigest = digest({ tenantId: expected.tenantId, scopeId: expected.scopeId, kind: expected.kind, purpose: expected.purpose, programDigest: expected.programDigest, queryDigest: digest(expected.input) });
    if (result.requestDigest !== expectedRequestDigest) throw new Error("Solver request digest mismatch");
  }
}

export function verifySynthesisProof(result: SynthesisResult, expectedScope?: { readonly tenantId: string; readonly scopeId: string }): void {
  if (!result || typeof result !== "object" || Array.isArray(result)) throw new Error("Synthesis result must be an object");
  assertExactKeys(result, ["status", "program", "examples", "counterexamples", "solverResults", "equality", "proof", "events"], "synthesis result");
  if (!Array.isArray(result.examples) || !Array.isArray(result.counterexamples) || !Array.isArray(result.solverResults) || !Array.isArray(result.events)) throw new Error("Synthesis result collections are invalid");
  const { proof } = result;
  if (!proof || typeof proof !== "object" || Array.isArray(proof)) throw new Error("Synthesis proof must be an object");
  assertExactKeys(proof, ["authority", "tenantId", "scopeId", "programDigest", "examplesDigest", "counterexamplesDigest", "equalityDigest", "solverDigests", "eventDigest", "outcome", "stopReason", "proofDigest"], "synthesis proof");
  if (proof.authority !== "NEXUS_VERIFIED_SYNTHESIS_V1") throw new Error("Unsupported synthesis proof authority");
  assertId("proof tenantId", proof.tenantId);
  assertId("proof scopeId", proof.scopeId);
  if (expectedScope && (proof.tenantId !== expectedScope.tenantId || proof.scopeId !== expectedScope.scopeId)) throw new Error("Synthesis proof expected scope mismatch");
  for (const solver of result.solverResults) verifySolverResult(solver);
  if (result.equality) {
    const expectedEqualityDigest = digest({ canonical: result.equality.canonical, explored: result.equality.explored, iterations: result.equality.iterations, status: result.equality.status });
    if (expectedEqualityDigest !== result.equality.digest) throw new Error("Equality saturation digest mismatch");
    typeOfExpr(result.equality.canonical, { count: 0 }, HARD_LIMITS.maxExpressionNodes);
    if (result.program && digest(result.program.expression) !== digest(result.equality.canonical)) throw new Error("Program/equality linkage mismatch");
  }
  if (proof.outcome !== result.status || proof.programDigest !== digest(result.program) || proof.examplesDigest !== digest(result.examples) || proof.counterexamplesDigest !== digest(result.counterexamples) || proof.equalityDigest !== (result.equality?.digest ?? digest(null)) || digest(result.solverResults.map((solver) => solver.resultDigest)) !== digest(proof.solverDigests) || proof.eventDigest !== digest(result.events)) throw new Error("Synthesis proof linkage mismatch");
  if (result.program) {
    validateProgram(result.program, HARD_LIMITS.maxExpressionNodes);
    if (proof.tenantId !== result.program.tenantId || proof.scopeId !== result.program.scopeId) throw new Error("Synthesis proof scope mismatch");
  }
  const { proofDigest, ...base } = proof;
  if (digest(base) !== proofDigest) throw new Error("Synthesis proof digest mismatch");
  result.events.forEach((event, index) => {
    if (!event || typeof event !== "object" || Array.isArray(event)) throw new Error("Synthesis event is invalid");
    assertExactKeys(event, ["type", "index"], "synthesis event");
    if (event.index !== index) throw new Error("Synthesis event sequence mismatch");
  });
  for (const counterexample of result.counterexamples) {
    if (!counterexample || typeof counterexample !== "object" || Array.isArray(counterexample)) throw new Error("Counterexample evidence is invalid");
    assertExactKeys(counterexample, ["inputs", "expected", "source", "sourceDigest"], "counterexample evidence");
    if (!DIGEST_RE.test(counterexample.sourceDigest)) throw new Error("Counterexample source digest is invalid");
  }
  if (result.status === "VERIFIED") {
    if (!result.program || !result.equality || proof.stopReason !== "VERIFIED") throw new Error("VERIFIED synthesis is missing required program/equality evidence");
    for (const example of result.examples) {
      validateExample(example, result.program.outputType);
      if (evaluate(result.program, example.inputs, HARD_LIMITS.maxExpressionNodes) !== example.expected) throw new Error("VERIFIED program does not satisfy recorded example evidence");
    }
    if (!result.events.some((event) => event.type === "VERIFIED")) throw new Error("VERIFIED synthesis is missing terminal event evidence");
    if (result.solverResults.some((solver) => ["UNKNOWN", "UNAVAILABLE", "TIMEOUT", "CANCELLED", "ERROR"].includes(solver.status))) throw new Error("VERIFIED synthesis contains inconclusive solver evidence");
  } else if (proof.stopReason === "VERIFIED") {
    throw new Error("Non-verified synthesis cannot carry VERIFIED stop reason");
  }
}

export class GovernedSynthesisRuntime {
  public constructor(private readonly tenantId: string, private readonly scopeId: string) {
    assertId("tenantId", tenantId);
    assertId("scopeId", scopeId);
  }

  public async execute(input: Omit<Parameters<typeof synthesizeVerified>[0], "tenantId" | "scopeId">): Promise<SynthesisResult> {
    return await synthesizeVerified({ ...input, tenantId: this.tenantId, scopeId: this.scopeId });
  }

  public verify(result: SynthesisResult): void {
    verifySynthesisProof(result, { tenantId: this.tenantId, scopeId: this.scopeId });
  }
}
