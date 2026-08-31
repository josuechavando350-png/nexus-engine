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
  readonly expectedStatus: "SAT" | "UNSAT";
  readonly programDigest: string;
  readonly input: string;
  readonly timeoutMs: number;
}

export interface SolverResult {
  readonly kind: SolverKind;
  readonly status: SolverStatus;
  readonly solver: string;
  readonly tenantId: string;
  readonly scopeId: string;
  readonly purpose: SolverPurpose;
  readonly expectedStatus: "SAT" | "UNSAT";
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
  readonly stopReason: "VERIFIED" | "EXHAUSTED" | "CANCELLED" | "TIMEOUT" | "SOLVER_UNAVAILABLE" | "SOLVER_INCONCLUSIVE" | "COUNTEREXAMPLE_LIMIT" | "EXTERNAL_CALL_LIMIT";
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
  maxExternalCalls: 64,
  timeoutMs: 5_000,
});

const HARD_LIMITS: SynthesisBudget = Object.freeze({
  maxCandidates: 10_000,
  maxIterations: 1_000,
  maxExpressionNodes: 2_048,
  maxEGraphNodes: 10_000,
  maxExamples: 10_000,
  maxCounterexamples: 1_000,
  maxExternalCalls: 512,
  timeoutMs: 60_000,
});

const MAX_DEPTH = 128;
const MAX_SOLVER_INPUT_BYTES = 256_000;
const MAX_SOLVER_OUTPUT_BYTES = 256_000;
const MAX_STDERR_BYTES = 32_000;
const MAX_EXECUTABLE_LENGTH = 1_024;
const MAX_ARGS = 32;
const MAX_ARG_LENGTH = 1_024;
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const DIGEST_RE = /^[a-f0-9]{64}$/u;

function stable(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stable(record[key])}`).join(",")}}`;
}

export function digest(value: unknown): string {
  return createHash("sha256").update(stable(value)).digest("hex");
}

function exactKeys(value: object, allowed: readonly string[], label: string): void {
  const keys = Object.keys(value);
  if (keys.length !== allowed.length || keys.some((key) => !allowed.includes(key))) throw new Error(`${label} contains unknown or missing fields`);
}

function assertId(label: string, value: unknown): asserts value is string {
  if (typeof value !== "string" || !ID_RE.test(value)) throw new Error(`${label} is invalid`);
}

function assertScalar(label: string, value: unknown): asserts value is Scalar {
  if (typeof value !== "number" && typeof value !== "boolean") throw new Error(`${label} must be numeric or boolean`);
  if (typeof value === "number" && !Number.isFinite(value)) throw new Error(`${label} must be finite`);
}

function exprType(expr: Expr, maxNodes: number, state = { nodes: 0 }, depth = 0): ValueType {
  if (!expr || typeof expr !== "object" || Array.isArray(expr)) throw new Error("Expression must be an object");
  state.nodes += 1;
  if (state.nodes > maxNodes) throw new Error("Expression node budget exceeded");
  if (depth > MAX_DEPTH) throw new Error("Expression depth budget exceeded");
  switch (expr.kind) {
    case "const":
      exactKeys(expr, ["kind", "value"], "const expression");
      assertScalar("constant", expr.value);
      return typeof expr.value === "number" ? "NUMBER" : "BOOLEAN";
    case "var":
      exactKeys(expr, ["kind", "name", "valueType"], "var expression");
      assertId("variable name", expr.name);
      if (expr.valueType !== "NUMBER" && expr.valueType !== "BOOLEAN") throw new Error("Variable valueType is invalid");
      return expr.valueType;
    case "add":
    case "sub":
    case "mul":
      exactKeys(expr, ["kind", "left", "right"], `${expr.kind} expression`);
      if (exprType(expr.left, maxNodes, state, depth + 1) !== "NUMBER" || exprType(expr.right, maxNodes, state, depth + 1) !== "NUMBER") throw new Error(`${expr.kind} requires NUMBER operands`);
      return "NUMBER";
    case "lt":
    case "le":
      exactKeys(expr, ["kind", "left", "right"], `${expr.kind} expression`);
      if (exprType(expr.left, maxNodes, state, depth + 1) !== "NUMBER" || exprType(expr.right, maxNodes, state, depth + 1) !== "NUMBER") throw new Error(`${expr.kind} requires NUMBER operands`);
      return "BOOLEAN";
    case "eq": {
      exactKeys(expr, ["kind", "left", "right"], "eq expression");
      const left = exprType(expr.left, maxNodes, state, depth + 1);
      const right = exprType(expr.right, maxNodes, state, depth + 1);
      if (left !== right) throw new Error("eq operands must have the same type");
      return "BOOLEAN";
    }
    case "and":
    case "or":
      exactKeys(expr, ["kind", "left", "right"], `${expr.kind} expression`);
      if (exprType(expr.left, maxNodes, state, depth + 1) !== "BOOLEAN" || exprType(expr.right, maxNodes, state, depth + 1) !== "BOOLEAN") throw new Error(`${expr.kind} requires BOOLEAN operands`);
      return "BOOLEAN";
    case "not":
      exactKeys(expr, ["kind", "value"], "not expression");
      if (exprType(expr.value, maxNodes, state, depth + 1) !== "BOOLEAN") throw new Error("not requires BOOLEAN operand");
      return "BOOLEAN";
    case "ite": {
      exactKeys(expr, ["kind", "condition", "whenTrue", "whenFalse"], "ite expression");
      if (exprType(expr.condition, maxNodes, state, depth + 1) !== "BOOLEAN") throw new Error("ite condition must be BOOLEAN");
      const whenTrue = exprType(expr.whenTrue, maxNodes, state, depth + 1);
      const whenFalse = exprType(expr.whenFalse, maxNodes, state, depth + 1);
      if (whenTrue !== whenFalse) throw new Error("ite branches must have the same type");
      return whenTrue;
    }
    default:
      throw new Error("Unsupported expression kind");
  }
}

