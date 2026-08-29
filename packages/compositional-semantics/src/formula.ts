import type { SemanticFormula, SemanticOperand, SemanticState, SemanticValue } from "./types.js";
import { validateSemanticState } from "./state.js";

const MAX_FORMULA_DEPTH = 128;
const COMPARATORS = new Set(["eq", "neq", "lt", "lte", "gt", "gte"]);

function assertName(name: unknown, label: string): asserts name is string {
  if (typeof name !== "string" || !name.trim()) throw new Error(`${label} must be a non-empty string`);
}

function validateOperand(operand: SemanticOperand): void {
  if (!operand || typeof operand !== "object" || typeof (operand as { kind?: unknown }).kind !== "string") {
    throw new Error("Unsupported semantic operand");
  }
  if (operand.kind === "literal") {
    const value = operand.value;
    if (!(value === null || typeof value === "string" || typeof value === "boolean" || (typeof value === "number" && Number.isFinite(value)))) {
      throw new Error("Literal must be a scalar semantic value");
    }
    return;
  }
  if (operand.kind !== "fact" && operand.kind !== "metric") throw new Error("Unsupported semantic operand");
  assertName(operand.name, `${operand.kind} operand name`);
}

export function validateSemanticFormula(formula: SemanticFormula, depth = 0): void {
  if (depth > MAX_FORMULA_DEPTH) throw new Error(`Semantic formula exceeds maximum depth ${MAX_FORMULA_DEPTH}`);
  switch (formula.op) {
    case "true":
    case "false":
      return;
    case "exists": {
      const operand = formula.operand as SemanticOperand;
      validateOperand(operand);
      if (operand.kind === "literal") throw new Error("exists cannot target a literal");
      return;
    }
    case "compare":
      validateOperand(formula.left);
      validateOperand(formula.right);
      if (!COMPARATORS.has(formula.comparator)) throw new Error(`Unsupported comparator ${String(formula.comparator)}`);
      return;
    case "not":
      validateSemanticFormula(formula.formula, depth + 1);
      return;
    case "and":
    case "or":
      if (formula.formulas.length === 0) throw new Error(`${formula.op} requires at least one child formula`);
      for (const child of formula.formulas) validateSemanticFormula(child, depth + 1);
      return;
    case "implies":
      validateSemanticFormula(formula.antecedent, depth + 1);
      validateSemanticFormula(formula.consequent, depth + 1);
      return;
    default: {
      const exhaustive: never = formula;
      throw new Error(`Unsupported semantic formula: ${String(exhaustive)}`);
    }
  }
}

interface ResolvedOperand {
  readonly exists: boolean;
  readonly value?: SemanticValue;
}

function resolveOperand(state: SemanticState, operand: SemanticOperand): ResolvedOperand {
  if (operand.kind === "literal") return { exists: true, value: operand.value };
  if (operand.kind === "fact") {
    if (!Object.prototype.hasOwnProperty.call(state.facts, operand.name)) return { exists: false };
    return { exists: true, value: state.facts[operand.name]! };
  }
  if (!Object.prototype.hasOwnProperty.call(state.metrics, operand.name)) return { exists: false };
  return { exists: true, value: state.metrics[operand.name]! };
}

function compareValues(left: SemanticValue, comparator: string, right: SemanticValue): boolean {
  if (comparator === "eq") return left === right;
  if (comparator === "neq") return left !== right;
  if (typeof left !== "number" || typeof right !== "number") return false;
  switch (comparator) {
    case "lt": return left < right;
    case "lte": return left <= right;
    case "gt": return left > right;
    case "gte": return left >= right;
    default: return false;
  }
}

function evaluateTrusted(state: SemanticState, formula: SemanticFormula): boolean {
  switch (formula.op) {
    case "true": return true;
    case "false": return false;
    case "exists": return resolveOperand(state, formula.operand).exists;
    case "compare": {
      const left = resolveOperand(state, formula.left);
      const right = resolveOperand(state, formula.right);
      if (!left.exists || !right.exists) return false;
      return compareValues(left.value!, formula.comparator, right.value!);
    }
    case "not": return !evaluateTrusted(state, formula.formula);
    case "and": return formula.formulas.every((child) => evaluateTrusted(state, child));
    case "or": return formula.formulas.some((child) => evaluateTrusted(state, child));
    case "implies": return !evaluateTrusted(state, formula.antecedent) || evaluateTrusted(state, formula.consequent);
  }
}

export function evaluateSemanticFormula(state: SemanticState, formula: SemanticFormula): boolean {
  validateSemanticState(state);
  validateSemanticFormula(formula);
  return evaluateTrusted(state, formula);
}
