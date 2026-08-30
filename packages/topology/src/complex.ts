import {
  digestValue,
  leafPrimitives,
  primitiveCenter,
  validateBounds,
  validatePrimitive,
  verifyVisualAlgebraTerm,
} from "@nexus/visual-algebra";
import type { VisualAlgebraTerm } from "@nexus/visual-algebra";
import type {
  BuildComplexInput,
  FiltrationComplex,
  FiltrationVertex,
  FilteredSimplex,
  TopologicalRelation,
} from "./types.js";

const EPSILON = 1e-12;
const LEAF_KINDS = new Set<string>(["rectangle", "ellipse", "line", "polygon", "text", "image"]);

function assertUnit(value: number, label: string): void {
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error(`${label} must be a finite value in [0,1]`);
  }
}

function assertSha256(value: string, label: string): void {
  if (!/^[a-f0-9]{64}$/.test(value)) throw new Error(`${label} must be SHA-256 hex`);
}

function stableCompare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function simplexId(vertices: readonly string[]): string {
  return `simplex:${JSON.stringify([...vertices].sort(stableCompare))}`;
}

function pair(left: string, right: string): readonly [string, string] {
  return left < right ? [left, right] : [right, left];
}

function pairKey(left: string, right: string): string {
  return JSON.stringify(pair(left, right));
}

function normalizedDistance(left: FiltrationVertex, right: FiltrationVertex, diagonal: number): number {
  if (diagonal <= EPSILON) return 0;
  return Math.hypot(left.point.x - right.point.x, left.point.y - right.point.y) / diagonal;
}

function normalizeRelations(
  relations: readonly TopologicalRelation[],
  vertexIds: ReadonlySet<string>,
): readonly TopologicalRelation[] {
  const byPair = new Map<string, TopologicalRelation>();

  for (const relation of relations) {
    if (relation.sourceId === relation.targetId) throw new Error("Topological relations cannot be self-relations");
    if (!vertexIds.has(relation.sourceId) || !vertexIds.has(relation.targetId)) {
      throw new Error(`Relation references unknown primitive: ${relation.sourceId} -> ${relation.targetId}`);
    }
    assertUnit(relation.filtration, "relation.filtration");

    const [sourceId, targetId] = pair(relation.sourceId, relation.targetId);
    const key = pairKey(sourceId, targetId);
    const existing = byPair.get(key);
    if (existing === undefined || relation.filtration < existing.filtration) {
      byPair.set(key, Object.freeze({ sourceId, targetId, filtration: relation.filtration }));
    }
  }

  return Object.freeze(
    [...byPair.values()].sort(
      (left, right) => stableCompare(left.sourceId, right.sourceId)
        || stableCompare(left.targetId, right.targetId),
    ),
  );
}

function relationMap(relations: readonly TopologicalRelation[]): ReadonlyMap<string, number> {
  return new Map(relations.map((relation) => [pairKey(relation.sourceId, relation.targetId), relation.filtration]));
}

function simplexComparator(left: FilteredSimplex, right: FilteredSimplex): number {
  return left.filtration - right.filtration || left.dimension - right.dimension || stableCompare(left.id, right.id);
}

