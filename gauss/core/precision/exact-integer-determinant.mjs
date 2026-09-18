// GAUSS-owned fraction-free Bareiss determinant. Only the Node.js BigInt runtime is used.
// Decimal JSON numbers are forbidden: integer strings prevent pre-rounded input.
const MAX_DIMENSION = 24;
const MAX_TOKEN_LENGTH = 256;
const MAX_INTERMEDIATE_BITS = 32_768;
const INTEGER = /^(?:0|-?[1-9]\d*)$/u;

function bounded(value) {
  if ((value < 0n ? -value : value).toString(2).length > MAX_INTERMEDIATE_BITS) {
    throw new RangeError('exact determinant intermediate exceeds computational budget');
  }
  return value;
}
function parseInteger(value, label) {
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) throw new TypeError(`${label} must not contain pre-rounded floats or unsafe integers`);
    value = String(value);
  }
  if (typeof value !== 'string' || value.length > MAX_TOKEN_LENGTH || !INTEGER.test(value)) {
    throw new TypeError(`${label} must be a bounded canonical integer string or safe integer`);
  }
  return bounded(BigInt(value));
}

export function exactIntegerDeterminant(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)
      || input.mode !== 'EXACT_INTEGER'
      || Object.keys(input).some(key => key !== 'mode' && key !== 'coefficients')) {
    throw new TypeError('exact determinant requires mode EXACT_INTEGER and only declared fields');
  }
  const matrix = input.coefficients;
  const n = matrix?.length;
  if (!Array.isArray(matrix) || !Number.isInteger(n) || n < 1 || n > MAX_DIMENSION) {
    throw new RangeError(`exact determinant requires a square matrix of 1..${MAX_DIMENSION} rows`);
  }
  const work = matrix.map((row, i) => {
    if (!Array.isArray(row) || row.length !== n) throw new TypeError('exact determinant requires a square matrix');
    return row.map((value, j) => parseInteger(value, `coefficients[${i}][${j}]`));
  });

  let sign = 1n;
  let previous = 1n;
  let pivotExchanges = 0;
  for (let k = 0; k < n - 1; k++) {
    let pivotRow = k;
    while (pivotRow < n && work[pivotRow][k] === 0n) pivotRow++;
    if (pivotRow === n) {
      return Object.freeze({ arithmetic: 'EXACT_INTEGER', determinant: '0', singular: true, pivotExchanges });
    }
    if (pivotRow !== k) {
      [work[k], work[pivotRow]] = [work[pivotRow], work[k]];
      sign = -sign;
      pivotExchanges++;
    }
    const pivot = work[k][k];
    for (let i = k + 1; i < n; i++) {
      for (let j = k + 1; j < n; j++) {
        const numerator = bounded(work[i][j] * pivot - work[i][k] * work[k][j]);
        if (numerator % previous !== 0n) throw new Error('Bareiss exact-division invariant failed');
        work[i][j] = bounded(numerator / previous);
      }
      work[i][k] = 0n;
    }
    previous = pivot;
  }
  const determinant = bounded(sign * work[n - 1][n - 1]);
  return Object.freeze({ arithmetic: 'EXACT_INTEGER', determinant: determinant.toString(),
    singular: determinant === 0n, pivotExchanges });
}
