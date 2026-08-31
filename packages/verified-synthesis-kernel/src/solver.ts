import { spawn } from "node:child_process";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { evaluateConstraint, normalizeConstraints, sha256 } from "./egraph.js";
import type { CandidateAssignment, IrConstraint, IrExpression, SolverKind, SolverResult, SynthesisProblem, SynthesisSolver } from "./types.js";

const MAX_TOOL_OUTPUT_BYTES = 1_048_576;
const MAX_QUERY_BYTES = 1_048_576;

function duration(start: number): number { return Math.max(0, Date.now() - start); }

export class InternalBoundedSolver implements SynthesisSolver {
  readonly kind = "INTERNAL_BOUNDED" as const;

  async solve(problem: SynthesisProblem, constraintsInput: readonly IrConstraint[], signal: AbortSignal): Promise<SolverResult> {
    const start = Date.now();
    const constraints = normalizeConstraints(problem, constraintsInput);
    const queryDigest = sha256({ problem: problem.problemId, variables: problem.variables, constraints });
    const values = problem.variables.map((variable) => variable.min);
    let visited = 0;
    const deadline = start + problem.budgets.solverTimeoutMs;
    const candidate = (): CandidateAssignment => Object.freeze(Object.fromEntries(problem.variables.map((variable, index) => [variable.name, values[index]])));
    const increment = (): boolean => {
      for (let index = values.length - 1; index >= 0; index -= 1) {
        const variable = problem.variables[index];
        if (!variable) continue;
        if ((values[index] ?? variable.min) < variable.max) {
          values[index] = (values[index] ?? variable.min) + 1;
          for (let reset = index + 1; reset < values.length; reset += 1) values[reset] = problem.variables[reset]?.min ?? 0;
          return true;
        }
      }
      return false;
    };
    while (true) {
      if (signal.aborted) return this.result("ERROR", queryDigest, start);
      if (Date.now() > deadline) return this.result("TIMEOUT", queryDigest, start);
      if (visited >= problem.budgets.maxCandidates) return this.result("UNKNOWN", queryDigest, start);
      const assignment = candidate();
      visited += 1;
      if (constraints.every((constraint) => evaluateConstraint(constraint, assignment).pass)) {
        return Object.freeze({
          status: "SAT",
          candidate: assignment,
          evidence: Object.freeze({ solverKind: this.kind, implementation: "nexus-internal-bounded-enumerator-v1", status: "SAT", queryDigest, outputDigest: sha256(assignment), durationMs: duration(start) }),
        });
      }
      if (!increment()) return this.result("UNSAT", queryDigest, start);
      if (visited % 2048 === 0) await Promise.resolve();
    }
  }

  private result(status: "UNSAT" | "UNKNOWN" | "TIMEOUT" | "ERROR", queryDigest: string, start: number): SolverResult {
    return Object.freeze({ status, evidence: Object.freeze({ solverKind: this.kind, implementation: "nexus-internal-bounded-enumerator-v1", status, queryDigest, durationMs: duration(start) }) });
  }
}

export interface ExternalSolverOptions {
  readonly executable: string;
  readonly kind: "SMT" | "SYGUS";
  readonly args?: readonly string[];
}

export class ExternalSmtLibSolver implements SynthesisSolver {
  readonly kind: SolverKind;
  constructor(private readonly options: ExternalSolverOptions) {
    if (!options || typeof options.executable !== "string" || options.executable.length < 1 || options.executable.length > 1024) throw new Error("solver executable is invalid");
    if (options.kind !== "SMT" && options.kind !== "SYGUS") throw new Error("solver kind must be SMT or SYGUS");
    if (options.args && (!Array.isArray(options.args) || options.args.length > 32 || options.args.some((arg) => typeof arg !== "string" || arg.length > 1024))) throw new Error("solver args are invalid");
    this.kind = options.kind;
  }