function buildCanonicalSimplices(input: {
  readonly vertices: readonly FiltrationVertex[];
  readonly relations: readonly TopologicalRelation[];
  readonly canvasBounds: BuildComplexInput["canvasBounds"];
  readonly maxFiltration: number;
  readonly maxSimplexDimension: 1 | 2;
}): readonly FilteredSimplex[] {
  const relationByPair = relationMap(input.relations);
  const diagonal = Math.hypot(input.canvasBounds.width, input.canvasBounds.height);
  const simplices: FilteredSimplex[] = input.vertices.map((vertex) => Object.freeze({
    id: simplexId([vertex.id]),
    vertices: Object.freeze([vertex.id]),
    dimension: 0 as const,
    filtration: 0,
  }));

  const edgeFiltration = new Map<string, number>();
  for (let i = 0; i < input.vertices.length; i += 1) {
    for (let j = i + 1; j < input.vertices.length; j += 1) {
      const left = input.vertices[i]!;
      const right = input.vertices[j]!;
      const geometric = normalizedDistance(left, right, diagonal);
      const relation = relationByPair.get(pairKey(left.id, right.id));
      const filtration = relation === undefined ? geometric : Math.min(geometric, relation);
      if (filtration > input.maxFiltration + EPSILON) continue;

      edgeFiltration.set(pairKey(left.id, right.id), filtration);
      const simplexVertices = [left.id, right.id].sort(stableCompare);
      simplices.push(Object.freeze({
        id: simplexId(simplexVertices),
        vertices: Object.freeze(simplexVertices),
        dimension: 1,
        filtration,
      }));
    }
  }

  if (input.maxSimplexDimension >= 2) {
    for (let a = 0; a < input.vertices.length; a += 1) {
      for (let b = a + 1; b < input.vertices.length; b += 1) {
        for (let c = b + 1; c < input.vertices.length; c += 1) {
          const va = input.vertices[a]!;
          const vb = input.vertices[b]!;
          const vc = input.vertices[c]!;
          const ab = edgeFiltration.get(pairKey(va.id, vb.id));
          const ac = edgeFiltration.get(pairKey(va.id, vc.id));
          const bc = edgeFiltration.get(pairKey(vb.id, vc.id));
          if (ab === undefined || ac === undefined || bc === undefined) continue;

          const filtration = Math.max(ab, ac, bc);
          if (filtration > input.maxFiltration + EPSILON) continue;
          const triangleVertices = [va.id, vb.id, vc.id].sort(stableCompare);
          simplices.push(Object.freeze({
            id: simplexId(triangleVertices),
            vertices: Object.freeze(triangleVertices),
            dimension: 2,
            filtration,
          }));
        }
      }
    }
  }

  simplices.sort(simplexComparator);
  return Object.freeze(simplices);
}

export function buildFiltrationComplex(input: BuildComplexInput): FiltrationComplex {
  validateBounds(input.canvasBounds, "canvasBounds");
  if (input.canvasBounds.width <= 0 || input.canvasBounds.height <= 0) {
    throw new Error("canvasBounds must have positive width and height");
  }

  const maxFiltration = input.maxFiltration ?? 1;
  assertUnit(maxFiltration, "maxFiltration");
  const maxHomologyDimension = input.maxHomologyDimension ?? 1;
  if (maxHomologyDimension !== 0 && maxHomologyDimension !== 1) {
    throw new Error("Only H0 and H1 persistent homology are supported");
  }
  if (input.sourceTermDigest !== undefined) assertSha256(input.sourceTermDigest, "sourceTermDigest");
  for (const primitive of input.primitives) validatePrimitive(primitive);

  const maxSimplexDimension = (maxHomologyDimension + 1) as 1 | 2;
  const leaves = leafPrimitives(input.primitives);
  const sourceIds = new Set<string>();
  const vertices: FiltrationVertex[] = [];

  for (const primitive of leaves) {
    if (sourceIds.has(primitive.id)) throw new Error(`Duplicate primitive id: ${primitive.id}`);
    sourceIds.add(primitive.id);
    const center = primitiveCenter(primitive);
    vertices.push(Object.freeze({
      id: primitive.id,
      sourcePrimitiveId: primitive.id,
      primitiveKind: primitive.kind,
      point: Object.freeze({ x: center.x, y: center.y }),
    }));
  }
  vertices.sort((left, right) => stableCompare(left.id, right.id));

  const relations = normalizeRelations(input.relations ?? [], sourceIds);
  const simplices = buildCanonicalSimplices({
    vertices,
    relations,
    canvasBounds: input.canvasBounds,
    maxFiltration,
    maxSimplexDimension,
  });

  const base = {
    authority: "NEXUS_FILTERED_FLAG_COMPLEX_V1" as const,
    ...(input.sourceTermDigest !== undefined ? { sourceTermDigest: input.sourceTermDigest } : {}),
    canvasBounds: Object.freeze({ ...input.canvasBounds }),
    maxFiltration,
    maxHomologyDimension,
    maxSimplexDimension,
    vertices: Object.freeze(vertices),
    relations,
    simplices,
  };
  return Object.freeze({ ...base, digest: digestValue(base) });
}

