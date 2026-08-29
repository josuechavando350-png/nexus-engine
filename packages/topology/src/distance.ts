import { validatePersistenceDiagram } from "./homology.js";
import type { BottleneckDimensionResult, BottleneckDistanceResult, PersistenceDiagram, PersistenceInterval } from "./types.js";

const DIMENSIONS = [0, 1] as const;
function validateInterval(interval: PersistenceInterval): void {
  if (!Number.isFinite(interval.birth) || interval.birth < 0) throw new Error("Persistence interval birth must be finite and non-negative");
  if (interval.death !== null && (!Number.isFinite(interval.death) || interval.death < interval.birth)) throw new Error("Persistence interval death must be finite and >= birth");
}
function intervals(diagram: PersistenceDiagram, dimension: 0 | 1, finite: boolean): PersistenceInterval[] {
  return diagram.intervals.filter((item) => {
    validateInterval(item);
    return item.dimension === dimension && (finite ? item.death !== null : item.death === null);
  });
}
function pointDistance(left: PersistenceInterval, right: PersistenceInterval): number {
  if (left.death === null || right.death === null) return left.death === null && right.death === null ? Math.abs(left.birth - right.birth) : Number.POSITIVE_INFINITY;
  return Math.max(Math.abs(left.birth - right.birth), Math.abs(left.death - right.death));
}
function diagonalDistance(item: PersistenceInterval): number { return item.death === null ? Number.POSITIVE_INFINITY : (item.death - item.birth) / 2; }
function hasPerfectMatching(costs: readonly (readonly number[])[], threshold: number): boolean {
  const size = costs.length; if (size === 0) return true;
  const matchedRight = new Array<number>(size).fill(-1);
  const augment = (left: number, seen: boolean[]): boolean => {
    for (let right = 0; right < size; right += 1) {
      if (seen[right] || costs[left]![right]! > threshold) continue;
      seen[right] = true;
      if (matchedRight[right] === -1 || augment(matchedRight[right]!, seen)) { matchedRight[right] = left; return true; }
    }
    return false;
  };
  for (let left = 0; left < size; left += 1) if (!augment(left, new Array<boolean>(size).fill(false))) return false;
  return true;
}
function finiteBottleneckDistance(left: readonly PersistenceInterval[], right: readonly PersistenceInterval[]): number {
  const m = left.length; const n = right.length; const size = m + n; if (size === 0) return 0;
  const costs = Array.from({ length: size }, () => new Array<number>(size).fill(Number.POSITIVE_INFINITY));
  for (let a = 0; a < m; a += 1) for (let b = 0; b < n; b += 1) costs[a]![b] = pointDistance(left[a]!, right[b]!);
  for (let a = 0; a < m; a += 1) for (let diagonal = 0; diagonal < m; diagonal += 1) costs[a]![n + diagonal] = diagonalDistance(left[a]!);
  for (let diagonal = 0; diagonal < n; diagonal += 1) for (let b = 0; b < n; b += 1) costs[m + diagonal]![b] = diagonalDistance(right[b]!);
  for (let row = m; row < size; row += 1) for (let column = n; column < size; column += 1) costs[row]![column] = 0;
  const candidates = [...new Set(costs.flat().filter(Number.isFinite))].sort((a, b) => a - b);
  if (candidates.length === 0) return Number.POSITIVE_INFINITY;
  let low = 0; let high = candidates.length - 1; let answer = candidates[high]!;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2); const threshold = candidates[middle]!;
    if (hasPerfectMatching(costs, threshold)) { answer = threshold; high = middle - 1; } else low = middle + 1;
  }
  return answer;
}
function essentialBottleneckDistance(left: readonly PersistenceInterval[], right: readonly PersistenceInterval[]): number {
  if (left.length !== right.length) return Number.POSITIVE_INFINITY;
  const a = left.map((item) => item.birth).sort((x, y) => x - y); const b = right.map((item) => item.birth).sort((x, y) => x - y);
  let maximum = 0; for (let i = 0; i < a.length; i += 1) maximum = Math.max(maximum, Math.abs(a[i]! - b[i]!)); return maximum;
}
function dimensionDistance(left: PersistenceDiagram, right: PersistenceDiagram, dimension: 0 | 1): BottleneckDimensionResult {
  const finiteDistance = finiteBottleneckDistance(intervals(left, dimension, true), intervals(right, dimension, true));
  const essentialDistance = essentialBottleneckDistance(intervals(left, dimension, false), intervals(right, dimension, false));
  return Object.freeze({ dimension, finiteDistance, essentialDistance, distance: Math.max(finiteDistance, essentialDistance) });
}
export function bottleneckDistance(left: PersistenceDiagram, right: PersistenceDiagram, dimension?: 0 | 1): BottleneckDistanceResult {
  if (dimension !== undefined && dimension !== 0 && dimension !== 1) throw new Error("Bottleneck dimension must be 0 or 1");
  validatePersistenceDiagram(left); validatePersistenceDiagram(right);
  const dimensions: readonly (0 | 1)[] = dimension === undefined ? DIMENSIONS : [dimension];
  const results = dimensions.map((target) => dimensionDistance(left, right, target));
  return Object.freeze({ distance: results.reduce((max, item) => Math.max(max, item.distance), 0), dimensions: Object.freeze(results) });
}