  async solve(problem: SynthesisProblem, constraintsInput: readonly IrConstraint[], signal: AbortSignal): Promise<SolverResult> {
    const start = Date.now();
    const constraints = normalizeConstraints(problem, constraintsInput);
    const query = this.kind === "SMT" ? toSmt2(problem, constraints) : toSygus2(problem, constraints);
    if (Buffer.byteLength(query) > MAX_QUERY_BYTES) throw new Error("solver query exceeds byte budget");
    const queryDigest = sha256(query);
    if (signal.aborted) return this.simple("ERROR", queryDigest, start);
    try {
      const output = await runTool(this.options.executable, this.options.args ?? [], query, problem.budgets.solverTimeoutMs, signal);
      const outputDigest = sha256(output.stdout);
      const text = output.stdout.trim();
      if (output.timedOut) return this.simple("TIMEOUT", queryDigest, start, outputDigest);
      if (output.cancelled) return this.simple("ERROR", queryDigest, start, outputDigest);
      if (output.spawnUnavailable) return this.simple("UNAVAILABLE", queryDigest, start, outputDigest);
      if (output.exitCode !== 0) return this.simple("ERROR", queryDigest, start, outputDigest);
      if (/^unsat\b/m.test(text) || /^fail\b/m.test(text)) return this.simple("UNSAT", queryDigest, start, outputDigest);
      if (/^unknown\b/m.test(text)) return this.simple("UNKNOWN", queryDigest, start, outputDigest);
      const candidate = this.kind === "SMT" ? parseSmtModel(problem, text) : parseSygusModel(problem, text);
      if (!candidate) return this.simple("ERROR", queryDigest, start, outputDigest);
      if (!constraints.every((constraint) => evaluateConstraint(constraint, candidate).pass)) return this.simple("ERROR", queryDigest, start, outputDigest);
      return Object.freeze({
        status: "SAT",
        candidate,
        evidence: Object.freeze({ solverKind: this.kind, implementation: this.options.executable, status: "SAT", queryDigest, outputDigest, durationMs: duration(start) }),
      });
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return this.simple("UNAVAILABLE", queryDigest, start);
      return this.simple(signal.aborted ? "ERROR" : "ERROR", queryDigest, start);
    }
  }

  private simple(status: "UNSAT" | "UNKNOWN" | "TIMEOUT" | "UNAVAILABLE" | "ERROR", queryDigest: string, start: number, outputDigest?: string): SolverResult {
    return Object.freeze({ status, evidence: Object.freeze({ solverKind: this.kind, implementation: this.options.executable, status, queryDigest, ...(outputDigest ? { outputDigest } : {}), durationMs: duration(start) }) });
  }
}

function symbol(name: string): string { return `|${name.replaceAll("|", "")}|`; }

function smtExpression(expression: IrExpression, sygus = false): string {
  switch (expression.kind) {
    case "const": return expression.value.toString(10);
    case "var": return sygus ? `(${symbol(expression.name)})` : symbol(expression.name);
    case "add": return `(+ ${smtExpression(expression.left, sygus)} ${smtExpression(expression.right, sygus)})`;
    case "sub": return `(- ${smtExpression(expression.left, sygus)} ${smtExpression(expression.right, sygus)})`;
    case "mul": return `(* ${smtExpression(expression.left, sygus)} ${smtExpression(expression.right, sygus)})`;
    case "min": return `(ite (<= ${smtExpression(expression.left, sygus)} ${smtExpression(expression.right, sygus)}) ${smtExpression(expression.left, sygus)} ${smtExpression(expression.right, sygus)})`;
    case "max": return `(ite (>= ${smtExpression(expression.left, sygus)} ${smtExpression(expression.right, sygus)}) ${smtExpression(expression.left, sygus)} ${smtExpression(expression.right, sygus)})`;
  }
}

function relation(constraint: IrConstraint, sygus = false): string {
  const op = constraint.relation === "EQ" ? "=" : constraint.relation === "LE" ? "<=" : ">=";
  return `(${op} ${smtExpression(constraint.left, sygus)} ${smtExpression(constraint.right, sygus)})`;
}

function toSmt2(problem: SynthesisProblem, constraints: readonly IrConstraint[]): string {
  const lines = ["(set-logic QF_NIA)"];
  for (const variable of problem.variables) {
    lines.push(`(declare-const ${symbol(variable.name)} Int)`);
    lines.push(`(assert (>= ${symbol(variable.name)} ${variable.min}))`);
    lines.push(`(assert (<= ${symbol(variable.name)} ${variable.max}))`);
  }
  for (const constraint of constraints) lines.push(`(assert ${relation(constraint)})`);
  lines.push("(check-sat)");
  lines.push(`(get-value (${problem.variables.map((variable) => symbol(variable.name)).join(" ")}))`);
  return `${lines.join("\n")}\n`;
}

