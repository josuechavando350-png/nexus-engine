import { assertExactKeys, assertSafeInteger } from '../core/common.mjs';
import { dense } from './scientific-linear.mjs';

/** Empirical lag-one binary transfer entropy I(X_t;Y_{t+1}|Y_t) in bits. */
export function estimateBinaryTransferEntropy(input) {
  assertExactKeys(input, ['source', 'target'], 'transfer entropy input');
  const x = dense(input.source, 'source', 3, 100_000);
  const y = dense(input.target, 'target', x.length, x.length);
  for (let i = 0; i < x.length; i++) {
    assertSafeInteger(x[i], `source[${i}]`, { min: 0, max: 1 });
    assertSafeInteger(y[i], `target[${i}]`, { min: 0, max: 1 });
  }
  const triples = Array(8).fill(0), byY = [0, 0], byXY = Array(4).fill(0), byYNext = Array(4).fill(0);
  for (let i = 0; i < x.length - 1; i++) {
    const xp = x[i], yp = y[i], yn = y[i + 1];
    triples[xp * 4 + yp * 2 + yn]++;
    byY[yp]++; byXY[xp * 2 + yp]++; byYNext[yp * 2 + yn]++;
  }
  const n = x.length - 1;
  let bits = 0;
  for (let xp = 0; xp < 2; xp++) for (let yp = 0; yp < 2; yp++) for (let yn = 0; yn < 2; yn++) {
    const c = triples[xp * 4 + yp * 2 + yn];
    if (!c) continue; // 0 log 0 = 0. All conditioning cells here have nonzero mass.
    bits += c / n * Math.log2((c * byY[yp]) / (byXY[xp * 2 + yp] * byYNext[yp * 2 + yn]));
  }
  if (!Number.isFinite(bits) || bits < -1e-10) throw new Error('conditional mutual information invariant violated');
  return { bits: Math.max(0, bits), effectiveSamples: n, tripleCounts: triples,
    estimator: 'EMPIRICAL_DISCRETE_CONDITIONAL_MUTUAL_INFORMATION',
    note: 'Lag-one empirical transfer entropy on supplied binary series; no causality, bias-correction or out-of-sample prediction is claimed.' };
}
