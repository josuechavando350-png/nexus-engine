import { validateOriginalityEdge } from "./edge.js";
import { MAX_ORIGINALITY_GEODESIC_EDGES, MAX_ORIGINALITY_GEODESIC_NODES } from "./limits.js";
import { compareStableStrings } from "./order.js";
import type { GeodesicPath, OriginalityEdge } from "./types.js";

function pathKey(path: readonly string[]): string {
  return path.join("\u0000");
}

function edgeKey(edge: OriginalityEdge): string {
  return `${edge.a}\u0000${edge.b}`;
}

function prepareGraph(nodeIds: readonly string[], edges: readonly OriginalityEdge[]) {
  if (nodeIds.length > MAX_ORIGINALITY_GEODESIC_NODES) {
    throw new Error(`Geodesic node budget exceeded (${MAX_ORIGINALITY_GEODESIC_NODES})`);
  }
  if (edges.length > MAX_ORIGINALITY_GEODESIC_EDGES) {
    throw new Error(`Geodesic edge budget exceeded (${MAX_ORIGINALITY_GEODESIC_EDGES})`);
  }
  const unique = new Set(nodeIds);
  if (unique.size !== nodeIds.length) throw new Error("Geodesic node IDs must be unique");

  const adjacency = new Map<string, Array<{ id: string; weight: number }>>();
  for (const id of nodeIds) adjacency.set(id, []);
  const seenEdges = new Set<string>();
  for (const edge of edges) {
    validateOriginalityEdge(edge);
    if (!unique.has(edge.a) || !unique.has(edge.b)) throw new Error("Geodesic edge endpoint does not exist in graph");
    const key = edgeKey(edge);
    if (seenEdges.has(key)) throw new Error(`Duplicate geodesic edge ${edge.a}<->${edge.b}`);
    seenEdges.add(key);
    adjacency.get(edge.a)!.push({ id: edge.b, weight: edge.weight });
    adjacency.get(edge.b)!.push({ id: edge.a, weight: edge.weight });
  }
  for (const neighbors of adjacency.values()) neighbors.sort((a, b) => compareStableStrings(a.id, b.id));
  return { unique, adjacency };
}

function runSingleSource(input: {
  readonly nodeIds: readonly string[];
  readonly edges: readonly OriginalityEdge[];
  readonly source: string;
}) {
  const { unique, adjacency } = prepareGraph(input.nodeIds, input.edges);
  if (!unique.has(input.source)) throw new Error("Geodesic source must exist in graph");

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

  return { unique, distance, paths };
}

export function shortestGeodesicPaths(input: {
  readonly nodeIds: readonly string[];
  readonly edges: readonly OriginalityEdge[];
  readonly source: string;
  readonly targets: readonly string[];
}): readonly Readonly<{ target: string; path: GeodesicPath }>[] {
  const { unique, distance, paths } = runSingleSource(input);
  const seenTargets = new Set<string>();
  return Object.freeze(input.targets.map((target) => {
    if (!unique.has(target)) throw new Error("Geodesic target must exist in graph");
    if (seenTargets.has(target)) throw new Error(`Duplicate geodesic target ${target}`);
    seenTargets.add(target);
    const result = distance.get(target)!;
    const path: GeodesicPath = Number.isFinite(result)
      ? Object.freeze({ reachable: true, distance: result, nodes: Object.freeze([...(paths.get(target) ?? [input.source])]) })
      : Object.freeze({ reachable: false, distance: null, nodes: Object.freeze([]) });
    return Object.freeze({ target, path });
  }));
}

export function shortestGeodesicPath(input: {
  readonly nodeIds: readonly string[];
  readonly edges: readonly OriginalityEdge[];
  readonly source: string;
  readonly target: string;
}): GeodesicPath {
  return shortestGeodesicPaths({ ...input, targets: [input.target] })[0]!.path;
}
