import { LIMITS, record, token } from './model.mjs';

const LEAF = new Set(['TRUE', 'FALSE']);
const ATOM = new Set(['ATOM']);
const UNARY = new Set(['NOT', 'EX', 'AX', 'EF', 'AF', 'EG', 'AG']);
const BINARY = new Set(['AND', 'OR', 'IMPLIES', 'EU', 'AU']);

/** Strictly whitelist AST operators and bound size/depth, including nested formulas. */
export function normalizeFormula(raw, budget, depth = 0) {
  if (++budget.count > LIMITS.formulaNodes || depth > LIMITS.formulaDepth) throw new TypeError('CTL formula exceeds complexity limit');
  record(raw, 'CTL formula', ['op', 'name', 'arg', 'left', 'right'], ['op']);
  const op = token(raw.op, 'CTL operator');
  const normalized = { op };
  if (LEAF.has(op)) record(raw, op, ['op']);
  else if (ATOM.has(op)) {
    record(raw, op, ['op', 'name']);
    normalized.name = token(raw.name, 'atomic proposition');
  } else if (UNARY.has(op)) {
    record(raw, op, ['op', 'arg']);
    normalized.arg = normalizeFormula(raw.arg, budget, depth + 1);
  } else if (BINARY.has(op)) {
    record(raw, op, ['op', 'left', 'right']);
    normalized.left = normalizeFormula(raw.left, budget, depth + 1);
    normalized.right = normalizeFormula(raw.right, budget, depth + 1);
  } else throw new TypeError(`unsupported CTL operator ${op}`);
  return Object.freeze(normalized);
}

const has = (set, i) => set[i] === 1;
const complement = set => Uint8Array.from(set, x => x ? 0 : 1);
const combine = (left, right, fn) => Uint8Array.from(left, (x, i) => fn(x, right[i]) ? 1 : 0);
function existsNext(set, graph) {
  return Uint8Array.from(graph.successors, successors => successors.some(i => has(set, i)) ? 1 : 0);
}
function allNext(set, graph) {
  return Uint8Array.from(graph.successors, successors => successors.every(i => has(set, i)) ? 1 : 0);
}
function fixedPoint(base, graph, quantifier, greatest, guard) {
  let current = greatest ? new Uint8Array(graph.states.length).fill(1) : new Uint8Array(graph.states.length);
  for (let step = 0; step <= graph.states.length; step++) {
    const nextState = quantifier === 'E' ? existsNext(current, graph) : allNext(current, graph);
    const next = Uint8Array.from(base, (x, i) => {
      if (greatest) return x && nextState[i] ? 1 : 0;
      return x || ((guard === undefined || guard[i]) && nextState[i]) ? 1 : 0;
    });
    if (next.every((value, i) => value === current[i])) return next;
    current = next;
  }
  throw new Error('internal error: finite fixed point did not converge');
}

export function evaluateCTL(formula, graph) {
  const evidence = [];
  const satisfyingByNode = new WeakMap();
  function visit(node) {
    const a = node.arg ? visit(node.arg) : null;
    const l = node.left ? visit(node.left) : null;
    const r = node.right ? visit(node.right) : null;
    let sat;
    switch (node.op) {
      case 'TRUE': sat = new Uint8Array(graph.states.length).fill(1); break;
      case 'FALSE': sat = new Uint8Array(graph.states.length); break;
      case 'ATOM': sat = Uint8Array.from(graph.propositions, labels => labels.includes(node.name) ? 1 : 0); break;
      case 'NOT': sat = complement(a); break;
      case 'AND': sat = combine(l, r, (x, y) => x && y); break;
      case 'OR': sat = combine(l, r, (x, y) => x || y); break;
      case 'IMPLIES': sat = combine(l, r, (x, y) => !x || y); break;
      case 'EX': sat = existsNext(a, graph); break;
      case 'AX': sat = allNext(a, graph); break;
      case 'EF': sat = fixedPoint(a, graph, 'E', false); break;
      case 'AF': sat = fixedPoint(a, graph, 'A', false); break;
      case 'EG': sat = fixedPoint(a, graph, 'E', true); break;
      case 'AG': sat = fixedPoint(a, graph, 'A', true); break;
      case 'EU': sat = fixedPoint(r, graph, 'E', false, l); break;
      case 'AU': sat = fixedPoint(r, graph, 'A', false, l); break;
      default: throw new Error(`internal error: unhandled ${node.op}`);
    }
    const satisfyingStateIndices = [];
    for (let i = 0; i < sat.length; i++) if (sat[i]) satisfyingStateIndices.push(i);
    evidence.push(Object.freeze({
      nodeId: evidence.length,
      op: node.op,
      ...(node.name ? { name: node.name } : {}),
      satisfyingStateIndices,
    }));
    satisfyingByNode.set(node, sat);
    return sat;
  }
  return { satisfying: visit(formula), subformulaEvidence: evidence, satisfyingByNode };
}

