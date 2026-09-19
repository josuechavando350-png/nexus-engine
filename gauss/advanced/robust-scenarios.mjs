import { assertExactKeys, assertToken } from '../core/common.mjs';
import { add, asString, fraction, mul, ONE, probability, sub, ZERO } from './rational.mjs';
import { boundedInt, cmp, dense } from './scientific-linear.mjs';

/** Exhaustive finite-scenario robust minimax loss and regret, plus supplied-probability expectation. */
export function optimizeRobustScenarios(input) {
  assertExactKeys(input, ['decisions', 'scenarioProbabilities', 'losses'], 'robust scenarios');
  const decisions = dense(input.decisions, 'decisions', 2, 32).map((id, i) => assertToken(id, `decisions[${i}]`));
  if (new Set(decisions).size !== decisions.length) throw new TypeError('duplicate decision name');
  const probs = dense(input.scenarioProbabilities, 'scenarioProbabilities', 2, 32).map((p, i) => probability(p, `scenarioProbabilities[${i}]`));
  if (cmp(probs.reduce(add, ZERO), ONE) !== 0n) throw new TypeError('scenario probabilities must sum to one');
  const losses = dense(input.losses, 'losses', decisions.length, decisions.length).map((row, i) =>
    dense(row, `losses[${i}]`, probs.length, probs.length).map((loss, j) => fraction(BigInt(boundedInt(loss, `losses[${i}][${j}]`)))));
  const bestPerScenario = probs.map((_, s) => losses.reduce((best, row) => cmp(row[s], best) < 0n ? row[s] : best, losses[0][s]));
  const rows = decisions.map((decision, i) => {
    const worst = losses[i].reduce((best, value) => cmp(value, best) > 0n ? value : best);
    const regret = losses[i].map((value, s) => sub(value, bestPerScenario[s]));
    const maxRegret = regret.reduce((best, value) => cmp(value, best) > 0n ? value : best);
    const expected = probs.reduce((sum, p, s) => add(sum, mul(p, losses[i][s])), ZERO);
    return { decision, worstCaseLoss: asString(worst), expectedLoss: asString(expected),
      maximumRegret: asString(maxRegret), losses: losses[i].map(asString) };
  });
  function pick(field) { return rows.reduce((best, row) => cmp(field(row), field(best)) < 0n ? row : best, rows[0]).decision; }
  return { minimaxLossDecision: pick((r) => parse(r.worstCaseLoss)),
    minimaxRegretDecision: pick((r) => parse(r.maximumRegret)),
    minimumExpectedLossDecision: pick((r) => parse(r.expectedLoss)),
    byDecision: rows, evaluatedProfiles: decisions.length * probs.length,
    method: 'EXHAUSTIVE_FINITE_SCENARIO_RATIONAL',
    note: 'Scenario set and probabilities are supplied, not learned; no out-of-sample guarantee.' };
}
function parse(s) { const [n, d] = s.split('/').map(BigInt); return fraction(n, d); }
