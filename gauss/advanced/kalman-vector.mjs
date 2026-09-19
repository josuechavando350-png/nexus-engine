import { assertArray, assertExactKeys, assertFiniteNumber } from '../core/common.mjs';

function vec(x, n, name) {
  const a = assertArray(x, name, { min: n, max: n });
  return Array.from({ length: n }, (_, i) => {
    if (!Object.hasOwn(a, i)) throw new TypeError(`${name} must be dense`);
    return assertFiniteNumber(a[i], `${name}[${i}]`);
  });
}
function matrix(x, n, name) {
  const a = assertArray(x, name, { min: n, max: n });
  return Array.from({ length: n }, (_, i) => {
    if (!Object.hasOwn(a, i)) throw new TypeError(`${name} must be dense`);
    return vec(a[i], n, `${name}[${i}]`);
  });
}
const transpose = a => a[0].map((_, i) => a.map(row => row[i]));
const matmul = (a, b) => a.map(row => b[0].map((_, j) => row.reduce((s, x, k) => s + x * b[k][j], 0)));
const add = (a, b) => a.map((row, i) => row.map((v, j) => v + b[i][j]));
const identity = n => Array.from({ length: n }, (_, i) => Array.from({ length: n }, (_, j) => Number(i === j)));
const matvec = (a, x) => a.map(row => row.reduce((s, v, j) => s + v * x[j], 0));
// Semidefinite Cholesky: when a diagonal pivot is zero, its entire remaining column must vanish.
function assertPsd(a, label) {
  const n = a.length, lower = Array.from({ length: n }, () => Array(n).fill(0));
  for (let i = 0; i < n; i++) for (let j = 0; j <= i; j++) {
    if (Math.abs(a[i][j] - a[j][i]) > 1e-10 * Math.max(1, Math.abs(a[i][j]), Math.abs(a[j][i]))) throw new TypeError(`${label} must be symmetric`);
    let residual = a[i][j];
    for (let k = 0; k < j; k++) residual -= lower[i][k] * lower[j][k];
    const tol = 1e-11 * Math.max(1, Math.abs(a[i][i]), Math.abs(a[j][j]));
    if (i === j) {
      if (residual < -tol) throw new TypeError(`${label} must be positive semidefinite`);
      lower[i][j] = residual <= 0 ? 0 : Math.sqrt(residual);
    } else if (lower[j][j] === 0) {
      if (Math.abs(residual) > tol) throw new TypeError(`${label} must be positive semidefinite`);
    } else lower[i][j] = residual / lower[j][j];
  }
}
/** Higher-dimensional linear-Gaussian Kalman filter with Joseph covariance update. */
export function filterVectorKalman(input) {
  assertExactKeys(input, ['transition', 'processCovariance', 'measurementVector', 'measurementVariance', 'initialMean', 'initialCovariance', 'observations'], 'vector Kalman');
  const initialMean = assertArray(input.initialMean, 'initialMean', { min: 1, max: 8 });
  const n = initialMean.length;
  let mean = vec(initialMean, n, 'initialMean');
  let cov = matrix(input.initialCovariance, n, 'initialCovariance');
  const F = matrix(input.transition, n, 'transition');
  const Q = matrix(input.processCovariance, n, 'processCovariance');
  const H = vec(input.measurementVector, n, 'measurementVector');
  if (H.every(v => v === 0)) throw new TypeError('measurementVector cannot be zero');
  const R = assertFiniteNumber(input.measurementVariance, 'measurementVariance', { min: Number.MIN_VALUE });
  assertPsd(Q, 'processCovariance'); assertPsd(cov, 'initialCovariance');
  const observations = assertArray(input.observations, 'observations', { min: 1, max: 10_000 });
  const trace = [];
  let logLikelihood = 0;
  for (let t = 0; t < observations.length; t++) {
    const reading = observations[t];
    if (reading !== null) assertFiniteNumber(reading, `observations[${t}]`);
    mean = matvec(F, mean);
    cov = add(matmul(matmul(F, cov), transpose(F)), Q);
    if (reading === null) {
      trace.push({ mean: [...mean], covariance: cov.map(row => [...row]), observed: false, innovation: null, innovationVariance: null });
      continue;
    }
    const ph = matvec(cov, H);
    const innovationVariance = H.reduce((s, h, j) => s + h * ph[j], R);
    if (!(innovationVariance > 0) || !Number.isFinite(innovationVariance)) throw new RangeError('invalid innovation variance');
    const innovation = reading - H.reduce((s, h, j) => s + h * mean[j], 0);
    const K = ph.map(v => v / innovationVariance);
    mean = mean.map((v, j) => v + K[j] * innovation);
    const J = identity(n).map((row, i) => row.map((v, j) => v - K[i] * H[j]));
    // Joseph form resists cancellation and preserves symmetric PSD covariance.
    cov = add(matmul(matmul(J, cov), transpose(J)), K.map(ki => K.map(kj => ki * kj * R)));
    cov = cov.map((row, i) => row.map((v, j) => (v + cov[j][i]) / 2));
    logLikelihood += -0.5 * (Math.log(2 * Math.PI * innovationVariance) + innovation * innovation / innovationVariance);
    if (!Number.isFinite(logLikelihood) || mean.some(v => !Number.isFinite(v)) || cov.some(row => row.some(v => !Number.isFinite(v)))) throw new RangeError('numerical filter overflow');
    trace.push({ mean: [...mean], covariance: cov.map(row => [...row]), observed: true, innovation, innovationVariance });
  }
  return { mean, covariance: cov, trace, logLikelihood, stateDimension: n,
    method: 'LINEAR_GAUSSIAN_VECTOR_KALMAN_JOSEPH',
    note: 'Double-precision estimates conditional on supplied linear Gaussian model; not an empirical accuracy certificate.' };
}
