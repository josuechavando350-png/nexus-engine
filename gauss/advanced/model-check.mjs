import { assertArray, assertExactKeys, assertToken } from '../core/common.mjs';

function uniqueTokens(values, label, min, max) {
  const tokens = assertArray(values, label, { min, max }).map((v, i) => assertToken(v, `${label}[${i}]`));
  if (new Set(tokens).size !== tokens.length) throw new TypeError(`${label} contains duplicates`);
  return tokens;
}

/** Exhaustive AG(!forbidden) and EF(target) over a *supplied finite state graph*. */
export function checkFiniteTransitionSystem(input) {
  assertExactKeys(input, ['states', 'initial', 'transitions', 'forbiddenStates', 'targetStates'], 'finite automaton');
  const states = uniqueTokens(input.states, 'states', 1, 64);
  const index = new Map(states.map((s, i) => [s, i]));
  const initial = assertToken(input.initial, 'initial');
  if (!index.has(initial)) throw new TypeError('initial not in states');
  const forbidden = uniqueTokens(input.forbiddenStates, 'forbiddenStates', 0, 64);
  const targets = uniqueTokens(input.targetStates, 'targetStates', 0, 64);
  for (const state of [...forbidden, ...targets]) if (!index.has(state)) throw new TypeError('referenced state not in states');
  const edges = Array.from({ length: states.length }, () => new Set());
  const transitions = assertArray(input.transitions, 'transitions', { max: 1024 });
  for (const [i, edge] of transitions.entries()) {
    assertExactKeys(edge, ['from', 'to'], `transitions[${i}]`);
    if (!index.has(edge.from) || !index.has(edge.to)) throw new TypeError('transition references unknown state');
    if (edges[index.get(edge.from)].has(index.get(edge.to))) throw new TypeError('duplicate transition');
    edges[index.get(edge.from)].add(index.get(edge.to));
  }
  // BFS visits all reachable states and provides shortest witnesses (in edge count).
  const parent = new Map([[initial, null]]);
  const queue = [initial];
  for (let i = 0; i < queue.length; i++) {
    for (const neighbor of [...edges[index.get(queue[i])]].sort((a, b) => a - b)) {
      const to = states[neighbor];
      if (!parent.has(to)) { parent.set(to, queue[i]); queue.push(to); }
    }
  }
  function trace(state) {
    if (state === null) return null;
    const path = [];
    for (let at = state; at !== null; at = parent.get(at)) path.push(at);
    return path.reverse();
  }
  const bad = queue.find((s) => forbidden.includes(s)) ?? null;
  const target = queue.find((s) => targets.includes(s)) ?? null;
  return {
    domain: 'SUPPLIED_FINITE_TRANSITION_SYSTEM',
    reachableStateCount: queue.length,
    exploredTransitionCount: queue.reduce((n, s) => n + edges[index.get(s)].size, 0),
    invariantHolds: bad === null,
    counterexample: trace(bad),
    targetReachable: target !== null,
    targetWitness: trace(target),
    note: 'Exhaustive only for the supplied bounded graph; not a proof about an external system.',
  };
}
