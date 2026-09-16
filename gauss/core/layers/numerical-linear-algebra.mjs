// NEXUS-owned bounded numerical methods. These produce numerical approximations,
// not claims of exact real arithmetic. Ill-conditioned/unconverged problems fail.
const freeze = Object.freeze;
const finite = (value, name, limit = 1_000_000) => {
  if (typeof value !== 'number' || !Number.isFinite(value) || Math.abs(value) > limit)
    throw new TypeError(`${name} must be finite and bounded`);
  return value;
};
const integer = (value, name, min, max) => {
  if (!Number.isSafeInteger(value) || value < min || value > max)
    throw new TypeError(`${name} must be an integer in [${min},${max}]`);
  return value;
};
function matrix(input, label, maxRows = 32, maxCols = 32) {
  if (!Array.isArray(input) || !input.length || input.length > maxRows)
    throw new TypeError(`${label} must have 1..${maxRows} rows`);
  const width = input[0]?.length;
  if (!Number.isInteger(width) || width < 1 || width > maxCols)
    throw new TypeError(`${label} must have 1..${maxCols} columns`);
  return input.map((row, i) => {
    if (!Array.isArray(row) || row.length !== width) throw new TypeError(`${label} must be rectangular`);
    return row.map((value, j) => finite(value, `${label}[${i}][${j}]`));
  });
}
function vector(input, label, length, max = 1_000_000) {
  if (!Array.isArray(input) || input.length !== length) throw new TypeError(`${label} length mismatch`);
  return input.map((value, i) => finite(value, `${label}[${i}]`, max));
}
function square(input, label, max = 32) {
  const a = matrix(input, label, max, max);
  if (a.length !== a[0].length) throw new TypeError(`${label} must be square`);
  return a;
}
const identity = n => Array.from({ length: n }, (_, i) => Array.from({ length: n }, (_, j) => i === j ? 1 : 0));
const transpose = a => a[0].map((_, j) => a.map(row => row[j]));
const product = (a, b) => a.map(row => b[0].map((_, j) => row.reduce((s, x, k) => s + x * b[k][j], 0)));
const frozenMatrix = a => freeze(a.map(row => freeze(row)));
function finiteResult(values, label) {
  if (values.some(value => !Number.isFinite(value))) throw new Error(`${label} overflow`);
}
function normInfResidual(a, x, b) {
  return Math.max(...a.map((row, i) => Math.abs(row.reduce((s, value, j) => s + value * x[j], 0) - b[i])));
}
function eliminate(a, b = null) {
  const n = a.length;
  const work = a.map(row => [...row]);
  const rhs = b ? [...b] : null;
  let exchanges = 0;
  let logAbsDeterminant = 0;
  let determinantSign = 1;
  const scale = Math.max(1, ...a.flat().map(Math.abs));
  for (let k = 0; k < n; k += 1) {
    let pivot = k;
    for (let i = k + 1; i < n; i += 1) if (Math.abs(work[i][k]) > Math.abs(work[pivot][k])) pivot = i;
    if (Math.abs(work[pivot][k]) <= 1e-12 * scale)
      throw new RangeError('matrix is singular or numerically ill-conditioned');
    if (pivot !== k) {
      [work[k], work[pivot]] = [work[pivot], work[k]];
      if (rhs) [rhs[k], rhs[pivot]] = [rhs[pivot], rhs[k]];
      exchanges += 1;
    }
    const diagonal = work[k][k];
    logAbsDeterminant += Math.log(Math.abs(diagonal));
    determinantSign *= Math.sign(diagonal);
    for (let i = k + 1; i < n; i += 1) {
      const factor = work[i][k] / diagonal;
      work[i][k] = 0;
      for (let j = k + 1; j < n; j += 1) work[i][j] -= factor * work[k][j];
      if (rhs) rhs[i] -= factor * rhs[k];
    }
  }
  determinantSign *= exchanges % 2 ? -1 : 1;
  if (!Number.isFinite(logAbsDeterminant)) throw new Error('elimination determinant overflow');
  return { upper: work, rhs, exchanges, logAbsDeterminant, determinantSign };
}

export function gaussianLinearSolve({ coefficients, rhs }) {
  const a = square(coefficients, 'coefficients');
  const b = vector(rhs, 'rhs', a.length);
  const { upper, rhs: y, exchanges } = eliminate(a, b);
  const solution = Array(a.length).fill(0);
  for (let i = a.length - 1; i >= 0; i -= 1) {
    solution[i] = (y[i] - upper[i].slice(i + 1).reduce((s, v, k) => s + v * solution[i + 1 + k], 0)) / upper[i][i];
  }
  finiteResult(solution, 'linear solve');
  const residualInfinityNorm = normInfResidual(a, solution, b);
  const scale = 1 + Math.max(...b.map(Math.abs)) + Math.max(...a.flat().map(Math.abs)) * Math.max(...solution.map(Math.abs));
  if (!Number.isFinite(residualInfinityNorm) || residualInfinityNorm > 1e-8 * scale)
    throw new Error('linear solve residual invariant failed');
  return freeze({ solution: freeze(solution), residualInfinityNorm, pivotExchanges: exchanges });
}

