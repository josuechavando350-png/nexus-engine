import { assertExactKeys, assertToken } from '../core/common.mjs';
import { add, asString, fraction, mul, ONE, probability, sub, ZERO } from './rational.mjs';
import { boundedInt, cmp, dense, solveLinear } from './scientific-linear.mjs';

/** Exact policy iteration for fully observed finite discounted Markov decision processes. */
export function solveDiscountedMdp(input) {
  assertExactKeys(input, ['states', 'actions', 'transition', 'rewards', 'discount', 'initialDistribution'], 'discounted MDP');
  const states = dense(input.states, 'states', 2, 4).map((id, i) => assertToken(id, `states[${i}]`));
  const actions = dense(input.actions, 'actions', 2, 3).map((id, i) => assertToken(id, `actions[${i}]`));
  if (new Set(states).size !== states.length || new Set(actions).size !== actions.length) throw new TypeError('duplicate state/action');
  const n = states.length, m = actions.length;
  const gamma = probability(input.discount, 'discount');
  if (cmp(gamma, ONE) >= 0n) throw new TypeError('infinite-horizon discount must be strictly below 1');
  function distribution(value, label) {
    const values = dense(value, label, n, n).map((v, i) => probability(v, `${label}[${i}]`));
    if (cmp(values.reduce(add, ZERO), ONE) !== 0n) throw new TypeError(`${label} must sum to one`);
    return values;
  }
  const initial = distribution(input.initialDistribution, 'initialDistribution');
  const t = dense(input.transition, 'transition', n, n).map((byAction, s) =>
    dense(byAction, `transition[${s}]`, m, m).map((row, a) => distribution(row, `transition[${s}][${a}]`)));
  const rewards = dense(input.rewards, 'rewards', n, n).map((row, s) =>
    dense(row, `rewards[${s}]`, m, m).map((r, a) => fraction(BigInt(boundedInt(r, `rewards[${s}][${a}]`)))));
  let policy = Array(n).fill(0), iterations = 0;
  const evaluate = (choices) => {
    const A = t.map((_, s) => t[s][choices[s]].map((p, next) => sub(next === s ? ONE : ZERO, mul(gamma, p))));
    return solveLinear(A, rewards.map((row, s) => row[choices[s]]));
  };
  let values, qValues;
  const maxPolicies = m ** n;
  for (; iterations < maxPolicies + 1; iterations++) {
    values = evaluate(policy);
    qValues = t.map((byAction, s) => byAction.map((transition, a) => add(rewards[s][a],
      mul(gamma, transition.reduce((sum, p, next) => add(sum, mul(p, values[next])), ZERO)))));
    const improved = policy.map((choice, s) => {
      let best = choice;
      for (let a = 0; a < m; a++) if (cmp(qValues[s][a], qValues[s][best]) > 0n) best = a;
      return best;
    });
    if (improved.every((action, state) => action === policy[state])) break;
    policy = improved;
  }
  if (iterations > maxPolicies) throw new Error('policy iteration exceeded finite policy count');
  for (let s = 0; s < n; s++) {
    if (cmp(values[s], qValues[s][policy[s]]) !== 0n || qValues[s].some((q) => cmp(q, values[s]) > 0n)) {
      throw new Error('exact Bellman optimality certificate failed');
    }
  }
  const expected = initial.reduce((sum, p, s) => add(sum, mul(p, values[s])), ZERO);
  return { optimalPolicy: Object.fromEntries(states.map((state, i) => [state, actions[policy[i]]])),
    values: values.map(asString), qValues: qValues.map((row) => row.map(asString)),
    expectedInitialValue: asString(expected), policyImprovementRounds: iterations,
    bellmanResidual: '0/1', method: 'EXACT_DISCOUNTED_POLICY_ITERATION',
    note: 'Globally optimal for this supplied finite fully observed discounted MDP; not an arbitrary POMDP or empirical forecast.' };
}
