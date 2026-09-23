/** Validation primitives shared by the independent bounded mathematical engines. */
export function object(value, name, keys, required = keys) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new TypeError(`${name} must be an object`);
  for (const key of Object.keys(value)) if (!keys.includes(key)) throw new TypeError(`${name} unknown field ${key}`);
  for (const key of required) if (!Object.hasOwn(value, key)) throw new TypeError(`${name} missing ${key}`);
  return value;
}
export function array(value, name, min, max) {
  if (!Array.isArray(value) || value.length < min || value.length > max) throw new TypeError(`${name} must have ${min}..${max} entries`);
  return value;
}
export function id(value, name) {
  if (typeof value !== 'string' || !/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(value)) throw new TypeError(`${name} must be identifier`);
  return value;
}
export function integer(value, name, min, max) {
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new TypeError(`${name} must be safe integer ${min}..${max}`);
  return value;
}
export function number(value, name, min = -Infinity, max = Infinity) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) throw new TypeError(`${name} invalid finite number`);
  return value;
}
export function unique(values, name) {
  if (new Set(values).size !== values.length) throw new TypeError(`${name} contains duplicates`);
  return values;
}
export function gcd(a, b) { while (b) [a, b] = [b, a % b]; return a < 0n ? -a : a; }
export function rat(n, d = 1n) {
  if (d === 0n) throw new TypeError('zero denominator');
  if (d < 0n) { n = -n; d = -d; }
  const g = gcd(n, d);
  return [n / g, d / g];
}
export function rational(value, name, { probability = false } = {}) {
  if (typeof value !== 'string' || !/^-?(0|[1-9][0-9]{0,8})(?:\/[1-9][0-9]{0,8})?$/.test(value)) throw new TypeError(`${name} must be bounded canonical rational string`);
  const [a, b = '1'] = value.split('/');
  const r = rat(BigInt(a), BigInt(b));
  if (probability && (r[0] < 0n || r[0] > r[1])) throw new TypeError(`${name} is not a probability`);
  return r;
}
export const add = (x, y) => rat(x[0] * y[1] + y[0] * x[1], x[1] * y[1]);
export const sub = (x, y) => rat(x[0] * y[1] - y[0] * x[1], x[1] * y[1]);
export const mul = (x, y) => rat(x[0] * y[0], x[1] * y[1]);
export const div = (x, y) => { if (!y[0]) throw new TypeError('division by zero'); return rat(x[0] * y[1], x[1] * y[0]); };
export const cmp = (x, y) => x[0] * y[1] < y[0] * x[1] ? -1 : x[0] * y[1] > y[0] * x[1] ? 1 : 0;
export const fmt = x => `${x[0]}/${x[1]}`;
export const ZERO = [0n, 1n];
export const ONE = [1n, 1n];
