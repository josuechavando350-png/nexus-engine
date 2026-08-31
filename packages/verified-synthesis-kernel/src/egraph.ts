import { createHash } from "node:crypto";
import type { CandidateAssignment, IrConstraint, IrExpression, SynthesisBudgets, SynthesisProblem } from "./types.js";

const MAX_EXPRESSION_DEPTH = 32;
const MAX_EXPRESSION_NODES = 256;
const IDENTIFIER = /^[A-Za-z][A-Za-z0-9_.:-]{0,127}$/;

export function stable(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stable(record[key])}`).join(",")}}`;
}

export function sha256(value: unknown): string {
  return createHash("sha256").update(stable(value)).digest("hex");
}

function assertIdentifier(value: unknown, field: string): string {
  if (typeof value !== "string" || !IDENTIFIER.test(value)) throw new Error(`${field} is invalid`);
  return value;
}

function assertSafeInteger(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value)) throw new Error(`${field} must be a safe integer`);
  return value as number;
}

function validateExpression(expression: IrExpression, variables: ReadonlySet<string>, depth = 0, counter = { count: 0 }): void {
  if (!expression || typeof expression !== "object" || Array.isArray(expression)) throw new Error("IR expression must be an object");
  counter.count += 1;
  if (counter.count > MAX_EXPRESSION_NODES) throw new Error("IR expression exceeds node budget");
  if (depth > MAX_EXPRESSION_DEPTH) throw new Error("IR expression exceeds depth budget");
  const keys = Object.keys(expression as object);
  if (expression.kind === "const") {
    if (keys.length !== 2 || !keys.includes("kind") || !keys.includes("value")) throw new Error("const expression contains unknown fields");
    assertSafeInteger(expression.value, "constant");
    return;
  }
  if (expression.kind === "var") {
    if (keys.length !== 2 || !keys.includes("kind") || !keys.includes("name")) throw new Error("var expression contains unknown fields");
    assertIdentifier(expression.name, "variable reference");
    if (!variables.has(expression.name)) throw new Error(`unknown synthesis variable: ${expression.name}`);
    return;
  }
  if (keys.length !== 3 || !keys.includes("kind") || !keys.includes("left") || !keys.includes("right")) throw new Error("binary expression contains unknown fields");
  validateExpression(expression.left, variables, depth + 1, counter);
  validateExpression(expression.right, variables, depth + 1, counter);
}

export function validateProblem(problem: SynthesisProblem): void {
  if (!problem || typeof problem !== "object" || Array.isArray(problem)) throw new Error("synthesis problem must be an object");
  const allowed = new Set(["authority", "scope", "problemId", "variables", "constraints", "budgets"]);
  for (const key of Object.keys(problem as object)) if (!allowed.has(key)) throw new Error(`unknown synthesis problem field: ${key}`);
  if (problem.authority !== "NEXUS_VERIFIED_SYNTHESIS_PROBLEM_V1") throw new Error("unsupported synthesis problem authority");
  assertIdentifier(problem.problemId, "problemId");
  if (!problem.scope || typeof problem.scope !== "object" || Array.isArray(problem.scope)) throw new Error("scope must be an object");
  const scopeKeys = Object.keys(problem.scope as object);
  if (scopeKeys.length !== 3 || !["tenantId", "organizationId", "projectId"].every((key) => scopeKeys.includes(key))) throw new Error("scope contains unknown or missing fields");
  assertIdentifier(problem.scope.tenantId, "tenantId");
  assertIdentifier(problem.scope.organizationId, "organizationId");
  assertIdentifier(problem.scope.projectId, "projectId");
  if (!Array.isArray(problem.variables) || problem.variables.length < 1 || problem.variables.length > 12) throw new Error("variables must contain 1..12 entries");
  const variableNames = new Set<string>();
  for (const variable of problem.variables) {
    if (!variable || typeof variable !== "object" || Array.isArray(variable)) throw new Error("variable must be an object");
    const keys = Object.keys(variable as object);
    if (keys.length !== 3 || !["name", "min", "max"].every((key) => keys.includes(key))) throw new Error("variable contains unknown or missing fields");
    const name = assertIdentifier(variable.name, "variable name");
    if (variableNames.has(name)) throw new Error(`duplicate synthesis variable: ${name}`);
    variableNames.add(name);
    const min = assertSafeInteger(variable.min, `${name}.min`);
    const max = assertSafeInteger(variable.max, `${name}.max`);
    if (min > max || max - min > 10_000) throw new Error(`variable ${name} has invalid or excessive range`);
  }
  if (!Array.isArray(problem.constraints) || problem.constraints.length > 256) throw new Error("constraints exceed supported bound");
  const ids = new Set<string>();
  for (const constraint of problem.constraints) {
    if (!constraint || typeof constraint !== "object" || Array.isArray(constraint)) throw new Error("constraint must be an object");
    const keys = Object.keys(constraint as object);
    if (keys.length !== 4 || !["id", "left", "relation", "right"].every((key) => keys.includes(key))) throw new Error("constraint contains unknown or missing fields");
    const id = assertIdentifier(constraint.id, "constraint id");
    if (ids.has(id)) throw new Error(`duplicate constraint id: ${id}`);
    ids.add(id);
    if (constraint.relation !== "EQ" && constraint.relation !== "LE" && constraint.relation !== "GE") throw new Error(`constraint ${id} has invalid relation`);
    validateExpression(constraint.left, variableNames);
    validateExpression(constraint.right, variableNames);
  }
  validateBudgets(problem.budgets);
}

