import { digestValue, leafPrimitives, primitiveCenter, validateBounds } from "@nexus/visual-algebra";
import type { VisualAlgebraTerm } from "@nexus/visual-algebra";
import type { BuildComplexInput, FiltrationComplex, FiltrationVertex, FilteredSimplex, TopologicalRelation } from "./types.js";

const EPSILON = 1e-12;
function assertUnit(value: number, label: string): void {
  if (!Number.isFinite(value) || value < 0 || value > 1) throw new Error(`${label} must be a finite value in [0,1]`);
}
export function simplexId(vertices: readonly string[]): string { return `simplex:${JSON.stringify([...vertices].sort())}`; }
function pairKey(left: string, right: string): string { return JSON.stringify(left < right ? [left, right] : [right, left]); }
function normalizedDistance(left: FiltrationVertex, right: FiltrationVertex, diagonal: number): number {
  if (diagonal <= EPSILON) return 0;
  return Math.hypot(left.point.x - right.point.x, left.point.y - right.point.y) / diagonal;
}
function buildRelationMap(relations: readonly TopologicalRelation[], vertexIds: ReadonlySet<string>): ReadonlyMap<string, number> {
  const map = new Map<string, number>();
  for (const relation of relations) {
    if (relation.sourceId === relation.targetId) throw new Error("Topological relations cannot be self-relations");
    if (!vertexIds.has(relation.sourceId) || !vertexIds.has(relation.targetId)) {
      throw new Error(`Relation references unknown primitive: ${relation.sourceId} -> ${relation.targetId}`);
    }
    assertUnit(relation.filtration, "relation.filtration");
    const key = pairKey(relation.sourceId, relation.targetId);
    const existing = map.get(key);
    if (existing === undefined || relation.filtration < existing) map.set(key, relation.filtration);
  }
  return map;
}
function simplexComparator(left: FilteredSimplex, right: FilteredSimplex): number {
  return left.filtration - right.filtration || left.dimension - right.dimension || left.id.localeCompare(right.id);
}
export function buildFiltrationComplex(input: BuildComplexInput): FiltrationComplex {
  validateBounds(input.canvasBounds, "canvasBounds");
  if (input.canvasBounds.width <= 0 || input.canvasBounds.height <= 0) throw new Error("canvasBounds must have positive width and height");
  const maxFiltration = input.maxFiltration ?? 1;
  assertUnit(maxFiltration, "maxFiltration");
  const maxHomologyDimension = input.maxHomologyDimension ?? 1;
  const maxSimplexDimension = (maxHomologyDimension + 1) as 1 | 2;
  const leaves = leafPrimitives(input.primitives);
  const sourceIds = new Set<string>();
  const vertices: FiltrationVertex[] = [];
  for (const primitive of leaves) {
    if (sourceIds.has(primitive.id)) throw new Error(`Duplicate primitive id: ${primitive.id}`);
    sourceIds.add(primitive.id);
    const center = primitiveCenter(primitive);
    vertices.push(Object.freeze({ id: primitive.id, sourcePrimitiveId: primitive.id, primitiveKind: primitive.kind, point: Object.freeze({ x: center.x, y: center.y }) }));
  }
  vertices.sort((a, b) => a.id.localeCompare(b.id));
  const relationMap = buildRelationMap(input.relations ?? [], sourceIds);
  const diagonal = Math.hypot(input.canvasBounds.width, input.canvasBounds.height);
  const simplices: FilteredSimplex[] = vertices.map((vertex) => Object.freeze({
    id: simplexId([vertex.id]), vertices: Object.freeze([vertex.id]), dimension: 0 as const, filtration: 0,
  }));
  const edgeFiltration = new Map<string, number>();
  for (let i = 0; i < vertices.length; i += 1) {
    for (let j = i + 1; j < vertices.length; j += 1) {
      const left = vertices[i]!; const right = vertices[j]!;
      const geometric = normalizedDistance(left, right, diagonal);
      const relation = relationMap.get(pairKey(left.id, right.id));
      const filtration = relation === undefined ? geometric : Math.min(geometric, relation);
      if (filtration > maxFiltration + EPSILON) continue;
      edgeFiltration.set(pairKey(left.id, right.id), filtration);
      const simplexVertices = [left.id, right.id].sort();
      simplices.push(Object.freeze({ id: simplexId(simplexVertices), vertices: Object.freeze(simplexVertices), dimension: 1, filtration }));
    }
  }
  if (maxSimplexDimension >= 2) {
    for (let a = 0; a < vertices.length; a += 1) {
      for (let b = a + 1; b < vertices.length; b += 1) {
        for (let c = b + 1; c < vertices.length; c += 1) {
          const va = vertices[a]!; const vb = vertices[b]!; const vc = vertices[c]!;
          const ab = edgeFiltration.get(pairKey(va.id, vb.id));
          const ac = edgeFiltration.get(pairKey(va.id, vc.id));
          const bc = edgeFiltration.get(pairKey(vb.id, vc.id));
          if (ab === undefined || ac === undefined || bc === undefined) continue;
          const filtration = Math.max(ab, ac, bc);
          if (filtration > maxFiltration + EPSILON) continue;
          const triangleVertices = [va.id, vb.id, vc.id].sort();
          simplices.push(Object.freeze({ id: simplexId(triangleVertices), vertices: Object.freeze(triangleVertices), dimension: 2, filtration }));
        }
      }
    }
  }
  simplices.sort(simplexComparator);
  const base = {
    authority: "NEXUS_FILTERED_FLAG_COMPLEX_V1" as const,
    ...(input.sourceTermDigest ? { sourceTermDigest: input.sourceTermDigest } : {}),
    canvasBounds: Object.freeze({ ...input.canvasBounds }), maxFiltration, maxHomologyDimension, maxSimplexDimension,
    vertices: Object.freeze(vertices), simplices: Object.freeze(simplices),
  };
  return Object.freeze({ ...base, digest: digestValue(base) });
}
export function buildComplexFromTerm(term: VisualAlgebraTerm, options: {
  readonly relations?: readonly TopologicalRelation[]; readonly maxFiltration?: number; readonly maxHomologyDimension?: 0 | 1;
} = {}): FiltrationComplex {
  return buildFiltrationComplex({
    primitives: term.primitives, canvasBounds: term.canvasBounds, sourceTermDigest: term.digest,
    ...(options.relations ? { relations: options.relations } : {}),
    ...(options.maxFiltration !== undefined ? { maxFiltration: options.maxFiltration } : {}),
    ...(options.maxHomologyDimension !== undefined ? { maxHomologyDimension: options.maxHomologyDimension } : {}),
  });
}
export function buildVietorisRipsComplex(input: Omit<BuildComplexInput, "relations">): FiltrationComplex { return buildFiltrationComplex(input); }