export function pivotedLogDeterminant({ coefficients }) {
  const a = square(coefficients, 'coefficients', 24);
  const result = eliminate(a);
  return freeze({ sign: result.determinantSign, logAbsoluteDeterminant: result.logAbsDeterminant,
    pivotExchanges: result.exchanges });
}

function cholesky(a) {
  const n = a.length;
  const maximum = Math.max(1, ...a.flat().map(Math.abs));
  for (let i = 0; i < n; i += 1) for (let j = 0; j < i; j += 1)
    if (Math.abs(a[i][j] - a[j][i]) > 1e-12 * maximum) throw new TypeError('matrix must be symmetric');
  const lower = Array.from({ length: n }, () => Array(n).fill(0));
  for (let i = 0; i < n; i += 1) for (let j = 0; j <= i; j += 1) {
    let value = a[i][j];
    for (let k = 0; k < j; k += 1) value -= lower[i][k] * lower[j][k];
    if (i === j) {
      if (value <= 1e-12 * maximum) throw new RangeError('matrix must be numerically positive definite');
      lower[i][j] = Math.sqrt(value);
    } else lower[i][j] = value / lower[j][j];
  }
  return lower;
}

export function choleskyDecomposition({ coefficients }) {
  const a = square(coefficients, 'coefficients');
  const lower = cholesky(a);
  const reconstructed = product(lower, transpose(lower));
  const residualInfinityNorm = Math.max(...a.flatMap((row, i) => row.map((value, j) => Math.abs(value - reconstructed[i][j]))));
  if (!Number.isFinite(residualInfinityNorm) || residualInfinityNorm > 1e-8 * (1 + Math.max(...a.flat().map(Math.abs))))
    throw new Error('Cholesky reconstruction invariant failed');
  return freeze({ lower: frozenMatrix(lower), residualInfinityNorm });
}

export function conjugateGradientSolve({ coefficients, rhs, tolerance = 1e-10, maxIterations = 2048 }) {
  const a = square(coefficients, 'coefficients');
  cholesky(a); // Verify the SPD precondition before attempting the iterative solver.
  const b = vector(rhs, 'rhs', a.length);
  const tol = finite(tolerance, 'tolerance', 0.01);
  if (tol <= 0) throw new TypeError('tolerance must be positive');
  const limit = integer(maxIterations, 'maxIterations', 1, 2048);
  const x = Array(a.length).fill(0);
  let r = [...b], p = [...r], rr = r.reduce((s, v) => s + v * v, 0);
  let iterations = 0;
  const target = tol * (1 + Math.sqrt(rr));
  for (; iterations < limit && Math.sqrt(rr) > target; iterations += 1) {
    const ap = a.map(row => row.reduce((sum, value, j) => sum + value * p[j], 0));
    const pap = p.reduce((sum, value, i) => sum + value * ap[i], 0);
    if (!(pap > 0) || !Number.isFinite(pap)) throw new Error('conjugate gradient broke SPD invariant');
    const step = rr / pap;
    for (let j = 0; j < x.length; j += 1) { x[j] += step * p[j]; r[j] -= step * ap[j]; }
    const next = r.reduce((s, value) => s + value * value, 0);
    if (!Number.isFinite(next)) throw new Error('conjugate gradient numerical overflow');
    const beta = next / rr;
    p = r.map((value, j) => value + beta * p[j]);
    rr = next;
  }
  const residualInfinityNorm = normInfResidual(a, x, b);
  const bScale = 1 + Math.max(...b.map(Math.abs));
  if (!Number.isFinite(residualInfinityNorm) || residualInfinityNorm > 1e-7 * bScale || Math.sqrt(rr) > target)
    throw new Error('conjugate gradient did not converge to a verified solution');
  return freeze({ solution: freeze(x), iterations, residualInfinityNorm });
}

