import { compareStableStrings } from "./order.js";
import type { GeodesicPath, OriginalityEdge } from "./types.js";

function pathKey(path: readonly string[]): string {
  return path.join("\u0000");
}

export function shortestGeodesicPath(input: {
  readonly nodeIds: readonly string[];
  readonly edges: readonly OriginalityEdge[];
  readonly source: string;
  readonly target: string;
}): GeodesicPath {
  const unique = new Set(input.nodeIds);
  if (unique.size !== input.nodeIds.length) throw new Error("Geodesic node IDs must be unique");
  if (!unique.has(input.source) || !unique.has(input.target)) throw new Error("Geodesic source and target must exist in graph");

  const adjacency = new Map<string, Array<{ id: string; weight: number }>>();
  for (const id of input.nodeIds) adjacency.set(id, []);
  for (const edge of input.edges) {
    if (!unique.has(edge.a) || !unique.has(edge.b)) throw new Error("Geodesic edge endpoint does not exist in graph");
    if (!Number.isFinite(edge.weight) || edge.weight < 0) throw new Error("Geodesic edge weight must be finite and non-negative");
    adjacency.get(edge.a)!.push({ id: edge.b, weight: edge.weight });
    adjacency.get(edge.b)!.push({ id: edge.a, weight: edge.weight });
  }
  for (const neighbors of adjacency.values()) neighbors.sort((a, b) => compareStableStrings(a.id, b.id));

  const distance = new Map<string, number>();
  const paths = new Map<string, readonly string[]>();
  const unsettled = new Set(input.nodeIds);
  for (const id of input.nodeIds) distance.set(id, Number.POSITIVE_INFINITY);
  distance.set(input.source, 0);
  paths.set(input.source, Object.freeze([input.source]));

  while (unsettled.size) {
    const current = [...unsettled].sort((a, b) => {
      const delta = distance.get(a)! - distance.get(b)!;
      if (delta !== 0) return delta;
      const leftPath = paths.get(a);
      const rightPath = paths.get(b);
      if (leftPath && rightPath) return compareStableStrings(pathKey(leftPath), pathKey(rightPath));
      if (leftPath) return -1;
      if (rightPath) return 1;
      return compareStableStrings(a, b);
    })[0]!;

    const currentDistance = distance.get(current)!;
    if (!Number.isFinite(currentDistance)) break;
    unsettled.delete(current);
    if (current === input.target) break;

    const currentPath = paths.get(current)!;
    for (const neighbor of adjacency.get(current)!) {
      if (!unsettled.has(neighbor.id)) continue;
      const alternative = currentDistance + neighbor.weight;
      const alternativePath = Object.freeze([...currentPath, neighbor.id]);
      const existing = distance.get(neighbor.id)!;
      const existingPath = paths.get(neighbor.id);
      if (alternative < existing || (alternative === existing && (!existingPath || compareStableStrings(pathKey(alternativePath), pathKey(existingPath)) < 0))) {
        distance.set(neighbor.id, alternative);
        paths.set(neighbor.id, alternativePath);
      }
    }
  }

  const result = distance.get(input.target)!;
  if (!Number.isFinite(result)) return Object.freeze({ reachable: false, distance: null, nodes: Object.freeze([]) });
  return Object.freeze({ reachable: true, distance: result, nodes: Object.freeze([...(paths.get(input.target) ?? [input.source])]) });
}