export function validateCanonicalFiltrationComplex(complex: FiltrationComplex): void {
  if (complex.authority !== "NEXUS_FILTERED_FLAG_COMPLEX_V1") {
    throw new Error("Unsupported filtration complex authority");
  }
  validateBounds(complex.canvasBounds, "complex.canvasBounds");
  if (complex.canvasBounds.width <= 0 || complex.canvasBounds.height <= 0) {
    throw new Error("Complex canvas must have positive width and height");
  }
  if (!Number.isFinite(complex.maxFiltration) || complex.maxFiltration < 0 || complex.maxFiltration > 1) {
    throw new Error("Complex maxFiltration must be in [0,1]");
  }
  if (complex.maxHomologyDimension !== 0 && complex.maxHomologyDimension !== 1) {
    throw new Error("Complex maxHomologyDimension must be 0 or 1");
  }
  if (complex.maxSimplexDimension !== complex.maxHomologyDimension + 1) {
    throw new Error("Complex simplex/homology dimensions are inconsistent");
  }
  if (complex.sourceTermDigest !== undefined) assertSha256(complex.sourceTermDigest, "Complex sourceTermDigest");
  if (!Array.isArray(complex.vertices) || !Array.isArray(complex.relations) || !Array.isArray(complex.simplices)) {
    throw new Error("Complex vertices, relations and simplices must be arrays");
  }

  const vertexIds = new Set<string>();
  let previousVertexId: string | null = null;
  for (const vertex of complex.vertices) {
    if (!vertex.id.trim() || !vertex.sourcePrimitiveId.trim()) throw new Error("Complex vertex ids cannot be empty");
    if (vertex.id !== vertex.sourcePrimitiveId) throw new Error(`Complex vertex ${vertex.id} source primitive linkage mismatch`);
    if (!LEAF_KINDS.has(vertex.primitiveKind)) throw new Error(`Complex vertex ${vertex.id} has invalid primitive kind`);
    if (vertexIds.has(vertex.id)) throw new Error(`Duplicate complex vertex id: ${vertex.id}`);
    if (!Number.isFinite(vertex.point.x) || !Number.isFinite(vertex.point.y)) {
      throw new Error(`Complex vertex ${vertex.id} has non-finite coordinates`);
    }
    if (previousVertexId !== null && stableCompare(previousVertexId, vertex.id) >= 0) {
      throw new Error("Complex vertices are not in canonical order");
    }
    previousVertexId = vertex.id;
    vertexIds.add(vertex.id);
  }

  const normalizedRelations = normalizeRelations(complex.relations, vertexIds);
  if (digestValue(normalizedRelations) !== digestValue(complex.relations)) {
    throw new Error("Complex relations are not canonical");
  }

  const expectedSimplices = buildCanonicalSimplices({
    vertices: complex.vertices,
    relations: normalizedRelations,
    canvasBounds: complex.canvasBounds,
    maxFiltration: complex.maxFiltration,
    maxSimplexDimension: complex.maxSimplexDimension,
  });
  if (digestValue(expectedSimplices) !== digestValue(complex.simplices)) {
    throw new Error("Filtration complex simplices do not match canonical vertices/relations");
  }

  const { digest, ...digestPayload } = complex;
  if (!/^[a-f0-9]{64}$/.test(digest) || digestValue(digestPayload) !== digest) {
    throw new Error("Filtration complex digest mismatch");
  }
}

export function buildComplexFromTerm(
  term: VisualAlgebraTerm,
  options: {
    readonly relations?: readonly TopologicalRelation[];
    readonly maxFiltration?: number;
    readonly maxHomologyDimension?: 0 | 1;
  } = {},
): FiltrationComplex {
  verifyVisualAlgebraTerm(term);
  return buildFiltrationComplex({
    primitives: term.primitives,
    canvasBounds: term.canvasBounds,
    sourceTermDigest: term.digest,
    ...(options.relations ? { relations: options.relations } : {}),
    ...(options.maxFiltration !== undefined ? { maxFiltration: options.maxFiltration } : {}),
    ...(options.maxHomologyDimension !== undefined ? { maxHomologyDimension: options.maxHomologyDimension } : {}),
  });
}

export function buildVietorisRipsComplex(input: Omit<BuildComplexInput, "relations">): FiltrationComplex {
  return buildFiltrationComplex(input);
}