function validateBudgets(budgets: SynthesisBudgets): void {
  if (!budgets || typeof budgets !== "object" || Array.isArray(budgets)) throw new Error("budgets must be an object");
  const allowed = ["maxIterations", "maxCandidates", "maxCounterexamples", "maxEGraphIterations", "maxEGraphNodes", "solverTimeoutMs", "oracleTimeoutMs"] as const;
  const keys = Object.keys(budgets as object);
  if (keys.length !== allowed.length || !allowed.every((key) => keys.includes(key))) throw new Error("budgets contain unknown or missing fields");
  const ranges: Readonly<Record<(typeof allowed)[number], readonly [number, number]>> = {
    maxIterations: [1, 64], maxCandidates: [1, 1_000_000], maxCounterexamples: [0, 256], maxEGraphIterations: [1, 32], maxEGraphNodes: [1, 10_000], solverTimeoutMs: [1, 120_000], oracleTimeoutMs: [1, 120_000],
  };
  for (const key of allowed) {
    const value = budgets[key];
    const [min, max] = ranges[key];
    if (!Number.isSafeInteger(value) || value < min || value > max) throw new Error(`${key} is outside the supported bound`);
  }
}

export function evaluateExpression(expression: IrExpression, candidate: CandidateAssignment): number {
  switch (expression.kind) {
    case "const": return expression.value;
    case "var": {
      const value = candidate[expression.name];
      if (!Number.isSafeInteger(value)) throw new Error(`candidate is missing safe integer ${expression.name}`);
      return value;
    }
    case "add": {
      const value = evaluateExpression(expression.left, candidate) + evaluateExpression(expression.right, candidate);
      if (!Number.isSafeInteger(value)) throw new Error("IR evaluation exceeded safe integer range");
      return value;
    }
    case "sub": {
      const value = evaluateExpression(expression.left, candidate) - evaluateExpression(expression.right, candidate);
      if (!Number.isSafeInteger(value)) throw new Error("IR evaluation exceeded safe integer range");
      return value;
    }
    case "mul": {
      const value = evaluateExpression(expression.left, candidate) * evaluateExpression(expression.right, candidate);
      if (!Number.isSafeInteger(value)) throw new Error("IR evaluation exceeded safe integer range");
      return value;
    }
    case "min": return Math.min(evaluateExpression(expression.left, candidate), evaluateExpression(expression.right, candidate));
    case "max": return Math.max(evaluateExpression(expression.left, candidate), evaluateExpression(expression.right, candidate));
  }
}

export function evaluateConstraint(constraint: IrConstraint, candidate: CandidateAssignment): { leftValue: number; rightValue: number; pass: boolean } {
  const leftValue = evaluateExpression(constraint.left, candidate);
  const rightValue = evaluateExpression(constraint.right, candidate);
  const pass = constraint.relation === "EQ" ? leftValue === rightValue : constraint.relation === "LE" ? leftValue <= rightValue : leftValue >= rightValue;
  return { leftValue, rightValue, pass };
}

function expressionCost(expression: IrExpression): number {
  if (expression.kind === "const" || expression.kind === "var") return 1;
  return 1 + expressionCost(expression.left) + expressionCost(expression.right);
}

