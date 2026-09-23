/** MF-DFA of a finite scalar series. No calibrated confidence intervals are inferred from one trace. */
const sum = values => values.reduce((total, value) => total + value, 0);

function checkedArray(value, name, min, max) {
  if (!Array.isArray(value) || value.length < min || value.length > max)
    throw new TypeError(`${name} must contain ${min}..${max} values`);
  return value;
}
function finite(value, name, min = -Infinity, max = Infinity) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max)
    throw new TypeError(`${name} must be a finite number in range`);
  return value;
}
function unique(values, name) {
  if (new Set(values).size !== values.length) throw new TypeError(`${name} contains duplicates`);
  return values;
}
function logMeanExp(values) {
  const max = Math.max(...values);
  if (max === -Infinity) return -Infinity;
  return max + Math.log(sum(values.map(value => Math.exp(value - max))) / values.length);
}
function fitLogScaling(scales, logFluctuations) {
  if (logFluctuations.some(value => !Number.isFinite(value))) return {exponent: null, rSquared: null};
  const xs = scales.map(Math.log);
  const xMean = sum(xs) / xs.length;
  const yMean = sum(logFluctuations) / xs.length;
  const xx = sum(xs.map(value => (value - xMean) ** 2));
  if (!(xx > 0)) throw new TypeError('scales cannot determine a slope');
  const exponent = sum(xs.map((value, index) => (value - xMean) * (logFluctuations[index] - yMean))) / xx;
  const residual = sum(xs.map((value, index) => (logFluctuations[index] - yMean - exponent * (value - xMean)) ** 2));
  const total = sum(logFluctuations.map(value => (value - yMean) ** 2));
  return {exponent, rSquared: total === 0 ? 1 : Math.max(0, Math.min(1, 1 - residual / total))};
}

/**
 * Standard double-ended MF-DFA: integrate centered samples, detrend each window with
 * degree 1 or 2 least squares, and fit log F_q(s) against log s. q=0 uses the
 * geometric limit. Small/zero variances cannot support nonpositive moments.
 */
export function multifractalDFA(input) {
  if (input === null || typeof input !== 'object' || Array.isArray(input))
    throw new TypeError('MF-DFA input must be an object');
  for (const key of Object.keys(input))
    if (!['series', 'scales', 'moments', 'order'].includes(key)) throw new TypeError(`MF-DFA unknown field ${key}`);
  const series = checkedArray(input.series, 'series', 32, 200000)
    .map((value, index) => finite(value, `series[${index}]`, -1e12, 1e12));
  const order = input.order === undefined ? 1 : input.order;
  if (!Number.isInteger(order) || ![1, 2].includes(order)) throw new TypeError('order must be 1 or 2');
  const scales = unique(checkedArray(input.scales, 'scales', 3, 30).map((value, index) => {
    if (!Number.isSafeInteger(value) || value < order + 3 || value > Math.floor(series.length / 4))
      throw new TypeError(`scales[${index}] requires at least four complete windows and polynomial degrees of freedom`);
    return value;
  }), 'scales');
  const moments = unique(checkedArray(input.moments ?? [-4, -2, 0, 2, 4], 'moments', 1, 17)
    .map((value, index) => finite(value, `moments[${index}]`, -8, 8)), 'moments');

  // Kahan summation reduces drift when a small signal rides on a large offset.
  let total = 0, compensation = 0;
  for (const value of series) {
    const next = value - compensation, updated = total + next;
    compensation = (updated - total) - next;
    total = updated;
  }
  const mean = total / series.length;
  const profile = new Float64Array(series.length);
  let integrated = 0;
  for (let i = 0; i < series.length; i++) profile[i] = integrated += series[i] - mean;

  const windows = scales.map(scale => {
    const half = (scale - 1) / 2;
    const norm = scale;
    const t2mean = (scale * scale - 1) / (12 * norm * norm);
    const t2den = (scale * scale - 1) / (12 * norm * norm) * scale;
    let quadraticDen = 0;
    if (order === 2) for (let j = 0; j < scale; j++) {
      const t = (j - half) / norm;
      quadraticDen += (t * t - t2mean) ** 2;
    }
    const variances = [];
    const nWindows = Math.floor(profile.length / scale);
    for (let side = 0; side < 2; side++) for (let block = 0; block < nWindows; block++) {
      const offset = side === 0 ? block * scale : profile.length - (block + 1) * scale;
      let meanY = 0;
      for (let j = 0; j < scale; j++) meanY += profile[offset + j];
      meanY /= scale;
      let linear = 0, quadratic = 0;
      for (let j = 0; j < scale; j++) {
        const t = (j - half) / norm;
        const centered = profile[offset + j] - meanY;
        linear += t * centered;
        if (order === 2) quadratic += (t * t - t2mean) * centered;
      }
      linear /= t2den;
      if (order === 2) quadratic /= quadraticDen;
      let squared = 0;
      for (let j = 0; j < scale; j++) {
        const t = (j - half) / norm;
        const residual = profile[offset + j] - meanY - linear * t - (order === 2 ? quadratic * (t * t - t2mean) : 0);
        squared += residual * residual;
      }
      const variance = squared / scale;
      if (!Number.isFinite(variance)) throw new RangeError('MF-DFA variance overflow');
      variances.push(variance);
    }
    return {scale, variances};
  });

  const curves = moments.map(q => {
    const fluctuations = windows.map(({scale, variances}) => {
      if (q <= 0 && variances.some(value => value === 0))
        throw new RangeError(`MF-DFA zero window variance at scale ${scale}: moment ${q} is undefined`);
      const logFluctuation = q === 0
        ? sum(variances.map(value => Math.log(value))) / (2 * variances.length)
        : logMeanExp(variances.map(value => value === 0 ? -Infinity : (q / 2) * Math.log(value))) / q;
      return {scale, fluctuation: Math.exp(logFluctuation), windows: variances.length, logFluctuation};
    });
    const fit = fitLogScaling(scales, fluctuations.map(value => value.logFluctuation));
    return {q, scalingExponent: fit.exponent, rSquared: fit.rSquared,
      massExponent: fit.exponent === null ? null : q * fit.exponent - 1,
      fluctuations: fluctuations.map(({scale, fluctuation, windows: count}) => ({scale, fluctuation, windows: count}))};
  });
  // Legendre spectrum requires adjacent q estimates; it is descriptive, not a proof of multifractality.
  const ascending = [...curves].sort((a, b) => a.q - b.q);
  const spectrum = ascending.length < 3 || ascending.some(curve => curve.massExponent === null) ? []
    : ascending.slice(1, -1).map((curve, index) => {
      const prev = ascending[index], next = ascending[index + 2];
      const alpha = (next.massExponent - prev.massExponent) / (next.q - prev.q);
      return {q: curve.q, alpha, fAlpha: curve.q * alpha - curve.massExponent};
    });
  return {domain: 'BOUNDED_MULTIFRACTAL_DFA', order, sampleCount: series.length, curves, spectrum,
    limitations: 'Finite-scale descriptive estimates only; no calibrated bias correction, confidence intervals, or inference of causality from a single series.'};
}
