import assert from "node:assert/strict";
import test from "node:test";

import { zeroDimensionalPersistence } from "../core/layers/persistence.mjs";

test("H0 refuses overflowing aggregate finite persistence instead of serializing Infinity as null", () => {
  const problem = { vertexCount: 3, edges: [
    { i: 0, j: 1, weight: 1e308 },
    { i: 1, j: 2, weight: 1e308 },
  ] };
  assert.throws(() => zeroDimensionalPersistence(problem), /overflow/u);
});

test("H0 preserves finite totals and exact finite/infinite bar counts", () => {
  const result = zeroDimensionalPersistence({
    vertexCount: 4,
    edges: [{ i: 0, j: 1, weight: 2 }, { i: 1, j: 2, weight: 3 }],
  });
  assert.equal(result.totalFinitePersistence, 5);
  assert.equal(result.infiniteIntervalCount, 2);
  assert.deepEqual(result.finiteIntervals.map((x) => x.death), [2, 3]);
});
