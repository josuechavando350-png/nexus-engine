import { assertArray, assertExactKeys, assertFiniteNumber } from './common.mjs';

// Entropic Value-at-Risk for a supplied finite, discrete loss distribution.
// Larger losses are worse. This is an uncertainty-sensitive statistic of the
// supplied distribution, not a calibrated bound on real-world outcomes.
// EVaR_alpha(X) = inf_{t>0} [log E exp(tX) - log(1-alpha)]/t.
// The finite-support solution is the largest mean under a KL budget of
// -log(1-alpha). We solve for the exponential tilt using monotone KL bisection.
export function discreteEntropicValueAtRisk({ outcomes, confidence }) {
  const alpha = assertFiniteNumber(confidence, 'confidence', { min: 0, max: 0.999999 });
  const rows = assertArray(outcomes, 'outcomes', { min: 1, max: 4096 }).map((row, index) => {
    assertExactKeys(row, ['loss', 'probability'], `outcomes[${index}]`);
    return {
      loss: assertFiniteNumber(row.loss, `outcomes[${index}].loss`, { min: -1e9, max: 1e9 }),
      probability: assertFiniteNumber(row.probability, `outcomes[${index}].probability`, { min: 0, max: 1 }),
    };
  });
  const probabilityMass = rows.reduce((sum, row) => sum + row.probability, 0);
  if (Math.abs(probabilityMass - 1) > 1e-12) throw new TypeError('outcome probabilities must sum to 1');
  const positive = rows.filter((row) => row.probability > 0)
    .map((row) => ({ loss: row.loss, probability: row.probability / probabilityMass }));
  const minLoss = positive.reduce((v, row) => Math.min(v, row.loss), Infinity);
  const maxLoss = positive.reduce((v, row) => Math.max(v, row.loss), -Infinity);
  const expectedLoss = positive.reduce((sum, row) => sum + row.probability * row.loss, 0);
  const tailProbability = 1 - alpha;
  const entropyBudget = -Math.log(tailProbability);
  const frame = (entropicValueAtRisk, achievedKLDivergence, solutionKind) => {
    if (![entropicValueAtRisk, expectedLoss, achievedKLDivergence].every(Number.isFinite)) {
      throw new TypeError('entropic risk calculation overflow');
    }
    return Object.freeze({ confidence: alpha, tailProbability, probabilityMass,
      expectedLoss, worstLoss: maxLoss, entropyBudget,
      achievedKLDivergence, entropicValueAtRisk, solutionKind });
  };
  if (alpha === 0) return frame(expectedLoss, 0, 'MEAN');
  if (minLoss === maxLoss) return frame(maxLoss, 0, 'CONSTANT');

  const topMass = positive.reduce((sum, row) => sum + (row.loss === maxLoss ? row.probability : 0), 0);
  // When the entropy budget admits conditioning exclusively on the worst
  // outcome, the supremum max loss is attained; no infinite tilt is emitted.
  if (topMass >= tailProbability) return frame(maxLoss, -Math.log(topMass), 'WORST_LOSS');

  const range = maxLoss - minLoss;
  const support = positive.map(({ loss, probability }) => ({
    gap: (maxLoss - loss) / range,
    logProbability: Math.log(probability),
  }));
  const tilted = (scaledTilt) => {
    let peak = -Infinity;
    for (const item of support) peak = Math.max(peak, item.logProbability - scaledTilt * item.gap);
    let partition = 0;
    let gapNumerator = 0;
    for (const item of support) {
      const weight = Math.exp(item.logProbability - scaledTilt * item.gap - peak);
      partition += weight;
      gapNumerator += weight * item.gap;
    }
    const meanGap = gapNumerator / partition;
    const logPartition = peak + Math.log(partition);
    return { meanGap, kl: -scaledTilt * meanGap - logPartition };
  };

  let lower = 0;
  let upper = 1;
  let atUpper = tilted(upper);
  // Bound the search; if the double-precision representation cannot resolve
  // the prescribed distribution, reject rather than invent a numerical PASS.
  for (let step = 0; atUpper.kl < entropyBudget && step < 1020; step += 1) {
    lower = upper;
    upper *= 2;
    if (!Number.isFinite(upper)) throw new TypeError('entropic risk tilt cannot be bracketed');
    atUpper = tilted(upper);
  }
  if (atUpper.kl < entropyBudget) throw new TypeError('entropic risk tilt cannot be bracketed');
  for (let step = 0; step < 180; step += 1) {
    const middle = lower + (upper - lower) / 2;
    if (middle === lower || middle === upper) break;
    if (tilted(middle).kl >= entropyBudget) upper = middle;
    else lower = middle;
  }
  const resolved = tilted(lower + (upper - lower) / 2);
  const value = maxLoss - range * resolved.meanGap;
  if (resolved.kl < entropyBudget - 1e-8 || resolved.kl > entropyBudget + 1e-8) {
    throw new TypeError('entropic risk KL solver did not converge');
  }
  if (value < expectedLoss - 1e-8 * Math.max(1, Math.abs(expectedLoss)) || value > maxLoss) {
    throw new TypeError('entropic risk violated the mean or maximum bound');
  }
  return frame(value, resolved.kl, 'EXPONENTIAL_TILT');
}
