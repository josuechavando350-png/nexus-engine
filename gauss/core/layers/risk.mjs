import { assertArray, assertExactKeys, assertFiniteNumber } from '../common.mjs';

// For an explicitly supplied discrete loss distribution, CVaR at confidence
// alpha is the mean loss in the worst (1-alpha) probability mass. Larger losses
// are worse; this is a descriptive risk statistic, not a forecast or guarantee.
export function discreteConditionalValueAtRisk({ outcomes, confidence }) {
  const alpha = assertFiniteNumber(confidence, 'confidence', { min: 0, max: 0.999999 });
  const rows = assertArray(outcomes, 'outcomes', { min: 1, max: 10_000 }).map((row, index) => {
    assertExactKeys(row, ['loss', 'probability'], `outcomes[${index}]`);
    return {
      loss: assertFiniteNumber(row.loss, `outcomes[${index}].loss`, { min: -1e12, max: 1e12 }),
      probability: assertFiniteNumber(row.probability, `outcomes[${index}].probability`, { min: 0, max: 1 }),
    };
  });
  const probabilityMass = rows.reduce((sum, row) => sum + row.probability, 0);
  if (Math.abs(probabilityMass - 1) > 1e-12) throw new TypeError('outcome probabilities must sum to 1');
  // Normalize acceptable floating-point round-off; zero-mass outcomes never
  // influence quantiles, including when confidence is exactly zero.
  const positive = rows.filter((row) => row.probability > 0)
    .map((row) => ({ loss: row.loss, probability: row.probability / probabilityMass }));
  const ascending = [...positive].sort((left, right) => left.loss - right.loss);
  let accumulated = 0;
  let valueAtRisk = ascending[ascending.length - 1].loss;
  for (const row of ascending) {
    accumulated += row.probability;
    if (accumulated >= alpha) {
      valueAtRisk = row.loss;
      break;
    }
  }
  const tailProbability = 1 - alpha;
  let remaining = tailProbability;
  let tailLoss = 0;
  for (const row of [...positive].sort((left, right) => right.loss - left.loss)) {
    if (remaining <= 0) break;
    const consumed = Math.min(row.probability, remaining);
    tailLoss += consumed * row.loss;
    remaining -= consumed;
  }
  if (remaining > 1e-12) throw new TypeError('unable to resolve the requested loss tail');
  const conditionalValueAtRisk = tailLoss / tailProbability;
  const expectedLoss = positive.reduce((sum, row) => sum + row.probability * row.loss, 0);
  if (![valueAtRisk, conditionalValueAtRisk, expectedLoss].every(Number.isFinite)) {
    throw new TypeError('loss risk calculation overflow');
  }
  return Object.freeze({ confidence: alpha, tailProbability, probabilityMass,
    valueAtRisk, conditionalValueAtRisk, expectedLoss });
}
