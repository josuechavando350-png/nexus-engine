import { digestValue } from "@nexus/visual-algebra";
import type {
  SemanticComposition,
  SemanticContract,
  SemanticEffect,
  SemanticFormula,
  SemanticParallel,
  SemanticRule,
  SemanticState,
  SemanticValue,
} from "./types.js";
import { assertSafeSemanticName, createSemanticState, validateSemanticState } from "./state.js";
import { validateSemanticFormula } from "./formula.js";

export const MAX_SEMANTIC_COMPOSITION_DEPTH = 128;
export const MAX_SEMANTIC_COMPOSITION_NODES = 4_096;
export const MAX_SEMANTIC_COMPOSITION_RULES = 8_192;
export const MAX_SEMANTIC_COMPOSITION_EFFECTS = 16_384;

function assertNonEmpty(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} must be a non-empty string`);
}

interface CompositionBudget {
  nodes: number;
  rules: number;
  effects: number;
}

function validateRules(rules: readonly SemanticRule[] | undefined, label: string, budget: CompositionBudget): void {
  const ids = new Set<string>();
  for (const rule of rules ?? []) {
    budget.rules += 1;
    if (budget.rules > MAX_SEMANTIC_COMPOSITION_RULES) {
      throw new Error(`Semantic composition exceeds ${MAX_SEMANTIC_COMPOSITION_RULES} rules`);
    }
    assertNonEmpty(rule.id, `${label} rule id`);
    if (ids.has(rule.id)) throw new Error(`Duplicate ${label} rule id: ${rule.id}`);
    ids.add(rule.id);
    if (rule.message !== undefined && typeof rule.message !== "string") throw new Error(`${label} rule message must be a string`);
    validateSemanticFormula(rule.formula);
  }
}

function validateContract(contract: SemanticContract | undefined, budget: CompositionBudget): void {
  if (!contract) return;
  assertNonEmpty(contract.id, "contract id");
  validateRules(contract.requires, "requires", budget);
  validateRules(contract.ensures, "ensures", budget);
  validateRules(contract.invariants, "invariants", budget);
}

function validateEffect(effect: SemanticEffect): void {
  if (!effect || typeof effect !== "object") throw new Error("Semantic effect must be an object");
  assertSafeSemanticName(effect.name, "effect name");
  switch (effect.kind) {
    case "set_fact": {
      const value = effect.value;
      if (!(value === null || typeof value === "string" || typeof value === "boolean" || (typeof value === "number" && Number.isFinite(value)))) {
        throw new Error(`Effect ${effect.name} requires a scalar semantic value`);
      }
      return;
    }
    case "delete_fact":
      return;
    case "set_metric":
    case "add_metric":
    case "min_metric":
    case "max_metric":
      if (typeof effect.value !== "number" || !Number.isFinite(effect.value)) {
        throw new Error(`Effect ${effect.name} requires a finite number`);
      }
      return;
    default: {
      const exhaustive: never = effect;
      throw new Error(`Unsupported semantic effect kind: ${String((exhaustive as { kind?: unknown }).kind)}`);
    }
  }
}

export function validateSemanticComposition(
  composition: SemanticComposition,
  options: { readonly maxDepth?: number } = {},
): void {
  const maxDepth = options.maxDepth ?? MAX_SEMANTIC_COMPOSITION_DEPTH;
  if (!Number.isInteger(maxDepth) || maxDepth < 1 || maxDepth > MAX_SEMANTIC_COMPOSITION_DEPTH) {
    throw new Error(`maxDepth must be an integer in [1, ${MAX_SEMANTIC_COMPOSITION_DEPTH}]`);
  }
  const ids = new Set<string>();
  const budget: CompositionBudget = { nodes: 0, rules: 0, effects: 0 };
  const visit = (node: SemanticComposition, depth: number): void => {
    if (!node || typeof node !== "object") throw new Error("Semantic composition node must be an object");
    if (depth > maxDepth) throw new Error(`Semantic composition exceeds maximum depth ${maxDepth}`);
    budget.nodes += 1;
    if (budget.nodes > MAX_SEMANTIC_COMPOSITION_NODES) {
      throw new Error(`Semantic composition exceeds ${MAX_SEMANTIC_COMPOSITION_NODES} nodes`);
    }
    assertNonEmpty(node.id, "composition node id");
    if (ids.has(node.id)) throw new Error(`Duplicate composition node id: ${node.id}`);
    ids.add(node.id);
    validateContract(node.contract, budget);
    switch (node.kind) {
      case "step":
        if (!Array.isArray(node.effects)) throw new Error(`step node ${node.id} requires an effects array`);
        budget.effects += node.effects.length;
        if (budget.effects > MAX_SEMANTIC_COMPOSITION_EFFECTS) {
          throw new Error(`Semantic composition exceeds ${MAX_SEMANTIC_COMPOSITION_EFFECTS} effects`);
        }
        for (const effect of node.effects) validateEffect(effect);
        return;
      case "sequence":
      case "parallel":
      case "nest":
        if (!Array.isArray(node.children) || node.children.length === 0) throw new Error(`${node.kind} node ${node.id} requires at least one child`);
        for (const child of node.children) visit(child, depth + 1);
        return;
      default: {
        const exhaustive: never = node;
        throw new Error(`Unsupported composition node: ${String((exhaustive as { kind?: unknown }).kind)}`);
      }
    }
  };
  visit(composition, 1);
}

function canonicalizeFormula(formula: SemanticFormula): unknown {
  switch (formula.op) {
    case "and":
    case "or":
      return { ...formula, formulas: formula.formulas.map(canonicalizeFormula) };
    case "not":
      return { ...formula, formula: canonicalizeFormula(formula.formula) };
    case "implies":
      return { ...formula, antecedent: canonicalizeFormula(formula.antecedent), consequent: canonicalizeFormula(formula.consequent) };
    default:
      return formula;
  }
}

function canonicalizeContract(contract: SemanticContract | undefined): unknown {
  if (!contract) return undefined;
  const canonicalRules = (rules: readonly SemanticRule[] | undefined) =>
    rules ? [...rules].sort((a, b) => a.id.localeCompare(b.id)).map((rule) => ({ ...rule, formula: canonicalizeFormula(rule.formula) })) : undefined;
  return {
    id: contract.id,
    ...(contract.requires ? { requires: canonicalRules(contract.requires) } : {}),
    ...(contract.ensures ? { ensures: canonicalRules(contract.ensures) } : {}),
    ...(contract.invariants ? { invariants: canonicalRules(contract.invariants) } : {}),
  };
}

export function canonicalizeSemanticComposition(composition: SemanticComposition): unknown {
  const contract = canonicalizeContract(composition.contract);
  const common = { id: composition.id, kind: composition.kind, ...(contract ? { contract } : {}) };
  if (composition.kind === "step") return { ...common, effects: composition.effects };
  const children = composition.children.map(canonicalizeSemanticComposition);
  return { ...common, children: composition.kind === "parallel" ? [...children].sort((a, b) => {
    const left = (a as { id: string }).id;
    const right = (b as { id: string }).id;
    return left.localeCompare(right);
  }) : children };
}

export function semanticCompositionDigest(composition: SemanticComposition): string {
  validateSemanticComposition(composition);
  return digestValue(canonicalizeSemanticComposition(composition));
}

type FactPatchValue = Readonly<{ present: true; value: SemanticValue }> | Readonly<{ present: false }>;
interface StatePatch {
  readonly facts: ReadonlyMap<string, FactPatchValue>;
  readonly metrics: ReadonlyMap<string, number | undefined>;
}

function diffState(base: SemanticState, next: SemanticState): StatePatch {
  validateSemanticState(base);
  validateSemanticState(next);
  const facts = new Map<string, FactPatchValue>();
  const factKeys = new Set([...Object.keys(base.facts), ...Object.keys(next.facts)]);
  for (const key of [...factKeys].sort()) {
    const baseHas = Object.prototype.hasOwnProperty.call(base.facts, key);
    const nextHas = Object.prototype.hasOwnProperty.call(next.facts, key);
    if (baseHas === nextHas && (!baseHas || base.facts[key] === next.facts[key])) continue;
    facts.set(key, nextHas ? { present: true, value: next.facts[key]! } : { present: false });
  }
  const metrics = new Map<string, number | undefined>();
  const metricKeys = new Set([...Object.keys(base.metrics), ...Object.keys(next.metrics)]);
  for (const key of [...metricKeys].sort()) {
    const baseHas = Object.prototype.hasOwnProperty.call(base.metrics, key);
    const nextHas = Object.prototype.hasOwnProperty.call(next.metrics, key);
    if (baseHas === nextHas && (!baseHas || base.metrics[key] === next.metrics[key])) continue;
    metrics.set(key, nextHas ? next.metrics[key] : undefined);
  }
  return { facts, metrics };
}

function sameFactPatch(left: FactPatchValue, right: FactPatchValue): boolean {
  if (left.present !== right.present) return false;
  return !left.present || left.value === (right as { present: true; value: SemanticValue }).value;
}

export interface ParallelMergeResult {
  readonly state?: SemanticState;
  readonly conflict?: string;
}

export function mergeParallelStates(base: SemanticState, branches: readonly SemanticState[]): ParallelMergeResult {
  validateSemanticState(base);
  const factWrites = new Map<string, FactPatchValue>();
  const metricWrites = new Map<string, number | undefined>();

  for (const branch of branches) {
    const patch = diffState(base, branch);
    for (const [key, value] of patch.facts) {
      const existing = factWrites.get(key);
      if (existing !== undefined && !sameFactPatch(existing, value)) return { conflict: `parallel fact conflict on ${key}` };
      factWrites.set(key, value);
    }
    for (const [key, value] of patch.metrics) {
      if (metricWrites.has(key) && metricWrites.get(key) !== value) return { conflict: `parallel metric conflict on ${key}` };
      metricWrites.set(key, value);
    }
  }

  const facts = Object.assign(Object.create(null), base.facts) as Record<string, SemanticValue>;
  const metrics = Object.assign(Object.create(null), base.metrics) as Record<string, number>;
  for (const [key, change] of [...factWrites.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    if (change.present) facts[key] = change.value; else delete facts[key];
  }
  for (const [key, value] of [...metricWrites.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    if (value === undefined) delete metrics[key]; else metrics[key] = value;
  }
  return { state: createSemanticState({ facts, metrics }) };
}

export function orderedParallelChildren(node: SemanticParallel): readonly SemanticComposition[] {
  return Object.freeze([...node.children].sort((a, b) => a.id.localeCompare(b.id)));
}
