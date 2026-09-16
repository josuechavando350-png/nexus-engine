import { assertArray, assertFiniteNumber, assertObject, normalizeNumberArray } from "../common.mjs";

export function empiricalWasserstein2({ left, right }) {
  const a = normalizeNumberArray(left, "left");
  const b = normalizeNumberArray(right, "right");
  if (a.length !== b.length) throw new TypeError("empiricalWasserstein2 requires equal sample sizes");
  const sa = [...a].sort((x, y) => x - y);
  const sb = [...b].sort((x, y) => x - y);
  let sum = 0;
  for (let index = 0; index < sa.length; index += 1) {
    const delta = sa[index] - sb[index];
    sum += delta * delta;
  }
  return Object.freeze({ distance: Math.sqrt(sum / sa.length), sampleCount: sa.length });
}

export function paretoFrontier({ points, objectives }) {
  assertArray(points, "points", { min: 1, max: 10_000 });
  const dirs = assertArray(objectives, "objectives", { min: 1, max: 64 }).map((direction, index) => {
    if (direction !== "MAX" && direction !== "MIN") throw new TypeError(`objectives[${index}] must be MAX or MIN`);
    return direction;
  });
  const rows = points.map((point, index) => {
    assertObject(point, `points[${index}]`);
    const id = String(point.id ?? "").trim();
    if (!id) throw new TypeError(`points[${index}].id required`);
    const values = normalizeNumberArray(point.values, `points[${index}].values`, { minLength: dirs.length, maxLength: dirs.length });
    return Object.freeze({ id, values: Object.freeze(values) });
  });
  const dominates = (a, b) => {
    let strict = false;
    for (let i = 0; i < dirs.length; i += 1) {
      if (dirs[i] === "MAX") {
        if (a.values[i] < b.values[i]) return false;
        if (a.values[i] > b.values[i]) strict = true;
      } else {
        if (a.values[i] > b.values[i]) return false;
        if (a.values[i] < b.values[i]) strict = true;
      }
    }
    return strict;
  };
  const frontier = rows.filter((candidate, index) => !rows.some((other, otherIndex) => otherIndex !== index && dominates(other, candidate)));
  return Object.freeze({
    frontierIds: Object.freeze(frontier.map((row) => row.id).sort()),
    dominatedIds: Object.freeze(rows.filter((row) => !frontier.includes(row)).map((row) => row.id).sort()),
  });
}

export function graphLaplacian({ adjacency }) {
  const matrix = assertArray(adjacency, "adjacency", { min: 1, max: 256 });
  const n = matrix.length;
  const normalized = matrix.map((row, i) => {
    const values = normalizeNumberArray(row, `adjacency[${i}]`, { minLength: n, maxLength: n });
    return values.map((value, j) => {
      if (value < 0) throw new TypeError("adjacency weights must be non-negative");
      if (i === j && value !== 0) throw new TypeError("adjacency diagonal must be zero");
      return value;
    });
  });
  for (let i = 0; i < n; i += 1) {
    for (let j = i + 1; j < n; j += 1) {
      // An undirected adjacency matrix must be exactly symmetric. A tolerance
      // would silently produce an asymmetric Laplacian while claiming otherwise.
      if (normalized[i][j] !== normalized[j][i]) throw new TypeError("adjacency must be symmetric");
    }
  }
  const degrees = normalized.map((row) => row.reduce((sum, value) => sum + value, 0));
  const laplacian = normalized.map((row, i) => row.map((value, j) => (i === j ? degrees[i] : -value)));
  const trace = degrees.reduce((sum, value) => sum + value, 0);
  return Object.freeze({
    degree: Object.freeze(degrees),
    laplacian: Object.freeze(laplacian.map((row) => Object.freeze(row))),
    trace,
  });
}
