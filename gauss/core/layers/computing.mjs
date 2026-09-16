import { assertArray, assertFiniteNumber, assertObject, assertSafeInteger } from "../common.mjs";

export function exactBinaryKnapsack({ items, capacity }) {
  const cap = assertSafeInteger(capacity, "capacity", { min: 0, max: 1_000_000_000 });
  const rows = assertArray(items, "items", { min: 1, max: 64 }).map((item, index) => {
    assertObject(item, `items[${index}]`);
    const id = String(item.id ?? "").trim();
    if (!id) throw new TypeError(`items[${index}].id required`);
    const weight = assertSafeInteger(item.weight, `items[${index}].weight`, { min: 0, max: cap || 1_000_000_000 });
    const value = assertFiniteNumber(item.value, `items[${index}].value`, { min: 0 });
    return { id, weight, value, ratio: weight === 0 ? Infinity : value / weight };
  });
  if (new Set(rows.map((row) => row.id)).size !== rows.length) throw new TypeError("item ids must be unique");
  rows.sort((a, b) => b.ratio - a.ratio || b.value - a.value || a.id.localeCompare(b.id));
  let bestValue = 0;
  let bestWeight = 0;
  let bestIds = [];
  let visitedNodes = 0;

  function optimisticBound(index, remainingCapacity, value) {
    let bound = value;
    let remaining = remainingCapacity;
    for (let i = index; i < rows.length; i += 1) {
      const row = rows[i];
      if (row.weight === 0) {
        bound += row.value;
      } else if (row.weight <= remaining) {
        bound += row.value;
        remaining -= row.weight;
      } else {
        bound += row.value * (remaining / row.weight);
        break;
      }
    }
    return bound;
  }

  function betterTie(ids, weight) {
    if (weight !== bestWeight) return weight < bestWeight;
    const left = [...ids].sort().join("\u0000");
    const right = [...bestIds].sort().join("\u0000");
    return left < right;
  }

  function visit(index, remainingCapacity, value, weight, ids) {
    visitedNodes += 1;
    if (value > bestValue + 1e-12 || (Math.abs(value - bestValue) <= 1e-12 && betterTie(ids, weight))) {
      bestValue = value;
      bestWeight = weight;
      bestIds = [...ids];
    }
    if (index >= rows.length) return;
    if (optimisticBound(index, remainingCapacity, value) < bestValue - 1e-12) return;
    const row = rows[index];
    if (row.weight <= remainingCapacity) {
      ids.push(row.id);
      visit(index + 1, remainingCapacity - row.weight, value + row.value, weight + row.weight, ids);
      ids.pop();
    }
    visit(index + 1, remainingCapacity, value, weight, ids);
  }

  visit(0, cap, 0, 0, []);
  return Object.freeze({
    selectedIds: Object.freeze([...bestIds].sort()),
    totalValue: bestValue,
    totalWeight: bestWeight,
    capacity: cap,
    visitedNodes,
  });
}

export function verifyRequestEventuallyCertification({ trace, requestEvent = "REQUEST", certificationEvent = "CERTIFICATION" }) {
  const rows = assertArray(trace, "trace", { min: 1, max: 1_000_000 }).map((event, index) => {
    const value = String(event ?? "").trim();
    if (!value) throw new TypeError(`trace[${index}] must be non-empty`);
    return value;
  });
  const request = String(requestEvent).trim();
  const certification = String(certificationEvent).trim();
  if (!request || !certification) throw new TypeError("event names must be non-empty");
  const violations = [];
  let nextCertification = -1;
  const nearestCertification = new Array(rows.length).fill(-1);
  for (let i = rows.length - 1; i >= 0; i -= 1) {
    if (rows[i] === certification) nextCertification = i;
    nearestCertification[i] = nextCertification;
  }
  let requestCount = 0;
  for (let i = 0; i < rows.length; i += 1) {
    if (rows[i] !== request) continue;
    requestCount += 1;
    if (nearestCertification[i] < i) violations.push(i);
  }
  return Object.freeze({
    property: `G(${request}->F(${certification}))`,
    satisfied: violations.length === 0,
    requestCount,
    violationIndices: Object.freeze(violations),
  });
}