function toSygus2(problem: SynthesisProblem, constraints: readonly IrConstraint[]): string {
  const lines = ["(set-logic NIA)"];
  for (const variable of problem.variables) lines.push(`(synth-fun ${symbol(variable.name)} () Int)`);
  for (const variable of problem.variables) {
    lines.push(`(constraint (>= (${symbol(variable.name)}) ${variable.min}))`);
    lines.push(`(constraint (<= (${symbol(variable.name)}) ${variable.max}))`);
  }
  for (const constraint of constraints) lines.push(`(constraint ${relation(constraint, true)})`);
  lines.push("(check-synth)");
  return `${lines.join("\n")}\n`;
}

function unquoteSymbol(value: string): string { return value.startsWith("|") && value.endsWith("|") ? value.slice(1, -1) : value; }

function parseSmtModel(problem: SynthesisProblem, output: string): CandidateAssignment | undefined {
  if (!/^sat\b/m.test(output)) return undefined;
  const candidate: Record<string, number> = {};
  const matcher = /\(\s*(\|[^|]+\||[A-Za-z][A-Za-z0-9_.:-]*)\s+(-?\d+)\s*\)/g;
  for (const match of output.matchAll(matcher)) {
    const name = unquoteSymbol(match[1] ?? "");
    if (!problem.variables.some((variable) => variable.name === name)) continue;
    const value = Number(match[2]);
    if (!Number.isSafeInteger(value)) return undefined;
    candidate[name] = value;
  }
  return finalizeCandidate(problem, candidate);
}

function parseSygusModel(problem: SynthesisProblem, output: string): CandidateAssignment | undefined {
  const candidate: Record<string, number> = {};
  const matcher = /\(define-fun\s+(\|[^|]+\||[A-Za-z][A-Za-z0-9_.:-]*)\s*\(\s*\)\s+Int\s+(-?\d+)\s*\)/g;
  for (const match of output.matchAll(matcher)) {
    const name = unquoteSymbol(match[1] ?? "");
    if (!problem.variables.some((variable) => variable.name === name)) continue;
    const value = Number(match[2]);
    if (!Number.isSafeInteger(value)) return undefined;
    candidate[name] = value;
  }
  return finalizeCandidate(problem, candidate);
}

function finalizeCandidate(problem: SynthesisProblem, candidate: Record<string, number>): CandidateAssignment | undefined {
  for (const variable of problem.variables) {
    const value = candidate[variable.name];
    if (!Number.isSafeInteger(value) || value < variable.min || value > variable.max) return undefined;
  }
  return Object.freeze(Object.fromEntries(problem.variables.map((variable) => [variable.name, candidate[variable.name] as number])));
}

interface ToolResult { readonly stdout: string; readonly exitCode: number | null; readonly timedOut: boolean; readonly cancelled: boolean; readonly spawnUnavailable: boolean; }

function runTool(executable: string, args: readonly string[], stdin: string, timeoutMs: number, signal: AbortSignal): Promise<ToolResult> {
  return new Promise((resolve, reject) => {
    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn(executable, [...args], { shell: false, stdio: ["pipe", "pipe", "pipe"], env: { PATH: process.env.PATH ?? "" } });
    } catch (error) { reject(error); return; }
    let stdout = Buffer.alloc(0);
    let stderrBytes = 0;
    let settled = false;
    let timedOut = false;
    let cancelled = false;
    let spawnUnavailable = false;
    const finish = (exitCode: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      resolve({ stdout: stdout.toString("utf8"), exitCode, timedOut, cancelled, spawnUnavailable });
    };
    const kill = () => { if (!child.killed) child.kill("SIGKILL"); };
    const timer = setTimeout(() => { timedOut = true; kill(); }, timeoutMs);
    const onAbort = () => { cancelled = true; kill(); };
    signal.addEventListener("abort", onAbort, { once: true });
    child.once("error", (error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") { spawnUnavailable = true; finish(null); } else reject(error); });
    child.stdout.on("data", (chunk: Buffer) => {
      if (settled) return;
      if (stdout.length + chunk.length > MAX_TOOL_OUTPUT_BYTES) { kill(); return; }
      stdout = Buffer.concat([stdout, chunk]);
    });
    child.stderr.on("data", (chunk: Buffer) => { stderrBytes += chunk.length; if (stderrBytes > MAX_TOOL_OUTPUT_BYTES) kill(); });
    child.once("close", (code) => finish(code));
    child.stdin.on("error", () => undefined);
    child.stdin.end(stdin);
    if (signal.aborted) onAbort();
  });
}
