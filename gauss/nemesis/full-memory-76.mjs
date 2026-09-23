/** Bounded power-law random walk with every historical increment available by default. */
import {object, number, integer} from './engine/src/motors/shared.mjs';
import {seeded} from './engine/src/motors/numerics.mjs';

export function simulateFullHistoryWalk(input) {
  object(input, 'full-history walk',
    ['steps', 'alpha', 'memoryWeight', 'seed', 'initial', 'horizon'],
    ['steps', 'alpha', 'memoryWeight']);
  const steps = integer(input.steps, 'steps', 1, 4096);
  const alpha = number(input.alpha, 'alpha', 0, 5);
  const memoryWeight = number(input.memoryWeight, 'memoryWeight', -1, 1);
  const horizon = integer(input.horizon ?? Math.max(1, steps - 1), 'horizon', 1, steps);
  const seed = integer(input.seed ?? 12, 'seed', 0, 4294967295);
  let x = number(input.initial ?? 0, 'initial', -1e12, 1e12);
  const maxLag = Math.min(horizon, steps - 1);
  const work = maxLag * (maxLag + 1) / 2 + (steps - 1 - maxLag) * maxLag;
  if (work > 2000000) throw new RangeError('full-history walk work budget exceeded');

  const weights = new Float64Array(maxLag);
  const weightSums = new Float64Array(maxLag + 1);
  for (let lag = 0; lag < maxLag; lag++) {
    weights[lag] = (lag + 1) ** (-alpha);
    weightSums[lag + 1] = weightSums[lag] + weights[lag];
  }
  const rng = seeded(seed);
  const increments = new Int8Array(steps);
  const positions = [x];
  const rightProbabilities = [];
  for (let t = 0; t < steps; t++) {
    const lookback = Math.min(t, maxLag);
    let history = 0;
    if (memoryWeight !== 0 && lookback > 0) {
      let weighted = 0;
      for (let lag = 0; lag < lookback; lag++)
        weighted += weights[lag] * increments[t - 1 - lag];
      history = weighted / weightSums[lookback];
    }
    const probability = Math.max(0, Math.min(1, (1 + memoryWeight * history) / 2));
    rightProbabilities.push(probability);
    const increment = rng() < probability ? 1 : -1;
    increments[t] = increment;
    x += increment;
    positions.push(x);
  }
  return {domain: 'BOUNDED_FULL_HISTORY_POWER_LAW_WALK', positions, rightProbabilities,
    lagExponent: alpha, memoryWeight, seed, maxLag, truncated: maxLag < steps - 1,
    limitations: 'Finite bounded random-walk simulation; no fitting or calibration to observed data.'};
}