/** Deterministic shortest path constrained to a subset, with explicit final-state predicate. */
function shortestPath(graph, start, allowed, goal) {
  const queue = [[start]];
  const visited = new Set([start]);
  for (let i = 0; i < queue.length; i++) {
    const path = queue[i];
    const last = path.at(-1);
    if (goal(last)) return path.map(n => graph.states[n]);
    for (const next of graph.successors[last]) {
      if (!allowed(next) || visited.has(next)) continue;
      visited.add(next);
      queue.push([...path, next]);
    }
  }
  return null;
}
function requiredPath(graph, start, allowed, goal) {
  const path = shortestPath(graph, start, allowed, goal);
  if (!path) throw new Error('internal error: CTL verdict has no corresponding finite path');
  return path;
}

/** Find a prefix and a nonempty loop, proving an infinite path under deadlock-stutter semantics. */
function lasso(graph, start, allowed) {
  const seen = new Map();
  const chain = [];
  function search(node) {
    if (seen.has(node)) {
      const index = seen.get(node);
      return { prefix: chain.slice(0, index + 1).map(i => graph.states[i]), cycle: [...chain.slice(index), node].map(i => graph.states[i]) };
    }
    seen.set(node, chain.length);
    chain.push(node);
    for (const next of graph.successors[node]) {
      if (!allowed(next)) continue;
      const result = search(next);
      if (result) return result;
    }
    chain.pop();
    seen.delete(node);
    return null;
  }
  const result = search(start);
  if (!result) throw new Error('internal error: CTL verdict has no corresponding infinite path');
  return result;
}

/** Diagnostics are *supplementary*: exhaustive CTL satisfaction sets determine the verdict. */
export function diagnostic(formula, graph, start, satisfied, satisfyingByNode) {
  const local = child => satisfyingByNode.get(child);
  const state = graph.states[start];
  if (formula.op === 'AG' && !satisfied) {
    const child = local(formula.arg);
    return { kind: 'SAFETY_COUNTEREXAMPLE', path: requiredPath(graph, start, () => true, i => !has(child, i)) };
  }
  if (formula.op === 'EF' && satisfied) {
    const child = local(formula.arg);
    return { kind: 'REACHABILITY_WITNESS', path: requiredPath(graph, start, () => true, i => has(child, i)) };
  }
  if (formula.op === 'AF' && !satisfied) {
    const child = local(formula.arg);
    return { kind: 'LIVENESS_COUNTEREXAMPLE', ...lasso(graph, start, i => !has(child, i)) };
  }
  if (formula.op === 'EG' && satisfied) {
    const child = local(formula.arg);
    return { kind: 'INFINITE_PATH_WITNESS', ...lasso(graph, start, i => has(child, i)) };
  }
  if (formula.op === 'EU' && satisfied) {
    const left = local(formula.left), right = local(formula.right);
    return { kind: 'UNTIL_WITNESS', path: requiredPath(graph, start, i => has(left, i) || has(right, i), i => has(right, i)) };
  }
  if (formula.op === 'EX' && satisfied || formula.op === 'AX' && !satisfied) {
    const child = local(formula.arg);
    const to = graph.successors[start].find(i => has(child, i) === satisfied);
    return { kind: satisfied ? 'NEXT_WITNESS' : 'NEXT_COUNTEREXAMPLE', path: [state, graph.states[to]] };
  }
  return { kind: 'EXHAUSTIVE_STATE_SET', state };
}