export function validateProgram(program: TypedProgram, maxNodes = DEFAULT_BUDGET.maxExpressionNodes): void {
  if (!program || typeof program !== "object" || Array.isArray(program)) throw new Error("Program must be an object");
  exactKeys(program, ["version", "programId", "tenantId", "scopeId", "outputType", "expression"], "program");
  if (program.version !== 1) throw new Error("Unsupported program version");
  assertId("programId", program.programId);
  assertId("tenantId", program.tenantId);
  assertId("scopeId", program.scopeId);
  if (program.outputType !== "NUMBER" && program.outputType !== "BOOLEAN") throw new Error("Program output type is invalid");
  if (exprType(program.expression, maxNodes) !== program.outputType) throw new Error("Program output type mismatch");
}

function finiteNumber(value: number): number {
  if (!Number.isFinite(value)) throw new Error("Program produced non-finite numeric intermediate");
  return value;
}

export function evaluate(program: TypedProgram, inputs: Readonly<Record<string, Scalar>>, maxNodes = DEFAULT_BUDGET.maxExpressionNodes): Scalar {
  validateProgram(program, maxNodes);
  if (!inputs || typeof inputs !== "object" || Array.isArray(inputs)) throw new Error("Program inputs must be an object");
  let nodes = 0;
  const visit = (expr: Expr, depth = 0): Scalar => {
    nodes += 1;
    if (nodes > maxNodes) throw new Error("Evaluation node budget exceeded");
    if (depth > MAX_DEPTH) throw new Error("Evaluation depth budget exceeded");
    switch (expr.kind) {
      case "const": return expr.value;
      case "var": {
        if (!(expr.name in inputs)) throw new Error(`Missing input ${expr.name}`);
        const value = inputs[expr.name];
        assertScalar(`Input ${expr.name}`, value);
        if ((expr.valueType === "NUMBER") !== (typeof value === "number")) throw new Error(`Input type mismatch for ${expr.name}`);
        return value;
      }
      case "add": return finiteNumber((visit(expr.left, depth + 1) as number) + (visit(expr.right, depth + 1) as number));
      case "sub": return finiteNumber((visit(expr.left, depth + 1) as number) - (visit(expr.right, depth + 1) as number));
      case "mul": return finiteNumber((visit(expr.left, depth + 1) as number) * (visit(expr.right, depth + 1) as number));
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

function cost(expr: Expr): number {
  switch (expr.kind) {
    case "const":
    case "var": return 1;
    case "not": return 1 + cost(expr.value);
    case "ite": return 1 + cost(expr.condition) + cost(expr.whenTrue) + cost(expr.whenFalse);
    default: return 1 + cost(expr.left) + cost(expr.right);
  }
}

function foldBinary(expr: Extract<Expr, { left: Expr; right: Expr }>): Expr | null {
  if (expr.left.kind !== "const" || expr.right.kind !== "const") return null;
  const outputType: ValueType = ["add", "sub", "mul"].includes(expr.kind) ? "NUMBER" : "BOOLEAN";
  try {
    return { kind: "const", value: evaluate({ version: 1, programId: "fold", tenantId: "fold", scopeId: "fold", outputType, expression: expr }, {}) };
  } catch {
    return null;
  }
}

function localRewrites(expr: Expr): Expr[] {
  switch (expr.kind) {
    case "const":
    case "var": return [];
    case "not": {
      const variants: Expr[] = [];
      if (expr.value.kind === "const" && typeof expr.value.value === "boolean") variants.push({ kind: "const", value: !expr.value.value });
      if (expr.value.kind === "not") variants.push(expr.value.value);
      return variants;
    }
    case "ite": {
      const variants: Expr[] = [];
      if (expr.condition.kind === "const" && typeof expr.condition.value === "boolean") variants.push(expr.condition.value ? expr.whenTrue : expr.whenFalse);
      if (digest(expr.whenTrue) === digest(expr.whenFalse)) variants.push(expr.whenTrue);
      return variants;
    }
    default: {
      const variants: Expr[] = [];
      if (["add", "mul", "eq", "and", "or"].includes(expr.kind)) variants.push({ ...expr, left: expr.right, right: expr.left } as Expr);
      if (expr.kind === "add") {
        if (expr.left.kind === "const" && expr.left.value === 0) variants.push(expr.right);
        if (expr.right.kind === "const" && expr.right.value === 0) variants.push(expr.left);
      }
      if (expr.kind === "sub" && expr.right.kind === "const" && expr.right.value === 0) variants.push(expr.left);
      if (expr.kind === "mul") {
        if (expr.left.kind === "const" && expr.left.value === 0) variants.push(expr.left);
        if (expr.right.kind === "const" && expr.right.value === 0) variants.push(expr.right);
        if (expr.left.kind === "const" && expr.left.value === 1) variants.push(expr.right);
        if (expr.right.kind === "const" && expr.right.value === 1) variants.push(expr.left);
      }
      if ((expr.kind === "and" || expr.kind === "or") && digest(expr.left) === digest(expr.right)) variants.push(expr.left);
      if (expr.kind === "eq" && digest(expr.left) === digest(expr.right)) variants.push({ kind: "const", value: true });
      const folded = foldBinary(expr);
      if (folded) variants.push(folded);
      return variants;
    }
  }
}

function deepRewrites(expr: Expr): Expr[] {
  const variants = [...localRewrites(expr)];
  switch (expr.kind) {
    case "const":
    case "var": break;
    case "not":
      for (const value of localRewrites(expr.value)) variants.push({ kind: "not", value });
      break;
    case "ite":
      for (const condition of localRewrites(expr.condition)) variants.push({ ...expr, condition });
      for (const whenTrue of localRewrites(expr.whenTrue)) variants.push({ ...expr, whenTrue });
      for (const whenFalse of localRewrites(expr.whenFalse)) variants.push({ ...expr, whenFalse });
      break;
    default:
      for (const left of localRewrites(expr.left)) variants.push({ ...expr, left } as Expr);
      for (const right of localRewrites(expr.right)) variants.push({ ...expr, right } as Expr);
      break;
  }
  return variants;
}

export function equalitySaturate(
  expression: Expr,
  limits: Pick<SynthesisBudget, "maxIterations" | "maxExpressionNodes" | "maxEGraphNodes"> = DEFAULT_BUDGET,
): EqualitySaturationResult {
  exprType(expression, limits.maxExpressionNodes);
  const seen = new Map<string, Expr>([[digest(expression), expression]]);
  let frontier: Expr[] = [expression];
  let iterations = 0;
  let saturated = false;
  while (iterations < limits.maxIterations && frontier.length > 0 && seen.size < limits.maxEGraphNodes) {
    const next: Expr[] = [];
    for (const current of frontier) {
      for (const variant of deepRewrites(current)) {
        exprType(variant, limits.maxExpressionNodes);
        const key = digest(variant);
        if (seen.has(key)) continue;
        if (seen.size >= limits.maxEGraphNodes) break;
        seen.set(key, variant);
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
  const canonical = [...seen.values()].sort((a, b) => cost(a) - cost(b) || stable(a).localeCompare(stable(b)))[0] ?? expression;
  const status = saturated ? "SATURATED" : "BOUNDED";
  return Object.freeze({ canonical, explored: seen.size, iterations, status, digest: digest({ canonical, explored: seen.size, iterations, status }) });
}

function solverInput(programDigest: string, input: string): string {
  return `; NEXUS_PROGRAM_DIGEST ${programDigest}\n${input}`;
}

function validateSolverRequest(request: SolverRequest, expectedKind: SolverKind): void {
  if (!request || typeof request !== "object" || Array.isArray(request)) throw new Error("Solver request must be an object");
  exactKeys(request, ["tenantId", "scopeId", "kind", "purpose", "expectedStatus", "programDigest", "input", "timeoutMs"], "solver request");
  assertId("tenantId", request.tenantId);
  assertId("scopeId", request.scopeId);
  if (request.kind !== expectedKind) throw new Error("Solver request kind mismatch");
  if (!["CANDIDATE_CHECK", "INVARIANT_CHECK", "SYNTHESIS_CHECK"].includes(request.purpose)) throw new Error("Solver purpose is invalid");
  if (request.expectedStatus !== "SAT" && request.expectedStatus !== "UNSAT") throw new Error("Solver expected status is invalid");
  if (!DIGEST_RE.test(request.programDigest)) throw new Error("Solver program digest is invalid");
  if (typeof request.input !== "string" || !request.input || Buffer.byteLength(request.input) > MAX_SOLVER_INPUT_BYTES) throw new Error("Solver input is empty or too large");
  if (!Number.isInteger(request.timeoutMs) || request.timeoutMs < 10 || request.timeoutMs > HARD_LIMITS.timeoutMs) throw new Error("Invalid solver timeout");
}

function solverResult(kind: SolverKind, status: SolverStatus, executable: string, request: SolverRequest, stdout: Buffer): SolverResult {
  const queryDigest = digest(request.input);
  const requestDigest = digest({ tenantId: request.tenantId, scopeId: request.scopeId, kind, purpose: request.purpose, expectedStatus: request.expectedStatus, programDigest: request.programDigest, queryDigest });
  const base = {
    kind,
    status,
    solver: executable,
    tenantId: request.tenantId,
    scopeId: request.scopeId,
    purpose: request.purpose,
    expectedStatus: request.expectedStatus,
    programDigest: request.programDigest,
    queryDigest,
    requestDigest,
    outputDigest: digest(stdout.toString("utf8")),
  };
  return Object.freeze({ ...base, resultDigest: digest(base) });
}

export class ProcessSolverAdapter implements SolverAdapter {
  readonly #executable: string;
  readonly #args: readonly string[];

  public constructor(public readonly kind: SolverKind, executable: string, args: readonly string[] = []) {
    if (kind !== "SMT" && kind !== "SYGUS") throw new Error("Solver kind is invalid");
    if (typeof executable !== "string" || executable.length < 1 || executable.length > MAX_EXECUTABLE_LENGTH || executable.includes("\0")) throw new Error("Solver executable is invalid");
    if (!Array.isArray(args) || args.length > MAX_ARGS || args.some((arg) => typeof arg !== "string" || arg.length > MAX_ARG_LENGTH || arg.includes("\0"))) throw new Error("Solver arguments are invalid");
    this.#executable = executable;
    this.#args = Object.freeze([...args]);
  }

  public async solve(request: SolverRequest, signal?: AbortSignal): Promise<SolverResult> {
    validateSolverRequest(request, this.kind);
    if (signal?.aborted) return solverResult(this.kind, "CANCELLED", this.#executable, request, Buffer.alloc(0));
    return await new Promise<SolverResult>((resolve) => {
      let child: ChildProcessWithoutNullStreams | null = null;
      let stdout = Buffer.alloc(0);
      let stderrBytes = 0;
      let settled = false;
      const finish = (status: SolverStatus): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        resolve(solverResult(this.kind, status, this.#executable, request, stdout));
      };
      const kill = (): void => { if (child && !child.killed) child.kill("SIGKILL"); };
      const onAbort = (): void => { kill(); finish("CANCELLED"); };
      const timer = setTimeout(() => { kill(); finish("TIMEOUT"); }, request.timeoutMs);
      try {
        child = spawn(this.#executable, [...this.#args], { stdio: ["pipe", "pipe", "pipe"], shell: false, env: { PATH: process.env.PATH ?? "" } });
      } catch {
        finish("UNAVAILABLE");
        return;
      }
      signal?.addEventListener("abort", onAbort, { once: true });
      child.on("error", (error: NodeJS.ErrnoException) => finish(error.code === "ENOENT" ? "UNAVAILABLE" : "ERROR"));
      child.stdout.on("data", (chunk: Buffer) => {
        if (settled) return;
        if (stdout.length + chunk.length > MAX_SOLVER_OUTPUT_BYTES) {
          kill();
          finish("ERROR");
          return;
        }
        stdout = Buffer.concat([stdout, chunk]);
      });
      child.stderr.on("data", (chunk: Buffer) => {
        if (settled) return;
        stderrBytes += chunk.length;
        if (stderrBytes > MAX_STDERR_BYTES) {
          kill();
          finish("ERROR");
        }
      });
      child.on("close", (code) => {
        if (settled) return;
        if (code !== 0) {
          finish("ERROR");
          return;
        }
        const token = stdout.toString("utf8").trim().split(/\s+/u)[0]?.toLowerCase();
        finish(token === "sat" ? "SAT" : token === "unsat" ? "UNSAT" : "UNKNOWN");
      });
      child.stdin.on("error", () => undefined);
      child.stdin.end(request.input);
      if (signal?.aborted) onAbort();
    });
  }
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
  exactKeys(example, ["inputs", "expected"], "example");
  if (!example.inputs || typeof example.inputs !== "object" || Array.isArray(example.inputs)) throw new Error("Example inputs must be an object");
  assertScalar("Example expected", example.expected);
  if ((outputType === "NUMBER") !== (typeof example.expected === "number")) throw new Error("Example expected type mismatch");
  if (Object.keys(example.inputs).length > 64) throw new Error("Too many example inputs");
  for (const [name, value] of Object.entries(example.inputs)) {
    assertId("input name", name);
    assertScalar(`Input ${name}`, value);
  }
}

function validateCounterexample(counterexample: Counterexample, oracle: CounterexampleOracle, program: TypedProgram): void {
  if (!counterexample || typeof counterexample !== "object" || Array.isArray(counterexample)) throw new Error("Counterexample must be an object");
  exactKeys(counterexample, ["inputs", "expected", "source", "sourceDigest"], "counterexample");
  if (counterexample.source !== oracle.kind) throw new Error("Counterexample source does not match oracle kind");
  if (!DIGEST_RE.test(counterexample.sourceDigest)) throw new Error("Counterexample source digest is invalid");
  validateExample({ inputs: counterexample.inputs, expected: counterexample.expected }, program.outputType);
  if (evaluate(program, counterexample.inputs) === counterexample.expected) throw new Error("Oracle counterexample does not falsify candidate");
}

function validateSolverCheck(check: SolverCheck): void {
  if (!check || typeof check !== "object" || Array.isArray(check)) throw new Error("Solver check must be an object");
  const allowed = ["adapter", "input", "purpose", "expectedStatus"];
  for (const key of Object.keys(check)) if (!allowed.includes(key)) throw new Error(`Unknown solver check field ${key}`);
  if (!check.adapter || (check.adapter.kind !== "SMT" && check.adapter.kind !== "SYGUS") || typeof check.adapter.solve !== "function") throw new Error("Solver adapter is invalid");
  if (typeof check.input !== "string" || !check.input || Buffer.byteLength(check.input) > MAX_SOLVER_INPUT_BYTES) throw new Error("Solver check input is invalid");
  if (check.purpose !== undefined && !["CANDIDATE_CHECK", "INVARIANT_CHECK", "SYNTHESIS_CHECK"].includes(check.purpose)) throw new Error("Solver purpose is invalid");
  if (check.expectedStatus !== undefined && check.expectedStatus !== "SAT" && check.expectedStatus !== "UNSAT") throw new Error("Solver expected status is invalid");
}

class BoundedCallError extends Error {
  public constructor(public readonly reason: "TIMEOUT" | "CANCELLED") {
    super(reason === "TIMEOUT" ? "External synthesis call timed out" : "Synthesis was cancelled");
    this.name = "BoundedCallError";
  }
}

async function boundedCall<T>(operation: (signal: AbortSignal) => Promise<T>, timeoutMs: number, parent: AbortSignal): Promise<T> {
  if (parent.aborted) throw parent.reason instanceof BoundedCallError ? parent.reason : new BoundedCallError("CANCELLED");
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const onAbort = (): void => {
    const error = parent.reason instanceof BoundedCallError ? parent.reason : new BoundedCallError("CANCELLED");
    controller.abort(error);
  };
  const boundary = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      const error = new BoundedCallError("TIMEOUT");
      controller.abort(error);
      reject(error);
    }, timeoutMs);
    parent.addEventListener("abort", onAbort, { once: true });
    controller.signal.addEventListener("abort", () => reject(controller.signal.reason), { once: true });
  });
  try {
    return await Promise.race([Promise.resolve().then(() => operation(controller.signal)), boundary]);
  } finally {
    if (timer) clearTimeout(timer);
    parent.removeEventListener("abort", onAbort);
  }
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
  const base = {
    authority: "NEXUS_VERIFIED_SYNTHESIS_V1" as const,
    tenantId: input.tenantId,
    scopeId: input.scopeId,
    programDigest: digest(input.program),
    examplesDigest: digest(input.examples),
    counterexamplesDigest: digest(input.counterexamples),
    equalityDigest: input.equality?.digest ?? digest(null),
    solverDigests: input.solverResults.map((result) => result.resultDigest),
    eventDigest: digest(input.events),
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

function terminalFromBounded(error: unknown): "TIMEOUT" | "CANCELLED" | null {
  return error instanceof BoundedCallError ? error.reason : null;
}

function verifySolverResult(result: SolverResult, expected?: { tenantId: string; scopeId: string; kind: SolverKind; purpose: SolverPurpose; expectedStatus: "SAT" | "UNSAT"; programDigest: string; input: string }): void {
  if (!result || typeof result !== "object" || Array.isArray(result)) throw new Error("Solver result must be an object");
  exactKeys(result, ["kind", "status", "solver", "tenantId", "scopeId", "purpose", "expectedStatus", "programDigest", "queryDigest", "requestDigest", "outputDigest", "resultDigest"], "solver result");
  if (result.kind !== "SMT" && result.kind !== "SYGUS") throw new Error("Solver result kind is invalid");
  if (!["SAT", "UNSAT", "UNKNOWN", "UNAVAILABLE", "TIMEOUT", "CANCELLED", "ERROR"].includes(result.status)) throw new Error("Solver status is invalid");
  assertId("solver tenantId", result.tenantId);
  assertId("solver scopeId", result.scopeId);
  if (!["CANDIDATE_CHECK", "INVARIANT_CHECK", "SYNTHESIS_CHECK"].includes(result.purpose)) throw new Error("Solver purpose is invalid");
  if (result.expectedStatus !== "SAT" && result.expectedStatus !== "UNSAT") throw new Error("Solver expected status is invalid");
  if (typeof result.solver !== "string" || !result.solver || result.solver.length > MAX_EXECUTABLE_LENGTH) throw new Error("Solver identity is invalid");
  for (const value of [result.programDigest, result.queryDigest, result.requestDigest, result.outputDigest, result.resultDigest]) if (!DIGEST_RE.test(value)) throw new Error("Solver result digest is invalid");
  const { resultDigest, ...payload } = result;
  if (digest(payload) !== resultDigest) throw new Error("Solver result digest mismatch");
  if (expected) {
    const queryDigest = digest(expected.input);
    const requestDigest = digest({ tenantId: expected.tenantId, scopeId: expected.scopeId, kind: expected.kind, purpose: expected.purpose, expectedStatus: expected.expectedStatus, programDigest: expected.programDigest, queryDigest });
    if (result.tenantId !== expected.tenantId || result.scopeId !== expected.scopeId || result.kind !== expected.kind || result.purpose !== expected.purpose || result.expectedStatus !== expected.expectedStatus || result.programDigest !== expected.programDigest || result.queryDigest !== queryDigest || result.requestDigest !== requestDigest) throw new Error("Solver result candidate/query binding mismatch");
  }
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
  if (input.oracles && !Array.isArray(input.oracles)) throw new Error("Oracles must be an array");
  if (input.solvers && !Array.isArray(input.solvers)) throw new Error("Solvers must be an array");
  for (const oracle of input.oracles ?? []) if (!oracle || (oracle.kind !== "RUNTIME" && oracle.kind !== "BROWSER") || typeof oracle.findCounterexample !== "function") throw new Error("Counterexample oracle is invalid");
  for (const check of input.solvers ?? []) validateSolverCheck(check);

  const examples = [...input.examples];
  const counterexamples: Counterexample[] = [];
  const counterexampleKeys = new Set<string>();
  const solverResults: SolverResult[] = [];
  const events: SynthesisEvent[] = [];
  const controller = new AbortController();
  const deadline = Date.now() + limits.timeoutMs;
  let externalCalls = 0;
  const timer = setTimeout(() => controller.abort(new BoundedCallError("TIMEOUT")), limits.timeoutMs);
  const abort = (): void => controller.abort(input.signal?.reason instanceof BoundedCallError ? input.signal.reason : new BoundedCallError("CANCELLED"));
  input.signal?.addEventListener("abort", abort, { once: true });
  if (input.signal?.aborted) abort();

  try {
    for (const candidate of input.candidates) {
      if (controller.signal.aborted) break;
      validateProgram(candidate, limits.maxExpressionNodes);
      if (candidate.tenantId !== input.tenantId || candidate.scopeId !== input.scopeId) throw new Error("Cross-tenant/scope candidate rejected");
      for (const example of examples) validateExample(example, candidate.outputType);
      events.push({ type: "CANDIDATE_TESTED", index: events.length });
      if (!examples.every((example) => evaluate(candidate, example.inputs, limits.maxExpressionNodes) === example.expected)) continue;

      let rejected = false;
      for (const oracle of input.oracles ?? []) {
        if (externalCalls >= limits.maxExternalCalls) {
          events.push({ type: "BOUNDED_STOP", index: events.length });
          return finalize({ tenantId: input.tenantId, scopeId: input.scopeId, status: "NOT_VERIFIED", stopReason: "EXTERNAL_CALL_LIMIT", program: null, examples, counterexamples, solverResults, equality: null, events });
        }
        externalCalls += 1;
        let found: Counterexample | null;
        try {
          found = await boundedCall((signal) => oracle.findCounterexample(candidate, signal), Math.max(1, deadline - Date.now()), controller.signal);
        } catch (error) {
          const reason = terminalFromBounded(error);
          if (!reason) throw error;
          events.push({ type: "BOUNDED_STOP", index: events.length });
          return finalize({ tenantId: input.tenantId, scopeId: input.scopeId, status: "NOT_VERIFIED", stopReason: reason, program: null, examples, counterexamples, solverResults, equality: null, events });
        }
        if (!found) continue;
        validateCounterexample(found, oracle, candidate);
        const key = digest(found);
        if (counterexampleKeys.has(key) || counterexamples.length >= limits.maxCounterexamples || examples.length >= limits.maxExamples) {
          events.push({ type: "BOUNDED_STOP", index: events.length });
          return finalize({ tenantId: input.tenantId, scopeId: input.scopeId, status: "NOT_VERIFIED", stopReason: "COUNTEREXAMPLE_LIMIT", program: null, examples, counterexamples, solverResults, equality: null, events });
        }
        counterexampleKeys.add(key);
        const frozen = Object.freeze({ ...found, inputs: Object.freeze({ ...found.inputs }) });
        counterexamples.push(frozen);
        examples.push(Object.freeze({ inputs: Object.freeze({ ...found.inputs }), expected: found.expected }));
        events.push({ type: "COUNTEREXAMPLE_ADDED", index: events.length });
        rejected = true;
        break;
      }
      if (controller.signal.aborted) break;
      if (rejected) continue;

      const equality = equalitySaturate(candidate.expression, limits);
      const verifiedProgram = Object.freeze({ ...candidate, expression: equality.canonical });
      if (!examples.every((example) => evaluate(verifiedProgram, example.inputs, limits.maxExpressionNodes) === example.expected)) throw new Error("Equality saturation changed candidate semantics");
      const programDigest = digest(verifiedProgram);

      for (const check of input.solvers ?? []) {
        if (externalCalls >= limits.maxExternalCalls) {
          events.push({ type: "BOUNDED_STOP", index: events.length });
          return finalize({ tenantId: input.tenantId, scopeId: input.scopeId, status: "NOT_VERIFIED", stopReason: "EXTERNAL_CALL_LIMIT", program: verifiedProgram, examples, counterexamples, solverResults, equality, events });
        }
        externalCalls += 1;
        events.push({ type: "SOLVER_INVOKED", index: events.length });
        const purpose = check.purpose ?? "CANDIDATE_CHECK";
        const expectedStatus = check.expectedStatus ?? "SAT";
        const boundInput = solverInput(programDigest, check.input);
        let result: SolverResult;
        try {
          result = await boundedCall(
            (signal) => check.adapter.solve({ tenantId: input.tenantId, scopeId: input.scopeId, kind: check.adapter.kind, purpose, expectedStatus, programDigest, input: boundInput, timeoutMs: Math.max(10, Math.min(HARD_LIMITS.timeoutMs, deadline - Date.now())) }, signal),
            Math.max(1, deadline - Date.now()),
            controller.signal,
          );
        } catch (error) {
          const reason = terminalFromBounded(error);
          if (!reason) throw error;
          events.push({ type: "BOUNDED_STOP", index: events.length });
          return finalize({ tenantId: input.tenantId, scopeId: input.scopeId, status: "NOT_VERIFIED", stopReason: reason, program: verifiedProgram, examples, counterexamples, solverResults, equality, events });
        }
        verifySolverResult(result, { tenantId: input.tenantId, scopeId: input.scopeId, kind: check.adapter.kind, purpose, expectedStatus, programDigest, input: boundInput });
        solverResults.push(result);
        if (result.status === "UNAVAILABLE" || result.status === "ERROR") {
          events.push({ type: "BOUNDED_STOP", index: events.length });
          return finalize({ tenantId: input.tenantId, scopeId: input.scopeId, status: "UNAVAILABLE", stopReason: "SOLVER_UNAVAILABLE", program: verifiedProgram, examples, counterexamples, solverResults, equality, events });
        }
        if (result.status === "TIMEOUT" || result.status === "CANCELLED") {
          events.push({ type: "BOUNDED_STOP", index: events.length });
          return finalize({ tenantId: input.tenantId, scopeId: input.scopeId, status: "NOT_VERIFIED", stopReason: result.status === "TIMEOUT" ? "TIMEOUT" : "CANCELLED", program: verifiedProgram, examples, counterexamples, solverResults, equality, events });
        }
        if (result.status === "UNKNOWN" || result.status !== expectedStatus) {
          events.push({ type: "BOUNDED_STOP", index: events.length });
          return finalize({ tenantId: input.tenantId, scopeId: input.scopeId, status: "NOT_VERIFIED", stopReason: "SOLVER_INCONCLUSIVE", program: verifiedProgram, examples, counterexamples, solverResults, equality, events });
        }
      }

      events.push({ type: "VERIFIED", index: events.length });
      return finalize({ tenantId: input.tenantId, scopeId: input.scopeId, status: "VERIFIED", stopReason: "VERIFIED", program: verifiedProgram, examples, counterexamples, solverResults, equality, events });
    }

    events.push({ type: "BOUNDED_STOP", index: events.length });
    const reason = controller.signal.reason instanceof BoundedCallError ? controller.signal.reason.reason : "EXHAUSTED";
    return finalize({ tenantId: input.tenantId, scopeId: input.scopeId, status: "NOT_VERIFIED", stopReason: reason, program: null, examples, counterexamples, solverResults, equality: null, events });
  } finally {
    clearTimeout(timer);
    input.signal?.removeEventListener("abort", abort);
  }
}

export function verifySynthesisProof(result: SynthesisResult, expectedScope?: { readonly tenantId: string; readonly scopeId: string }): void {
  if (!result || typeof result !== "object" || Array.isArray(result)) throw new Error("Synthesis result must be an object");
  exactKeys(result, ["status", "program", "examples", "counterexamples", "solverResults", "equality", "proof", "events"], "synthesis result");
  if (!Array.isArray(result.examples) || !Array.isArray(result.counterexamples) || !Array.isArray(result.solverResults) || !Array.isArray(result.events)) throw new Error("Synthesis result collections are invalid");
  const proof = result.proof;
  if (!proof || typeof proof !== "object" || Array.isArray(proof)) throw new Error("Synthesis proof must be an object");
  exactKeys(proof, ["authority", "tenantId", "scopeId", "programDigest", "examplesDigest", "counterexamplesDigest", "equalityDigest", "solverDigests", "eventDigest", "outcome", "stopReason", "proofDigest"], "synthesis proof");
  if (proof.authority !== "NEXUS_VERIFIED_SYNTHESIS_V1") throw new Error("Unsupported synthesis proof authority");
  assertId("proof tenantId", proof.tenantId);
  assertId("proof scopeId", proof.scopeId);
  if (expectedScope && (proof.tenantId !== expectedScope.tenantId || proof.scopeId !== expectedScope.scopeId)) throw new Error("Synthesis proof expected scope mismatch");
  for (const solver of result.solverResults) verifySolverResult(solver);
  if (result.equality) {
    exprType(result.equality.canonical, HARD_LIMITS.maxExpressionNodes);
    const expectedEqualityDigest = digest({ canonical: result.equality.canonical, explored: result.equality.explored, iterations: result.equality.iterations, status: result.equality.status });
    if (expectedEqualityDigest !== result.equality.digest) throw new Error("Equality saturation digest mismatch");
    if (result.program && digest(result.program.expression) !== digest(result.equality.canonical)) throw new Error("Program/equality linkage mismatch");
  }
  if (proof.outcome !== result.status || proof.programDigest !== digest(result.program) || proof.examplesDigest !== digest(result.examples) || proof.counterexamplesDigest !== digest(result.counterexamples) || proof.equalityDigest !== (result.equality?.digest ?? digest(null)) || digest(result.solverResults.map((solver) => solver.resultDigest)) !== digest(proof.solverDigests) || proof.eventDigest !== digest(result.events)) throw new Error("Synthesis proof linkage mismatch");
  const { proofDigest, ...proofBase } = proof;
  if (digest(proofBase) !== proofDigest) throw new Error("Synthesis proof digest mismatch");
  result.events.forEach((event, index) => {
    if (!event || typeof event !== "object" || Array.isArray(event)) throw new Error("Synthesis event is invalid");
    exactKeys(event, ["type", "index"], "synthesis event");
    if (event.index !== index) throw new Error("Synthesis event sequence mismatch");
  });
  const seenCounterexamples = new Set<string>();
  for (const counterexample of result.counterexamples) {
    if (!counterexample || typeof counterexample !== "object" || Array.isArray(counterexample)) throw new Error("Counterexample evidence is invalid");
    exactKeys(counterexample, ["inputs", "expected", "source", "sourceDigest"], "counterexample evidence");
    if (!DIGEST_RE.test(counterexample.sourceDigest)) throw new Error("Counterexample source digest is invalid");
    const key = digest(counterexample);
    if (seenCounterexamples.has(key)) throw new Error("Counterexample replay detected");
    seenCounterexamples.add(key);
    if (!result.examples.some((example) => digest(example) === digest({ inputs: counterexample.inputs, expected: counterexample.expected }))) throw new Error("Counterexample is not bound into example evidence");
  }
  if (result.program) {
    validateProgram(result.program, HARD_LIMITS.maxExpressionNodes);
    if (proof.tenantId !== result.program.tenantId || proof.scopeId !== result.program.scopeId) throw new Error("Synthesis proof scope mismatch");
  }
  if (result.status === "VERIFIED") {
    if (!result.program || !result.equality || proof.stopReason !== "VERIFIED") throw new Error("VERIFIED synthesis is missing program/equality evidence");
    for (const example of result.examples) {
      validateExample(example, result.program.outputType);
      if (evaluate(result.program, example.inputs, HARD_LIMITS.maxExpressionNodes) !== example.expected) throw new Error("VERIFIED program does not satisfy recorded evidence");
    }
    if (!result.events.some((event) => event.type === "VERIFIED")) throw new Error("VERIFIED synthesis is missing terminal event");
    if (result.solverResults.some((solver) => solver.status !== solver.expectedStatus)) throw new Error("VERIFIED synthesis contains inconclusive solver evidence");
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
