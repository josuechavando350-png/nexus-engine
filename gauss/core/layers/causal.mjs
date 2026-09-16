import { assertArray, assertFiniteNumber, assertObject, normalizeNumberArray } from "../common.mjs";

function mean(values) {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

export function differenceInDifferences({ treatedPre, treatedPost, controlPre, controlPost }) {
  const tp = normalizeNumberArray(treatedPre, "treatedPre");
  const tq = normalizeNumberArray(treatedPost, "treatedPost");
  const cp = normalizeNumberArray(controlPre, "controlPre");
  const cq = normalizeNumberArray(controlPost, "controlPost");
  const treatedChange = mean(tq) - mean(tp);
  const controlChange = mean(cq) - mean(cp);
  return Object.freeze({ treatedChange, controlChange, estimate: treatedChange - controlChange });
}

export function inversePropensityWeightedATE({ rows, propensityFloor = 0.01 }) {
  const floor = assertFiniteNumber(propensityFloor, "propensityFloor", { min: 1e-6, max: 0.49 });
  const data = assertArray(rows, "rows", { min: 2, max: 1_000_000 }).map((row, index) => {
    assertObject(row, `rows[${index}]`);
    if (row.treatment !== 0 && row.treatment !== 1) throw new TypeError(`rows[${index}].treatment must be 0 or 1`);
    const outcome = assertFiniteNumber(row.outcome, `rows[${index}].outcome`);
    const propensity = assertFiniteNumber(row.propensity, `rows[${index}].propensity`, { min: floor, max: 1 - floor });
    return { treatment: row.treatment, outcome, propensity };
  });
  let treatedWeighted = 0;
  let treatedWeight = 0;
  let controlWeighted = 0;
  let controlWeight = 0;
  for (const row of data) {
    if (row.treatment === 1) {
      const weight = 1 / row.propensity;
      treatedWeighted += weight * row.outcome;
      treatedWeight += weight;
    } else {
      const weight = 1 / (1 - row.propensity);
      controlWeighted += weight * row.outcome;
      controlWeight += weight;
    }
  }
  if (treatedWeight === 0 || controlWeight === 0) throw new TypeError("IPW ATE requires treated and control observations");
  const treatedMean = treatedWeighted / treatedWeight;
  const controlMean = controlWeighted / controlWeight;
  return Object.freeze({ estimate: treatedMean - controlMean, treatedMean, controlMean, sampleCount: data.length });
}
