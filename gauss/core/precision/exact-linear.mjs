// NEXUS-owned exact rational linear algebra. No non-Node runtime dependency.
// Inputs are strings (or safe integers), never pre-rounded floating point values.
const MAX_DIMENSION = 12;
const MAX_TOKEN_LENGTH = 512;
const MAX_EXPONENT = 256;
const MAX_INTERMEDIATE_BITS = 32_768;
const MAX_DECIMAL_PLACES = 4_096;
const ZERO = Object.freeze({ n: 0n, d: 1n });
function abs(n) { return n < 0n ? -n : n; }
function gcd(a, b) {
  a = abs(a); b = abs(b);
  while (b !== 0n) [a, b] = [b, a % b];
  return a;
}
function assertBoundedInteger(value) {
  if (value.toString(16).length * 4 > MAX_INTERMEDIATE_BITS) {
    throw new RangeError('exact rational intermediate exceeds the computational budget');
  }
}
function fraction(n, d) {
  if (d === 0n) throw new RangeError('zero rational denominator');
  if (n === 0n) return ZERO;
  if (d < 0n) { n = -n; d = -d; }
  const common = gcd(n, d);
  n /= common; d /= common;
  assertBoundedInteger(n); assertBoundedInteger(d);
  return Object.freeze({ n, d });
}
function add(a, b) {
  if (a.n === 0n) return b;
  if (b.n === 0n) return a;
  const common = gcd(a.d, b.d);
  return fraction(a.n * (b.d / common) + b.n * (a.d / common), (a.d / common) * b.d);
}
function neg(a) { return a.n === 0n ? ZERO : Object.freeze({ n: -a.n, d: a.d }); }
function sub(a, b) { return add(a, neg(b)); }
function mul(a, b) {
  if (a.n === 0n || b.n === 0n) return ZERO;
  const p = gcd(a.n, b.d), q = gcd(b.n, a.d);
  return fraction((a.n / p) * (b.n / q), (a.d / q) * (b.d / p));
}
function div(a, b) {
  if (b.n === 0n) throw new RangeError('division by zero');
  if (a.n === 0n) return ZERO;
  return mul(a, fraction(b.d, b.n));
}
function parseScalar(value, label) {
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) throw new TypeError(`${label} must be a string or safe integer; floats lose precision before GAUSS`);
    value = String(value);
  }
  if (typeof value !== 'string' || value.length < 1 || value.length > MAX_TOKEN_LENGTH || value.trim() !== value) {
    throw new TypeError(`${label} must be a bounded canonical decimal or rational string`);
  }
  const rational = /^(-?(?:0|[1-9]\d*))\/([1-9]\d*)$/u.exec(value);
  if (rational) return fraction(BigInt(rational[1]), BigInt(rational[2]));
  const decimal = /^(-?)(0|[1-9]\d*)(?:\.(\d+))?(?:[eE]([+-]?\d{1,3}))?$/u.exec(value);
  if (!decimal) throw new TypeError(`${label} must be a canonical decimal or rational string`);
  const exponent = decimal[4] === undefined ? 0 : Number(decimal[4]);
  if (Math.abs(exponent) > MAX_EXPONENT) throw new RangeError(`${label} decimal exponent exceeds the computational budget`);
  const fractionalDigits = decimal[3] ?? '';
  let n = BigInt(decimal[2] + fractionalDigits);
  if (decimal[1] === '-') n = -n;
  const shift = exponent - fractionalDigits.length;
  return shift >= 0 ? fraction(n * 10n ** BigInt(shift), 1n) : fraction(n, 10n ** BigInt(-shift));
}
function validateInput(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new TypeError('exact linear input must be an object');
  const accepted = new Set(['mode', 'coefficients', 'rhs', 'decimalPlaces']);
  if (Object.keys(input).some(key => !accepted.has(key)) || input.mode !== 'EXACT_RATIONAL') {
    throw new TypeError('exact linear input requires mode EXACT_RATIONAL and only declared fields');
  }
  const n = input.coefficients?.length;
  if (!Array.isArray(input.coefficients) || !Number.isInteger(n) || n < 1 || n > MAX_DIMENSION) {
    throw new RangeError(`exact linear coefficients must have 1..${MAX_DIMENSION} rows`);
  }
  if (!Array.isArray(input.rhs) || input.rhs.length !== n) throw new TypeError('exact linear rhs length mismatch');
  const decimalPlaces = input.decimalPlaces ?? 64;
  if (!Number.isSafeInteger(decimalPlaces) || decimalPlaces < 0 || decimalPlaces > MAX_DECIMAL_PLACES) {
    throw new RangeError(`decimalPlaces must be an integer in 0..${MAX_DECIMAL_PLACES}`);
  }
  const a = input.coefficients.map((row, i) => {
    if (!Array.isArray(row) || row.length !== n) throw new TypeError('exact linear coefficients must be square');
    return row.map((value, j) => parseScalar(value, `coefficients[${i}][${j}]`));
  });
  const b = input.rhs.map((value, i) => parseScalar(value, `rhs[${i}]`));
  return { a, b, n, decimalPlaces };
}
function decimalWithProof(value, decimalPlaces) {
  const scale = 10n ** BigInt(decimalPlaces);
  const scaled = abs(value.n) * scale;
  let q = scaled / value.d;
  const remainder = scaled % value.d;
  const twiceRemainder = 2n * remainder;
  if (twiceRemainder > value.d || (twiceRemainder === value.d && q % 2n !== 0n)) q += 1n;
  const digits = q.toString().padStart(decimalPlaces + 1, '0');
  const magnitude = decimalPlaces === 0 ? digits : `${digits.slice(0, -decimalPlaces)}.${digits.slice(-decimalPlaces)}`;
  const decimal = value.n < 0n && q !== 0n ? `-${magnitude}` : magnitude;
  const error = fraction(abs(scaled - q * value.d), value.d * scale);
  if (error.n * 2n * scale > error.d) throw new Error('exact decimal rounding bound violated');
  return Object.freeze({
    numerator: value.n.toString(), denominator: value.d.toString(), decimal,
    absoluteError: Object.freeze({ numerator: error.n.toString(), denominator: error.d.toString() }),
  });
}
export function solveExactLinearSystem(input) {
  const { a, b, n, decimalPlaces } = validateInput(input);
  const work = a.map((row, i) => [...row, b[i]]);
  let pivotExchanges = 0;
  for (let k = 0; k < n; k++) {
    let pivot = k;
    while (pivot < n && work[pivot][k].n === 0n) pivot++;
    if (pivot === n) throw new RangeError('exact linear system is singular: no unique solution');
    if (pivot !== k) { [work[k], work[pivot]] = [work[pivot], work[k]]; pivotExchanges++; }
    for (let i = k + 1; i < n; i++) {
      if (work[i][k].n === 0n) continue;
      const factor = div(work[i][k], work[k][k]);
      work[i][k] = ZERO;
      for (let j = k + 1; j <= n; j++) work[i][j] = sub(work[i][j], mul(factor, work[k][j]));
    }
  }
  const solution = Array(n).fill(ZERO);
  for (let i = n - 1; i >= 0; i--) {
    let rhs = work[i][n];
    for (let j = i + 1; j < n; j++) rhs = sub(rhs, mul(work[i][j], solution[j]));
    solution[i] = div(rhs, work[i][i]);
  }
  // A second, exact residual calculation is mandatory, not a floating-point tolerance.
  for (let i = 0; i < n; i++) {
    let sum = ZERO;
    for (let j = 0; j < n; j++) sum = add(sum, mul(a[i][j], solution[j]));
    if (sub(sum, b[i]).n !== 0n) throw new Error('exact residual verification failed');
  }
  return Object.freeze({
    arithmetic: 'EXACT_RATIONAL', decimalPlaces,
    solution: Object.freeze(solution.map(value => decimalWithProof(value, decimalPlaces))),
    exactResidualVerified: true, pivotExchanges,
  });
}
