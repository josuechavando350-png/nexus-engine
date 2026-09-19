// Exact bounded rational arithmetic: never convert probabilities to binary floating point.
const LIMIT = 1_000_000_000n;
function gcd(a, b) {
  while (b !== 0n) [a, b] = [b, a % b];
  return a < 0n ? -a : a;
}
export function fraction(n, d = 1n) {
  if (d === 0n) throw new RangeError('zero denominator');
  if (d < 0n) { n = -n; d = -d; }
  const g = gcd(n, d);
  return Object.freeze({ n: n / g, d: d / g });
}
export const ZERO = fraction(0n);
export const ONE = fraction(1n);
export const add = (a, b) => fraction(a.n * b.d + b.n * a.d, a.d * b.d);
export const sub = (a, b) => fraction(a.n * b.d - b.n * a.d, a.d * b.d);
export const mul = (a, b) => fraction(a.n * b.n, a.d * b.d);
export const div = (a, b) => fraction(a.n * b.d, a.d * b.n);
export const complement = (a) => sub(ONE, a);
export const asString = (a) => `${a.n}/${a.d}`;
export function probability(value, label) {
  if (typeof value !== 'string' || !/^(?:0|[1-9][0-9]*)\/(?:[1-9][0-9]*)$/u.test(value)) {
    throw new TypeError(`${label} must be a nonnegative fraction string n/d`);
  }
  const [n, d] = value.split('/').map(BigInt);
  if (d > LIMIT || n > LIMIT || n > d) throw new RangeError(`${label} must be a probability with bounded numerator and denominator`);
  return fraction(n, d);
}
