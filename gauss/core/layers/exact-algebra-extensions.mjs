// Two bounded, distinct exact algebra operators. Native BigInt only; no math packages.
const INTEGER = /^(?:0|-?[1-9]\d*)$/u;
const MAX_TOKEN = 128;
const MAX_CRT_BITS = 4096;
const mod = (value, modulus) => ((value % modulus) + modulus) % modulus;

function parseInteger(value, name) {
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) throw new TypeError(`${name} must not be pre-rounded or fractional`);
    value = String(value);
  }
  if (typeof value !== 'string' || value.length > MAX_TOKEN || !INTEGER.test(value)) {
    throw new TypeError(`${name} must be a bounded canonical integer string or safe integer`);
  }
  return BigInt(value);
}
function keysExactly(value, expected, name) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)
      || Object.keys(value).length !== expected.length
      || expected.some(key => !Object.hasOwn(value, key))) {
    throw new TypeError(`${name} requires exactly ${expected.join(', ')}`);
  }
}
function extendedGcd(a, b) {
  let oldR = a, r = b, oldS = 1n, s = 0n;
  while (r !== 0n) {
    const q = oldR / r;
    [oldR, r] = [r, oldR - q * r];
    [oldS, s] = [s, oldS - q * s];
  }
  return oldR >= 0n ? [oldR, oldS] : [-oldR, -oldS];
}

// Unlike CRT_COPRIME.012, supports shared factors and reports inconsistent systems.
export function generalizedChineseRemainder(input) {
  keysExactly(input, ['congruences'], 'generalized CRT input');
  const congruences = input.congruences;
  if (!Array.isArray(congruences) || congruences.length < 1 || congruences.length > 16) {
    throw new RangeError('generalized CRT requires 1..16 congruences');
  }
  // Validate all entries before checking consistency: a contradiction must not mask malformed input.
  const entries = congruences.map((item, index) => {
    keysExactly(item, ['remainder', 'modulus'], `congruences[${index}]`);
    const m = parseInteger(item.modulus, `congruences[${index}].modulus`);
    if (m < 1n) throw new RangeError('CRT moduli must be positive');
    return [mod(parseInteger(item.remainder, `congruences[${index}].remainder`), m), m];
  });
  let remainder = 0n, modulus = 1n;
  for (const [r, m] of entries) {
    const [gcd, bezout] = extendedGcd(modulus, m);
    const difference = r - remainder;
    if (difference % gcd !== 0n) {
      return Object.freeze({ consistent: false, remainder: null, modulus: null });
    }
    const reducedModulus = m / gcd;
    const shift = reducedModulus === 1n ? 0n : mod((difference / gcd) * bezout, reducedModulus);
    const combined = modulus * reducedModulus;
    if (combined.toString(2).length > MAX_CRT_BITS) {
      throw new RangeError('CRT combined modulus exceeds computational budget');
    }
    remainder = mod(remainder + modulus * shift, combined);
    modulus = combined;
  }
  return Object.freeze({ consistent: true, remainder: remainder.toString(), modulus: modulus.toString() });
}

function isPrime(value) {
  if (!Number.isSafeInteger(value) || value < 2 || value > 65_521) return false;
  for (let divisor = 2; divisor * divisor <= value; divisor++) {
    if (value % divisor === 0) return false;
  }
  return true;
}
function powMod(base, exponent, prime) {
  let power = base, result = 1;
  for (let k = exponent; k > 0; k = Math.floor(k / 2)) {
    if (k % 2 !== 0) result = (result * power) % prime;
    power = (power * power) % prime;
  }
  return result;
}
const modNumber = (value, prime) => ((value % prime) + prime) % prime;

// Inverts an entire matrix over a prime finite field (not the existing scalar modular inverse).
export function finiteFieldMatrixInverse(input) {
  keysExactly(input, ['prime', 'coefficients'], 'finite-field matrix inverse input');
  const { prime, coefficients } = input;
  if (!isPrime(prime)) throw new RangeError('finite-field matrix requires a prime in 2..65521');
  const n = coefficients?.length;
  if (!Array.isArray(coefficients) || !Number.isInteger(n) || n < 1 || n > 12) {
    throw new RangeError('finite-field matrix requires 1..12 square rows');
  }
  const left = coefficients.map((row, i) => {
    if (!Array.isArray(row) || row.length !== n) throw new TypeError('finite-field matrix must be square');
    return row.map((entry, j) => {
      if (!Number.isSafeInteger(entry) || Math.abs(entry) > 1_000_000_000) {
        throw new TypeError(`coefficients[${i}][${j}] must be a bounded safe integer`);
      }
      return modNumber(entry, prime);
    });
  });
  const inverse = Array.from({ length: n }, (_, i) => Array.from({ length: n }, (_, j) => Number(i === j)));
  for (let pivot = 0; pivot < n; pivot++) {
    let selected = pivot;
    while (selected < n && left[selected][pivot] === 0) selected++;
    if (selected === n) return Object.freeze({ fieldPrime: prime, invertible: false, inverse: null });
    if (selected !== pivot) {
      [left[pivot], left[selected]] = [left[selected], left[pivot]];
      [inverse[pivot], inverse[selected]] = [inverse[selected], inverse[pivot]];
    }
    // The field is prime: nonzero pivot^(p-2) is its multiplicative inverse.
    const factor = powMod(left[pivot][pivot], prime - 2, prime);
    for (let col = 0; col < n; col++) {
      left[pivot][col] = left[pivot][col] * factor % prime;
      inverse[pivot][col] = inverse[pivot][col] * factor % prime;
    }
    for (let row = 0; row < n; row++) {
      if (row === pivot) continue;
      const multiple = left[row][pivot];
      if (multiple === 0) continue;
      for (let col = 0; col < n; col++) {
        left[row][col] = modNumber(left[row][col] - multiple * left[pivot][col], prime);
        inverse[row][col] = modNumber(inverse[row][col] - multiple * inverse[pivot][col], prime);
      }
    }
  }
  return Object.freeze({ fieldPrime: prime, invertible: true,
    inverse: Object.freeze(inverse.map(row => Object.freeze(row))) });
}
