// Exact integer-polynomial resultant via a bounded Sylvester matrix and Bareiss elimination.
// Coefficients are in ascending degree order; outputs are decimal strings (never floats).
const DECIMAL = /^-?(?:0|[1-9][0-9]*)$/u;
const MAX_DIGITS = 40;
const MAX_INTERMEDIATE_DIGITS = 4096;

function coefficients(value, name) {
  if (!Array.isArray(value) || value.length < 2 || value.length > 7) {
    throw new RangeError(`${name} must have degree 1..6`);
  }
  const result = value.map((entry, index) => {
    const label = `${name}[${index}]`;
    if (typeof entry === 'number' && !Number.isSafeInteger(entry)) {
      throw new TypeError(`${label} must be an exact integer`);
    }
    if (typeof entry !== 'string' && typeof entry !== 'number') {
      throw new TypeError(`${label} must be an integer or decimal integer string`);
    }
    const text = String(entry);
    if (!DECIMAL.test(text) || text.replace(/^-/, '').length > MAX_DIGITS || text === '-0') {
      throw new RangeError(`${label} must be a canonical decimal integer of at most ${MAX_DIGITS} digits`);
    }
    return BigInt(text);
  });
  if (result.at(-1) === 0n) throw new RangeError(`${name} leading coefficient must be nonzero`);
  return result;
}

function determinantBareiss(matrix) {
  const size = matrix.length;
  const a = matrix.map((row) => [...row]);
  let sign = 1n;
  let previousPivot = 1n;
  for (let k = 0; k < size - 1; k += 1) {
    let pivotRow = k;
    while (pivotRow < size && a[pivotRow][k] === 0n) pivotRow += 1;
    if (pivotRow === size) return 0n;
    if (pivotRow !== k) {
      [a[k], a[pivotRow]] = [a[pivotRow], a[k]];
      sign = -sign;
    }
    const pivot = a[k][k];
    for (let i = k + 1; i < size; i += 1) {
      for (let j = k + 1; j < size; j += 1) {
        const numerator = pivot * a[i][j] - a[i][k] * a[k][j];
        if (numerator % previousPivot !== 0n) throw new Error('Bareiss division was not exact');
        const quotient = numerator / previousPivot;
        if (quotient.toString().replace(/^-/, '').length > MAX_INTERMEDIATE_DIGITS) {
          throw new RangeError('polynomial resultant intermediate exceeds budget');
        }
        a[i][j] = quotient;
      }
      a[i][k] = 0n;
    }
    previousPivot = pivot;
  }
  return sign * a[size - 1][size - 1];
}

export function exactIntegerPolynomialResultant({ left, right } = {}) {
  const f = coefficients(left, 'left');
  const g = coefficients(right, 'right');
  const m = f.length - 1;
  const n = g.length - 1;
  const size = m + n;
  const matrix = Array.from({ length: size }, () => Array(size).fill(0n));
  const descendingF = [...f].reverse();
  const descendingG = [...g].reverse();
  for (let row = 0; row < n; row += 1) {
    for (let j = 0; j <= m; j += 1) matrix[row][row + j] = descendingF[j];
  }
  for (let row = 0; row < m; row += 1) {
    for (let j = 0; j <= n; j += 1) matrix[n + row][row + j] = descendingG[j];
  }
  const resultant = determinantBareiss(matrix);
  return Object.freeze({
    arithmetic: 'EXACT_INTEGER',
    degrees: Object.freeze([m, n]),
    resultant: resultant.toString(),
    commonComplexRoot: resultant === 0n,
  });
}
