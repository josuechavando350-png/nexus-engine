import assert from "node:assert/strict";
import test from "node:test";

import { exactBinaryKnapsack } from "../core/layers/computing.mjs";

function exhaustiveOracle(items, capacity) {
  let bestValue = 0;
  let bestWeight = 0;
  let bestIds = [];
  for (let mask = 0; mask < (1 << items.length); mask += 1) {
    let weight = 0;
    let value = 0;
    const ids = [];
    for (let i = 0; i < items.length; i += 1) {
      if ((mask & (1 << i)) === 0) continue;
      weight += items[i].weight;
      value += items[i].value;
      ids.push(items[i].id);
    }
    if (weight > capacity) continue;
    ids.sort();
    const lex = ids.join("\u0000");
    const bestLex = bestIds.join("\u0000");
    if (value > bestValue || (value === bestValue && (weight < bestWeight || (weight === bestWeight && lex < bestLex)))) {
      bestValue = value;
      bestWeight = weight;
      bestIds = ids;
    }
  }
  return { bestValue, bestWeight, bestIds };
}

test("small positive fractional values are not erased by an absolute tolerance", () => {
  const items = [{ id: "tiny", weight: 1, value: 5e-13 }];
  const result = exactBinaryKnapsack({ items, capacity: 1 });
  assert.deepEqual(result.selectedIds, ["tiny"]);
  assert.equal(result.totalValue, 5e-13);
});

test("two unequal payoffs cannot tie merely because their difference is below 1e-12", () => {
  const items = [{ id: "a", weight: 1, value: 1 }, { id: "b", weight: 1, value: 1 + 5e-13 }];
  const result = exactBinaryKnapsack({ items, capacity: 1 });
  assert.deepEqual(result.selectedIds, ["b"]);
  assert.equal(result.totalValue, 1 + 5e-13);
});

test("branch-and-bound matches an independent exhaustive oracle across 160 seeded bounded instances", () => {
  let state = 0x79f3691b;
  const rand = () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;
    return state / 0x100000000;
  };
  for (let trial = 0; trial < 160; trial += 1) {
    const count = 2 + Math.floor(rand() * 10);
    const capacity = Math.floor(rand() * 31);
    const items = Array.from({ length: count }, (_, i) => ({
      id: `item-${String(i).padStart(2, "0")}`,
      weight: Math.floor(rand() * 12),
      value: Math.floor(rand() * 101),
    }));
    const actual = exactBinaryKnapsack({ items, capacity });
    const expected = exhaustiveOracle(items, capacity);
    assert.deepEqual(
      { value: actual.totalValue, weight: actual.totalWeight, ids: actual.selectedIds },
      { value: expected.bestValue, weight: expected.bestWeight, ids: expected.bestIds },
      `knapsack oracle disagreement trial ${trial}`,
    );
  }
});
