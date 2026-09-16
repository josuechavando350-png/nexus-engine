import { assertArray, assertFiniteNumber, assertObject, normalizeNumberArray } from "../common.mjs";

export function expectedUtility({ outcomes }) {
  const rows = assertArray(outcomes, "outcomes", { min: 1, max: 10_000 }).map((row, index) => {
    assertObject(row, `outcomes[${index}]`);
    const probability = assertFiniteNumber(row.probability, `outcomes[${index}].probability`, { min: 0, max: 1 });
    const utility = assertFiniteNumber(row.utility, `outcomes[${index}].utility`);
    return { probability, utility };
  });
  const probabilityMass = rows.reduce((sum, row) => sum + row.probability, 0);
  if (Math.abs(probabilityMass - 1) > 1e-9) throw new TypeError("outcome probabilities must sum to 1");
  const value = rows.reduce((sum, row) => sum + row.probability * row.utility, 0);
  return Object.freeze({ expectedUtility: value, probabilityMass });
}

export function minimaxRegret({ actions, payoffMatrix }) {
  const ids = assertArray(actions, "actions", { min: 1, max: 1_000 }).map((id, index) => {
    const text = String(id ?? "").trim();
    if (!text) throw new TypeError(`actions[${index}] required`);
    return text;
  });
  const matrix = assertArray(payoffMatrix, "payoffMatrix", { min: ids.length, max: ids.length }).map((row, index) => (
    normalizeNumberArray(row, `payoffMatrix[${index}]`, { minLength: 1, maxLength: 10_000 })
  ));
  const scenarioCount = matrix[0].length;
  if (matrix.some((row) => row.length !== scenarioCount)) throw new TypeError("payoff matrix must be rectangular");
  const bestByScenario = Array.from({ length: scenarioCount }, (_, j) => Math.max(...matrix.map((row) => row[j])));
  const maximumRegret = matrix.map((row) => Math.max(...row.map((payoff, j) => bestByScenario[j] - payoff)));
  let bestIndex = 0;
  for (let i = 1; i < maximumRegret.length; i += 1) {
    if (maximumRegret[i] < maximumRegret[bestIndex] - 1e-12
      || (Math.abs(maximumRegret[i] - maximumRegret[bestIndex]) <= 1e-12 && ids[i] < ids[bestIndex])) bestIndex = i;
  }
  return Object.freeze({ selectedAction: ids[bestIndex], maximumRegret: maximumRegret[bestIndex], regrets: Object.freeze(maximumRegret) });
}