function qr(a) {
  const m = a.length, n = a[0].length;
  const r = a.map(row => [...row]), q = identity(m);
  for (let k = 0; k < n; k += 1) {
    let squared = 0;
    for (let i = k; i < m; i += 1) squared += r[i][k] ** 2;
    const length = Math.sqrt(squared);
    if (!(length > 1e-12) || !Number.isFinite(length)) throw new RangeError('QR rank deficient or ill-conditioned');
    const v = Array.from({ length: m - k }, (_, j) => r[j + k][k]);
    v[0] += r[k][k] >= 0 ? length : -length;
    const vLength = Math.hypot(...v);
    if (!(vLength > 0) || !Number.isFinite(vLength)) throw new Error('QR Householder normalization failed');
    for (let i = 0; i < v.length; i += 1) v[i] /= vLength;
    for (let j = k; j < n; j += 1) {
      let dot = 0;
      for (let i = 0; i < v.length; i += 1) dot += v[i] * r[k + i][j];
      for (let i = 0; i < v.length; i += 1) r[k + i][j] -= 2 * v[i] * dot;
    }
    for (let i = 0; i < m; i += 1) {
      let dot = 0;
      for (let j = 0; j < v.length; j += 1) dot += q[i][k + j] * v[j];
      for (let j = 0; j < v.length; j += 1) q[i][k + j] -= 2 * dot * v[j];
    }
  }
  const rebuilt = product(q, r), orthogonal = product(transpose(q), q);
  const maxA = Math.max(1, ...a.flat().map(Math.abs));
  const reconstruction = Math.max(...a.flatMap((row, i) => row.map((value, j) => Math.abs(rebuilt[i][j] - value))));
  const orthogonality = Math.max(...orthogonal.flatMap((row, i) => row.map((value, j) => Math.abs(value - (i === j ? 1 : 0)))));
  if (![reconstruction, orthogonality].every(Number.isFinite) || reconstruction > 1e-8 * maxA || orthogonality > 1e-8)
    throw new Error('QR factorization numerical invariants failed');
  return { q, r, reconstruction, orthogonality };
}

export function householderQrDecomposition({ coefficients }) {
  const a = matrix(coefficients, 'coefficients', 48, 16);
  if (a.length < a[0].length) throw new TypeError('QR requires rows >= columns');
  const result = qr(a);
  return freeze({ q: frozenMatrix(result.q), r: frozenMatrix(result.r),
    reconstructionInfinityNorm: result.reconstruction, orthogonalityInfinityNorm: result.orthogonality });
}

export function qrLeastSquaresSolve({ coefficients, rhs }) {
  const a = matrix(coefficients, 'coefficients', 48, 16);
  const m = a.length, n = a[0].length;
  if (m < n) throw new TypeError('least squares requires rows >= columns');
  const b = vector(rhs, 'rhs', m);
  const { q, r } = qr(a);
  const y = transpose(q).map(row => row.reduce((sum, value, j) => sum + value * b[j], 0));
  const x = Array(n).fill(0);
  for (let i = n - 1; i >= 0; i -= 1) {
    if (Math.abs(r[i][i]) < 1e-12) throw new RangeError('least-squares matrix is rank deficient');
    x[i] = (y[i] - r[i].slice(i + 1, n).reduce((sum, value, j) => sum + value * x[i + 1 + j], 0)) / r[i][i];
  }
  finiteResult(x, 'QR least squares');
  const squaredError = a.reduce((sum, row, i) => sum + (row.reduce((s, value, j) => s + value * x[j], 0) - b[i]) ** 2, 0);
  const gradient = transpose(a).map(row => row.reduce((sum, value, i) => sum + value * (a[i].reduce((s, v, j) => s + v * x[j], 0) - b[i]), 0));
  if (!Number.isFinite(squaredError) || gradient.some(value => !Number.isFinite(value))) throw new Error('QR least squares overflow');
  return freeze({ solution: freeze(x), squaredError, normalEquationResidualInfinityNorm: Math.max(...gradient.map(Math.abs)) });
}

export function radixTwoFourierTransform({ real, imaginary, inverse = false }) {
  if (typeof inverse !== 'boolean') throw new TypeError('inverse must be boolean');
  if (!Array.isArray(real) || !real.length || real.length > 1024 || (real.length & (real.length - 1)))
    throw new TypeError('FFT real input length must be a power of two in 1..1024');
  const n = real.length;
  const re = vector(real, 'real', n), im = vector(imaginary, 'imaginary', n);
  let j = 0;
  for (let i = 1; i < n; i += 1) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) { [re[i], re[j]] = [re[j], re[i]]; [im[i], im[j]] = [im[j], im[i]]; }
  }
  for (let size = 2; size <= n; size <<= 1) {
    const angle = (inverse ? 2 : -2) * Math.PI / size;
    for (let offset = 0; offset < n; offset += size) for (let k = 0; k < size / 2; k += 1) {
      const c = Math.cos(angle * k), s = Math.sin(angle * k);
      const u = offset + k, v = u + size / 2;
      const vr = re[v] * c - im[v] * s, vi = re[v] * s + im[v] * c;
      re[v] = re[u] - vr; im[v] = im[u] - vi;
      re[u] += vr; im[u] += vi;
    }
  }
  if (inverse) for (let i = 0; i < n; i += 1) { re[i] /= n; im[i] /= n; }
  finiteResult(re, 'FFT real'); finiteResult(im, 'FFT imaginary');
  return freeze({ real: freeze(re), imaginary: freeze(im), inverse });
}
