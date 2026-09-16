import { assertArray, assertFiniteNumber, assertSafeInteger, normalizeNumberArray, seededXorShift32 } from "../common.mjs";

function inverseNormalCdf(p) {
  if (!(p > 0 && p < 1)) throw new RangeError("p must be in (0,1)");
  const a = [-39.69683028665376, 220.9460984245205, -275.9285104469687, 138.357751867269, -30.66479806614716, 2.506628277459239];
  const b = [-54.47609879822406, 161.5858368580409, -155.6989798598866, 66.80131188771972, -13.28068155288572];
  const c = [-0.007784894002430293, -0.3223964580411365, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
  const d = [0.007784695709041462, 0.3224671290700398, 2.445134137142996, 3.754408661907416];
  const low = 0.02425;
  const high = 1 - low;
  if (p < low) {
    const q = Math.sqrt(-2 * Math.log(p));
    return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5])
      / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
  if (p > high) {
    const q = Math.sqrt(-2 * Math.log(1 - p));
    return -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5])
      / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
  const q = p - 0.5;
  const r = q * q;
  return (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q
    / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
}

export function wilsonInterval({ successes, trials, confidence = 0.95 }) {
  const n = assertSafeInteger(trials, "trials", { min: 1, max: 1_000_000_000 });
  const k = assertSafeInteger(successes, "successes", { min: 0, max: n });
  const c = assertFiniteNumber(confidence, "confidence", { min: 0.5, max: 0.999999 });
  const z = inverseNormalCdf(0.5 + c / 2);
  const p = k / n;
  const z2 = z * z;
  const denominator = 1 + z2 / n;
  const center = (p + z2 / (2 * n)) / denominator;
  const margin = (z / denominator) * Math.sqrt((p * (1 - p) + z2 / (4 * n)) / n);
  return Object.freeze({ estimate: p, lower: Math.max(0, center - margin), upper: Math.min(1, center + margin), confidence: c });
}

export function brierScore({ probabilities, outcomes }) {
  const probs = normalizeNumberArray(probabilities, "probabilities");
  const ys = assertArray(outcomes, "outcomes", { min: probs.length, max: probs.length }).map((value, index) => {
    if (value !== 0 && value !== 1) throw new TypeError(`outcomes[${index}] must be 0 or 1`);
    return value;
  });
  let sum = 0;
  for (let i = 0; i < probs.length; i += 1) {
    if (probs[i] < 0 || probs[i] > 1) throw new TypeError(`probabilities[${i}] must be in [0,1]`);
    const delta = probs[i] - ys[i];
    sum += delta * delta;
  }
  return Object.freeze({ score: sum / probs.length, sampleCount: probs.length });
}

function percentile(sorted, p) {
  if (sorted.length === 1) return sorted[0];
  const position = (sorted.length - 1) * p;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) return sorted[lower];
  const weight = position - lower;
  return sorted[lower] * (1 - weight) + sorted[upper] * weight;
}

export function bootstrapMeanInterval({ samples, confidence = 0.95, resamples = 2_000, seed = 1 }) {
  const values = normalizeNumberArray(samples, "samples", { minLength: 2, maxLength: 10_000 });
  const c = assertFiniteNumber(confidence, "confidence", { min: 0.5, max: 0.999 });
  const count = assertSafeInteger(resamples, "resamples", { min: 100, max: 100_000 });
  const rng = seededXorShift32(seed);
  const means = new Array(count);
  for (let r = 0; r < count; r += 1) {
    let sum = 0;
    for (let i = 0; i < values.length; i += 1) sum += values[Math.floor(rng() * values.length)];
    means[r] = sum / values.length;
  }
  means.sort((a, b) => a - b);
  const alpha = (1 - c) / 2;
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  return Object.freeze({ mean, lower: percentile(means, alpha), upper: percentile(means, 1 - alpha), confidence: c, resamples: count, seed });
}
