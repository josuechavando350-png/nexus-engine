import assert from "node:assert/strict";
import test from "node:test";

import { exactBinaryKnapsack } from "../core/layers/computing.mjs";
import { mutualInformation, renyiDivergence } from "../core/layers/information.mjs";

test("exact knapsack rejects oversized instances rather than implying unbounded exact solving", () => {
  const items = Array.from({ length: 21 }, (_, index) => ({ id: `item-${index}`, weight: 1, value: 1 }));
  assert.throws(() => exactBinaryKnapsack({ items, capacity: 10 }), /bounded length/u);
});

test("Renyi log-sum-exp handles large discrete supports without JS spread argument limits", () => {
  const count = 200_000;
  const p = Array(count).fill(1 / count);
  const q = Array(count).fill(1 / count);
  const output = renyiDivergence({ p, q, alpha: 1000 });
  assert.equal(output.divergenceKind, "FINITE");
  assert(Math.abs(output.divergence) < 1e-9);
});

test("mutual information refuses excessive matrix cells before materializing them", () => {
  const row = Array(1_000).fill(0);
  const joint = Array(1_001).fill(row);
  assert.throws(() => mutualInformation({ joint }), /bounded cell budget/u);
});
