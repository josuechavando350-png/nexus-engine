import { object, array, integer, number } from './shared.mjs';

const T = A => A[0].map((_, i) => A.map(row => row[i]));
const mm = (A, B) => A.map(row => B[0].map((_, j) => row.reduce((s, a, k) => s + a * B[k][j], 0)));
const mv = (A, v) => A.map(row => row.reduce((s, a, k) => s + a * v[k], 0));
const add = (A, B) => A.map((row, i) => row.map((v, j) => v + B[i][j]));
const sub = (A, B) => A.map((row, i) => row.map((v, j) => v - B[i][j]));
const ident = n => Array.from({ length: n }, (_, i) => Array.from({ length: n }, (_, j) => +(i === j)));
const sym = A => A.map((row, i) => row.map((v, j) => (v + A[j][i]) / 2));
function vec(x, label, n) { return array(x, label, n, n).map((v, i) => number(v, `${label}[${i}]`, -1e6, 1e6)); }
function mat(x, label, r, c) {
  return array(x, label, r, r).map((row, i) => vec(row, `${label}[${i}]`, c));
}
function cholesky(A, label) {
  const n = A.length, L = Array.from({ length: n }, () => Array(n).fill(0));
  for (let i = 0; i < n; i++) for (let j = 0; j <= i; j++) {
    if (Math.abs(A[i][j] - A[j][i]) > 1e-8 * Math.max(1, Math.abs(A[i][j]), Math.abs(A[j][i]))) throw new TypeError(`${label} not symmetric`);
    let value = A[i][j];
    for (let k = 0; k < j; k++) value -= L[i][k] * L[j][k];
    if (i === j) {
      if (!(value > 1e-12) || !Number.isFinite(value)) throw new TypeError(`${label} not positive definite / ill-conditioned`);
      L[i][j] = Math.sqrt(value);
    } else L[i][j] = value / L[j][j];
  }
  return L;
}
function inverseSPD(A, label) {
  const L = cholesky(A, label), n = A.length, inverse = Array.from({ length: n }, () => Array(n).fill(0));
  for (let col = 0; col < n; col++) {
    const y = Array(n).fill(0), x = Array(n).fill(0);
    for (let i = 0; i < n; i++) {
      let s = +(i === col);
      for (let j = 0; j < i; j++) s -= L[i][j] * y[j];
      y[i] = s / L[i][i];
    }
    for (let i = n - 1; i >= 0; i--) {
      let s = y[i];
      for (let j = i + 1; j < n; j++) s -= L[j][i] * x[j];
      x[i] = s / L[i][i];
    }
    for (let i = 0; i < n; i++) inverse[i][col] = x[i];
  }
  return { inverse: sym(inverse), logDet: 2 * L.reduce((s, row, i) => s + Math.log(row[i]), 0) };
}
function validState(x, P, label) {
  if (x.some(v => !Number.isFinite(v)) || P.some(row => row.some(v => !Number.isFinite(v)))) throw new RangeError(`${label} diverged numerically`);
  cholesky(P, `${label}.covariance`);
  return { mean: x, covariance: P };
}
/** Multivariate linear-Gaussian filtering and fixed-interval Rauch–Tung–Striebel smoothing. */
export function smoothLinearGaussian(input) {
  object(input, 'Kalman RTS', ['F', 'H', 'Q', 'R', 'initialMean', 'initialCovariance', 'observations']);
  const n = array(input.initialMean, 'initialMean', 1, 6).length;
  const m = array(input.H, 'H', 1, 6).length;
  const F = mat(input.F, 'F', n, n), H = mat(input.H, 'H', m, n);
  const Q = mat(input.Q, 'Q', n, n), R = mat(input.R, 'R', m, m);
  const initialMean = vec(input.initialMean, 'initialMean', n);
  const initialCovariance = mat(input.initialCovariance, 'initialCovariance', n, n);
  cholesky(Q, 'Q'); cholesky(R, 'R'); cholesky(initialCovariance, 'initialCovariance');
  const obs = array(input.observations, 'observations', 1, 128).map((o, i) => o === null ? null : vec(o, `observations[${i}]`, m));
  const predicted = [], filtered = [], innovations = [];
  const Ft = T(F), Ht = T(H), I = ident(n);
  let prior = validState(initialMean, initialCovariance, 'initial'), logLikelihood = 0;
  for (let t = 0; t < obs.length; t++) {
    if (t > 0) prior = validState(mv(F, filtered[t - 1].mean), sym(add(mm(mm(F, filtered[t - 1].covariance), Ft), Q)), 'prediction');
    predicted.push(prior);
    if (obs[t] === null) { filtered.push(prior); innovations.push(null); continue; }
    const residual = obs[t].map((v, i) => v - mv(H, prior.mean)[i]);
    const S = sym(add(mm(mm(H, prior.covariance), Ht), R));
    const { inverse: Si, logDet } = inverseSPD(S, 'innovation covariance');
    const K = mm(mm(prior.covariance, Ht), Si);
    const dx = mv(K, residual);
    const x = prior.mean.map((v, i) => v + dx[i]);
    const IKH = sub(I, mm(K, H));
    const P = sym(add(mm(mm(IKH, prior.covariance), T(IKH)), mm(mm(K, R), T(K))));
    filtered.push(validState(x, P, 'filter'));
    const quad = residual.reduce((s, v, i) => s + v * mv(Si, residual)[i], 0);
    logLikelihood -= (m * Math.log(2 * Math.PI) + logDet + quad) / 2;
    innovations.push({ residual, covariance: S });
  }
  const smoothed = filtered.slice();
  for (let t = obs.length - 2; t >= 0; t--) {
    const J = mm(mm(filtered[t].covariance, Ft), inverseSPD(predicted[t + 1].covariance, 'predicted covariance').inverse);
    const difference = smoothed[t + 1].mean.map((v, i) => v - predicted[t + 1].mean[i]);
    const x = filtered[t].mean.map((v, i) => v + mv(J, difference)[i]);
    const P = sym(add(filtered[t].covariance, mm(mm(J, sub(smoothed[t + 1].covariance, predicted[t + 1].covariance)), T(J))));
    smoothed[t] = validState(x, P, 'smoother');
  }
  return { engine: 'NEMESIS_LINEAR_KALMAN_RTS_V1', dimension: n, observationDimension: m,
    timeSteps: obs.length, missingObservations: obs.filter(o => o === null).length, predicted, filtered, smoothed,
    innovations, logLikelihood, note: 'Fixed-interval linear Gaussian smoothing, not physical reversal of time or general nonlinear inference.' };
}