function key(expression: IrExpression): string { return stable(expression); }
function zero(): IrExpression { return { kind: "const", value: 0 }; }
function one(): IrExpression { return { kind: "const", value: 1 }; }

function binary(kind: "add" | "sub" | "mul" | "min" | "max", left: IrExpression, right: IrExpression): IrExpression {
  return { kind, left, right };
}

function immediateRewrites(expression: IrExpression): readonly IrExpression[] {
  if (expression.kind === "const" || expression.kind === "var") return [];
  const output: IrExpression[] = [];
  const { kind, left, right } = expression;
  if (kind === "add" || kind === "mul" || kind === "min" || kind === "max") output.push(binary(kind, right, left));
  if (kind === "add" && key(right) === key(zero())) output.push(left);
  if (kind === "add" && key(left) === key(zero())) output.push(right);
  if (kind === "sub" && key(right) === key(zero())) output.push(left);
  if (kind === "sub" && key(left) === key(right)) output.push(zero());
  if (kind === "mul" && key(right) === key(one())) output.push(left);
  if (kind === "mul" && key(left) === key(one())) output.push(right);
  if (kind === "mul" && (key(left) === key(zero()) || key(right) === key(zero()))) output.push(zero());
  if ((kind === "min" || kind === "max") && key(left) === key(right)) output.push(left);
  if (left.kind === "const" && right.kind === "const") output.push({ kind: "const", value: evaluateExpression(expression, {}) });
  if ((kind === "add" || kind === "mul") && left.kind === kind) output.push(binary(kind, left.left, binary(kind, left.right, right)));
  if ((kind === "add" || kind === "mul") && right.kind === kind) output.push(binary(kind, binary(kind, left, right.left), right.right));
  return output;
}

export interface SaturationResult {
  readonly expression: IrExpression;
  readonly exploredNodes: number;
  readonly iterations: number;
  readonly saturated: boolean;
  readonly digest: string;
}

export function saturateExpression(expression: IrExpression, budgets: Pick<SynthesisBudgets, "maxEGraphIterations" | "maxEGraphNodes">): SaturationResult {
  const seen = new Map<string, IrExpression>([[key(expression), expression]]);
  let frontier = [expression];
  let iterations = 0;
  let saturated = false;
  for (; iterations < budgets.maxEGraphIterations && frontier.length > 0; iterations += 1) {
    const next: IrExpression[] = [];
    for (const current of frontier) {
      const variants = [...immediateRewrites(current)];
      if (current.kind !== "const" && current.kind !== "var") {
        for (const replacement of immediateRewrites(current.left)) variants.push(binary(current.kind, replacement, current.right));
        for (const replacement of immediateRewrites(current.right)) variants.push(binary(current.kind, current.left, replacement));
      }
      for (const variant of variants) {
        const variantKey = key(variant);
        if (seen.has(variantKey)) continue;
        if (seen.size >= budgets.maxEGraphNodes) { frontier = []; break; }
        seen.set(variantKey, variant);
        next.push(variant);
      }
      if (seen.size >= budgets.maxEGraphNodes) break;
    }
    if (next.length === 0) { saturated = true; frontier = []; break; }
    frontier = next;
  }
  const expressionOut = [...seen.values()].sort((a, b) => expressionCost(a) - expressionCost(b) || key(a).localeCompare(key(b)))[0] ?? expression;
  return Object.freeze({ expression: expressionOut, exploredNodes: seen.size, iterations, saturated, digest: sha256([...seen.keys()].sort()) });
}

export function normalizeConstraints(problem: SynthesisProblem, constraints: readonly IrConstraint[]): readonly IrConstraint[] {
  validateProblem(problem);
  if (!Array.isArray(constraints) || constraints.length > 512) throw new Error("combined constraint set exceeds supported bound");
  const ids = new Set<string>();
  const normalized = constraints.map((constraint) => {
    validateProblem({ ...problem, constraints: [constraint] });
    if (ids.has(constraint.id)) throw new Error(`duplicate combined constraint id: ${constraint.id}`);
    ids.add(constraint.id);
    return Object.freeze({
      id: constraint.id,
      relation: constraint.relation,
      left: saturateExpression(constraint.left, problem.budgets).expression,
      right: saturateExpression(constraint.right, problem.budgets).expression,
    });
  });
  return Object.freeze(normalized.sort((a, b) => a.id.localeCompare(b.id)));
}
