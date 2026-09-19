import { assertArray, assertExactKeys, assertFiniteNumber } from '../core/common.mjs';

/** Conservative NTP four-timestamp clock-offset intervals (nonnegative one-way delays). */
export function synchronizeClockIntervals(input) {
  assertExactKeys(input, ['exchanges'], 'clock exchanges');
  const exchanges = assertArray(input.exchanges, 'exchanges', { min: 1, max: 10_000 });
  let low = -Infinity, high = Infinity;
  const receipts = exchanges.map((entry, i) => {
    assertExactKeys(entry, ['t1', 't2', 't3', 't4'], `exchange[${i}]`);
    const { t1, t2, t3, t4 } = entry;
    for (const k of ['t1', 't2', 't3', 't4']) assertFiniteNumber(entry[k], `exchange[${i}].${k}`);
    if (t4 < t1 || t3 < t2) throw new TypeError('timestamps must be ordered within each clock');
    const delay = (t4 - t1) - (t3 - t2);
    if (delay < -1e-10) throw new TypeError('negative inferred network delay');
    const lowerBound = t3 - t4, upperBound = t2 - t1;
    low = Math.max(low, lowerBound); high = Math.min(high, upperBound);
    return { offsetMidpoint: (lowerBound + upperBound) / 2, offsetLowerBound: lowerBound,
      offsetUpperBound: upperBound, networkDelay: Math.max(0, delay) };
  });
  if (low > high + 1e-10) return { offsetMidpoints: receipts.map(x => x.offsetMidpoint), status: 'INCONSISTENT', exchanges: receipts, compatibleOffset: null,
    note: 'A single constant clock offset cannot explain the exchanges with nonnegative path delays; drift or bad timestamps may be present.' };
  const midpoint = (low + high) / 2;
  return { status: 'CONSISTENT', offsetMidpoints: receipts.map(x => x.offsetMidpoint), exchanges: receipts, compatibleOffset: { lower: low, upper: high,
    midpoint, uncertaintyRadius: Math.max(0, (high - low) / 2) },
    method: 'FOUR_TIMESTAMP_NONNEGATIVE_DELAY_INTERVAL_INTERSECTION',
    note: 'Interval guarantee assumes constant offset during exchanges and nonnegative one-way delays; not a distributed consensus or authenticated time service.' };
}
