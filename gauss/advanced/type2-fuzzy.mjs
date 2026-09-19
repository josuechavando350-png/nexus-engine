import { assertArray, assertExactKeys, assertFiniteNumber } from '../core/common.mjs';

/** Karnik-Mendel endpoint type reduction for interval type-2 singleton consequents. */
export function reduceIntervalType2(input) {
  assertExactKeys(input, ['rules'], 'interval type-2 fuzzy input');
  const rules = assertArray(input.rules, 'rules', { min: 1, max: 1000 }).map((r, i) => {
    assertExactKeys(r, ['centroid', 'lower', 'upper'], `rules[${i}]`);
    const centroid = assertFiniteNumber(r.centroid, `rules[${i}].centroid`);
    const lower = assertFiniteNumber(r.lower, `rules[${i}].lower`, { min: 0, max: 1 });
    const upper = assertFiniteNumber(r.upper, `rules[${i}].upper`, { min: 0, max: 1 });
    if (lower > upper) throw new TypeError('lower membership exceeds upper membership');
    return { centroid, lower, upper };
  }).sort((a, b) => a.centroid - b.centroid);
  if (!rules.some(r => r.lower > 0)) throw new TypeError('at least one strictly positive lower firing strength is required');
  function endpoint(left) {
    let y = rules.reduce((s, r) => s + r.centroid * (r.lower + r.upper) / 2, 0)
      / rules.reduce((s, r) => s + (r.lower + r.upper) / 2, 0);
    let switchIndex = -2;
    for (let iteration = 1; iteration <= rules.length + 2; iteration++) {
      let k = -1;
      for (let j = 0; j < rules.length; j++) if (rules[j].centroid <= y) k = j;
      const total = rules.reduce((s, r, j) => s + (left ? (j <= k ? r.upper : r.lower) : (j <= k ? r.lower : r.upper)), 0);
      const weighted = rules.reduce((s, r, j) => s + r.centroid * (left ? (j <= k ? r.upper : r.lower) : (j <= k ? r.lower : r.upper)), 0);
      const next = weighted / total;
      if (!Number.isFinite(next)) throw new RangeError('invalid type-reduction endpoint');
      if (k === switchIndex || Math.abs(next - y) <= 1e-12 * Math.max(1, Math.abs(y))) return { value: next, iterations: iteration };
      switchIndex = k; y = next;
    }
    throw new Error('Karnik-Mendel iteration failed to converge');
  }
  const l = endpoint(true), r = endpoint(false);
  if (l.value > r.value + 1e-9) throw new Error('inconsistent type-2 interval');
  return { left: l.value, right: r.value, crisp: (l.value + r.value) / 2,
    iterations: { left: l.iterations, right: r.iterations },
    method: 'INTERVAL_TYPE2_KARNIK_MENDEL_CENTER_OF_SETS',
    note: 'Type-reduction of specified singleton consequents and independent interval firing strengths; not an unrestricted general type-2 fuzzy inference engine.' };
}
