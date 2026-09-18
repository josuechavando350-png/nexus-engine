import { createHash } from "node:crypto";

// Independent WALLE-side replay: no imports from GAUSS's Pareto implementation.
// All inputs are hypothetical planning vectors, never observed sales outcomes.
export function independentlyVerifyCommercialPareto(points, objectives, claimed) {
  if (!Array.isArray(points) || points.length === 0 || points.length > 1_000
      || !Array.isArray(objectives) || objectives.length !== 5
      || objectives.some((direction) => direction !== "MAX" && direction !== "MIN")) {
    throw new Error("WALLE_PARETO_INVALID_INPUT");
  }
  const ids = new Set();
  for (const point of points) {
    if (!point || typeof point.id !== "string" || ids.has(point.id)
        || !Array.isArray(point.values) || point.values.length !== objectives.length
        || point.values.some((value) => !Number.isSafeInteger(value))) {
      throw new Error("WALLE_PARETO_INVALID_POINT");
    }
    ids.add(point.id);
  }
  if (!claimed || !Array.isArray(claimed.frontierIds) || !Array.isArray(claimed.dominatedIds)) {
    throw new Error("WALLE_PARETO_CLAIM_REQUIRED");
  }
  function dominates(left, right) {
    let strictlyBetter = false;
    for (let axis = 0; axis < objectives.length; axis++) {
      const a = left.values[axis];
      const b = right.values[axis];
      if (objectives[axis] === "MAX" ? a < b : a > b) return false;
      if (a !== b) strictlyBetter = true;
    }
    return strictlyBetter;
  }
  const frontierIds = [];
  const dominatedIds = [];
  for (const candidate of points) {
    const dominated = points.some((competitor) => competitor.id !== candidate.id && dominates(competitor, candidate));
    (dominated ? dominatedIds : frontierIds).push(candidate.id);
  }
  frontierIds.sort();
  dominatedIds.sort();
  const same = (expected, actual) => actual.length === expected.length
    && actual.every((id) => typeof id === "string")
    && [...actual].sort().every((id, index) => id === expected[index]);
  if (!same(frontierIds, claimed.frontierIds) || !same(dominatedIds, claimed.dominatedIds)) {
    throw new Error("WALLE_PARETO_REPLAY_MISMATCH");
  }
  const inputSha256 = `sha256:${createHash("sha256").update(JSON.stringify({ points, objectives })).digest("hex")}`;
  return Object.freeze({ status: "PASS", inputSha256, frontierIds: Object.freeze(frontierIds),
    dominatedIds: Object.freeze(dominatedIds), interpretation: "INDEPENDENT_MODELED_PARETO_REPLAY_NOT_COMMERCIAL_EFFICACY" });
}
