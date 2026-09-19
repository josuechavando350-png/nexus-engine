import { assertArray, assertExactKeys, assertSafeInteger, assertToken } from '../core/common.mjs';
import { add, asString, div, fraction, mul, ONE, probability, ZERO } from './rational.mjs';

const compare = (x, y) => x.n * y.d - y.n * x.d;
function vector(x, label, length) {
  const rows = assertArray(x, label, { min: length, max: length });
  return Array.from({ length }, (_, i) => {
    if (!Object.hasOwn(rows, i)) throw new TypeError(`${label} must be dense`);
    return probability(rows[i], `${label}[${i}]`);
  });
}
function normalized(v, label) { if (compare(v.reduce(add, ZERO), ONE) !== 0n) throw new TypeError(`${label} must sum to one`); return v; }
function names(value, label) {
  const x = assertArray(value, label, { min: 2, max: 2 });
  const names = x.map((n, i) => assertToken(n, `${label}[${i}]`));
  if (new Set(names).size !== 2) throw new TypeError(`duplicate ${label}`);
  return names;
}

/** Exact finite-horizon POMDP Bellman backup on a fully specified 2x2x2 model. */
export function solveFinitePomdp(input) {
  assertExactKeys(input, ['states', 'actions', 'observations', 'belief', 'transition', 'observationModel', 'reward', 'horizon', 'discount'], 'POMDP input');
  const states = names(input.states, 'states'), actions = names(input.actions, 'actions');
  names(input.observations, 'observations');
  const horizon = assertSafeInteger(input.horizon, 'horizon', { min: 1, max: 5 });
  const discount = probability(input.discount, 'discount');
  const belief = normalized(vector(input.belief, 'belief', 2), 'belief');
  const outer = (x, label) => {
    const rows = assertArray(x, label, { min: 2, max: 2 });
    if (!Object.hasOwn(rows, 0) || !Object.hasOwn(rows, 1)) throw new TypeError(`${label} must be dense`);
    return rows;
  };
  const t = outer(input.transition, 'transition').map((byState, a) => {
    return outer(byState, `transition[${a}]`).map((row, s) => normalized(vector(row, `transition[${a}][${s}]`, 2), 'transition row'));
  });
  const o = outer(input.observationModel, 'observationModel').map((byNext, a) => {
    return outer(byNext, `observationModel[${a}]`).map((row, s) => normalized(vector(row, `observationModel[${a}][${s}]`, 2), 'observation row'));
  });
  const rewards = outer(input.reward, 'reward').map((row, a) => {
    const values = outer(row, `reward[${a}]`);
    return values.map((value, s) => fraction(BigInt(assertSafeInteger(value, `reward[${a}][${s}]`, { min: -1_000_000, max: 1_000_000 }))));
  });
  const memo = new Map();
  function solve(b, remaining) {
    if (remaining === 0) return { value: ZERO, action: null, q: [] };
    const key = `${remaining}:${b.map(asString).join(',')}`;
    if (memo.has(key)) return memo.get(key);
    const q = actions.map((_, a) => {
      let immediate = ZERO;
      for (let s = 0; s < 2; s++) immediate = add(immediate, mul(b[s], rewards[a][s]));
      const next = [ZERO, ZERO];
      for (let s = 0; s < 2; s++) for (let ns = 0; ns < 2; ns++) next[ns] = add(next[ns], mul(b[s], t[a][s][ns]));
      let future = ZERO;
      for (let obs = 0; obs < 2; obs++) {
        const joint = next.map((p, ns) => mul(p, o[a][ns][obs]));
        const evidenceMass = add(joint[0], joint[1]);
        if (evidenceMass.n === 0n) continue; // Impossible observation has zero expectation.
        const posterior = joint.map((p) => div(p, evidenceMass));
        future = add(future, mul(evidenceMass, solve(posterior, remaining - 1).value));
      }
      return add(immediate, mul(discount, future));
    });
    const winner = compare(q[1], q[0]) > 0n ? 1 : 0;
    const result = { value: q[winner], action: actions[winner], q };
    memo.set(key, result);
    return result;
  }
  const solution = solve(belief, horizon);
  return { bestAction: solution.action, expectedValue: asString(solution.value),
    actionValues: Object.fromEntries(actions.map((name, a) => [name, asString(solution.q[a])])),
    reachableBeliefStates: memo.size, horizon, method: 'EXACT_FINITE_HORIZON_BELIEF_TREE',
    assumptions: ['Supplied transition and observation matrices describe the process', 'Rewards and initial belief are supplied', 'Two states, two actions and two observations; finite horizon'],
    note: 'Model-optimal expected reward is not a real-world success probability.' };
}
